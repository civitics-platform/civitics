-- =============================================================================
-- FIX-1396 — MOVE the last eight cron vacuums to the dispatcher. cc-267,
-- 2026-11-11. Class P: eight job_registry UPDATEs and eight cron.alter_job.
--
--   officials-vacuum-analyze            at 30 1 * * 1      → dead_tuples > 60% of trigger + floor 7 days
--   odr-mv-vacuum-analyze               at 5 11,17 * * *   → dead_tuples > 60% of trigger + floor 24 hours
--   treemap-individuals-vacuum-analyze  at 10 11,17 * * *  → (the same daily rule)
--   odt-vacuum-analyze                  at 12 11,17 * * *  → …
--   osdr-vacuum-analyze                 at 14 11,17 * * *  → …
--   osar-vacuum-analyze                 at 16 11,17 * * *  → …
--   odbt-vacuum-analyze                 at 18 11,17 * * *  → …
--   ecs-vacuum-analyze                  at 20 11,17 * * *  → …
--
-- every row gates {prod_session}, phase_lock false, phase_due_at NULL; cap 64,
-- budget NULL, priority 4, cost_class io, unit_shape bare and the exclusion
-- groups (officials / rollups ×6 / ec) unchanged. After it the cutover's
-- dispatchable remainder is zero; R1b (FIX-1309: cron_job_budget → VIEW,
-- cron.unschedule) is the one step left. Registry eligible 27 → 35.
--
-- DESIGN: cc-prompt-267 D1–D7 (Craig 11-07 00:26 PST "recs good — go").
-- The shape is fix1366's (20261030001000_fix1366_move_dpr_vacuum_analyze.sql)
-- ×8: per row, the UPDATE matched on its exact old `at …` text (a second run
-- NOTICEs "already moved"; anything else RAISEs), then the park by NAME
-- (FIX-946: exactly one cron.job row or RAISE; active → cron.alter_job(job_id
-- := v_jobid, active := false); already inactive → NOTICE; never
-- cron.unschedule). One read-back at the end.
--
-- WHY ONE RULE FOR THE SEVEN (D1, D2). The MV series vacuumed on a clock
-- twice a day (11:xx / 17:xx) whether or not a refresh had dirtied the table;
-- 0.14–1.63 s p50. Under the dispatcher a table under its 60 % line is not
-- due, and the 24-hour floor keeps the old cadence's upper bound. The same
-- rule as ec-vacuum-analyze (fix1349) and entity-tags-vacuum-analyze
-- (fix1381), without their phase_lock: nothing here needs a fixed slot.
-- officials (D3) takes fix1335 / fix1366's weekly shape verbatim; the grammar
-- has no bare-floor form (20261029000000 :754-758) and none is added.
--
-- MEASUREMENT (prod, cc-267 read 2, 2026-11-11 00:10Z; pg_stat_* since the
-- 11-05 01:59:17Z restart; GUCs autovacuum_vacuum_threshold 50,
-- autovacuum_vacuum_scale_factor 0.2; the trigger reads reloptions first):
--
--   table                            reltuples   trigger  60% line  n_dead  cron (14 d)
--   public.officials                    39,360     1,000       600       0  jobid 39  2×  3.53 / 3.59 s
--   public.official_donor_rollup_mv    664,665    33,283    19,970       0  jobid 32 28×  p50 1.49 max 27.70 s
--   public.treemap_individuals_rollup 1,249,956   62,548    37,529   3,071  jobid 33 28×  p50 0.59 max 3.10 s
--   public.official_donor_totals         7,521       426       256       0  jobid 34 28×  p50 0.16 max 0.34 s
--   public.official_small_dollar_rollup  7,531       427       256       0  jobid 35 28×  p50 0.14 max 0.21 s
--   public.official_sector_affinity_rollup 25,727  1,336       802       0  jobid 36 28×  p50 0.31 max 0.38 s
--   public.official_donor_bracket_totals 20,541     1,077       646       0  jobid 37 28×  p50 0.26 max 0.35 s
--   public.entity_connection_stats_mv 4,927,986   246,450   147,870     143  jobid 47 28×  p50 1.63 max 40.11 s
--
--   officials reads reloptions {autovacuum_vacuum_threshold=1000,
--   autovacuum_vacuum_scale_factor=0.0} (rule 341: a threshold-only trigger);
--   the other seven {autovacuum_vacuum_scale_factor=0.05}. officials
--   autovacuums on its own: autovacuum_count 51 since the restart (~8.6/day),
--   last 2026-11-10 21:11:09Z; its cron VACUUM last ran 11-09 01:30:00Z. The
--   floor anchors on GREATEST(last_vacuum, last_autovacuum, the newest reaped
--   succeeded tick), so autovacuum keeps resetting it: the pct term (600) is
--   the one that will arm this row, and the floor is the backstop.
--   ecs has never autovacuumed (autovacuum_count 0): the cron was its only
--   owner. None of the eight had a failure in 14 d.
--
-- WHAT THE EIGHT WAIT ON (read 3; rule 410's first-reason order). The six
-- rollups-group rows queue behind the group's live unit (donor-rollup-
-- refresh, the weekly refreshes, the sweeps) and the FIX-1322 io cap's one
-- VACUUM at a time; ecs behind ec-crawl / ec-vacuum-analyze in group ec;
-- officials alone in group officials. Nothing waits on them: no row yields to
-- a vacuum, and a bare VACUUM holds no advisory lock.
--
-- READERS (D6, read 4) — none goes red or NULL on a parked cron: the receipts
-- render it `inactive` (fr / dpr precedent); prod_op_gate's (b) loop marks a
-- {prod_session}-gated non-`at` row `dispatched` and skips its slot;
-- remediation-manifest prints `<schedule> [INACTIVE]` for officials as it does
-- for fr / ec / fe; check-job-registry reads the fence's `at` → `dead_tuples`
-- as RETURNED and each UPDATE below names its job for the gates column.
-- No rollup_watch_overrides row is involved, so no session-hold guard.
--
-- NETS: platform_dials.pause; the box skip (io: rung included); the
-- prod_session gate; the io cap; the groups; the postgres role's 3 h
-- statement_timeout as a bare VACUUM's only in-backend bound (no
-- cron_job_budget row, rule 313). Autovacuum stays on at the tuned triggers.
--
-- HISTORY (D5). fix1335 :305-314, fix1349 :295-304 and fix1366 :220-225
-- assert officials-vacuum-analyze on `at 30 1 * * 1` with an active cron.
-- They are history; the clone tests that read or re-apply them read the move
-- through MOVED_LINEAGE (packages/data/src/__tests__/lib/migration-text.ts).
--
-- ROLLBACK (data): scripts/fix1396-revert-move-officials-mv-vacuums.sql, a
-- --call payload: the eight rows back to their `at` text, gates '{}',
-- phase_lock false, phase_due_at NULL, the eight crons RE-ACTIVATED by name.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) officials-vacuum-analyze — weekly
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 30 1 * * 1; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'officials-vacuum-analyze'
     AND deadline_rule = 'at 30 1 * * 1';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] officials-vacuum-analyze: at 30 1 * * 1 → dead_tuples > 60%% of trigger + floor 7 days (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'officials-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 7 days' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] officials-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] officials-vacuum-analyze reads % / gates %, expected at 30 1 * * 1 or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'officials-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named officials-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'officials-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron officials-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron officials-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (2) odr-mv-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 5 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'odr-mv-vacuum-analyze'
     AND deadline_rule = 'at 5 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] odr-mv-vacuum-analyze: at 5 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'odr-mv-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] odr-mv-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] odr-mv-vacuum-analyze reads % / gates %, expected at 5 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'odr-mv-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named odr-mv-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'odr-mv-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron odr-mv-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron odr-mv-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) treemap-individuals-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 10 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'treemap-individuals-vacuum-analyze'
     AND deadline_rule = 'at 10 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] treemap-individuals-vacuum-analyze: at 10 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'treemap-individuals-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] treemap-individuals-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] treemap-individuals-vacuum-analyze reads % / gates %, expected at 10 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'treemap-individuals-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named treemap-individuals-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'treemap-individuals-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron treemap-individuals-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron treemap-individuals-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (4) odt-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 12 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'odt-vacuum-analyze'
     AND deadline_rule = 'at 12 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] odt-vacuum-analyze: at 12 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'odt-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] odt-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] odt-vacuum-analyze reads % / gates %, expected at 12 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'odt-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named odt-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'odt-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron odt-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron odt-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (5) osdr-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 14 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'osdr-vacuum-analyze'
     AND deadline_rule = 'at 14 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] osdr-vacuum-analyze: at 14 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'osdr-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] osdr-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] osdr-vacuum-analyze reads % / gates %, expected at 14 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'osdr-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named osdr-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'osdr-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron osdr-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron osdr-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (6) osar-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 16 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'osar-vacuum-analyze'
     AND deadline_rule = 'at 16 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] osar-vacuum-analyze: at 16 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'osar-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] osar-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] osar-vacuum-analyze reads % / gates %, expected at 16 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'osar-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named osar-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'osar-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron osar-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron osar-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (7) odbt-vacuum-analyze — daily, group rollups
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 18 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'odbt-vacuum-analyze'
     AND deadline_rule = 'at 18 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] odbt-vacuum-analyze: at 18 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'odbt-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] odbt-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] odbt-vacuum-analyze reads % / gates %, expected at 18 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'odbt-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named odbt-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'odbt-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron odbt-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron odbt-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (8) ecs-vacuum-analyze — daily, group ec
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-11-11 (FIX-1396, cc-267) from at 20 11,17 * * *; first dispatched firing owed',
         updated_at    = now()
   WHERE job = 'ecs-vacuum-analyze'
     AND deadline_rule = 'at 20 11,17 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1396] ecs-vacuum-analyze: at 20 11,17 * * * → dead_tuples > 60%% of trigger + floor 24 hours (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'ecs-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1396] ecs-vacuum-analyze already moved — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1396] ecs-vacuum-analyze reads % / gates %, expected at 20 11,17 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ecs-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1396] % cron.job rows named ecs-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'ecs-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1396] cron ecs-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1396] cron ecs-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_moves   jsonb := '[
    {"job": "officials-vacuum-analyze",           "floor": "7 days",   "target": "public.officials",                       "grp": "officials"},
    {"job": "odr-mv-vacuum-analyze",              "floor": "24 hours", "target": "public.official_donor_rollup_mv",        "grp": "rollups"},
    {"job": "treemap-individuals-vacuum-analyze", "floor": "24 hours", "target": "public.treemap_individuals_rollup",      "grp": "rollups"},
    {"job": "odt-vacuum-analyze",                 "floor": "24 hours", "target": "public.official_donor_totals",           "grp": "rollups"},
    {"job": "osdr-vacuum-analyze",                "floor": "24 hours", "target": "public.official_small_dollar_rollup",    "grp": "rollups"},
    {"job": "osar-vacuum-analyze",                "floor": "24 hours", "target": "public.official_sector_affinity_rollup", "grp": "rollups"},
    {"job": "odbt-vacuum-analyze",                "floor": "24 hours", "target": "public.official_donor_bracket_totals",   "grp": "rollups"},
    {"job": "ecs-vacuum-analyze",                 "floor": "24 hours", "target": "public.entity_connection_stats_mv",      "grp": "ec"}
  ]'::jsonb;
  v_x       jsonb;
  v_job     text;
  v_rule    text;
  v_r       public.job_registry%ROWTYPE;
  v_rel     regclass;
  v_m       text[];
  v_jobid   bigint;
  v_active  boolean;
  v_reltup  real;
  v_relopts text[];
  v_dead    bigint;
  v_statvac timestamptz;
  v_reaped  timestamptz;
  v_lastvac timestamptz;
  v_trigger numeric;
  v_elig    int;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
BEGIN
  FOR v_x IN SELECT * FROM jsonb_array_elements(v_moves) LOOP
    v_job  := v_x->>'job';
    v_rule := 'dead_tuples > 60% of trigger + floor ' || (v_x->>'floor');
    SELECT * INTO v_r FROM public.job_registry WHERE job = v_job;
    IF NOT FOUND THEN
      v_missing := v_missing || format('%s: no job_registry row', v_job)::text;
      CONTINUE;
    END IF;
    IF v_r.deadline_rule IS DISTINCT FROM v_rule THEN
      v_missing := v_missing || format('%s deadline_rule %L, expected %L', v_job, v_r.deadline_rule, v_rule)::text;
    END IF;
    IF v_r.gates IS DISTINCT FROM '{prod_session}'::text[] THEN
      v_missing := v_missing || format('%s gates %s, expected {prod_session}', v_job, v_r.gates)::text;
    END IF;
    -- phase_due_at is the dispatcher's to write, and only on a phase_lock row.
    IF v_r.phase_lock IS DISTINCT FROM false OR v_r.phase_due_at IS NOT NULL THEN
      v_missing := v_missing || format('%s phase_lock %s / phase_due_at %s, expected false / NULL', v_job, v_r.phase_lock, v_r.phase_due_at)::text;
    END IF;
    -- Nothing else on the row moved.
    IF v_r.runner IS DISTINCT FROM 'pg_cron' OR v_r.unit_shape IS DISTINCT FROM 'bare'
       OR v_r.priority IS DISTINCT FROM 4 OR v_r.cost_class IS DISTINCT FROM 'io'
       OR v_r.cap_mb IS DISTINCT FROM 64 OR v_r.exclusion_group IS DISTINCT FROM (v_x->>'grp')
       OR v_r.budget_seconds IS NOT NULL OR v_r.idempotent_refire IS DISTINCT FROM true
       OR v_r.pipeline IS NOT NULL OR v_r.yield_to IS DISTINCT FROM '{}'::text[] THEN
      v_missing := v_missing || format('%s columns moved: runner %s, shape %s, priority %s, class %s, cap %s, group %s, budget %s, refire %s, pipeline %s, yield_to %s',
                                       v_job, v_r.runner, v_r.unit_shape, v_r.priority, v_r.cost_class, v_r.cap_mb,
                                       v_r.exclusion_group, v_r.budget_seconds, v_r.idempotent_refire, v_r.pipeline, v_r.yield_to)::text;
    END IF;
    -- The pick's own VACUUM-target extraction (the census reg CTE).
    v_rel := to_regclass(substring(v_r.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'));
    IF v_rel IS DISTINCT FROM to_regclass(v_x->>'target') THEN
      v_missing := v_missing || format('%s unit_call %L resolves to %s, expected %s', v_job, v_r.unit_call, v_rel, v_x->>'target')::text;
    END IF;
    -- The pick's own parser, identical literal: groups 60 / the floor.
    v_m := regexp_match(v_r.deadline_rule,
             '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
    IF v_m IS NULL THEN
      v_missing := v_missing || format('%s: the pick regex does not match the rule', v_job)::text;
    ELSIF v_m[1]::numeric IS DISTINCT FROM 60 OR v_m[2]::interval IS DISTINCT FROM (v_x->>'floor')::interval THEN
      v_missing := v_missing || format('%s groups %s / %s, expected 60 / %s', v_job, v_m[1], v_m[2], v_x->>'floor')::text;
    END IF;
    -- The cron, parked by name.
    v_jobid := NULL;
    v_active := NULL;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_jobid IS NULL OR v_active THEN
      v_missing := v_missing || format('cron %s inactive (jobid %s, active %s)', v_job, v_jobid, v_active)::text;
    END IF;
  END LOOP;

  -- No routine moved here. dispatch_one_unit is pinned exactly; the other three
  -- may already read the later files of this push (20261111001000 moves
  -- get_dispatcher_status, 20261111003000 box_is_saturated and prod_op_gate).
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18'
     OR v_md5_g IS NULL OR v_md5_g NOT IN ('4c30523742e280a4b48ea2ec390654d6', 'd6bb02aab3eb8c9625275227f564c5c9')
     OR v_md5_b IS NULL OR v_md5_b NOT IN ('aaf6cc6552df532eff4a9b21e9780670', 'b05961ca6d1cf7e56874071bfe334da1')
     OR v_md5_p IS NULL OR v_md5_p NOT IN ('6488601cf8c09287d540989c0e0fd074', '70a799ab3df2484fc424fe2762ffa797') THEN
    v_missing := v_missing || format('the pins: dispatch_one_unit %s / get_dispatcher_status %s / box_is_saturated %s / prod_op_gate %s',
                                     v_md5_d, v_md5_g, v_md5_b, v_md5_p)::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1396] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- Printed, not asserted: the pick's arithmetic per row (the dead_tuples branch).
  FOR v_x IN SELECT * FROM jsonb_array_elements(v_moves) LOOP
    v_job := v_x->>'job';
    v_rel := to_regclass(v_x->>'target');
    SELECT c.reltuples, c.reloptions, s.n_dead_tup, GREATEST(s.last_vacuum, s.last_autovacuum)
      INTO v_reltup, v_relopts, v_dead, v_statvac
      FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE c.oid = v_rel;
    v_trigger :=
      COALESCE((SELECT split_part(o, '=', 2)::numeric FROM unnest(v_relopts) o
                 WHERE split_part(o, '=', 1) = 'autovacuum_vacuum_threshold'),
               current_setting('autovacuum_vacuum_threshold')::numeric)
      + COALESCE((SELECT split_part(o, '=', 2)::numeric FROM unnest(v_relopts) o
                   WHERE split_part(o, '=', 1) = 'autovacuum_vacuum_scale_factor'),
                 current_setting('autovacuum_vacuum_scale_factor')::numeric)
        * GREATEST(v_reltup, 0)::numeric;
    SELECT max(x.ticked_at) INTO v_reaped FROM public.dispatch_log x
     WHERE x.armed_jobid IS NOT NULL AND x.job = v_job
       AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%';
    v_lastvac := GREATEST(v_statvac, v_reaped);
    RAISE NOTICE '[fix1396] % — trigger %, 60%% line %, n_dead_tup %, anchor % → %',
      v_job, round(v_trigger, 1), round(v_trigger * 0.6), COALESCE(v_dead::text, 'NULL'), COALESCE(v_lastvac::text, 'NULL'),
      CASE WHEN v_dead >= v_trigger * 0.6 THEN 'DUE NOW (pct)'
           WHEN v_lastvac IS NULL THEN 'DUE NOW (null anchor, FIX-1326)'
           ELSE 'floor due ' || (v_lastvac + (v_x->>'floor')::interval)::text END;
  END LOOP;

  SELECT count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'
                            AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$'))
    INTO v_elig FROM public.job_registry j;
  RAISE NOTICE '[fix1396] read-back ok: eight rows moved, gates {prod_session}, phase_lock false, eight crons inactive; registry eligible %', v_elig;
  RAISE NOTICE '[fix1396] md5 dispatch_one_unit % / get_dispatcher_status % / box_is_saturated % / prod_op_gate %',
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;
END $$;
