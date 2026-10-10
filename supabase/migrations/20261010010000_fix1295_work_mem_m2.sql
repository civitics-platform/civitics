-- FIX-1295 (M2) — the work_mem step-down, M2 (cc-211): treemap and donor-party
-- (+ its crawl slice's proconfig) at 64MB.
--
-- Census of record: docs/audits/2026-10-09-work-mem-allowance-census.md — §1.1
-- (the registry) and §7 (the M2/M3 rows); its §5 ratios are reused as read
-- 2026-10-09 03:21Z (no bulk landing has moved pg_class since). M1 is
-- 20261009030000 (cc-210). M2 and M3 are separate files because their
-- receipts fall on different days: M2's are the Tuesday 14:00Z / 15:00Z
-- firings, so a Tuesday regression points at this file alone.
--
-- WHY. Both bodies SET 256MB = a 512 MB hash cap per node (hash_mem_multiplier
-- 2) on a 904 MB box, and both wrote 0 temp in pgss at 256MB: every hash and
-- sort they built sat in private memory, against 4.5M and 5.9M shared blocks.
--
-- THE MEASUREMENT (R5, local prod-clone, cc-205's recipe as census §5 states
-- it: 256MB vs 64MB, parallel 0 both, hash_mem_multiplier untouched, cold for
-- each body's top statement, RssAnon sampled per second). Verdict = wall <=
-- 1.5x and no Hash Join flip and temp under the clone's free disk (918 GB):
--   refresh_treemap_individuals_global      PASS. The publish's ranked top-50
--       sort over a whole sweep's staging (1.64M rows): quicksort 124 MB ->
--       external merge 66 MB disk; 4.85 / 4.74 -> 4.66 / 4.73 s; RssAnon
--       115 -> 68 MB. The per-chunk merge has no node over 100k rows (a 2 MB
--       sort over 27.5k rows; identical plans) — warm 0.36 s at both; its cold
--       walls (4.8-10.1 s) are FE-pkey random reads, same 20.7k blocks.
--       Projected (FE tuples x1.42): the publish sort is ~176 MB, in memory at
--       256MB, a small external merge at 64MB.
--   refresh_donor_party_rollup_incremental  PASS. Crawl mode on the clone (lag
--       14 d < its 30 d full_rebuild_lag); the full-mode window stage measured
--       as a statement anyway (window 1/16): HashAgg B1 30.7 MB, hashes 19 /
--       2 MB, identical plans, 1.57 -> 1.80 s warm. Projected x1.46: ~45 MB, so
--       64MB still holds it in one batch. The FIX-1212 windowing already keeps
--       full mode under 64MB; there is no single GROUP BY over every donation.
--   refresh_donor_party_rollup_slice        PASS. The crawl unit whole over a
--       real 50k-row slice (watermark rewound in-txn — the clone's is caught
--       up): 22.2 -> 23.1 s cold, 1.34 -> 1.31 s warm, RssAnon 49 MB at both.
--       Nothing it builds approaches 64MB; the 256MB was a ceiling nobody hit.
--
-- WHAT THIS DOES.
--   B4  refresh_treemap_individuals_global: SET work_mem 64MB + parallel 0
--       (+2/-1).
--   B5  refresh_donor_party_rollup_incremental: SET work_mem 64MB (-1/+1); its
--       FIX-1212 `SET max_parallel_workers_per_gather = 0` is already there.
--       refresh_donor_party_rollup_slice: the PROCONFIG `SET work_mem TO
--       '64MB'` (-1/+1 in the header; the body is byte-identical). It inherits
--       the procedure's parallel 0 — a proconfig overrides only what it names.
--
-- Every body is a full CREATE OR REPLACE copied from its latest file (each
-- equal to prod's prosrc by md5, read 2026-10-10 04:22Z; no CRLF in any) with
-- ONLY the SET lines changed. work-mem-allowances.test.ts proves it by a line
-- diff against each source file, the slice's header included.
--
-- fix1128: the two COMMITting procedures keep proconfig NULL. The slice is a
-- FUNCTION (atomic by construction) whose proconfig already carried work_mem;
-- only its value changes.
--
-- ROLLBACK — per body, SET 256MB, never RESET (design B0's rule: RESET lands on
-- the role default, 64MB since M1, not on the prior state):
--   ROLLBACK refresh_treemap_individuals_global: re-apply its CREATE OR REPLACE
--     from 20260911000100 (SET work_mem = '256MB', no parallel line).
--   ROLLBACK refresh_donor_party_rollup_incremental: re-apply from
--     20260927020000 (SET work_mem = '256MB').
--   ROLLBACK refresh_donor_party_rollup_slice: re-apply from 20260903010000
--     (SET work_mem TO '256MB' in the header).
--
-- NOT TOUCHED: the wrappers, the proconfig-64 units, hash_mem_multiplier (D5),
-- maintenance_work_mem, the weekly merge, any schedule.

-- ---------------------------------------------------------------------------
-- refresh_treemap_individuals_global — copied from 20260911000100_fix950_guards_rollup_family.sql; grants as last stated at 20260902100000:1292-1293
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
 LANGUAGE plpgsql
AS $procedure$
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
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('treemap_individuals_global_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[treemap-global refresh] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Plain SET (not SET LOCAL) survives the per-chunk COMMITs. The caller's
  -- statement_timeout is armed at CALL start and CANNOT be changed from here
  -- (FIX-944, measured) — the c_budget guard below is the only clean stop.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

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
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_treemap_individuals_global() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;

-- ---------------------------------------------------------------------------
-- refresh_donor_party_rollup_incremental — copied from 20260927020000_fix918_primary_industry_tag.sql; grants as last stated at 20260927010000:510-511
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('donor_party_rollup_refresh')::bigint;
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  -- FIX-1212 — the full-rebuild cursor, and the age past which it is discarded.
  c_cursor_key     text     := 'donor_party_full_rebuild';
  -- FIX-1216 — 3 weekly firings + 1 d of slack. started_at is the FIRST
  -- firing's, so at 7 d the second firing always found the cursor a few ms
  -- past the bound and discarded it; weekly firings never reached 16/16.
  c_cycle_max_age  interval := interval '22 days';
  v_cfg        jsonb;
  v_budget     interval;
  v_max_units  int;
  v_full_lag   interval;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_target     timestamptz;
  v_lag        interval;
  v_mode       text;
  v_i          int;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint := 0;
  v_n          bigint;
  v_units      int     := 0;
  v_donors     bigint  := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_failures   text[]  := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text    := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
  v_res        jsonb;
  i            int;
  -- FIX-1212 — the windowed full rebuild.
  v_cursor         jsonb;
  v_discarded      jsonb   := NULL;
  v_resumed        boolean := false;
  v_cycle_started  timestamptz;
  v_cycle_target   timestamptz;
  v_done           int[]   := ARRAY[]::int[];
  v_win_run        int[]   := ARRAY[]::int[];
  v_stage_s        numeric[] := ARRAY[]::numeric[];
  v_apply_s        numeric[] := ARRAY[]::numeric[];
  v_max_unit       interval := interval '0';
  v_t0             timestamptz;
  v_t1             timestamptz;
  v_fr_w           text;
  v_et_w           text;
  v_fe_w           text;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-party-rollup] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703,
  -- FIX-1185): the CALL's statement bound is the postgres role default (3 h)
  -- armed at CALL start — nothing in this body can change it. The budget guard
  -- below and the FIX-1063 watchdog are the real stops.
  SET work_mem = '64MB';
  -- FIX-1212 — FIX-1123's remedy: no parallel workers, so one window's memory is
  -- one backend's memory, not (1 + workers) copies of it.
  SET max_parallel_workers_per_gather = 0;

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_budget    := make_interval(secs => GREATEST(
                   COALESCE((v_cfg->>'unit_budget_seconds')::numeric, 1500), 60));
  v_max_units := GREATEST(COALESCE((v_cfg->>'max_units')::int, 40), 1);
  v_full_lag  := make_interval(days => GREATEST(
                   COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));

  -- ── the mode decision, O(1) ──────────────────────────────────────────────
  -- Two index probes and a subtraction. The old body materialised
  -- array_agg(DISTINCT from_id) over the whole backlog — 3.3M uuids on
  -- 2026-09-02 — purely to compare its length against a threshold, then
  -- discarded it. That array build IS the 1,814 s that the watchdog killed on
  -- 2026-09-01. It is gone.
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon. Bounds the lag that picks the mode AND the
  -- watermark the full path writes below.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  v_lag  := CASE WHEN v_watermark IS NULL OR v_target IS NULL
                 THEN NULL ELSE v_target - v_watermark END;

  -- FIX-1212 — a full rebuild in progress wins the decision. A cursor younger
  -- than c_cycle_max_age is resumed whatever the lag is now; an older (or
  -- malformed) one is discarded and the mode decided afresh.
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;
  IF v_cursor IS NOT NULL THEN
    IF v_cursor->>'mode' IN ('bootstrap', 'full')
       AND (v_cursor->>'started_at')::timestamptz > clock_timestamp() - c_cycle_max_age
       AND v_cursor->>'target' IS NOT NULL THEN
      v_resumed       := true;
      v_mode          := v_cursor->>'mode';
      v_cycle_started := (v_cursor->>'started_at')::timestamptz;
      v_cycle_target  := (v_cursor->>'target')::timestamptz;
      SELECT COALESCE(array_agg(DISTINCT x::int ORDER BY x::int), ARRAY[]::int[])
        INTO v_done
        FROM jsonb_array_elements_text(COALESCE(v_cursor->'windows_done', '[]'::jsonb)) x;
    ELSE
      v_discarded := v_cursor;
    END IF;
  END IF;

  IF NOT v_resumed THEN
    v_mode := CASE
                WHEN v_watermark IS NULL     THEN 'bootstrap'
                WHEN v_lag > v_full_lag      THEN 'full'
                ELSE                              'crawl'
              END;
    IF v_mode IN ('bootstrap', 'full') THEN
      -- A new cycle. Its target is fixed HERE, before window 1 reads anything.
      v_cycle_started := v_started;
      v_cycle_target  := COALESCE(v_target, public.fr_watermark_horizon());   -- FIX-983
    END IF;
  END IF;

  IF v_discarded IS NOT NULL THEN
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    RAISE WARNING '[donor-party-rollup] discarded a stale full-rebuild cursor (started %, % window(s) done)',
      v_discarded->>'started_at', jsonb_array_length(COALESCE(v_discarded->'windows_done', '[]'::jsonb));
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_strip_nulls(jsonb_build_object(
                             'mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int,
                             'resumed', CASE WHEN v_mode IN ('bootstrap', 'full') THEN v_resumed END,
                             'cycle_started_at', v_cycle_started,
                             'cycle_target', v_cycle_target,
                             'windows_done_before', CASE WHEN v_mode IN ('bootstrap', 'full')
                                                         THEN to_jsonb(v_done) END,
                             'cursor_discarded', v_discarded)))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Windowed full rebuild (FIX-1212) ═══════════════════════════════════
    -- Sixteen donor-id windows. Each is ONE bounded unit: stage the window's
    -- aggregate, replace the window in donor_party_rollup_mv, record it in the
    -- cursor, COMMIT. The GROUP BY and both joins are bounded to the window, so
    -- the peak is ~1/16 of the whole-table stage's (clone: 30.7 MB + 19.2 MB
    -- against 434 MB + 306 MB). A cap or a cancel banks every window already
    -- committed; the next CALL or firing resumes at the first window not done.
    --
    -- Cost is NOT independent of the lag's consequences (FIX-1112's header said
    -- it was: "~350-420 s on prod regardless"). It scales with
    -- financial_relationships and financial_entities — 21,628.6 s on 2026-08-04
    -- and 11,278 s on 2026-09-22 as one statement. What the windows buy is that
    -- no single statement has to be the whole of it.
    FOR i IN 1..16 LOOP
      CONTINUE WHEN i = ANY (v_done);

      IF v_units >= v_max_units THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] UNIT CAP (%) reached before window %/16; stopping cleanly', v_max_units, i;
        EXIT;
      END IF;
      -- Project the next window from the longest one this call has run, so the
      -- CALL stops AT its budget rather than one window past it. The first
      -- window of a call always runs (v_max_unit is 0), which is what
      -- guarantees progress.
      IF (clock_timestamp() - v_started) + v_max_unit >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET: % elapsed + % longest window >= %; stopping before window %/16',
          clock_timestamp() - v_started, v_max_unit, v_budget, i;
        EXIT;
      END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      -- Literal bounds, so each window is planned against its real range.
      v_fr_w := format('fr.from_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fr.from_id < %L::uuid', v_hi) END;
      v_et_w := format('et.entity_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND et.entity_id < %L::uuid', v_hi) END;
      v_fe_w := format('fe.id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fe.id < %L::uuid', v_hi) END;

      BEGIN
        v_t0 := clock_timestamp();
        DROP TABLE IF EXISTS dpr_stage_w;
        EXECUTE format($stage$
          CREATE TEMP TABLE dpr_stage_w AS
          WITH agg AS MATERIALIZED (
            SELECT
              fr.from_id                          AS donor_id,
              COALESCE(o.party::text, 'unknown')  AS party_key,
              SUM(fr.amount_cents)::bigint        AS total_cents,
              COUNT(*)::bigint                    AS tx_count
            FROM public.financial_relationships fr
            JOIN public.officials o
              ON o.id = fr.to_id AND fr.to_type = 'official'
            WHERE fr.relationship_type = 'donation'
              AND fr.from_type = 'financial_entity'
              AND %1$s
            GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
          ),
          ind AS (
            -- FIX-918: the donor's primary industry, from its one home, for
            -- this window's tagged donors.
            SELECT pit.entity_id,
                   pit.tag           AS industry_tag,
                   pit.display_label AS industry_label
            FROM public.primary_industry_tag(ARRAY(
                   SELECT et.entity_id
                   FROM public.entity_tags et
                   WHERE et.entity_type  = 'financial_entity'
                     AND et.tag_category = 'industry'
                     AND %2$s)) pit
          )
          SELECT
            a.donor_id, a.party_key, fe.display_name AS donor_name,
            fe.entity_type, ind.industry_tag, ind.industry_label,
            a.total_cents, a.tx_count
          FROM agg a
          LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id AND %3$s
          LEFT JOIN ind                          ON ind.entity_id = a.donor_id
        $stage$, v_fr_w, v_et_w, v_fe_w);
        v_t1 := clock_timestamp();

        DELETE FROM public.donor_party_rollup_mv
         WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
        INSERT INTO public.donor_party_rollup_mv (
          donor_id, party_key, donor_name, entity_type, industry_tag,
          industry_label, total_cents, tx_count
        )
        SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
               industry_label, total_cents, tx_count
        FROM dpr_stage_w;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        DROP TABLE dpr_stage_w;

        -- The cursor rides the SAME transaction as the window's rows: it can
        -- never name a window whose apply rolled back.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
                  'mode',         v_mode,
                  'started_at',   v_cycle_started,
                  'target',       v_cycle_target,
                  'windows_done', to_jsonb(v_done || i)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();

        -- Locals last: a PL/pgSQL variable is NOT rolled back with the
        -- subtransaction, so nothing that can still raise may follow these.
        v_done     := v_done || i;
        v_win_run  := v_win_run || i;
        v_stage_s  := v_stage_s || round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 2);
        v_apply_s  := v_apply_s || round(EXTRACT(epoch FROM (clock_timestamp() - v_t1))::numeric, 2);
        v_max_unit := GREATEST(v_max_unit, clock_timestamp() - v_t0);
        v_rows     := v_rows + v_n;
        v_units    := v_units + 1;
        RAISE NOTICE '  [donor-party-rollup] window %/16 — stage % s, apply % s, % rows (% of 16 done)',
          i, v_stage_s[array_length(v_stage_s, 1)], v_apply_s[array_length(v_apply_s, 1)],
          v_n, array_length(v_done, 1);
      EXCEPTION
      -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
      WHEN query_canceled THEN
        v_canceled := format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED (rolled back whole — cursor unmoved): %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level, outside the EXCEPTION subtransaction
      -- FIX-1028 — the box has just proven it cannot finish one window; the
      -- remaining ones would each re-arm the same axe.
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;

    DROP TABLE IF EXISTS dpr_stage_w;
    COMMIT;

    -- All sixteen banked (across however many calls): the cycle recomputed
    -- EVERY donor, so the watermark jumps to the target fixed before window 1
    -- read. FR writes stamped after it are re-processed by the next crawl,
    -- never silently consumed. The cursor goes in the same transaction.
    IF (SELECT count(DISTINCT x) FROM unnest(v_done) x) = 16 THEN
      IF v_watermark IS NULL OR v_cycle_target > v_watermark THEN
        INSERT INTO public.pipeline_state (key, value)
        VALUES ('donor_party_rollup_watermark',
                jsonb_build_object('last_indexed_at', v_cycle_target::text))   -- FIX-983
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();
      ELSE
        -- Something advanced the watermark past this cycle's target mid-cycle.
        -- Writing the target would move it BACKWARDS (the FIX-983 rule).
        RAISE WARNING '  [donor-party-rollup] watermark % is already past cycle target %; left alone',
          v_watermark, v_cycle_target;
      END IF;
      DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ CRAWL PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < v_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_res := NULL;
      BEGIN
        v_res    := public.refresh_donor_party_rollup_slice();
        v_rows   := v_rows   + COALESCE((v_res->>'rows_written')::bigint, 0);
        v_donors := v_donors + COALESCE((v_res->>'donors')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing is
      -- stranded and nothing is skipped; the next firing retries the same
      -- slice. That is the whole point of FIX-1112.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [donor-party-rollup] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      v_units := v_units + 1;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [donor-party-rollup] slice -> % — % donors, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [donor-party-rollup] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;
    END LOOP;

    IF v_units >= v_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      -- FIX-979/981: clock_timestamp(), not now() — this transaction began
      -- after the last unit's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; every COMMITTED %s kept its progress, the next firing resumes from it',
                                 v_canceled,
                                 CASE WHEN v_mode IN ('bootstrap', 'full') THEN 'window' ELSE 'slice' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('%s — %s unit(s) run, resumable',
                                 CASE WHEN v_units >= v_max_units THEN 'unit cap reached'
                                      ELSE 'wall-clock budget reached' END, v_units), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode',            v_mode,
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'dirty_donors',    v_donors,
                        'rollup_rows',     v_rows,
                        'failures',        COALESCE(array_length(v_failures, 1), 0),
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- Where the next firing picks up. On the old code this
                        -- was always the same value as watermark_before, which
                        -- is what the ratchet looked like in the log.
                        'next_slice_from', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'donor_party_rollup_watermark'))
                      -- FIX-1212 — the windowed full rebuild's own clock (the
                      -- phase_seconds shape, rule 93). Absent on a crawl run.
                      || CASE WHEN v_mode IN ('bootstrap', 'full') THEN jsonb_build_object(
                           'windows_total', 16,
                           'windows_done',  to_jsonb(v_done),
                           'windows_run',   to_jsonb(v_win_run),
                           'stage_seconds', to_jsonb(v_stage_s),
                           'apply_seconds', to_jsonb(v_apply_s))
                         ELSE '{}'::jsonb END
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-party-rollup] % (mode=%) — % unit(s), % donors, % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_mode, v_units, v_donors, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'donor_party_rollup_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_donor_party_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_donor_party_rollup_incremental() TO service_role;

-- ---------------------------------------------------------------------------
-- refresh_donor_party_rollup_slice — copied from 20260903010000_fix983_fr_watermark_horizon.sql; grants as last stated at 20260903010000:391-392
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_slice()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_cfg        jsonb;
  v_slice_rows int;
  v_chunk      int;
  v_w          timestamptz;
  v_target     timestamptz;
  v_slice_end  timestamptz;
  v_dirty      uuid[];
  v_n          int;
  v_i          int;
  v_ids        uuid[];
  v_rows       bigint := 0;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg        := COALESCE(v_cfg, '{}'::jsonb);
  v_slice_rows := GREATEST(COALESCE((v_cfg->>'slice_rows')::int, 50000), 1000);
  v_chunk      := GREATEST(COALESCE((v_cfg->>'chunk_ids')::int,  5000),  100);

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_w
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  IF v_w IS NULL THEN
    -- A NULL watermark is the bootstrap case and cannot be served by slices:
    -- the incremental path only touches donors present in its dirty set, so it
    -- can never DELETE a rollup row whose last qualifying FR vanished. The
    -- caller drives the staged full rebuild instead. Defined behaviour.
    RETURN jsonb_build_object('bootstrap_required', true);
  END IF;

  -- O(1) via financial_relationships_updated_at, backward.
  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon (see fr_watermark_horizon()). slice_end is
  -- chosen from `updated_at > v_w AND <= v_target` and the dirty set from
  -- `> v_w AND <= slice_end`, so clamping v_target bounds both.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  IF v_target IS NULL OR v_target <= v_w THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the bound, established BEFORE any work ───────────────────────────────
  -- An index scan of exactly v_slice_rows entries. If a single timestamp is
  -- shared by more rows than that, slice_end lands on it and the slice is
  -- larger than nominal — but it is still strictly greater than the watermark,
  -- so the crawl can never fail to advance. That is the property that matters.
  SELECT max(s.updated_at) INTO v_slice_end
    FROM (SELECT fr.updated_at
            FROM public.financial_relationships fr
           WHERE fr.updated_at >  v_w
             AND fr.updated_at <= v_target
           ORDER BY fr.updated_at
           LIMIT v_slice_rows) s;

  IF v_slice_end IS NULL THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the dirty set, scoped to this slice ──────────────────────────────────
  -- Byte-for-byte the predicates refresh_donor_party_rollup_incremental() has
  -- always used; only the upper time bound is new. This is a pacing change,
  -- not a semantics change.
  SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
    FROM public.financial_relationships fr
   WHERE fr.relationship_type = 'donation'
     AND fr.from_type = 'financial_entity'
     AND fr.to_type   = 'official'
     AND fr.updated_at >  v_w
     AND fr.updated_at <= v_slice_end;

  v_n := COALESCE(array_length(v_dirty, 1), 0);
  v_i := 1;
  WHILE v_i <= v_n LOOP
    v_ids  := v_dirty[v_i : LEAST(v_i + v_chunk - 1, v_n)];
    v_rows := v_rows + public.donor_party_rollup_rebuild_donors(v_ids);
    v_i    := v_i + v_chunk;
  END LOOP;

  -- ── the watermark, in this same transaction ──────────────────────────────
  -- No COMMIT above and none here. Either every row this slice wrote AND this
  -- advance are durable, or neither is. FIX-1112's rule, enforced by the
  -- language: this is a FUNCTION, so it cannot COMMIT even if a future edit
  -- wanted it to.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_party_rollup_watermark',
          jsonb_build_object('last_indexed_at', v_slice_end::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = clock_timestamp();

  RETURN jsonb_build_object(
    'caught_up',    v_slice_end >= v_target,
    'watermark',    v_slice_end,
    'from',         v_w,
    'donors',       v_n,
    'rows_written', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_donor_party_rollup_slice() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_slice() TO service_role;
