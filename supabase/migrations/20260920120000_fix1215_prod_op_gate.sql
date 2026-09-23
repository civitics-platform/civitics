-- FIX-1215 — prod_op_gate(): the prod-op window as a function of the
-- instruments, so a runner can WAIT on it instead of a human computing a clock.
--
-- THE PROBLEM. Every supervised prod op since cc-131 has been clocked by hand
-- against docs/cc/PROMPT_TEMPLATE.md's gates (a)–(g): a prompt restates the
-- nightly start, the 05:45–09:00 blackout, the vacuum spacing (rule 155), the
-- */2 watchdog health and the interlock; CC turns them into a start time; a
-- human has to be awake when it arrives. Rule 65 already says prod ops are
-- clocked to CONDITIONS, and every one of those conditions is readable from the
-- database. So read them, here, once.
--
--     SELECT public.prod_op_gate(<expected seconds>);
--     → { ok, checked_at, expected_seconds, span_end,
--         blocked_by: [{check, name, detail, retry_after}],
--         readings:   {nightly, vacuum, blackout, watchdogs, interlock, stuck_units} }
--
-- Every check is written in its instrument's own vocabulary (rule 137) and
-- carries its reading, so an `ok=false` explains itself. `span` below is
-- [p_now, p_now + 2 × p_expected_seconds] — the template's "none scheduled
-- inside [start, start + 2 × expected wall]", applied to every scheduled thing.
--
-- (a) nightly     — no `nightly_cron` phase `running` (the predicate
--                   prod_session_state() uses: status='running', < 6 h old); no
--                   phase CLOSED in the last 10 min (the gap between two phases
--                   is ~30 s on 09-22 — a poll in it must not read "done"); and
--                   the next START ≥ 2 × expected + 15 min away. The start is a
--                   CONSTANT, 22:35 UTC: cron `0 21 * * *` plus the GitHub
--                   offset (1.6–1.8 h, rule 79; cc-141 measured the weekday
--                   nightly at 22:49–23:01). Past 22:35 with no nightly row since
--                   21:35 reads as "due, not started" and BLOCKS until it shows.
-- (b) vacuum      — rule 155, from cron.job_run_details JOIN cron.job by NAME
--                   (`%vacuum%`; the jobids differ between prod and the clone):
--                   none running; no run with wall > 60 s ENDED in the last
--                   90 min; no run at all ended in the last 10 min; and no ACTIVE
--                   vacuum job whose 14-day MEAN wall > 60 s has a daily slot in
--                   the span. Only the `^M H * * *$` shape is parsed — ec 30 4,
--                   fr 0 3, fe 50 4 today. Any other shape (the 11,17 series,
--                   `0 2 * * 0,3`) is reported in readings.vacuum.unparsed[] with
--                   its mean and NEVER blocks: a partial cron parser that guessed
--                   would be worse than one that says what it did not read.
-- (c) blackout    — pipeline_state.ec_crawl->'blackout' ([{from,to}], the
--                   crawl_gate() parse, wrap-midnight included) — the same row
--                   the crawl already obeys, so there is one blackout, not two.
--                   Absent OR empty falls back to 05:45–09:00 UTC (FIX-1124: the
--                   06:00 derived-MVs stack; rule 2) — the clone seeds `[]`, and
--                   a prod row emptied to pause the CRAWL's blackout must not
--                   silently open prod to supervised ops inside the 06:00 stack.
--                   BLOCKS when any occurrence intersects the span.
-- (d) watchdogs   — both `*/2 * * * *` jobs (by schedule; names in the
--                   reading): ≥ 28 runs each in the last 60 min, max wall
--                   ≤ 1.0 s over the last 10 min (0.003–0.13 s healthy, 1–4 s
--                   the pre-failure signature on all three Tuesdays, cc-145 §1);
--                   ZERO `job startup timeout` failures on ANY job in the last
--                   60 min; no cron_job_budget job `running` past its budget.
-- (e) interlock   — prod_session_state(): held = false and live_writers = [].
-- (f) stuck units — no data_sync_log `running` row older than 60 min for any
--                   GUARDED pipeline. The set is DERIVED, not listed (rule 122),
--                   with the same three regexes and the same join as
--                   packages/data/src/lib/cron-job-pipelines.ts
--                   Q_CRON_JOB_PIPELINES — a cron.job's CALLed procedure, whose
--                   body references prod_session_state, and the pipeline name
--                   its data_sync_log INSERT (or c_pipeline) names. A unit test
--                   asserts the regex text here equals the TS constants, so the
--                   two derivations cannot drift apart. rollup_watch_overrides
--                   was the alternative and is NOT used: it is a declaration
--                   table of freshness thresholds, and a pipeline gains a guard
--                   without gaining a row there.
--
-- NOT HERE: the 57014 / front-door 5xx census. It lives in the Logs API and
-- must be readable when Postgres is not (rule 20; the FIX-1125 lesson). The
-- runner reads it in TypeScript (cancellation-census.ts) before it claims and
-- every 15 min while it runs.
--
-- p_now IS FOR TESTS. A time-based gate is only testable if time can be
-- injected: every clock comparison reads p_now, never now()/clock_timestamp()
-- directly. Two inputs cannot be time-shifted and read LIVE whatever p_now says:
-- (e) pg_locks via prod_session_state(), and (f)'s cron.job/pg_proc
-- derivation (the stuck-row age itself does use p_now).
--
-- VOLATILE (clock_timestamp, pg_locks), SECURITY INVOKER — the caller is
-- `postgres` over direct pg, which can read cron.* (service_role has no USAGE
-- on schema cron, measured 2026-09-21, so a service_role call errors rather
-- than answering wrong). search_path is the only SET clause (check:proconfig).
--
-- Cross-refs: FIX-1213 (the claimant GUC the runner sets after this opens),
-- FIX-950 (the interlock), FIX-1212 (the first unattended op), FIX-1124,
-- FIX-1194, FIX-1063 (cron_job_budget), rule 155 (cc-141).

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
  c_nightly_start   CONSTANT time     := '22:35';
  c_nightly_age     CONSTANT interval := interval '6 hours';
  -- (c) FIX-1124 / rule 2: the fallback when pipeline_state.ec_crawl has none.
  c_blackout_from   CONSTANT time     := '05:45';
  c_blackout_to     CONSTANT time     := '09:00';
  -- (b) rule 155.
  c_vac_long_s      CONSTANT numeric  := 60;
  c_vac_long_gap    CONSTANT interval := interval '90 minutes';
  c_vac_any_gap     CONSTANT interval := interval '10 minutes';
  -- (d)
  c_wd_min_runs     CONSTANT int      := 28;
  c_wd_max_wall_s   CONSTANT numeric  := 1.0;

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
  IF v_next_start > p_now AND v_next_start - p_now < 2 * v_exp + interval '15 minutes' THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_next_start',
      'detail', format('next nightly start %s is %s min away; need >= %s (2 x expected + 15 min)',
                       to_char(v_next_start AT TIME ZONE 'UTC', 'MM-DD HH24:MI'),
                       round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
                       round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('nightly', jsonb_build_object(
    'running', v_json,
    'last_phase', v_last_phase,
    'next_start', v_next_start,
    'minutes_to_next_start', round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
    'required_minutes', round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)));

  -- ══ (b) vacuum spacing (rule 155) ═════════════════════════════════════════
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
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
      'running_since', r.running_since, 'next_slot', v_slot);

    IF r.running_since IS NOT NULL THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s running since %s', r.jobname,
                         to_char(r.running_since AT TIME ZONE 'UTC', 'HH24:MI:SS')),
        'retry_after', NULL);
    END IF;

    -- The newest run of each job decides; an older long run inside 90 min is
    -- only possible for a job firing more than once in 90 min, and none does.
    IF r.last_end IS NOT NULL AND r.last_wall_s > c_vac_long_s
       AND r.last_end > p_now - c_vac_long_gap THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s ran %s s, ended %s; +90 min = %s', r.jobname, r.last_wall_s,
                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI'),
                         to_char((r.last_end + c_vac_long_gap) AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', r.last_end + c_vac_long_gap);
    ELSIF r.last_end IS NOT NULL AND r.last_end > p_now - c_vac_any_gap THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s ended %s (%s s); +10 min = %s', r.jobname,
                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI:SS'), r.last_wall_s,
                         to_char((r.last_end + c_vac_any_gap) AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', r.last_end + c_vac_any_gap);
    END IF;

    IF v_slot IS NOT NULL AND r.active AND COALESCE(r.mean_s, 0) > c_vac_long_s
       AND v_slot <= v_span_end THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s (mean %s s over %s runs) is scheduled %s UTC, inside the span to %s',
                         r.jobname, r.mean_s, r.runs_14d,
                         to_char(v_slot AT TIME ZONE 'UTC', 'HH24:MI'),
                         to_char(v_span_end AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', v_slot + make_interval(secs => r.mean_s) + c_vac_long_gap);
    END IF;
  END LOOP;
  v_readings := v_readings || jsonb_build_object('vacuum', jsonb_build_object(
    'jobs', v_vac_jobs, 'unparsed', v_unparsed));

  -- ══ (c) blackout ══════════════════════════════════════════════════════════
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_windows := v_cfg->'blackout';
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'array' OR jsonb_array_length(v_windows) = 0 THEN
    v_windows := jsonb_build_array(jsonb_build_object('from', c_blackout_from::text, 'to', c_blackout_to::text));
    v_source  := 'constant 05:45-09:00 (FIX-1124 fallback: pipeline_state.ec_crawl has no blackout)';
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
  FOR r IN
    SELECT j.jobname,
           count(d.*) FILTER (WHERE d.start_time > p_now - interval '60 minutes')        AS runs_60m,
           round(max(EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))
                   FILTER (WHERE d.start_time > p_now - interval '10 minutes')::numeric, 3) AS max_wall_10m_s,
           round(percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))::numeric, 3)
                                                                                         AS median_wall_60m_s
      FROM cron.job j
      LEFT JOIN cron.job_run_details d
        ON d.jobid = j.jobid
       AND d.start_time >  p_now - interval '60 minutes'
       AND d.start_time <= p_now
     WHERE j.schedule = '*/2 * * * *' AND j.active
     GROUP BY j.jobname
     ORDER BY j.jobname
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

  SELECT count(*), max(d.start_time) INTO v_n, v_t
    FROM cron.job_run_details d
   WHERE d.start_time >  p_now - interval '60 minutes'
     AND d.start_time <= p_now
     AND d.status = 'failed'
     AND d.return_message ILIKE '%startup timeout%';
  IF v_n > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'startup_timeout',
      'detail', format('%s job startup timeout failure(s) in the last 60 min, latest %s', v_n,
                       to_char(v_t AT TIME ZONE 'UTC', 'HH24:MI:SS')),
      'retry_after', v_t + interval '60 minutes');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'jobname', x.jobname, 'age_seconds', x.age_s, 'budget_seconds', x.budget_seconds)), '[]'::jsonb)
    INTO v_json
    FROM (
      SELECT j.jobname, b.budget_seconds,
             round(EXTRACT(epoch FROM (p_now - d.start_time)))::int AS age_s
        FROM cron.job_run_details d
        JOIN cron.job j              ON j.jobid   = d.jobid
        JOIN public.cron_job_budget b ON b.jobname = j.jobname
       WHERE d.status = 'running'
         AND d.start_time <= p_now
         AND d.start_time >  p_now - interval '1 day'
         AND EXTRACT(epoch FROM (p_now - d.start_time)) > b.budget_seconds
    ) x;
  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'budget_overrun',
      'detail', format('%s budgeted job(s) running past budget: %s', jsonb_array_length(v_json), v_json),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('watchdogs', jsonb_build_object(
    'jobs', v_wd, 'startup_timeouts_60m', v_n, 'budget_overruns', v_json));

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
  'for tests. Waited on by session:wait-for-gate.';

REVOKE ALL ON FUNCTION public.prod_op_gate(int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prod_op_gate(int, timestamptz) TO service_role;
