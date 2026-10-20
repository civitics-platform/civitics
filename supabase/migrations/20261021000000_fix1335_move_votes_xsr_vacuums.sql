-- =============================================================================
-- FIX-1335 — V2: MOVE votes-vacuum-analyze and xsr-vacuum-analyze to the
-- dispatcher (v1.3 note §2: a KEEP job changes owner from cron to the
-- dispatcher). Each job_registry row goes `at <its weekly slot>` →
-- `dead_tuples > 60% of trigger + floor 7 days` with gates {prod_session}, and
-- its cron is parked AT the move, in this file. V1's shape
-- (20261017020000_fix1320_move_fr_vacuum_analyze.sql) twice over. cc-240,
-- 2026-10-21.
--
-- TWO ROWS, NOT THREE. The prompt moved officials-vacuum-analyze too. cc-240's
-- read 5 found its reloptions are autovacuum_vacuum_threshold=1000,
-- autovacuum_vacuum_scale_factor=0.0, so its trigger is 1,000 dead tuples and
-- the 60 % line is 600. Every nightly crosses that line on routine traffic:
-- congress_officials (539 updates) and openstates_bulk_people (7,417) at
-- 21:01–21:04Z on 10-20, with 26 autovacuums in the 7.9 d since the stats
-- epoch, the last at 21:05:00Z. Under this rule the dispatcher would run a
-- nightly second pass on top of autovacuum, which D-a says the dispatched
-- VACUUM is not. So officials stays on its Mon 01:30Z cron and its rule gets
-- its own design. The read-back below asserts it is untouched.
-- dpr-vacuum-analyze is not moved either (D-b). Its MV is written only by the
-- parked donor-party-rollup-refresh weekly, so its dead tuples stay 0 until
-- that RETURNS, and its MOVE rides that return. After this file the small
-- weekly vacuum class is complete EXCEPT officials and dpr.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) the two row UPDATEs: deadline_rule + gates '{prod_session}' + a note
--       append, each matched on its exact current `at …` text (a second run
--       NOTICEs "already moved"; anything else RAISEs). priority 4,
--       exclusion_group (votes / xsr), budget_seconds NULL and phase_lock
--       false are unchanged (D-d, D-e).
--   (2) the two parks, by NAME (FIX-946 — jobids differ between prod and the
--       clone; prod votes 56 / xsr 57 at cc-240 read 4): exactly one cron.job
--       row per name or RAISE; active → cron.alter_job(job_id := v_jobid,
--       active := false); already inactive → NOTICE. Never cron.unschedule,
--       never a new jobid. The registry owns both jobs from here (R1b
--       unschedules later).
--   (3) a read-back that RAISEs on any miss (D-h): each rule parsed by the
--       pick's own regex (pct 60, floor '7 days'::interval), each unit_call's
--       VACUUM target resolved by the pick's own extraction to the expected
--       relation, the gates, the unchanged columns, both crons inactive,
--       officials and dpr UNMOVED (`at …`, crons active), and the two
--       dispatcher bodies' md5s unchanged (the B1 pair). It also prints each
--       row's trigger, 60 % line, n_dead_tup and floor due, computed with the
--       pick's arithmetic. Those are printed, not asserted.
-- No routine is defined or replaced here: the B1 body (20261020000000)
-- already parses `dead_tuples > …`, arms a `bare` row, gives a NULL anchor a
-- due (FIX-1326) and serializes VACUUMs (FIX-1322, `unit_call ~*
-- '^\s*VACUUM'`).
--
-- WHY — D-a, the rule. Due when n_dead_tup >= 0.60 × trigger, where trigger =
-- COALESCE(reloption autovacuum_vacuum_threshold, the GUC 50) +
-- COALESCE(reloption autovacuum_vacuum_scale_factor, the GUC 0.2) ×
-- reltuples; OR when GREATEST(last_vacuum, last_autovacuum, the job's newest
-- `reaped succeeded` tick) + 7 days <= now. The floor is each job's current
-- cron cadence (weekly), so the receipt changes one variable (rule 74): the pct
-- term. A landing that leaves either table at 60 % of its autovacuum trigger
-- gets its VACUUM as soon as the claim releases instead of up to a week later.
-- 60 % matches fr, so the vacuum class keeps ONE pct convention. An autovacuum
-- that reaches the table resets the floor. That is intended: the dispatched
-- VACUUM guarantees nothing goes 7 days without a VACUUM (ANALYZE). It is not
-- a second pass on top of autovacuum.
--
-- WHY — D-d, no phase_lock. A weekly floor drifts ~+4 min per cycle (arm
-- latency, FIX-1323); over a week that is noise, and the receipt wants one
-- changed variable. If it matters later it is one `UPDATE … phase_lock = true`.
--
-- WHY — D-e, gates {prod_session}; groups, priority 4 and budget NULL
-- unchanged. A bare VACUUM has no body to consult prod_session_state(), so the
-- dispatcher's gate is its first: it chases a landing instead of racing it.
-- The per-table groups stay; the io cap (FIX-1322) is what keeps two VACUUMs
-- apart. No vacuum_cost_delay (V1 D-c).
--
-- MEASUREMENT (prod, cc-240 read 5, 2026-10-20 23:22Z; stats epoch
-- pg_postmaster_start_time() 2026-10-13 01:24:52Z, 7.92 d; GUCs
-- autovacuum_vacuum_threshold 50, autovacuum_vacuum_scale_factor 0.2):
--
--   public.votes — reltuples 984,336; relpages 73,085, all-visible 73,085;
--     reloptions {autovacuum_vacuum_scale_factor=0.05 (FIX-1239),
--     autovacuum_analyze_scale_factor=0.02}; heap 571 MB.
--     trigger = 50 + 0.05 × 984,336 = 49,266.8; 60 % line = 29,560.
--     n_dead_tup 0 (0.0 % of the line); n_tup_ins / upd / del 0 / 0 / 0 since
--     the epoch → 0 dead/day, so the line is never reached at this rate.
--     last_vacuum 2026-10-17 02:37:00.08063Z (the Sat cron, 2.71 s);
--     last_autovacuum NULL. Floor due 2026-10-24 02:37:00.08Z (Sat). The 02:37
--     tick reads it ~0.03 s early, so the 02:39 tick arms it and the VACUUM
--     runs 02:41Z. Cron walls (30 d): 24.80 / 2.90 / 2.71 s; bands.json 0–29 s.
--
--   public.external_source_refs — reltuples 610,931; relpages 14,421,
--     all-visible 14,421; reloptions {autovacuum_vacuum_scale_factor=0.05,
--     autovacuum_analyze_scale_factor=0.02}; heap 113 MB.
--     trigger = 50 + 0.05 × 610,931 = 30,596.6; 60 % line = 18,358.
--     n_dead_tup 651 (3.5 % of the line); n_tup_ins / upd / del 1,448 / 5,560
--     / 0 → 702 dead/day → ~25 days to the line.
--     last_vacuum 2026-10-20 01:41:01.774633Z (the cron's first-ever firing,
--     2.50 s); last_autovacuum NULL. Floor due 2026-10-27 01:41:01.77Z (Tue).
--     The 01:43 tick arms it; :45 is skipped, so the VACUUM runs 01:47Z.
--     No band (bands.json has no xsr key).
--
--   (officials, for the record: trigger 1,000 + 0.0 × 39,229 = 1,000; 60 %
--   line 600; n_dead_tup 0 just after the 21:05:00Z autovacuum; 75,145
--   updates since the epoch ≈ 9,490/day, all in the nightly. Not moved.)
--
-- NETS: platform_dials.pause (the hard stop for the arm); the dispatcher's box
-- skip; the prod_session gate (D-e); the io cap, one VACUUM at a time
-- (FIX-1322); the postgres role's 3 h statement_timeout (FIX-1185) as the
-- one-shot's ONLY in-backend bound. There is NO cron_job_budget row for a
-- bare VACUUM (budget_seconds NULL), and enforce_cron_job_budgets() cancels
-- CALLs only. Autovacuum stays on at each table's tuned trigger as the
-- backstop. The data revert is below.
--
-- ROLLBACK (data): scripts/fix1335-revert-move-votes-xsr-vacuums.sql, a
-- --call payload: both rows back to their `at …` text + gates '{}', and both
-- crons RE-ACTIVATED by name. A MOVE's revert re-activates the cron, because
-- nothing else owns the job once the row is back on `at`. Working order is in
-- the payload's header (pause first).
--
-- IDEMPOTENT: a second run NOTICEs "already moved" / "already parked" and
-- changes nothing. The clone gets it twice through `db-query.mjs --local
-- --file` (rule 241).
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the two row moves
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
         note          = note || '; MOVED by cc-240 (FIX-1335) from at 37 2 * * 6',
         updated_at    = now()
   WHERE job = 'votes-vacuum-analyze'
     AND deadline_rule = 'at 37 2 * * 6';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1335] job_registry votes-vacuum-analyze: at 37 2 * * 6 → dead_tuples > 60%% of trigger + floor 7 days, gates {prod_session} (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'votes-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 7 days' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1335] job_registry votes-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 7 days) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1335] job_registry votes-vacuum-analyze reads % / gates %, expected at 37 2 * * 6 or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;

  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days',
         gates         = '{prod_session}',
         note          = note || '; MOVED by cc-240 (FIX-1335) from at 41 1 * * 2',
         updated_at    = now()
   WHERE job = 'xsr-vacuum-analyze'
     AND deadline_rule = 'at 41 1 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1335] job_registry xsr-vacuum-analyze: at 41 1 * * 2 → dead_tuples > 60%% of trigger + floor 7 days, gates {prod_session} (1 row)';
  ELSE
    SELECT deadline_rule, gates INTO v_rule, v_gates FROM public.job_registry WHERE job = 'xsr-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 7 days' AND v_gates = '{prod_session}' THEN
      RAISE NOTICE '[fix1335] job_registry xsr-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 7 days) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1335] job_registry xsr-vacuum-analyze reads % / gates %, expected at 41 1 * * 2 or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates;
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (2) the two parks, by NAME (FIX-946)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_job    text;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['votes-vacuum-analyze', 'xsr-vacuum-analyze'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1335] % cron.job rows named % — expected exactly 1; refusing to park by a name that does not resolve', v_n, v_job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := false);
      RAISE NOTICE '[fix1335] cron % (jobid %) parked — the registry owns it', v_job, v_jobid;
    ELSE
      RAISE NOTICE '[fix1335] cron % (jobid %) already parked — no-op', v_job, v_jobid;
    END IF;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss (D-h)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_rule    constant text := 'dead_tuples > 60% of trigger + floor 7 days';
  v_missing text[] := '{}';
  v_moves   text[][] := ARRAY[['votes-vacuum-analyze', 'votes', 'public.votes'],
                              ['xsr-vacuum-analyze',   'xsr',   'public.external_source_refs']];
  v_job     text;
  v_group   text;
  v_relname text;
  v_r       public.job_registry%ROWTYPE;
  v_rel     regclass;
  v_m       text[];
  v_iv      interval;
  v_jobid   bigint;
  v_active  boolean;
  v_reltup  real;
  v_relopts text[];
  v_dead    bigint;
  v_lastvac timestamptz;
  v_trigger numeric;
  v_line    text := '';
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  FOR i IN 1 .. array_length(v_moves, 1) LOOP
    v_job := v_moves[i][1]; v_group := v_moves[i][2]; v_relname := v_moves[i][3];
    SELECT * INTO v_r FROM public.job_registry WHERE job = v_job;
    IF NOT FOUND THEN
      v_missing := v_missing || format('%s: no job_registry row', v_job);
      CONTINUE;
    END IF;
    IF v_r.deadline_rule IS DISTINCT FROM c_rule THEN
      v_missing := v_missing || format('%s deadline_rule %L', v_job, v_r.deadline_rule);
    END IF;
    IF v_r.gates IS DISTINCT FROM '{prod_session}'::text[] THEN
      v_missing := v_missing || format('%s gates %s, expected {prod_session}', v_job, v_r.gates);
    END IF;
    -- D-d / D-e: nothing else on the row moved.
    IF v_r.unit_shape IS DISTINCT FROM 'bare' OR v_r.priority IS DISTINCT FROM 4
       OR v_r.exclusion_group IS DISTINCT FROM v_group OR v_r.budget_seconds IS NOT NULL
       OR v_r.phase_lock IS DISTINCT FROM false OR v_r.phase_due_at IS NOT NULL THEN
      v_missing := v_missing || format('%s columns moved: shape %s, priority %s, group %s, budget %s, phase_lock %s, phase_due_at %s',
                                       v_job, v_r.unit_shape, v_r.priority, v_r.exclusion_group,
                                       v_r.budget_seconds, v_r.phase_lock, v_r.phase_due_at);
    END IF;

    -- The pick's own VACUUM-target extraction (20261020000000, the census reg CTE).
    v_rel := to_regclass(substring(v_r.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'));
    IF v_rel IS DISTINCT FROM v_relname::regclass THEN
      v_missing := v_missing || format('%s unit_call %L resolves to %s, expected %s', v_job, v_r.unit_call, v_rel, v_relname);
    END IF;

    -- The pick's own parser, identical literal: groups 60 / 7 days.
    v_m := regexp_match(v_r.deadline_rule,
             '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
    IF v_m IS NULL THEN
      v_missing := v_missing || format('%s: the pick regex does not match the rule', v_job);
    ELSE
      IF v_m[1]::numeric IS DISTINCT FROM 60 THEN
        v_missing := v_missing || format('%s pct group %s, expected 60', v_job, v_m[1]);
      END IF;
      v_iv := v_m[2]::interval;
      IF v_iv IS DISTINCT FROM interval '7 days' THEN
        v_missing := v_missing || format('%s floor group %s, expected 7 days', v_job, v_m[2]);
      END IF;
    END IF;

    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_jobid IS NULL OR v_active THEN
      v_missing := v_missing || format('cron %s inactive (jobid %s, active %s)', v_job, v_jobid, v_active);
    END IF;

    -- Printed, not asserted: the pick's arithmetic (20261020000000, the
    -- dead_tuples branch), so the push log carries each row's next due.
    IF v_rel IS NOT NULL AND v_m IS NOT NULL THEN
      SELECT c.reltuples, c.reloptions, s.n_dead_tup, GREATEST(s.last_vacuum, s.last_autovacuum)
        INTO v_reltup, v_relopts, v_dead, v_lastvac
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
      v_lastvac := GREATEST(v_lastvac,
        (SELECT max(x.ticked_at) FROM public.dispatch_log x
          WHERE x.armed_jobid IS NOT NULL AND x.job = v_job
            AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'));
      v_line := v_line || format('; %s: trigger %s, 60%% line %s, n_dead_tup %s → %s',
        v_job, round(v_trigger, 1), round(v_trigger * 0.6), COALESCE(v_dead::text, 'NULL'),
        CASE WHEN v_dead >= v_trigger * 0.6 THEN 'DUE NOW (pct)'
             WHEN v_lastvac IS NULL THEN 'DUE NOW (null anchor, FIX-1326)'
             ELSE 'floor due ' || (v_lastvac + v_iv)::text END);
    END IF;
  END LOOP;

  -- Officials and dpr stay on cron (header): untouched rows, active crons.
  SELECT * INTO v_r FROM public.job_registry WHERE job = 'officials-vacuum-analyze';
  IF v_r.deadline_rule IS DISTINCT FROM 'at 30 1 * * 1' OR v_r.gates IS DISTINCT FROM '{}'::text[] THEN
    v_missing := v_missing || format('officials-vacuum-analyze reads %L / %s, expected at 30 1 * * 1 / {} (not moved)', v_r.deadline_rule, v_r.gates);
  END IF;
  SELECT * INTO v_r FROM public.job_registry WHERE job = 'dpr-vacuum-analyze';
  IF v_r.deadline_rule IS DISTINCT FROM 'at 0 2 * * 0,3' OR v_r.gates IS DISTINCT FROM '{}'::text[] THEN
    v_missing := v_missing || format('dpr-vacuum-analyze reads %L / %s, expected at 0 2 * * 0,3 / {} (not moved)', v_r.deadline_rule, v_r.gates);
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('officials-vacuum-analyze', 'dpr-vacuum-analyze') AND active) <> 2 THEN
    v_missing := v_missing || 'crons officials-vacuum-analyze + dpr-vacuum-analyze active';
  END IF;

  -- D-h: no dispatcher body moved — the B1 pair (cc-239, 20261020000000).
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM 'cfc9ed48517cd7de6fa76cf807dd1f37' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s, expected the B1 body', v_md5_d);
  END IF;
  IF v_md5_g IS DISTINCT FROM '1cf4b7745f4c89ce978935648c87c92b' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected the B1 body', v_md5_g);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1335] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1335] read-back ok: votes-vacuum-analyze + xsr-vacuum-analyze % (pct 60, floor 7 days), gates {prod_session}, targets public.votes / public.external_source_refs, both crons inactive; officials + dpr unmoved%',
    c_rule, v_line;
  RAISE NOTICE '[fix1335] md5 dispatch_one_unit % / get_dispatcher_status %', v_md5_d, v_md5_g;
END $$;
