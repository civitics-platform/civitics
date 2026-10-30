-- =============================================================================
-- FIX-1366 — MOVE dpr-vacuum-analyze to the dispatcher (v1.3 note §2: a KEEP
-- job changes owner from cron to the dispatcher). Its job_registry row goes
-- `at 0 2 * * 0,3` → `dead_tuples > 60% of trigger + floor 7 days` with
-- gates {prod_session} and NO phase_lock — fix1335's weekly-vacuum shape
-- (20261021000000_fix1335_move_votes_xsr_vacuums.sql, D-d) — and its cron is
-- parked AT the move, in this file. cc-254, 2026-10-30. Class P: one row
-- UPDATE and one cron.alter_job.
--
-- WHY NOW. FIX-1335 (D-b) held this MOVE back: donor_party_rollup_mv is
-- written only by donor-party-rollup-refresh (and the monthly orphan sweep,
-- jobid 18), both parked since 10-13, so its dead tuples stayed 0. The MOVE
-- rides the RETURN (20261030000000_fix1365, the same push, first). After it
-- the small vacuum class is dispatched except officials (rule 341).
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) the row UPDATE: deadline_rule + gates '{prod_session}' + a note
--       append, matched on the exact current `at 0 2 * * 0,3` text (a second
--       run NOTICEs "already moved"; anything else RAISEs). priority 4,
--       cost_class io, cap_mb 64, unit_shape bare, group rollups,
--       budget_seconds NULL, idempotent_refire true and phase_lock false are
--       unchanged.
--   (2) the park, by NAME (FIX-946; prod jobid 31 at cc-254 read 5): exactly
--       one cron.job row or RAISE; active → cron.alter_job(job_id := v_jobid,
--       active := false); already inactive → NOTICE. Never cron.unschedule.
--   (3) a read-back that RAISEs on any miss: the rule parsed by the pick's
--       own regex (pct 60, floor '7 days'), the unit_call's VACUUM target
--       resolved by the pick's own extraction to public.donor_party_rollup_mv,
--       gates, the unchanged columns, the cron inactive, officials UNMOVED
--       (`at 30 1 * * 1`, cron active), and the four pins unchanged. It
--       prints the trigger, 60 % line, n_dead_tup, anchor and due with the
--       pick's arithmetic: printed, not asserted.
--
-- WHY — the rule (fix1335 D-a). Due when n_dead_tup >= 0.60 × trigger, where
-- trigger = COALESCE(reloption autovacuum_vacuum_threshold, the GUC 50) +
-- COALESCE(reloption autovacuum_vacuum_scale_factor, the GUC 0.2) ×
-- reltuples; OR when GREATEST(last_vacuum, last_autovacuum, the job's newest
-- `reaped succeeded` tick) + 7 days <= now. The floor is the cron's cadence,
-- rounded to the class's weekly (the cron ran twice a week, Sun + Wed 02:00Z,
-- at 1.4–1.5 s a run). A crawl that rewrites > 60 % of the trigger gets its
-- VACUUM on the next tick the group frees, instead of at the next Sun/Wed.
--
-- WHY — no phase_lock (fix1335 D-d). A weekly floor drifts ~+4 min a cycle;
-- over a week that is noise. gates {prod_session} (D-e): a bare VACUUM has no
-- body to consult prod_session_state(), so the dispatcher's gate is its first.
--
-- MEASUREMENT (prod, cc-254 read 5, 2026-10-30 00:23Z; every pg_stat_* view
-- dates from the 10-25 13:25:53Z crash recovery; GUCs
-- autovacuum_vacuum_threshold 50, autovacuum_vacuum_scale_factor 0.2):
--
--   public.donor_party_rollup_mv — reltuples 2,975,150 (2,973,265 rows,
--     2,737,798 donors); reloptions {autovacuum_vacuum_scale_factor=0.02,
--     autovacuum_analyze_scale_factor=0.01}: no threshold reloption, so this
--     is NOT rule 341's case (officials' threshold-only trigger).
--     trigger = 50 + 0.02 × 2,975,150 = 59,553; 60 % line 35,732.
--     n_dead_tup 0; n_tup_ins / upd / del 0 / 0 / 0 since the reset.
--     last_vacuum 2026-10-28 02:00:00.257Z (the cron), last_autovacuum NULL,
--     no reaped tick → the floor is due 2026-11-04 02:00:00Z unless the pct
--     term fires first. Read 3(e)'s catch-up rebuilds 15,324 donors (~1.09
--     rows each), so it should leave ~17 k dead rows, under the line.
--     Cron walls (14 d): 1.4 / 1.4 / 1.4 / 1.5 s (10-18, 10-21, 10-25, 10-28);
--     bands.json no-band.
--
-- OWNERS of the table's VACUUM (rule 371): cron dpr-vacuum-analyze (the
-- fix975 backstop itself) and autovacuum. No pipeline tail VACUUMs it. After
-- the park, prod_op_gate's (b) loop (active cron VACUUM names) no longer sees
-- it; the dispatcher's io cap and the `rollups` group do.
--
-- NETS: platform_dials.pause; the dispatcher's box skip; the prod_session
-- gate; the io cap, one VACUUM at a time (FIX-1322); the `rollups` group (it
-- never runs beside the donor-party crawl); the postgres role's 3 h
-- statement_timeout as the one-shot's only in-backend bound (a bare VACUUM
-- has no cron_job_budget row, rule 313). Autovacuum stays on at the tuned
-- trigger as the backstop.
--
-- ROLLBACK (data): scripts/fix1366-revert-move-dpr-vacuum.sql, a --call
-- payload: the row back to `at 0 2 * * 0,3`, gates '{}', phase_lock false,
-- phase_due_at NULL, and the cron RE-ACTIVATED by name (a MOVE's revert
-- re-activates the cron: nothing else owns the job once the row is back on
-- `at`).
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the row move
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n     int;
  v_rule  text;
  v_gates text[];
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-10-30 (FIX-1366, cc-254) from at 0 2 * * 0,3',
         updated_at    = now()
   WHERE job = 'dpr-vacuum-analyze'
     AND deadline_rule = 'at 0 2 * * 0,3';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1366] job_registry dpr-vacuum-analyze: at 0 2 * * 0,3 → dead_tuples > 60%% of trigger + floor 7 days, gates {prod_session} (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'dpr-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 7 days' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1366] job_registry dpr-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 7 days) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1366] job_registry dpr-vacuum-analyze reads % / gates %, expected at 0 2 * * 0,3 or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (2) the park, by NAME (FIX-946)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'dpr-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1366] % cron.job rows named dpr-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'dpr-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1366] cron dpr-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1366] cron dpr-vacuum-analyze (jobid %) already parked — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_rule    constant text := 'dead_tuples > 60% of trigger + floor 7 days';
  v_missing text[] := '{}';
  v_r       public.job_registry%ROWTYPE;
  v_rel     regclass;
  v_m       text[];
  v_iv      interval;
  v_jobid   bigint;
  v_active  boolean;
  v_reltup  real;
  v_relopts text[];
  v_dead    bigint;
  v_statvac timestamptz;
  v_reaped  timestamptz;
  v_lastvac timestamptz;
  v_trigger numeric;
  v_line    text := '';
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
BEGIN
  SELECT * INTO v_r FROM public.job_registry WHERE job = 'dpr-vacuum-analyze';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1366] read-back failed: no job_registry row dpr-vacuum-analyze';
  END IF;
  IF v_r.deadline_rule IS DISTINCT FROM c_rule THEN
    v_missing := v_missing || format('dpr-vacuum-analyze deadline_rule %L', v_r.deadline_rule);
  END IF;
  IF v_r.gates IS DISTINCT FROM '{prod_session}'::text[] THEN
    v_missing := v_missing || format('dpr-vacuum-analyze gates %s, expected {prod_session}', v_r.gates);
  END IF;
  -- phase_due_at is the dispatcher's to write, and only on a phase_lock row.
  IF v_r.phase_lock IS DISTINCT FROM false OR v_r.phase_due_at IS NOT NULL THEN
    v_missing := v_missing || format('dpr-vacuum-analyze phase_lock %s / phase_due_at %s, expected false / NULL', v_r.phase_lock, v_r.phase_due_at);
  END IF;
  -- Nothing else on the row moved.
  IF v_r.runner IS DISTINCT FROM 'pg_cron' OR v_r.unit_shape IS DISTINCT FROM 'bare'
     OR v_r.priority IS DISTINCT FROM 4 OR v_r.cost_class IS DISTINCT FROM 'io'
     OR v_r.cap_mb IS DISTINCT FROM 64 OR v_r.exclusion_group IS DISTINCT FROM 'rollups'
     OR v_r.budget_seconds IS NOT NULL OR v_r.idempotent_refire IS DISTINCT FROM true
     OR v_r.pipeline IS NOT NULL OR v_r.yield_to IS DISTINCT FROM '{}'::text[] THEN
    v_missing := v_missing || format('dpr-vacuum-analyze columns moved: runner %s, shape %s, priority %s, class %s, cap %s, group %s, budget %s, refire %s, pipeline %s, yield_to %s',
                                     v_r.runner, v_r.unit_shape, v_r.priority, v_r.cost_class, v_r.cap_mb,
                                     v_r.exclusion_group, v_r.budget_seconds, v_r.idempotent_refire, v_r.pipeline, v_r.yield_to);
  END IF;

  -- The pick's own VACUUM-target extraction (the census reg CTE).
  v_rel := to_regclass(substring(v_r.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'));
  IF v_rel IS DISTINCT FROM 'public.donor_party_rollup_mv'::regclass THEN
    v_missing := v_missing || format('dpr-vacuum-analyze unit_call %L resolves to %s, expected public.donor_party_rollup_mv', v_r.unit_call, v_rel);
  END IF;

  -- The pick's own parser, identical literal: groups 60 / 7 days.
  v_m := regexp_match(v_r.deadline_rule,
           '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
  IF v_m IS NULL THEN
    v_missing := v_missing || 'dpr-vacuum-analyze: the pick regex does not match the rule';
  ELSE
    IF v_m[1]::numeric IS DISTINCT FROM 60 THEN
      v_missing := v_missing || format('dpr-vacuum-analyze pct group %s, expected 60', v_m[1]);
    END IF;
    v_iv := v_m[2]::interval;
    IF v_iv IS DISTINCT FROM interval '7 days' THEN
      v_missing := v_missing || format('dpr-vacuum-analyze floor group %s, expected 7 days', v_m[2]);
    END IF;
  END IF;

  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'dpr-vacuum-analyze';
  IF v_jobid IS NULL OR v_active THEN
    v_missing := v_missing || format('cron dpr-vacuum-analyze inactive (jobid %s, active %s)', v_jobid, v_active);
  END IF;

  -- officials stays on cron (rule 341): an untouched row, an active cron.
  SELECT * INTO v_r FROM public.job_registry WHERE job = 'officials-vacuum-analyze';
  IF v_r.deadline_rule IS DISTINCT FROM 'at 30 1 * * 1' OR v_r.gates IS DISTINCT FROM '{}'::text[] THEN
    v_missing := v_missing || format('officials-vacuum-analyze reads %L / %s, expected at 30 1 * * 1 / {} (not moved)', v_r.deadline_rule, v_r.gates);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'officials-vacuum-analyze' AND active) THEN
    v_missing := v_missing || 'cron officials-vacuum-analyze active';
  END IF;

  -- No routine moved: the four pins (cc-253, 20261029000000).
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18'
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6'
     OR v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_p IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' THEN
    v_missing := v_missing || format('the pins: dispatch_one_unit %s / get_dispatcher_status %s / box_is_saturated %s / prod_op_gate %s',
                                     v_md5_d, v_md5_g, v_md5_b, v_md5_p);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1366] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- Printed, not asserted: the pick's arithmetic (the dead_tuples branch).
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
   WHERE x.armed_jobid IS NOT NULL AND x.job = 'dpr-vacuum-analyze'
     AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%';
  v_lastvac := GREATEST(v_statvac, v_reaped);
  v_line := format('trigger %s, 60%% line %s, n_dead_tup %s, anchor %s (stats %s, reaped %s) → %s',
    round(v_trigger, 1), round(v_trigger * 0.6), COALESCE(v_dead::text, 'NULL'),
    COALESCE(v_lastvac::text, 'NULL'), COALESCE(v_statvac::text, 'NULL'), COALESCE(v_reaped::text, 'NULL'),
    CASE WHEN v_dead >= v_trigger * 0.6 THEN 'DUE NOW (pct)'
         WHEN v_lastvac IS NULL THEN 'DUE NOW (null anchor, FIX-1326)'
         ELSE 'floor due ' || (v_lastvac + v_iv)::text END);
  RAISE NOTICE '[fix1366] read-back ok: dpr-vacuum-analyze % (pct 60, floor 7 days), gates {prod_session}, phase_lock false, target public.donor_party_rollup_mv, cron (jobid %) inactive; officials unmoved; %',
    c_rule, v_jobid, v_line;
  RAISE NOTICE '[fix1366] md5 dispatch_one_unit % / get_dispatcher_status % / box_is_saturated % / prod_op_gate %',
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;
END $$;
