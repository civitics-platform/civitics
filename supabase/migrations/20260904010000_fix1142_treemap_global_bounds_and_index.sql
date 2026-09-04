-- FIX-1142 — treemap-individuals-global: a covering partial index for the
-- donor-range chunk, and a resume bound that outlives the schedule.
--
-- TWO INDEPENDENT DEFECTS, both measured under FIX-973 (cc-prompt-103) and
-- confirmed against prod on 2026-09-04.
--
-- (1) THE CHUNK IS I/O-BOUND ON AN UNCOVERED INDEX.
--     financial_relationships_donation_size_rollup is (from_id) INCLUDE
--     (amount_cents) WHERE from_type='financial_entity' AND
--     relationship_type='donation' — it does NOT carry to_type. The chunk
--     filters to_type='official', so the planner cannot use it and falls back
--     to financial_relationships_derivation plus a heap fetch per row to reach
--     amount_cents. Measured: 57,432 reads per chunk on that path against
--     2,423 with a covering partial index — 24x. Prod went from 43 s/chunk
--     (2026-08-06, all 64 chunks in 2,779 s) to 451 s/chunk (2026-09-01, 12
--     chunks in 5,409.8 s) with no code change, as financial_entities grew
--     past what 256 MB of shared_buffers can hold.
--
--     THE INDEX IS ALREADY BUILT ON PROD. CREATE INDEX CONCURRENTLY cannot run
--     inside a transaction block and `supabase db push` wraps each migration in
--     one, so it was built out-of-band by
--     scripts/fix1142-build-treemap-global-index.mjs on 2026-09-04 (103.8 s,
--     indisvalid=t, 256 MB). The IF NOT EXISTS form below is therefore a no-op
--     against prod and the real build path for local and any rebuilt-from-zero
--     environment. Same split as FIX-1118.
--
--     NOTE the tension with FIX-1133: this takes financial_relationships from
--     18 indexes to 19, on 6,926 MB of existing index. Six of the eighteen have
--     never been scanned (usaspending_unique 518 MB, cycle 133 MB, pkey 573 MB,
--     plus three tiny ones). Censusing and dropping those is FIX-1133's job and
--     nothing here touches them; financial_relationships_donation_size_rollup
--     in particular STAYS — it has 1.4M scans and its consumers aggregate per
--     donor regardless of recipient type.
--
-- (2) NON-CONVERGENCE IS STRUCTURAL, AND THE PREDICTIVE GUARD IS DEAD CODE.
--     c_max_sweep was 72 h while jobid 26 runs '0 14 * * 2' = every 168 h, so a
--     cursor written on Tuesday is ALWAYS older than the bound by the next
--     Tuesday and the sweep restarts from chunk 0 forever. Prod says it in
--     words — pipeline_state.treemap_global_refresh holds chunk_cursor 12 with
--     sweep_started_at 2026-09-01 14:00, and the 09-01 row's restarted_reason
--     reads "sweep started 2026-08-18 08:15:02 exceeds the 72:00:00 staleness
--     bound". Raised to 240 h: a weekly job's cursor must survive one entirely
--     missed week plus slack. (FIX-1142's bullet proposed 120 h, but that was
--     paired with moving jobid 26 to a DAILY cadence. That cadence change is
--     NOT applied here — the schedule stays weekly — and 120 h is still under
--     168 h, so it would not have fixed anything on its own.)
--
--     Separately, the internal c_budget was 4h30m (16,200 s) while
--     civitics.cron_job_budget is 5,400 s, so the FIX-1063 watchdog always
--     axed the run mid-chunk before the procedure's own predictive guard could
--     stop it cleanly at a chunk boundary (it did exactly that at 5,409.8 s on
--     09-01). Aligned to 5,400 s so the guard is live again. The
--     civitics.treemap_global_budget_seconds GUC still overrides, unchanged.
--
-- WHAT IS DELIBERATELY NOT CHANGED: jobid 26's schedule, jobid 24, the canary's
-- thresholds. The convergence receipt is the next Tuesday 14:00 UTC firing.
--
-- The procedure body below is the LIVE prod body (md5 39329398acf3e4a931c9ff8838391676, identical to
-- 20260902100000_fix1028_sweep_981_979_994.sql) with exactly those two literals
-- changed. New md5: 931ba6716e8bd75e6ad13c57d9ab9d3d.

-- NOT "CONCURRENTLY" here, and that is deliberate — CONCURRENTLY cannot run
-- inside the transaction `supabase db push` wraps each migration in. The
-- concurrent build is scripts/fix1142-build-treemap-global-index.mjs, which
-- already ran against prod; this plain form is a no-op there (IF NOT EXISTS)
-- and is only ever reached on local or a rebuilt-from-zero database, where an
-- ACCESS EXCLUSIVE lock costs nothing. Exactly the FIX-1118 split.
CREATE INDEX IF NOT EXISTS financial_relationships_treemap_global_rollup
  ON public.financial_relationships (from_id) INCLUDE (amount_cents)
  WHERE from_type = 'financial_entity'
    AND relationship_type = 'donation'
    AND to_type = 'official';

COMMENT ON INDEX public.financial_relationships_treemap_global_rollup IS
  'FIX-1142 — covering partial index over the ~6.6M individual-donation-to-official '
  'rows of financial_relationships. Makes refresh_treemap_individuals_global''s '
  'per-chunk donor aggregation an Index Only Scan (measured 57,432 reads/chunk on '
  'the derivation path vs 2,423 covering). Sibling of '
  'financial_relationships_donation_size_rollup, which lacks to_type and so cannot '
  'serve this query. Built CONCURRENTLY out-of-band 2026-09-04.';

CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key  bigint := hashtext('treemap_individuals_global_refresh')::bigint;
  c_global    uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks    int    := 64;              -- 4-per-first-byte from_id ranges
  c_state_key text   := 'treemap_global_refresh';
  c_max_sweep interval := interval '240 hours';
  c_budget    interval := interval '5400 seconds';
  v_state      jsonb;
  v_cursor     int;                      -- last COMMITTED chunk (-1 = none)
  v_resumed    boolean := false;
  v_restarted  text    := NULL;          -- non-NULL = why a resume was discarded
  v_sweep_beg  timestamptz;
  v_log_id     uuid;
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- cc-98 measured this procedure cancelled on 2026-09-01 at 5,409.8 s against
  -- jobid 26's 5,400 s budget; WHEN OTHERS did not match it, so the terminal
  -- UPDATE below was skipped and the row sat 'running' until the reaper.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('treemap_individuals_global_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent refresh'));
    RAISE NOTICE '[treemap-global refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Plain SET (not SET LOCAL) survives the per-chunk COMMITs. The caller's
  -- statement_timeout is armed at CALL start and CANNOT be changed from here
  -- (FIX-944, measured) — the c_budget guard below is the only clean stop.
  SET work_mem = '256MB';

  v_budget_cfg := NULLIF(current_setting('civitics.treemap_global_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF to_regclass('public._tin_state_name') IS NULL THEN
      v_restarted := 'staging table missing (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._tin_state_name LIMIT 1) THEN
      v_restarted := 'staging table empty despite a committed cursor — crash-truncated';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[treemap-global refresh] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    -- Fresh sweep: (re)create staging and stamp the sweep start.
    DROP TABLE IF EXISTS public._tin_state_name;
    CREATE UNLOGGED TABLE public._tin_state_name (
      state          text   NOT NULL,
      donor_name     text   NOT NULL,
      total_cents    bigint NOT NULL,
      donation_count bigint NOT NULL,
      PRIMARY KEY (state, donor_name)
    );
    -- Supabase default privileges grant table access broadly; this staging can
    -- persist for days mid-sweep. Route reads go through the rollup, never this.
    REVOKE ALL ON public._tin_state_name FROM PUBLIC, anon, authenticated;
    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text),
          updated_at = clock_timestamp();   -- FIX-981
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('treemap_individuals_global_refresh', 'running', v_started,
          jsonb_build_object(
            'scope', 'global', 'shape', 'resumable 64-chunk merge',
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish staging + running row; keep the first chunk's txn short

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    -- PREDICTIVE budget check (FIX-944): stop when the slowest chunk observed
    -- so far (plus 25% headroom) would not fit in what remains.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_chunk > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[treemap-global refresh] budget guard — stopping before chunk % (elapsed %s, slowest chunk %s)',
        k, round(v_elapsed)::int, round(v_max_chunk)::int;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * 4), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * 4), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      -- Group FR by donor FIRST (rides the donation_size rollup index), join
      -- financial_entities once per donor, partial-aggregate to (state, name),
      -- MERGE into staging. GROUP BY dedupes within the statement, so
      -- ON CONFLICT only ever fires for prior chunks' rows.
      INSERT INTO public._tin_state_name AS t (state, donor_name, total_cents, donation_count)
      SELECT
        COALESCE(fe.metadata->>'state', '??') AS state,
        fe.display_name                       AS donor_name,
        SUM(da.total_cents)::bigint,
        SUM(da.donation_count)::bigint
      FROM (
        SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total_cents, COUNT(*)::bigint AS donation_count
        FROM public.financial_relationships fr
        WHERE fr.relationship_type = 'donation'
          AND fr.from_type         = 'financial_entity'
          AND fr.to_type           = 'official'
          AND fr.amount_cents > 0
          AND fr.from_id >= v_lo
          AND (v_hi IS NULL OR fr.from_id < v_hi)
        GROUP BY fr.from_id
      ) da
      JOIN public.financial_entities fe ON fe.id = da.from_id AND fe.entity_type = 'individual'
      GROUP BY 1, 2
      ON CONFLICT (state, donor_name) DO UPDATE
        SET total_cents    = t.total_cents    + EXCLUDED.total_cents,
            donation_count = t.donation_count + EXCLUDED.donation_count;

      -- The whole fix: cursor advances INSIDE the chunk's transaction. A run
      -- cancelled mid-chunk keeps every committed chunk and resumes at k.
      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()   -- FIX-981: after N COMMITs, now() is this chunk's txn start
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        -- Committing the merge WITHOUT the cursor would double-count this
        -- range on the next run. Abort the chunk (the merge rolls back).
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error EXCEPT
    -- query_canceled and assert_failure, so the budget watchdog's cancel used to
    -- blow straight out of the procedure from here. Falling out of the loop
    -- instead reaches the terminal UPDATE, which is the whole point. The cursor
    -- is written INSIDE the chunk txn (above), so the cancelled chunk rolls back
    -- with its cursor advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s: %s', k, SQLERRM);
      RAISE WARNING '[treemap-global refresh] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      -- A skipped range would corrupt the global aggregate — fail the run,
      -- keep the cursor at the last COMMITTED chunk, let the next CALL retry.
      v_failed := format('chunk %s: %s', k, SQLERRM);
      RAISE WARNING '[treemap-global refresh] chunk % FAILED: %', k, SQLERRM;
    END;

    -- EXIT before the COMMIT: the caught chunk has already rolled back to the
    -- subtransaction savepoint, and committing here would publish nothing but
    -- would also not help. Both arms leave the cursor at the last GOOD chunk.
    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;  -- top level (PL/pgSQL forbids COMMIT inside the EXCEPTION block)

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    IF (k + 1) % 8 = 0 THEN
      RAISE NOTICE '[treemap-global refresh] chunk %/% done (%s)', k + 1, c_chunks, round(v_chunk_secs)::int;
    END IF;
  END LOOP;

  -- FIX-1028 — a cancelled run is PARTIAL and RESUMABLE: every chunk it did
  -- commit is real and the cursor points at it. Distinct from 'failed' (a chunk
  -- raised) and from the budget guard's own clean stop below.
  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(),
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1 FROM public.pipeline_state WHERE key = c_state_key), 0),
             c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'canceled', true,
             'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[treemap-global refresh] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    -- Partial, resumable — distinct from 'complete' and 'failed' (FIX-944).
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(),
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1 FROM public.pipeline_state WHERE key = c_state_key), 0),
             c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[treemap-global refresh] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  -- Publish: swap the GLOBAL scope in ONE transaction, clear the sweep state,
  -- drop staging. Readers see the old top-50 until this commits.
  DELETE FROM public.treemap_individuals_rollup WHERE scope_id = c_global;

  WITH ranked AS (
    SELECT state, donor_name, total_cents, donation_count,
      ROW_NUMBER() OVER (PARTITION BY state ORDER BY total_cents DESC, donor_name) AS rank
    FROM public._tin_state_name
  ),
  ins AS (
    INSERT INTO public.treemap_individuals_rollup
      (scope_id, state, rank, donor_name, total_cents, donation_count)
    SELECT c_global, state, rank::int, donor_name, total_cents, donation_count
    FROM ranked WHERE rank <= 50
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows FROM ins;

  DROP TABLE IF EXISTS public._tin_state_name;

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text),   -- FIX-981
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[treemap-global refresh] complete — % rows', v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;
