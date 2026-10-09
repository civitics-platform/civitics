-- FIX-1294, FIX-1295 (M1), FIX-1287 — the work_mem step-down, M1 (cc-210).
--
-- Census of record: docs/audits/2026-10-09-work-mem-allowance-census.md.
--
-- WHY. The postgres role row {statement_timeout=3h, work_mem=256MB} was set
-- once, by FIX-697 (20260630000000:37), and it is the floor for every session
-- that does not SET its own: ad-hoc db-query reads, migrations, the direct-pg
-- writers (all but two — census §6), platform-counts-daily and the probes. 21
-- active CALL jobs; 17 SET work_mem; 13 at 256MB. At hash_mem_multiplier 2
-- that is a 512 MB hash cap per node per process, doubled by a parallel hash,
-- on a 904 MB box whose MemAvailable sits near 430 MB. The 10-06 wedge ran
-- under run_rule_taggers' own 256MB; the 10-07 02:03Z ad-hoc cif_ledger read
-- ran 509.7 s under the role's 256MB with temp written 0 (every hash in RAM)
-- and owns the 02:02-02:12Z swap storm (swap-in up to 3,485/s, MemAvailable
-- 491 -> 249 MB). The worst pg_cron overlaps (30 d) are ec-crawl x
-- contract-flow (1,887 s) and ec-crawl x donor-rollup (1,806 s): 1,024 MB
-- serial each, 1,536 MB counting a parallel hash.
--
-- THE MEASUREMENT (R5, local prod-clone, cc-205's cold recipe; 256MB vs 64MB,
-- parallel 0 both, hash_mem_multiplier untouched). Verdict = wall <= 1.5x and
-- no Hash Join flip and temp under free disk:
--   run_entity_connections_rebuild  PASS. Contracts-arm sort, 3.82M rows: an
--       external merge at BOTH (351 MB disk); 65.9 -> 58.7 s; RssAnon 327 -> 110
--       MB. Dirty-set hash, 4.03M rows: B1 232 MB -> B5 128 MB; 5.83 -> 6.11 s.
--   donor_rollup_rebuild_bulk       PASS. Donor-dimension hash, 3.68M rows:
--       B2 425 MB -> B8 107 MB; RssAnon 446 -> 120 MB; 35.4 -> 13.6 s. By prod
--       tuples (x1.42) this is a ~500 MB hash at 256MB today. Chunk and targets
--       aggregates fit under 64MB (47 MB, 0.7 MB).
--   rebuild_entity_search_index     PASS. 74.0 -> 72.2 s; RssAnon 77 -> 75 MB.
--   run_rule_taggers('daily')       PASS. Pre-vote trio: every hash and sort
--       fits under 64MB (62 / 57 / 42 MB hashes, 48 MB sort); 342 -> 362 s cold.
--   rebuild_official_vote_stats     PASS. 2.56 -> 2.36 s; 46 MB sort fits.
--   refresh_platform_counts (inherits B0) PASS. 3.3 s at both; no node over
--       100k rows, so it takes no SET of its own.
--
-- WHAT THIS DOES.
--   B0  ALTER ROLE postgres IN DATABASE postgres SET work_mem = '64MB', read
--       back with BOTH settings asserted (D7; the FIX-1185 block re-stated).
--   B1  run_entity_connections_rebuild: SET work_mem 64MB + parallel 0.
--   B2  donor_rollup_rebuild_bulk:      SET work_mem 64MB + parallel 0.
--   B6  rebuild_entity_search_index:    SET LOCAL work_mem 64MB + SET LOCAL
--       parallel 0 (it is unit 9 of refresh_derived_mvs, which COMMITs per
--       unit, so the LOCAL ends at that unit's COMMIT, as before).
--       run_rule_taggers: the SET before the cadence split -> 64MB + parallel
--       0, both cadences; the weekly's own 64MB SET is kept so its allowance
--       stays explicit.
--       rebuild_official_vote_stats:    SET work_mem 64MB + parallel 0.
--   FIX-1287  run_rule_taggers builds v_phase as each phase finishes, in both
--       blocks. plpgsql variables survive the EXCEPTION handler (the
--       subtransaction rolls back rows, not variables), so a cancelled or
--       failed run's terminal UPDATE — which already writes phase_seconds when
--       v_phase <> '{}' — carries the phases that finished.
--
-- Every body is a full CREATE OR REPLACE copied from its latest file (each
-- equal to prod's prosrc by md5, read 2026-10-09 01:06Z) with ONLY the SET
-- lines and FIX-1287's lines changed. work-mem-allowances.test.ts proves that
-- by a line diff against each source file.
--
-- fix1128: no routine gains a SET clause. The three COMMITting procedures
-- keep proconfig NULL; the search index (a function) and vote stats (an
-- atomic procedure) keep only their search_path. B0 is role-level, the form
-- that genuinely applies.
--
-- NOT TOUCHED: hash_mem_multiplier (D5), maintenance_work_mem, the 64MB
-- proconfig units, M2/M3 (treemap, donor-party, contract-flow, the monthly
-- sweeps, group-donor — cc-211), statement_timeout.

-- ---------------------------------------------------------------------------
-- B0 — the postgres role default. Rollback is SET, never RESET: RESET lands on
-- the cluster default (4MB at boot, not readable here) and flips every ad-hoc
-- plan. Rollback:
--   ALTER ROLE postgres IN DATABASE postgres SET work_mem = '256MB';
-- ---------------------------------------------------------------------------
ALTER ROLE postgres IN DATABASE postgres SET work_mem = '64MB';

-- D7: the FIX-1185 read-back (20260916000000:89-104), re-stated for the new
-- value. Both settings live on the one pg_db_role_setting row.
DO $$
DECLARE
  cfg text[];
BEGIN
  SELECT s.setconfig INTO cfg
    FROM pg_db_role_setting s
    JOIN pg_roles r    ON r.oid = s.setrole
    JOIN pg_database d ON d.oid = s.setdatabase
   WHERE r.rolname = 'postgres' AND d.datname = 'postgres';
  RAISE NOTICE 'FIX-1294 pg_db_role_setting(postgres@postgres) = %', cfg;
  IF NOT ('statement_timeout=3h' = ANY(cfg)) THEN
    RAISE EXCEPTION 'FIX-1294: statement_timeout=3h did not survive the ALTER ROLE (got %)', cfg;
  END IF;
  IF NOT ('work_mem=64MB' = ANY(cfg)) THEN
    RAISE EXCEPTION 'FIX-1294: work_mem=64MB not present after ALTER ROLE (got %)', cfg;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- run_entity_connections_rebuild — copied from 20261004100000_fix1269_1132_1270_search_index_stamp_stats_read_arm_park.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text, IN p_max_units integer DEFAULT NULL::integer)
 LANGUAGE plpgsql
AS $procedure$DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- EXCEPTION WHEN OTHERS does not match query_canceled, so before this the 6h
  -- statement_timeout blew straight through both handlers below and out of the
  -- procedure, skipping the terminal UPDATE and stranding the row 'running'.
  v_canceled   text := NULL;
  -- ── FIX-1056 — budget + durable per-arm resume checkpoint ─────────────────
  -- 5h, deliberately 1h under the 6h `postgres` role statement_timeout so the
  -- terminal bookkeeping below is never the thing that gets cancelled. Do NOT
  -- raise this to 6h: the margin IS the feature. FIX-1071 mirrors this value in
  -- cron_job_budget as an OUTSIDE bound, because this one is checked at arm
  -- boundaries and therefore cannot bound a single arm.
  c_budget_default interval := interval '5 hours';
  c_budget        interval;
  c_cursor_key    text     := 'entity_connections_rebuild_cursor';
  c_budget_key    text     := 'entity_connections_rebuild_budget';
  c_cycle_max_age interval := interval '7 days';
  v_cursor        jsonb;
  v_done_arms     text[]   := ARRAY[]::text[];
  v_cycle_started timestamptz;
  v_budget_out    boolean  := false;
  v_arm_started   timestamptz;
  v_arm_failed    boolean;
  v_arm_timings   jsonb    := '{}'::jsonb;
  v_next_arm      text     := NULL;
  v_resumed       boolean  := false;
  -- ── FIX-1069 — the donations arm is windowed in BOTH modes ────────────────
  v_don_arm       text;
  v_incr_target   timestamptz := NULL;
  v_bootstrap     boolean  := false;
  v_closed        boolean;
  -- ── FIX-1101 ──────────────────────────────────────────────────────────────
  c_inflight_key  text     := 'entity_connections_window_inflight';
  v_interlock     jsonb;
  -- ── FIX-1111 — the crawl ──────────────────────────────────────────────────
  v_crawl        boolean := (p_max_units IS NOT NULL);
  v_units_run    int     := 0;
  v_unit_capped  boolean := false;
  v_gate         jsonb;
  v_unit_t0      timestamptz;
  v_unit_secs    numeric;
  v_rec          jsonb;
  v_backoff_set  boolean := false;
  v_win_since    timestamptz;
  v_unit_log     jsonb   := '[]'::jsonb;
  -- ── FIX-1115 — entity_connection_stats as 16 bounded windows ──────────────
  c_stats_arm    text    := 'entity_connection_stats_windows';
  c_stats_key    text    := 'entity_connection_stats_progress';
  v_stats_prog   jsonb;
  v_stats_done   int[]   := ARRAY[]::int[];
  v_stats_fp     text;
  v_stats_res    jsonb;
  v_stats_ups    bigint  := 0;
  v_stats_del    bigint  := 0;
  -- ── FIX-1117 — the per-arm source-change gate ─────────────────────────────
  c_fp_key       text    := 'ec_arm_source_fingerprints';
  v_fp           text;
  v_fp_prev      text;
  v_fp_t0        timestamptz;
  v_fp_secs      numeric := 0;
  v_gated_arms   text[]  := ARRAY[]::text[];
  -- ── FIX-1270 — park a generic arm after two consecutive cancels (cc-188) ───
  c_park_key      text    := 'ec_arm_parked';
  v_park          jsonb;
  v_last_two      text[];
  v_parked_now    text    := NULL;
  v_parked_detail text    := NULL;
  v_parked_arms   text[]  := ARRAY[]::text[];
  v_unparked_arms text[]  := ARRAY[]::text[];
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo         uuid;
  v_hi         uuid;
  v_win        bigint;
  v_donations_total bigint;
  i            int;
  -- FIX-1028 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- FIX-1111 — a unit cap of 0 or less is meaningless; treat it as a caller bug
  -- rather than silently doing nothing forever on a */15 schedule.
  IF v_crawl AND p_max_units < 1 THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  -- ── Concurrency guard (session advisory lock; survives the COMMITs below) ───
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'skipped', now(), now(),
      jsonb_build_object(
        'mode', p_mode,
        'skip_reason', 'advisory lock held by a concurrent entity_connections rebuild',
        'source', 'pg_cron'
      )
    );
    RAISE NOTICE '[rebuild] advisory lock held — skipping (mode=%)', p_mode;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connections_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rebuild] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- ── FIX-1111 — the crawl gate ─────────────────────────────────────────────
  -- Crawl mode only: p_max_units IS NULL is byte-for-byte today's behaviour, so
  -- an operator's unbounded manual run is never blocked by a policy written for
  -- a */15 background job.
  --
  -- Placed AFTER the advisory-lock guard (so the unlock below is unconditional)
  -- and BEFORE the FEC interlock, because it is strictly cheaper: two
  -- pipeline_state reads and one indexed data_sync_log aggregate, against the
  -- interlock's pg_locks scan.
  --
  -- LOGGING ASYMMETRY, deliberate. Only `backoff` writes a data_sync_log row.
  -- At */15 a blackout or cooldown skip would write up to 96 rows a day saying
  -- "I did nothing, on purpose", drowning the very log that FIX-1107-class
  -- diagnosis is read from. Backoff is rare, means the box is throttled, and is
  -- exactly what you want to find in that log. The other two are counted in
  -- ec_crawl.skips and RAISEd, which is greppable without being noise.
  IF v_crawl THEN
    v_gate := public.ec_crawl_gate();
    IF NOT (v_gate->>'run')::boolean THEN
      IF v_gate->>'reason' = 'backoff' THEN
        INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
        VALUES (
          'entity_connections_rebuild', 'skipped', v_started, clock_timestamp(),
          jsonb_build_object(
            'mode',        p_mode,
            'source',      'pg_cron',
            'skip_reason', v_gate->>'detail',
            'crawl',       true,
            'max_units',   p_max_units,
            'gate',        v_gate));
      END IF;

      UPDATE public.pipeline_state
         SET value = value
                   || jsonb_build_object(
                        'skips',
                        COALESCE(value->'skips', '{}'::jsonb)
                        || jsonb_build_object(
                             v_gate->>'reason',
                             COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                             'last_skip_at',     clock_timestamp(),
                             'last_skip_reason', v_gate->>'reason')),
             updated_at = now()
       WHERE key = 'ec_crawl';

      RAISE NOTICE '[rebuild/crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;
  END IF;

  -- ── FIX-1101 — the widened FEC interlock ──────────────────────────────────
  -- Defers BEFORE the log row goes 'running', before the cursor read and before
  -- any cycle is opened, so a deferred firing leaves no state behind and the
  -- next firing is indistinguishable from a first one.
  --
  -- The status is its own value, 'deferred', not 'skipped': a skip means a peer
  -- rebuild is already doing this work, a defer means the work is deliberately
  -- postponed. Conflating them would make the two indistinguishable in exactly
  -- the log this line of work is diagnosed from.
  --
  -- Placed AFTER the advisory-lock guard, so at this point we HOLD the rebuild
  -- lock and the unlock below is both required and unconditional.
  --
  -- FIX-1111 — this is also the whole Monday fix. jobid 22 is retired by the
  -- crawl, and the weekly FIX-903 FEC replay now simply defers crawl firings
  -- while it holds the lock or leaves a run_state. When it clears, the crawl's
  -- next unit runs — and if the replay spent the day's I/O budget, that unit's
  -- DURATION says so and the sensor above backs off 2 h. No schedule arithmetic.
  v_interlock := public.fec_bulk_interlock_state();

  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'deferred', v_started, clock_timestamp(),
      jsonb_build_object(
        'mode',          p_mode,
        'source',        'pg_cron',
        'defer_reason',  v_interlock->>'reason',
        'fec_interlock', v_interlock)
    );
    RAISE WARNING '[rebuild] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- A stale marker does NOT defer, but it must not be silent either: a
  -- run_state that never clears would otherwise convert one bad run into an
  -- indefinitely skipped arm.
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[rebuild] fec_bulk_run_state present but STALE (%s old) — proceeding; the marker is stranded and wants investigating',
      v_interlock->>'run_state_age';
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer. FIX-1069 re-measured the same for a FUNCTION's
  -- proconfig on the plain SELECT path (the GUC does change inside the body; the
  -- timer does not re-arm) and REMOVED the decorative 45min/90min guards from
  -- the donations arm functions rather than leave them to mislead.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the repro
  -- paths exercise the SHIPPED code path rather than a test variant of it.
  SELECT GREATEST(interval '1 second', make_interval(secs => (value->>'seconds')::numeric))
    INTO c_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  c_budget := COALESCE(c_budget, c_budget_default);

  -- ── FIX-1056 — read the resume cursor BEFORE opening the log row ───────────
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;

  IF v_cursor IS NOT NULL
     AND v_cursor->>'mode' = p_mode
     AND (v_cursor->>'cycle_started_at')::timestamptz > now() - c_cycle_max_age
  THEN
    v_cycle_started := (v_cursor->>'cycle_started_at')::timestamptz;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[])
      INTO v_done_arms
      FROM jsonb_array_elements_text(COALESCE(v_cursor->'completed_arms', '[]'::jsonb)) x;
    v_resumed := COALESCE(array_length(v_done_arms, 1), 0) > 0;
    IF v_resumed THEN
      RAISE NOTICE '[rebuild] resuming cycle started % — % arm(s) already banked: %',
        v_cycle_started, array_length(v_done_arms, 1), array_to_string(v_done_arms, ', ');
    END IF;
  ELSE
    -- No cursor, wrong mode, or a cycle too old to trust: start fresh.
    v_cycle_started := v_started;
    v_done_arms     := ARRAY[]::text[];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object(
      'mode', p_mode,
      'source', 'pg_cron',
      'resumed', v_resumed,
      'cycle_started_at', v_cycle_started,
      'budget_seconds', round(EXTRACT(epoch FROM c_budget))::int,
      'arms_banked_on_entry', to_jsonb(v_done_arms),
      -- FIX-1111
      'crawl', v_crawl,
      'max_units', p_max_units
    )
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  IF NOT COALESCE(
       (SELECT (split_part(opt, '=', 2))::boolean
          FROM pg_catalog.pg_class c, unnest(c.reloptions) AS opt
         WHERE c.oid = 'public.entity_connections'::regclass
           AND opt LIKE 'autovacuum_enabled=%'),
       true
     ) THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE WARNING '[rebuild] startup reconcile: autovacuum was stranded OFF on entity_connections — re-enabled (FIX-885)';
  END IF;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ═══ DONATIONS ARM — 16 COMMITTED WINDOWS, BOTH MODES (FIX-703/FIX-1069) ═══
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint, so the
  -- CALL-level budget never becomes an atomic multi-hour txn.
  --
  -- FIX-1069 — this is the change that matters. Before it this whole block was
  -- gated on `IF v_full`, and BOTH scheduled jobs run mode='incremental', so on
  -- prod the windowed path was unreachable code while the incremental arm ran
  -- as one 6-hour statement that banked nothing and wrote nothing.
  --
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. reconcile_recipient_count() survives as a break-glass full
  -- recompute with NO caller and NO cron job (FIX-736 unscheduled it; the
  -- FIX-1056 comment correction records why that mattered).
  v_don_arm := CASE WHEN v_full THEN 'donations_full_windows' ELSE 'donations_incr_windows' END;

  IF NOT (v_don_arm = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();

    -- ── prepare ──────────────────────────────────────────────────────────────
    IF v_full THEN
      BEGIN
        PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donations prepare: %s', SQLERRM);
        RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;
    ELSE
      -- FIX-1069 — stages the dirty set ONCE per cycle and returns the cycle
      -- target. Free on resume: an open cycle whose staging table is still
      -- populated returns immediately without rebuilding anything.
      BEGIN
        v_incr_target := public.rebuild_ec_donations_incr_prepare();
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare CANCELED: %', SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;

      -- A NULL target means no watermark has ever been set. The incremental
      -- path only touches donors present in its dirty set, so it cannot clear
      -- an edge whose donor has vanished from financial_relationships; a true
      -- bootstrap must go through the full windowed path, which range-DELETEs.
      IF v_canceled IS NULL
         AND v_incr_target IS NULL
         AND COALESCE(array_length(v_failures, 1), 0) = 0
      THEN
        v_bootstrap := true;
        v_don_arm   := 'donations_full_windows';
        RAISE WARNING '  [donations/incr] no watermark — bootstrapping via the FULL windowed path';
        BEGIN
          PERFORM public.rebuild_ec_donations_full_prepare();
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations prepare: %s', SQLERRM);
          RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
        END;
        COMMIT;
      END IF;
    END IF;

    -- ── the 16 windows ───────────────────────────────────────────────────────
    v_donations_total := 0;
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        -- ── FIX-1111 — skip a banked window BEFORE spending a unit on it ─────
        -- rebuild_ec_donations_incr_window() already returns 0 immediately for a
        -- window level with the cycle target; this hoists that same check into
        -- the driver so an already-banked window does not consume the crawl's
        -- one unit. Without it, a crawl firing that met 15 banked windows would
        -- "run" window 1 in ~0 s, count it, and exit — livelock at one useless
        -- firing every 15 minutes forever.
        --
        -- Read-only and exactly the function's own predicate, so NULL-mode
        -- behaviour is unchanged: the call it replaces returned 0 anyway.
        IF NOT v_full AND NOT v_bootstrap THEN
          SELECT (value->'windows'->>(i - 1)::text)::timestamptz
            INTO v_win_since
            FROM public.pipeline_state
           WHERE key = 'entity_connections_donations';

          IF v_win_since IS NOT NULL AND v_win_since >= v_incr_target THEN
            RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', i;
            CONTINUE;
          END IF;
        END IF;

        -- ── FIX-1111 — the unit cap ─────────────────────────────────────────
        -- Checked AFTER the skip above, so the cap is only ever spent on a
        -- window that will do real work.
        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, i);
          RAISE NOTICE '  [donations] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          -- FIX-1069 — name the arm AND the window. The end-of-run lookup below
          -- only covers v_fns, which never contains the donations window arm.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        -- ── FIX-1101 — publish the in-flight window ────────────────────────
        -- Must be COMMITted before the window starts, or the watchdog — which
        -- runs in a different backend — cannot see it. FIX-1030's shape.
        -- clock_timestamp(), not now(): now() is transaction_timestamp() and
        -- would date the window to whenever this transaction began.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_inflight_key, jsonb_build_object(
                  'window_idx',  i,
                  'started_at',  clock_timestamp(),
                  'backend_pid', pg_backend_pid(),
                  'mode',        p_mode,
                  'log_id',      v_log_id))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now();
        COMMIT;

        v_unit_t0 := clock_timestamp();   -- FIX-1111
        v_win     := 0;                   -- FIX-1111 — so a cancel records 0 rows, not NULL

        BEGIN
          IF v_full OR v_bootstrap THEN
            v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          ELSE
            -- p_idx is 0-based, to match the window watermark keys "0".."15".
            v_win := public.rebuild_ec_donations_incr_window(i - 1, v_lo, v_hi, v_incr_target);
          END IF;
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        EXCEPTION
        -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error
        -- EXCEPT query_canceled and assert_failure.
        WHEN query_canceled THEN
          v_canceled := format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          -- FIX-1101 — name the arm AND the window, matching what the BUDGET
          -- exit above already does. Before this, a cancelled window closed the
          -- row with next_arm = 'donations_incr_windows' and the window index
          -- only in cancel_detail, so the two exit paths described the same
          -- situation differently and next_arm alone could not tell an operator
          -- where to resume. Now that FIX-1101's watchdog makes a per-window
          -- cancel a ROUTINE outcome rather than an incident, that asymmetry
          -- would be read every week.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
        WHEN OTHERS THEN
          -- Per-window catch: one bad window must not abort the rest; the run is
          -- reported `failed`.
          v_failures := v_failures || format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
        END;
        -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction —
        -- PL/pgSQL forbids COMMIT inside one). This is the point at which the
        -- window's edges AND, in incremental mode, its watermark become durable
        -- together. Neither can land without the other.
        COMMIT;

        -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────
        -- A CANCELLED window is still counted and still recorded. It spent the
        -- I/O either way, and a 1,800 s cancel against a ~346 s median is
        -- precisely the reading that should trip the backoff — that is the
        -- sensor working, not an edge case to exclude.
        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     CASE WHEN v_full OR v_bootstrap THEN 'donations_full_window'
                          ELSE 'donations_incr_window' END,
                     format('%s window %s/16', v_don_arm, i),
                     v_unit_secs, v_win,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled' ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          -- The sensor must never be able to fail the run it is measuring.
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;

        -- FIX-1111 — the sensor tripped. In crawl mode stop here and let the
        -- gate hold the next firings off; in NULL mode the backoff is RECORDED
        -- for the crawl to obey but does NOT change this run's behaviour, which
        -- is what "NULL = today's behaviour" has to mean.
        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    -- FIX-1111 — `AND NOT v_unit_capped` is load-bearing. Without it a crawl
    -- firing that ran ONE window would fall into this branch, and although
    -- rebuild_ec_donations_incr_close() correctly refuses to close a cycle
    -- whose windows still lag (FIX-1069c), the arm would still be appended to
    -- v_done_arms below — so the NEXT firing would skip the entire donations
    -- arm with 15 windows unbuilt. The cap exit is an incomplete pass and must
    -- be treated exactly like a budget exit.
    IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1069 — close the incremental cycle: drop the staging rows and set
      -- the scalar watermark. Returns false if any window still lags, which
      -- cannot happen on this branch but is checked rather than assumed.
      IF NOT v_full AND NOT v_bootstrap THEN
        BEGIN
          v_closed := public.rebuild_ec_donations_incr_close(v_incr_target);
          IF NOT v_closed THEN
            RAISE WARNING '  [donations/incr] cycle NOT closed — a window still lags the target';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations incr close: %s', SQLERRM);
          RAISE WARNING '  [donations/incr] close FAILED: %', SQLERRM;
        END;
      END IF;

      IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_done_arms := v_done_arms || v_don_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
      END IF;
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed, %) — % (% edges)',
      CASE WHEN v_full THEN 'full' WHEN v_bootstrap THEN 'bootstrap' ELSE 'incremental' END,
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
           WHEN v_unit_capped THEN 'UNIT CAP'
           WHEN v_canceled IS NOT NULL THEN 'CANCELED'
           ELSE 'complete' END,
      v_donations_total;
  ELSE
    RAISE NOTICE '  [chunk] donations (windowed) — SKIPPED (already banked this cycle)';
  END IF;

  -- ── Remaining chunks (external + investigation MUST stay last) ─────────────
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_votes_full',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  ELSE
    -- FIX-1069 — 'rebuild_entity_connections_donations' REMOVED. That entry is
    -- what routed the incremental donations arm through the generic
    -- single-statement EXECUTE below; it is now driven as 16 committed windows
    -- above. The function still exists as a break-glass single-shot.
    v_fns := ARRAY[
      'rebuild_entity_connections_votes',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  END IF;

  FOREACH v_fn IN ARRAY v_fns LOOP
    -- FIX-1028 — a cancel in the donations windows above skips the chunks too.
    EXIT WHEN v_canceled IS NOT NULL;
    -- FIX-1056 — and so does a budget exhaustion in those windows.
    EXIT WHEN v_budget_out;
    -- FIX-1111 — and so does a unit-cap or backoff exit. Placed BEFORE the
    -- banked-arm CONTINUE so v_next_arm keeps the window index the donations
    -- exit already wrote into it, rather than being overwritten with the first
    -- outstanding chunk arm.
    EXIT WHEN v_unit_capped;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- ── FIX-1117 — the source-change gate ───────────────────────────────────
    -- Placed AFTER the banked-arm skip and BEFORE the unit cap, for exactly the
    -- reason the banked-window skip sits before the window cap: a gated arm did
    -- no work, so it must not consume the firing's one unit. A cycle whose ten
    -- arms are all unchanged therefore finishes in ONE firing rather than ten,
    -- and that is most of the saving — the ring measured _external and
    -- _contracts rebuilding byte-identical row counts (2 x 574,209 and
    -- 3 x 189,949) for ~1,244 s of writer per cycle.
    --
    -- ⚠ FAIL OPEN. A NULL fingerprint — unknown arm, probe error, or no stored
    -- previous value — RUNS the arm. The only path that skips is "I measured
    -- this source before the last successful build, I measured it now, and the
    -- two are equal". A gate that can silently freeze an arm is the FIX-885
    -- stranded-flag class and is strictly worse than the waste it removes.
    v_fp      := NULL;
    v_fp_prev := NULL;
    v_fp_t0   := clock_timestamp();
    BEGIN
      v_fp := public.ec_arm_source_fingerprint(v_fn);
    EXCEPTION
    -- FIX-1028 — by name, and it earns its place here: the probe is a statement
    -- like any other, so the FIX-1063 watchdog can land on it, and OTHERS does
    -- not match query_canceled. Without this a cancelled probe would escape the
    -- procedure entirely and strand the log row 'running'.
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', v_fn, SQLERRM);
      v_next_arm := v_fn;
      RAISE WARNING '  [gate] % — fingerprint probe CANCELED: %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [gate] % — fingerprint probe FAILED (%) — running the arm', v_fn, SQLERRM;
      v_fp := NULL;
    END;
    EXIT WHEN v_canceled IS NOT NULL;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    -- ── FIX-1270 — a parked arm is skipped until its source moves ───────────
    -- Parked by the block after the unit record below, after two consecutive
    -- cancels. Skipped WITHOUT spending a unit and banked for the cycle — the
    -- gated-arm shape — so the cycle can close and the stats fingerprint can
    -- advance behind it. It stays parked until its fingerprint differs from the
    -- one it was parked on (cleared here, automatically) or an operator deletes
    -- pipeline_state.ec_arm_parked->'<arm>'. A NULL fingerprint on either side
    -- proves nothing, so it does not unpark: running it is what livelocked.
    v_park := NULL;
    SELECT value->v_fn INTO v_park FROM public.pipeline_state WHERE key = c_park_key;
    IF v_park IS NOT NULL THEN
      IF v_fp IS NOT NULL AND (v_park->>'fp') IS NOT NULL AND v_fp <> (v_park->>'fp') THEN
        UPDATE public.pipeline_state
           SET value = value - v_fn, updated_at = now()
         WHERE key = c_park_key;
        COMMIT;
        v_unparked_arms := v_unparked_arms || v_fn;
        RAISE WARNING '  [park] % — source changed since it was parked (% -> %); unparked, running it',
          v_fn, v_park->>'fp', v_fp;
      ELSE
        v_done_arms   := v_done_arms   || v_fn;
        v_parked_arms := v_parked_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);
        -- rows = 0 and seconds = the probe: unratable and far under the
        -- absolute trip, so the mark can never feed the backoff sensor.
        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)',
                                               v_fp_secs, 0, 'skipped_parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        RAISE WARNING '  [chunk] % — SKIPPED (parked since %: %); delete pipeline_state.ec_arm_parked->''%'' to retry it',
          v_fn, v_park->>'since', v_park->>'last_detail', v_fn;
        CONTINUE;
      END IF;
    END IF;

    IF v_fp IS NOT NULL THEN
      SELECT value->'arms'->v_fn->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_fp THEN
      -- Unchanged. Bank it for this cycle — an arm whose source did not move IS
      -- built, and refusing to bank it would stop the cycle ever closing — then
      -- carry straight on to the next arm without spending a unit.
      v_done_arms  := v_done_arms  || v_fn;
      v_gated_arms := v_gated_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);

      -- The ring gets a "skipped_unchanged" mark so the lag metric can tell an
      -- IDLE arm from a GATED one. rows = 0 makes the entry unratable under
      -- FIX-1111b (rate is NULL below backoff_min_rows), so it is excluded from
      -- the median rate by construction and cannot drag down the baseline the
      -- next REAL run of this class is judged against. That property is why the
      -- mark can live in the same ring rather than needing a second one.
      BEGIN
        v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      RAISE NOTICE '  [chunk] % — SKIPPED (source unchanged since last build: %)', v_fn, v_fp;
      CONTINUE;
    END IF;

    -- FIX-1111 — the unit cap, after the banked-arm skip for the same reason
    -- the window cap sits after the banked-window skip: a cap must only ever be
    -- spent on work that will actually run.
    IF v_crawl AND v_units_run >= p_max_units THEN
      v_unit_capped := true;
      v_next_arm    := v_fn;
      RAISE NOTICE '  [chunk] % — UNIT CAP reached (% unit(s)); banking and exiting', v_fn, v_units_run;
      EXIT;
    END IF;

    -- FIX-1056 — stop BEFORE starting an arm the budget cannot cover, so the
    -- exit lands on an arm boundary with the cursor and the log row intact
    -- rather than being cancelled mid-statement by the 6h axe.
    IF clock_timestamp() - v_started >= c_budget THEN
      v_budget_out := true;
      v_next_arm   := v_fn;
      RAISE WARNING '  [chunk] % — BUDGET EXHAUSTED (%s elapsed); banking % arm(s) and exiting',
        v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
        COALESCE(array_length(v_done_arms, 1), 0);
      EXIT;
    END IF;

    v_arm_started := clock_timestamp();
    v_arm_failed  := false;
    v_n           := 0;   -- FIX-1111 — so a cancelled arm records 0 rows, not NULL
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION
    -- FIX-1028 — by name; see the donations handler above.
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — CANCELED (statement_timeout or operator cancel): %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      v_arm_failed := true;
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;

    -- FIX-1056 — per-arm elapsed, recorded for EVERY outcome. This is the
    -- observability gap that let the 08-17 overrun be attributed to the arm the
    -- axe hit rather than the arm that spent the hours.
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank the arm only if it neither cancelled nor raised. A
    -- cancelled arm rolled back, so re-running it next firing is exactly right.
    IF v_canceled IS NULL AND NOT v_arm_failed THEN
      v_done_arms := v_done_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();

      -- ── FIX-1117 — store the fingerprint this build CONSUMED ──────────────
      -- v_fp was captured BEFORE the arm ran. Re-reading the source here would
      -- mark any write that landed DURING the run as already consumed and gate
      -- it away forever; storing the pre-run value means such a write is seen
      -- next cycle and the arm runs again. Conservative in the only safe
      -- direction. Merged key-wise rather than jsonb_set()-ed, so a registry row
      -- that somehow lacks the 'arms' object still gets written correctly.
      IF v_fp IS NOT NULL THEN
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_fp_key, jsonb_build_object('arms',
                  jsonb_build_object(v_fn,
                    jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb)
                      || jsonb_build_object('arms',
                           COALESCE(ps.value->'arms', '{}'::jsonb)
                           || jsonb_build_object(v_fn,
                                jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))),
              updated_at = now();
      END IF;
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────────
    v_units_run := v_units_run + 1;
    v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_arm_started));
    BEGIN
      v_rec := public.ec_crawl_record_unit(
                 v_fn, v_fn, v_unit_secs, v_n,
                 CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                      WHEN v_arm_failed          THEN 'failed'
                      ELSE 'ok' END);
      IF (v_rec->>'backoff_set')::boolean THEN
        v_backoff_set := true;
      END IF;
      v_unit_log := v_unit_log || jsonb_build_array(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
    END;
    COMMIT;

    -- ── FIX-1270 — the second consecutive cancel parks the arm ─────────────
    -- A generic arm is ONE statement: a cancel rolls it back whole and banks
    -- nothing, the unit record above trips the 2 h backoff (seconds >= 1500),
    -- and before this the next firing retried the SAME arm into the same wall —
    -- every 2 h, forever, with the cycle never closing (census 2026-10-04
    -- §2.6 item 6; _contracts 2026-08-31, 1,878 s, 0 rows). Read the ring: if
    -- this arm's last two entries — real runs plus its '(parked)' marks, which
    -- break the chain so an unparked arm gets two fresh tries — are both
    -- 'canceled', park it, bank it for the cycle, clear the cancel and carry on
    -- to the next arm instead of EXITing. The first cancel still EXITs exactly
    -- as before. If the record above failed there is no ring entry, no park,
    -- and the old behaviour.
    IF v_canceled IS NOT NULL THEN
      SELECT array_agg(t.outcome ORDER BY t.ord DESC) INTO v_last_two
        FROM (SELECT u.value->>'outcome' AS outcome, u.ord
                FROM public.pipeline_state ps,
                     jsonb_array_elements(COALESCE(ps.value->'recent_units', '[]'::jsonb))
                       WITH ORDINALITY AS u(value, ord)
               WHERE ps.key = 'ec_crawl'
                 AND u.value->>'unit' IN (v_fn, v_fn || ' (parked)')
               ORDER BY u.ord DESC
               LIMIT 2) t;

      IF COALESCE(array_length(v_last_two, 1), 0) = 2
         AND v_last_two[1] = 'canceled' AND v_last_two[2] = 'canceled' THEN
        v_parked_now    := v_fn;
        v_parked_detail := v_canceled;
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_park_key, jsonb_build_object(v_fn, jsonb_build_object(
                  'since',       clock_timestamp(),
                  'cancels',     2,
                  'last_detail', v_canceled,
                  'fp',          v_fp,
                  'log_id',      v_log_id)))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb) || EXCLUDED.value,
              updated_at = now();

        v_done_arms := v_done_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)', 0, 0, 'parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        v_parked_arms := v_parked_arms || v_fn;
        v_canceled    := NULL;
        RAISE WARNING '  [park] % — PARKED after 2 consecutive cancels; the cycle carries on without it: %',
          v_fn, v_parked_detail;
      END IF;
    END IF;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;

    -- FIX-1111 — sensor tripped; crawl mode stops, NULL mode carries on.
    IF v_crawl AND v_backoff_set THEN
      v_unit_capped := true;
      EXIT;
    END IF;
  END LOOP;

  -- ═══ EC STATS ARM — 16 BOUNDED, GATED WINDOWS (FIX-1115) ═══════════════════
  -- LAST in the cycle by construction: it aggregates entity_connections, so it
  -- has to run after every arm that writes edges — including _external and
  -- _investigation, which are themselves pinned last.
  --
  -- Shaped exactly like the donations windows above, and for the same reasons:
  -- one window is one unit, each window COMMITs, an already-banked window is
  -- skipped WITHOUT spending a unit (or a firing that met 15 banked windows
  -- would "run" window 1 in ~0 s and livelock at one useless firing every 15
  -- minutes), and per-window progress is durable so a cancel loses at most one
  -- window.
  --
  -- THE STALENESS THIS CLEARS: entity_connection_stats_mv last rebuilt
  -- successfully 2026-08-05 while the crawl writes edges continuously, so the
  -- first gated pass is a full 16-window backfill of three weeks of drift. At
  -- one unit per */15 firing that is ~4 h of wall clock, paced under the same
  -- sensor and blackout as everything else — which is the entire point of doing
  -- it here rather than in a 6-hour cron job.
  IF c_stats_arm = ANY(v_done_arms) THEN
    RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', c_stats_arm;
  ELSIF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped THEN
    v_arm_started := clock_timestamp();

    -- ── the FIX-1117 gate, over entity_connections itself ───────────────────
    v_fp_t0    := clock_timestamp();
    v_stats_fp := NULL;
    BEGIN
      v_stats_fp := public.ec_arm_source_fingerprint(c_stats_arm);
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', c_stats_arm, SQLERRM);
      v_next_arm := c_stats_arm;
      RAISE WARNING '  [ec-stats] fingerprint probe CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [ec-stats] fingerprint probe FAILED (%) — running the arm', SQLERRM;
      v_stats_fp := NULL;
    END;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    v_fp_prev := NULL;
    IF v_canceled IS NULL AND v_stats_fp IS NOT NULL THEN
      SELECT value->'arms'->c_stats_arm->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_canceled IS NOT NULL THEN
      NULL;   -- fall through to the terminal bookkeeping below

    ELSIF v_stats_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_stats_fp THEN
      -- No edge has been written since the last successful stats build. Bank the
      -- arm and move on without spending a unit. On a day where the gate above
      -- also silenced the ten source arms, this is the whole cycle costing
      -- nothing but probes.
      v_done_arms  := v_done_arms  || c_stats_arm;
      v_gated_arms := v_gated_arms || c_stats_arm;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_stats_key;
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(c_stats_arm, round(v_fp_secs)::int);
      BEGIN
        v_rec := public.ec_crawl_record_unit(c_stats_arm, c_stats_arm || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;
      RAISE NOTICE '  [chunk] % — SKIPPED (entity_connections unchanged since last build: %)',
        c_stats_arm, v_stats_fp;

    ELSE
      -- ── resume this cycle's per-window progress ──────────────────────────
      SELECT value INTO v_stats_prog FROM public.pipeline_state WHERE key = c_stats_key;
      IF v_stats_prog IS NOT NULL
         AND (v_stats_prog->>'cycle_started_at')::timestamptz = v_cycle_started
      THEN
        SELECT COALESCE(array_agg(x::int), ARRAY[]::int[])
          INTO v_stats_done
          FROM jsonb_array_elements_text(COALESCE(v_stats_prog->'done', '[]'::jsonb)) x;
        -- Keep the fingerprint the FIRST firing of this arm captured. A pass
        -- that spans four hours of firings must record what it actually
        -- consumed, not a value re-read at the end with edges written between.
        v_stats_fp := COALESCE(v_stats_prog->>'fp', v_stats_fp);
        IF COALESCE(array_length(v_stats_done, 1), 0) > 0 THEN
          RAISE NOTICE '  [ec-stats] resuming — %/16 window(s) already banked this cycle',
            array_length(v_stats_done, 1);
        END IF;
      ELSE
        v_stats_done := ARRAY[]::int[];
      END IF;

      FOR i IN 1..16 LOOP
        -- Banked window: skip BEFORE the cap, never spending a unit on a no-op.
        IF (i - 1) = ANY(v_stats_done) THEN
          RAISE NOTICE '    [ec-stats] window %/16 — SKIPPED (already banked this cycle)', i;
          CONTINUE;
        END IF;

        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, i);
          RAISE NOTICE '  [ec-stats] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          v_next_arm   := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        v_unit_t0    := clock_timestamp();
        v_n          := 0;   -- so a cancelled window records 0 rows, not NULL
        v_arm_failed := false;
        BEGIN
          v_stats_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
          v_n         := (v_stats_res->>'upserted')::bigint + (v_stats_res->>'deleted')::bigint;
          v_stats_ups := v_stats_ups + (v_stats_res->>'upserted')::bigint;
          v_stats_del := v_stats_del + (v_stats_res->>'deleted')::bigint;

          -- The window's rows and the window's progress become durable in the
          -- SAME transaction. FIX-1112's rule in its strongest form: there is no
          -- ratchet to lose, because the progress marker IS part of the chunk.
          INSERT INTO public.pipeline_state (key, value)
          VALUES (c_stats_key, jsonb_build_object(
                    'cycle_started_at', v_cycle_started,
                    'done',             to_jsonb(v_stats_done || (i - 1)),
                    'fp',               v_stats_fp))
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now();

          RAISE NOTICE '    [ec-stats] window %/16 [%..%) — % upserted, % deleted, % groups',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'),
            v_stats_res->>'upserted', v_stats_res->>'deleted', v_stats_res->>'groups';
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('%s window %s/16: %s', c_stats_arm, i, SQLERRM);
          v_next_arm := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_arm_failed := true;
          v_failures := v_failures || format('%s window %s: %s', c_stats_arm, i, SQLERRM);
          RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;

        -- Claim the window only once its transaction actually committed.
        -- PL/pgSQL variables are NOT rolled back by a subtransaction abort, so
        -- appending inside the block above would let a failed INSERT leave this
        -- array claiming a window that never banked.
        IF v_canceled IS NULL AND NOT v_arm_failed THEN
          v_stats_done := v_stats_done || (i - 1);
        END IF;

        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     'entity_connection_stats_window',
                     format('%s window %s/16', c_stats_arm, i),
                     v_unit_secs, v_n,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                          WHEN v_arm_failed          THEN 'failed'
                          ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        EXIT WHEN v_canceled IS NOT NULL;

        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_stats_ups + v_stats_del;
      v_arm_timings := v_arm_timings || jsonb_build_object(
        c_stats_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

      -- Bank the ARM only on a clean, complete pass over all sixteen windows —
      -- the same "AND NOT v_unit_capped" discipline the donations arm needs, and
      -- for the same reason: a cap exit is an INCOMPLETE pass, and banking it
      -- would make the next firing skip the whole arm with windows unbuilt.
      IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
         AND COALESCE(array_length(v_failures, 1), 0) = 0
         AND COALESCE(array_length(v_stats_done, 1), 0) = 16
      THEN
        v_done_arms := v_done_arms || c_stats_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();

        IF v_stats_fp IS NOT NULL THEN
          INSERT INTO public.pipeline_state AS ps (key, value)
          VALUES (c_fp_key, jsonb_build_object('arms',
                    jsonb_build_object(c_stats_arm,
                      jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))))
          ON CONFLICT (key) DO UPDATE
            SET value = COALESCE(ps.value, '{}'::jsonb)
                        || jsonb_build_object('arms',
                             COALESCE(ps.value->'arms', '{}'::jsonb)
                             || jsonb_build_object(c_stats_arm,
                                  jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))),
                updated_at = now();
        END IF;

        DELETE FROM public.pipeline_state WHERE key = c_stats_key;
        COMMIT;
      END IF;

      RAISE NOTICE '  [chunk] % — % (% upserted, % deleted)', c_stats_arm,
        CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
             WHEN v_unit_capped THEN 'UNIT CAP'
             WHEN v_canceled IS NOT NULL THEN 'CANCELED'
             ELSE 'complete' END,
        v_stats_ups, v_stats_del;
    END IF;
  END IF;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;

  -- ── FIX-1056 — cycle bookkeeping ───────────────────────────────────────────
  -- FIX-1069 — the donations WINDOW arm is in v_fns in neither mode, so it has
  -- to be named explicitly here. Without this, a run whose donations windows
  -- never banked could compute v_next_arm = NULL and sit one gate away from
  -- reporting 'complete'. Only computed when nothing already claimed it — a
  -- budget exit sets it with the window index attached.
  IF v_next_arm IS NULL THEN
    IF NOT (v_don_arm = ANY(v_done_arms)) THEN
      v_next_arm := v_don_arm;
    ELSE
      -- WITH ORDINALITY because unnest() ordering is not contractually
      -- guaranteed and "first outstanding arm" has to mean first in ARM ORDER,
      -- not first returned.
      SELECT f INTO v_next_arm
        FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
       WHERE NOT (u.f = ANY(v_done_arms))
       ORDER BY u.ord
       LIMIT 1;
    END IF;
    -- FIX-1115 — the stats arm is not a member of v_fns either, and it is LAST,
    -- so it is only the outstanding arm once every other one has banked.
    IF v_next_arm IS NULL AND NOT (c_stats_arm = ANY(v_done_arms)) THEN
      v_next_arm := c_stats_arm;
    END IF;
  END IF;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: the donations windows can fail
    -- without being banked while every v_fns arm succeeds, which would
    -- otherwise clear the cursor on a run that still owes work. Leaving the
    -- cursor is safe either way — each arm is an idempotent DELETE-then-INSERT
    -- over its own connection_type — but clearing it on a failed pass would
    -- throw away the record of what still needs redoing.
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    -- FIX-1115 — belt-and-braces: the stats arm clears this itself when it
    -- banks, but a cycle can close having GATED the arm on a firing where the
    -- key was already gone, and a stale key carrying a dead cycle_started_at
    -- would otherwise sit here until the next stats pass ignored it.
    DELETE FROM public.pipeline_state WHERE key = c_stats_key;
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── FIX-1101 — the belt-and-braces clear (playbook C3) ────────────────────
  -- Unconditional, and NOT gated on this run having published anything: this is
  -- the "put it where it can FIRE" backstop, and it must be able to clean up
  -- state this run did not create. Reached on every software exit from the
  -- procedure — convergence, budget exit, a caught cancel, per-arm failures.
  -- Only a hard terminate or a crash skips it, and that case is the watchdog's.
  DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
  COMMIT;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        -- FIX-1270 — so is the firing that PARKS an arm: its
                        -- edges are stale until the park clears. Only that
                        -- firing; a later one that skips the parked arm is
                        -- judged on its own outcome and lists it in parked_arms.
                        WHEN v_parked_now IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        -- FIX-1111 — so is a unit-cap exit, and it is the crawl's
                        -- NORMAL outcome rather than an incident. It must still be
                        -- 'partial' (work remains), but `unit_capped` in metadata
                        -- is what distinguishes ~96 routine crawl exits a day from
                        -- the budget exhaustions FIX-969 counts.
                        WHEN v_unit_capped THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        -- FIX-1056 — arms left unrun without a cancel or a budget
                        -- exit can only mean a failure skipped them; never claim
                        -- 'complete' while v_next_arm is non-NULL.
                        WHEN v_next_arm IS NOT NULL THEN 'partial'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      -- FIX-1270 — a park leads the message; whatever else ended the run
      -- follows it (concat_ws skips the NULL side).
      error_message = left(concat_ws('; ',
                        CASE WHEN v_parked_now IS NOT NULL
                             THEN format('arm parked after 2 consecutive cancels: %s (%s)',
                                         v_parked_now, v_parked_detail) END,
                      CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +2 on the arm count: the donations window arm and
                          -- (FIX-1115) the stats window arm are both bankable
                          -- but neither is a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 2), 1000)
                        -- FIX-1111 — an ORDERLY, expected stop. Worded so it can
                        -- never be mistaken for a budget blowout in a grep.
                        WHEN v_unit_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s; resumable at arm %s',
                                 v_units_run,
                                 CASE WHEN v_backoff_set THEN ' then BACKOFF tripped' ELSE '' END,
                                 COALESCE(v_next_arm, '?')), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END), 1000),
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- FIX-1056
                        'budget_exhausted', v_budget_out,
                        'arm_timings', v_arm_timings,
                        'arms_banked', to_jsonb(v_done_arms),
                        'next_arm', v_next_arm,
                        'cycle_started_at', v_cycle_started,
                        -- FIX-1069 — the donations cycle target this run drove
                        -- its windows toward, so a partial run's remaining work
                        -- is readable from the log row alone.
                        'donations_target_at', v_incr_target,
                        'donations_bootstrap', v_bootstrap,
                        -- FIX-1111
                        'crawl', v_crawl,
                        'max_units', p_max_units,
                        'units_run', v_units_run,
                        'unit_capped', v_unit_capped,
                        'backoff_tripped', v_backoff_set,
                        'units', v_unit_log,
                        -- FIX-1115
                        'stats_upserted', v_stats_ups,
                        'stats_deleted', v_stats_del,
                        -- FIX-1117 — which arms this firing skipped as unchanged.
                        -- Distinguishable from an idle arm, which simply never
                        -- appears, and from a banked one, which is in arms_banked
                        -- without being here.
                        'gated_arms', to_jsonb(v_gated_arms),
                        'gated_count', COALESCE(array_length(v_gated_arms, 1), 0),
                        -- FIX-1270 — parked_arms: parked by this firing or
                        -- skipped by it as parked; parked_now: the one this
                        -- firing parked; unparked_arms: cleared because their
                        -- source moved. Absent from the log = nothing parked.
                        'parked_arms', to_jsonb(v_parked_arms),
                        'parked_now', v_parked_now,
                        'parked_detail', v_parked_detail,
                        'unparked_arms', to_jsonb(v_unparked_arms)
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, % unit(s), next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN v_unit_capped THEN 'UNIT CAP'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), v_units_run, COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.run_entity_connections_rebuild(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- donor_rollup_rebuild_bulk — copied from 20261004190000_fix1145_homepage_stats_mv_reads_rollups.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  -- FIX-973 - the SCHEDULED budget, sized the FIX-1002 way. Was 4h30m, which
  -- was right for a hand-driven break-glass run and wrong for jobid 24: two
  -- firings 3 h apart mean a 4h30m run is still inside itself when the second
  -- starts, and pg_cron QUEUES rather than skips. 2 h is the same bound the
  -- per-recipient path carried; the measured full sweep is 926 s.
  -- Overridable via civitics.donor_rollup_bulk_budget_seconds (break-glass).
  c_budget     interval := interval '2 hours';
  c_max_sweep  interval := interval '48 hours';

  -- FIX-973 - the log pipeline. The registry, the canary and
  -- check_rollup_freshness all judge `donor_rollup_refresh`; routing jobid 24
  -- here must not move the freshness clock to a new name, so the REGIME is
  -- metadata and the PIPELINE stays put. 'donor_rollup_bulk' survives as
  -- metadata.regime so the two histories stay separable after the fact.
  c_pipeline   text   := 'donor_rollup_refresh';

  -- FIX-973 - carried over from refresh_official_donor_rollup_incremental().
  -- The 12:00 backstop exists for a starved 09:00 launch; it must not open a
  -- second window into active hours. Same two GUCs as the incremental so the
  -- refusal stays testable without a wall clock.
  c_latest_hour int := 13;

  -- FIX-973 - cold seed for the predictive budget guard, so it is ARMED BEFORE
  -- CHUNK 0 rather than only after one chunk has completed. Without a seed
  -- `v_max_chunk > 0` is false on the first iteration and the guard cannot
  -- refuse a first chunk - which is exactly the window a slow pre-loop staging
  -- build opens. 600 s is ~10x the worst chunk ever measured (59 s, the 08-07
  -- full sweep). Overridable via civitics.donor_rollup_bulk_chunk_seed_seconds,
  -- which is also how the refusal is exercised in test.
  c_seed_chunk double precision := 600.0;

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_ignore_win boolean;
  v_hour_cfg   int;
  v_seed_cfg   double precision;
  v_seed_ref   double precision;
  v_guard_ref  double precision;
  v_prev_slow  int := 0;
  v_resume_at  int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- This is the manual break-glass bulk path, so the axe here is normally an
  -- operator cancel or the 6h role default rather than a cron budget — the
  -- stranding is identical either way.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  -- FIX-1194 P1-A — the start gate's answer, each chunk boundary's reading,
  -- and the reading that stopped the loop (NULL = the box did not stop it).
  v_gate       jsonb;
  v_sat        jsonb;
  v_backoff    jsonb := NULL;
  k            int;
BEGIN
  -- Start-window refusal (FIX-1002, carried to the bulk regime by FIX-973).
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget.
  v_ignore_win := COALESCE(
    NULLIF(current_setting('civitics.donor_rollup_ignore_start_window', true), '')::boolean,
    false);
  v_hour_cfg := NULLIF(current_setting('civitics.donor_rollup_latest_start_hour', true), '')::int;
  IF v_hour_cfg IS NOT NULL THEN
    c_latest_hour := GREATEST(0, LEAST(v_hour_cfg, 24));
  END IF;
  IF NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup bulk] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  -- FIX-1194 P1-A — the START gate: wait up to 600 s for a box that is neither
  -- stale nor failing forks (D2 — the watchdog wall is not an input). After the
  -- start-window refusal, so a queued firing past the cutoff still exits at
  -- once; BEFORE the lock, so a waiting firing holds nothing. A wait that
  -- crosses the cutoff hands the decision back to the start-window refusal.
  v_gate := public.box_backoff_gate('donor-rollup-refresh', 600);
  IF (v_gate->>'waited_s')::int > 0 AND NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[donor-rollup bulk] start window closed during the box gate''s wait (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;
  IF NOT (v_gate->>'clear')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format('box saturated after %s s: %s', v_gate->>'waited_s', v_gate->>'reason'),
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[donor-rollup bulk] box saturated (%) after % s — skipping (FIX-1194)',
      v_gate->>'reason', v_gate->>'waited_s';
    RETURN;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('regime', 'bulk', 'source', 'pg_cron', 'skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup bulk] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunks', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    IF v_cfg NOT IN (16, 32, 64, 128, 256) THEN
      PERFORM pg_advisory_unlock(c_lock_key);
      RAISE EXCEPTION 'civitics.donor_rollup_bulk_chunks must be one of 16/32/64/128/256 (got %)', v_cfg;
    END IF;
    c_chunks := v_cfg;
  END IF;
  v_step := 256 / c_chunks;

  v_cfg_txt := NULLIF(current_setting('civitics.donor_rollup_bulk_mode', true), '');
  v_mode := COALESCE(v_cfg_txt, 'dirty');
  IF v_mode NOT IN ('dirty', 'full') THEN
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE EXCEPTION 'civitics.donor_rollup_bulk_mode must be ''dirty'' or ''full'' (got %)', v_mode;
  END IF;

  v_seed_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunk_seed_seconds', true), '')::double precision;
  IF COALESCE(v_seed_cfg, 0) > 0 THEN
    c_seed_chunk := v_seed_cfg;
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);

  -- FIX-973 — arm the guard from chunk 0. `v_max_chunk` stays a pure
  -- MEASUREMENT (it is what gets logged and persisted); the guard consults
  -- v_seed_ref instead, until this run has actually completed a chunk.
  --
  -- The 0.75 cap is what keeps the seed from becoming a wedge: 1.25 x 0.75 is
  -- under 1, so a run that arrives at the loop having spent none of its budget
  -- CANNOT be refused by the seed alone, however bad the previous sweep's worst
  -- chunk was. What the seed CAN refuse is a run that reaches the loop having
  -- already burned the budget in the pre-loop staging build — the FIX-1018
  -- shape, and the only case a chunk-0 guard exists for.
  v_prev_slow := COALESCE((v_state->>'slowest_chunk_seconds')::int, 0);
  v_seed_ref  := LEAST(
    GREATEST(v_prev_slow::double precision, c_seed_chunk),
    EXTRACT(epoch FROM c_budget) * 0.75);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;
  v_sweep_tgt := (v_state->>'sweep_target')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF (v_state->>'mode') IS DISTINCT FROM v_mode THEN
      v_restarted := format('mode changed %s -> %s', v_state->>'mode', v_mode);
    ELSIF COALESCE((v_state->>'chunks')::int, -1) <> c_chunks THEN
      v_restarted := format('chunk count changed %s -> %s', v_state->>'chunks', c_chunks);
    ELSIF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_targets LIMIT 1) THEN
      v_restarted := 'target staging empty (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_fe LIMIT 1) THEN
      v_restarted := 'donor-dimension staging empty (crash recovery truncates UNLOGGED tables)';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[donor-rollup bulk] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    -- FIX-983 — the head-lag horizon, then the never-go-backwards floor.
    v_horizon   := public.fr_watermark_horizon();
    v_sweep_tgt := LEAST(COALESCE(v_sweep_tgt, v_horizon), v_horizon);

    -- Caught-up refusal (FIX-973; invariant (c) as an EXIT rather than a
    -- no-op sweep). The GREATEST clamp below still guarantees the watermark
    -- can never move backwards, but on the SCHEDULED path a caught-up firing
    -- must not pay for the staging build to discover it has nothing to do:
    -- `_drb_fe` is a full pass over financial_entities (5.2M rows / 1.9 GB
    -- heap on prod today) joined to entity_tags, and jobid 24 fires twice a
    -- day. The per-recipient path exits a caught-up run in ~0.1 s; this makes
    -- the bulk path do the same.
    -- Logged 'complete', not 'skipped' — FIX-1140: freshness counts ONLY
    -- status='complete', so a caught-up run that logs 'skipped' freezes the
    -- clock and the canary pages on a pipeline that is working perfectly.
    IF v_watermark IS NOT NULL AND v_sweep_tgt <= v_watermark THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES (c_pipeline, 'complete', v_started, clock_timestamp(),
              jsonb_build_object(
                'regime', 'bulk', 'mode', v_mode, 'chunks', c_chunks,
                'source', 'pg_cron', 'resumed', false,
                'targets', 0, 'target_officials', 0, 'recipients_done', 0,
                'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                'skip_reason', format('caught up at the FIX-983 horizon — %s is at or before the watermark %s',
                                      v_sweep_tgt, v_watermark),
                'horizon', v_sweep_tgt, 'watermark', v_watermark));
      RAISE NOTICE '[donor-rollup bulk] caught up at the horizon (% <= %) — nothing to do', v_sweep_tgt, v_watermark;
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;

    v_sweep_tgt := GREATEST(v_sweep_tgt, v_watermark);

    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all. Placed after the
    -- caught-up exit above, because a run that writes nothing needs no guard
    -- and the assert anti-joins all six arms.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    ELSE
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
          AND fr.updated_at >  v_watermark
          AND fr.updated_at <= v_sweep_tgt                             -- FIX-983
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      -- FIX-918: the donor's primary industry, from its one home.
      SELECT pit.entity_id, pit.tag, pit.display_label
      FROM public.primary_industry_tag(NULL) pit
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (c_pipeline, 'running', v_started,
          jsonb_build_object(
            'regime', 'bulk', 'source', 'pg_cron',
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget))
          -- FIX-1194 P1-A — only when the start gate actually waited.
          || CASE WHEN (v_gate->>'waited_s')::int > 0
                  THEN jsonb_build_object('gate', v_gate) ELSE '{}'::jsonb END)
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    -- Before any chunk has completed THIS run, size on the seed; after that, on
    -- what this run has actually measured.
    v_guard_ref := CASE WHEN v_done > 0 THEN v_max_chunk ELSE v_seed_ref END;
    IF v_guard_ref > 0
       AND v_elapsed + (v_guard_ref * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, reference %s, sized from %)',
        k, round(v_elapsed)::int, round(v_guard_ref)::int,
        CASE WHEN v_done > 0 THEN 'this run' ELSE 'seed' END;
      EXIT;
    END IF;

    -- FIX-1194 P1-A — back off at the chunk boundary on a stale probe or
    -- failing forks (D2). The cursor is committed with every chunk, so the
    -- next firing resumes at exactly this k.
    v_sat := public.box_is_saturated(p_include_watchdog_wall := false);
    IF (v_sat->>'saturated')::boolean THEN
      v_backoff := v_sat;
      RAISE NOTICE '[donor-rollup bulk] box saturated (%) — backing off before chunk %', v_sat->>'reason', k;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      TRUNCATE public._drb_donor;
      INSERT INTO public._drb_donor
        (to_id, relationship_type, from_id, total_cents, total_cents0, tx_count,
         small_cents, small_count, pos_cents, pos_count)
      SELECT
        fr.to_id,
        fr.relationship_type::text,
        fr.from_id,
        SUM(fr.amount_cents)::bigint,
        SUM(COALESCE(fr.amount_cents, 0))::bigint,
        COUNT(*)::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0))::bigint
      FROM public.financial_relationships fr
      JOIN public._drb_targets t ON t.to_id = fr.to_id
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_id >= v_lo
        AND (v_hi IS NULL OR fr.to_id < v_hi)
      GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      DELETE FROM public.official_donor_rollup_mv m
       WHERE m.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH ranked AS (
        SELECT d.to_id AS official_id, d.relationship_type, d.from_id AS donor_id,
               d.total_cents, d.tx_count,
               ROW_NUMBER() OVER (PARTITION BY d.to_id, d.relationship_type
                                  ORDER BY d.total_cents DESC, d.from_id) AS rn
        FROM public._drb_donor d
      ),
      top_rows AS (
        SELECT r.official_id, r.relationship_type, r.rn::int AS rank, r.donor_id,
               fe.display_name, fe.entity_type, fe.industry_tag, fe.industry_label,
               r.total_cents, r.tx_count, NULL::bigint AS tail_donor_count
        FROM ranked r
        LEFT JOIN public._drb_chunk_fe fe ON fe.id = r.donor_id
        WHERE r.rn <= 200
      ),
      tail_rows AS (
        SELECT r.official_id, r.relationship_type, 201 AS rank, NULL::uuid, NULL::text,
               NULL::text, NULL::text, NULL::text,
               SUM(r.total_cents)::bigint, SUM(r.tx_count)::bigint, COUNT(*)::bigint
        FROM ranked r WHERE r.rn > 200
        GROUP BY r.official_id, r.relationship_type
      ),
      ins AS (
        INSERT INTO public.official_donor_rollup_mv (
          official_id, relationship_type, rank, donor_id, donor_name, entity_type,
          industry_tag, industry_label, total_cents, tx_count, tail_donor_count)
        SELECT * FROM top_rows UNION ALL SELECT * FROM tail_rows
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_n FROM ins;
      v_rows := v_rows + v_n;

      DELETE FROM public.official_donor_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_donor_totals
        (official_id, total_cents, pac_cents, individual_cents, donor_count, updated_at)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint,
             -- FIX-981: was the column DEFAULT now(), i.e. the START of this
             -- chunk's transaction, N COMMITs into the sweep.
             clock_timestamp()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_small_dollar_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_small_dollar_rollup
        (official_id, small_dollar_cents, small_dollar_count, updated_at)
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,
             clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      DELETE FROM public.treemap_individuals_rollup x
       WHERE x.scope_id <> c_global
         AND x.scope_id IN (
           SELECT t.to_id FROM public._drb_targets t
            WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH per_name AS (
        SELECT d.to_id AS scope_id,
               COALESCE(fe.state, '??') AS state,
               fe.display_name          AS donor_name,
               SUM(d.pos_cents)::bigint AS total_cents,
               SUM(d.pos_count)::bigint AS donation_count
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
        GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY scope_id, state
                                     ORDER BY total_cents DESC, donor_name) AS rank
        FROM per_name
      )
      INSERT INTO public.treemap_individuals_rollup
        (scope_id, state, rank, donor_name, total_cents, donation_count)
      SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
      FROM ranked WHERE rank <= 50;

      DELETE FROM public.official_donor_bracket_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH bucketed AS (
        SELECT d.to_id AS official_id, d.pos_cents AS donor_cents,
               CASE WHEN d.pos_cents >= 1000000 THEN 'mega'
                    WHEN d.pos_cents >=  250000 THEN 'major'
                    WHEN d.pos_cents >=   50000 THEN 'mid'
                    ELSE                              'small' END AS tier
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
      )
      INSERT INTO public.official_donor_bracket_totals (official_id, tier, total_cents, donor_count)
      SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
      FROM bucketed GROUP BY official_id, tier;

      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object(
                       'chunk_cursor', k,
                       'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. The cursor is written INSIDE this chunk's
    -- transaction, so a cancelled chunk rolls back together with its cursor
    -- advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  -- FIX-1028 — cancelled is PARTIAL and RESUMABLE. The bulk path's watermark
  -- write is at the very end and stays there (this is the manual, re-runnable
  -- path — a re-CALL resumes from the committed cursor), but the ROW now closes
  -- itself instead of sitting 'running' until the reaper.
  -- FIX-973 — check_rollup_freshness now derives sweep_in_progress/sweep_cursor
  -- from THIS pipeline's own last row (it used to hard-wire a read of
  -- pipeline_state.donor_rollup_watermark, which the bulk regime never writes
  -- a cursor into). `resumable` + `resume_at_chunk` are that contract.
  SELECT COALESCE((value->>'chunk_cursor')::int + 1, 0) INTO v_resume_at
  FROM public.pipeline_state WHERE key = c_state_key;
  v_resume_at := COALESCE(v_resume_at, 0);

  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'canceled', true, 'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[donor-rollup bulk] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- FIX-1194 P1-A — backed off on a saturated box: partial and resumable, in
  -- the budget close's shape, plus what the box read when it stopped the loop.
  IF v_backoff IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('box saturated (%s) — resumable at chunk %s of %s',
             v_backoff->>'reason', v_resume_at, c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'backoff_reason', v_backoff->>'reason',
             'backoff_readings', v_backoff->'readings',
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — box saturated (%); resumable at chunk %', v_backoff->>'reason', v_resume_at;
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text,   -- FIX-981
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets,
                                    -- FIX-973: seeds the NEXT run's chunk-0 guard.
                                    'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'recipients_done', v_n_offic,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  -- >>> FIX-1145 — refresh the home-page MV now that official_donor_totals
  -- moved. Reached only here, after the success tail's COMMIT: the caught-up
  -- exit and the canceled / failed / backoff / budget closes all RETURN before
  -- the watermark write. Advisory, in the CALL's trailing transaction: a failure
  -- (a cancel included, which WHEN OTHERS alone does not catch) is a WARNING
  -- plus homepage_mv_refreshed=false on this run's log row, never a failed run.
  -- lock_timeout bounds a wait on a concurrent refresh of the same MV.
  BEGIN
    SET LOCAL lock_timeout = '60s';
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv;
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('homepage_mv_refreshed', true)
     WHERE id = v_log_id;
    RAISE NOTICE '[donor-rollup bulk] refreshed official_homepage_stats_mv (FIX-1145)';
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    RAISE WARNING '[donor-rollup bulk] official_homepage_stats_mv refresh FAILED (advisory, FIX-1145): %', SQLERRM;
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('homepage_mv_refreshed', false,
                                                     'homepage_mv_refresh_error', left(SQLERRM, 300))
     WHERE id = v_log_id;
  END;
  -- <<< FIX-1145
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;

-- ---------------------------------------------------------------------------
-- rebuild_entity_search_index — copied from 20261004100000_fix1269_1132_1270_search_index_stamp_stats_read_arm_park.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_count integer;
  -- FIX-985(b). The spend-precedence vocabulary, declared ONCE so the
  -- predicate below and the domain assertion cannot drift apart. Was
  -- ('corporation','organization') at both sites; 'organization' has never
  -- been in the financial_entities.entity_type CHECK domain, so every
  -- non-corporation spender fell through to total_donated_cents and
  -- rendered amount_cents = 0. Prod 2026-09-02: 35 'other' + 2 'nonprofit'
  -- entities, 1,317,782,700 cents ($13,177,827.00) of contract+grant, all
  -- showing $0.
  c_spend_types text[] := ARRAY['corporation', 'other', 'nonprofit'];
  v_domain text[];
  v_lit    text;
  -- FIX-687's canonical 16. uuid v4 keys distribute evenly across them.
  c_bounds uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  i    int;
  v_lo uuid;
  v_hi uuid;
  -- FIX-1132 — where _conn came from this run, and why (cc-188).
  v_currency    jsonb;
  v_conn_source text;
  v_conn_t0     timestamptz;
  v_conn_secs   numeric;
BEGIN
  -- FIX-985(b) guard: every literal in c_spend_types must be a real member of
  -- the financial_entities.entity_type CHECK domain. The next vocabulary
  -- drift fails loudly here instead of silently zeroing an amount column.
  SELECT array_agg(m[1]) INTO v_domain
  FROM pg_constraint con
  CROSS JOIN LATERAL regexp_matches(
         pg_get_constraintdef(con.oid), '''([a-z0-9_]+)''::text', 'g') AS m
  WHERE con.conrelid = 'public.financial_entities'::regclass
    AND con.contype  = 'c'
    AND con.conname  = 'financial_entities_entity_type_check';

  IF v_domain IS NULL THEN
    -- Constraint renamed or dropped: cannot assert. Say so, do not block the
    -- nightly rebuild on a missing guard.
    RAISE WARNING 'FIX-985: financial_entities_entity_type_check not readable - '
                  'entity_type vocabulary left unasserted.';
  ELSE
    FOREACH v_lit IN ARRAY c_spend_types LOOP
      IF NOT (v_lit = ANY (v_domain)) THEN
        RAISE EXCEPTION
          'FIX-985: entity_type ''%'' in the search-index spend vocabulary is not in '
          'the financial_entities.entity_type CHECK domain (%). Fix the vocabulary '
          'or the constraint before rebuilding the search index.',
          v_lit, array_to_string(v_domain, ', ');
      END IF;
    END LOOP;
  END IF;

  -- Per-statement memory for the GIN builds on the INSERTs below. The _conn
  -- stage no longer runs under this: entity_search_conn_window() carries its own
  -- 64MB proconfig, which is what actually bounds the aggregate (FIX-1123).
  SET LOCAL work_mem = '64MB';
  SET LOCAL max_parallel_workers_per_gather = 0;

  -- ── Shared derivations (built once) ──
  --
  -- FIX-1123 — sixteen bounded windows instead of one whole-table
  -- HashAggregate over a UNION ALL of both id columns. Each window is its own
  -- statement, so the memory ceiling is per-window and a future cardinality
  -- spills one window's worth rather than the box. entity_connections is
  -- 10,503,011 rows / 7,473 MB on prod as of 2026-08-31 — the ~2.4M in FIX-748's
  -- header was true when it shipped 2026-07-06 and has been 4.4x wrong since.
  CREATE TEMP TABLE _conn (entity_id uuid, c int) ON COMMIT DROP;
  -- FIX-1132 (cc-188) — read the stats table when it is provably current.
  -- entity_connection_stats_mv.connection_count is the same count over the
  -- same UNION ALL of both id columns in the same 16 windows, so when
  -- entity_connections has not changed since the stats arm last banked, the
  -- table IS _conn (367,713 / 367,713 equal on prod, 2026-10-03 and -04).
  -- ec_stats_table_currency() is that test: the arm's stored fingerprint equals
  -- a live probe, no stats pass is mid-flight, and the table is non-empty. It
  -- costs one fingerprint probe (prod p50 6.5 s) against the windows' 4.67M
  -- buffers on the clone. Anything else — EC written since, a pass in flight, a
  -- disabled or failed probe — takes today's 16 windows, unchanged. A stale
  -- table is never read.
  v_conn_t0  := clock_timestamp();
  v_currency := public.ec_stats_table_currency();
  IF COALESCE((v_currency->>'current')::boolean, false) THEN
    v_conn_source := 'stats_table';
    INSERT INTO _conn (entity_id, c)
    SELECT s.entity_id, s.connection_count::int
      FROM public.entity_connection_stats_mv s;
  ELSE
    v_conn_source := 'windows';
    FOR i IN 1 .. 16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      INSERT INTO _conn (entity_id, c)
      SELECT w.entity_id, w.c
        FROM public.entity_search_conn_window(v_lo, v_hi) w;
    END LOOP;
  END IF;
  v_conn_secs := EXTRACT(epoch FROM (clock_timestamp() - v_conn_t0));
  CREATE UNIQUE INDEX ON _conn (entity_id);
  -- The old build was a CTAS, which leaves no statistics behind either; the
  -- INSERT path is the same. ANALYZE so the eight INSERTs below join against a
  -- real row count rather than a default guess.
  ANALYZE _conn;

  CREATE TEMP TABLE _off_committees ON COMMIT DROP AS
    SELECT official_id, array_agg(DISTINCT committee_id) AS committee_ids
    FROM public.official_committee_memberships
    WHERE ended_at IS NULL
    GROUP BY official_id;
  CREATE UNIQUE INDEX ON _off_committees (official_id);

  -- one primary industry slug per financial entity (FIX-918: the ranked pick,
  -- from its one home)
  CREATE TEMP TABLE _fe_industry ON COMMIT DROP AS
    SELECT pit.entity_id, pit.tag
    FROM public.primary_industry_tag(NULL) pit;
  CREATE UNIQUE INDEX ON _fe_industry (entity_id);

  TRUNCATE public.entity_search_index;

  -- ── official ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, photo_url, search_tsv, is_synthetic,
    jurisdiction_level, state, party, chamber, status, committee_ids,
    amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'official', o.id, o.full_name, o.role_title, o.photo_url,
    to_tsvector('english', coalesce(o.full_name,'') || ' ' || coalesce(o.role_title,'')),
    coalesce(o.is_synthetic, false),
    CASE lower(coalesce(j.type::text, oj.type::text))
      WHEN 'country' THEN 'federal'
      WHEN 'state'   THEN 'state'
      WHEN 'county'  THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL
    END,
    o.metadata->>'state',
    o.party::text,
    CASE WHEN o.role_title = 'Senator' THEN 'senate'
         WHEN o.role_title ILIKE 'Representative%' THEN 'house' ELSE NULL END,
    'active',
    oc.committee_ids,
    -- FIX-942: the authoritative per-official donation total is
    -- official_donor_totals.total_cents, NOT officials.total_received_cents.
    -- Both sum the same quantity (FR rows, to_type='official',
    -- relationship_type='donation'), but the column lost its writer when the
    -- nightly moved to the FIX-836 bulk regime and has been frozen since.
    -- Prod 2026-09-05: 4,131 officials disagreed, $2,745,805,506 of |gap|.
    -- Missing rollup row = 0, which is what an official with no donations has.
    COALESCE(odt.total_cents, 0),
    CASE WHEN odt.total_cents IS NOT NULL THEN 'received' ELSE NULL END,
    coalesce(cn.c, 0),
    o.updated_at,
    CASE WHEN o.source_ids ? 'congress_gov' OR o.source_ids ? 'bioguide_id' THEN 'congress.gov'
         WHEN o.source_ids ? 'openstates' THEN 'openstates' ELSE NULL END,
    now()
  FROM public.officials o
  LEFT JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
  LEFT JOIN public.jurisdictions j     ON j.id = gb.jurisdiction_id
  LEFT JOIN public.jurisdictions oj    ON oj.id = o.jurisdiction_id
  LEFT JOIN _conn cn                    ON cn.entity_id = o.id
  LEFT JOIN _off_committees oc          ON oc.official_id = o.id
  LEFT JOIN public.official_donor_totals odt ON odt.official_id = o.id
  WHERE o.is_active
    -- FIX-939 - merge stubs never surface. A FIX-933 merge neutralises a
    -- same-person duplicate: the money moves to the elected survivor and the
    -- candidate row keeps its retired FEC id purely as provenance. What is
    -- left is a $0 official that duplicates a real person, and all 86 of them
    -- on prod (2026-09-05) were being offered by search, typeahead and the
    -- browse facets as people you could look up. All three read this table, so
    -- this predicate is what covers them; the TS mirror for the readers that
    -- hit `officials` directly is isMergeStubSourceIds() in @civitics/db.
    --
    -- PRESENCE of any marker key, not equality with a particular id:
    --   merged_fec_candidate_id   legacy scalar (86 prod rows today)
    --   merged_fec_candidate_ids  the FIX-956 array writers now emit
    --   merged_into               the survivor pointer, written by a later
    --                             data pass - accepted here already so
    --                             nothing changes when it lands.
    AND NOT (o.source_ids ?| ARRAY[
      'merged_fec_candidate_id', 'merged_fec_candidate_ids', 'merged_into']);

  -- ── proposal (non-initiative) ───────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, proposal_type, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'proposal', p.id, p.title, p.type::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.type::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, p.type::text,
    NULL, NULL, coalesce(cn.c, 0),
    p.introduced_at::timestamptz,
    CASE WHEN p.type::text = 'regulation' THEN 'regulations.gov' ELSE 'congress.gov' END,
    now()
  FROM public.proposals p
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type <> 'initiative';

  -- ── initiative ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, initiative_stage, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'initiative', p.id, p.title, id2.stage::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(id2.stage::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, id2.stage::text,
    coalesce(cn.c, 0), p.created_at, 'civitics', now()
  FROM public.proposals p
  LEFT JOIN public.initiative_details id2 ON id2.proposal_id = p.id
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type = 'initiative';

  -- ── agency ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    agency_type, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'agency', a.id, a.name, a.acronym,
    to_tsvector('english', coalesce(a.name,'') || ' ' || coalesce(a.acronym,'')),
    coalesce(a.is_synthetic, false),
    a.agency_type, 'active', coalesce(cn.c, 0), a.updated_at, NULL, now()
  FROM public.agencies a
  LEFT JOIN _conn cn ON cn.entity_id = a.id
  WHERE a.is_active;

  -- ── financial (non-individual) — FIX-667 amount precedence ──────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    financial_type, industry, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'financial', f.id, f.display_name, f.entity_type,
    to_tsvector('english', coalesce(f.display_name,'') || ' ' || coalesce(f.entity_type,'')),
    coalesce(f.is_synthetic, false),
    f.entity_type, fi.tag,
    amt.amount_cents, amt.amount_label,
    coalesce(cn.c, 0),
    f.created_at,   -- FIX-699: updated_at is stale (lost trigger) — created_at is the defensible column
    CASE WHEN amt.amount_label IN ('contract','grant') THEN 'usaspending' ELSE 'fec' END,
    now()
  FROM public.financial_entities f
  LEFT JOIN _conn cn ON cn.entity_id = f.id
  LEFT JOIN _fe_industry fi ON fi.entity_id = f.id
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN ie > 0 THEN ie
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types) THEN spend
           ELSE don END AS amount_cents,
      CASE WHEN ie > 0 THEN 'independent_expenditure'
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types)
             THEN CASE WHEN contract_c >= grant_c THEN 'contract' ELSE 'grant' END
           ELSE 'donation' END AS amount_label
    FROM (SELECT
            coalesce(f.total_ie_support_cents,0) + coalesce(f.total_ie_oppose_cents,0) AS ie,
            coalesce(f.total_contract_cents,0)   + coalesce(f.total_grant_cents,0)     AS spend,
            coalesce(f.total_contract_cents,0)   AS contract_c,
            coalesce(f.total_grant_cents,0)      AS grant_c,
            coalesce(f.total_donated_cents,0)    AS don) v
  ) amt
  WHERE f.entity_type <> 'individual';

  -- ── jurisdiction ────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'jurisdiction', jr.id, jr.name, jr.type::text,
    to_tsvector('english', coalesce(jr.name,'') || ' ' || coalesce(jr.short_name,'')),
    coalesce(jr.is_synthetic, false),
    CASE lower(jr.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    'active', coalesce(cn.c, 0), jr.updated_at, 'census', now()
  FROM public.jurisdictions jr
  LEFT JOIN _conn cn ON cn.entity_id = jr.id
  WHERE jr.is_active;

  -- ── institution (governing bodies) ──────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, institution_type, status, connection_count, activity_at, refreshed_at)
  SELECT
    'institution', g.id, g.name, g.type::text,
    to_tsvector('english', coalesce(g.name,'') || ' ' || coalesce(g.short_name,'')),
    coalesce(g.is_synthetic, false),
    CASE lower(gj.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    g.type::text, 'active', coalesce(cn.c, 0), g.updated_at, now()
  FROM public.governing_bodies g
  LEFT JOIN public.jurisdictions gj ON gj.id = g.jurisdiction_id
  LEFT JOIN _conn cn ON cn.entity_id = g.id
  WHERE g.is_active;

  -- ── meeting ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, connection_count, activity_at, refreshed_at)
  SELECT
    'meeting', m.id, m.title, m.meeting_type,
    to_tsvector('english', coalesce(m.title,'') || ' ' || coalesce(m.meeting_type,'')),
    false,  -- meetings have no is_synthetic column
    m.status, coalesce(cn.c, 0), m.scheduled_at, now()
  FROM public.meetings m
  LEFT JOIN _conn cn ON cn.entity_id = m.id
  WHERE m.title IS NOT NULL;

  -- ── facet rollup ──
  PERFORM public.rebuild_browse_facet_counts();

  SELECT count(*) INTO v_count FROM public.entity_search_index;

  -- FIX-1269 (cc-188) — one row that says when this table was last built, so a
  -- reader that wants its freshness reads a key instead of sorting 367,713
  -- rows for one refreshed_at (the */30 status snapshot did, 15,285 blocks read
  -- per call). now() is the same value every row above was stamped with, so
  -- this equals max(entity_search_index.refreshed_at) by construction.
  -- conn_source / conn_reason are FIX-1132's receipt: which path built _conn.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('entity_search_index', jsonb_build_object(
            'refreshed_at', now(),
            'rows',         v_count,
            'conn_source',  v_conn_source,
            'conn_reason',  v_currency->>'reason',
            'conn_seconds', round(v_conn_secs, 1),
            'stats_fp',     v_currency->>'live_fp'))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_search_index() TO service_role;

-- ---------------------------------------------------------------------------
-- run_rule_taggers — copied from 20261007010000_fix1284_weekly_merge_work_mem_box_gate.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.run_rule_taggers(IN p_cadence text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key    bigint := hashtext('run_rule_taggers')::bigint;  -- shared by both cadences
  c_wm_key      text   := 'size_tags:donation_watermark';
  v_log_id      uuid;
  v_rows        bigint := 0;
  v_action      text;
  v_current_sig text;
  v_stored_sig  text;
  v_failures    text[] := ARRAY[]::text[];
  v_canceled    text := NULL;                          -- FIX-1028
  v_started     timestamptz := clock_timestamp();      -- FIX-979
  v_phase       jsonb := '{}'::jsonb;                  -- FIX-1178 (d)
  v_t0          timestamptz;                           -- FIX-1178 (d)
  v_t1          timestamptz;                           -- FIX-1178 (d)
  v_t2          timestamptz;                           -- FIX-1178 (a)
  v_desired     bigint := NULL;                        -- FIX-1178 (a)
  v_deleted     bigint := NULL;                        -- FIX-1178 (a)
  v_inserted    bigint := NULL;                        -- FIX-1248
  v_updated     bigint := NULL;                        -- FIX-1248
  v_gate        jsonb  := NULL;                        -- FIX-1284
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;
  -- >>> FIX-1284 D2 — the P1-A START gate (FIX-1194), weekly only: wait up to
  -- 600 s for a box that is neither stale nor failing forks. BEFORE the lock,
  -- so a waiting firing holds nothing; before the FIX-950 stand-down, so a
  -- claim taken during the wait is still read. The sensor's memory half is
  -- report-only: this does not see a swapping box whose probe still forks.
  IF p_cadence = 'weekly' THEN
    v_gate := public.box_backoff_gate('rule-taggers-weekly', 600);
    IF NOT (v_gate->>'clear')::boolean THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
              jsonb_build_object('cadence', p_cadence,
                                 'skip_reason', format('box saturated after %s s: %s',
                                                       v_gate->>'waited_s', v_gate->>'reason'),
                                 'source', 'pg_cron',
                                 'gate', v_gate));
      RAISE NOTICE '[rule-taggers] box saturated (%) after % s — skipping (FIX-1284)',
        v_gate->>'reason', v_gate->>'waited_s';
      RETURN;
    END IF;
  END IF;
  -- <<< FIX-1284 D2

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent run_rule_taggers',
                               'source', 'pg_cron'));
    RAISE NOTICE '[rule-taggers] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rule-taggers] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Bounded memory for the aggregate rebuilds (they HashAggregate the donation /
  -- vote set). Plain SET survives COMMIT. Budget = 3 h (FIX-1185; the 10-06
  -- cancel landed 2 h late under swap thrash — cc-204 §8 Q1). Weekly: 64MB below.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', v_started,
          jsonb_build_object('cadence', p_cadence, 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  -- >>> FIX-1284 D2 — a wait the gate took is on the record (the P1-A shape).
  IF (v_gate->>'waited_s')::int > 0 THEN
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('gate', v_gate)
     WHERE id = v_log_id;
  END IF;
  -- <<< FIX-1284 D2
  COMMIT;

  IF p_cadence = 'weekly' THEN
    -- ── size-tags (donation-derived), gated ──────────────────────────────────
    BEGIN
      SELECT count(*)::text || '|'
             || COALESCE(max(created_at), 'epoch'::timestamptz)::text || '|'
             || COALESCE(max(updated_at), 'epoch'::timestamptz)::text
        INTO v_current_sig
        FROM public.financial_relationships
       WHERE from_type = 'financial_entity' AND relationship_type = 'donation';

      SELECT value->>'sig' INTO v_stored_sig
        FROM public.pipeline_state WHERE key = c_wm_key;

      IF v_stored_sig IS DISTINCT FROM v_current_sig THEN
        -- FIX-1248 — the MERGE, three phases, timed separately, all in the
        -- SAME transaction as the signature advance below, with no COMMIT
        -- between them: scan, then DELETE current\desired on (entity_id, tag),
        -- then INSERT desired\current with a moved total UPDATEd in place.
        -- >>> FIX-1284 D1 — every hash in the trio sizes by |desired| (4.43M
        -- on prod). At 256MB x hash_mem_multiplier 2 the INSERT's ~560 MB
        -- anti-join hash ran against a 512 MB hash_mem on a 904 MB box already
        -- carrying ~800 MB in swap, and wedged it (10-06 16:04Z, MemAvailable
        -- 141 MB). At 64MB each hash spills to temp past 128 MB: the clone
        -- measured Batches 2 / 2 / 4 (pre-count / DELETE / INSERT), no slower,
        -- peak backend memory 380 -> 126 MB. A plain SET, like the daily's
        -- above; it holds for the rest of the session.
        -- FIX-1295 M1 (cc-210 B6): the SET above is 64MB now too; kept so the weekly's allowance stays explicit.
        SET work_mem = '64MB';
        -- <<< FIX-1284 D1
        v_t0      := clock_timestamp();
        v_desired := public.rebuild_financial_entity_size_tags_scan();
        v_t1      := clock_timestamp();
        v_phase   := v_phase || jsonb_build_object('scan', round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1));  -- FIX-1287
        v_deleted := public.rebuild_financial_entity_size_tags_delete();
        v_t2      := clock_timestamp();
        v_phase   := v_phase || jsonb_build_object('delete', round(EXTRACT(epoch FROM (v_t2 - v_t1))::numeric, 1));  -- FIX-1287
        SELECT i.inserted, i.updated INTO v_inserted, v_updated
          FROM public.rebuild_financial_entity_size_tags_insert() i;
        v_phase   := v_phase || jsonb_build_object('insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t2))::numeric, 1));  -- FIX-1287
        v_rows    := v_inserted + v_updated;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — merged (desired % / deleted % / inserted % / updated %, sig=%, phases=%)',
          v_desired, v_deleted, v_inserted, v_updated, v_current_sig, v_phase;
      ELSE
        v_action := 'skipped_unchanged';
        RAISE NOTICE '  [rule-taggers] size-tags — donation source unchanged (sig=%), skipping rebuild', v_current_sig;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, first. The rebuild and its signature advance share
    -- this subtransaction, so a cancel rolls BOTH back and the next run redoes
    -- the same work. Nothing to gate; just record it and close the row.
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      -- Rebuild + watermark advance roll back together → next run retries.
      v_action := 'failed';
      v_failures := v_failures || format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  ELSE
    -- ── pre-vote timing (vote-derived), ungated ──────────────────────────────
    BEGIN
      -- FIX-1178 (a) — the MERGE, three phases, timed separately, all in the
      -- SAME transaction with no COMMIT between them: scan, then DELETE
      -- current\desired, then INSERT desired\current. They still stand or fall
      -- together, exactly as when this was one rewriting function call.
      v_t0      := clock_timestamp();
      v_desired := public.rebuild_pre_vote_timing_tags_scan();
      v_t1      := clock_timestamp();
      v_phase   := v_phase || jsonb_build_object('scan', round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1));  -- FIX-1287
      v_deleted := public.rebuild_pre_vote_timing_tags_delete();
      v_t2      := clock_timestamp();
      v_phase   := v_phase || jsonb_build_object('delete', round(EXTRACT(epoch FROM (v_t2 - v_t1))::numeric, 1));  -- FIX-1287
      v_rows    := public.rebuild_pre_vote_timing_tags_insert();
      v_phase   := v_phase || jsonb_build_object('insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t2))::numeric, 1));  -- FIX-1287
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — merged (desired % / deleted % / inserted %, phases=%)',
        v_desired, v_deleted, v_rows, v_phase;
    EXCEPTION
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_action := 'failed';
      v_failures := v_failures || format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'tagger', CASE WHEN p_cadence = 'weekly' THEN 'size_tags' ELSE 'pre_vote_timing' END,
                        'action', v_action,
                        'tags_written', v_rows,
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
                      -- FIX-1178 (d) — absent, not null, when nothing was timed
                      -- (the gated weekly branch that skips as skipped_unchanged).
                      || CASE WHEN v_phase = '{}'::jsonb THEN '{}'::jsonb
                              ELSE jsonb_build_object('phase_seconds', v_phase) END
                      -- FIX-1178 (a) — same discipline: the merge's set sizes,
                      -- absent on any branch that did not measure them.
                      || CASE WHEN v_desired IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('desired_rows', v_desired,
                                                      'deleted_rows', v_deleted) END
                      -- FIX-1248 — the weekly merge's two write counts, absent
                      -- on the daily and on a weekly skipped_unchanged.
                      || CASE WHEN v_inserted IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('inserted_rows', v_inserted,
                                                      'updated_rows', v_updated) END
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.run_rule_taggers(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_rule_taggers(text) TO service_role;

-- ---------------------------------------------------------------------------
-- rebuild_official_vote_stats — copied from 20260911000200_fix950_guards_rebuild_family.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.rebuild_official_vote_stats()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_count   bigint;
  v_started timestamptz := clock_timestamp();  -- FIX-979
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('official_vote_stats_rebuild')::bigint) THEN
    RAISE NOTICE '[vote-stats rebuild] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('official_vote_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[vote-stats rebuild] prod session held — skipping (FIX-950)';
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  -- Atomic swap: readers are snapshot-isolated, so DELETE + INSERT in one txn is
  -- never observed as an empty set. Aggregation is byte-identical to _full().
  DELETE FROM public.official_vote_stats;

  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  INSERT INTO public.official_vote_stats (official_id, total_votes, yes_votes, bipartisan_yes)
  SELECT
    to2.official_id,
    to2.total_votes::BIGINT,
    to2.yes_votes::BIGINT,
    COALESCE(b.bipartisan_yes, 0)::BIGINT
  FROM totals to2
  LEFT JOIN bipartisan b ON b.official_id = to2.official_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the full write, so the read fn only
  -- leaves the _full() fallback once the complete set is committed.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('official_vote_stats_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text, 'rows', v_count))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_vote_stats_rebuild', 'complete', v_started, clock_timestamp(), v_count,
          jsonb_build_object('rows', v_count));

  RAISE NOTICE '[vote-stats rebuild] complete — % officials', v_count;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.rebuild_official_vote_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.rebuild_official_vote_stats() TO service_role;
