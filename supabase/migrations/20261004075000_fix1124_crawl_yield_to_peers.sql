-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1124 part 1 — the crawls yield to what is RUNNING and what is DUE, not to
-- a clock. cc-189.
--
-- Design of record: design-fix1124-crawl-peer-yield-2026-10-03 D1 / D2 / D3 /
-- D5, as ratified by Craig 2026-10-03 17:44 PDT (lead_s = the 1,800 s unit
-- budget; the daily waits ≤ 600 s then proceeds; fe-crawl joins now). D4 —
-- retiring the blackout and making prod_op_gate's check (c) the same
-- look-ahead — is part 2, after a receipt week. The blackout is NOT touched.
--
-- WHY: the 2026-08-29 seizure was the EC crawl, mid stats window, meeting the
-- 06:00 refresh_derived_mvs 22 ms apart on a 2-vCPU, IOWait-bound box. The
-- answer since has been ec_crawl.blackout [05:45, 09:00] — a clock standing in
-- for two readable facts. And the clock never covered fe-crawl at all:
-- fe_crawl.blackout is [] on prod, and on every one of the 8 mornings
-- 2026-09-26..10-03 a fe-crawl unit overlapped the 06:00 daily AND the 06:30
-- rule taggers (cc-189 read 4). Those units were caught-up no-ops (0.1–0.5 s);
-- the day the FE crawl has real work, the same instant is the 08-29 shape.
--
-- ── WHAT CHANGES ──────────────────────────────────────────────────────────────
--
-- 1. cron_next_daily(p_schedule, p_now) — NEW. prod_op_gate()'s daily-schedule
--    parser (20260920150000:608-616, v_day at :506), lifted so a second reader
--    does not re-implement it. NULL for anything not '^\d+ \d+ \* \* \*$', and
--    NULL for an out-of-range minute or hour (rule 105: ignored, never
--    mis-parsed). prod_op_gate() keeps its own copy UNTOUCHED here; part 2
--    rewires it.
--
-- 2. crawl_gate() — rebuilt on the PROD body (pg_get_functiondef, read
--    2026-10-04 01:48 UTC, byte-equal to 20260828020000_fix1031:140-249 after
--    trailing-whitespace normalisation). Additions only (+N/−0): ten DECLAREs,
--    and the yield_to block between peer_backoff and blackout. Order is now
--    backoff → peer_backoff → peer_running → peer_due → blackout →
--    cycle_cooldown → clear. The two callers are NOT changed: both key their
--    skip counter on v_gate->>'reason' generically
--    (20260911000200:212-223 and :1366-1374), so the new reasons land as new
--    counter keys and, like blackout/cycle_cooldown, write no data_sync_log
--    row — FIX-1111's logging asymmetry, kept.
--    ONE deliberate departure from the prompt's B2: peer_due also holds for a
--    peer that fired under 60 s ago (c_peer_grace_s). See the block's comment.
--
-- 3. peer_wait_gate(p_pipelines, p_wait_max_s) — NEW, box_backoff_gate's shape
--    (20261003030000:201). Polls every 60 s while the EC window-inflight key
--    exists or a data_sync_log 'running' row younger than 6 h exists for one of
--    p_pipelines; returns {clear, waited_s, wait_max_s, polls, blocking}.
--    civitics.peer_gate_wait_max_s (0–3,600) overrides p_wait_max_s for tests.
--
-- 4. refresh_derived_mvs() — rebuilt on the PROD body (byte-equal to
--    20260911000100_fix950_guards_rollup_family:40-…). Additions only: one
--    DECLARE, the daily's peer_wait_gate before the lock, and an UPDATE that
--    adds `gate` to the running row (when the gate waited or was not clear)
--    between the INSERT … RETURNING and the COMMIT that publishes it — so the
--    INSERT itself is byte-identical. NO proconfig: it COMMITs (candidate 237).
--
-- 5. Seeds — ec_crawl and fe_crawl gain yield_to, as a jsonb_set guarded by
--    NOT (value ? 'yield_to') so a later hand edit survives a replay. The two
--    peers are the only fixed jobs between 05:00 and 07:00 UTC:
--      refresh-derived-mvs-daily  0 6 * * *   pipeline refresh_derived_mvs
--      rule-taggers-daily         30 6 * * *  pipeline run_rule_taggers
--    (run_rule_taggers commits its own 'running' row with that pipeline name.)
--
-- Expected firings on a normal morning (lead 1,800 s, grace 60 s):
--   ec-crawl */15 — 05:30 / 05:45 peer_due (daily), 06:00 peer_due (the daily
--     in its grace, else the tagger), 06:15 peer_due (tagger) or peer_running,
--     06:30 peer_due (tagger, grace) or peer_running; 06:45 on → blackout as
--     today until 09:00.
--   fe-crawl */30 — 05:30 peer_due, 06:00 peer_due, 06:30 peer_due; 07:00 clear.
--
-- Rule 34: SECURITY INVOKER, the search_path SET on crawl_gate, and the
-- absence of any SET on refresh_derived_mvs are restated from the prod
-- definitions; the REVOKEs are restated (no-ops on prod, whose ACLs read
-- {postgres=X, service_role=X} for both). New functions follow the sibling
-- convention: REVOKE from PUBLIC, anon, authenticated; GRANT to service_role.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. cron_next_daily() — the lifted daily-schedule parser
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cron_next_daily(
  p_schedule text,
  p_now      timestamptz DEFAULT clock_timestamp()
)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_m    numeric;
  v_h    numeric;
  v_day  date;
  v_slot timestamptz;
BEGIN
  IF p_schedule IS NULL OR p_now IS NULL OR p_schedule !~ '^\d+ \d+ \* \* \*$' THEN
    RETURN NULL;
  END IF;
  v_m := split_part(p_schedule, ' ', 1)::numeric;
  v_h := split_part(p_schedule, ' ', 2)::numeric;
  IF v_m > 59 OR v_h > 23 THEN
    RETURN NULL;
  END IF;
  v_day  := (p_now AT TIME ZONE 'UTC')::date;
  v_slot := (v_day + make_time(v_h::int, v_m::int, 0)) AT TIME ZONE 'UTC';
  IF v_slot < p_now THEN v_slot := v_slot + interval '1 day'; END IF;
  RETURN v_slot;
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_next_daily(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_next_daily(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.cron_next_daily(text, timestamptz) IS
  'FIX-1124 — the next firing at or after p_now of a daily-form pg_cron schedule ''M H * * *'' (UTC), '
  'lifted from prod_op_gate()''s vacuum-spacing parser. NULL for any other form and for an out-of-range '
  'minute or hour: a schedule this cannot read is ignored by its callers, never mis-parsed.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. crawl_gate() — yield_to (prod body; additions only)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.crawl_gate(p_config_key text, p_cursor_key text DEFAULT NULL::text, p_pipeline text DEFAULT NULL::text, p_peer_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cfg        jsonb;
  v_backoff    timestamptz;
  v_peer       timestamptz;
  v_now        timestamptz := clock_timestamp();
  v_tod        time        := (clock_timestamp() AT TIME ZONE 'UTC')::time;
  r            record;
  v_from       time;
  v_to         time;
  v_cursor     jsonb;
  v_min_gap    int;
  v_last_close timestamptz;
  v_age_min    numeric;
  -- FIX-1124 additions
  c_peer_grace_s CONSTANT int := 60;  -- a peer that fired < 60 s ago is still "due"
  v_yield      jsonb;
  v_valid      jsonb := '[]'::jsonb;
  v_sched      text;
  v_active     boolean;
  v_lead       numeric;
  v_due        timestamptz;
  v_since      timestamptz;
  v_peer_job   text;
  v_peer_pipe  text;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = p_config_key;
  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  -- ── backoff (own) ─────────────────────────────────────────────────────────
  v_backoff := (v_cfg->>'backoff_until')::timestamptz;
  IF v_backoff IS NOT NULL AND v_backoff > v_now THEN
    RETURN jsonb_build_object(
      'run',    false,
      'reason', 'backoff',
      'detail', format('backing off until %s (%s s remaining) — a unit ran far over its rolling median',
                       v_backoff, round(EXTRACT(epoch FROM (v_backoff - v_now)))::int),
      'backoff_until', v_backoff);
  END IF;

  -- ── backoff (peer) ────────────────────────────────────────────────────────
  -- FIX-1031: the box's throttle is a property of the BOX, not of whichever
  -- crawl happened to measure it. A sibling crawl that ignored its peer's
  -- backoff would keep writing through exactly the condition the sensor exists
  -- to detect, and the two crawls together would be worse than the single one
  -- this pattern replaced.
  IF p_peer_key IS NOT NULL THEN
    SELECT (value->>'backoff_until')::timestamptz INTO v_peer
      FROM public.pipeline_state WHERE key = p_peer_key;
    IF v_peer IS NOT NULL AND v_peer > v_now THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'peer_backoff',
        'detail', format('peer crawl %s is backed off until %s — the box is throttled for both of us',
                         p_peer_key, v_peer),
        'backoff_until', v_peer);
    END IF;
  END IF;

  -- ── yield_to: peers that are RUNNING or DUE (FIX-1124) ────────────────────
  -- The blackout below is a clock standing in for two facts that are readable:
  -- a fixed job is RUNNING, or it is about to start. v_cfg->'yield_to' names the
  -- jobs this crawl yields to, as [{job, pipeline, lead_s}]:
  --   peer_running — the peer's OWN data_sync_log 'running' row first, then
  --                  cron.job_run_details as the belt. Both bounded to 6 h, so a
  --                  row a crash stranded cannot hold the crawl for longer.
  --   peer_due     — the peer's next daily firing is within lead_s (default
  --                  1,800 s, the crawl's unit budget: a unit started now may
  --                  still be running then), OR it fired under 60 s ago. The
  --                  crawl and its peer fire in the same ~100 ms, and the peer's
  --                  running row is not committed until after its first few
  --                  statements, so without the grace the crawl wins that race
  --                  at the LAST peer's slot every morning (cc-189 read 4).
  -- Every running check precedes every due check: a running peer is the
  -- stronger fact. Fails OPEN like the blackout parser — a malformed entry, a job
  -- that does not exist, or a schedule cron_next_daily() cannot read is a
  -- WARNING and is ignored for that test, never a refusal to crawl. A PARKED job
  -- (cron.job.active = false) never fires, so it is never peer_due.
  v_yield := COALESCE(v_cfg->'yield_to', '[]'::jsonb);
  IF jsonb_typeof(v_yield) IS DISTINCT FROM 'array' THEN
    RAISE WARNING '[%] yield_to is not an array (%) — ignored', p_config_key, v_yield;
    v_yield := '[]'::jsonb;
  END IF;

  FOR r IN SELECT e.value AS y FROM jsonb_array_elements(v_yield) e
  LOOP
    BEGIN
      IF jsonb_typeof(r.y) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'not an object';
      END IF;
      v_peer_job  := NULLIF(r.y->>'job', '');
      v_peer_pipe := NULLIF(r.y->>'pipeline', '');
      v_lead      := COALESCE((r.y->>'lead_s')::numeric, 1800);
      IF v_peer_job IS NULL OR v_peer_pipe IS NULL OR v_lead <= 0 THEN
        RAISE EXCEPTION 'job, pipeline and a positive lead_s are required';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[%] malformed yield_to entry % (%) — ignored', p_config_key, r.y, SQLERRM;
      CONTINUE;
    END;

    SELECT j.schedule, j.active INTO v_sched, v_active
      FROM cron.job j
     WHERE j.jobname = v_peer_job
     ORDER BY j.active DESC, j.jobid
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE WARNING '[%] yield_to names cron job % which does not exist — ignored', p_config_key, v_peer_job;
      CONTINUE;
    END IF;

    v_valid := v_valid || jsonb_build_array(jsonb_build_object(
                 'job', v_peer_job, 'pipeline', v_peer_pipe, 'lead_s', v_lead,
                 'schedule', v_sched, 'active', v_active));
  END LOOP;

  -- peer_running, from the peer's own row …
  FOR r IN SELECT e.value AS y FROM jsonb_array_elements(v_valid) e
  LOOP
    SELECT max(l.started_at) INTO v_since
      FROM public.data_sync_log l
     WHERE l.status     = 'running'
       AND l.started_at > v_now - interval '6 hours'
       AND l.pipeline   = r.y->>'pipeline';
    IF v_since IS NOT NULL THEN
      RETURN jsonb_build_object(
        'run',      false,
        'reason',   'peer_running',
        'detail',   format('peer %s is running since %s', r.y->>'pipeline', v_since),
        'peer',     r.y->>'job',
        'pipeline', r.y->>'pipeline',
        'since',    v_since,
        'source',   'data_sync_log');
    END IF;
  END LOOP;

  -- … then from the scheduler's, as the belt: one scan for every peer.
  IF jsonb_array_length(v_valid) > 0 THEN
    SELECT j.jobname, d.start_time INTO v_peer_job, v_since
      FROM cron.job_run_details d
      JOIN cron.job j ON j.jobid = d.jobid
      JOIN jsonb_array_elements(v_valid) WITH ORDINALITY AS e(y, n)
        ON e.y->>'job' = j.jobname
     WHERE d.status     = 'running'
       AND d.start_time > v_now - interval '6 hours'
     ORDER BY e.n, d.start_time
     LIMIT 1;
    IF v_peer_job IS NOT NULL THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'peer_running',
        'detail', format('peer %s is running since %s (cron.job_run_details; no data_sync_log running row)',
                         v_peer_job, v_since),
        'peer',   v_peer_job,
        'since',  v_since,
        'source', 'cron.job_run_details');
    END IF;
  END IF;

  -- peer_due
  FOR r IN SELECT e.value AS y FROM jsonb_array_elements(v_valid) e
  LOOP
    CONTINUE WHEN NOT (r.y->>'active')::boolean;
    v_due := public.cron_next_daily(r.y->>'schedule', v_now - make_interval(secs => c_peer_grace_s));
    IF v_due IS NULL THEN
      RAISE WARNING '[%] yield_to job % has schedule % — not daily-form, so it can be peer_running but never peer_due',
        p_config_key, r.y->>'job', r.y->>'schedule';
      CONTINUE;
    END IF;
    v_lead := (r.y->>'lead_s')::numeric;
    IF v_due - v_now <= make_interval(secs => v_lead::double precision)
       AND v_now - v_due < make_interval(secs => c_peer_grace_s) THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'peer_due',
        'detail', CASE WHEN v_due > v_now
                       THEN format('peer %s due at %s within %s s', r.y->>'job', v_due, v_lead)
                       ELSE format('peer %s fired at %s (%s s ago) — inside the %s s start grace',
                                   r.y->>'job', v_due,
                                   round(EXTRACT(epoch FROM (v_now - v_due)))::int, c_peer_grace_s)
                  END,
        'peer',   r.y->>'job',
        'due_at', v_due,
        'lead_s', v_lead);
    END IF;
  END LOOP;

  -- ── blackout ──────────────────────────────────────────────────────────────
  -- Wrap-around supported: from > to means the window spans midnight UTC.
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(COALESCE(v_cfg->'blackout', '[]'::jsonb)) e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[%] unparseable blackout entry % — ignored', p_config_key, r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL THEN CONTINUE; END IF;

    IF (v_from <= v_to  AND v_tod >= v_from AND v_tod < v_to)
    OR (v_from >  v_to AND (v_tod >= v_from OR v_tod < v_to))
    THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'blackout',
        'detail', format('inside blackout window %s–%s UTC', v_from, v_to));
    END IF;
  END LOOP;

  -- ── cycle cooldown ────────────────────────────────────────────────────────
  -- Only for a crawl that HAS cycles, and only when none is open. An open cycle
  -- is work already started and must be allowed to finish.
  IF p_cursor_key IS NOT NULL AND p_pipeline IS NOT NULL THEN
    SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = p_cursor_key;

    IF v_cursor IS NULL THEN
      v_min_gap := COALESCE((v_cfg->>'min_cycle_interval_minutes')::int, 0);
      IF v_min_gap > 0 THEN
        SELECT max(completed_at) INTO v_last_close
          FROM public.data_sync_log
         WHERE pipeline = p_pipeline
           AND status   = 'complete';
        IF v_last_close IS NOT NULL THEN
          v_age_min := EXTRACT(epoch FROM (v_now - v_last_close)) / 60.0;
          IF v_age_min < v_min_gap THEN
            RETURN jsonb_build_object(
              'run',    false,
              'reason', 'cycle_cooldown',
              'detail', format('last cycle closed %s min ago; minimum interval is %s min',
                               round(v_age_min)::int, v_min_gap));
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('run', true, 'reason', 'clear');
END;
$function$;

REVOKE ALL ON FUNCTION public.crawl_gate(text, text, text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.crawl_gate(text, text, text, text) IS
  'FIX-1031 — the FIX-1111 crawl gate, generalised over its config key so more '
  'than one crawl can share one implementation. Checks cheapest first: own '
  'backoff_until, PEER backoff_until (a throttle is a property of the box, not '
  'of whichever crawl measured it), FIX-1124 yield_to peers (peer_running from '
  'the peer''s own data_sync_log row then cron.job_run_details, both bounded to '
  '6 h; then peer_due — the peer''s next daily firing within lead_s, or one that '
  'fired < 60 s ago), configured blackout windows, and — only for a crawl that '
  'has a cycle cursor, and only when no cycle is open — a minimum interval '
  'since the last cycle CLOSED. Returns a verdict; the caller owns all logging. '
  'ec_crawl_gate() delegates here with the EC keys.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. peer_wait_gate() — the daily's belt
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.peer_wait_gate(
  p_pipelines  text[],
  p_wait_max_s int
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_poll_s   CONSTANT int := 60;
  v_cfg      int;
  v_max      int := GREATEST(COALESCE(p_wait_max_s, 0), 0);
  v_started  timestamptz := clock_timestamp();
  v_waited   double precision := 0;
  v_polls    int := 0;
  v_blocking jsonb;
BEGIN
  -- Break-glass / test override. Unset (the default everywhere) = the argument.
  v_cfg := NULLIF(current_setting('civitics.peer_gate_wait_max_s', true), '')::int;
  IF v_cfg IS NOT NULL THEN
    v_max := GREATEST(0, LEAST(v_cfg, 3600));
  END IF;

  LOOP
    -- Each statement takes a fresh snapshot (READ COMMITTED), so a unit that
    -- commits its terminal row during the wait is seen on the next poll.
    SELECT COALESCE(jsonb_agg(b.v ORDER BY b.since), '[]'::jsonb) INTO v_blocking
      FROM (
        SELECT s.value->>'started_at' AS since,
               jsonb_build_object('kind',        'ec_window_inflight',
                                  'since',       s.value->>'started_at',
                                  'window_idx',  s.value->'window_idx',
                                  'backend_pid', s.value->'backend_pid') AS v
          FROM public.pipeline_state s
         WHERE s.key = 'entity_connections_window_inflight'
        UNION ALL
        SELECT l.started_at::text,
               jsonb_build_object('kind',     'running_row',
                                  'pipeline', l.pipeline,
                                  'since',    l.started_at,
                                  'log_id',   l.id)
          FROM public.data_sync_log l
         WHERE l.status     = 'running'
           AND l.started_at > clock_timestamp() - interval '6 hours'
           AND l.pipeline   = ANY (p_pipelines)
      ) b;
    v_polls  := v_polls + 1;
    v_waited := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    EXIT WHEN jsonb_array_length(v_blocking) = 0 OR v_waited >= v_max;
    RAISE NOTICE '[peer gate] % in flight — waited % of % s',
      jsonb_array_length(v_blocking), round(v_waited)::int, v_max;
    PERFORM pg_sleep(LEAST(c_poll_s, v_max - v_waited));
  END LOOP;

  RETURN jsonb_build_object(
    'clear',      jsonb_array_length(v_blocking) = 0,
    'waited_s',   round(v_waited)::int,
    'wait_max_s', v_max,
    'polls',      v_polls,
    'blocking',   v_blocking);
END;
$function$;

REVOKE ALL ON FUNCTION public.peer_wait_gate(text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.peer_wait_gate(text[], int) TO service_role;

COMMENT ON FUNCTION public.peer_wait_gate(text[], int) IS
  'FIX-1124 — waits (60 s polls) while pipeline_state.entity_connections_window_inflight exists or a '
  'data_sync_log running row younger than 6 h exists for any of p_pipelines, until clear or p_wait_max_s '
  '(civitics.peer_gate_wait_max_s overrides, 0-3600). Returns {clear, waited_s, wait_max_s, polls, blocking}. '
  'Answers only; the caller decides. Holds no lock; call it BEFORE taking one.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. refresh_derived_mvs() — the daily waits ≤ 600 s on an in-flight unit
--    (prod body; additions only)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(IN p_cadence text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('refresh_derived_mvs')::bigint;  -- shared by both cadences: never two at once
  v_log_id   uuid;
  v_units    text[];   -- SQL command per unit
  v_labels   text[];   -- human label per unit (data_sync_log / NOTICE)
  v_cmd      text;
  v_label    text;
  v_ok       int := 0;
  v_failures text[] := ARRAY[]::text[];
  i          int;
  -- FIX-1021 additions
  c_budget     double precision;         -- seconds; per-cadence, GUC-overridable
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_unit_beg   timestamptz;
  v_unit_secs  double precision;
  v_max_unit   double precision := 0;
  v_elapsed    double precision := 0;
  v_unit_times jsonb := '{}'::jsonb;     -- label -> seconds, ALWAYS written
  v_skipped    text[] := ARRAY[]::text[];
  v_budget_hit boolean := false;
  v_canceled   text := NULL;             -- non-NULL = query_canceled caught
  v_status     text;
  -- FIX-1030 addition
  c_unit_budget int;                     -- seconds; per-UNIT, enforced externally
  -- FIX-1152 addition
  v_vm          jsonb;                   -- visibility-map state this run ran against
  -- FIX-1124 addition
  v_gate        jsonb;                   -- peer_wait_gate() verdict (daily only)
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'refresh_derived_mvs: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  -- FIX-1124 — the daily waits up to 600 s for an in-flight crawl unit, then
  -- PROCEEDS whatever the answer (D2): a skip would cost the day's freshness
  -- (FIX-1140 counts only `complete`), and this is the belt. What keeps a unit
  -- from STARTING inside the 1,800 s before 06:00 is the crawls' own yield_to
  -- (crawl_gate, peer_due). Before the lock, so a waiting firing holds nothing;
  -- the wait holds a snapshot for at most 600 s (box_backoff_gate's trade-off,
  -- FIX-1194). v_started is already set, so the predictive budget counts the
  -- wait. The weekly is not gated.
  IF p_cadence = 'daily' THEN
    v_gate := public.peer_wait_gate(
                ARRAY['entity_connections_rebuild', 'financial_entity_totals_refresh'], 600);
  END IF;
  -- Session advisory lock (survives the per-unit COMMITs below). Stampede guard.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent refresh_derived_mvs',
                               'source', 'pg_cron'));
    RAISE NOTICE '[derived-mvs] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[derived-mvs] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Bounded per-unit memory. Plain SET (not SET LOCAL) survives the COMMITs.
  SET work_mem = '128MB';

  -- FIX-1109 finding 2 / FIX-1129: parallel workers OFF for the weekly cadence.
  -- The weekly's units 1 and 2 both build a hash over the whole of
  -- financial_entities (3.06M rows; width 16 for unit 1, width 26 for unit 2).
  -- Under a Parallel Hash Join that build lives in a DYNAMIC SHARED MEMORY
  -- segment, and on 2026-08-25 unit 2's segment could not grow:
  --   could not resize shared memory segment "/PostgreSQL.3323093180"
  --   to 134217728 bytes: No space left on device
  -- 134217728 = 128MB = exactly the work_mem set above, and 3.06M x 26 bytes
  -- plus tuple overhead is what asks for it. Reproduced on the prod-scale clone
  -- (2026-09-03): unit 2 at max_parallel_workers_per_gather=1 fails with the
  -- same error, and at 0 completes in 32.2s.
  --
  -- With no parallelism the same join becomes a plain Hash Join whose build is
  -- PRIVATE backend memory, bounded by work_mem x hash_mem_multiplier
  -- (128MB x 2 = 256MB) and permitted to spill to disk in batches instead of
  -- failing. Measured on the clone, this is not a speed trade: unit 1 ran
  -- 24.2s at 0 against 57.3s at 1, and units 3-6 plan identically either way.
  --
  -- Weekly ONLY. The daily cadence is untouched: none of its units joins
  -- financial_entities and it has never hit this failure class.
  IF p_cadence = 'weekly' THEN
    SET max_parallel_workers_per_gather = 0;
  END IF;

  -- FIX-1021: per-cadence budget. Measured 2026-08-12: work_mem is NOT the
  -- lever here (unit 1 measured 185 s at 256MB vs 198 s at 128MB, identical
  -- plan), so this stays as FIX-748 set it.
  c_budget := CASE p_cadence WHEN 'weekly' THEN 4200 ELSE 3300 END;
  v_budget_cfg := NULLIF(current_setting('civitics.derived_mvs_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := v_budget_cfg;
  END IF;

  -- FIX-1030: per-UNIT budget. Published for enforce_derived_mvs_unit_budget(),
  -- which runs in a different session and cannot read this session's GUC.
  -- NOTE: this procedure cannot enforce it itself — statement_timeout is armed
  -- once at CALL time and neither SET nor SET LOCAL re-arms it across a
  -- procedure's COMMIT (verified on PG 17; see the header and FIX-703).
  c_unit_budget := COALESCE(
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int, 900);

  IF p_cadence = 'daily' THEN
    -- proposal/vote/comment/engagement-derived + co-located daily maintenance.
    -- FIX-748: rebuild_entity_search_index appended (daily superset — new
    -- entities land on the nightly ingest; TRUNCATE+INSERT is atomic per unit).
    v_labels := ARRAY[
      'proposal_trending_24h', 'proposal_popularity_24h', 'homepage_stats_mv',
      'official_homepage_stats_mv', 'entity_engagement_rollup_mv',
      'homepage_agency_counts_mv', 'commons_active_threads', 'pipeline_runtime_stats_mv',
      'rebuild_entity_search_index',
      'rebuild_all_primary_sources', 'prune_platform_usage_snapshot',
      'prune_kill_switch_events', 'prune_status_snapshot'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_trending_24h',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_popularity_24h',
      'REFRESH MATERIALIZED VIEW public.homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.commons_active_threads',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.pipeline_runtime_stats_mv',
      'SELECT public.rebuild_entity_search_index()',
      'SELECT public.rebuild_all_primary_sources()',
      'SELECT public.prune_platform_usage_snapshot()',
      'SELECT public.prune_kill_switch_events()',
      'SELECT public.prune_status_snapshot()'
    ];
  ELSE  -- weekly (donation-derived)
    v_labels := ARRAY[
      'chord_industry_flows_mv', 'chord_donor_type_party_flows_mv',
      'chord_donor_state_party_flows_mv', 'chord_subject_party_flows_mv',
      'official_sector_dollars_mv', 'refresh_spending_totals'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_industry_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_type_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_state_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_subject_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_sector_dollars_mv',
      'SELECT public.refresh_spending_totals()'
    ];
  END IF;

  -- FIX-1152 — record the visibility map this run ran against.
  --
  -- A vacuum receipt is a RATE, not a reading: the search unit measured 202.5s
  -- (2026-09-02, 4h after a vacuum), 1017.4s / 1015.0s / 1012.0s on the three
  -- days after it, then 234.8s and 236.0s on the two days following the next
  -- one. Reconstructing which visibility-map state each of those ran against
  -- took a Cowork pass over pg_class every time, and pg_class only ever holds
  -- NOW -- the state at 06:00 three days ago is not recoverable from anything.
  -- So the run records it itself, and from here every unit_seconds reading is
  -- paired with the heap state that produced it.
  --
  -- entity_connections and financial_entities specifically: those are the two
  -- relations rebuild_entity_search_index scans, and the two whose all-visible
  -- fraction the FIX-884 index-only-scan degradation keys on.
  --
  -- Taken at RUN START rather than immediately before the search unit, which is
  -- both simpler and strictly more useful: neither relation is written by any
  -- of the eight units that precede it, so the value is the same, and taking it
  -- here means a run that dies BEFORE reaching the search unit still carries the
  -- reading -- which is exactly the 'partial' case this exists to explain.
  --
  -- Catalog-only: pg_class and pg_stat_user_tables, two index lookups each. It
  -- mirrors the vm[] shape check_rebuild_autovacuum_status() publishes (FIX-885)
  -- so both can be read with the same expression.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'relation',        t.relname,
           'relpages',        t.relpages,
           'relallvisible',   t.relallvisible,
           'pct_all_visible', CASE WHEN t.relpages > 0
                                   THEN round(100.0 * t.relallvisible / t.relpages, 1)
                                   ELSE 100.0 END,
           'n_dead_tup',      t.n_dead_tup,
           'n_live_tup',      t.n_live_tup,
           'last_vacuum',     t.last_vacuum,
           'last_autovacuum', t.last_autovacuum
         ) ORDER BY t.relname), '[]'::jsonb)
    INTO v_vm
    FROM (
      SELECT c.relname, c.relpages, c.relallvisible,
             s.n_dead_tup, s.n_live_tup, s.last_vacuum, s.last_autovacuum
      FROM pg_class c
      JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname IN ('entity_connections', 'financial_entities')
    ) t;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('refresh_derived_mvs', 'running', now(),
          jsonb_build_object('cadence', p_cadence,
                             'units', array_length(v_units, 1),
                             'budget_seconds', c_budget,
                             'unit_budget_seconds', c_unit_budget,
                             'vm_before', v_vm,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  -- FIX-1124 — the gate lands in the running row only when it shaped the run.
  IF v_gate IS NOT NULL
     AND (NOT (v_gate->>'clear')::boolean OR (v_gate->>'waited_s')::int > 0) THEN
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('gate', v_gate)
     WHERE id = v_log_id;
  END IF;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd   := v_units[i];
    v_label := v_labels[i];

    -- FIX-1021 PREDICTIVE budget check (FIX-944 idiom): stop when the slowest
    -- unit observed so far, plus 25% headroom, would not fit in what remains.
    -- Deliberately BETWEEN units — playbook C3, a REFRESH cannot be interrupted
    -- from inside.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_unit > 0 AND v_elapsed + (v_max_unit * 1.25) > c_budget THEN
      v_budget_hit := true;
      -- Everything from here on is skipped; name each one so the log says what
      -- is stale rather than just that something is.
      v_skipped := v_skipped || v_labels[i : array_length(v_labels, 1)];
      RAISE WARNING '[derived-mvs] budget guard — stopping before % (elapsed %s of %s budget, slowest unit %s); % unit(s) skipped',
        v_label, round(v_elapsed)::int, round(c_budget)::int, round(v_max_unit)::int,
        array_length(v_skipped, 1);
      EXIT;
    END IF;

    v_unit_beg := clock_timestamp();

    -- FIX-1030: publish the in-flight unit and COMMIT, so
    -- enforce_derived_mvs_unit_budget() — running in another session, on its
    -- own pg_cron cadence — can see WHICH unit is running, since when, and in
    -- which backend. Without this commit the watchdog sees nothing: everything
    -- this transaction writes is invisible to it until the unit ends, which is
    -- exactly the case it exists to handle.
    UPDATE public.data_sync_log
    SET metadata = metadata || jsonb_build_object(
                     'current_unit',            v_label,
                     'current_unit_index',      i,
                     'current_unit_started_at', v_unit_beg,
                     'backend_pid',             pg_backend_pid())
    WHERE id = v_log_id;
    COMMIT;

    BEGIN
      EXECUTE v_cmd;
      v_ok := v_ok + 1;
      RAISE NOTICE '  [derived-mvs] % — ok', v_label;
    EXCEPTION
      -- FIX-1021: query_canceled is NOT matched by OTHERS (PL/pgSQL trapping
      -- rules), and statement_timeout raises exactly that. Trapping it by name
      -- is the only way this procedure can close its own row. The docs' caution
      -- about swallowing user cancels is answered by the EXIT below: we stop the
      -- whole loop immediately and do nothing but bookkeeping afterwards, so a
      -- deliberate pg_cancel_backend still ends the run — it just ends it
      -- tidily instead of leaving a stranded 'running' row behind.
      -- FIX-1030: this is now also the landing point for the unit watchdog's
      -- cancel, which is why that watchdog needs no error path of its own.
      WHEN query_canceled THEN
        v_canceled := format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — CANCELED (statement_timeout, unit watchdog, or operator cancel): %', v_label, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — FAILED: %', v_label, SQLERRM;
    END;

    -- Timing is recorded for EVERY outcome (ok, failed, canceled) — a unit that
    -- died at 6 h is the single most interesting number in the run.
    v_unit_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_unit_beg));
    v_unit_times := v_unit_times || jsonb_build_object(v_label, round(v_unit_secs::numeric, 1));
    IF v_unit_secs > v_max_unit THEN
      v_max_unit := v_unit_secs;
    END IF;

    COMMIT;

    IF v_canceled IS NOT NULL THEN
      -- The timer that fired is disarmed once it has thrown, so the bookkeeping
      -- UPDATE below still runs. Continuing the loop would not: the next unit
      -- would be starting on a box that has already proven it cannot finish one.
      IF i < array_length(v_units, 1) THEN
        v_skipped := v_skipped || v_labels[i + 1 : array_length(v_labels, 1)];
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_status := CASE
                WHEN v_canceled IS NOT NULL THEN 'partial'
                WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                WHEN v_budget_hit THEN 'partial'
                ELSE 'complete'
              END;

  UPDATE public.data_sync_log
  SET status        = v_status,
      completed_at  = now(),
      rows_inserted = v_ok,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled mid-unit — %s; %s unit(s) skipped',
                                           v_canceled, COALESCE(array_length(v_skipped, 1), 0)), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_budget_hit
                          THEN left(format('budget exhausted after %ss of %ss — %s unit(s) skipped: %s',
                                           round(v_elapsed)::int, round(c_budget)::int,
                                           COALESCE(array_length(v_skipped, 1), 0),
                                           array_to_string(v_skipped, ', ')), 1000)
                        ELSE NULL
                      END,
      -- FIX-1030: strip the in-flight publish keys, so a terminal row never
      -- looks like it is mid-unit to the watchdog or to a human reading it.
      metadata      = (metadata
                        - 'current_unit' - 'current_unit_index'
                        - 'current_unit_started_at' - 'backend_pid')
                      || jsonb_build_object(
                        'units_ok', v_ok,
                        'unit_failures', COALESCE(array_length(v_failures, 1), 0),
                        'unit_seconds', v_unit_times,
                        'elapsed_seconds', round(v_elapsed::numeric, 1),
                        'slowest_unit_seconds', round(v_max_unit::numeric, 1),
                        'budget_hit', v_budget_hit,
                        'canceled', v_canceled IS NOT NULL,
                        'skipped_units', to_jsonb(v_skipped))
  WHERE id = v_log_id;

  RAISE NOTICE '[derived-mvs] % (cadence=%) — %/% units ok (% failures, % skipped, %ss elapsed)',
    upper(v_status), p_cadence, v_ok, array_length(v_units, 1),
    COALESCE(array_length(v_failures, 1), 0), COALESCE(array_length(v_skipped, 1), 0),
    round(v_elapsed)::int;

  -- FIX-1109 finding 1: a failed unit must fail the CALL.
  -- Until now this procedure returned normally on EVERY path, so a run whose
  -- own data_sync_log row said 'failed' was recorded by pg_cron as
  -- 'succeeded' (prod, jobid 10, 2026-08-25: runid 15272 succeeded / 1361.9s,
  -- while the sync row for the same run says failed on
  -- chord_donor_type_party_flows_mv). That hid the failure from
  -- cron.job_run_details, from check_cron_job_health() and from FIX-1073's
  -- escalation tiers -- every consumer that keys on pg_cron's own verdict.
  --
  -- Order matters: COMMIT makes the terminal row durable, and the advisory
  -- unlock is session-scoped (not transactional), so both survive the raise.
  -- Raising before either would roll the terminal UPDATE back and strand the
  -- lock, which is the failure mode this is meant to end, not start.
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  -- 'partial' deliberately does NOT raise: a budget stop and a watchdog cancel
  -- are this system's own decisions, already recorded in the row, and pg_cron
  -- should not be told that its job errored when the bound worked as designed.
  IF v_status = 'failed' THEN
    RAISE EXCEPTION '[derived-mvs] % of % unit(s) FAILED (cadence=%): %',
      COALESCE(array_length(v_failures, 1), 0), array_length(v_units, 1),
      p_cadence, array_to_string(v_failures, '; ');
  END IF;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_derived_mvs(text) FROM PUBLIC, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Seeds — both crawls yield to the two 06:xx jobs (data; idempotent)
-- ═══════════════════════════════════════════════════════════════════════════
-- NOT (value ? 'yield_to') keeps a later hand edit of the list: a replay of this
-- file never overwrites it. `blackout` is untouched (part 2).

UPDATE public.pipeline_state
   SET value = jsonb_set(
                 value,
                 '{yield_to}',
                 '[{"job": "refresh-derived-mvs-daily", "pipeline": "refresh_derived_mvs", "lead_s": 1800},
                   {"job": "rule-taggers-daily",        "pipeline": "run_rule_taggers",    "lead_s": 1800}]'::jsonb,
                 true),
       updated_at = now()
 WHERE key IN ('ec_crawl', 'fe_crawl')
   AND NOT (value ? 'yield_to');
