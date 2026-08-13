-- =============================================================================
-- FIX-1028 (2 of 14) — refresh_official_donor_rollup_incremental() and
-- run_entity_connections_rebuild() can now close their own data_sync_log row
-- when they are cancelled.
--
-- THE DEFECT (census in the FIX-1028 bullet; catalog-derived, not hand-kept).
-- PL/pgSQL's `EXCEPTION WHEN OTHERS` matches every error condition EXCEPT
-- `query_canceled` and `assert_failure`. `statement_timeout` raises exactly
-- `query_canceled` (57014), and so does `pg_cancel_backend` and a client
-- disconnect. So a procedure that
--
--   1. INSERTs a data_sync_log row with status='running',
--   2. COMMITs it (making it visible),
--   3. relies on a trailing UPDATE to close it,
--
-- will have step 3 skipped entirely when the 6h axe lands: the error blows
-- through the WHEN OTHERS handler, out of the loop, and out of the procedure,
-- leaving the row stranded `running` until the nightly reaper closes it up to
-- 60 minutes later. Of the 15 procedures on prod that write a running row AND
-- use transaction control, 14 have this defect. Only refresh_derived_mvs()
-- handles it, as of FIX-1021.
--
-- THIS MIGRATION FIXES THE TWO THAT ACTUALLY GET CANCELLED IN PRACTICE. The
-- other 12 are a later sweep; the FIX-1028 bullet stays OPEN and records 2/14.
--
-- THE IDIOM, mirroring what FIX-1021 shipped and verified locally:
--   * `WHEN query_canceled THEN` BY NAME on the existing per-unit/per-chunk
--     handler, listed BEFORE `WHEN OTHERS`.
--   * record it, then EXIT the loop — the box has just proven it cannot finish
--     one unit, so starting the next only re-arms the same axe.
--   * let the EXISTING trailing UPDATE close the row as `partial`.
--   * the handler CANNOT be an outer block wrapping the loop: PL/pgSQL forbids
--     COMMIT inside a block that has an EXCEPTION clause, so it must live on
--     the per-iteration block that is already there.
-- The timer that fired is disarmed once it has thrown, so the bookkeeping
-- UPDATE after the catch does run (verified in FIX-1021's local repro).
--
-- TWO NON-OBVIOUS CONSEQUENCES, both of which are why these two went first:
--
-- (a) run_entity_connections_rebuild() in mode='full' pauses autovacuum on
--     entity_connections (ALTER TABLE … autovacuum_enabled=false) and COMMITs
--     that, then re-enables it after the chunk loop. Before this change a
--     cancel jumped straight over the re-enable, so a cancelled full rebuild
--     left autovacuum STRANDED OFF on the platform's largest table. That is
--     precisely the FIX-884 mechanism — the 2026-06-28 GHA run was cancelled at
--     its cap and the flag sat off for ~4 weeks (9.5M dead tuples, all-visible
--     0.9%, index-only scans degraded to per-row heap fetches). FIX-885 added a
--     startup reconcile to heal it on the NEXT run; this makes the cancelling
--     run clean up after itself instead. Falling out of the loop reaches the
--     re-enable, which is the main reason the EXIT shape is right.
--
-- (b) refresh_official_donor_rollup_incremental() must NOT advance its resume
--     cursor past a CANCELLED chunk. A FAILED chunk may advance it, because
--     sweep_failures then blocks the watermark advance and the whole set is
--     retried; a cancel routes to the 'partial' branch, which does not set
--     sweep_failures, so an advanced cursor there would permanently skip the
--     recipients whose work had just been rolled back. The cursor write is
--     therefore gated on `v_canceled IS NULL`.
--
-- Both bodies below are pg_get_functiondef() output taken from PROD
-- (2026-08-13) with only the changes described above applied, so this migration
-- cannot silently revert an intermediate definition.
--
-- Cross-ref FIX-1021, FIX-990, FIX-968, FIX-969, FIX-944, FIX-885, FIX-884,
-- FIX-979.
-- =============================================================================

CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
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

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object('mode', p_mode, 'source', 'pg_cron')
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- This is the crash-safe half of FIX-590/591: the pause is undone at the end
  -- of a successful run, but a run that dies hard (or a GHA break-glass run
  -- SIGKILLed at the 4h cap) leaves the flag off with nothing to restore it.
  -- The TS rebuild script has carried this reconcile since FIX-591, but FIX-688
  -- moved the schedule to pg_cron and left that script as manual break-glass —
  -- so the self-heal stopped running on prod entirely. That is how FIX-884
  -- happened: the 2026-06-28 GHA run was cancelled at the cap, and the flag sat
  -- off for ~4 weeks (9,505,759 dead tuples, all-visible 0.9%) because both
  -- pg_cron jobs are 'incremental' and every re-enable here was gated on v_full.
  --
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  --
  -- The predicate parses reloptions the way check_rebuild_autovacuum_status()
  -- does (split_part -> boolean, absent => default true) rather than matching a
  -- literal 'autovacuum_enabled=false', so the reconcile and the detector can
  -- never disagree about what "stranded" means.
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

  -- ── Full donations chunk — per-window COMMIT (FIX-703) ─────────────────────
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint on Micro
  -- (so the raised CALL-level budget never becomes an atomic multi-hour txn).
  -- Each window range-scopes its delete+insert, so a mid-run failure leaves
  -- un-processed windows' PRIOR edges intact (complete-if-stale, never missing).
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band (reconcile_recipient_count(), monthly post-VACUUM) and stays
  -- dirty-scoped in the incremental donations path.
  IF v_full THEN
    BEGIN
      PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('donations prepare: %s', SQLERRM);
      RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
    END;
    COMMIT;

    v_donations_total := 0;
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
        v_donations_total := v_donations_total + v_win;
        RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
      EXCEPTION
      -- FIX-1028 — by name, FIRST. The prior comment on this handler asserted
      -- "WHEN OTHERS catches a statement_timeout cancel too", which is exactly
      -- backwards: PL/pgSQL's OTHERS matches every error EXCEPT query_canceled
      -- and assert_failure.
      WHEN query_canceled THEN
        v_canceled := format('donations window %s [%s..%s): %s',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
        RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
      WHEN OTHERS THEN
        -- Per-window catch: one bad window must not abort the rest; the run is
        -- reported `failed`.
        v_failures := v_failures || format('donations window %s [%s..%s): %s',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
        RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
      END;
      -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction — PL/pgSQL
      -- forbids COMMIT inside one).
      COMMIT;

      -- FIX-1028 — stop the sweep. The box has just proven it cannot finish one
      -- window; the remaining 15 would each re-arm the same axe. Falling out of
      -- the loop still reaches the autovacuum re-enable and the terminal UPDATE
      -- below, which is the whole point.
      IF v_canceled IS NOT NULL THEN
        EXIT;
      END IF;
    END LOOP;

    v_total := v_total + v_donations_total;
    RAISE NOTICE '  [chunk] donations (windowed) — complete (% edges)', v_donations_total;
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
    v_fns := ARRAY[
      'rebuild_entity_connections_donations',
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
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;
    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    COMMIT;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        -- Distinct from 'failed' (a chunk raised) and 'complete'.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s', v_canceled,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;

  -- FIX-1002 — wall-clock budget for ONE run. See the header for the sizing:
  -- 3h between firings, pg_cron queues rather than skips, one healthy full
  -- sweep measured 2h00m43s. Overridable via civitics.donor_rollup_budget_seconds.
  c_budget     interval := interval '2 hours';

  -- What one chunk SHOULD cost. The guard can only act between chunks, so this
  -- is also the granularity of every control decision in the loop and the blast
  -- radius of a mid-chunk cancel by the outer 6h timeout. 300 s over a 2 h
  -- budget gives the guard ~24 evaluation points per run; FIX-972's regime gave
  -- it 3. Overridable via civitics.donor_rollup_chunk_target_seconds.
  c_chunk_secs int := 300;

  -- Hard caps on one chunk, so a mis-calibrated rows-per-second cannot build a
  -- monster. c_weight_max is ~450 s at the healthy measured rate of 448 rows/s.
  c_weight_max     bigint := 200000;   -- FR rows
  c_recipients_max int    := 500;      -- recipients (also the meaning of the
                                       -- pre-existing donor_rollup_chunk_size GUC)

  -- Cold-start rows-per-second, used only when pipeline_state carries no
  -- calibration. Deliberately pessimistic: prod's WORST measured incremental
  -- rate was 28.7 rows/s (08-07, un-vacuumed arms) against 448 rows/s healthy.
  -- Starting low costs one short first chunk; starting high costs an outage.
  c_rps_seed   double precision := 30.0;

  -- Weight assumed for a recipient with no official_donor_totals row yet.
  -- p90 of the live distribution (1,389), rounded up — being wrong-small here
  -- is what builds an oversized chunk, so this errs pessimistic.
  c_weight_default bigint := 1500;

  -- Latest UTC hour at which a firing may START. The 12:00 backstop exists for
  -- the case where 09:00 was starved at startup; it must not turn into a second
  -- full window chained onto an overrunning first one (measured 08-06/07/08).
  -- Overridable two ways: civitics.donor_rollup_ignore_start_window for
  -- break-glass, and civitics.donor_rollup_latest_start_hour to move the cutoff
  -- (0 refuses always, 24 never refuses). The second exists so the refusal is
  -- TESTABLE without waiting for a wall clock — a guard that can only be
  -- observed by getting unlucky is the same class of defect as the one this
  -- migration is fixing.
  c_latest_hour int := 13;

  -- FIX-1018 — fraction of the budget the PRE-LOOP dirty-set build may consume
  -- before the run refuses to enter the loop at all.
  --
  -- Sizing, one line: the healthy build is 52.8 s against a 7,200 s budget
  -- (0.7%) and should be well under that once the index below is in place, so
  -- anything past 50% is two orders of magnitude off-nominal and means the box
  -- is in the contention regime this run must not add to; below 50% there is
  -- still a full c_chunk_secs target of window left with headroom, so entering
  -- the loop is still worth it. This guard exists for the ~176x case, not the
  -- healthy one. Overridable via
  -- civitics.donor_rollup_dirty_set_budget_fraction (which is also how the
  -- refusal is exercised in test — playbook C3).
  c_dirty_frac double precision := 0.5;

  v_state      jsonb;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_cursor     uuid;
  v_resumed    boolean := false;
  v_dirty      uuid[];
  v_weights    bigint[];
  v_chunk      uuid[];
  v_n_recips   int;
  v_i          int := 1;
  v_j          int;
  v_chunk_end  int;
  v_chunk_w    bigint;
  v_target_w   bigint;
  v_fit_w      bigint;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  v_prior_fail int := 0;
  v_budget_cfg int;
  v_chunk_cfg  int;
  v_secs_cfg   int;
  v_hour_cfg   int;
  v_frac_cfg   double precision;   -- FIX-1018
  v_ignore_win boolean;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_dirty_secs double precision;   -- FIX-1018
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_stop_why   text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- Routed into the EXISTING v_budget_hit 'partial' branch below rather than a
  -- new terminal path: a cancelled sweep and a budget-stopped sweep are the same
  -- thing to a reader (resumable, cursor intact), so they get the same shape.
  v_canceled   text := NULL;
  v_blocked    uuid := NULL;
  v_elapsed    double precision;
  v_remaining  double precision;
  v_rps_seed   double precision;
  v_rps_run    double precision := NULL;
  v_rps        double precision;
  v_yield      double precision;
  v_budget_s   double precision;
BEGIN
  -- ── Start-window refusal (FIX-1002) ───────────────────────────────────────
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget. This is the job stopping ITSELF; nothing here depends
  -- on an operator noticing (FIX-965's lesson — a cancelled long CALL wedged
  -- prod for ~7 h on 08-05, so cancellation is not a control path).
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
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  -- Session advisory lock (survives the COMMITs below). Stampede protection.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded per-chunk memory. Plain SET (not SET LOCAL) survives the per-chunk
  -- COMMITs. NOTE (FIX-703/FIX-944): the CALL's statement_timeout is the
  -- postgres role default (6h) armed at CALL start — nothing in this body can
  -- change it, which is exactly why the c_budget loop guard below exists.
  SET work_mem = '128MB';

  SELECT value INTO v_state
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  v_watermark := (v_state->>'last_indexed_at')::timestamptz;
  v_cursor    := NULLIF(v_state->>'sweep_cursor', '')::uuid;

  -- FIX-1002 — cross-run calibration. The previous run's measured (pessimistic)
  -- rows-per-second sizes THIS run's first chunk, which is the one FIX-972's
  -- guard could never protect. Persisted alongside the cursor and carried
  -- across sweep completion.
  v_rps_seed := COALESCE(
    NULLIF(v_state->>'rows_per_second', '')::double precision, c_rps_seed);
  IF v_rps_seed <= 0 THEN v_rps_seed := c_rps_seed; END IF;

  -- Optional operator overrides, all SESSION GUCs rather than shared state
  -- (FIX-944 decision 6): a pipeline_state override would have to be restored
  -- afterwards, and a run that died before restoring would silently re-widen
  -- every subsequent pg_cron run. A GUC dies with the connection.
  --     SET civitics.donor_rollup_budget_seconds              = '72000';
  --     SET civitics.donor_rollup_chunk_target_seconds        = '600';
  --     SET civitics.donor_rollup_chunk_size                  = '250';
  --     SET civitics.donor_rollup_ignore_start_window         = 'on';
  --     SET civitics.donor_rollup_dirty_set_budget_fraction   = '0.5';
  v_budget_cfg := NULLIF(current_setting('civitics.donor_rollup_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  v_secs_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_target_seconds', true), '')::int;
  IF COALESCE(v_secs_cfg, 0) > 0 THEN
    c_chunk_secs := LEAST(v_secs_cfg, 3600);
  END IF;

  -- Pre-existing GUC, repurposed: it now caps RECIPIENTS per chunk rather than
  -- fixing them. Clamped to [1, 5000] — 0 or negative would make the inner
  -- accumulator never advance v_i, i.e. an infinite loop holding an advisory
  -- lock (the FIX-972 hazard, preserved).
  v_chunk_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_size', true), '')::int;
  IF COALESCE(v_chunk_cfg, 0) > 0 THEN
    c_recipients_max := LEAST(v_chunk_cfg, 5000);
  END IF;

  -- FIX-1018 — clamped to (0, 1]. A value of 0 or below would make the pre-loop
  -- refusal fire on every run including healthy ones, permanently parking the
  -- sweep; above 1 it could never fire at all.
  v_frac_cfg := NULLIF(current_setting('civitics.donor_rollup_dirty_set_budget_fraction', true), '')::double precision;
  IF COALESCE(v_frac_cfg, 0) > 0 THEN
    c_dirty_frac := LEAST(v_frac_cfg, 1.0);
  END IF;

  v_budget_s   := EXTRACT(epoch FROM c_budget);
  v_prior_fail := COALESCE((v_state->>'sweep_failures')::int, 0);

  IF v_cursor IS NOT NULL AND (v_state ? 'sweep_target') THEN
    -- RESUMING an interrupted sweep. Reuse the target captured at sweep start
    -- so mid-sweep FR writes stay for the NEXT sweep (FIX-704 invariant).
    v_resumed := true;
    v_new_max := (v_state->>'sweep_target')::timestamptz;
  ELSE
    -- Capture the new watermark BEFORE building the dirty set so FR writes that
    -- land mid-refresh are re-processed by the next run, never silently consumed.
    v_cursor     := NULL;
    v_prior_fail := 0;
    SELECT MAX(fr.updated_at) INTO v_new_max
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');
  END IF;

  -- ── Dirty set, now carrying a per-recipient cost weight (FIX-1002) ────────
  -- ORDER BY is load-bearing: the cursor resumes on uuid order, so the dirty
  -- set must be built the same way on every resuming run, and v_dirty/v_weights
  -- must be built in ONE aggregate so the two arrays stay index-aligned.
  --
  -- The weight is official_donor_totals.donor_count — COUNT(*) of that
  -- official's donation FR rows, already maintained by the odt arm of
  -- donor_rollup_rebuild_recipients(). 6,782 rows / 117 pages, so reading it is
  -- free next to the scan it is sizing. Two known imprecisions, both tolerable
  -- because the loop RE-MEASURES rows-per-second empirically after every chunk:
  --   * it counts only 'donation', not ie_support/ie_oppose, so an IE-heavy
  --     recipient is under-weighted;
  --   * it is itself one run stale for recipients in the current dirty set.
  --
  -- FIX-1018 — `to_type = 'official'` is REQUIRED, not an optimisation. Without
  -- it 57% of the enumerated recipients are financial_entities that the arms
  -- cannot roll up, 54% of the dirty weight is c_weight_default fabricated for
  -- them, and the uuid-ordered cursor parks on whichever PAC sorts first. It is
  -- also what lets the planner use
  -- financial_relationships_donor_rollup_dirty_idx above; the two changes are
  -- one fix, not alternatives (see the header's measurement B).
  IF v_watermark IS NULL THEN
    -- Bootstrap: every recipient, same chunked loop.
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  ELSE
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND fr.updated_at > v_watermark
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  END IF;

  -- FIX-1018 — stamp the pre-loop cost. This is the ONLY place it can be
  -- measured: v_started is procedure entry and the next thing that happens is
  -- the loop. Recorded on EVERY run, success or refusal, because its absence
  -- from the logs is what made FIX-1018 take a day to find.
  v_dirty_secs := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'dirty_weight', COALESCE((SELECT SUM(w) FROM unnest(v_weights) w), 0),
            -- 3 dp, not 1: a healthy post-index build is sub-second, and a
            -- value that rounds to "0.0" reads as "not measured" — which is
            -- the exact failure mode this key exists to end.
            'dirty_set_build_seconds', round(v_dirty_secs::numeric, 3),   -- FIX-1018
            'resumed', v_resumed,
            'resume_cursor', v_cursor,
            'sweep_failures_before', v_prior_fail,
            'budget_seconds', v_budget_s,
            'chunk_target_seconds', c_chunk_secs,
            'rows_per_second_seed', round(v_rps_seed::numeric, 2),
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  -- ── The PRE-LOOP budget refusal (FIX-1018) ────────────────────────────────
  -- FIX-1002's guard is armed from chunk 1, which is correct and still leaves
  -- everything before iteration 1 unguarded. On 2026-08-10 that unguarded
  -- region was 9,292 of 9,367 seconds. Refuse here rather than enter a loop
  -- that has no window left, so the run stops evicting a 256 MB buffer pool on
  -- behalf of work it cannot finish.
  --
  -- Skipped when v_n_recips = 0: an empty dirty set means there is nothing to
  -- refuse and the run should COMPLETE and advance the watermark, however long
  -- the build took.
  IF v_n_recips > 0 AND v_dirty_secs > c_dirty_frac * v_budget_s THEN
    v_budget_hit := true;
    v_stop_why   := 'dirty_set_build_exhausted_budget';
    RAISE NOTICE '[donor-rollup] dirty-set build took %s of a %s budget (limit fraction %) — refusing to enter the loop',
      round(v_dirty_secs)::int, round(v_budget_s)::int, c_dirty_frac;
  END IF;

  WHILE NOT v_budget_hit AND v_i <= v_n_recips LOOP
    v_elapsed   := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    v_remaining := v_budget_s - v_elapsed;
    v_rps       := COALESCE(v_rps_run, v_rps_seed);

    -- Out of window entirely. Distinct from the per-chunk refusal below so the
    -- log says which one stopped the run.
    IF v_chunk_no > 0 AND v_remaining <= 0 THEN
      v_budget_hit := true;
      v_stop_why   := 'budget_exhausted';
      RAISE NOTICE '[donor-rollup] budget exhausted after chunk % (elapsed %s)',
        v_chunk_no, round(v_elapsed)::int;
      EXIT;
    END IF;

    -- ── Size this chunk (FIX-1002) ──────────────────────────────────────────
    -- Target the configured per-chunk duration at the measured rate, then
    -- shrink to fit what is actually left of the budget (with 25% headroom).
    -- Shrinking BEFORE the guard has to refuse is what turns the budget from a
    -- cliff into a taper: a run near its limit does small chunks rather than
    -- gambling one big one.
    v_target_w := GREATEST(1, LEAST(c_weight_max, (c_chunk_secs * v_rps)::bigint));
    v_fit_w    := GREATEST(1, (GREATEST(v_remaining, 0) * v_rps / 1.25)::bigint);
    v_target_w := LEAST(v_target_w, v_fit_w);

    -- Accumulate recipients until the weight target or the recipient cap is
    -- hit. A chunk is ALWAYS at least one recipient, so a single whale heavier
    -- than the whole target forms its own chunk and the loop still advances.
    v_chunk_end := v_i;
    v_chunk_w   := COALESCE(v_weights[v_i], c_weight_default);
    v_j         := v_i + 1;
    WHILE v_j <= v_n_recips
          AND v_chunk_end - v_i + 1 < c_recipients_max
          AND v_chunk_w + COALESCE(v_weights[v_j], c_weight_default) <= v_target_w
    LOOP
      v_chunk_w   := v_chunk_w + COALESCE(v_weights[v_j], c_weight_default);
      v_chunk_end := v_j;
      v_j         := v_j + 1;
    END LOOP;

    -- ── The guard, ARMED FROM CHUNK 1 (FIX-1002) ────────────────────────────
    -- FIX-972's version reserved 1.25 × the slowest chunk SEEN, which is a
    -- high-water mark of the past and says nothing about the chunk in hand.
    -- This projects the cost of THIS chunk from its own weight, so a whale is
    -- refused on its own merits.
    --
    -- The `v_chunk_no > 0` exception is deliberate and is about LIVENESS, not
    -- convenience: a lone recipient whose projected cost exceeds an entire
    -- budget would otherwise be refused by every future run forever and park
    -- the sweep permanently. The first chunk of a run always attempts, with the
    -- full window ahead of it and the 6h role timeout as the backstop. It is
    -- bounded by v_target_w (one recipient), not by a blind 50.
    IF v_chunk_no > 0
       AND (v_chunk_w / v_rps) * 1.25 > v_remaining THEN
      v_budget_hit := true;
      v_stop_why   := 'chunk_would_not_fit';
      IF v_chunk_end = v_i THEN
        v_blocked := v_dirty[v_i];
      END IF;
      RAISE NOTICE '[donor-rollup] budget guard — refusing chunk % (weight %, projected %s, remaining %s)',
        v_chunk_no + 1, v_chunk_w, round((v_chunk_w / v_rps) * 1.25)::int, round(v_remaining)::int;
      EXIT;
    END IF;

    v_chunk     := v_dirty[v_i : v_chunk_end];
    v_chunk_no  := v_chunk_no + 1;
    v_chunk_beg := clock_timestamp();
    BEGIN
      v_n    := public.donor_rollup_rebuild_recipients(v_chunk);
      v_rows := v_rows + v_n;
      IF v_chunk_no % 10 = 0 THEN
        RAISE NOTICE '[donor-rollup] chunk % — % recipients done, % rows so far',
          v_chunk_no, v_chunk_end, v_rows;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name. EXCEPTION WHEN OTHERS does not match query_canceled,
    -- so the 6h statement_timeout used to blow through this handler and out of
    -- the procedure, leaving the data_sync_log row stranded 'running' until the
    -- reaper found it up to 60 minutes later. This procedure is one of the two
    -- that actually get cancelled in practice.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its recipients keep their PRIOR
      -- rollup rows (complete-if-stale). The cursor still advances so the sweep
      -- terminates, but sweep_failures blocks the watermark advance at the end,
      -- so the whole set is retried by the next sweep.
      v_failures := v_failures || format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;

    -- FIX-944 — persist the cursor in the SAME transaction as the chunk's work.
    -- A run cancelled by the 6h statement_timeout keeps every committed chunk.
    -- FIX-972 — clock_timestamp(), NOT NOW(): NOW() is transaction_timestamp()
    -- and this transaction began right after the previous chunk's COMMIT, so it
    -- would stamp the moment this chunk STARTED.
    -- FIX-1002 — the calibration rides along, so the next run's first chunk is
    -- sized by the last run's measured rate.
    -- FIX-1028 — do NOT advance the cursor past a CANCELLED chunk. A failed
    -- chunk may advance (sweep_failures blocks the watermark, so the whole set
    -- is retried), but a cancel routes to the 'partial' branch which does NOT
    -- set sweep_failures — so an advanced cursor there would silently skip the
    -- recipients whose work was just rolled back. Leaving it un-advanced makes
    -- the next run redo exactly this chunk.
    IF v_canceled IS NULL THEN
    v_cursor := v_dirty[v_chunk_end];
    UPDATE public.pipeline_state
       SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
                     'sweep_cursor',    v_cursor::text,
                     'sweep_target',    v_new_max::text,
                     'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                     'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
           updated_at = clock_timestamp()
     WHERE key = 'donor_rollup_watermark';
    IF NOT FOUND THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark', jsonb_build_object(
                'sweep_cursor',    v_cursor::text,
                'sweep_target',    v_new_max::text,
                'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = clock_timestamp();
    END IF;
    END IF;  -- FIX-1028 cursor guard

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

    -- FIX-1028 — end the sweep on a cancel, reusing the budget-stop path so the
    -- run closes its own row as 'partial' and stays resumable at v_i.
    IF v_canceled IS NOT NULL THEN
      v_budget_hit := true;
      v_stop_why   := 'canceled';
      EXIT;
    END IF;

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;

    -- ── Re-measure the rate, pessimistically (FIX-1002) ─────────────────────
    -- Rolling MINIMUM within the run, so one expensive chunk immediately makes
    -- every subsequent chunk smaller. It resets each run rather than ratcheting
    -- down forever: a bad day pins the seed for exactly one following run, and
    -- a good run restores it.
    IF v_chunk_secs > 0 THEN
      v_rps_run := LEAST(COALESCE(v_rps_run, 1e18), v_chunk_w / v_chunk_secs);
    END IF;

    -- ── Pace (FIX-1002) ─────────────────────────────────────────────────────
    -- The saturation mechanism is shared-buffer eviction on a 256 MB pool, not
    -- disk throughput (Disk IO 3–5% while the site was down). Yielding gives
    -- the request path an unobstructed window to re-warm its own pages. Costs
    -- ~5% of the window at the default 300 s chunk. That trade is the point:
    -- a rollup that takes longer but leaves the site up is strictly better than
    -- one that converges fast and makes the platform unreachable. Do not
    -- "optimise" this away.
    v_yield := LEAST(v_chunk_secs * 0.10, 15.0);
    IF v_yield > 0 THEN PERFORM pg_sleep(v_yield); END IF;

    v_i := v_chunk_end + 1;
  END LOOP;

  IF v_budget_hit THEN
    -- Partial, resumable. Distinct from both 'complete' and 'failed'.
    UPDATE public.data_sync_log
    SET status        = 'partial',
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        -- FIX-1018 — say WHICH budget ran out. The pre-loop refusal and the
        -- in-loop exhaustion are different failures with different remedies,
        -- and a message that calls both "budget exhausted" hides the one this
        -- FIX exists to make visible.
        error_message = CASE
          -- FIX-1028 — name the cancel; it is not a budget stop and the remedy
          -- differs (the box could not finish one chunk, not "ran out of time").
          WHEN v_stop_why = 'canceled' THEN
            format('canceled — %s; resumable at recipient %s of %s (cursor %s)',
                   v_canceled, v_i, v_n_recips, v_cursor)
          WHEN v_stop_why = 'dirty_set_build_exhausted_budget' THEN
            format('dirty-set build consumed %ss of a %ss budget (limit %s%%) — loop not entered; resumable at recipient 1 of %s',
                   round(v_dirty_secs)::int, round(v_budget_s)::int,
                   round((c_dirty_frac * 100)::numeric, 1), v_n_recips)
          ELSE
            format('budget exhausted — resumable at recipient %s of %s (cursor %s)',
                   v_i, v_n_recips, v_cursor)
          END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_i - 1,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'resumable', true,
                          'resume_at_chunk', v_chunk_no + 1,
                          -- Which of the stop paths ended the run. Without
                          -- this, 'partial' cannot be told apart from 'partial'
                          -- and the guard is unfalsifiable from the log alone.
                          'stop_reason', v_stop_why,
                          'canceled', v_canceled IS NOT NULL,
                          'cancel_detail', v_canceled,
                          'remaining_recipients', GREATEST(v_n_recips - v_i + 1, 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          -- FIX-1002 — "no silent caps": a single recipient the
                          -- guard refuses because it cannot fit a whole budget
                          -- is a stuck sweep, not a paced one. Name it.
                          'blocked_recipient', v_blocked,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] PARTIAL (%) — % of % recipients this run, resumable at chunk %',
      v_stop_why, v_i - 1, v_n_recips, v_chunk_no + 1;
  ELSE
    -- Sweep finished. Advance the durable watermark only if NO chunk failed
    -- anywhere in the sweep (including earlier, interrupted runs of it), then
    -- clear the cursor so the next run starts a fresh sweep.
    IF v_prior_fail + COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1002 — this branch REPLACES the whole jsonb (that is how the sweep
      -- keys get cleared), so the calibration must be re-stated here or it is
      -- silently dropped every time a sweep completes. Same class of bug as the
      -- entity_comments rating trigger clobbering denormalized keys.
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark',
              jsonb_build_object(
                'last_indexed_at', COALESCE(v_new_max, NOW())::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, NOW())::text,
                      'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
            updated_at = NOW();
    ELSE
      UPDATE public.pipeline_state
         SET value = (value - 'sweep_cursor' - 'sweep_target' - 'sweep_failures'),
             updated_at = NOW()
       WHERE key = 'donor_rollup_watermark';
    END IF;

    UPDATE public.data_sync_log
    SET status        = CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0
                             THEN 'failed' ELSE 'complete' END,
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        error_message = CASE WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                             ELSE NULL END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_n_recips,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'sweep_failures_total', v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] % — % recipients in % chunks, % rows (% failures this run)',
      CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'PARTIAL' ELSE 'complete' END,
      v_n_recips, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);
  END IF;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;
