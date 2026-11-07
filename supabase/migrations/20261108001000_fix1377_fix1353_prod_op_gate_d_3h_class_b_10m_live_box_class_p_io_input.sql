-- =============================================================================
-- FIX-1377 + FIX-1353 — prod_op_gate() (d) re-cut in ONE file: class B remembers
-- startup timeouts for 3 h, class P reads the last 10 min plus the live box, and
-- both read the mirror's io: keys. cc-264, 2026-11-07.
--
-- DESIGN: docs/audits/2026-11-02-io-budget-census.md §8 (the gate) and FIX-1353.
-- Prompt: cc-prompt-264-…, D3.
--
-- WHY THEY LAND TOGETHER (rule 412). FIX-1377 widens (d), FIX-1353 narrows it, and
-- they conflict only without the io: input. On 11-02 a 10-min or a 60-min window
-- reopened in the clean 04:45Z and 05:45Z buckets, mid-throttle. With the mirror's
-- keys in (d), the throttle holds the gate itself, so class P can stop waiting out
-- an old startup timeout (cc-248's 7 s push waited 55 min on a 03:02Z status-half
-- burst) and class B can remember a throttle's bursts.
--
-- WHAT IT COSTS (cc-264 read 4, 14 d, the 10-25 wedge day excluded): hours with a
-- (d) startup-timeout block read 7.1 h at 60 min. Class B moves to 13.1 h at 3 h.
-- Class P moves to 4.0 h at 10 min.
--
-- WHAT: prod_op_gate() = 20261025000000 (fix1342) VERBATIM (prosrc md5
-- 1d3507cd4b71439f0cfff51cde49b9d8 = prod at cc-264 read 2) plus the (d) hunks. The signature, the
-- blocked_by shape and the class derivation (c_push_s, p_expected_seconds <= 60)
-- are unchanged:
--   class B  the startup-timeout window is 3 h; retry_after = latest + 3 h.
--   class P  the startup-timeout window is 10 min; retry_after = latest + 10 min.
--            box_is_saturated() is a NEW read: any saturated reason blocks
--            d:box_<reason>, retry_after now + 10 min. FIX-1353's shorthand
--            "box_is_saturated(false)" would bind false to p_stale_seconds; it is
--            the named p_include_watchdog_wall := false, with p_now passed through.
--   both     the mirror's derived keys, read directly: io_throttle_until > now
--            blocks d:io_throttled with that instant; io_busy_streak >= io_samples
--            blocks d:io_saturated, retry_after now + 10 min. A stale or absent
--            mirror reads neither.
-- For class P, box_io_saturated / box_io_throttled are never blocked: the two
-- blocks above already name them, the throttle with its real retry_after.
-- The per-watchdog blocks, (a), (b), (c), (e) and (f) are unchanged to the byte.
--
-- THE READINGS. readings.watchdogs.startup_timeouts_60m would now lie, so it is
-- startup_timeouts plus startup_timeout_window ('3 h' | '10 min'). No code reads
-- the gate's key (the receipts read box_health's). readings.io is new, and
-- readings.box for class P.
--
-- THE TOKENS. blockToken() in lib/prod-op-gate.ts is generic (`${check}:${name}`),
-- so the new names render with no TS change: d:io_throttled(→HH:MM),
-- d:io_saturated(→HH:MM), d:box_memory(→HH:MM), d:box_stale(→HH:MM),
-- d:box_fork_failures(→HH:MM). A d:io_* block is a WAIT in session:wait-for-gate,
-- as every block is.
--
-- THE READ-BACK cannot assert ok: on prod this file runs under the gate's own claim,
-- so (e) reads session_held there. It asserts the two windows and the new readings
-- and NOTICEs both blocked_by lists. Item 6 reads ok after the claim releases.
--
-- CLASS: P. One CREATE OR REPLACE, a COMMENT, the grants, a read-back.
--
-- ROLLBACK: scripts/fix1377-revert-prod-op-gate-d.sql (fix1342's body verbatim).
-- =============================================================================

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' AND v_md5 IS DISTINCT FROM '6488601cf8c09287d540989c0e0fd074' THEN
    RAISE EXCEPTION '[fix1377] prod_op_gate md5 % is neither fix1342''s 1d3507cd4b71439f0cfff51cde49b9d8 nor this file''s — the pin moved; rebuild this file on the live body',
      COALESCE(v_md5, '(no function)');
  END IF;
  RAISE NOTICE '[fix1377] guard: prod_op_gate %', v_md5;
END $$;

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
  -- read directly. A stale or absent mirror reads neither: the probe's
  -- staleness is (d)'s job above, and box_is_saturated's for class P below.
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';
  v_mem_age   := round(EXTRACT(epoch FROM (p_now - (v_mem->>'at')::timestamptz)))::int;
  v_io_fresh  := COALESCE(v_mem_age <= c_mem_stale_s, false);
  v_io_streak := COALESCE((v_mem->>'io_busy_streak')::int, 0);
  v_io_until  := (v_mem->>'io_throttle_until')::timestamptz;
  SELECT d.io_samples INTO v_io_need FROM public.platform_dials d WHERE d.id;
  v_io_need   := COALESCE(v_io_need, c_io_samples);
  IF v_io_fresh AND v_io_until > p_now THEN
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

COMMENT ON FUNCTION public.prod_op_gate(int, timestamptz) IS
  'FIX-1215 — may a supervised prod op of p_expected_seconds start now? {ok, blocked_by[{check,name,detail,'
  'retry_after}], readings}. Checks (a) nightly (b) vacuum spacing (c) blackout (d) watchdogs (e) interlock '
  '(f) stuck guarded units, each from its instrument. The Logs API census is NOT here (rule 20). p_now is '
  'for tests. Waited on by session:wait-for-gate. FIX-1342 (cc-247): p_expected_seconds <= 60 is class P (a '
  'push) and skips only the nightly distance; (b) is a live VACUUM or an unguarded > 60 s cron slotted in the '
  'span, never a clock after an END. FIX-1377 + FIX-1353 (cc-264): (d) remembers startup timeouts 3 h for class B '
  'and 10 min for class P; class P also reads box_is_saturated(p_include_watchdog_wall := false), blocking '
  'd:box_<reason>; both read the mirror''s io_throttle_until and io_busy_streak, blocking d:io_throttled and '
  'd:io_saturated (a stale mirror reads neither).';

REVOKE ALL ON FUNCTION public.prod_op_gate(int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prod_op_gate(int, timestamptz) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_md5_g   text;
  v_md5_b   text;
  v_md5_m   text;
  v_md5_d   text;
  v_md5_s   text;
  v_config  text[];
  v_oid     oid := 'public.prod_op_gate(int, timestamptz)'::regprocedure;
  v_p       jsonb;
  v_b       jsonb;
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5_g, v_config FROM pg_proc WHERE oid = v_oid;
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_m FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_s FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;

  IF v_md5_g IS DISTINCT FROM '6488601cf8c09287d540989c0e0fd074' THEN
    v_missing := v_missing || format('prod_op_gate md5 %s (expected 6488601cf8c09287d540989c0e0fd074)', v_md5_g);
  END IF;
  -- file A's NEW md5s, not fix1354's: this file reads what A wrote.
  IF v_md5_b IS DISTINCT FROM 'aaf6cc6552df532eff4a9b21e9780670' THEN
    v_missing := v_missing || format('box_is_saturated md5 %s (expected file A''s aaf6cc6552df532eff4a9b21e9780670)', v_md5_b);
  END IF;
  IF v_md5_m IS DISTINCT FROM 'de9ebee733077a59dfe2959981f8e0c3' THEN
    v_missing := v_missing || format('record_box_health_mem md5 %s (expected file A''s de9ebee733077a59dfe2959981f8e0c3)', v_md5_m);
  END IF;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' OR v_md5_s IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' THEN
    v_missing := v_missing || format('the dispatcher pair moved: %s / %s', v_md5_d, v_md5_s);
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
    v_missing := v_missing || format('proconfig %s (expected search_path only)', v_config);
  END IF;

  v_p := public.prod_op_gate(1);
  v_b := public.prod_op_gate(5400);
  IF v_p->'readings'->'nightly'->>'class' IS DISTINCT FROM 'P'
     OR v_p->'readings'->'watchdogs'->>'startup_timeout_window' IS DISTINCT FROM '10 min' THEN
    v_missing := v_missing || format('prod_op_gate(1) reads class %s window %s (expected P / 10 min)',
      v_p->'readings'->'nightly'->>'class', v_p->'readings'->'watchdogs'->>'startup_timeout_window');
  END IF;
  IF v_b->'readings'->'nightly'->>'class' IS DISTINCT FROM 'B'
     OR v_b->'readings'->'watchdogs'->>'startup_timeout_window' IS DISTINCT FROM '3 h' THEN
    v_missing := v_missing || format('prod_op_gate(5400) reads class %s window %s (expected B / 3 h)',
      v_b->'readings'->'nightly'->>'class', v_b->'readings'->'watchdogs'->>'startup_timeout_window');
  END IF;
  IF NOT (v_p->'readings' ? 'io') OR v_p->'readings'->'box'->>'reason' IS NULL THEN
    v_missing := v_missing || format('prod_op_gate(1) readings carry no io / box: %s', v_p->'readings'->'box');
  END IF;
  IF jsonb_typeof(v_b->'readings'->'box') IS DISTINCT FROM 'null' THEN
    v_missing := v_missing || format('prod_op_gate(5400) read the live box: %s', v_b->'readings'->'box');
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1377] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1377] read-back ok: prod_op_gate md5 % (was 1d3507cd4b71439f0cfff51cde49b9d8); box_is_saturated % · record_box_health_mem % (file A''s); dispatch_one_unit % · get_dispatcher_status % unchanged; prod_op_gate(1) ok=% class P window 10 min box % blocked_by %; prod_op_gate(5400) ok=% class B window 3 h blocked_by %',
    v_md5_g, v_md5_b, v_md5_m, v_md5_d, v_md5_s,
    v_p->>'ok', v_p->'readings'->'box'->>'reason', v_p->'blocked_by', v_b->>'ok', v_b->'blocked_by';
END $$;
