-- =============================================================================
-- FIX-1320 — V1: MOVE fr-vacuum-analyze to the dispatcher (v1.3 note §2: a
-- KEEP job changes owner from cron to the dispatcher). job_registry's row goes
-- `at 0 3 * * *` → `dead_tuples > 60% of trigger + floor 24 hours` with gates
-- {prod_session}, and its 03:00Z cron is parked AT the move, in this file.
-- The first dispatched VACUUM on prod. cc-235, 2026-10-17.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) the row UPDATE: deadline_rule + gates '{prod_session}' + a note
--       append, matched on `deadline_rule = 'at 0 3 * * *'` (a second run
--       NOTICEs "already moved"; anything else RAISEs).
--   (2) the park, by NAME (FIX-946 — jobids differ between prod and the
--       clone; jobid 38 on prod at cc-235 read 4): exactly one cron.job row
--       named fr-vacuum-analyze or RAISE; active → cron.alter_job(job_id :=
--       v_jobid, active := false); already inactive → NOTICE. Never
--       cron.unschedule, never a new jobid. The registry owns the job from here.
--   (3) a read-back that RAISEs on any miss: the rule, the gates, the cron row
--       inactive, the pick's own VACUUM-target extraction resolving to
--       financial_relationships, the rule parsed by the pick's own regex (so a
--       typo fails the PUSH, not the first tick as `unsupported_deadline`), and
--       the two dispatcher bodies' md5s unchanged.
-- No routine is defined or replaced here (D-h): the M1 bodies already parse
-- `dead_tuples > …` (20261016230000, step 6) and arm a `bare` row.
--
-- WHY — D-a, the rule. Due when n_dead_tup >= 0.60 × trigger, where trigger =
-- autovacuum_vacuum_threshold (no FR reloption → the GUC, 50) +
-- autovacuum_vacuum_scale_factor (FR reloption 0.02, FIX-943) × reltuples; OR
-- when GREATEST(last_vacuum, last_autovacuum, the job's newest `reaped
-- succeeded` row) + 24 h <= now. The cron's fixed 03:00Z slot was FIX-1191's
-- answer to "daily, and away from the front door's peak"; the rule keeps the
-- daily cadence (the floor) and adds the thing the slot could not: after a
-- drop-night landing the pct term fires it as soon as the claim releases,
-- instead of up to a day later. On a quiet weekday the floor governs and the
-- vacuum fires ≈ daily at a drifting 03:0xZ (FIX-1323 owns the drift).
--
-- WHY — D-b, gates {prod_session}. The row was seeded '{}'. A bare VACUUM has
-- no body to consult prod_session_state() (FIX-1191: "fr-vacuum-analyze
-- REMAINS UNGUARDED … it can still fire INSIDE one"), so the dispatcher's gate
-- is the first gate this job has ever had: the vacuum CHASES a landing
-- (nothing_due · gated: prod_session rows, armed after the release) instead of
-- racing it, and it cannot start inside a gated push. The `nightly` GHA row
-- shares exclusion_group fr-table, so `group busy: fr-table` also excludes it
-- while a nightly_cron running row is < 6 h old. No blackout gate.
--
-- WHY — D-c, vacuum_cost_delay is NOT set. (1) A role-level GUC applies to
-- every manual VACUUM the postgres role runs — the other 12 cron vacuums and
-- every script VACUUM — so it is a platform-scoped change riding a one-row
-- move (FIX-1165). (2) One variable per receipt: the receipt is the
-- dispatched unit_ms against the cron's own band at the SAME cost settings.
-- (3) Nothing in the tree sets or reads it today. The 57014 census around the
-- first dispatched vacuum decides whether a cost delay becomes its own prompt.
--
-- MEASUREMENT (prod, cc-235 read 5, 2026-10-17 01:13:38Z):
--   reltuples 15,605,407; reloptions {autovacuum_analyze_scale_factor=0.02,
--   autovacuum_vacuum_scale_factor=0.02}; autovacuum_vacuum_threshold 50.
--   trigger = 50 + 0.02 × 15,605,407 = 312,158; 60 % = 187,295.
--   n_dead_tup 0 (pct 0.00); last_vacuum 2026-10-16 03:00:00.264949Z (the
--   cron run 129377, 03:00:00.050 → 03:00:09.537Z — last_vacuum is stamped at
--   the VACUUM's end, before its ANALYZE); last_autovacuum NULL;
--   vacuum_count 4 since the stats epoch pg_postmaster_start_time() 2026-10-13
--   01:24:52Z.
--   Predicted floor instant: 2026-10-17 03:00:00.26Z → the 03:01Z tick arms it
--   for 03:03Z — IF this file lands before 03:00Z (the push window, D-f).
--   The cron's 30-d band (job_run_details, succeeded): 27 runs, p50 10.1 s,
--   max 234.7 s, mean 54.8 s (the registry note's seed reading: 10.4 / 212.0).
--
-- NETS: platform_dials.pause (the hard stop for the arm); the dispatcher's box
-- skip, box_is_saturated(p_include_watchdog_wall := false); the prod_session
-- gate (D-b); the fr-table exclusion group against the nightly row; the
-- postgres role's 3 h statement_timeout (FIX-1185) as the one-shot's ONLY
-- in-backend bound — there is NO cron_job_budget row for a bare VACUUM
-- (budget_seconds NULL; dispatch_one_unit writes one only `IF v_pick_budget IS
-- NOT NULL`) and enforce_cron_job_budgets() cancels CALLs only, so the */2
-- watchdog is NOT a net here; autovacuum stays on at its tuned trigger as the
-- backstop; the data revert below.
--
-- ROLLBACK (data): scripts/fix1320-revert-fr-vacuum-move.sql, a --call
-- payload: the row back to `at 0 3 * * *` + gates '{}', and the cron
-- RE-ACTIVATED by name — a MOVE's revert, unlike a RETURN's, re-activates the
-- cron, because the registry row goes back to `at` and nothing else owns the
-- job. Working order in the payload's header (pause first).
--
-- IDEMPOTENT: a second run NOTICEs "already moved" / "already inactive" and
-- changes nothing. The clone gets it twice through `db-query.mjs --local
-- --file` (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n      int;
  v_rule   text;
  v_gates  text[];
  v_jobid  bigint;
  v_active boolean;
BEGIN
  -- ── (1) the row move ────────────────────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         note          = note || '; MOVED 2026-10-17 (FIX-1320, cc-235): dead_tuples > 60% of trigger '
                                 '+ floor 24 hours, gates {prod_session}; the 03:00Z cron parked at the '
                                 'move; vacuum_cost_delay deliberately unchanged (D-c)',
         updated_at    = now()
   WHERE job = 'fr-vacuum-analyze'
     AND deadline_rule = 'at 0 3 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1320] job_registry fr-vacuum-analyze: at 0 3 * * * → dead_tuples > 60%% of trigger + floor 24 hours, gates {prod_session} (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'fr-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1320] job_registry fr-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 24 hours) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1320] job_registry fr-vacuum-analyze reads % / gates %, expected at 0 3 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  -- ── (2) the park, by NAME (FIX-946) ─────────────────────────────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'fr-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1320] % cron.job rows named fr-vacuum-analyze — expected exactly 1; refusing to park by a name that does not resolve', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'fr-vacuum-analyze';
  IF v_active THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := false);
    RAISE NOTICE '[fix1320] cron fr-vacuum-analyze (jobid %) parked — the registry owns it', v_jobid;
  ELSE
    RAISE NOTICE '[fix1320] cron fr-vacuum-analyze (jobid %) already inactive — no-op', v_jobid;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_rule    text;
  v_gates   text[];
  v_call    text;
  v_rel     regclass;
  v_m       text[];
  v_iv      interval;
  v_jobid   bigint;
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  SELECT deadline_rule, gates, unit_call INTO v_rule, v_gates, v_call
    FROM public.job_registry WHERE job = 'fr-vacuum-analyze';
  IF v_rule IS DISTINCT FROM 'dead_tuples > 60% of trigger + floor 24 hours' THEN
    v_missing := v_missing || format('deadline_rule %L', v_rule);
  END IF;
  IF v_gates IS DISTINCT FROM '{prod_session}'::text[] THEN
    v_missing := v_missing || format('gates %s, expected {prod_session}', v_gates);
  END IF;

  -- The pick's own VACUUM-target extraction (20261016230000, step 6).
  v_rel := to_regclass(substring(v_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'));
  IF v_rel IS DISTINCT FROM 'public.financial_relationships'::regclass THEN
    v_missing := v_missing || format('unit_call %L resolves to %s, expected public.financial_relationships', v_call, v_rel);
  END IF;

  -- The pick's own parser, identical literal: groups 60 / 24 hours.
  v_m := regexp_match(v_rule,
           '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
  IF v_m IS NULL THEN
    v_missing := v_missing || 'the pick regex does not match the rule';
  ELSE
    IF v_m[1]::numeric IS DISTINCT FROM 60 THEN
      v_missing := v_missing || format('pct group %s, expected 60', v_m[1]);
    END IF;
    v_iv := v_m[2]::interval;
    IF v_iv IS DISTINCT FROM interval '24 hours' THEN
      v_missing := v_missing || format('floor group %s, expected 24 hours', v_m[2]);
    END IF;
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'fr-vacuum-analyze' AND NOT active;
  IF v_jobid IS NULL THEN
    v_missing := v_missing || 'cron fr-vacuum-analyze inactive';
  END IF;

  -- D-h: no dispatcher body moved (cc-235 read 3, prod 01:13Z).
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM '98660b34c17c5c537fc3d2e03d021440' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s, expected the M1 body', v_md5_d);
  END IF;
  IF v_md5_g IS DISTINCT FROM '4c9d0eb0cd85f9f46b38a9947cc94785' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected the M1 body', v_md5_g);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1320] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1320] read-back ok: fr-vacuum-analyze % (pct %, floor %), gates %, target %, cron jobid % inactive; dispatch_one_unit % / get_dispatcher_status %',
    v_rule, v_m[1], v_iv, v_gates, v_rel, v_jobid, v_md5_d, v_md5_g;
END $$;
