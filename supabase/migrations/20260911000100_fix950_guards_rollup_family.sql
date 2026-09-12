-- FIX-950 — the ROLLUP-REFRESH family stands down while a supervised prod
-- session is held.
--
-- HOW THIS FILE WAS BUILT, AND WHY IT LOOKS MACHINE-MADE
--
-- Each body below is the EXACT output of pg_get_functiondef() read from the
-- local prod-clone on 2026-09-11, md5-verified byte-identical to prod for all
-- twenty procedures before a character was changed, with ONE block inserted
-- immediately after the procedure's own advisory-lock acquisition. Nothing else
-- differs — not a SET clause, not whitespace, not a comment. That is the 885
-- model and rule 34's answer in one: an omitted `SET search_path` is silently
-- dropped by CREATE OR REPLACE, and the only reliable way to re-state twenty
-- bodies without losing one is not to retype them.
--
-- The guard: after the procedure has taken its own lock (so it is the legitimate
-- runner) and before it writes anything, it asks public.prod_session_state()
-- whether a human is holding the box. If so it writes the `skipped` row it
-- already knows how to write, releases the lock it just took, and returns —
-- in well under a second, which is the property the prod receipt measures.
--
-- `skipped` + `skip_reason` is deliberately the SAME vocabulary each of these
-- procedures already uses for its own lock contention, so nothing downstream
-- needs teaching: list_scheduled_rollup_pipelines() keeps listing the pipeline,
-- check_rollup_freshness() keeps counting only `complete` (so a held firing
-- correctly does NOT advance the freshness clock), and FIX-1137's future
-- re-fire can key on `skip_reason LIKE 'prod session held%'` — the same prefix
-- the nightly writes from TypeScript.
--
-- WHAT IS NOT GUARDED, and why: the twelve VACUUM jobs (a top-level VACUUM is
-- not a procedure and cannot branch), the two */2 watchdogs
-- (enforce_cron_job_budgets, enforce_derived_mvs_unit_budget — a session must
-- not disarm the thing that cancels runaway jobs), refresh_platform_counts and
-- purge_abuse_events (observational/retention, seconds). A session must not
-- blind the instruments.
--

-- ───────────────────────────────────────────────────────────────────────
-- refresh_derived_mvs
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(IN p_cadence text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('refresh_derived_mvs')::bigint;  -- shared by both cadences: never two at once
  v_log_id   uuid;
  v_units    text[];   -- SQL command per unit
  v_labels   text[];   -- human label per unit (data_sync_log / NOTICE)
  v_cmd      text;
  v_label    text;
  v_ok       int := 0;
  v_failures text[] := ARRAY[]::text[];
  i          int;
  -- FIX-1021 additions
  c_budget     double precision;         -- seconds; per-cadence, GUC-overridable
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_unit_beg   timestamptz;
  v_unit_secs  double precision;
  v_max_unit   double precision := 0;
  v_elapsed    double precision := 0;
  v_unit_times jsonb := '{}'::jsonb;     -- label -> seconds, ALWAYS written
  v_skipped    text[] := ARRAY[]::text[];
  v_budget_hit boolean := false;
  v_canceled   text := NULL;             -- non-NULL = query_canceled caught
  v_status     text;
  -- FIX-1030 addition
  c_unit_budget int;                     -- seconds; per-UNIT, enforced externally
  -- FIX-1152 addition
  v_vm          jsonb;                   -- visibility-map state this run ran against
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'refresh_derived_mvs: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  -- Session advisory lock (survives the per-unit COMMITs below). Stampede guard.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent refresh_derived_mvs',
                               'source', 'pg_cron'));
    RAISE NOTICE '[derived-mvs] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[derived-mvs] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Bounded per-unit memory. Plain SET (not SET LOCAL) survives the COMMITs.
  SET work_mem = '128MB';

  -- FIX-1109 finding 2 / FIX-1129: parallel workers OFF for the weekly cadence.
  -- The weekly's units 1 and 2 both build a hash over the whole of
  -- financial_entities (3.06M rows; width 16 for unit 1, width 26 for unit 2).
  -- Under a Parallel Hash Join that build lives in a DYNAMIC SHARED MEMORY
  -- segment, and on 2026-08-25 unit 2's segment could not grow:
  --   could not resize shared memory segment "/PostgreSQL.3323093180"
  --   to 134217728 bytes: No space left on device
  -- 134217728 = 128MB = exactly the work_mem set above, and 3.06M x 26 bytes
  -- plus tuple overhead is what asks for it. Reproduced on the prod-scale clone
  -- (2026-09-03): unit 2 at max_parallel_workers_per_gather=1 fails with the
  -- same error, and at 0 completes in 32.2s.
  --
  -- With no parallelism the same join becomes a plain Hash Join whose build is
  -- PRIVATE backend memory, bounded by work_mem x hash_mem_multiplier
  -- (128MB x 2 = 256MB) and permitted to spill to disk in batches instead of
  -- failing. Measured on the clone, this is not a speed trade: unit 1 ran
  -- 24.2s at 0 against 57.3s at 1, and units 3-6 plan identically either way.
  --
  -- Weekly ONLY. The daily cadence is untouched: none of its units joins
  -- financial_entities and it has never hit this failure class.
  IF p_cadence = 'weekly' THEN
    SET max_parallel_workers_per_gather = 0;
  END IF;

  -- FIX-1021: per-cadence budget. Measured 2026-08-12: work_mem is NOT the
  -- lever here (unit 1 measured 185 s at 256MB vs 198 s at 128MB, identical
  -- plan), so this stays as FIX-748 set it.
  c_budget := CASE p_cadence WHEN 'weekly' THEN 4200 ELSE 3300 END;
  v_budget_cfg := NULLIF(current_setting('civitics.derived_mvs_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := v_budget_cfg;
  END IF;

  -- FIX-1030: per-UNIT budget. Published for enforce_derived_mvs_unit_budget(),
  -- which runs in a different session and cannot read this session's GUC.
  -- NOTE: this procedure cannot enforce it itself — statement_timeout is armed
  -- once at CALL time and neither SET nor SET LOCAL re-arms it across a
  -- procedure's COMMIT (verified on PG 17; see the header and FIX-703).
  c_unit_budget := COALESCE(
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int, 900);

  IF p_cadence = 'daily' THEN
    -- proposal/vote/comment/engagement-derived + co-located daily maintenance.
    -- FIX-748: rebuild_entity_search_index appended (daily superset — new
    -- entities land on the nightly ingest; TRUNCATE+INSERT is atomic per unit).
    v_labels := ARRAY[
      'proposal_trending_24h', 'proposal_popularity_24h', 'homepage_stats_mv',
      'official_homepage_stats_mv', 'entity_engagement_rollup_mv',
      'homepage_agency_counts_mv', 'commons_active_threads', 'pipeline_runtime_stats_mv',
      'rebuild_entity_search_index',
      'rebuild_all_primary_sources', 'prune_platform_usage_snapshot',
      'prune_kill_switch_events', 'prune_status_snapshot'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_trending_24h',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_popularity_24h',
      'REFRESH MATERIALIZED VIEW public.homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.commons_active_threads',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.pipeline_runtime_stats_mv',
      'SELECT public.rebuild_entity_search_index()',
      'SELECT public.rebuild_all_primary_sources()',
      'SELECT public.prune_platform_usage_snapshot()',
      'SELECT public.prune_kill_switch_events()',
      'SELECT public.prune_status_snapshot()'
    ];
  ELSE  -- weekly (donation-derived)
    v_labels := ARRAY[
      'chord_industry_flows_mv', 'chord_donor_type_party_flows_mv',
      'chord_donor_state_party_flows_mv', 'chord_subject_party_flows_mv',
      'official_sector_dollars_mv', 'refresh_spending_totals'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_industry_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_type_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_state_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_subject_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_sector_dollars_mv',
      'SELECT public.refresh_spending_totals()'
    ];
  END IF;

  -- FIX-1152 — record the visibility map this run ran against.
  --
  -- A vacuum receipt is a RATE, not a reading: the search unit measured 202.5s
  -- (2026-09-02, 4h after a vacuum), 1017.4s / 1015.0s / 1012.0s on the three
  -- days after it, then 234.8s and 236.0s on the two days following the next
  -- one. Reconstructing which visibility-map state each of those ran against
  -- took a Cowork pass over pg_class every time, and pg_class only ever holds
  -- NOW -- the state at 06:00 three days ago is not recoverable from anything.
  -- So the run records it itself, and from here every unit_seconds reading is
  -- paired with the heap state that produced it.
  --
  -- entity_connections and financial_entities specifically: those are the two
  -- relations rebuild_entity_search_index scans, and the two whose all-visible
  -- fraction the FIX-884 index-only-scan degradation keys on.
  --
  -- Taken at RUN START rather than immediately before the search unit, which is
  -- both simpler and strictly more useful: neither relation is written by any
  -- of the eight units that precede it, so the value is the same, and taking it
  -- here means a run that dies BEFORE reaching the search unit still carries the
  -- reading -- which is exactly the 'partial' case this exists to explain.
  --
  -- Catalog-only: pg_class and pg_stat_user_tables, two index lookups each. It
  -- mirrors the vm[] shape check_rebuild_autovacuum_status() publishes (FIX-885)
  -- so both can be read with the same expression.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'relation',        t.relname,
           'relpages',        t.relpages,
           'relallvisible',   t.relallvisible,
           'pct_all_visible', CASE WHEN t.relpages > 0
                                   THEN round(100.0 * t.relallvisible / t.relpages, 1)
                                   ELSE 100.0 END,
           'n_dead_tup',      t.n_dead_tup,
           'n_live_tup',      t.n_live_tup,
           'last_vacuum',     t.last_vacuum,
           'last_autovacuum', t.last_autovacuum
         ) ORDER BY t.relname), '[]'::jsonb)
    INTO v_vm
    FROM (
      SELECT c.relname, c.relpages, c.relallvisible,
             s.n_dead_tup, s.n_live_tup, s.last_vacuum, s.last_autovacuum
      FROM pg_class c
      JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname IN ('entity_connections', 'financial_entities')
    ) t;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('refresh_derived_mvs', 'running', now(),
          jsonb_build_object('cadence', p_cadence,
                             'units', array_length(v_units, 1),
                             'budget_seconds', c_budget,
                             'unit_budget_seconds', c_unit_budget,
                             'vm_before', v_vm,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd   := v_units[i];
    v_label := v_labels[i];

    -- FIX-1021 PREDICTIVE budget check (FIX-944 idiom): stop when the slowest
    -- unit observed so far, plus 25% headroom, would not fit in what remains.
    -- Deliberately BETWEEN units — playbook C3, a REFRESH cannot be interrupted
    -- from inside.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_unit > 0 AND v_elapsed + (v_max_unit * 1.25) > c_budget THEN
      v_budget_hit := true;
      -- Everything from here on is skipped; name each one so the log says what
      -- is stale rather than just that something is.
      v_skipped := v_skipped || v_labels[i : array_length(v_labels, 1)];
      RAISE WARNING '[derived-mvs] budget guard — stopping before % (elapsed %s of %s budget, slowest unit %s); % unit(s) skipped',
        v_label, round(v_elapsed)::int, round(c_budget)::int, round(v_max_unit)::int,
        array_length(v_skipped, 1);
      EXIT;
    END IF;

    v_unit_beg := clock_timestamp();

    -- FIX-1030: publish the in-flight unit and COMMIT, so
    -- enforce_derived_mvs_unit_budget() — running in another session, on its
    -- own pg_cron cadence — can see WHICH unit is running, since when, and in
    -- which backend. Without this commit the watchdog sees nothing: everything
    -- this transaction writes is invisible to it until the unit ends, which is
    -- exactly the case it exists to handle.
    UPDATE public.data_sync_log
    SET metadata = metadata || jsonb_build_object(
                     'current_unit',            v_label,
                     'current_unit_index',      i,
                     'current_unit_started_at', v_unit_beg,
                     'backend_pid',             pg_backend_pid())
    WHERE id = v_log_id;
    COMMIT;

    BEGIN
      EXECUTE v_cmd;
      v_ok := v_ok + 1;
      RAISE NOTICE '  [derived-mvs] % — ok', v_label;
    EXCEPTION
      -- FIX-1021: query_canceled is NOT matched by OTHERS (PL/pgSQL trapping
      -- rules), and statement_timeout raises exactly that. Trapping it by name
      -- is the only way this procedure can close its own row. The docs' caution
      -- about swallowing user cancels is answered by the EXIT below: we stop the
      -- whole loop immediately and do nothing but bookkeeping afterwards, so a
      -- deliberate pg_cancel_backend still ends the run — it just ends it
      -- tidily instead of leaving a stranded 'running' row behind.
      -- FIX-1030: this is now also the landing point for the unit watchdog's
      -- cancel, which is why that watchdog needs no error path of its own.
      WHEN query_canceled THEN
        v_canceled := format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — CANCELED (statement_timeout, unit watchdog, or operator cancel): %', v_label, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — FAILED: %', v_label, SQLERRM;
    END;

    -- Timing is recorded for EVERY outcome (ok, failed, canceled) — a unit that
    -- died at 6 h is the single most interesting number in the run.
    v_unit_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_unit_beg));
    v_unit_times := v_unit_times || jsonb_build_object(v_label, round(v_unit_secs::numeric, 1));
    IF v_unit_secs > v_max_unit THEN
      v_max_unit := v_unit_secs;
    END IF;

    COMMIT;

    IF v_canceled IS NOT NULL THEN
      -- The timer that fired is disarmed once it has thrown, so the bookkeeping
      -- UPDATE below still runs. Continuing the loop would not: the next unit
      -- would be starting on a box that has already proven it cannot finish one.
      IF i < array_length(v_units, 1) THEN
        v_skipped := v_skipped || v_labels[i + 1 : array_length(v_labels, 1)];
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_status := CASE
                WHEN v_canceled IS NOT NULL THEN 'partial'
                WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                WHEN v_budget_hit THEN 'partial'
                ELSE 'complete'
              END;

  UPDATE public.data_sync_log
  SET status        = v_status,
      completed_at  = now(),
      rows_inserted = v_ok,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled mid-unit — %s; %s unit(s) skipped',
                                           v_canceled, COALESCE(array_length(v_skipped, 1), 0)), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_budget_hit
                          THEN left(format('budget exhausted after %ss of %ss — %s unit(s) skipped: %s',
                                           round(v_elapsed)::int, round(c_budget)::int,
                                           COALESCE(array_length(v_skipped, 1), 0),
                                           array_to_string(v_skipped, ', ')), 1000)
                        ELSE NULL
                      END,
      -- FIX-1030: strip the in-flight publish keys, so a terminal row never
      -- looks like it is mid-unit to the watchdog or to a human reading it.
      metadata      = (metadata
                        - 'current_unit' - 'current_unit_index'
                        - 'current_unit_started_at' - 'backend_pid')
                      || jsonb_build_object(
                        'units_ok', v_ok,
                        'unit_failures', COALESCE(array_length(v_failures, 1), 0),
                        'unit_seconds', v_unit_times,
                        'elapsed_seconds', round(v_elapsed::numeric, 1),
                        'slowest_unit_seconds', round(v_max_unit::numeric, 1),
                        'budget_hit', v_budget_hit,
                        'canceled', v_canceled IS NOT NULL,
                        'skipped_units', to_jsonb(v_skipped))
  WHERE id = v_log_id;

  RAISE NOTICE '[derived-mvs] % (cadence=%) — %/% units ok (% failures, % skipped, %ss elapsed)',
    upper(v_status), p_cadence, v_ok, array_length(v_units, 1),
    COALESCE(array_length(v_failures, 1), 0), COALESCE(array_length(v_skipped, 1), 0),
    round(v_elapsed)::int;

  -- FIX-1109 finding 1: a failed unit must fail the CALL.
  -- Until now this procedure returned normally on EVERY path, so a run whose
  -- own data_sync_log row said 'failed' was recorded by pg_cron as
  -- 'succeeded' (prod, jobid 10, 2026-08-25: runid 15272 succeeded / 1361.9s,
  -- while the sync row for the same run says failed on
  -- chord_donor_type_party_flows_mv). That hid the failure from
  -- cron.job_run_details, from check_cron_job_health() and from FIX-1073's
  -- escalation tiers -- every consumer that keys on pg_cron's own verdict.
  --
  -- Order matters: COMMIT makes the terminal row durable, and the advisory
  -- unlock is session-scoped (not transactional), so both survive the raise.
  -- Raising before either would roll the terminal UPDATE back and strand the
  -- lock, which is the failure mode this is meant to end, not start.
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  -- 'partial' deliberately does NOT raise: a budget stop and a watchdog cancel
  -- are this system's own decisions, already recorded in the row, and pg_cron
  -- should not be told that its job errored when the bound worked as designed.
  IF v_status = 'failed' THEN
    RAISE EXCEPTION '[derived-mvs] % of % unit(s) FAILED (cadence=%): %',
      COALESCE(array_length(v_failures, 1), 0), array_length(v_units, 1),
      p_cadence, array_to_string(v_failures, '; ');
  END IF;
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_official_donor_rollup_incremental
-- ───────────────────────────────────────────────────────────────────────
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
  v_horizon    timestamptz;   -- FIX-983
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
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
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

    -- FIX-983 — the head-lag horizon, applied to the sweep target the moment it
    -- is captured, so every downstream use (the dirty-set bound below, the
    -- per-chunk sweep_target, and the terminal watermark) inherits it.
    v_horizon := public.fr_watermark_horizon();
    v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

    -- FIX-983 invariant (c), FIX-1140 shape. The clamp can put the target at or
    -- below the watermark (the first minutes after a write burst, or after the
    -- lag GUC is raised). Floor it rather than returning early: the dirty
    -- predicate below is then empty BY CONSTRUCTION, the loop is a no-op, and
    -- the terminal write rewrites the SAME watermark — so the run still reports
    -- 'complete', which is what check_rollup_freshness() and canary-check.ts
    -- measure staleness from. An early return logging 'skipped' would have left
    -- that clock frozen through a legitimately caught-up stretch and paged on a
    -- healthy rollup (FIX-968's shape). GREATEST ignores NULLs, so bootstrap
    -- (v_watermark IS NULL) is unaffected.
    v_new_max := GREATEST(v_new_max, v_watermark);
  END IF;

  v_horizon := COALESCE(v_horizon, public.fr_watermark_horizon());

  -- FIX-970/FIX-1023 — the officials-only invariant, asserted on the
  -- per-recipient path too. Until now donor_rollup_bulk_assert_invariants() ran
  -- ONLY from donor_rollup_rebuild_bulk(), so the path that actually held
  -- jobid 24 was the one path with no guard: every dirty-set enumeration has
  -- been scoped to fr.to_type = 'official' since FIX-1018, which means a row
  -- an arm holds for a NON-official can never be refreshed again — it freezes
  -- and drifts silently. reconcile_donor_rollup_orphans() does not cover this
  -- class; it only removes recipients with no FR rows at all.
  -- Fresh sweeps only: the assert anti-joins all six arms, and a resume has
  -- already paid for it at the sweep that started.
  IF NOT v_resumed THEN
    PERFORM public.donor_rollup_bulk_assert_invariants();
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
        AND fr.updated_at >  v_watermark
        AND fr.updated_at <= v_new_max                                -- FIX-983
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
                'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
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

-- ───────────────────────────────────────────────────────────────────────
-- donor_rollup_rebuild_bulk
-- ───────────────────────────────────────────────────────────────────────
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


  SET work_mem = '256MB';

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
      SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag, et.display_label
      FROM public.entity_tags et
      WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
      ORDER BY et.entity_id, et.tag
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
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
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
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_donor_party_rollup_incremental
-- ───────────────────────────────────────────────────────────────────────
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


  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703):
  -- the CALL's statement_timeout is the postgres role default (6h) armed at
  -- CALL start — nothing in this body can change it. The budget guard below and
  -- the FIX-1063 watchdog are the real stops.
  SET work_mem = '256MB';

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
  v_mode := CASE
              WHEN v_watermark IS NULL     THEN 'bootstrap'
              WHEN v_lag > v_full_lag      THEN 'full'
              ELSE                              'crawl'
            END;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Staged full rebuild ═══════════════════════════════════════════════
    -- ONE set-based scan (the FIX-734 lesson) into a session temp stage, then
    -- 16 donor-id-windowed DELETE+INSERT applies with per-window COMMIT
    -- (FIX-703 bounded-txn discipline). Readers keep prior rows per un-applied
    -- window (complete-if-stale, never missing).
    --
    -- Cost is independent of the lag: ~350-420 s on prod regardless of how far
    -- behind the watermark is. That is why it is the right answer once the lag
    -- is large, and why a cancelled full rebuild does not ratchet — the next
    -- firing redoes the same ~350 s, not a bigger one.
    BEGIN
      DROP TABLE IF EXISTS dpr_stage;
      CREATE TEMP TABLE dpr_stage AS
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
        GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
      ),
      ind AS (
        SELECT DISTINCT ON (et.entity_id)
          et.entity_id,
          et.tag           AS industry_tag,
          et.display_label AS industry_label
        FROM public.entity_tags et
        WHERE et.entity_type  = 'financial_entity'
          AND et.tag_category = 'industry'
        ORDER BY et.entity_id, et.tag
      )
      SELECT
        a.donor_id, a.party_key, fe.display_name AS donor_name,
        fe.entity_type, ind.industry_tag, ind.industry_label,
        a.total_cents, a.tx_count
      FROM agg a
      LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
      LEFT JOIN ind                          ON ind.entity_id = a.donor_id;

      CREATE INDEX dpr_stage_idx ON dpr_stage (donor_id);
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level (temp table persists across COMMIT for the session)

    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
        BEGIN
          DELETE FROM public.donor_party_rollup_mv
           WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          INSERT INTO public.donor_party_rollup_mv (
            donor_id, party_key, donor_name, entity_type, industry_tag,
            industry_label, total_cents, tx_count
          )
          SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
                 industry_label, total_cents, tx_count
          FROM dpr_stage
          WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_rows := v_rows + v_n;
          RAISE NOTICE '  [donor-party-rollup] window %/16 — % rows', i, v_n;
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_failures := v_failures || format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;  -- top level, outside the EXCEPTION subtransaction
        -- FIX-1028 — the box has just proven it cannot finish one window; the
        -- remaining ones would each re-arm the same axe.
        EXIT WHEN v_canceled IS NOT NULL;
      END LOOP;
      v_units := 1;
    END IF;

    DROP TABLE IF EXISTS dpr_stage;
    COMMIT;

    -- The full rebuild recomputed EVERY donor, so on a clean finish the
    -- watermark can jump straight to the target captured before it started.
    -- FR writes that landed during the rebuild are strictly after v_target and
    -- are re-processed by the next firing's crawl, never silently consumed.
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_party_rollup_watermark',
              jsonb_build_object('last_indexed_at',
                COALESCE(v_target, public.fr_watermark_horizon())::text))   -- FIX-983
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = clock_timestamp();
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
                          THEN left(format('canceled — %s; every COMMITTED slice kept its watermark, the next firing resumes from it', v_canceled), 1000)
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
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_financial_entity_totals_incremental
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_financial_entity_totals_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_chunk     int    := 500;
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id    uuid;
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_horizon   timestamptz;   -- FIX-983
  v_dirty_from uuid[];
  v_dirty_to   uuid[];
  v_chunk     uuid[];
  v_n_from    int;
  v_n_to      int;
  v_i         int;
  v_lo        uuid;
  v_hi        uuid;
  v_rows      bigint := 0;
  v_rc        bigint := 0;   -- FIX-736: recipient_count rows written
  v_n         bigint;
  v_failures  text[] := ARRAY[]::text[];
  v_mode      text;
  i           int;
  v_canceled  text := NULL;                            -- FIX-1028
  v_started   timestamptz := clock_timestamp();        -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[fe-totals] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[fe-totals] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '128MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'financial_entity_totals_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  -- FIX-983 — the head-lag horizon, applied to the target BEFORE the dirty set
  -- is built (which is where this routine already captures it, for the sibling
  -- reason stated just above).
  v_horizon := public.fr_watermark_horizon();
  v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

  -- FIX-983 invariant (c), FIX-1140 shape — floor, do not return early. See the
  -- sibling comment in refresh_official_donor_rollup_incremental(): a 'skipped'
  -- terminal row does not reset check_rollup_freshness()'s clock, so a
  -- legitimately caught-up run must still report 'complete'. Flooring the
  -- target at the watermark empties the dirty predicate by construction and
  -- rewrites the same watermark. GREATEST ignores NULLs; bootstrap is
  -- unaffected.
  v_new_max := GREATEST(v_new_max, v_watermark);

  v_mode := CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END;

  IF v_watermark IS NOT NULL THEN
    SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty_from
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983

    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty_to
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983
  END IF;

  v_n_from := COALESCE(array_length(v_dirty_from, 1), 0);
  v_n_to   := COALESCE(array_length(v_dirty_to, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode,
                             'dirty_donors', v_n_from,
                             'dirty_recipients', v_n_to,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_watermark IS NULL THEN
    -- Bootstrap: 16-window full pass over both totals sides + recipient_count.
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
        v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
        v_rc   := v_rc   + public.financial_entity_recipient_count_window(v_lo, v_hi);  -- FIX-736
        RAISE NOTICE '  [fe-totals] bootstrap window %/16 — % totals rows, % rc rows so far', i, v_rows, v_rc;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;
  ELSE
    -- Incremental: chunk the dirty donor set (totals + recipient_count together),
    -- then the dirty recipient set (received totals).
    v_i := 1;
    WHILE v_i <= v_n_from LOOP
      v_chunk := v_dirty_from[v_i : LEAST(v_i + c_chunk - 1, v_n_from)];
      BEGIN
        v_n := public.financial_entity_donation_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
        v_n := public.financial_entity_recipient_count_rebuild(v_chunk);  -- FIX-736
        v_rc := v_rc + v_n;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;

    v_i := 1;
    WHILE v_i <= v_n_to AND v_canceled IS NULL LOOP
      v_chunk := v_dirty_to[v_i : LEAST(v_i + c_chunk - 1, v_n_to)];
      BEGIN
        v_n := public.financial_entity_received_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — a failed chunk/window's keys
  -- must stay in the next run's dirty set. FIX-1028 adds the cancel arm: a
  -- cancelled run has NOT covered its dirty set, so advancing here would
  -- permanently skip every key it did not reach.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('financial_entity_totals_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, v_horizon)::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows + v_rc,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; watermark unmoved, the whole dirty set is retried next run', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'recipient_count_updated', v_rc,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % totals rows, % recipient_count rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, v_rc, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_sector_affinity_from_tag_changes
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('sector_affinity_tag_refresh')::bigint;
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_chunk      constant int  := 500;   -- matches backfill_official_sector_affinity_rollup
  v_log_id     uuid;
  v_live_sig   text;
  v_stored_sig text;
  v_shadow_n   bigint;
  v_reason     text;
  v_donors     uuid[];
  v_n_donors   int;
  v_officials  uuid[];
  v_n_off      int := 0;
  v_chunk_ids  uuid[];
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text := NULL;
  -- FIX-979 — real entry time.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent sector-affinity tag refresh'));
    RAISE NOTICE '[sector-affinity tag refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[sector-affinity tag refresh] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '128MB';

  -- Signature FIRST, before any rebuild: tag writes that land mid-run make the
  -- NEXT run's live signature differ from what this run stores, so they are
  -- re-processed rather than silently absorbed — the FIX-704
  -- capture-watermark-before-dirty-set discipline, content-shaped.
  v_live_sig := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig' INTO v_stored_sig
    FROM public.pipeline_state WHERE key = c_sig_key;

  SELECT count(*) INTO v_shadow_n FROM public.donor_industry_tag_state;

  -- ── Path 1: no-op — identical content, zero rollup work ────────────────────
  IF v_stored_sig IS NOT NULL AND v_shadow_n > 0 AND v_live_sig = v_stored_sig THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
    VALUES ('sector_affinity_tag_refresh', 'complete', v_started, clock_timestamp(), 0,
            jsonb_build_object('path', 'noop',
                               'reason', 'industry tag content signature unchanged',
                               'sig', v_live_sig));
    RAISE NOTICE '[sector-affinity tag refresh] noop — signature unchanged (%)', v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 2: cold start / signature-store miss — the full backfill ──────────
  IF v_stored_sig IS NULL OR v_shadow_n = 0 THEN
    v_reason := CASE WHEN v_stored_sig IS NULL
                     THEN 'cold_start_no_signature'
                     ELSE 'signature_store_miss_empty_shadow' END;
    INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'running', v_started,
            jsonb_build_object('path', 'full_backfill', 'reason', v_reason))
    RETURNING id INTO v_log_id;
    COMMIT;

    -- Deliberately NOT wrapped in an EXCEPTION block: the nested procedure
    -- COMMITs per chunk, and transaction control is illegal inside a plpgsql
    -- EXCEPTION subtransaction. On failure the error propagates, the signature
    -- is never seeded, and the next run retries the cold path — fail-safe
    -- direction is REBUILD, same as the FIX-652 gate.
    --
    -- FIX-1028 NOTE: this path is therefore the one place in the sweep that
    -- CANNOT carry a query_canceled handler — the language forbids it. A cancel
    -- inside the cold-start backfill still strands the running row for the
    -- reaper. That is a structural consequence of CALLing a COMMITting
    -- procedure, not an oversight; the fix would be to inline the backfill's
    -- chunk loop here, which is out of scope for this sweep. Path 3 below (the
    -- steady-state path, and the only one a scheduled firing takes once the
    -- signature store is warm) IS protected.
    CALL public.backfill_official_sector_affinity_rollup();

    DELETE FROM public.donor_industry_tag_state;
    INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
    SELECT et.entity_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)),
           count(*)::int,
           clock_timestamp()   -- FIX-981: after the backfill's per-chunk COMMITs
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

    UPDATE public.data_sync_log
       SET status = 'complete', completed_at = clock_timestamp(),
           metadata = metadata || jsonb_build_object(
             'sig', v_live_sig,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;

    RAISE NOTICE '[sector-affinity tag refresh] full backfill (%) — signature store seeded (%)',
      v_reason, v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 3: targeted — diff the per-donor shadow, rebuild only the affected ─
  WITH cur AS (
    SELECT et.entity_id AS donor_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)) AS sig,
           count(*)::int AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT array_agg(donor_id) INTO v_donors
    FROM (
      SELECT COALESCE(c.donor_id, s.donor_id) AS donor_id
        FROM cur c
        FULL OUTER JOIN public.donor_industry_tag_state s ON s.donor_id = c.donor_id
       WHERE c.donor_id IS NULL                       -- tags removed entirely
          OR s.donor_id IS NULL                       -- newly tagged donor
          OR c.sig IS DISTINCT FROM s.tag_sig
          OR c.n   IS DISTINCT FROM s.tag_count
    ) d;

  v_n_donors := COALESCE(array_length(v_donors, 1), 0);

  -- v_n_donors = 0 with a moved global signature means tags changed between the
  -- signature capture and this diff (the shadow was already advanced past the
  -- captured signature by content that arrived mid-scan). Nothing to rebuild
  -- for THIS signature; the newer content re-diffs on the next run. Advance and
  -- log donors_changed=0 — self-healing by construction.
  IF v_n_donors > 0 THEN
    SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
      FROM unnest(v_donors) AS d(id)
      JOIN public.financial_relationships fr ON fr.from_id = d.id
     WHERE fr.relationship_type = 'donation'
       AND fr.from_type = 'financial_entity'
       AND fr.to_type   = 'official'
       AND fr.amount_cents > 0;
    v_n_off := COALESCE(array_length(v_officials, 1), 0);
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('sector_affinity_tag_refresh', 'running', v_started,
          jsonb_build_object('path', 'targeted',
                             'reason', 'industry tag content signature changed',
                             'donors_changed', v_n_donors,
                             'officials_affected', v_n_off,
                             'sig_before', v_stored_sig,
                             'sig_after', v_live_sig))
  RETURNING id INTO v_log_id;
  COMMIT;

  WHILE v_i <= v_n_off LOOP
    v_chunk_ids := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n_off)];
    v_chunk_no  := v_chunk_no + 1;
    BEGIN
      v_n    := public.sector_affinity_rebuild_officials(v_chunk_ids);
      v_rows := v_rows + v_n;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its officials keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced signature re-derives
      -- the same diff next run.
      v_failures := v_failures || format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction (PL/pgSQL rule)
    -- FIX-1028 — stop the sweep; the remaining chunks would each re-arm the
    -- same axe, and the signature advance below is gated so the un-covered
    -- officials stay in the next run's diff.
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- Advance shadow + signature only on a clean run. FIX-1028 adds the cancel
  -- arm: a cancelled run did not rebuild every affected official, so storing
  -- the new signature would drop the remainder out of the next run's diff
  -- forever.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    IF v_n_donors > 0 THEN
      DELETE FROM public.donor_industry_tag_state s
       WHERE s.donor_id = ANY (v_donors)
         AND NOT EXISTS (
           SELECT 1 FROM public.entity_tags et
            WHERE et.entity_type  = 'financial_entity'
              AND et.tag_category = 'industry'
              AND et.entity_id    = s.donor_id);

      INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
      SELECT et.entity_id,
             md5(string_agg(et.tag, ',' ORDER BY et.tag)),
             count(*)::int,
             clock_timestamp()   -- FIX-981: after the chunk loop's COMMITs
        FROM unnest(v_donors) AS d(id)
        JOIN public.entity_tags et ON et.entity_id = d.id
       WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
       GROUP BY et.entity_id
      ON CONFLICT (donor_id) DO UPDATE
        SET tag_sig = EXCLUDED.tag_sig,
            tag_count = EXCLUDED.tag_count,
            updated_at = clock_timestamp();
    END IF;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
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
                             THEN left(format('canceled — %s; signature unmoved, the remaining officials stay in the next diff', v_canceled), 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL
                         END,
         metadata      = metadata || jsonb_build_object(
                           'rollup_rows', v_rows,
                           'chunks', v_chunk_no,
                           'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                           'canceled', v_canceled IS NOT NULL,
                           'cancel_detail', v_canceled,
                           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[sector-affinity tag refresh] % — % donor(s) changed, % official(s) in % chunk(s), % rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_donors, v_n_off, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_treemap_individuals_global
-- ───────────────────────────────────────────────────────────────────────
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
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_agency_staffing_rollup
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_agency_staffing_rollup()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint   := hashtext('agency_staffing_rollup_refresh')::bigint;
  c_chunk    int      := 50;
  -- Past this lag the dirty set stops being a saving and the full pass is the
  -- simpler, bounded answer. Mirrors donor-party's full_rebuild_lag_days.
  c_full_lag interval := interval '14 days';
  v_state    jsonb;
  v_w_fr     timestamptz;
  v_w_ec     timestamptz;
  v_h        timestamptz;
  v_mode     text;
  v_fr_dirty uuid[];
  v_ec_dirty uuid[];
  v_n_fr     int := 0;
  v_n_ec     int := 0;
  v_agencies uuid[];
  v_chunk    uuid[];
  v_n        int;
  v_i        int := 1;
  v_chunk_no int := 0;
  v_rows     bigint := 0;
  v_n_ins    bigint;
  -- FIX-979: survives the per-chunk COMMITs; now() would not.
  v_started  timestamptz := clock_timestamp();
  -- FIX-1028/1108: non-NULL once a query_canceled (57014) has been caught.
  v_canceled text := NULL;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[agency-staffing refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('agency_staffing_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[agency-staffing refresh] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '128MB';

  -- ── Mode, O(1) ─────────────────────────────────────────────────────────────
  SELECT value INTO v_state
    FROM public.pipeline_state WHERE key = 'agency_staffing_watermark';

  v_w_fr := (v_state->>'fr_last_indexed_at')::timestamptz;
  v_w_ec := (v_state->>'ec_last_indexed_at')::timestamptz;

  -- FIX-983 — the head-lag horizon. Nothing stamped inside the last
  -- civitics.watermark_lag_seconds is read yet, on either side.
  v_h := public.fr_watermark_horizon();

  v_mode := CASE
              WHEN v_w_fr IS NULL OR v_w_ec IS NULL THEN 'full'
              WHEN v_h - v_w_fr > c_full_lag        THEN 'full'
              ELSE                                       'incremental'
            END;

  IF v_mode = 'full' THEN
    -- ═══ FULL / BOOTSTRAP — today's behaviour, unchanged ═════════════════════
    SELECT array_agg(id ORDER BY id) INTO v_agencies FROM public.agencies;
  ELSE
    -- ═══ INCREMENTAL ═════════════════════════════════════════════════════════
    -- Never let the horizon pull a watermark backwards (FIX-983 invariant (c)).
    -- When it would, the two predicates below collapse to empty and the run is
    -- a clean no-op that rewrites the SAME watermark.
    v_h := GREATEST(v_h, v_w_fr, v_w_ec);

    -- FR side. `from_type = 'agency'` is deliberately NOT in this predicate:
    -- with it the planner BitmapANDs financial_relationships_from
    -- (from_type='agency' → 3.9M rows, 1.9 s, 7,083 buffers) against the range,
    -- for no gain. Without it the range rides
    -- financial_relationships_contract_grant_updated_at alone and the
    -- ∩ agencies below removes anything that is not an agency. Dropping a
    -- filter can only WIDEN a dirty set, and a wider dirty set is still exact
    -- here because the worker recomputes each agency from full history.
    SELECT array_agg(DISTINCT fr.from_id) INTO v_fr_dirty
      FROM public.financial_relationships fr
     WHERE fr.relationship_type IN ('contract', 'grant')
       AND fr.updated_at >  v_w_fr
       AND fr.updated_at <= v_h;

    -- EC side. 8,081 appointment→agency edges in total, so this stays cheap
    -- however the planner drives it.
    SELECT array_agg(DISTINCT ec.to_id) INTO v_ec_dirty
      FROM public.entity_connections ec
     WHERE ec.connection_type = 'appointment'
       AND ec.to_type         = 'agency'
       AND ec.derived_at >  v_w_ec
       AND ec.derived_at <= v_h;

    v_n_fr := COALESCE(array_length(v_fr_dirty, 1), 0);
    v_n_ec := COALESCE(array_length(v_ec_dirty, 1), 0);

    -- (FR ∪ EC) ∩ agencies, plus any agency that has no rollup row yet — the
    -- latter is what keeps incremental mode's output identical to full mode's.
    SELECT array_agg(a.id ORDER BY a.id) INTO v_agencies
      FROM public.agencies a
     WHERE a.id = ANY (COALESCE(v_fr_dirty, ARRAY[]::uuid[]))
        OR a.id = ANY (COALESCE(v_ec_dirty, ARRAY[]::uuid[]))
        OR NOT EXISTS (SELECT 1 FROM public.agency_staffing_rollup r
                        WHERE r.agency_id = a.id);
  END IF;

  v_n := COALESCE(array_length(v_agencies, 1), 0);

  RAISE NOTICE '[agency-staffing refresh] mode=% — % agencies to rebuild (fr-dirty %, ec-dirty %)',
    v_mode, v_n, v_n_fr, v_n_ec;

  WHILE v_i <= v_n LOOP
    v_chunk    := v_agencies[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    BEGIN
      v_n_ins := public.agency_staffing_rebuild_agencies(v_chunk);
      v_rows  := v_rows + v_n_ins;
    EXCEPTION
    -- ONLY query_canceled. No WHEN OTHERS — this loop had no handler at all
    -- before, and every other error must keep propagating out of the procedure
    -- exactly as it does today.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (agencies %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n), SQLERRM);
      RAISE WARNING '[agency-staffing refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- ── The watermarks, once, for the whole run ────────────────────────────────
  -- Advanced ONLY on a run that reached the end of its dirty set. A cancelled
  -- run has NOT covered its set, so advancing here would permanently skip every
  -- agency it did not reach — the FIX-1028 rule. Both sides move to the same
  -- horizon: they were computed against it, together.
  IF v_canceled IS NULL THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('agency_staffing_watermark',
            jsonb_build_object('fr_last_indexed_at', v_h::text,
                               'ec_last_indexed_at', v_h::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  -- Reached on a cancel now, instead of being jumped over. Every chunk that
  -- COMMITted is real work and is reported; the rollup is per-agency, so a
  -- partial pass leaves the un-reached agencies on their PRIOR rows
  -- (complete-if-stale) and the next firing redoes the whole dirty set.
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, error_message, metadata)
  VALUES ('agency_staffing_rollup_refresh',
          CASE WHEN v_canceled IS NOT NULL THEN 'partial' ELSE 'complete' END,
          v_started, clock_timestamp(), v_rows,
          CASE WHEN v_canceled IS NOT NULL
               THEN left(format('canceled — %s', v_canceled), 1000) ELSE NULL END,
          jsonb_build_object(
            'agencies', v_n, 'chunks', v_chunk_no, 'source', 'pg_cron/backfill',
            'mode', v_mode,                       -- FIX-987
            'dirty_fr', v_n_fr,                   -- FIX-987
            'dirty_ec', v_n_ec,                   -- FIX-987
            'agencies_rebuilt', v_rows,           -- FIX-987
            'watermark_before_fr', v_w_fr,        -- FIX-987
            'watermark_before_ec', v_w_ec,        -- FIX-987
            'horizon', v_h,                       -- FIX-983/987
            'canceled', v_canceled IS NOT NULL,
            'cancel_detail', v_canceled,
            'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int));

  RAISE NOTICE '[agency-staffing refresh] % (mode=%) — % agencies in % chunks',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED' ELSE 'complete' END,
    v_mode, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- run_group_donor_rollup_refresh
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_group_donor_rollup_refresh()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_result  jsonb;
BEGIN
  -- Session-scoped guard, not transaction-scoped: this procedure is CALLed, so
  -- if pg_cron ever queues a firing behind an overrunning one (which it does —
  -- it queues rather than skips), the second must decline rather than run a
  -- second full DELETE + re-INSERT concurrently with the first.
  IF NOT pg_try_advisory_xact_lock(hashtext('group_donor_rollup_refresh')::bigint) THEN
    RAISE NOTICE '[group-donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('group_donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[group-donor-rollup] prod session held — skipping (FIX-950)';
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
    RETURN;
  END IF;


  SELECT public.refresh_group_donor_rollup() INTO v_result;

  -- `source: pg_cron` is load-bearing, not decoration: it is what
  -- list_scheduled_rollup_pipelines() reads to classify the driver and to
  -- correlate this pipeline to its cron job. The correlation is BY NAME via
  -- replace(jobname, '-', '_'), so the pipeline string below and the jobname in
  -- section 2 must stay in lockstep: 'group-donor-rollup-refresh' <->
  -- 'group_donor_rollup_refresh'. 'complete' is likewise the only status
  -- check_rollup_freshness counts (FIX-1140) — a non-complete row freezes the
  -- freshness clock rather than advancing it.
  INSERT INTO public.data_sync_log
    (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES (
    'group_donor_rollup_refresh',
    'complete',
    v_started,
    clock_timestamp(),
    COALESCE((v_result->>'donor_rows')::bigint, 0),
    jsonb_build_object(
      'source',      'pg_cron',
      'cohorts',     v_result->'cohorts',
      'donor_rows',  v_result->'donor_rows',
      'refreshed_at', v_result->'refreshed_at'));

  RAISE NOTICE '[group-donor-rollup] complete — %', v_result;
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- refresh_contract_flow_rollups
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
  -- FIX-979: real entry time. Single-transaction procedure, so now() would in
  -- fact be correct here — the variable is used anyway so all three writers
  -- carry one greppable pattern.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('contract_flow_rollups_rebuild')::bigint) THEN
    RAISE NOTICE '[contract-flow rollups] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('contract_flow_rollups_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[contract-flow rollups] prod session held — skipping (FIX-950)';
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
    RETURN;
  END IF;


  SET work_mem = '256MB';

  -- Recipient rollup: top-500 recipients — byte-identical to
  -- treemap_recipients_by_contracts_full(500). One deterministic industry per
  -- recipient (FIX-873) → 500 distinct entity_ids, no fan-out.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  WITH recipient_industry AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    COALESCE(ri.tag, 'Other'),
    MIN(fr.metadata->>'naics_code'),
    SUM(fr.amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, ri.tag
  ORDER BY SUM(fr.amount_cents) DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.tag,
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture'
          WHEN '21' THEN 'Mining'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Retail'
          WHEN '45' THEN 'Retail'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Information Technology'
          WHEN '52' THEN 'Finance'
          WHEN '54' THEN 'Professional Services'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Healthcare'
          WHEN '71' THEN 'Arts & Entertainment'
          WHEN '72' THEN 'Hospitality'
          WHEN '81' THEN 'Other Services'
          WHEN '92' THEN 'Government'
          ELSE 'Other'
        END,
        'Other'
      )                                               AS sector,
      fr.amount_cents
    FROM public.financial_relationships fr
    JOIN public.agencies a
      ON a.id = fr.from_id AND fr.from_type = 'agency'
    LEFT JOIN public.financial_entities fe
      ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
    LEFT JOIN recipient_industry ri
      ON ri.entity_id = fe.id
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
  )
  SELECT
    agency_id,
    agency_name,
    agency_acronym,
    sector,
    SUM(amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector;
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  -- FIX-979: clock_timestamp(), not now(). runid 130 ran 7,125.6 s and reported
  -- 0.000000 because both columns were the same frozen transaction_timestamp().
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'complete', v_started, clock_timestamp(),
          v_recipients + v_flows,
          jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows));

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$procedure$
;
