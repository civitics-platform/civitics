-- =============================================================================
-- FIX-965 — Make refresh_treemap_individuals_global() RESUMABLE across runs
-- (was chunked-but-monolithic: one CALL had to fit the whole population).
--
-- ── What broke (measured on prod) ────────────────────────────────────────────
-- The FIX-779c shape ran 16 Phase-A chunks + one Phase-B join inside a single
-- CALL. statement_timeout arms ONCE at CALL start and the per-chunk COMMITs do
-- not re-arm it (FIX-944, measured), so the whole refresh had to fit whatever
-- timeout the caller carried. Pre-indiv22 that was ~27 min (cron runs 07-21 /
-- 07-28: 25-27 min). The FIX-952 indiv22 backfill tripled the individual-donor
-- population (financial_entities ~3.64M) and the same CALL now exceeds every
-- budget it runs under:
--   * 2026-08-04 08:15 cron run — cancelled at EXACTLY 6h (the postgres role's
--     statement_timeout), mid Phase-A INSERT, under nightly contention.
--   * 2026-08-05 15:07 manual CALL, IDLE box, statement_timeout=2400s —
--     cancelled at 40.1 min. The cancellation wedged the instance ~15:50-22:41.
-- A cancelled CALL loses ALL progress (staging is dropped at start, nothing is
-- cursor-tracked), so re-issuing the same CALL can never converge — and the
-- surface keeps serving pre-FIX-934 (pre-delete) data.
--
-- ── The fix (FIX-944 pattern, sized for indiv20/FIX-961 growth) ─────────────
-- One loop of 64 from_id-RANGE chunks; each chunk group-then-joins its donor
-- range and MERGEs the per-(state, donor_name) partial into a durable UNLOGGED
-- staging table, then advances a cursor in pipeline_state INSIDE the same
-- transaction and COMMITs. from_id ranges partition donors, so per-range
-- partials sum additively (a donor lands in exactly one chunk). After chunk 63,
-- a publish step swaps the GLOBAL scope of treemap_individuals_rollup in one
-- transaction and clears the sweep state.
--
--   * A PREDICTIVE between-chunk wall-clock budget (elapsed + slowest*1.25) is
--     the ONLY clean stop — default 4h30m under the 6h role ceiling,
--     overridable per-session via GUC civitics.treemap_global_budget_seconds
--     (session-scoped like FIX-944's: a dead run cannot strand a widened
--     budget). Budget hit → status='partial', resumable at chunk_cursor+1.
--   * A run cancelled mid-chunk loses AT MOST that chunk: the cursor write
--     shares the chunk's transaction, so a cancelled run can never claim a
--     chunk it did not commit. Cancellation is no longer a control path —
--     but it is survivable.
--   * Chunk FAILURE aborts the run (status='failed', cursor kept at the last
--     committed chunk). Unlike FIX-944's per-recipient units, a skipped range
--     here would silently corrupt the global aggregate, so there is no
--     skip-and-continue.
--   * Staging is UNLOGGED (no WAL) and lives in public so it survives the
--     per-chunk COMMITs and session ends. Crash recovery TRUNCATES unlogged
--     tables, so a resume that finds the staging missing/empty restarts the
--     sweep from chunk 0. A sweep older than 72h also restarts fresh: merged
--     partials mix FR epochs, and a multi-day mix is worse than redoing the
--     work.
--
-- The per-chunk statement preserves FIX-779c's I/O shape (group FR by donor
-- FIRST, join financial_entities once per donor, never per FR row) — only now
-- each range is its own committed, cursor-tracked statement instead of a phase
-- inside one cancellable CALL.
--
-- Result is IDENTICAL to FIX-779/779c: top-50 individual donors per state,
-- uncapped, into the GLOBAL sentinel scope. The weekly cron
-- (treemap-individuals-global-refresh, Tue 08:15 UTC) needs no change; a
-- parked partial resumes on the next CALL. Break-glass single-pass driver:
-- packages/data/src/scripts/treemap-global-sweep.ts.
--
-- Cross-ref [[FIX-965]] [[FIX-944]] [[FIX-779]] [[FIX-868]] [[FIX-952]]
-- [[FIX-934]] [[FIX-943]] [[FIX-961]] [[FIX-964]].
-- =============================================================================

-- The FIX-779c Phase-A staging leaked on prod when its CALLs were cancelled
-- (the DROP lived at the end of the procedure). The new shape never uses it.
DROP TABLE IF EXISTS public._tin_donor_agg;

CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key  bigint := hashtext('treemap_individuals_global_refresh')::bigint;
  c_global    uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks    int    := 64;              -- 4-per-first-byte from_id ranges
  c_state_key text   := 'treemap_global_refresh';
  c_max_sweep interval := interval '72 hours';
  c_budget    interval := interval '4 hours 30 minutes';
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
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('treemap_individuals_global_refresh', 'skipped', now(), now(),
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
    v_sweep_beg := now();
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text),
          updated_at = NOW();
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('treemap_individuals_global_refresh', 'running', now(),
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
             updated_at = NOW()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        -- Committing the merge WITHOUT the cursor would double-count this
        -- range on the next run. Abort the chunk (the merge rolls back).
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- A skipped range would corrupt the global aggregate — fail the run,
      -- keep the cursor at the last COMMITTED chunk, let the next CALL retry.
      v_failed := format('chunk %s: %s', k, SQLERRM);
      RAISE WARNING '[treemap-global refresh] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;  -- top level (PL/pgSQL forbids COMMIT inside the EXCEPTION block)

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    IF (k + 1) % 8 = 0 THEN
      RAISE NOTICE '[treemap-global refresh] chunk %/% done (%s)', k + 1, c_chunks, round(v_chunk_secs)::int;
    END IF;
  END LOOP;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = now(), error_message = left(v_failed, 1000),
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
       SET status = 'partial', completed_at = now(),
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
     SET value = jsonb_build_object('last_completed_at', now()::text),
         updated_at = NOW()
   WHERE key = c_state_key;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = now(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[treemap-global refresh] complete — % rows', v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

COMMENT ON PROCEDURE public.refresh_treemap_individuals_global() IS
  'FIX-779/779c/965 — recompute the GLOBAL treemap_individuals_rollup scope '
  '(true uncapped top-50 individual donors per state). FIX-965: RESUMABLE — 64 '
  'from_id-range chunks merge per-(state,name) partials into UNLOGGED staging '
  'public._tin_state_name, cursor in pipeline_state.treemap_global_refresh '
  'advanced inside each chunk transaction, predictive wall-clock budget '
  '(default 4h30m; GUC civitics.treemap_global_budget_seconds) exits '
  'status=''partial'' — re-CALL to continue. Publish swaps the global scope in '
  'one final transaction. Weekly pg_cron Tue 08:15 UTC; break-glass driver: '
  'packages/data/src/scripts/treemap-global-sweep.ts.';

REVOKE ALL ON PROCEDURE public.refresh_treemap_individuals_global() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;
