-- FIX-1194 P1-B — the box_health probe: a */1 pg_cron firing that stamps what
-- the forker and the watchdogs look like, every minute, whose STALENESS is the
-- signal. Plus box_is_saturated() to read it, and FIX-1125's on-box mirror of
-- the memory series (record_box_health_mem(), called by /api/cron/box-health).
--
-- Design of record: claude/design-fix1194-forker-starvation-2026-09-19.md §3
-- P1-B (ratified 09-20), §4 ("probe first, gates second"), §7 ("a memory
-- reading would live in the P1-B probe"). cc-149 D1 + D2(b).
--
-- ── WHY A PROBE, AND WHY ITS SILENCE IS THE READING ─────────────────────────
--
-- The failure FIX-1194 is about stops pg_cron from STARTING work: a firing that
-- cannot get a connection fails `job startup timeout` after ~10 s and does
-- nothing (cron.use_background_workers is OFF on prod, read 2026-09-24, so a
-- firing is a libpq connection the postmaster must fork — connection-accept
-- pressure, not bgworker slots). The forker's own failures are the most honest
-- IOWait proxy this box has, and this probe is itself a pg_cron firing: it goes
-- dark exactly when the box is saturated. So `at` is written on EVERY firing
-- (rule 129 — a timestamp written only on a value change is a change proxy and
-- its silence proves nothing), and box_is_saturated() inverts it:
-- age > p_stale_seconds ⇒ saturated, reason 'stale'.
--
-- ── WHAT THE STAMP CARRIES ──────────────────────────────────────────────────
--
--   pipeline_state.box_health = {
--     at,                          -- the firing's clock; the liveness
--     startup_timeouts_10m / _60m, -- the forker's failures, every job
--     watchdog_max_wall_10m: {budget, unit},  -- the two */2 jobs BY NAME
--     watchdog_runs_10m:     {budget, unit},  -- (cc-147: 0.014 → 1.341 s is
--                                             --  the leading-indicator series)
--     running_budgeted_jobs, running_over_budget, oldest_running_s,
--     backends: {client, active, idle_in_txn, lock_waiting, longest_active_s,
--                max_connections},
--     probe_ms }                   -- this firing's own cost
--
-- The startup-timeout predicate is REUSED, not re-derived (rule 93 — one
-- predicate): `d.status = 'failed' AND d.return_message ILIKE '%startup
-- timeout%'`, byte-identical to prod_op_gate() (20260920120000) and
-- check_cron_job_health(); a unit test greps both files for it. The wall is
-- COALESCE(end_time, now) - start_time over every row, startup timeouts
-- included, exactly as prod_op_gate's (d) reads it.
--
-- ── COST (rule 97: measured before budgeting) ───────────────────────────────
--
-- cron.job_run_details on prod, 2026-09-24 01:35 UTC: 62,052 rows since
-- 2026-06-29, 11 MB, ONE index (the runid pkey) — `start_time` is NOT indexed
-- and there is no retention job. Measured on prod, read-only:
--   the startup-timeout predicate as prod_op_gate writes it:  75.0 ms seq scan
--     (the planner evaluates the ILIKE FIRST, on all 62,052 rows)
--   the */2 wall read, start_time filter only:                 9.5 ms per scan
--   running budgeted jobs:                                      9.0 ms
-- Three reads as written would be ~103 ms — over the < 100 ms target. So this
-- function scans the table ONCE: a MATERIALIZED CTE filtered by start_time
-- alone (1 day, ~1,600 rows today), with the startup-timeout predicate
-- evaluated in its select list over those rows only. Every other read is over
-- the CTE. Measured cost is in the cc-149 report.
--
-- The cost has a clock on it, and that is stated rather than hidden: this job
-- adds 1,440 rows/day to cron.job_run_details (~1,610/day today → ~3,050/day)
-- and nothing purges it. Every seq-scan reader of that table — this probe,
-- prod_op_gate(), check_cron_job_health(), the receipts' forker queries — grows
-- with it. A retention job is the durable answer; it is not this migration's.
--
-- ── pipeline_state WRITE VOLUME ─────────────────────────────────────────────
--
-- 1,440 upserts/day here + 720/day from record_box_health_mem() on ONE row each,
-- rewritten in place. pipeline_state carries FIX-1003b's threshold-led
-- reloptions (threshold 20, scale 0.05); prod 2026-09-24: 39 live, 14 dead,
-- 3,198 updates / 116 autovacuums since the 09-15 epoch (~355 updates/day plus
-- FIX-1208's 720). This roughly triples the table's update rate again, from a
-- base of a couple of heap pages; each autovacuum cycle is milliseconds. The
-- 1208 header did the same math for the same shape.
--
-- ── NOT HERE ────────────────────────────────────────────────────────────────
--
-- No consumer. P1-A (the backoff gate in the three 9,000 s rollups) reads
-- box_is_saturated() at unit boundaries — a later prompt. No memory THRESHOLD:
-- the memory reading is returned in `readings` and never sets `saturated`
-- until a week of data sizes it (rule 97). No on-box sample table (cc-149 D5).
--
-- rule 120: the job is single-statement (a FUNCTION, no COMMIT), so it gets a
-- cron_job_budget row at creation — 60 s, the cadence. fix1128: every SET
-- clause below is search_path only; there is no transaction control, so
-- proconfig is legal, and no statement_timeout, which would be inert.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. record_box_health() — the probe body. Runs as `postgres` under pg_cron.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_box_health(
  p_now timestamptz DEFAULT clock_timestamp()
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_t0     timestamptz := clock_timestamp();
  v_to10   int;
  v_to60   int;
  v_wall   jsonb;
  v_runs   jsonb;
  v_rb     int;
  v_rob    int;
  v_old    int;
  v_back   jsonb;
  v_value  jsonb;
BEGIN
  -- ONE scan of cron.job_run_details (see the header's cost section), and
  -- every cron reading below comes off it in this one statement. The probe's
  -- own row is excluded by pid: pg_cron runs this firing on a libpq connection
  -- whose backend is pg_backend_pid(), and that row reads 'running'.
  WITH d AS MATERIALIZED (
    SELECT d.jobid, d.job_pid, d.status, d.start_time, d.end_time,
           (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%') AS startup_timeout
      FROM cron.job_run_details d
     WHERE d.start_time >  p_now - interval '1 day'
       AND d.start_time <= p_now
  ),
  wd AS (
    SELECT CASE j.jobname WHEN 'cron-job-budget-watchdog'  THEN 'budget'
                          WHEN 'derived-mvs-unit-watchdog' THEN 'unit' END AS k,
           count(d.jobid) FILTER (WHERE d.start_time > p_now - interval '10 minutes') AS runs_10m,
           round(max(EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))
                   FILTER (WHERE d.start_time > p_now - interval '10 minutes')::numeric, 3) AS max_wall_10m_s
      FROM cron.job j
      LEFT JOIN d ON d.jobid = j.jobid
     WHERE j.jobname IN ('cron-job-budget-watchdog', 'derived-mvs-unit-watchdog')
     GROUP BY j.jobname
  ),
  run AS (
    SELECT count(b.jobname)::int AS running_budgeted,
           (count(*) FILTER (WHERE EXTRACT(epoch FROM (p_now - d.start_time)) > b.budget_seconds))::int
                                                                         AS running_over_budget,
           round(max(EXTRACT(epoch FROM (p_now - d.start_time))))::int  AS oldest_running_s
      FROM d
      JOIN cron.job j ON j.jobid = d.jobid
      LEFT JOIN public.cron_job_budget b ON b.jobname = j.jobname
     WHERE d.status = 'running'
       AND d.job_pid IS DISTINCT FROM pg_backend_pid()
  )
  SELECT (SELECT count(*) FILTER (WHERE startup_timeout AND start_time > p_now - interval '10 minutes') FROM d),
         (SELECT count(*) FILTER (WHERE startup_timeout AND start_time > p_now - interval '60 minutes') FROM d),
         (SELECT COALESCE(jsonb_object_agg(k, max_wall_10m_s), '{}'::jsonb) FROM wd WHERE k IS NOT NULL),
         (SELECT COALESCE(jsonb_object_agg(k, runs_10m), '{}'::jsonb) FROM wd WHERE k IS NOT NULL),
         run.running_budgeted, run.running_over_budget, run.oldest_running_s
    INTO v_to10, v_to60, v_wall, v_runs, v_rb, v_rob, v_old
    FROM run;

  SELECT jsonb_build_object(
           'client',           count(*),
           'active',           count(*) FILTER (WHERE a.state = 'active'),
           'idle_in_txn',      count(*) FILTER (WHERE a.state LIKE 'idle in transaction%'),
           'lock_waiting',     count(*) FILTER (WHERE a.wait_event_type = 'Lock'),
           'longest_active_s', round(max(EXTRACT(epoch FROM (p_now - a.query_start)))
                                       FILTER (WHERE a.state = 'active' AND a.pid <> pg_backend_pid())),
           'max_connections',  current_setting('max_connections')::int)
    INTO v_back
    FROM pg_stat_activity a
   WHERE a.backend_type = 'client backend';

  v_value := jsonb_build_object(
    'at',                    p_now,
    'startup_timeouts_10m',  v_to10,
    'startup_timeouts_60m',  v_to60,
    'watchdog_max_wall_10m', v_wall,
    'watchdog_runs_10m',     v_runs,
    'running_budgeted_jobs', v_rb,
    'running_over_budget',   v_rob,
    'oldest_running_s',      v_old,
    'backends',              v_back,
    'probe_ms',              round((EXTRACT(epoch FROM (clock_timestamp() - v_t0)) * 1000)::numeric, 1));

  -- No EXCEPTION handler, on purpose. A firing whose reads fail writes no
  -- stamp, and that is the correct reading: the probe did not do its job, the
  -- failure is in cron.job_run_details with its message, and the stamp's age
  -- says so to every reader. A handler that stamped `error` instead would keep
  -- `at` fresh while the readings were absent — a live-looking instrument
  -- reporting nothing.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('box_health', v_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN v_value;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_box_health(timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.record_box_health(timestamptz) IS
  'FIX-1194 P1-B — the */1 box_health probe. Stamps pipeline_state.box_health = {at, startup_timeouts_10m/60m, '
  'watchdog_max_wall_10m{budget,unit}, watchdog_runs_10m, running_budgeted_jobs, running_over_budget, '
  'oldest_running_s, backends, probe_ms} on EVERY firing (rule 129). It is itself a pg_cron firing, so it goes '
  'dark exactly when the forker is starved — read it with box_is_saturated(), whose first rule is that a '
  'stale stamp IS the saturation signal. One scan of cron.job_run_details per firing (a MATERIALIZED CTE on '
  'start_time; the startup-timeout predicate is prod_op_gate''s, byte for byte). Executed by postgres under '
  'pg_cron only; p_now is for tests.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. box_is_saturated() — the readable helper. REPORT-ONLY this build.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rules, in order — the first that holds is the reason:
--   stale          no stamp, or the stamp is older than p_stale_seconds (180 =
--                  three missed */1 firings). The design's inversion.
--   fork_failures  startup_timeouts_10m >= p_fork_failures_10m.
--   watchdog_wall  either */2 watchdog's max wall over 10 min > 1.0 s — the
--                  SAME constant as prod_op_gate's c_wd_max_wall_s (asserted
--                  by a unit test): 0.003–0.13 s healthy, 1–4 s the
--                  pre-failure signature on all three Tuesdays (cc-145 §1).
--   clear          none of the above.
-- memory_low is NOT a rule this build: the mirror (box_health_mem) is returned
-- in readings.memory with its own age, and never sets `saturated`, until a
-- week of the series sizes a threshold (rule 97).
--
-- Reads pipeline_state only — no cron.* — so service_role (no USAGE on schema
-- cron, measured 2026-09-21) can call it as INVOKER. VOLATILE so a caller in a
-- long procedure sees the latest committed stamp on every call.

CREATE OR REPLACE FUNCTION public.box_is_saturated(
  p_stale_seconds     int         DEFAULT 180,
  p_fork_failures_10m int         DEFAULT 3,
  p_now               timestamptz DEFAULT clock_timestamp()
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
  ELSIF v_wall > c_watchdog_wall_s THEN
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
        'stale_seconds',     p_stale_seconds,
        'fork_failures_10m', p_fork_failures_10m,
        'watchdog_wall_s',   c_watchdog_wall_s,
        'memory',            'report-only — no threshold until a week of data sizes one')));
END;
$function$;

REVOKE ALL ON FUNCTION public.box_is_saturated(int, int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.box_is_saturated(int, int, timestamptz) TO service_role;

COMMENT ON FUNCTION public.box_is_saturated(int, int, timestamptz) IS
  'FIX-1194 P1-B — is the box saturated right now? {saturated, reason: stale|fork_failures|watchdog_wall|clear, '
  'age_seconds, readings{probe, memory, thresholds}}. A stale or absent box_health stamp IS saturation (the probe '
  'is a pg_cron firing and goes dark with the forker). memory is REPORT-ONLY this build: returned in readings, '
  'never in saturated. No consumer yet — P1-A reads it at unit boundaries. p_now is for tests.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. record_box_health_mem() — FIX-1125's ON-box mirror of the memory series.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Called by /api/cron/box-health every 2 minutes AFTER it has written the
-- sample OFF the box (Upstash). This row is the second copy, best-effort: a
-- failure here is logged by the route and never fails it. The off-box ring is
-- the deliverable, because the point of the series is to survive the box.
--
-- `at` is the DATABASE clock (rule 167: a stamp from THIS path, read on the
-- target database); `route_at` is when the route scraped, so skew between the
-- two instruments is visible. Keys are validated against a fixed list — the
-- two required numbers must be numbers and consistent, every other listed key
-- must be a number, and an unlisted key is DROPPED and named in the return
-- rather than stored, so a caller drift is visible without breaking the stamp.
--
-- SECURITY DEFINER for the 1208 reason (the route is service_role and this is
-- a narrow, parameter-validated writer of ONE pipeline_state key).

CREATE OR REPLACE FUNCTION public.record_box_health_mem(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_required CONSTANT text[] := ARRAY['mem_available_bytes', 'mem_total_bytes'];
  c_numeric  CONSTANT text[] := ARRAY['mem_available_bytes', 'mem_total_bytes',
                                      'swap_total_bytes', 'swap_free_bytes',
                                      'load1', 'pswpin', 'pswpout', 'pgmajfault',
                                      'oom_kill', 'scrape_ms'];
  v_at      timestamptz := now();
  v_k       text;
  v_value   jsonb := '{}'::jsonb;
  v_ignored text[] := ARRAY[]::text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'record_box_health_mem: p must be a jsonb object' USING ERRCODE = '22023';
  END IF;

  FOREACH v_k IN ARRAY c_required LOOP
    IF jsonb_typeof(p->v_k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'record_box_health_mem: % is required and must be a number', v_k
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (p->>'mem_total_bytes')::numeric <= 0
     OR (p->>'mem_available_bytes')::numeric < 0
     OR (p->>'mem_available_bytes')::numeric > (p->>'mem_total_bytes')::numeric THEN
    RAISE EXCEPTION 'record_box_health_mem: need 0 <= mem_available_bytes (%) <= mem_total_bytes (%)',
      p->>'mem_available_bytes', p->>'mem_total_bytes' USING ERRCODE = '22023';
  END IF;

  FOR v_k IN SELECT jsonb_object_keys(p) LOOP
    IF v_k = ANY (c_numeric) THEN
      IF jsonb_typeof(p->v_k) <> 'number' THEN
        RAISE EXCEPTION 'record_box_health_mem: % must be a number, got %', v_k, jsonb_typeof(p->v_k)
          USING ERRCODE = '22023';
      END IF;
      v_value := v_value || jsonb_build_object(v_k, p->v_k);
    ELSIF v_k = 'route_at' THEN
      -- Cast to prove it parses; stored as the caller sent it.
      PERFORM (p->>'route_at')::timestamptz;
      v_value := v_value || jsonb_build_object('route_at', p->'route_at');
    ELSE
      v_ignored := v_ignored || v_k;
    END IF;
  END LOOP;

  v_value := jsonb_build_object('at', v_at) || v_value;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('box_health_mem', v_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object('at', v_at, 'ignored_keys', to_jsonb(v_ignored));
END;
$function$;

REVOKE ALL ON FUNCTION public.record_box_health_mem(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_box_health_mem(jsonb) TO service_role;

COMMENT ON FUNCTION public.record_box_health_mem(jsonb) IS
  'FIX-1125 — the ON-box mirror of the memory series /api/cron/box-health scrapes every 2 min. Upserts '
  'pipeline_state.box_health_mem = {at (DB clock), route_at, mem_available_bytes, mem_total_bytes, swap_*, '
  'load1, …}. Validates keys (required numbers, consistent; unlisted keys dropped and returned as '
  'ignored_keys). Best-effort by design: the route writes the OFF-box Upstash ring FIRST, and a failure here '
  'never fails the route — the series exists to survive the box.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The job and its budget row (rule 120).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- cron.schedule() on an existing jobname updates it in place, so this is
-- re-runnable. The first `* * * * *` job on this database; every other
-- sub-hourly job is */2, */15 or */30.

SELECT cron.schedule('box-health-probe', '* * * * *',
  $job$SELECT public.record_box_health()$job$);

INSERT INTO public.cron_job_budget (jobname, budget_seconds, note) VALUES
  ('box-health-probe', 60,
   'FIX-1194 P1-B. One */1 firing: a single MATERIALIZED scan of cron.job_run_details + pg_stat_activity. '
   'Sub-100 ms target (cc-149 read 4); 60 s = the cadence, so a stuck probe never overlaps itself.')
ON CONFLICT (jobname) DO NOTHING;
