-- =============================================================================
-- FIX-1311 (cc-232) — park the 18 derived-layer pg_cron jobs for the dispatcher
-- cutover. Each returns only through a job_registry row with a real deadline
-- rule; the 20 plumbing jobs stay on.
--
-- THE DECISION (Craig, Mon 2026-10-12 ~20:20 PDT): the dispatcher migrates from
-- ZERO, not beside cron. Every derived-layer pg_cron job is parked now
-- (active := false, by NAME), R1/R2 land onto a quiet box, and each job comes
-- back only through a registry row with a deadline rule (stale_after / by /
-- dead_tuples) — one return, one receipt. Derived data (money rollups, crawls,
-- tags, derived MVs) goes stale for a week-plus; that cost is accepted. It buys
-- a clean s6 proving week, no dual-owner period per job, and it takes the two
-- Tuesday weeklies that wedged the box twice in seven days (jobid 10
-- refresh-derived-mvs-weekly, Tue 00:47Z 10-13; jobid 12 rule-taggers-weekly's
-- lineage, 10-06) OFF until they return behind box_is_saturated().
--
-- PARKED (18, CALL jobs — every one read ACTIVE on prod 2026-10-13 23:14Z):
--   ec-crawl, fe-crawl, donor-rollup-refresh, donor-party-rollup-refresh,
--   treemap-individuals-global-refresh, contract-flow-rollups-refresh,
--   agency-staffing-rollup-refresh, group-donor-rollup-refresh,
--   fe-inbound-rollup-refresh, rule-taggers-daily, rule-taggers-weekly,
--   refresh-derived-mvs-daily, refresh-derived-mvs-weekly,
--   financial-entity-totals-reconcile, donation-edge-orphan-sweep,
--   donor-party-rollup-orphan-sweep, donor-rollup-orphan-sweep,
--   entity-connection-stats-orphan-sweep
--
-- KEPT ON (20, the plumbing — not touched here):
--   box-health-probe (the dispatcher reads box_is_saturated() off its stamp),
--   cron-job-budget-watchdog, derived-mvs-unit-watchdog,
--   dpr-, ec-, ecs-, fe-, fr-, odbt-, odr-mv-, odt-, officials-, osar-, osdr-,
--   treemap-individuals-, xsr-vacuum-analyze, vm-probe-pre-ec,
--   abuse-events-retention, cron-job-run-details-retention,
--   platform-counts-daily
--
-- NOT NAMED by cc-232 and left exactly as they are (all ACTIVE on prod at the
-- 23:14Z read): vm-probe-pre-fe, vm-probe-pre-fr, vote-stats-refresh,
-- votes-vacuum-analyze. The four already-inactive jobs
-- (entity-connection-stats-rebuild, financial-entity-totals-incremental,
-- rebuild-ec-incremental, rebuild-ec-incremental-mon) are not touched either.
--
-- SHAPE.
--   * By NAME, never by jobid (FIX-946): the jobid is resolved in-statement
--     from cron.job.jobname. A missing or duplicated name RAISEs, so a typo
--     cannot silently park nothing. A name already inactive is a no-op, so the
--     file is idempotent (the clone runs it twice — cc-232 D5).
--   * Park, don't unschedule (D2): active := false keeps the row, the schedule
--     and the jobid. The return is a registry UPDATE plus, eventually, R1b's
--     cron.unschedule — never a re-schedule that mints a new jobid.
--   * The FIX-1059 hold rows ride the same statement (D3), so the park and the
--     canary's knowledge of it commit together. rollup_watch_overrides keys on
--     the DERIVED PIPELINE, not the jobname; the pipeline per job is
--     Q_CRON_JOB_PIPELINES' derivation (packages/data/src/lib/cron-job-pipelines.ts)
--     read on prod at 23:2xZ. Two job pairs share a pipeline (rule-taggers-daily
--     /-weekly → run_rule_taggers; refresh-derived-mvs-daily/-weekly →
--     refresh_derived_mvs), so 18 jobs are 16 hold rows. A held pipeline gets
--     NULL report/escalate thresholds in list_scheduled_rollup_pipelines() and
--     reads 'held' in check_rollup_freshness(): listed, never alerted.
--   * THE SESSION-HOLD COLLISION. This file lands through a gated push, which
--     CLAIMS a FIX-950 session, and claimProdSession() upserts a hold for every
--     guarded pipeline BEFORE the migration runs — all 16 of these among them.
--     A plain ON CONFLICT DO NOTHING would therefore insert nothing, and the
--     release's clearGuardedHolds() would then clear and garbage-collect those
--     session rows: the park would land with ZERO hold rows. So a conflicting
--     row that is the session's own machinery (note = SESSION_HOLD_NOTE, no
--     cadence, not retired — the exact rows clearGuardedHolds() would delete)
--     is taken over: it gets this hold_reason and this note, which neither the
--     release's UPDATE (hold_reason LIKE 'prod session held: %') nor its DELETE
--     (note = SESSION_HOLD_NOTE) matches. Any OTHER existing row is a human
--     declaration and is never overwritten; the guard at the end RAISEs on it
--     instead (cc-232 read 2's STOP, enforced at apply time). A re-run finds
--     its own rows and changes nothing. The literal is pinned to
--     prod-session.ts' SESSION_HOLD_NOTE by fix1311-park-derived-layer.test.ts.
--   * No cron_job_budget change: the budget rows stay, inert for an inactive
--     job, and the registry owns them later. No proconfig, no SET — this is a
--     DO block, not a routine (FIX-1128).
--
-- ROLLBACK: scripts/fix1311-unpark-derived-layer-crons.sql — the mirror
-- (active := true by name, and the 16 hold rows deleted by their hold_reason).
-- It is a db-query --call payload, NOT a migration, and is named in
-- docs/cc/projects/dispatcher.md s16.
-- =============================================================================

DO $$
DECLARE
  c_reason CONSTANT text :=
    'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  -- packages/data/src/lib/prod-session.ts SESSION_HOLD_NOTE, verbatim.
  c_session_note CONSTANT text :=
    'FIX-1177/1172 — set by claimProdSession(); cleared by release(); '
    'a row with this note and no hold is inert';
  -- The 18 jobs and their derived pipelines, position for position.
  c_jobs CONSTANT text[] := ARRAY[
    'ec-crawl',
    'fe-crawl',
    'donor-rollup-refresh',
    'donor-party-rollup-refresh',
    'treemap-individuals-global-refresh',
    'contract-flow-rollups-refresh',
    'agency-staffing-rollup-refresh',
    'group-donor-rollup-refresh',
    'fe-inbound-rollup-refresh',
    'rule-taggers-daily',
    'rule-taggers-weekly',
    'refresh-derived-mvs-daily',
    'refresh-derived-mvs-weekly',
    'financial-entity-totals-reconcile',
    'donation-edge-orphan-sweep',
    'donor-party-rollup-orphan-sweep',
    'donor-rollup-orphan-sweep',
    'entity-connection-stats-orphan-sweep'
  ];
  c_pipes CONSTANT text[] := ARRAY[
    'entity_connections_rebuild',
    'financial_entity_totals_refresh',
    'donor_rollup_refresh',
    'donor_party_rollup_refresh',
    'treemap_individuals_global_refresh',
    'contract_flow_rollups_rebuild',
    'agency_staffing_rollup_refresh',
    'group_donor_rollup_refresh',
    'financial_entity_inbound_rollup',
    'run_rule_taggers',
    'run_rule_taggers',
    'refresh_derived_mvs',
    'refresh_derived_mvs',
    'financial_entity_totals_reconcile',
    'donation_edge_orphan_sweep',
    'donor_party_rollup_orphan_sweep',
    'donor_rollup_orphan_sweep',
    'entity_connection_stats_orphan_sweep'
  ];
  v_name    text;
  v_n       int;
  v_jobid   bigint;
  v_active  boolean;
  v_parked  int := 0;
  v_already int := 0;
  v_rows    int;
  v_bad     text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1311] pg_cron absent — nothing to park';
    RETURN;
  END IF;

  IF cardinality(c_jobs) <> 18 OR cardinality(c_pipes) <> 18 THEN
    RAISE EXCEPTION '[fix1311] park list is % jobs / % pipelines, expected 18 / 18',
      cardinality(c_jobs), cardinality(c_pipes);
  END IF;

  -- 1. Park, by name.
  FOREACH v_name IN ARRAY c_jobs LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1311] % cron.job rows named % — expected exactly 1; refusing to park by a name that does not resolve',
        v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := false);
      v_parked := v_parked + 1;
      RAISE NOTICE '[fix1311] parked % (jobid %)', v_name, v_jobid;
    ELSE
      v_already := v_already + 1;
      RAISE NOTICE '[fix1311] % (jobid %) already inactive — no-op', v_name, v_jobid;
    END IF;
  END LOOP;

  -- 2. One FIX-1059 hold row per derived pipeline, in the same statement.
  INSERT INTO public.rollup_watch_overrides AS o (pipeline, held_since, hold_reason, note)
  SELECT p.pipeline,
         now(),
         c_reason,
         format('FIX-1311 (cc-232) — pg_cron %s parked (active = false) by migration '
                '20261013230000 for the dispatcher cutover. Returns only through a '
                'job_registry row with a deadline rule; that return deletes this row. '
                'Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.',
                string_agg(p.jobname, ' + ' ORDER BY p.jobname))
  FROM unnest(c_jobs, c_pipes) AS p(jobname, pipeline)
  GROUP BY p.pipeline
  ON CONFLICT (pipeline) DO UPDATE
    SET held_since  = EXCLUDED.held_since,
        hold_reason = EXCLUDED.hold_reason,
        note        = EXCLUDED.note,
        updated_at  = now()
    WHERE o.note = c_session_note
      AND o.retired_at    IS NULL
      AND o.cadence_hours IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- 3. Guard: every parked pipeline now carries THIS hold. Anything else is a
  --    human declaration this file refused to overwrite.
  SELECT string_agg(format('%s (row %s, hold_reason %L, retired_at %s)',
                           d.pipeline,
                           CASE WHEN o.pipeline IS NULL THEN 'absent' ELSE 'present' END,
                           o.hold_reason, o.retired_at), '; ' ORDER BY d.pipeline)
    INTO v_bad
  FROM (SELECT DISTINCT pipeline FROM unnest(c_pipes) AS t(pipeline)) d
  LEFT JOIN public.rollup_watch_overrides o ON o.pipeline = d.pipeline
  WHERE o.hold_reason IS DISTINCT FROM c_reason;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1311] a parked pipeline is already declared by someone else — not overwriting: %', v_bad;
  END IF;

  RAISE NOTICE '[fix1311] % job(s) parked, % already inactive; % hold row(s) written or taken over, 16 pipelines held',
    v_parked, v_already, v_rows;
END $$;
