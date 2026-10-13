-- =============================================================================
-- FIX-1308 — the unit dispatcher (R2 of spec-job-registry-and-dispatcher-
-- 2026-10-11 v1.1 §3, as corrected by C1–C4; cc-224, built 2026-10-13).
--
-- WHAT. dispatch_one_unit() reads FIX-1307's job_registry / platform_dials /
-- dispatch_log and, once per tick, does at most ONE thing: it ARMS the best
-- due registry row as a one-shot pg_cron job. dispatch_tick() is the thin
-- PROCEDURE pg_cron CALLs on odd minutes. The Vercel box-health route calls the
-- same function when the newest dispatch_log row is more than 6 min old (the
-- re-fire). get_dispatcher_status() is the read-only tile's one RPC.
--
-- ZERO ELIGIBLE ROWS AT LANDING. Every registry row is still `at <its cron
-- schedule>` (FIX-1307's seed, D12), and `at` rows are never dispatched. So the
-- tick lands logging `nothing_due` / `no eligible rows` on odd minutes and arms
-- nothing. The proving (s6, Thu 10-15 23:15Z → Mon 10-19 ~02:00Z) measures the
-- tick itself; M1 (donor-rollup-refresh → stale_after) is the first row move.
--
-- ── DECISIONS (the spec's letters; C1–C4 are Cowork's 10-11 corrections) ─────
--
-- D1 / C2 / C3  Substrate = pg_cron. The tick is `CALL public.dispatch_tick();`
--   on '1-59/2 * * * *' with a 120 s cron_job_budget row (rule 120: a CALL job
--   gets a budget; the watchdog cancels CALLs only). ODD minutes: '*/2' lands on
--   the two */2 watchdogs' second, three libpq connections inside pg_cron's
--   ~10 s startup window; the */2 Vercel box-health route then looks when a
--   healthy tick is <= 1 min old. dispatch_tick() is a PROCEDURE with NO
--   proconfig (rule 237: pg_cron's top-level CALL stays non-atomic). The work is
--   dispatch_one_unit(), a VOLATILE SECURITY DEFINER FUNCTION owned by postgres
--   with SET search_path public, pg_catalog, cron — cron.schedule / unschedule
--   need schema cron, which service_role lacks (rule 149, the FIX-1194 lesson;
--   check_cron_job_health() is the precedent). A search_path proconfig on a
--   FUNCTION is fine: it never COMMITs, and check:proconfig only fails an inert
--   statement_timeout.
-- C1  Every unit is ARMED as a one-shot pg_cron job; the dispatcher never
--   EXECUTEs a unit inline. cron.schedule('disp-<job>-<epoch s>',
--   '<MI> <HH> <DD> <MM> *', <unit_call verbatim>) for the next ODD minute
--   >= now + 60 s that is not :15/:45 (the crawl slots). The one-shot runs
--   top-level as postgres, so a COMMITting procedure COMMITs and a VACUUM runs
--   outside a transaction block. It gets its own cron.job_run_details row and
--   backend, so the budget watchdog, prod_op_gate (d) and record_box_health()
--   see it with zero body changes. When the registry row has budget_seconds,
--   the cron_job_budget row for the one-shot is INSERTed BEFORE cron.schedule
--   and DELETEd at reap (a bare VACUUM row has none — rule 120/275). Why not
--   inline EXECUTE: (a) `EXECUTE 'CALL p()'` from plpgsql runs the callee
--   atomic and a COMMITting unit dies at its first COMMIT (FIX-1128; measured on
--   the clone by cc-224); (b) an inline unit holds the tick's lock for the
--   unit's wall, so a second unit can never dispatch and max_concurrent_units
--   is a dead dial; (c) occupancy / budget / cancel all come free from the
--   one-shot's own run row. Cost: <= 2 min dispatch latency, two catalog rows
--   per unit.
-- C4  dispatch_log retention lives inside the tick (step 2b).
-- D3  The box rule: a row is eligible only if Σ cap_mb over live occupants +
--   its own cap_mb <= max_live_caps_mb AND live units < max_concurrent_units.
--   The D8 headroom test (MemAvailable − cap >= headroom_target_mb) waits for
--   FIX-1125's sensor — see the marked comment in step 6.
-- D4 / D10  No unit sizing here: unit_call runs verbatim (today's atomic runs).
--   unit_target_seconds is stored and read by get_dispatcher_status() and acted
--   on by NOBODY yet.
-- D8  Dials are rows. pause → every tick logs `paused` and arms nothing (the
--   Vercel re-fire calls this same function, so it obeys too). tick_seconds →
--   the AFTER UPDATE trigger below re-schedules 'dispatcher-tick' by NAME to
--   '1-59/N * * * *', N = GREATEST(1, ceil(tick_seconds / 60.0)). The
--   schedule is never edited by hand.
-- D11  bare rows arm their VACUUM statement exactly like any unit.
-- D12  The first dial values are R1's defaults, untouched.
--
-- ── THE NETS ──────────────────────────────────────────────────────────────────
--   platform_dials.pause; max_live_caps_mb; the */2 budget watchdog cancels an
--   over-budget one-shot CALL (its budget row is the registry's budget_seconds);
--   the front-door auto-restart; every row move is a data revert. THE HARD STOP
--   IS `pause = true`, then `SELECT cron.unschedule('dispatcher-tick')`: the
--   unschedule alone stops only the pg_cron path, and the box-health route
--   re-fires a dispatcher whose newest row is > 360 s old, so an unscheduled but
--   unpaused dispatcher still arms a unit every ~6–8 min through Vercel. Both
--   paths call dispatch_one_unit(), and it reads pause first.
--
-- ── PROVENANCE (cc-224) ──────────────────────────────────────────────────────
--   prod read 2026-10-13T22:51:24Z (pg_settings): cron.timezone GMT,
--   cron.use_background_workers off, cron.max_running_jobs 32, cron.log_run on,
--   cron.log_statement on. The one-shot schedules below are written in UTC to
--   match cron.timezone.
--   cron.job_run_details has NO index but its runid PK, and is owned by
--   supabase_admin (read on the clone). Every read of it here is guarded so it
--   happens only while a one-shot is armed or a bare row is due, never on an
--   idle tick.
--
-- IDEMPOTENT: CREATE OR REPLACE, ON CONFLICT DO NOTHING, the tick scheduled by
-- NAME (the fix1239 shape). The clone gets this file through
-- `db-query.mjs --local --call --file`; cc-227 pushes it Thu 10-15 23:15Z+.
--
-- ROLLBACK (pause first — see THE NETS):
--   UPDATE public.platform_dials SET pause = true;
--   SELECT cron.unschedule('dispatcher-tick');
--   DELETE FROM public.cron_job_budget WHERE jobname = 'dispatcher-tick';
--   DROP TRIGGER platform_dials_tick_reschedule ON public.platform_dials;
--   DROP FUNCTION public.dispatch_one_unit(text), public.get_dispatcher_status(),
--     public.in_blackout(text, timestamptz), public.platform_dials_tick_reschedule();
--   DROP PROCEDURE public.dispatch_tick();
--   DELETE FROM public.job_registry WHERE job = 'dispatcher-tick';
--   (the three tables are FIX-1307's and stay.)
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- (a) in_blackout() — crawl_gate()'s blackout parse, without crawl_gate's
--     other checks (20261004075000: the `blackout` loop). Fails OPEN.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.in_blackout(
  p_config_key text,
  p_now        timestamptz DEFAULT clock_timestamp()
)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cfg  jsonb;
  v_tod  time;
  r      record;
  v_from time;
  v_to   time;
BEGIN
  IF p_config_key IS NULL OR p_now IS NULL THEN
    RETURN false;
  END IF;
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = p_config_key;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg->'blackout') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  v_tod := (p_now AT TIME ZONE 'UTC')::time;

  -- Wrap-around supported: from > to means the window spans midnight UTC.
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(v_cfg->'blackout') e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[%] unparseable blackout entry % — ignored', p_config_key, r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL THEN CONTINUE; END IF;

    IF (v_from <= v_to AND v_tod >= v_from AND v_tod < v_to)
    OR (v_from >  v_to AND (v_tod >= v_from OR v_tod < v_to))
    THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.in_blackout(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.in_blackout(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.in_blackout(text, timestamptz) IS
  'FIX-1308 — is p_now inside one of pipeline_state.<p_config_key>->''blackout'' '
  '[{from, to}] UTC windows? crawl_gate()''s parse (wrap-around supported), with none of '
  'crawl_gate''s other checks. Fails OPEN: an absent key, a non-array or an unparseable '
  'entry reads false.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (b) dispatch_one_unit() — one tick: reap, read the box, take the census,
--     pick, ARM at most one unit. Every step that ends the tick writes ONE
--     dispatch_log row; the reap writes one row per one-shot it closes.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Steps (the decision each one can end on):
--   1  the xact-scoped advisory lock — `lock_busy`. Ticks never overlap, and a
--      cancelled tick frees it.
--   2  the one platform_dials row — `no_dials`; pause — `paused`.
--   2b retention (C4): 01:45–01:59 UTC, rows older than 14 days.
--   3  REAP every un-reaped `armed` row. A terminal run row → unschedule, drop
--      its budget row, `reaped` (unit_ms, `<status>: <return_message>`). A
--      non-terminal run row → it is an occupant (step 5). No run row and the
--      cron.job row gone → `reaped`, 'job row gone'. No run row by armed_for +
--      3 × tick_seconds → unschedule, drop the budget row, `missed` (the
--      registry row stays eligible: a missed one-shot never started, so
--      re-arming is safe whatever idempotent_refire says).
--   4  the box: box_is_saturated(p_include_watchdog_wall := false) — `skipped`.
--   5  the census of live occupants, four sources: the un-reaped armed
--      one-shots; data_sync_log `running` rows < 6 h old (by pipeline);
--      pg_stat_activity backends running `CALL|SELECT [public.]<routine>(` of
--      a registry row that has an exclusion_group (the probes and watchdogs
--      have none: they are millisecond SELECTs on their own clocks, and
--      counting them would make live_units flicker with the second a tick
--      lands); pg_stat_progress_vacuum, manual AND autovacuum, matched to the
--      bare row naming the table. One physical unit seen by several sources is
--      ONE unit: each observation resolves to a representative registry job
--      (an armed job first, then an active cron job, then the larger cap), and
--      units / caps count distinct representatives. An autovacuum on a table
--      no row names adds 64 MB to the caps and no unit and no group.
--   6  PICK: runner = 'pg_cron', deadline_rule NOT LIKE 'at %'. A row is DUE
--      when its time-to-deadline is <= 0; BY means by the deadline, never
--      early. Order (priority, time_to_deadline, job). Excluded, first reason
--      wins: already live, exclusion_group busy, live units at the max, Σ caps
--      over the max, then the gates (prod_session = held, blackout =
--      in_blackout('ec_crawl'), peer = peer_wait_gate(ARRAY[pipeline], 0);
--      'box' was step 4). Nothing armable → `nothing_due`, naming the would-be
--      top row's exclusion and the next not-yet-due row.
--   7  ARM — `armed`.
-- Any error inside steps 2–7 rolls them back and logs `error` with SQLSTATE.
--
-- Deadline forms (time_to_deadline):
--   stale_after <iv>   (last complete + iv) − now. Last complete = for a row
--       with a pipeline, max(data_sync_log.completed_at) of complete|partial
--       rows; for one without (a bare VACUUM), the later of the job's OWN cron
--       name's last succeeded run and the newest `reaped` row for the job whose
--       reason starts `succeeded`. Never completed → due now (−1 s).
--   by <M H * * *>     the most recent daily slot <= now is a deadline that has
--       passed; if nothing completed since it, due (slot − now <= 0), else the
--       next slot − now. A non-daily schedule → `unsupported_deadline`.
--       (cron_next_daily(<cron>, now) − now alone is >= 0 by construction, so
--       a row would never be due; cc-224 report §5.)
--   dead_tuples > <pct>% of trigger [+ floor <iv>]
--       trigger = autovacuum_vacuum_threshold + scale_factor × reltuples
--       (reloptions first, then the GUCs). Due when n_dead_tup >= trigger ×
--       pct/100; with a floor, also when (last vacuum end + floor) − now <= 0.
--       Neither knowable → not due.
--   anything else → `unsupported_deadline`, once per tick per row, excluded.
--
-- Bounded by construction: job_registry (<= 60 rows), platform_dials (1),
-- dispatch_log through its two indexes, pg_stat_activity,
-- pg_stat_progress_vacuum, data_sync_log via (status, started_at) and
-- (pipeline, started_at), pg_stat_user_tables for the due VACUUM rows only.
-- cron.job_run_details (no jobid index) is read only while a one-shot is armed
-- or a pipeline-less row has a stale_after / by deadline.

CREATE OR REPLACE FUNCTION public.dispatch_one_unit(p_source text DEFAULT 'pg_cron')
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'cron'
AS $function$
DECLARE
  c_lock_key    CONSTANT bigint   := hashtext('dispatcher_tick')::bigint;
  c_retention   CONSTANT interval := interval '14 days';
  c_running_win CONSTANT interval := interval '6 hours';
  c_cap_default CONSTANT int      := 64;
  c_tick_job    CONSTANT text     := 'dispatcher-tick';
  v_now        timestamptz := clock_timestamp();
  v_source     text := COALESCE(p_source, 'pg_cron');
  v_dials      public.platform_dials%ROWTYPE;
  v_have_dials boolean := false;
  v_row        public.dispatch_log%ROWTYPE;
  -- the final row
  v_decision   text;
  v_job        text;
  v_reason     text;
  v_box_out    jsonb;
  v_armed_id   bigint;
  v_armed_name text;
  v_armed_for  timestamptz;
  -- step 2b
  v_purged     int := 0;
  -- step 3
  r            record;
  -- step 4
  v_box        jsonb;
  -- step 5
  v_armed_jobs  text[] := '{}';
  v_armed_names text[] := '{}';
  v_live_units  int;
  v_live_caps   int;
  v_live_jobs   text[] := '{}';
  v_busy_groups text[] := '{}';
  v_held        boolean;
  -- step 6
  v_cron_last   jsonb := '{}'::jsonb;
  v_last        timestamptz;
  v_ttd         interval;
  v_iv          interval;
  v_bad         text;
  v_why         text;
  v_m           text[];
  v_slot_next   timestamptz;
  v_slot_prev   timestamptz;
  v_reltuples   double precision;
  v_relopts     text[];
  v_dead        bigint;
  v_lastvac     timestamptz;
  v_trigger     numeric;
  v_blackout    boolean;
  v_pick_job    text;
  v_pick_pri    smallint;
  v_pick_ttd    interval;
  v_pick_call   text;
  v_pick_rule   text;
  v_pick_budget int;
  v_better      boolean;
  v_blk_job     text;
  v_blk_pri     smallint;
  v_blk_ttd     interval;
  v_blk_why     text;
  v_next_job    text;
  v_next_ttd    interval;
  v_rows        int := 0;
  -- step 7
  v_fire        timestamptz;
  v_fire_utc    timestamp;
  v_sched       text;
BEGIN
  IF v_source NOT IN ('pg_cron', 'vercel', 'manual') THEN
    RAISE EXCEPTION 'dispatch_one_unit: p_source must be pg_cron, vercel or manual, got %', p_source;
  END IF;

  -- ── 1. the lock ───────────────────────────────────────────────────────────
  IF NOT pg_try_advisory_xact_lock(c_lock_key) THEN
    v_decision := 'lock_busy';
    v_reason   := 'another tick holds the dispatcher lock';
  ELSE
    BEGIN
      <<body>>
      BEGIN
        -- ── 2. the dials ──────────────────────────────────────────────────
        SELECT * INTO v_dials FROM public.platform_dials WHERE id;
        IF NOT FOUND THEN
          v_decision := 'no_dials';
          v_reason   := 'platform_dials has no row';
          EXIT body;
        END IF;
        v_have_dials := true;
        IF v_dials.pause THEN
          v_decision := 'paused';
          v_reason   := 'platform_dials.pause = true';
          EXIT body;
        END IF;

        -- ── 2b. retention (C4) ────────────────────────────────────────────
        IF extract(hour FROM v_now AT TIME ZONE 'UTC') = 1
           AND extract(minute FROM v_now AT TIME ZONE 'UTC') BETWEEN 45 AND 59 THEN
          DELETE FROM public.dispatch_log WHERE ticked_at < v_now - c_retention;
          GET DIAGNOSTICS v_purged = ROW_COUNT;
        END IF;

        -- ── 3. reap ───────────────────────────────────────────────────────
        IF EXISTS (
          SELECT 1 FROM public.dispatch_log a
           WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
             AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                              WHERE x.armed_jobid = a.armed_jobid
                                AND x.decision IN ('reaped', 'missed'))
        ) THEN
          FOR r IN
            WITH armed AS (
              SELECT a.id, a.job, a.armed_jobid, a.armed_jobname, a.armed_for
                FROM public.dispatch_log a
               WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
                 AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                                  WHERE x.armed_jobid = a.armed_jobid
                                    AND x.decision IN ('reaped', 'missed'))
            ), runs AS (
              SELECT DISTINCT ON (d.jobid)
                     d.jobid, d.status, d.start_time, d.end_time, d.return_message
                FROM cron.job_run_details d
               WHERE d.jobid = ANY (ARRAY(SELECT armed_jobid FROM armed))
               ORDER BY d.jobid, d.runid DESC
            )
            SELECT armed.*,
                   runs.status         AS run_status,
                   runs.start_time     AS run_start,
                   runs.end_time       AS run_end,
                   runs.return_message AS run_message,
                   EXISTS (SELECT 1 FROM cron.job c WHERE c.jobid = armed.armed_jobid) AS job_exists,
                   (SELECT j.idempotent_refire FROM public.job_registry j WHERE j.job = armed.job) AS refire
              FROM armed
              LEFT JOIN runs ON runs.jobid = armed.armed_jobid
             ORDER BY armed.id
          LOOP
            IF r.run_status IN ('succeeded', 'failed') THEN
              IF r.job_exists THEN PERFORM cron.unschedule(r.armed_jobid); END IF;
              DELETE FROM public.cron_job_budget WHERE jobname = r.armed_jobname;
              INSERT INTO public.dispatch_log
                (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, unit_ms)
              VALUES
                (v_source, r.job, 'reaped',
                 r.run_status || ': ' || left(COALESCE(r.run_message, ''), 200),
                 r.armed_jobid, r.armed_jobname, r.armed_for,
                 round(EXTRACT(epoch FROM (r.run_end - r.run_start)) * 1000)::int);
            ELSIF r.run_status IS NOT NULL THEN
              NULL;  -- starting / connecting / sending / running: an occupant (step 5)
            ELSIF NOT r.job_exists THEN
              DELETE FROM public.cron_job_budget WHERE jobname = r.armed_jobname;
              INSERT INTO public.dispatch_log
                (source, job, decision, reason, armed_jobid, armed_jobname, armed_for)
              VALUES
                (v_source, r.job, 'reaped',
                 'job row gone — unscheduled by hand before any run row',
                 r.armed_jobid, r.armed_jobname, r.armed_for);
            ELSIF r.armed_for + make_interval(secs => 3 * v_dials.tick_seconds) < v_now THEN
              PERFORM cron.unschedule(r.armed_jobid);
              DELETE FROM public.cron_job_budget WHERE jobname = r.armed_jobname;
              INSERT INTO public.dispatch_log
                (source, job, decision, reason, armed_jobid, armed_jobname, armed_for)
              VALUES
                (v_source, r.job, 'missed',
                 format('no job_run_details row by %s — pg_cron dropped the firing (D1); '
                        'idempotent_refire %s; the row stays eligible',
                        r.armed_for + make_interval(secs => 3 * v_dials.tick_seconds),
                        COALESCE(r.refire::text, 'unknown')),
                 r.armed_jobid, r.armed_jobname, r.armed_for);
            END IF;
          END LOOP;
        END IF;

        -- ── 4. the box ────────────────────────────────────────────────────
        v_box := public.box_is_saturated(p_include_watchdog_wall := false);
        IF COALESCE((v_box->>'saturated')::boolean, true) THEN
          v_decision := 'skipped';
          v_reason   := 'box: ' || COALESCE(v_box->>'reason', 'unknown');
          v_box_out  := v_box->'readings';
          EXIT body;
        END IF;

        -- ── 5. the census ─────────────────────────────────────────────────
        SELECT COALESCE(array_agg(a.job ORDER BY a.id), '{}'),
               COALESCE(array_agg(a.armed_jobname ORDER BY a.id), '{}')
          INTO v_armed_jobs, v_armed_names
          FROM public.dispatch_log a
         WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
           AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                            WHERE x.armed_jobid = a.armed_jobid
                              AND x.decision IN ('reaped', 'missed'));

        WITH reg AS (
          SELECT j.job, j.pipeline, j.cap_mb, j.exclusion_group,
                 substring(j.unit_call FROM '^\s*(?:CALL|SELECT)\s+public\.([a-zA-Z0-9_]+)\s*\(') AS routine,
                 CASE WHEN j.unit_shape = 'bare'
                      THEN to_regclass(substring(j.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'))
                 END AS vac_rel,
                 EXISTS (SELECT 1 FROM cron.job c WHERE c.jobname = j.job AND c.active) AS cron_active
            FROM public.job_registry j
           WHERE j.job <> c_tick_job
        ), obs AS (
          SELECT 'armed:' || a.armed_jobname AS unit_key, a.job
            FROM unnest(v_armed_jobs, v_armed_names) AS a(job, armed_jobname)
          UNION ALL
          SELECT 'pipeline:' || l.pipeline, reg.job
            FROM (SELECT DISTINCT d.pipeline FROM public.data_sync_log d
                   WHERE d.status = 'running' AND d.started_at > v_now - c_running_win) l
            JOIN reg ON reg.pipeline = l.pipeline
          UNION ALL
          SELECT 'routine:' || reg.routine, reg.job
            FROM pg_stat_activity s
            JOIN reg ON reg.routine IS NOT NULL
                    AND reg.exclusion_group IS NOT NULL
                    AND s.query ~* ('(CALL|SELECT)\s+(public\.)?' || reg.routine || '\s*\(')
           WHERE s.state <> 'idle'
             AND s.backend_type = 'client backend'
             AND s.pid <> pg_backend_pid()
          UNION ALL
          SELECT 'vacuum:' || p.relid::text, reg.job
            FROM pg_stat_progress_vacuum p
            LEFT JOIN reg ON reg.vac_rel = p.relid
           WHERE p.datname = current_database()
        ), units AS (
          SELECT o.unit_key,
                 array_agg(DISTINCT o.job) FILTER (WHERE o.job IS NOT NULL) AS jobs
            FROM obs o
           GROUP BY o.unit_key
        ), rep AS (
          SELECT u.unit_key, u.jobs,
                 (SELECT reg.job FROM reg
                   WHERE reg.job = ANY (u.jobs)
                   ORDER BY (reg.job = ANY (v_armed_jobs)) DESC, reg.cron_active DESC,
                            reg.cap_mb DESC NULLS LAST, reg.job
                   LIMIT 1) AS rep_job
            FROM units u
        )
        SELECT
          (SELECT count(DISTINCT rep_job) FROM rep WHERE rep_job IS NOT NULL)::int,
          (SELECT COALESCE(sum(COALESCE(reg.cap_mb, c_cap_default)), 0)
             FROM (SELECT DISTINCT rep_job FROM rep WHERE rep_job IS NOT NULL) d
             JOIN reg ON reg.job = d.rep_job)::int
            + (SELECT count(*) FROM rep WHERE rep_job IS NULL)::int * c_cap_default,
          COALESCE((SELECT array_agg(DISTINCT j) FROM rep, unnest(rep.jobs) j), '{}'),
          COALESCE((SELECT array_agg(DISTINCT reg.exclusion_group)
                      FROM rep, unnest(rep.jobs) j JOIN reg ON reg.job = j
                     WHERE reg.exclusion_group IS NOT NULL), '{}')
          INTO v_live_units, v_live_caps, v_live_jobs, v_busy_groups;

        v_held := COALESCE((public.prod_session_state()->>'held')::boolean, true);

        -- ── 6. pick ───────────────────────────────────────────────────────
        -- The pipeline-less rows' own cron history, one scan, only when needed.
        IF EXISTS (SELECT 1 FROM public.job_registry j
                    WHERE j.runner = 'pg_cron' AND j.pipeline IS NULL AND j.job <> c_tick_job
                      AND j.deadline_rule ~ '^(stale_after|by) ') THEN
          SELECT COALESCE(jsonb_object_agg(x.jobname, x.last_end), '{}'::jsonb) INTO v_cron_last
            FROM (SELECT c.jobname, max(d.end_time) AS last_end
                    FROM cron.job_run_details d
                    JOIN cron.job c ON c.jobid = d.jobid
                   WHERE d.status = 'succeeded'
                     AND c.jobname IN (SELECT j.job FROM public.job_registry j
                                        WHERE j.runner = 'pg_cron' AND j.pipeline IS NULL
                                          AND j.deadline_rule ~ '^(stale_after|by) ')
                   GROUP BY c.jobname) x;
        END IF;

        FOR r IN
          SELECT j.job, j.pipeline, j.unit_shape, j.unit_call, j.priority, j.deadline_rule,
                 j.cap_mb, j.exclusion_group, j.budget_seconds, j.gates,
                 CASE WHEN j.unit_shape = 'bare'
                      THEN to_regclass(substring(j.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'))
                 END AS vac_rel
            FROM public.job_registry j
           WHERE j.runner = 'pg_cron'
             AND j.deadline_rule NOT LIKE 'at %'
             AND j.job <> c_tick_job
           ORDER BY j.priority, j.job
        LOOP
          v_rows := v_rows + 1;
          v_ttd := NULL;
          v_bad := NULL;
          v_last := NULL;

          IF r.deadline_rule ~ '^(stale_after|by) ' THEN
            IF r.pipeline IS NOT NULL THEN
              SELECT max(l.completed_at) INTO v_last
                FROM public.data_sync_log l
               WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial');
            ELSE
              v_last := GREATEST(
                (v_cron_last->>r.job)::timestamptz,
                (SELECT max(x.ticked_at) FROM public.dispatch_log x
                  WHERE x.armed_jobid IS NOT NULL AND x.job = r.job
                    AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'));
            END IF;
          END IF;

          BEGIN
            IF r.deadline_rule LIKE 'stale_after %' THEN
              v_iv  := substring(r.deadline_rule FROM '^stale_after\s+(.+)$')::interval;
              v_ttd := CASE WHEN v_last IS NULL THEN interval '-1 second'
                            ELSE (v_last + v_iv) - v_now END;

            ELSIF r.deadline_rule LIKE 'by %' THEN
              v_slot_next := public.cron_next_daily(substring(r.deadline_rule FROM '^by\s+(.+)$'), v_now);
              IF v_slot_next IS NULL THEN
                v_bad := 'by: not a daily-form schedule (cron_next_daily reads M H * * * only)';
              ELSE
                v_slot_prev := CASE WHEN v_slot_next = v_now THEN v_slot_next
                                    ELSE v_slot_next - interval '1 day' END;
                v_ttd := CASE WHEN v_last IS NULL OR v_last < v_slot_prev
                              THEN v_slot_prev - v_now
                              ELSE v_slot_next - v_now END;
              END IF;

            ELSIF r.deadline_rule LIKE 'dead_tuples > %' THEN
              v_m := regexp_match(r.deadline_rule,
                       '^dead_tuples > ([0-9]+(?:\.[0-9]+)?)% of trigger(?:\s*\+\s*floor\s+(.+))?$');
              IF v_m IS NULL THEN
                v_bad := 'dead_tuples: expected ''dead_tuples > <pct>% of trigger [+ floor <interval>]''';
              ELSIF r.vac_rel IS NULL THEN
                v_bad := 'dead_tuples: unit_call names no VACUUM table that exists';
              ELSE
                SELECT c.reltuples, c.reloptions, s.n_dead_tup,
                       GREATEST(s.last_vacuum, s.last_autovacuum)
                  INTO v_reltuples, v_relopts, v_dead, v_lastvac
                  FROM pg_class c
                  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
                 WHERE c.oid = r.vac_rel;
                v_trigger :=
                  COALESCE((SELECT split_part(o, '=', 2)::numeric FROM unnest(v_relopts) o
                             WHERE split_part(o, '=', 1) = 'autovacuum_vacuum_threshold'),
                           current_setting('autovacuum_vacuum_threshold')::numeric)
                  + COALESCE((SELECT split_part(o, '=', 2)::numeric FROM unnest(v_relopts) o
                               WHERE split_part(o, '=', 1) = 'autovacuum_vacuum_scale_factor'),
                             current_setting('autovacuum_vacuum_scale_factor')::numeric)
                    * GREATEST(v_reltuples, 0)::numeric;
                v_lastvac := GREATEST(v_lastvac,
                  (SELECT max(x.ticked_at) FROM public.dispatch_log x
                    WHERE x.armed_jobid IS NOT NULL AND x.job = r.job
                      AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'));
                v_ttd := LEAST(
                  CASE WHEN v_dead >= v_trigger * v_m[1]::numeric / 100
                       THEN interval '-1 second' END,
                  CASE WHEN v_m[2] IS NOT NULL AND v_lastvac IS NOT NULL
                       THEN (v_lastvac + v_m[2]::interval) - v_now END);
              END IF;

            ELSE
              v_bad := 'unknown deadline form';
            END IF;
          EXCEPTION WHEN OTHERS THEN
            v_bad := SQLERRM;
            v_ttd := NULL;
          END;

          IF v_bad IS NOT NULL THEN
            INSERT INTO public.dispatch_log (source, job, decision, reason)
            VALUES (v_source, r.job, 'unsupported_deadline',
                    left(format('deadline_rule %L: %s — excluded', r.deadline_rule, v_bad), 400));
            CONTINUE;
          END IF;
          CONTINUE WHEN v_ttd IS NULL;  -- no deadline applies: not due

          IF v_ttd > interval '0' THEN
            IF v_next_job IS NULL OR v_ttd < v_next_ttd THEN
              v_next_job := r.job;
              v_next_ttd := v_ttd;
            END IF;
            CONTINUE;
          END IF;

          -- DUE. Exclusions, first reason wins.
          -- D8: headroom test here (FIX-1125)
          v_why := NULL;
          IF r.job = ANY (v_live_jobs) THEN
            v_why := 'live';
          ELSIF r.exclusion_group IS NOT NULL AND r.exclusion_group = ANY (v_busy_groups) THEN
            v_why := 'group busy: ' || r.exclusion_group;
          ELSIF v_live_units >= v_dials.max_concurrent_units THEN
            v_why := format('units: %s live of %s', v_live_units, v_dials.max_concurrent_units);
          ELSIF v_live_caps + COALESCE(r.cap_mb, c_cap_default) > v_dials.max_live_caps_mb THEN
            v_why := format('caps: %s MB live + %s MB > %s MB', v_live_caps,
                            COALESCE(r.cap_mb, c_cap_default), v_dials.max_live_caps_mb);
          ELSIF 'prod_session' = ANY (r.gates) AND v_held THEN
            v_why := 'gated: prod_session';
          ELSIF 'blackout' = ANY (r.gates) THEN
            IF v_blackout IS NULL THEN v_blackout := public.in_blackout('ec_crawl', v_now); END IF;
            IF v_blackout THEN v_why := 'gated: blackout'; END IF;
          END IF;
          IF v_why IS NULL AND 'peer' = ANY (r.gates)
             AND NOT COALESCE((public.peer_wait_gate(ARRAY[r.pipeline], 0)->>'clear')::boolean, false) THEN
            v_why := 'gated: peer';
          END IF;

          IF v_why IS NULL THEN
            IF v_pick_job IS NULL THEN
              v_better := true;
            ELSE
              v_better := (r.priority, v_ttd, r.job) < (v_pick_pri, v_pick_ttd, v_pick_job);
            END IF;
            IF v_better THEN
              v_pick_job    := r.job;
              v_pick_pri    := r.priority;
              v_pick_ttd    := v_ttd;
              v_pick_call   := r.unit_call;
              v_pick_rule   := r.deadline_rule;
              v_pick_budget := r.budget_seconds;
            END IF;
          ELSE
            IF v_blk_job IS NULL THEN
              v_better := true;
            ELSE
              v_better := (r.priority, v_ttd, r.job) < (v_blk_pri, v_blk_ttd, v_blk_job);
            END IF;
            IF v_better THEN
              v_blk_job := r.job;
              v_blk_pri := r.priority;
              v_blk_ttd := v_ttd;
              v_blk_why := v_why;
            END IF;
          END IF;
        END LOOP;

        IF v_pick_job IS NULL THEN
          v_decision := 'nothing_due';
          v_job      := v_blk_job;
          v_reason   := concat_ws('; ',
            CASE WHEN v_blk_job IS NOT NULL THEN v_blk_why || ' (' || v_blk_job || ')' END,
            CASE WHEN v_next_job IS NOT NULL
                 THEN 'next: ' || v_next_job || ' in ' || date_trunc('second', v_next_ttd)::text END,
            CASE WHEN v_rows = 0 THEN 'no eligible rows' END);
          IF v_reason = '' THEN
            v_reason := format('%s eligible row(s), none with a deadline that applies', v_rows);
          END IF;
          EXIT body;
        END IF;

        -- ── 7. ARM ────────────────────────────────────────────────────────
        -- The next ODD minute >= now + 60 s that is not :15 / :45, in UTC
        -- (cron.timezone = GMT, read on prod 2026-10-13).
        v_fire := date_trunc('minute', v_now + interval '60 seconds');
        IF v_fire < v_now + interval '60 seconds' THEN
          v_fire := v_fire + interval '1 minute';
        END IF;
        FOR i IN 1..4 LOOP
          EXIT WHEN extract(minute FROM v_fire AT TIME ZONE 'UTC')::int % 2 = 1
                AND extract(minute FROM v_fire AT TIME ZONE 'UTC')::int NOT IN (15, 45);
          v_fire := v_fire + interval '1 minute';
        END LOOP;
        v_fire_utc   := v_fire AT TIME ZONE 'UTC';
        v_armed_name := 'disp-' || v_pick_job || '-' || floor(EXTRACT(epoch FROM v_now))::bigint;
        v_sched      := format('%s %s %s %s *',
                               extract(minute FROM v_fire_utc)::int, extract(hour  FROM v_fire_utc)::int,
                               extract(day    FROM v_fire_utc)::int, extract(month FROM v_fire_utc)::int);

        IF v_pick_budget IS NOT NULL THEN
          INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
          VALUES (v_armed_name, v_pick_budget,
                  'disp one-shot for ' || v_pick_job || ' armed ' || v_now::text)
          ON CONFLICT (jobname) DO NOTHING;
        END IF;
        v_armed_id := cron.schedule(v_armed_name, v_sched, v_pick_call);

        v_decision  := 'armed';
        v_job       := v_pick_job;
        v_armed_for := v_fire;
        v_box_out   := v_box->'readings';
        v_reason    := v_pick_rule || ' → ' || date_trunc('second', v_pick_ttd)::text;
      END body;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[dispatcher] tick failed: % %', SQLSTATE, SQLERRM;
      v_decision   := 'error';
      v_job        := NULL;
      v_reason     := left(SQLSTATE || ': ' || SQLERRM, 400);
      v_armed_id   := NULL;
      v_armed_name := NULL;
      v_armed_for  := NULL;
      v_box_out    := NULL;
      v_purged     := 0;
      v_live_units := NULL;
      v_live_caps  := NULL;
    END;
  END IF;

  IF v_purged > 0 THEN
    v_reason := concat_ws(' ', v_reason, format('(retention: %s rows older than 14 days deleted)', v_purged));
  END IF;

  INSERT INTO public.dispatch_log
    (source, job, decision, reason, live_caps_mb, live_units, box,
     armed_jobid, armed_jobname, armed_for)
  VALUES
    (v_source, v_job, v_decision, v_reason, v_live_caps, v_live_units, v_box_out,
     v_armed_id, v_armed_name, v_armed_for)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id',            v_row.id,
    'ticked_at',     v_row.ticked_at,
    'source',        v_row.source,
    'decision',      v_row.decision,
    'job',           v_row.job,
    'reason',        v_row.reason,
    'live_units',    v_row.live_units,
    'live_caps_mb',  v_row.live_caps_mb,
    'armed_jobid',   v_row.armed_jobid,
    'armed_jobname', v_row.armed_jobname,
    'armed_for',     v_row.armed_for);
END;
$function$;

ALTER FUNCTION public.dispatch_one_unit(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dispatch_one_unit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_one_unit(text) TO service_role;

COMMENT ON FUNCTION public.dispatch_one_unit(text) IS
  'FIX-1308 — one dispatcher tick: reap finished one-shots, read the box, take the occupant '
  'census, pick the best DUE job_registry row by (priority, time-to-deadline) under the Σ-caps '
  'box rule and its gates, and ARM it as a one-shot pg_cron job (C1 — never EXECUTEd inline). '
  'Writes one dispatch_log row per decision and returns it. SECURITY DEFINER (owner postgres) '
  'because cron.schedule/unschedule need schema cron. p_source: pg_cron (the odd-minute tick), '
  'vercel (the box-health route''s re-fire), manual.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (c) dispatch_tick() — what pg_cron CALLs. No proconfig (rule 237).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.dispatch_tick()
 LANGUAGE plpgsql
AS $procedure$
BEGIN
  PERFORM public.dispatch_one_unit('pg_cron');
END;
$procedure$;

-- (d) grants (D1)
ALTER PROCEDURE public.dispatch_tick() OWNER TO postgres;
REVOKE ALL ON PROCEDURE public.dispatch_tick() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON PROCEDURE public.dispatch_tick() IS
  'FIX-1308 — the dispatcher-tick pg_cron job''s target: PERFORM dispatch_one_unit(''pg_cron''). '
  'A PROCEDURE with no SET clause, so pg_cron''s top-level CALL stays non-atomic.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (e) the tick_seconds trigger (D8) — re-schedule by NAME, never by hand
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.platform_dials_tick_reschedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'cron'
AS $function$
DECLARE
  v_jobid bigint;
  v_n     int;
  v_sched text;
BEGIN
  v_n     := GREATEST(1, ceil(NEW.tick_seconds / 60.0))::int;
  v_sched := '1-59/' || v_n || ' * * * *';
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'dispatcher-tick';
  IF v_jobid IS NULL THEN
    RAISE WARNING '[dispatcher] tick_seconds % → %: no dispatcher-tick job to re-schedule',
      OLD.tick_seconds, NEW.tick_seconds;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, schedule := v_sched);
    RAISE NOTICE '[dispatcher] tick_seconds % → %: dispatcher-tick (jobid %) now %',
      OLD.tick_seconds, NEW.tick_seconds, v_jobid, v_sched;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.platform_dials_tick_reschedule() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_dials_tick_reschedule() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER platform_dials_tick_reschedule
  AFTER UPDATE OF tick_seconds ON public.platform_dials
  FOR EACH ROW
  WHEN (OLD.tick_seconds IS DISTINCT FROM NEW.tick_seconds)
  EXECUTE FUNCTION public.platform_dials_tick_reschedule();

COMMENT ON FUNCTION public.platform_dials_tick_reschedule() IS
  'FIX-1308 / D8 — platform_dials.tick_seconds moves the dispatcher-tick schedule to '
  '''1-59/N * * * *'', N = GREATEST(1, ceil(tick_seconds / 60.0)), by NAME. A missing job '
  'is a WARNING, never an error. SECURITY DEFINER (owner postgres): cron.alter_job.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (f) the tick job — by NAME (the fix1239 shape), plus its budget row
-- ═══════════════════════════════════════════════════════════════════════════
-- The schedule is derived from the dial, so a re-apply never undoes a
-- tick_seconds move: '1-59/2' at the default 120.

DO $$
DECLARE
  c_jobname CONSTANT text := 'dispatcher-tick';
  c_cmd     CONSTANT text := 'CALL public.dispatch_tick();';
  v_sched   text;
  v_jobid   bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1308] pg_cron absent — dispatcher-tick not scheduled';
    RETURN;
  END IF;

  SELECT '1-59/' || GREATEST(1, ceil(COALESCE(max(tick_seconds), 120) / 60.0))::int || ' * * * *'
    INTO v_sched
    FROM public.platform_dials;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = c_jobname;
  IF v_jobid IS NULL THEN
    SELECT cron.schedule(c_jobname, v_sched, c_cmd) INTO v_jobid;
    RAISE NOTICE '[fix1308] scheduled % (jobid %) at %', c_jobname, v_jobid, v_sched;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, schedule := v_sched, command := c_cmd);
    RAISE NOTICE '[fix1308] retuned % (jobid %) to %', c_jobname, v_jobid, v_sched;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = c_jobname AND schedule ~ '^1-59/[0-9]+ \* \* \* \*$') THEN
    RAISE EXCEPTION '[fix1308] % is not on a 1-59/N schedule', c_jobname;
  END IF;
END $$;

INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES ('dispatcher-tick', 120,
        'FIX-1308 — the dispatcher tick; one odd minute; the function is tens of ms')
ON CONFLICT (jobname) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- (g) the registry row — FIX-1307's fence shape (membership is the UNION)
-- ═══════════════════════════════════════════════════════════════════════════
-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES
  ('dispatcher-tick', 'pg_cron', NULL, 'atomic', 'CALL public.dispatch_tick();', 1, 'at 1-59/2 * * * *', 'cpu', 128, NULL, 120, '{}', false, 'FIX-1308 — the dispatcher''s own tick; never dispatched; no-band (its cost is read from pgss in s6)')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end


-- ═══════════════════════════════════════════════════════════════════════════
-- (h) get_dispatcher_status() — the tile's and the receipts' one read
-- ═══════════════════════════════════════════════════════════════════════════
-- ticks_60m counts pg_cron-source FINAL rows (not reaped / missed /
-- unsupported_deadline), so it is the cadence the proving measures.
-- expected_ticks_60m is what '1-59/N' fires in an hour: floor(58 / N) + 1
-- (30 at N = 2; 3600 / tick_seconds agrees there).

CREATE OR REPLACE FUNCTION public.get_dispatcher_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'cron'
AS $function$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_dials public.platform_dials%ROWTYPE;
  v_n     int;
  v_last  record;
  v_ticks int;
  v_dec   jsonb;
  v_live  jsonb := '[]'::jsonb;
  v_reg   jsonb;
  v_job   jsonb;
BEGIN
  SELECT * INTO v_dials FROM public.platform_dials WHERE id;
  v_n := GREATEST(1, ceil(COALESCE(v_dials.tick_seconds, 120) / 60.0))::int;

  SELECT l.ticked_at, l.source, l.decision, l.job, l.reason INTO v_last
    FROM public.dispatch_log l
   WHERE l.decision NOT IN ('reaped', 'missed', 'unsupported_deadline')
   ORDER BY l.ticked_at DESC
   LIMIT 1;

  SELECT count(*) INTO v_ticks
    FROM public.dispatch_log l
   WHERE l.ticked_at > v_now - interval '60 minutes'
     AND l.source = 'pg_cron'
     AND l.decision NOT IN ('reaped', 'missed', 'unsupported_deadline');

  SELECT COALESCE(jsonb_object_agg(d.decision, d.n), '{}'::jsonb) INTO v_dec
    FROM (SELECT l.decision, count(*) AS n FROM public.dispatch_log l
           WHERE l.ticked_at > v_now - interval '24 hours'
           GROUP BY l.decision) d;

  IF EXISTS (SELECT 1 FROM public.dispatch_log a
              WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
                AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                                 WHERE x.armed_jobid = a.armed_jobid
                                   AND x.decision IN ('reaped', 'missed'))) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'job', a.job, 'armed_jobname', a.armed_jobname, 'armed_for', a.armed_for,
             'run_status', COALESCE(rd.status, 'not started')) ORDER BY a.id), '[]'::jsonb)
      INTO v_live
      FROM public.dispatch_log a
      LEFT JOIN LATERAL (SELECT d.status FROM cron.job_run_details d
                          WHERE d.jobid = a.armed_jobid
                          ORDER BY d.runid DESC LIMIT 1) rd ON true
     WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
       AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                        WHERE x.armed_jobid = a.armed_jobid
                          AND x.decision IN ('reaped', 'missed'));
  END IF;

  SELECT jsonb_build_object(
           'rows',      count(*),
           'eligible',  count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'),
           'by_runner', (SELECT COALESCE(jsonb_object_agg(x.runner, x.n), '{}'::jsonb)
                           FROM (SELECT runner, count(*) AS n FROM public.job_registry GROUP BY runner) x))
    INTO v_reg
    FROM public.job_registry j;

  SELECT jsonb_build_object('jobid', c.jobid, 'active', c.active, 'schedule', c.schedule,
                            'budget_seconds', b.budget_seconds)
    INTO v_job
    FROM cron.job c
    LEFT JOIN public.cron_job_budget b ON b.jobname = c.jobname
   WHERE c.jobname = 'dispatcher-tick';

  RETURN jsonb_build_object(
    'last_tick_at',       v_last.ticked_at,
    'last_tick_source',   v_last.source,
    'last_decision',      v_last.decision,
    'last_job',           v_last.job,
    'last_reason',        v_last.reason,
    'ticks_60m',          v_ticks,
    'expected_ticks_60m', floor(58.0 / v_n)::int + 1,
    'decisions_24h',      v_dec,
    'live',               v_live,
    'dials', CASE WHEN v_dials.id IS NULL THEN NULL ELSE jsonb_build_object(
               'pause',                v_dials.pause,
               'tick_seconds',         v_dials.tick_seconds,
               'unit_target_seconds',  v_dials.unit_target_seconds,
               'max_concurrent_units', v_dials.max_concurrent_units,
               'max_live_caps_mb',     v_dials.max_live_caps_mb,
               'headroom_target_mb',   v_dials.headroom_target_mb,
               'updated_at',           v_dials.updated_at) END,
    'registry',           v_reg,
    'tick_job',           v_job,
    'generated_at',       v_now);
END;
$function$;

ALTER FUNCTION public.get_dispatcher_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dispatcher_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispatcher_status() TO service_role;

COMMENT ON FUNCTION public.get_dispatcher_status() IS
  'FIX-1308 — the dispatcher at a glance: last tick (any source), pg_cron ticks in the last 60 '
  'min vs what the schedule fires, decisions in the last 24 h, the live one-shots with their '
  'run status, the six dials, registry counts, and the tick job''s active/schedule/budget. One '
  'read for the /dashboard tile (via the status snapshot) and the receipts'' §9 line. SECURITY '
  'DEFINER (owner postgres) because it reads cron.job.';
