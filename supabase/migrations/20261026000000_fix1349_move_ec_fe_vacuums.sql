-- =============================================================================
-- FIX-1349 — MOVE ec-vacuum-analyze and fe-vacuum-analyze to the dispatcher
-- (v1.3 note §2: a KEEP job changes owner from cron to the dispatcher). Each
-- job_registry row goes `at <its daily slot>` → `dead_tuples > 60% of trigger
-- + floor 24 hours` with gates {prod_session} and phase_lock true — fr's rule
-- (FIX-1320, FIX-1323) — and its cron is parked AT the move, in this file.
-- V2's shape (20261021000000_fix1335_move_votes_xsr_vacuums.sql). cc-249,
-- 2026-10-26. Class P: row UPDATEs and cron.alter_job only.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) the two row UPDATEs: deadline_rule + gates '{prod_session}' +
--       phase_lock true + a note append, each matched on its exact current
--       `at …` text (a second run NOTICEs "already moved"; anything else
--       RAISEs). priority 4, cost_class io, cap_mb 64, unit_shape bare,
--       budget_seconds NULL and the groups (ec / fe-totals) are unchanged.
--   (2) the two parks, by NAME (FIX-946 — jobids differ between prod and the
--       clone; prod ec 6 / fe 30 at cc-249 read 3): exactly one cron.job row
--       per name or RAISE; active → cron.alter_job(job_id := v_jobid,
--       active := false); already inactive → NOTICE. Never cron.unschedule.
--   (3) a read-back that RAISEs on any miss: each rule parsed by the pick's
--       own regex (pct 60, floor '24 hours'), each unit_call's VACUUM target
--       resolved to the expected relation, gates, phase_lock, phase_due_at
--       NULL (unless the dispatcher has armed the row since the move), the
--       unchanged columns, both crons inactive, officials and dpr UNMOVED
--       (`at …`, crons active), and the N2 pair + prod_op_gate md5s
--       unchanged. It prints each row's trigger, 60 % line, n_dead_tup, anchor
--       and due with the pick's arithmetic — printed, not asserted.
--
-- WHY — cc-250. The fixed 04:30 / 04:50 slots sat inside the 10-25 morning's
-- first pg_cron stall (04:33–05:05Z, swap at the 1,024 MB ceiling). A cron
-- fires into that; a dispatched unit is behind the dispatcher's box skip, its
-- prod_session gate, its group and the io cap. These two are also the last
-- daily VACUUMs prod_op_gate's slot clause could trip on (14-d max 139.2 /
-- 101.2 s; every other daily VACUUM cron is <= 10.4 s), and dispatched they
-- stop running beside their own crawls (rule 330: the `ec` / `fe-totals`
-- groups make the crawl and its table's VACUUM exclusive).
--
-- WHY — the rule is fr's, phase_lock included. A daily floor drifts
-- +4–6 min per cycle unlocked (rules 309 / 316, FIX-1323); fr's lock has held
-- to the µs for five days. The anchor is GREATEST(last_vacuum,
-- last_autovacuum, the job's newest `reaped succeeded` tick), and a NULL
-- anchor is due (FIX-1326). phase_due_at is written by the first FLOOR arm
-- (not by a null_anchor or pct arm); from then the row holds that slot.
--
-- MEASUREMENT (prod, cc-249 read 5, 2026-10-25 23:43:38Z; every pg_stat_* view
-- dates from the 13:25:53Z crash recovery, cc-250; GUCs
-- autovacuum_vacuum_threshold 50, autovacuum_vacuum_scale_factor 0.2):
--
--   public.entity_connections — reltuples 10,560,502; reloptions
--     {autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=
--     0.02, autovacuum_enabled=true}. trigger = 50 + 0.05 × 10,560,502 =
--     528,075.1; 60 % line 316,845. n_dead_tup 0; n_tup_ins / upd / del 0 / 0
--     / 0 since the reset. last_vacuum, last_autovacuum NULL; no reaped tick
--     → null_anchor → DUE at the push (the first tick after it arms it).
--     Cron walls (14 d): mean 37.0 / max 139.2 s, last 10.1 s (10-25 04:30Z);
--     bands.json 0–140 s.
--
--   public.financial_entities — reltuples 5,267,782; reloptions
--     {autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=
--     0.02}. trigger = 50 + 0.05 × 5,267,782 = 263,439.1; 60 % line 158,063.
--     n_dead_tup 64,083 (40.5 % of the line); n_tup_upd 131,159, ins 12,015,
--     del 0 since the reset — the Sun drop night's whole FEC landing included.
--     last_vacuum 2026-10-25 22:53:36.94Z: NOT the cron's. The nightly's fec
--     phase VACUUMs this table after rebuild_financial_entity_ie_totals
--     (vacuum-tail, FIX-943 rule: 96.9 s on 10-25, 45.6 s at 21:13:47Z on
--     10-24). So the floor is due 2026-10-26 22:53:36.94Z, not at the push,
--     and while that tail runs nightly an unlocked floor follows it: the row
--     arms only when 24 h pass without a VACUUM. Cron walls (14 d): mean 25.3 /
--     max 101.2 s, last 31.1 s; bands.json 0–140 s.
--
--   Rule 341 (the officials STOP): neither row trips. No threshold reloption
--   on either table, and routine nightly traffic stays under the line (ec 0
--   writes since the reset; fe 131,159 updates over a drop night < 158,063).
--
-- NETS: platform_dials.pause (the hard stop for the arm); the dispatcher's box
-- skip; the prod_session gate; the io cap, one VACUUM at a time (FIX-1322);
-- the `ec` / `fe-totals` groups; the postgres role's 3 h statement_timeout
-- (FIX-1185) as the one-shot's only in-backend bound — a bare VACUUM has no
-- cron_job_budget row (rule 313). Autovacuum stays on at each table's tuned
-- trigger as the backstop. The data revert is below.
--
-- ROLLBACK (data): scripts/fix1349-revert-move-ec-fe-vacuums.sql, a --call
-- payload: both rows back to their `at …` text, gates '{}', phase_lock false,
-- phase_due_at NULL, and both crons RE-ACTIVATED by name (a MOVE's revert
-- re-activates the cron: nothing else owns the job once the row is back on
-- `at`). Working order is in the payload's header (pause first).
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241): a second run
-- NOTICEs "already moved" / "already parked" and changes nothing. The clone
-- gets it twice through `db-query.mjs --local --file`, then a third time,
-- recording, through `supabase migration up --local` (FIX-1351).
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the two row moves
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n     int;
  v_rule  text;
  v_gates text[];
  v_lock  boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         phase_lock    = true,
         note          = note || '; MOVED by cc-249 (FIX-1349) from at 30 4 * * *',
         updated_at    = now()
   WHERE job = 'ec-vacuum-analyze'
     AND deadline_rule = 'at 30 4 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1349] job_registry ec-vacuum-analyze: at 30 4 * * * → dead_tuples > 60%% of trigger + floor 24 hours, gates {prod_session}, phase_lock true (1 row)';
  ELSE
    SELECT deadline_rule, gates, phase_lock INTO v_rule, v_gates, v_lock FROM public.job_registry WHERE job = 'ec-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' AND v_lock THEN
      RAISE NOTICE '[fix1349] job_registry ec-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 24 hours) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1349] job_registry ec-vacuum-analyze reads % / gates % / phase_lock %, expected at 30 4 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates, v_lock;
    END IF;
  END IF;

  UPDATE public.job_registry
     SET deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours',
         gates         = '{prod_session}',
         phase_lock    = true,
         note          = note || '; MOVED by cc-249 (FIX-1349) from at 50 4 * * *',
         updated_at    = now()
   WHERE job = 'fe-vacuum-analyze'
     AND deadline_rule = 'at 50 4 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1349] job_registry fe-vacuum-analyze: at 50 4 * * * → dead_tuples > 60%% of trigger + floor 24 hours, gates {prod_session}, phase_lock true (1 row)';
  ELSE
    SELECT deadline_rule, gates, phase_lock INTO v_rule, v_gates, v_lock FROM public.job_registry WHERE job = 'fe-vacuum-analyze';
    IF v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' AND v_gates = '{prod_session}' AND v_lock THEN
      RAISE NOTICE '[fix1349] job_registry fe-vacuum-analyze already moved (dead_tuples > 60%% of trigger + floor 24 hours) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1349] job_registry fe-vacuum-analyze reads % / gates % / phase_lock %, expected at 50 4 * * * or the moved rule',
        COALESCE(v_rule, '(no row)'), v_gates, v_lock;
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
  FOREACH v_job IN ARRAY ARRAY['ec-vacuum-analyze', 'fe-vacuum-analyze'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1349] % cron.job rows named % — expected exactly 1; refusing to park by a name that does not resolve', v_n, v_job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := false);
      RAISE NOTICE '[fix1349] cron % (jobid %) parked — the registry owns it', v_job, v_jobid;
    ELSE
      RAISE NOTICE '[fix1349] cron % (jobid %) already parked — no-op', v_job, v_jobid;
    END IF;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_rule    constant text := 'dead_tuples > 60% of trigger + floor 24 hours';
  v_missing text[] := '{}';
  v_moves   text[][] := ARRAY[['ec-vacuum-analyze', 'ec',        'public.entity_connections'],
                              ['fe-vacuum-analyze', 'fe-totals', 'public.financial_entities']];
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
  v_statvac timestamptz;
  v_reaped  timestamptz;
  v_lastvac timestamptz;
  v_trigger numeric;
  v_line    text := '';
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_reg     text;
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
    IF v_r.phase_lock IS DISTINCT FROM true THEN
      v_missing := v_missing || format('%s phase_lock %s, expected true', v_job, v_r.phase_lock);
    END IF;
    -- phase_due_at is the dispatcher's to write (its first floor arm). The move
    -- leaves it NULL; only an arm since the move may have set it.
    IF v_r.phase_due_at IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.dispatch_log x
          WHERE x.job = v_job AND x.decision = 'armed' AND x.ticked_at >= v_r.updated_at) THEN
      v_missing := v_missing || format('%s phase_due_at %s with no arm since the move', v_job, v_r.phase_due_at);
    END IF;
    -- Nothing else on the row moved.
    IF v_r.runner IS DISTINCT FROM 'pg_cron' OR v_r.unit_shape IS DISTINCT FROM 'bare'
       OR v_r.priority IS DISTINCT FROM 4 OR v_r.cost_class IS DISTINCT FROM 'io'
       OR v_r.cap_mb IS DISTINCT FROM 64 OR v_r.exclusion_group IS DISTINCT FROM v_group
       OR v_r.budget_seconds IS NOT NULL THEN
      v_missing := v_missing || format('%s columns moved: runner %s, shape %s, priority %s, class %s, cap %s, group %s, budget %s',
                                       v_job, v_r.runner, v_r.unit_shape, v_r.priority, v_r.cost_class,
                                       v_r.cap_mb, v_r.exclusion_group, v_r.budget_seconds);
    END IF;

    -- The pick's own VACUUM-target extraction (the census reg CTE).
    v_rel := to_regclass(substring(v_r.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'));
    IF v_rel IS DISTINCT FROM v_relname::regclass THEN
      v_missing := v_missing || format('%s unit_call %L resolves to %s, expected %s', v_job, v_r.unit_call, v_rel, v_relname);
    END IF;

    -- The pick's own parser, identical literal: groups 60 / 24 hours.
    v_m := regexp_match(v_r.deadline_rule,
             '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
    IF v_m IS NULL THEN
      v_missing := v_missing || format('%s: the pick regex does not match the rule', v_job);
    ELSE
      IF v_m[1]::numeric IS DISTINCT FROM 60 THEN
        v_missing := v_missing || format('%s pct group %s, expected 60', v_job, v_m[1]);
      END IF;
      v_iv := v_m[2]::interval;
      IF v_iv IS DISTINCT FROM interval '24 hours' THEN
        v_missing := v_missing || format('%s floor group %s, expected 24 hours', v_job, v_m[2]);
      END IF;
    END IF;

    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_jobid IS NULL OR v_active THEN
      v_missing := v_missing || format('cron %s inactive (jobid %s, active %s)', v_job, v_jobid, v_active);
    END IF;

    -- Printed, not asserted: the pick's arithmetic (N2, the dead_tuples branch).
    IF v_rel IS NOT NULL AND v_m IS NOT NULL THEN
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
      v_line := v_line || format('; %s: trigger %s, 60%% line %s, n_dead_tup %s, anchor %s (stats %s, reaped %s) → %s',
        v_job, round(v_trigger, 1), round(v_trigger * 0.6), COALESCE(v_dead::text, 'NULL'),
        COALESCE(v_lastvac::text, 'NULL'), COALESCE(v_statvac::text, 'NULL'), COALESCE(v_reaped::text, 'NULL'),
        CASE WHEN v_dead >= v_trigger * 0.6 THEN 'DUE NOW (pct)'
             WHEN v_lastvac IS NULL THEN 'DUE NOW (null anchor, FIX-1326)'
             ELSE 'floor due ' || (v_lastvac + v_iv)::text END);
    END IF;
  END LOOP;

  -- officials and dpr stay on cron: untouched rows, active crons.
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

  -- No routine moved: the N2 pair (cc-243, 20261023000000) + prod_op_gate (FIX-1342).
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc
   WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM '7b4e3f66105a49d030c41539e4cd2d56' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s, expected the N2 body', v_md5_d);
  END IF;
  IF v_md5_g IS DISTINCT FROM '2716fcca9ba97b683963cd499bc78136' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected the N2 body', v_md5_g);
  END IF;
  IF v_md5_p IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' THEN
    v_missing := v_missing || format('prod_op_gate md5 %s, expected the FIX-1342 body', v_md5_p);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1349] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT format('rows %s, eligible %s', count(*),
                count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'
                                   AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')))
    INTO v_reg FROM public.job_registry j;
  RAISE NOTICE '[fix1349] read-back ok: ec-vacuum-analyze + fe-vacuum-analyze % (pct 60, floor 24 hours), gates {prod_session}, phase_lock true, targets public.entity_connections / public.financial_entities, both crons inactive; officials + dpr unmoved; registry %',
    c_rule, v_reg || v_line;
  RAISE NOTICE '[fix1349] md5 dispatch_one_unit % / get_dispatcher_status % / prod_op_gate %', v_md5_d, v_md5_g, v_md5_p;
END $$;
