-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1194 P1-A — the three heavy rollups read the box before their work, and
-- between their units where they have units. cc-183.
--
-- Design of record: design-fix1194-forker-starvation-2026-09-19 §3 P1-A / §4 /
-- §6 step 3, as corrected by the 2026-10-01 census and Craig's D1–D4 (ratified
-- 2026-10-01 18:04 PDT). P1-B (box_is_saturated, 20260920130000) is the sensor
-- this consumes; P2-A (20260920070000) is the watchdog that cancels what this
-- does not stop.
--
-- ── WHAT CHANGES ──────────────────────────────────────────────────────────────
--
-- 1. box_is_saturated() gains p_include_watchdog_wall boolean DEFAULT true.
--    The rule order is unchanged; the watchdog_wall rule is skipped when false;
--    readings.thresholds gains watchdog_wall_considered. A trailing argument is
--    a NEW signature, so the 3-arg function is DROPPED and the 4-arg one created
--    — two overloads would make a bare box_is_saturated() ambiguous. Callers,
--    read 2026-10-03 (rule 122): none in prod's pg_proc.prosrc or
--    cron.job.command; prod_op_gate() reads the walls itself; the app only
--    names it in comments; the probe test passes three positional arguments,
--    which resolve to the 4-arg function. The default keeps every answer.
--    WHY the gates pass false (D2): the 1.0 s wall is not a backoff input.
--    Healthy hours exceed it (cc-147: 8 of 17, up to 10.2 s), and a bounded op
--    drives it to 1.3 s as ordinary I/O (cc-151) — a gate on it would stop the
--    rollup under the rollup's own healthy load. The gates read `stale` and
--    `fork_failures` only. The memory half stays report-only.
--
-- 2. box_backoff_gate(p_job, p_wait_max_s) — the shared START gate. Polls
--    box_is_saturated(p_include_watchdog_wall := false) every 60 s until clear
--    or p_wait_max_s; returns {job, clear, reason, age_seconds, waited_s,
--    wait_max_s, polls, readings}. civitics.box_gate_wait_max_s, when set,
--    overrides p_wait_max_s (0–3,600; unset = the argument) — the clone tests
--    run with 5.
--    Each procedure now runs gate → lock → defer → work, so a waiting firing
--    never holds its advisory lock against the next one. The wait does hold a
--    snapshot (a function's outer statement keeps one active), i.e. an xmin
--    horizon for at most p_wait_max_s, and only on a saturated box. The
--    contract-flow rebuild already holds one for its whole ~1,900 s
--    transaction every Thursday, so 1,800 s is inside what the box carries.
--
-- 3. donor_rollup_rebuild_bulk() — rebuilt on the PROD body (byte-equal to
--    20260927020000_fix918_primary_industry_tag:532-1175, read 2026-10-03),
--    additions only, plus the running row's metadata line split in two:
--      (i)  the START gate, 600 s, after the start-window refusal and before
--           the lock. Not clear → `skipped`, skip_reason 'box saturated after
--           N s: <reason>'. A wait that crosses the 13:00 UTC cutoff hands the
--           decision back to the start-window refusal (its text, plus `gate`).
--      (ii) per chunk, after the budget guard and before the chunk's work:
--           box_is_saturated(p_include_watchdog_wall := false); saturated →
--           EXIT → `partial`, 'box saturated (<reason>) — resumable at chunk k
--           of n', metadata backoff_reason + backoff_readings. The cursor is
--           already committed with every chunk, so the next firing resumes.
--    The budget guard, the cancel handler, the caught-up exit and the lock are
--    unchanged. `gate` lands in the running row only when the gate waited.
--
-- 4. refresh_contract_flow_rollups() — rebuilt on the PROD body (byte-equal to
--    20260930010000_fix1252_fix1245:482-684, read 2026-10-03 — cc-176's, NOT
--    fix838's):
--      * the START gate, 1,800 s. A weekly job: a skip costs a week of
--        freshness (FIX-1140 counts only `complete`), so it waits first.
--      * a `running` row INSERTed and COMMITted before the work, so a budget
--        cancel leaves a visible row (09-17: 5,892 s, 41 fork failures, no row
--        at all). The two DELETE+INSERT pairs and the pipeline_state flip run
--        in ONE sub-block — a cancel or an error still rolls back both tables
--        together — with WHEN query_canceled (stamp `failed`, canceled, the
--        table in flight, elapsed) and WHEN OTHERS (stamp `failed`, then
--        re-raise, so the job still fails in cron.job_run_details as before).
--        Success UPDATEs the running row to `complete` with {recipients,
--        agency_sectors}, in the same transaction as the writes.
--      * the advisory lock: xact → SESSION, same key, taken AFTER the gate and
--        released at every exit — an xact lock dies at the first COMMIT.
--      * the proconfig `SET search_path TO 'public', 'pg_temp'` is REMOVED. A
--        routine carrying any SET clause runs atomic and cannot COMMIT
--        (FIX-1128). The cc-183 prompt said this procedure had none; prod's
--        pg_proc.proconfig says it does. Every relation and function the body
--        names is public.-qualified or pg_catalog, as in the two COMMITting
--        siblings below, which never carried one.
--      * the statements inside the sub-block are byte-identical and NOT
--        re-indented (+0/-0 on those lines; the FIX-1254 CASE copies are
--        untouched). Its pipeline_state now() is now the work transaction's
--        start, milliseconds after the entry.
--    FIX-1063's cron_job_budget note ("Only target with no COMMIT in its
--    procedure") becomes false. The note is Craig's text and is left alone.
--
-- 5. refresh_agency_staffing_rollup() — rebuilt on the PROD body (byte-equal to
--    20260911000100_fix950_guards_rollup_family:2863-3050, read 2026-10-03):
--    the START gate (600 s) before the lock; the chunk loop reads
--    box_is_saturated(false) before each chunk and EXITs into the existing
--    partial close with backoff_reason. No cursor: the watermark is NOT
--    advanced on a backoff (the FIX-1028 rule for a cancel), so the next
--    firing redoes the whole dirty set — a ~40 s job on prod.
--
-- ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────────────
--
-- No new job and no cron_job_budget row (rule 120). Budgets stay 9,000 / 9,000
-- / 3,600 s and a gate wait counts against them: 600 + the 7,200 s internal
-- budget < 9,000; 1,800 + ~1,900 < 9,000; 600 + ~40 < 3,600.
-- enforce_cron_job_budgets() selects on cron.job_run_details, never on these
-- data_sync_log rows, and cancels with pg_cancel_backend — which is what makes
-- the query_canceled handlers fire. record_box_health() is untouched; its
-- service_role revoke shipped in 20260920150000 (prod ACL postgres only, read
-- 2026-10-03). No data statement and no CALL: metadata DDL only (rule 155).
--
-- Vocabulary: the new skip_reason starts 'box saturated', never 'prod session
-- held' (SESSION_HOLD_PREFIX). Statuses are the ones already in use.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. box_is_saturated() — p_include_watchdog_wall
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.box_is_saturated(int, int, timestamptz);

CREATE OR REPLACE FUNCTION public.box_is_saturated(
  p_stale_seconds          int         DEFAULT 180,
  p_fork_failures_10m      int         DEFAULT 3,
  p_now                    timestamptz DEFAULT clock_timestamp(),
  p_include_watchdog_wall  boolean     DEFAULT true
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_watchdog_wall_s CONSTANT numeric := 1.0;
  v_bh      jsonb;
  v_mem     jsonb;
  v_age     int;
  v_mem_age int;
  v_wall    numeric;
  v_to10    int;
  v_reason  text;
  v_memory  jsonb := NULL;
  v_walls   boolean := COALESCE(p_include_watchdog_wall, true);
BEGIN
  SELECT value INTO v_bh  FROM public.pipeline_state WHERE key = 'box_health';
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';

  v_age  := round(EXTRACT(epoch FROM (p_now - (v_bh->>'at')::timestamptz)))::int;
  v_to10 := (v_bh->>'startup_timeouts_10m')::int;
  v_wall := GREATEST((v_bh->'watchdog_max_wall_10m'->>'budget')::numeric,
                     (v_bh->'watchdog_max_wall_10m'->>'unit')::numeric);

  IF v_age IS NULL OR v_age > p_stale_seconds THEN
    v_reason := 'stale';
  ELSIF v_to10 >= p_fork_failures_10m THEN
    v_reason := 'fork_failures';
  ELSIF v_walls AND v_wall > c_watchdog_wall_s THEN
    v_reason := 'watchdog_wall';
  ELSE
    v_reason := 'clear';
  END IF;

  IF v_mem IS NOT NULL THEN
    v_mem_age := round(EXTRACT(epoch FROM (p_now - (v_mem->>'at')::timestamptz)))::int;
    v_memory := jsonb_build_object(
      'age_seconds',      v_mem_age,
      'mem_available_mb', round((v_mem->>'mem_available_bytes')::numeric / 1048576),
      'mem_total_mb',     round((v_mem->>'mem_total_bytes')::numeric / 1048576),
      'available_pct',    round(100 * (v_mem->>'mem_available_bytes')::numeric
                                    / NULLIF((v_mem->>'mem_total_bytes')::numeric, 0), 1),
      'swap_used_mb',     round(((v_mem->>'swap_total_bytes')::numeric
                                 - (v_mem->>'swap_free_bytes')::numeric) / 1048576),
      'load1',            v_mem->'load1');
  END IF;

  RETURN jsonb_build_object(
    'saturated',   v_reason <> 'clear',
    'reason',      v_reason,
    'age_seconds', v_age,
    'readings',    jsonb_build_object(
      'probe',      v_bh,
      'memory',     v_memory,
      'thresholds', jsonb_build_object(
        'stale_seconds',            p_stale_seconds,
        'fork_failures_10m',        p_fork_failures_10m,
        'watchdog_wall_s',          c_watchdog_wall_s,
        'watchdog_wall_considered', v_walls,
        'memory',                   'report-only — no threshold until a week of data sizes one')));
END;
$function$;

REVOKE ALL ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) IS
  'FIX-1194 P1-B / P1-A — is the box saturated right now? {saturated, reason: stale|fork_failures|watchdog_wall|clear, '
  'age_seconds, readings{probe, memory, thresholds}}. A stale or absent box_health stamp IS saturation (the probe '
  'is a pg_cron firing and goes dark with the forker). p_include_watchdog_wall := false skips the 1.0 s wall rule '
  '— the three rollup gates call it that way (cc-183 D2: the wall is not a backoff input). memory is REPORT-ONLY: '
  'returned in readings, never in saturated. p_now is for tests.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. box_backoff_gate() — the shared START gate
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.box_backoff_gate(
  p_job        text,
  p_wait_max_s int
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_poll_s  CONSTANT int := 60;
  v_cfg     int;
  v_max     int := GREATEST(COALESCE(p_wait_max_s, 0), 0);
  v_started timestamptz := clock_timestamp();
  v_waited  double precision := 0;
  v_polls   int := 0;
  v_sat     jsonb;
BEGIN
  -- Break-glass / test override. Unset (the default everywhere) = the argument.
  v_cfg := NULLIF(current_setting('civitics.box_gate_wait_max_s', true), '')::int;
  IF v_cfg IS NOT NULL THEN
    v_max := GREATEST(0, LEAST(v_cfg, 3600));
  END IF;

  LOOP
    v_sat    := public.box_is_saturated(p_include_watchdog_wall := false);
    v_polls  := v_polls + 1;
    v_waited := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    EXIT WHEN NOT (v_sat->>'saturated')::boolean OR v_waited >= v_max;
    RAISE NOTICE '[box gate] % — box saturated (%), waited % of % s',
      p_job, v_sat->>'reason', round(v_waited)::int, v_max;
    PERFORM pg_sleep(LEAST(c_poll_s, v_max - v_waited));
  END LOOP;

  RETURN jsonb_build_object(
    'job',         p_job,
    'clear',       NOT (v_sat->>'saturated')::boolean,
    'reason',      v_sat->>'reason',
    'age_seconds', v_sat->'age_seconds',
    'waited_s',    round(v_waited)::int,
    'wait_max_s',  v_max,
    'polls',       v_polls,
    'readings',    v_sat->'readings');
END;
$function$;

REVOKE ALL ON FUNCTION public.box_backoff_gate(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.box_backoff_gate(text, int) TO service_role;

COMMENT ON FUNCTION public.box_backoff_gate(text, int) IS
  'FIX-1194 P1-A — the START gate of the three heavy rollups. Polls box_is_saturated(p_include_watchdog_wall := false) '
  'every 60 s until clear or p_wait_max_s (civitics.box_gate_wait_max_s overrides, 0-3600). Returns {job, clear, reason, '
  'age_seconds, waited_s, wait_max_s, polls, readings}. Holds no lock; call it BEFORE taking one.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. donor_rollup_rebuild_bulk() — start gate + per-chunk backoff (jobid 24)
-- ═══════════════════════════════════════════════════════════════════════════

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
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. refresh_contract_flow_rollups() — start gate, running row, cancel handler (jobid 28)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
  -- FIX-979: real entry time. FIX-1194: the procedure now COMMITs its running
  -- row first, so now() would be the WORK transaction's start, not the entry.
  v_started    timestamptz := clock_timestamp();
  -- FIX-1194 P1-A — a SESSION advisory lock (was an xact lock on the same
  -- key): the running row's COMMIT would release an xact lock mid-run.
  c_lock_key   bigint := hashtext('contract_flow_rollups_rebuild')::bigint;
  v_gate       jsonb;
  v_log_id     uuid;
  v_stage      text := NULL;   -- the table in flight, for the cancel stamp
  v_canceled   text := NULL;
  v_failed     text := NULL;
  v_sqlstate   text := NULL;
BEGIN
  -- FIX-1194 P1-A — the START gate: wait up to 1,800 s for a box that is
  -- neither stale nor failing forks (D2). A weekly job: a skip costs a week of
  -- freshness (FIX-1140 counts only `complete`), so it waits before it skips.
  -- BEFORE the lock, so a waiting firing holds nothing.
  v_gate := public.box_backoff_gate('contract-flow-rollups-refresh', 1800);
  IF NOT (v_gate->>'clear')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('contract_flow_rollups_rebuild', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'skip_reason', format('box saturated after %s s: %s', v_gate->>'waited_s', v_gate->>'reason'),
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[contract-flow rollups] box saturated (%) after % s — skipping (FIX-1194)',
      v_gate->>'reason', v_gate->>'waited_s';
    RETURN;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
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
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  -- FIX-1194 P1-A — the running row, COMMITted before the work, so a budget
  -- cancel (enforce_cron_job_budgets → pg_cancel_backend) leaves a visible row
  -- instead of rolling back to nothing (09-17: 5,892 s, no row at all).
  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'running', v_started,
          CASE WHEN (v_gate->>'waited_s')::int > 0
               THEN jsonb_build_object('gate', v_gate) ELSE '{}'::jsonb END)
  RETURNING id INTO v_log_id;
  COMMIT;

  -- FIX-1194 P1-A — the rebuild in ONE sub-block: a cancel or an error rolls
  -- back both tables and the state flip together, as the single transaction
  -- did. The statements inside are byte-identical to the prod body and are
  -- deliberately NOT re-indented (rule 34: +0/-0 on the aggregation lines).
  BEGIN
  v_stage := 'contract_recipient_rollup';

  -- Recipient rollup: top-500 recipients — byte-identical to
  -- treemap_recipients_by_contracts_full(500). One deterministic industry per
  -- recipient (FIX-873) → 500 distinct entity_ids, no fan-out.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  recipient_codes AS (
    -- FIX-1252: dollars and rows per (recipient, NAICS code), one heap pass.
    SELECT fr.to_id                    AS entity_id,
           fr.metadata->>'naics_code'  AS naics_code,
           SUM(fr.amount_cents)        AS code_cents,
           COUNT(*)                    AS code_rows
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
      AND fr.to_type = 'financial_entity'
    GROUP BY fr.to_id, fr.metadata->>'naics_code'
  ),
  recipients AS (
    -- FIX-1252: one row per recipient; its code is the dominant one.
    SELECT rc.entity_id,
           SUM(rc.code_cents)::BIGINT AS total_cents,
           SUM(rc.code_rows)::BIGINT  AS award_count,
           (array_agg(rc.naics_code ORDER BY rc.code_cents DESC, rc.code_rows DESC, rc.naics_code)
              FILTER (WHERE rc.naics_code IS NOT NULL))[1] AS naics_code
    FROM recipient_codes rc
    GROUP BY rc.entity_id
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    -- FIX-1247: the chord's NAICS fallback, on the code this row reports.
    COALESCE(
      ri.display_label,
      CASE SUBSTRING(r.naics_code FROM 1 FOR 2)
        WHEN '11' THEN 'Agriculture & Food'
        WHEN '21' THEN 'Mining & Metals'
        WHEN '22' THEN 'Utilities'
        WHEN '23' THEN 'Construction'
        WHEN '31' THEN 'Manufacturing'
        WHEN '32' THEN 'Manufacturing'
        WHEN '33' THEN 'Manufacturing'
        WHEN '42' THEN 'Wholesale Trade'
        WHEN '44' THEN 'Consumer Goods & Services'
        WHEN '45' THEN 'Consumer Goods & Services'
        WHEN '48' THEN 'Transportation'
        WHEN '49' THEN 'Transportation'
        WHEN '51' THEN 'Technology & Communications'
        WHEN '52' THEN 'Finance & Insurance'
        WHEN '53' THEN 'Real Estate & Construction'
        WHEN '54' THEN 'Professional Services'
        WHEN '55' THEN 'Management'
        WHEN '56' THEN 'Administrative Services'
        WHEN '61' THEN 'Education'
        WHEN '62' THEN 'Health Care'
        WHEN '71' THEN 'Arts & Entertainment'
        WHEN '72' THEN 'Hospitality'
        WHEN '81' THEN 'Other Services'
        WHEN '92' THEN 'Government'
        ELSE 'Other'
      END,
      'Other'
    ),
    r.naics_code,
    r.total_cents,
    r.award_count
  FROM recipients r
  JOIN public.financial_entities fe
    ON fe.id = r.entity_id
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  ORDER BY r.total_cents DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  v_stage := 'contract_agency_sector_rollup';
  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.display_label,
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture & Food'
          WHEN '21' THEN 'Mining & Metals'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Consumer Goods & Services'
          WHEN '45' THEN 'Consumer Goods & Services'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Technology & Communications'
          WHEN '52' THEN 'Finance & Insurance'
          WHEN '53' THEN 'Real Estate & Construction'
          WHEN '54' THEN 'Professional Services'
          WHEN '55' THEN 'Management'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Health Care'
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

  v_stage := 'pipeline_state';
  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_stage, SQLERRM);
      RAISE WARNING '[contract-flow rollups] CANCELED during % (statement_timeout, budget or operator cancel): %',
        v_stage, SQLERRM;
    WHEN OTHERS THEN
      v_failed   := format('%s: %s', v_stage, SQLERRM);
      v_sqlstate := SQLSTATE;
      RAISE WARNING '[contract-flow rollups] FAILED during %: %', v_stage, SQLERRM;
  END;

  -- FIX-1194 P1-A — the cancel / failure close. Both tables are as they were
  -- before this run (the sub-block rolled back); the row says which table was
  -- in flight and for how long.
  IF v_canceled IS NOT NULL OR v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(),
           error_message = left(CASE WHEN v_canceled IS NOT NULL
                                     THEN 'canceled — ' || v_canceled ELSE v_failed END, 1000),
           metadata = metadata || jsonb_build_object(
             'canceled', v_canceled IS NOT NULL,
             'cancel_detail', v_canceled,
             'stage_in_flight', v_stage,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    IF v_failed IS NOT NULL THEN
      -- An error still fails the job in cron.job_run_details, as it did before.
      RAISE EXCEPTION '[contract-flow rollups] %', v_failed USING ERRCODE = v_sqlstate;
    END IF;
    RETURN;
  END IF;

  -- FIX-979: clock_timestamp(), not now(). runid 130 ran 7,125.6 s and reported
  -- 0.000000 because both columns were the same frozen transaction_timestamp().
  -- FIX-1194: the running row closes in the SAME transaction as the writes.
  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(),
         rows_inserted = v_recipients + v_flows,
         metadata = metadata || jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows)
   WHERE id = v_log_id;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. refresh_agency_staffing_rollup() — start gate + per-chunk backoff (jobid 25)
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- FIX-1194 P1-A — the start gate's answer, each chunk boundary's reading,
  -- and the reading that stopped the loop (NULL = the box did not stop it).
  v_gate     jsonb;
  v_sat      jsonb;
  v_backoff  jsonb := NULL;
BEGIN
  -- FIX-1194 P1-A — the START gate: wait up to 600 s for a box that is neither
  -- stale nor failing forks (D2). BEFORE the lock, so a waiting firing holds
  -- nothing.
  v_gate := public.box_backoff_gate('agency-staffing-rollup-refresh', 600);
  IF NOT (v_gate->>'clear')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('agency_staffing_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'skip_reason', format('box saturated after %s s: %s', v_gate->>'waited_s', v_gate->>'reason'),
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[agency-staffing refresh] box saturated (%) after % s — skipping (FIX-1194)',
      v_gate->>'reason', v_gate->>'waited_s';
    RETURN;
  END IF;

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
    -- FIX-1194 P1-A — back off at the chunk boundary on a stale probe or
    -- failing forks (D2). No cursor: the watermark stays put below, so the
    -- next firing redoes the whole dirty set — a ~40 s job.
    v_sat := public.box_is_saturated(p_include_watchdog_wall := false);
    IF (v_sat->>'saturated')::boolean THEN
      v_backoff := v_sat;
      RAISE NOTICE '[agency-staffing refresh] box saturated (%) — backing off before chunk %',
        v_sat->>'reason', v_chunk_no + 1;
      EXIT;
    END IF;
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
  -- FIX-1194 P1-A — a box backoff has not covered its set either.
  IF v_canceled IS NULL AND v_backoff IS NULL THEN
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
          CASE WHEN v_canceled IS NOT NULL OR v_backoff IS NOT NULL THEN 'partial' ELSE 'complete' END,
          v_started, clock_timestamp(), v_rows,
          CASE WHEN v_canceled IS NOT NULL
               THEN left(format('canceled — %s', v_canceled), 1000)
               WHEN v_backoff IS NOT NULL
               THEN format('box saturated (%s) — %s of %s chunks done; no cursor, the next firing redoes the whole dirty set',
                      v_backoff->>'reason', v_chunk_no, ceil(v_n::numeric / c_chunk)::int)
               ELSE NULL END,
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
            'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
          -- FIX-1194 P1-A — what the box read when it stopped the loop, and the
          -- start gate only when it actually waited.
          || CASE WHEN v_backoff IS NOT NULL
                  THEN jsonb_build_object('backoff_reason', v_backoff->>'reason',
                                          'backoff_readings', v_backoff->'readings',
                                          'resumable', false)
                  ELSE '{}'::jsonb END
          || CASE WHEN (v_gate->>'waited_s')::int > 0
                  THEN jsonb_build_object('gate', v_gate) ELSE '{}'::jsonb END);

  RAISE NOTICE '[agency-staffing refresh] % (mode=%) — % agencies in % chunks',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_backoff IS NOT NULL THEN 'BACKED OFF' ELSE 'complete' END,
    v_mode, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_agency_staffing_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup() TO service_role;
