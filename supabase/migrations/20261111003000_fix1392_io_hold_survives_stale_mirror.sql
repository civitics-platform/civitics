-- =============================================================================
-- FIX-1392 (H1, the part that needs no design) — a recorded io hold reads at
-- ANY mirror age. cc-267, 2026-11-11 (D12, Craig 11-09 20:39 PST "2b"). Class P:
-- two CREATE OR REPLACE, one hunk each.
--
-- (D-1) box_is_saturated: `ELSIF NOT v_mem_stale AND v_io_until > p_now THEN`
--       → `ELSIF v_io_until > p_now THEN` (+ a comment). v_io_until was
--       already read whenever the mirror row exists (fix1375 :344-345, :364).
-- (D-2) prod_op_gate: `IF v_io_fresh AND v_io_until > p_now THEN` → `IF
--       v_io_until > p_now THEN` (+ the comment above it). BOTH OR NEITHER:
--       class P's box block skips io_saturated / io_throttled because this
--       block names them (fix1377 :491-492), so a one-sided change leaves a
--       stale-mirror hold unnamed by the gate.
--
-- WHY. Monday 11-09 (cc-266 read 3): the rung fired on a fresh mirror (holds
-- 08:32Z and 14:23Z) and went silent through the stall that made the day —
-- 309 startup timeouts 05:00–11:00Z — because the throttle starves the 2-min
-- route, the mirror goes stale, and `NOT v_mem_stale` guarded BOTH io
-- clauses, a hold already recorded included. cc-267 read 11 (prod): the one
-- ARMED row Sun 23:00Z → Mon 22:30Z whose box showed a throttle_until later
-- than its arm instant —
--   donor-rollup-refresh 08:39:49Z: io 100 %, streak 4, all 6.68 MB/s,
--   throttle_until 09:32:25Z, mirror 404 s (mem_stale true),
--   startup_timeouts_10m 2 → reaped 08:43:09Z `failed: job startup timeout`.
-- This file would have refused that arm (box: io_throttled). fe-crawl's
-- 10:06:05Z arm (98.1 %, streak 3, 23.29 MB/s, throttle_until null, mirror
-- 189 s) had no hold to honour: H1 does not reach it (D13's H2/H3 would).
--
-- UNCHANGED ON PURPOSE: a stale mirror's STREAK (io_saturated) and its swap
-- (memory) stay fail-open (FIX-1354 D1 — a dark route must not stop the
-- dispatcher); the on-box `stale` / `fork_failures` precedence; every
-- readings key. A hold expires on its own instant (<= io_throttle_hold_min
-- after the last throttle sample), so a dark mirror cannot hold longer than
-- that. FIX-1392 stays OPEN: H2 (a throttle sample under the 90 % bar) and H3
-- (a stale mirror plus 1–2 startup timeouts) are counted in cc-267's report,
-- not built (D13).
--
-- BOTH PINS MOVE: box_is_saturated aaf6cc6552df532eff4a9b21e9780670 → b05961ca6d1cf7e56874071bfe334da1,
-- prod_op_gate 6488601cf8c09287d540989c0e0fd074 → 70a799ab3df2484fc424fe2762ffa797. PIN_LINEAGE and
-- PROMPT_TEMPLATE §Database carry them. Both bodies are prod's
-- pg_get_functiondef (LF, rule 450) plus the hunks; the guards refuse any
-- other starting body. dispatch_one_unit is pinned exactly. No
-- `prod_op_gate … ok` assertion here: the push itself holds (e) (rule 452).
--
-- ROLLBACK: scripts/fix1392-revert-io-hold-stale.sql (both bodies back,
-- md5-verified). IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_b text;
  v_p text;
BEGIN
  SELECT md5(prosrc) INTO v_b FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_p FROM pg_proc WHERE proname = 'prod_op_gate'     AND pronamespace = 'public'::regnamespace;
  IF v_b IS DISTINCT FROM 'aaf6cc6552df532eff4a9b21e9780670' AND v_b IS DISTINCT FROM 'b05961ca6d1cf7e56874071bfe334da1' THEN
    RAISE EXCEPTION '[fix1392] box_is_saturated md5 % is neither fix1375''s aaf6cc6552df532eff4a9b21e9780670 nor this file''s — the pin moved; rebuild this file on the live body',
      COALESCE(v_b, '(no function)');
  END IF;
  IF v_p IS DISTINCT FROM '6488601cf8c09287d540989c0e0fd074' AND v_p IS DISTINCT FROM '70a799ab3df2484fc424fe2762ffa797' THEN
    RAISE EXCEPTION '[fix1392] prod_op_gate md5 % is neither fix1377''s 6488601cf8c09287d540989c0e0fd074 nor this file''s — the pin moved; rebuild this file on the live body',
      COALESCE(v_p, '(no function)');
  END IF;
  RAISE NOTICE '[fix1392] guards: box_is_saturated % · prod_op_gate %', v_b, v_p;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (D-1) box_is_saturated() — a standing hold at any mirror age
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.box_is_saturated(p_stale_seconds integer DEFAULT 180, p_fork_failures_10m integer DEFAULT 3, p_now timestamp with time zone DEFAULT clock_timestamp(), p_include_watchdog_wall boolean DEFAULT true)
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
  -- FIX-1354 (D1): the swap ceiling. The dials are read here, so every reader
  -- of the gate sees one line. The CONSTANTs are the columns' DEFAULTs, used
  -- only when platform_dials has no row.
  c_swap_ceiling_mb CONSTANT int := 1018;
  c_headroom_mb     CONSTANT int := 150;
  v_ceiling   int;
  v_headroom  int;
  v_swap_used numeric;
  v_mem_stale boolean;
  -- FIX-1375 (cc-264): the io: rung. The same one-line pattern: the dials are
  -- read here, the CONSTANTs are their DEFAULTs. record_box_health_mem() keeps
  -- the streak and the hold on the mirror; this reads them.
  c_io_time_pct_ceiling CONSTANT numeric := 90;
  c_io_samples          CONSTANT int     := 3;
  c_io_mbps_floor       CONSTANT numeric := 12;
  c_io_throttle_hold_min CONSTANT int    := 60;
  v_io_ceiling numeric;
  v_io_samples int;
  v_io_floor   numeric;
  v_io_hold    int;
  v_io_streak  int;
  v_io_until   timestamptz;
  v_io         jsonb := NULL;
BEGIN
  SELECT value INTO v_bh  FROM public.pipeline_state WHERE key = 'box_health';
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';

  v_age  := round(EXTRACT(epoch FROM (p_now - (v_bh->>'at')::timestamptz)))::int;
  v_to10 := (v_bh->>'startup_timeouts_10m')::int;
  v_wall := GREATEST((v_bh->'watchdog_max_wall_10m'->>'budget')::numeric,
                     (v_bh->'watchdog_max_wall_10m'->>'unit')::numeric);

  SELECT d.swap_ceiling_mb, d.headroom_target_mb,
         d.io_time_pct_ceiling, d.io_samples, d.io_mbps_floor, d.io_throttle_hold_min
    INTO v_ceiling, v_headroom, v_io_ceiling, v_io_samples, v_io_floor, v_io_hold
    FROM public.platform_dials d WHERE d.id;
  v_ceiling  := COALESCE(v_ceiling, c_swap_ceiling_mb);
  v_headroom := COALESCE(v_headroom, c_headroom_mb);
  v_io_ceiling := COALESCE(v_io_ceiling, c_io_time_pct_ceiling);
  v_io_samples := COALESCE(v_io_samples, c_io_samples);
  v_io_floor   := COALESCE(v_io_floor, c_io_mbps_floor);
  v_io_hold    := COALESCE(v_io_hold, c_io_throttle_hold_min);

  IF v_mem IS NOT NULL THEN
    v_mem_age := round(EXTRACT(epoch FROM (p_now - (v_mem->>'at')::timestamptz)))::int;
    v_swap_used := round(((v_mem->>'swap_total_bytes')::numeric
                          - (v_mem->>'swap_free_bytes')::numeric) / 1048576);
    v_memory := jsonb_build_object(
      'age_seconds',      v_mem_age,
      'mem_available_mb', round((v_mem->>'mem_available_bytes')::numeric / 1048576),
      'mem_total_mb',     round((v_mem->>'mem_total_bytes')::numeric / 1048576),
      'available_pct',    round(100 * (v_mem->>'mem_available_bytes')::numeric
                                    / NULLIF((v_mem->>'mem_total_bytes')::numeric, 0), 1),
      'swap_used_mb',     v_swap_used,
      'load1',            v_mem->'load1');
    v_io_streak := COALESCE((v_mem->>'io_busy_streak')::int, 0);
    v_io_until  := (v_mem->>'io_throttle_until')::timestamptz;
    v_io := jsonb_build_object(
      'io_time_pct',    v_mem->'io_time_pct',
      'all_mbps',       round((v_mem->>'disk_all_read_mbps')::numeric + (v_mem->>'disk_all_write_mbps')::numeric, 2),
      'reads_ps',       v_mem->'disk_reads_ps',
      'busy_streak',    v_io_streak,
      'throttle_until', v_io_until);
  END IF;
  -- FIX-1354 (D1): fresh = the probe's own freshness (p_stale_seconds). A stale
  -- or absent mirror (the Vercel route writes it) does NOT saturate: fail-open,
  -- and counted (mem_stale). The on-box clauses above it already fail closed.
  v_mem_stale := v_mem_age IS NULL OR v_mem_age > p_stale_seconds;

  IF v_age IS NULL OR v_age > p_stale_seconds THEN
    v_reason := 'stale';
  ELSIF v_to10 >= p_fork_failures_10m THEN
    v_reason := 'fork_failures';
  ELSIF NOT v_mem_stale AND v_swap_used >= v_ceiling THEN
    v_reason := 'memory';  -- FIX-1354 (D1): swap at the ceiling
  ELSIF v_io_until > p_now THEN
    -- FIX-1392 (cc-267, D12): a recorded hold reads at ANY mirror age. The
    -- throttle starves the route that freshens the mirror, so the hold must
    -- outlive the mirror going dark; it expires on its own instant. A stale
    -- mirror's streak and swap stay fail-open (FIX-1354 D1).
    v_reason := 'io_throttled';  -- FIX-1375: first, the hold outlives the streak
  ELSIF NOT v_mem_stale AND v_io_streak >= v_io_samples THEN
    v_reason := 'io_saturated';  -- FIX-1375: io_time at the ceiling for io_samples samples
  ELSIF v_walls AND v_wall > c_watchdog_wall_s THEN
    v_reason := 'watchdog_wall';
  ELSE
    v_reason := 'clear';
  END IF;

  RETURN jsonb_build_object(
    'saturated',   v_reason <> 'clear',
    'reason',      v_reason,
    'age_seconds', v_age,
    'readings',    jsonb_build_object(
      'probe',      v_bh,
      'memory',     v_memory,
      'io',         v_io,
      'thresholds', jsonb_build_object(
        'stale_seconds',            p_stale_seconds,
        'fork_failures_10m',        p_fork_failures_10m,
        'watchdog_wall_s',          c_watchdog_wall_s,
        'watchdog_wall_considered', v_walls,
        'memory',                   jsonb_build_object(
                                      'swap_ceiling_mb',    v_ceiling,
                                      'headroom_target_mb', v_headroom,
                                      'mem_stale',          v_mem_stale),
        'io',                       jsonb_build_object(
                                      'ceiling',    v_io_ceiling,
                                      'samples',    v_io_samples,
                                      'mbps_floor', v_io_floor,
                                      'hold_min',   v_io_hold))));
END;
$function$;

REVOKE ALL ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) IS
  'FIX-1194 P1-B / P1-A — is the box saturated right now? {saturated, reason: '
  'stale|fork_failures|memory|io_throttled|io_saturated|watchdog_wall|clear, age_seconds, readings{probe, '
  'memory, io, thresholds}}. A stale or absent box_health stamp IS saturation (the probe is a pg_cron firing '
  'and goes dark with the forker). p_include_watchdog_wall := false skips the 1.0 s wall rule — the three '
  'rollup gates call it that way (cc-183 D2: the wall is not a backoff input). memory (FIX-1354, cc-251): a '
  'FRESH box_health_mem mirror with swap_used_mb >= platform_dials.swap_ceiling_mb saturates (reason memory); a '
  'stale or absent mirror never does (fail-open, readings.thresholds.memory.mem_stale true). thresholds.memory '
  '= {swap_ceiling_mb, headroom_target_mb, mem_stale}. io (FIX-1375, cc-264; FIX-1392, cc-267): a mirror with '
  'io_throttle_until in the future reads io_throttled at ANY mirror age (a hold expires on its own instant); a '
  'FRESH mirror with io_busy_streak >= platform_dials.io_samples reads io_saturated, a stale one never does; '
  'readings.io = {io_time_pct, all_mbps, reads_ps, busy_streak, throttle_until}, thresholds.io = {ceiling, '
  'samples, mbps_floor, hold_min}. Every reader inherits them: the dispatcher''s step 4, box_backoff_gate at a '
  'unit''s start, and the chunk loops of donor_rollup_rebuild_bulk and refresh_agency_staffing_rollup. p_now is '
  'for tests.';

-- ═══════════════════════════════════════════════════════════════════════════
-- (D-2) prod_op_gate() — the same, so class P names the hold once
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.prod_op_gate(
  p_expected_seconds int         DEFAULT 5400,
  p_now              timestamptz DEFAULT clock_timestamp()
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- (a) cron `0 21 * * *` + the GitHub offset (rule 79, cc-141). A constant
  -- because GitHub does not publish when it will actually start the run.
  c_nightly_start   CONSTANT time     := '21:00';  -- FIX-1218: the dispatch time (was 22:35, slot + GitHub offset)
  c_nightly_age     CONSTANT interval := interval '6 hours';
  -- (a) FIX-1342 (cc-247): class P, a push whose expected wall is <= this,
  -- skips only nightly_next_start. Every other wall is class B.
  c_push_s          CONSTANT numeric  := 60;
  -- (b) rule 155, re-cut (FIX-1342): a live VACUUM, or an unguarded cron
  -- whose mean or last wall exceeds this slotted inside the span.
  c_vac_long_s      CONSTANT numeric  := 60;
  -- (d)
  c_wd_min_runs     CONSTANT int      := 28;
  c_wd_max_wall_s   CONSTANT numeric  := 1.0;
  -- (d) FIX-1377 + FIX-1353 (cc-264): the startup-timeout window by class. Class
  -- B remembers 3 h (a post-landing throttle's bursts have clean 15-min buckets
  -- inside them); class P reads the last 10 min and the live box instead. With
  -- the io: input below, both hold (rule 412).
  c_st_window_b     CONSTANT interval := interval '3 hours';
  c_st_window_p     CONSTANT interval := interval '10 minutes';
  c_box_retry       CONSTANT interval := interval '10 minutes';
  -- box_is_saturated's default p_stale_seconds, and the io_samples dial's DEFAULT.
  c_mem_stale_s     CONSTANT int      := 180;
  c_io_samples      CONSTANT int      := 3;

  v_exp       interval;
  v_span_end  timestamptz;
  v_day       date;
  v_blocked   jsonb := '[]'::jsonb;
  v_readings  jsonb := '{}'::jsonb;
  r           record;
  v_n         bigint;
  v_t         timestamptz;
  v_json      jsonb;
  -- (a)
  v_today_slot  timestamptz;
  v_next_start  timestamptz;
  v_last_phase  jsonb;
  v_started_since boolean;
  v_class       text;
  -- (b)
  v_vac_jobs  jsonb := '[]'::jsonb;
  v_unparsed  jsonb := '[]'::jsonb;
  v_slot      timestamptz;
  v_h         int;
  v_m         int;
  -- (c)
  v_cfg       jsonb;
  v_windows   jsonb;
  v_source    text;
  v_from      time;
  v_to        time;
  v_occ_start timestamptz;
  v_occ_end   timestamptz;
  v_hit_end   timestamptz;
  v_hit_desc  text;
  -- (d)
  v_wd        jsonb := '[]'::jsonb;
  v_wd_n      int := 0;
  v_wd_rows   jsonb;  -- FIX-1194 cc-153: the watchdog rows from the one (d) scan
  v_st_window interval;   -- FIX-1377: by class
  v_st_label  text;
  v_mem       jsonb;      -- the mirror's io: keys
  v_mem_age   int;
  v_io_streak int;
  v_io_until  timestamptz;
  v_io_need   int;
  v_io_fresh  boolean;
  v_box       jsonb;      -- FIX-1353: class P only
  -- (e)
  v_pss       jsonb;
  -- (f)
  v_guarded   text[];
BEGIN
  v_exp      := make_interval(secs => GREATEST(COALESCE(p_expected_seconds, 5400), 1));
  v_span_end := p_now + 2 * v_exp;
  v_day      := (p_now AT TIME ZONE 'UTC')::date;

  -- ══ (a) nightly ═══════════════════════════════════════════════════════════
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'phase', COALESCE(d.metadata->>'phase', 'all'),
           'started_at', d.started_at,
           'age_seconds', round(EXTRACT(epoch FROM (p_now - d.started_at)))::int)
           ORDER BY d.started_at), '[]'::jsonb)
    INTO v_json
    FROM public.data_sync_log d
   WHERE d.pipeline = 'nightly_cron'
     AND d.status   = 'running'
     AND d.started_at >  p_now - c_nightly_age
     AND d.started_at <= p_now;
  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_running',
      'detail', format('nightly phase %s running since %s',
                       v_json->-1->>'phase', v_json->-1->>'started_at'),
      'retry_after', NULL);
  END IF;

  SELECT jsonb_build_object('phase', COALESCE(d.metadata->>'phase', 'all'), 'status', d.status,
                            'started_at', d.started_at, 'completed_at', d.completed_at)
    INTO v_last_phase
    FROM public.data_sync_log d
   WHERE d.pipeline = 'nightly_cron' AND d.started_at <= p_now
   ORDER BY d.started_at DESC LIMIT 1;

  IF v_last_phase IS NOT NULL
     AND v_last_phase->>'status' <> 'running'
     AND (v_last_phase->>'completed_at')::timestamptz > p_now - interval '10 minutes'
     AND (v_last_phase->>'completed_at')::timestamptz <= p_now THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_between_phases',
      'detail', format('nightly phase %s closed %s at %s — the next phase may not have opened yet',
                       v_last_phase->>'phase', v_last_phase->>'status', v_last_phase->>'completed_at'),
      'retry_after', (v_last_phase->>'completed_at')::timestamptz + interval '10 minutes');
  END IF;

  v_today_slot := (v_day + c_nightly_start) AT TIME ZONE 'UTC';
  IF p_now < v_today_slot THEN
    v_next_start := v_today_slot;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.data_sync_log d
                    WHERE d.pipeline = 'nightly_cron'
                      AND d.started_at >= v_today_slot - interval '60 minutes'
                      AND d.started_at <= p_now)
      INTO v_started_since;
    IF NOT v_started_since AND p_now < v_today_slot + interval '3 hours' THEN
      v_next_start := v_today_slot;   -- due, not started: it is "now"
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'a', 'name', 'nightly_due',
        'detail', format('nightly due since %s UTC and no nightly_cron row yet — waiting for it to start and finish',
                         c_nightly_start),
        'retry_after', NULL);
    ELSE
      v_next_start := v_today_slot + interval '1 day';
    END IF;
  END IF;
  -- FIX-1342 (cc-247): the distance below is the one clock (a) keeps, and a
  -- class-P push skips it; nightly_running, nightly_between_phases and
  -- nightly_due above are states and bind every class.
  v_class := CASE WHEN COALESCE(p_expected_seconds, 5400) <= c_push_s THEN 'P' ELSE 'B' END;
  IF v_class = 'B' AND v_next_start > p_now AND v_next_start - p_now < 2 * v_exp + interval '15 minutes' THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_next_start',
      'detail', format('next nightly start %s is %s min away; need >= %s (2 x expected + 15 min)',
                       to_char(v_next_start AT TIME ZONE 'UTC', 'MM-DD HH24:MI'),
                       round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
                       round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('nightly', jsonb_build_object(
    'class', v_class,
    'running', v_json,
    'last_phase', v_last_phase,
    'next_start', v_next_start,
    'minutes_to_next_start', round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
    'required_minutes', round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)));

  -- ══ (b) vacuum spacing (rule 155) ═════════════════════════════════════════
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           -- FIX-1342: a dispatcher row gated {prod_session} (a claim defers
           -- it a tick), or one of its disp-<job>-<epoch> one-shots.
           (j.jobname ~ '^disp-.+-[0-9]+$'
            OR EXISTS (SELECT 1 FROM public.job_registry g
                        WHERE g.job = j.jobname
                          AND g.deadline_rule !~ '^at '
                          AND 'prod_session' = ANY (g.gates)))                 AS dispatched,
           s.runs_14d, s.mean_s, s.last_end, s.last_wall_s, s.running_since
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE d.end_time IS NOT NULL)                          AS runs_14d,
               round(avg(EXTRACT(epoch FROM (d.end_time - d.start_time)))
                       FILTER (WHERE d.end_time IS NOT NULL)::numeric, 1)              AS mean_s,
               max(d.end_time) FILTER (WHERE d.end_time <= p_now)                      AS last_end,
               min(d.start_time) FILTER (WHERE d.end_time IS NULL
                                           AND d.status IN ('starting', 'running', 'sending', 'connecting')
                                           AND d.start_time > p_now - interval '6 hours') AS running_since,
               (SELECT round(EXTRACT(epoch FROM (d2.end_time - d2.start_time))::numeric, 1)
                  FROM cron.job_run_details d2
                 WHERE d2.jobid = j.jobid AND d2.end_time <= p_now
                 ORDER BY d2.end_time DESC LIMIT 1)                                   AS last_wall_s
          FROM cron.job_run_details d
         WHERE d.jobid = j.jobid
           AND d.start_time >  p_now - interval '14 days'
           AND d.start_time <= p_now
      ) s ON true
     WHERE j.jobname ILIKE '%vacuum%'
     ORDER BY j.jobname
  LOOP
    v_slot := NULL;
    IF r.schedule ~ '^\d+ \d+ \* \* \*$' THEN
      v_m := split_part(r.schedule, ' ', 1)::int;
      v_h := split_part(r.schedule, ' ', 2)::int;
      v_slot := (v_day + make_time(v_h, v_m, 0)) AT TIME ZONE 'UTC';
      IF v_slot < p_now THEN v_slot := v_slot + interval '1 day'; END IF;
    ELSE
      v_unparsed := v_unparsed || jsonb_build_object(
        'jobname', r.jobname, 'schedule', r.schedule, 'active', r.active, 'mean_14d_s', r.mean_s);
    END IF;

    v_vac_jobs := v_vac_jobs || jsonb_build_object(
      'jobname', r.jobname, 'schedule', r.schedule, 'active', r.active,
      'runs_14d', r.runs_14d, 'mean_14d_s', r.mean_s,
      'last_end', r.last_end, 'last_wall_s', r.last_wall_s,
      'dispatched', r.dispatched,
      'running_since', r.running_since, 'next_slot', v_slot);

    IF r.running_since IS NOT NULL THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s running since %s', r.jobname,
                         to_char(r.running_since AT TIME ZONE 'UTC', 'HH24:MI:SS')),
        'retry_after', NULL);
    END IF;

    -- FIX-1342 (cc-247): no clock after a VACUUM's END. Spacing is the live
    -- run above, or an unguarded cron slotted inside the span below (the mean
    -- alone misses a first or long-tail firing, so the last wall counts too).
    IF v_slot IS NOT NULL AND r.active AND NOT r.dispatched
       AND GREATEST(COALESCE(r.mean_s, 0), COALESCE(r.last_wall_s, 0)) > c_vac_long_s
       AND v_slot <= v_span_end THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s (mean %s s over %s runs) is scheduled %s UTC, inside the span to %s',
                         r.jobname, r.mean_s, r.runs_14d,
                         to_char(v_slot AT TIME ZONE 'UTC', 'HH24:MI'),
                         to_char(v_span_end AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', v_slot + make_interval(secs => GREATEST(COALESCE(r.mean_s, 0), COALESCE(r.last_wall_s, 0))));
    END IF;
  END LOOP;
  v_readings := v_readings || jsonb_build_object('vacuum', jsonb_build_object(
    'spacing', 'none (FIX-1342): live or slot-in-span',
    'jobs', v_vac_jobs, 'unparsed', v_unparsed));

  -- ══ (c) blackout ══════════════════════════════════════════════════════════
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_windows := v_cfg->'blackout';
  -- FIX-1124 part 2 (cc-243): an empty or absent array is NO window. The
  -- 05:45-09:00 constants are gone; the key stays as an operator override.
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'array' OR jsonb_array_length(v_windows) = 0 THEN
    v_windows := '[]'::jsonb;
    v_source  := 'none (FIX-1124 part 2)';
  ELSE
    v_source  := 'pipeline_state.ec_crawl';
  END IF;

  v_hit_end := NULL;
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(v_windows) e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[prod_op_gate] unparseable blackout entry % — ignored', r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN CONTINUE; END IF;
    -- Occurrences starting from yesterday (a wrap window that began then may
    -- still be open) through the span's last day.
    FOR v_n IN -1 .. (((v_span_end AT TIME ZONE 'UTC')::date - v_day) + 1)
    LOOP
      v_occ_start := ((v_day + v_n::int) + v_from) AT TIME ZONE 'UTC';
      v_occ_end   := ((v_day + v_n::int + CASE WHEN v_to > v_from THEN 0 ELSE 1 END) + v_to) AT TIME ZONE 'UTC';
      IF v_occ_start < v_span_end AND v_occ_end > p_now THEN
        IF v_hit_end IS NULL OR v_occ_start < v_hit_end THEN
          v_hit_end  := v_occ_end;
          v_hit_desc := format('%s–%s UTC %s', v_from, v_to,
                               CASE WHEN v_occ_start <= p_now THEN 'is open now'
                                    ELSE format('opens %s, inside the span to %s',
                                                to_char(v_occ_start AT TIME ZONE 'UTC', 'HH24:MI'),
                                                to_char(v_span_end AT TIME ZONE 'UTC', 'HH24:MI')) END);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF v_hit_end IS NOT NULL THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'c', 'name', 'blackout',
      'detail', format('blackout %s; clear at %s', v_hit_desc,
                       to_char(v_hit_end AT TIME ZONE 'UTC', 'HH24:MI')),
      'retry_after', v_hit_end);
  END IF;
  v_readings := v_readings || jsonb_build_object('blackout', jsonb_build_object(
    'source', v_source, 'windows', v_windows,
    'now_utc', to_char(p_now AT TIME ZONE 'UTC', 'HH24:MI:SS')));

  -- ══ (d) watchdogs ═════════════════════════════════════════════════════════
  -- FIX-1194 (cc-153) — ONE scan of cron.job_run_details for every (d) reading,
  -- the probe's form (record_box_health, 20260920130000). As three statements
  -- these reads cost 112-133 ms on prod (the startup-timeout read alone 79-101
  -- ms: the planner evaluated the ILIKE before the start_time filter, on every
  -- row). One MATERIALIZED CTE on start_time over the longest (d) window, 1 day,
  -- with the predicate in its select list: 23-26 ms. Same windows, same keys.
  -- The watchdog rows round-trip through jsonb so the loop body is unchanged.
  v_st_window := CASE WHEN v_class = 'P' THEN c_st_window_p ELSE c_st_window_b END;
  v_st_label  := CASE WHEN v_class = 'P' THEN '10 min' ELSE '3 h' END;
  WITH d AS MATERIALIZED (
    SELECT d.jobid, d.status, d.start_time, d.end_time,
           (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%') AS startup_timeout
      FROM cron.job_run_details d
     WHERE d.start_time >  p_now - interval '1 day'
       AND d.start_time <= p_now
  ),
  wd AS (
    SELECT j.jobname,
           count(d.*) FILTER (WHERE d.start_time > p_now - interval '60 minutes')        AS runs_60m,
           round(max(EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))
                   FILTER (WHERE d.start_time > p_now - interval '10 minutes')::numeric, 3) AS max_wall_10m_s,
           round(percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))::numeric, 3)
                                                                                         AS median_wall_60m_s
      FROM cron.job j
      LEFT JOIN d
        ON d.jobid = j.jobid
       AND d.start_time >  p_now - interval '60 minutes'
     WHERE j.schedule = '*/2 * * * *' AND j.active
     GROUP BY j.jobname
  ),
  bo AS (
    SELECT j.jobname, b.budget_seconds,
           round(EXTRACT(epoch FROM (p_now - d.start_time)))::int AS age_s
      FROM d
      JOIN cron.job j              ON j.jobid   = d.jobid
      JOIN public.cron_job_budget b ON b.jobname = j.jobname
     WHERE d.status = 'running'
       AND EXTRACT(epoch FROM (p_now - d.start_time)) > b.budget_seconds
  )
  SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(wd) ORDER BY wd.jobname), '[]'::jsonb) FROM wd),
         (SELECT count(*) FROM d WHERE d.startup_timeout AND d.start_time > p_now - v_st_window),
         (SELECT max(d.start_time) FROM d WHERE d.startup_timeout AND d.start_time > p_now - v_st_window),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'jobname', bo.jobname, 'age_seconds', bo.age_s, 'budget_seconds', bo.budget_seconds)), '[]'::jsonb)
            FROM bo)
    INTO v_wd_rows, v_n, v_t, v_json;

  FOR r IN
    SELECT x.jobname, x.runs_60m, x.max_wall_10m_s, x.median_wall_60m_s
      FROM jsonb_to_recordset(v_wd_rows)
           AS x(jobname text, runs_60m bigint, max_wall_10m_s numeric, median_wall_60m_s numeric)
     ORDER BY x.jobname
  LOOP
    v_wd_n := v_wd_n + 1;
    v_wd := v_wd || jsonb_build_object('jobname', r.jobname, 'runs_60m', r.runs_60m,
                                       'max_wall_10m_s', r.max_wall_10m_s,
                                       'median_wall_60m_s', r.median_wall_60m_s);
    IF r.runs_60m < c_wd_min_runs THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'd', 'name', r.jobname,
        'detail', format('%s ran %s times in the last 60 min; need >= %s', r.jobname, r.runs_60m, c_wd_min_runs),
        'retry_after', NULL);
    END IF;
    IF r.max_wall_10m_s > c_wd_max_wall_s THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'd', 'name', r.jobname,
        'detail', format('%s max wall %s s over the last 10 min; need <= %s s', r.jobname,
                         r.max_wall_10m_s, c_wd_max_wall_s),
        'retry_after', p_now + interval '10 minutes');
    END IF;
  END LOOP;
  IF v_wd_n = 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'no_watchdog',
      'detail', 'no active */2 watchdog job — nothing is enforcing cron budgets', 'retry_after', NULL);
  END IF;

  IF v_n > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'startup_timeout',
      'detail', format('%s job startup timeout failure(s) in the last %s, latest %s', v_n, v_st_label,
                       to_char(v_t AT TIME ZONE 'UTC', 'HH24:MI:SS')),
      'retry_after', v_t + v_st_window);
  END IF;

  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'budget_overrun',
      'detail', format('%s budgeted job(s) running past budget: %s', jsonb_array_length(v_json), v_json),
      'retry_after', NULL);
  END IF;

  -- FIX-1377 (cc-264): the io: input, both classes. The mirror's derived keys,
  -- read directly. FIX-1392 (cc-267, D12): a standing hold reads at any mirror
  -- age, as box_is_saturated's io_throttled does, so class P's box block below
  -- still skips it; a stale or absent mirror's streak reads nothing: the
  -- probe's staleness is (d)'s job above, and box_is_saturated's for class P below.
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';
  v_mem_age   := round(EXTRACT(epoch FROM (p_now - (v_mem->>'at')::timestamptz)))::int;
  v_io_fresh  := COALESCE(v_mem_age <= c_mem_stale_s, false);
  v_io_streak := COALESCE((v_mem->>'io_busy_streak')::int, 0);
  v_io_until  := (v_mem->>'io_throttle_until')::timestamptz;
  SELECT d.io_samples INTO v_io_need FROM public.platform_dials d WHERE d.id;
  v_io_need   := COALESCE(v_io_need, c_io_samples);
  IF v_io_until > p_now THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'io_throttled',
      'detail', format('the mirror''s io_throttle_until %s is in the future',
                       to_char(v_io_until AT TIME ZONE 'UTC', 'HH24:MI"Z"')),
      'retry_after', v_io_until);
  END IF;
  IF v_io_fresh AND v_io_streak >= v_io_need THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'io_saturated',
      'detail', format('the mirror''s io_busy_streak %s >= %s at %s', v_io_streak, v_io_need,
                       to_char((v_mem->>'at')::timestamptz AT TIME ZONE 'UTC', 'HH24:MI"Z"')),
      'retry_after', p_now + c_box_retry);
  END IF;

  -- FIX-1353 (cc-264): class P reads the live box. The io_ reasons are named by
  -- the two blocks above, with the throttle's own retry_after, so they are not
  -- blocked twice.
  IF v_class = 'P' THEN
    v_box := public.box_is_saturated(p_now := p_now, p_include_watchdog_wall := false);
    IF COALESCE((v_box->>'saturated')::boolean, true)
       AND COALESCE(v_box->>'reason', 'unknown') NOT IN ('io_saturated', 'io_throttled') THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'd', 'name', 'box_' || COALESCE(v_box->>'reason', 'unknown'),
        'detail', format('box_is_saturated: %s', COALESCE(v_box->>'reason', 'unknown')),
        'retry_after', p_now + c_box_retry);
    END IF;
  END IF;

  v_readings := v_readings || jsonb_build_object('watchdogs', jsonb_build_object(
    'jobs', v_wd, 'startup_timeouts', v_n, 'startup_timeout_window', v_st_label,
    'budget_overruns', v_json),
    'io', jsonb_build_object(
      'mirror_age_seconds', v_mem_age, 'fresh', v_io_fresh, 'busy_streak', v_io_streak,
      'samples', v_io_need, 'throttle_until', v_io_until),
    'box', CASE WHEN v_class = 'P' THEN jsonb_build_object(
                  'saturated', v_box->'saturated', 'reason', v_box->'reason') END);

  -- ══ (e) interlock ═════════════════════════════════════════════════════════
  v_pss := public.prod_session_state();
  IF (v_pss->>'held')::boolean THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'e', 'name', 'session_held',
      'detail', v_pss->>'reason_text', 'retry_after', NULL);
  END IF;
  IF jsonb_array_length(COALESCE(v_pss->'live_writers', '[]'::jsonb)) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'e', 'name', 'live_writers',
      'detail', format('live heavy writer(s): %s', v_pss->'live_writers'),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('interlock', jsonb_build_object(
    'held', v_pss->'held', 'live_writers', v_pss->'live_writers',
    'live_writer_detail', v_pss->'live_writer_detail', 'reason_text', v_pss->'reason_text'));

  -- ══ (f) stuck units — the guarded set, derived as Q_CRON_JOB_PIPELINES does ═
  -- The three patterns are byte-identical to RE_PROC_FROM_COMMAND,
  -- RE_COMMENT_ONLY_LINE, RE_PIPELINE_FROM_INSERT and RE_PIPELINE_FROM_LOCAL in
  -- packages/data/src/lib/cron-job-pipelines.ts (asserted by prod-op-gate.test.ts).
  WITH job AS (
    SELECT (regexp_match(j.command, '(?:CALL|SELECT)\s+(?:public\.)?([a-z_0-9]+)\s*\(', 'i'))[1] AS proc
      FROM cron.job j
  ), src AS (
    SELECT regexp_replace(pr.prosrc, '(?n)^[ \t]*--[^\n]*$', '', 'g') AS body,
           pr.prosrc AS raw
      FROM job
      JOIN pg_proc pr
        ON pr.proname = job.proc
       AND pr.pronamespace = 'public'::regnamespace
  )
  SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), ARRAY[]::text[]) INTO v_guarded
    FROM (
      SELECT COALESCE(
               (regexp_match(body, 'data_sync_log\s*\([^)]*\)\s*VALUES\s*\(\s*''([a-z_0-9]+)''', 'i'))[1],
               (regexp_match(body, 'c_pipeline\s+text\s*:=\s*''([a-z_0-9]+)''', 'i'))[1]) AS p
        FROM src
       WHERE raw ILIKE '%prod_session_state%'
    ) g
   WHERE p IS NOT NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', d.pipeline, 'started_at', d.started_at,
           'age_minutes', round(EXTRACT(epoch FROM (p_now - d.started_at)) / 60)) ORDER BY d.started_at), '[]'::jsonb)
    INTO v_json
    FROM public.data_sync_log d
   WHERE d.status = 'running'
     AND d.pipeline = ANY (v_guarded)
     AND d.started_at < p_now - interval '60 minutes';
  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'f', 'name', 'stuck_units',
      'detail', format('%s guarded unit(s) running > 60 min: %s', jsonb_array_length(v_json), v_json),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('stuck_units', jsonb_build_object(
    'guarded_pipelines', to_jsonb(v_guarded), 'stuck', v_json));

  RETURN jsonb_build_object(
    'ok',               jsonb_array_length(v_blocked) = 0,
    'checked_at',       p_now,
    'expected_seconds', p_expected_seconds,
    'span_end',         v_span_end,
    'blocked_by',       v_blocked,
    'readings',         v_readings);
END;
$function$;

REVOKE ALL ON FUNCTION public.prod_op_gate(int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prod_op_gate(int, timestamptz) TO service_role;

COMMENT ON FUNCTION public.prod_op_gate(int, timestamptz) IS
  'FIX-1215 — may a supervised prod op of p_expected_seconds start now? {ok, '
  'blocked_by[{check,name,detail,retry_after}], readings}. Checks (a) nightly (b) vacuum spacing (c) blackout '
  '(d) watchdogs (e) interlock (f) stuck guarded units, each from its instrument. The Logs API census is NOT '
  'here (rule 20). p_now is for tests. Waited on by session:wait-for-gate. FIX-1342 (cc-247): '
  'p_expected_seconds <= 60 is class P (a push) and skips only the nightly distance; (b) is a live VACUUM or an '
  'unguarded > 60 s cron slotted in the span, never a clock after an END. FIX-1377 + FIX-1353 (cc-264): (d) '
  'remembers startup timeouts 3 h for class B and 10 min for class P; class P also reads '
  'box_is_saturated(p_include_watchdog_wall := false), blocking d:box_<reason>; both read the mirror''s '
  'io_throttle_until and io_busy_streak, blocking d:io_throttled and d:io_saturated (FIX-1392, cc-267: a stale '
  'mirror still reads a standing hold; its streak reads nothing).';

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_md5_b   text;
  v_md5_p   text;
  v_md5_d   text;
  v_md5_g   text;
  v_n       int;
  v_args    text;
  v_cfg     text;
  v_box     jsonb;
  v_gate    jsonb;
BEGIN
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'b05961ca6d1cf7e56874071bfe334da1' THEN
    v_missing := v_missing || format('box_is_saturated md5 %s, expected b05961ca6d1cf7e56874071bfe334da1', v_md5_b)::text;
  END IF;
  IF v_md5_p IS DISTINCT FROM '70a799ab3df2484fc424fe2762ffa797' THEN
    v_missing := v_missing || format('prod_op_gate md5 %s, expected 70a799ab3df2484fc424fe2762ffa797', v_md5_p)::text;
  END IF;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (expected d6a9073bcc4d9084b9d7994324a89b18)', v_md5_d)::text;
  END IF;
  IF v_md5_g IS NULL OR v_md5_g NOT IN ('4c30523742e280a4b48ea2ec390654d6', 'd6bb02aab3eb8c9625275227f564c5c9') THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected 4c30523742e280a4b48ea2ec390654d6 or file B''s d6bb02aab3eb8c9625275227f564c5c9', v_md5_g)::text;
  END IF;

  -- One overload each, the old argument lists (a changed default is a different function).
  SELECT count(*), max(pg_get_function_arguments(oid)) INTO v_n, v_args
    FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 OR v_args IS DISTINCT FROM 'p_stale_seconds integer DEFAULT 180, p_fork_failures_10m integer DEFAULT 3, p_now timestamp with time zone DEFAULT clock_timestamp(), p_include_watchdog_wall boolean DEFAULT true' THEN
    v_missing := v_missing || format('box_is_saturated: %s overload(s), arguments %L', v_n, v_args)::text;
  END IF;
  SELECT count(*), max(pg_get_function_arguments(oid)) INTO v_n, v_args
    FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 OR v_args IS DISTINCT FROM 'p_expected_seconds integer DEFAULT 5400, p_now timestamp with time zone DEFAULT clock_timestamp()' THEN
    v_missing := v_missing || format('prod_op_gate: %s overload(s), arguments %L', v_n, v_args)::text;
  END IF;
  -- proconfig as before (check:proconfig's census unchanged).
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS DISTINCT FROM 'search_path=public, pg_catalog' THEN
    v_missing := v_missing || format('box_is_saturated proconfig %L', v_cfg)::text;
  END IF;
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS DISTINCT FROM 'search_path=public, pg_catalog' THEN
    v_missing := v_missing || format('prod_op_gate proconfig %L', v_cfg)::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1392] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- Printed, not asserted (rule 452): the two verdicts as they stand.
  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_gate := public.prod_op_gate(1);
  RAISE NOTICE '[fix1392] md5 box_is_saturated % (was aaf6cc6552df532eff4a9b21e9780670) / prod_op_gate % (was 6488601cf8c09287d540989c0e0fd074); dispatch_one_unit % unchanged',
    v_md5_b, v_md5_p, v_md5_d;
  RAISE NOTICE '[fix1392] box_is_saturated(false) now: % · io % · mem_stale %',
    v_box->>'reason', v_box->'readings'->'io', v_box->'readings'->'thresholds'->'memory'->'mem_stale';
  RAISE NOTICE '[fix1392] prod_op_gate(1) now: ok % · blocked_by % · io %',
    v_gate->>'ok', v_gate->'blocked_by', v_gate->'readings'->'io';
END $$;
