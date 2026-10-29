-- =============================================================================
-- FIX-1361 + FIX-1362 (cc-253) ROLLBACK — dispatch_one_unit back to 64c8271e…
-- (FIX-1354's body), then job_registry.anchor_cadence dropped.
--
-- The mirror of
-- supabase/migrations/20261029000000_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim.
-- The body below is prod's pg_get_functiondef output read on 2026-10-28
-- 23:58Z before the push, VERBATIM (md5(prosrc)
-- 64c8271e7601095d275c68eff5187931). It was generated from prod, not
-- hand-written.
--
-- WORKING ORDER:
--   1. UPDATE public.platform_dials SET pause = true;   -- by hand; not in this file
--   2. wait until no tick is running (a paused tick exits at step 2, before
--      the reap, so nothing is reaped while paused);
--   3. node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--        --file scripts/fix1361-revert-dispatcher-anchor-rung.sql
--   4. UPDATE public.platform_dials SET pause = false;
--   5. read the md5: this file's last block asserts the old pin and RAISEs
--      otherwise.
--
-- Order inside: the body first (so nothing reads anchor_cadence), then the
-- column. A lighter net comes before this file: `UPDATE job_registry SET
-- anchor_cadence = NULL WHERE job = '<row>'` restores the old anchor for one
-- row.
--
-- With FIX-1363's RETURN still in place, the old body anchors
-- refresh-derived-mvs-weekly on the PIPELINE's newest row again (the
-- sibling's slot satisfies it). Revert the RETURN first
-- (scripts/fix1363-revert-return-refresh-derived-mvs-weekly.sql) if the weekly
-- must not dispatch on that arithmetic.
--
-- Idempotent: the body is replaced in place, DROP COLUMN IF EXISTS.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.dispatch_one_unit(p_source text DEFAULT 'pg_cron'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'cron'
AS $function$
DECLARE
  c_lock_key    CONSTANT bigint   := hashtext('dispatcher_tick')::bigint;
  c_retention   CONSTANT interval := interval '14 days';
  c_running_win CONSTANT interval := interval '6 hours';
  c_cap_default CONSTANT int      := 64;
  c_tick_job    CONSTANT text     := 'dispatcher-tick';
  c_gha_fire_lapse CONSTANT interval := interval '20 minutes';  -- N2 (FIX-1336): no route answer by arm + this → missed
  c_gha_quiet   CONSTANT interval := interval '10 minutes';      -- N2: a non-tail terminal row this old, nothing running → failed
  c_gha_tail    CONSTANT text     := 'enrichment-tail';          -- N2: the nightly's last phase (nightly.yml --phase=)
  c_sweep_note  CONSTANT text     := 'FIX-1177/1172 — set by claimProdSession(); cleared by release(); a row with this note and no hold is inert';
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
  v_gha_jobs   text[] := '{}';  -- N2 (FIX-1336): GHA requests not yet reaped (occupants)
  v_gha_names  text[] := '{}';
  v_g_status   text;
  v_g_http     text;
  v_g_running  boolean;
  v_g_first    timestamptz;
  v_g_phase    text;
  v_g_st       text;
  v_g_end      timestamptz;
  v_g_dec      text;
  v_g_why      text;
  v_g_ms       int;
  v_swept      int;           -- D-h (FIX-1337): leftover session holds cleared by the reap
  -- step 4
  v_box        jsonb;
  v_mem_avail  int;           -- FIX-1354 (D2): step 4's MemAvailable (MB); NULL = stale / absent mirror
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
  v_adv         timestamptz;  -- I6 (FIX-1316): the row's last advancing completion
  v_cd_n        int;
  v_cd_at       timestamptz;
  v_cd_reason   text;
  v_cd_until    timestamptz;
  v_cd_bo       timestamptz;  -- D-f (FIX-1332): the unit's own backoff_until
  v_adv_start   timestamptz;  -- D-b (FIX-1323): the last advancing unit's START
  v_locked      boolean;      -- D-b: it started on time after phase_due_at
  v_term        text;         -- D-b: stale_after | floor | pct | null_anchor | by
  v_pct_ttd     interval;     -- D-b / D-c: the dead_tuples terms, apart
  v_floor_ttd   interval;
  v_pick_term   text;
  v_pick_lock   boolean;
  v_vacuum_live text;         -- D-a (FIX-1322): the VACUUM occupant, once per tick
  v_excluded    text[] := '{}';  -- D-e (FIX-1333): every due row not armed
  v_next_due    text;         -- FIX-1330: the newest advancing unit's own metadata.next_due_at
  v_ttds        jsonb := '{}'::jsonb;  -- FIX-1331: every looped row's ttd, read by the yield
  v_yield       text;
  -- step 7
  v_req_key     text;         -- N2 (FIX-1336): the request stamp a GHA arm writes
  v_fire        timestamptz;
  v_fire_utc    timestamp;
  v_sched       text;
  v_floor       bigint;       -- I2 (FIX-1316): max(runid) at ARM
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
              SELECT a.id, a.job, a.armed_jobid, a.armed_jobname, a.armed_for, a.runid_floor
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
                 AND d.runid > (SELECT min(COALESCE(a.runid_floor, 0)) FROM armed a)
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

        -- ── 3b. reap a GHA arm (N2, FIX-1336) ─────────────────────────────
        -- A github_actions row arms a REQUEST STAMP (pipeline_state
        -- gha_dispatch_request_<stem>), not a one-shot: the */5 nightly-request
        -- route fires workflow_dispatch on it and consumes it. Live = a stamp
        -- with no reaped_at. The run is read from the row's pipeline rows
        -- started at or after the request (the nightly's four phases).
        FOR r IN
          SELECT j.job, j.pipeline, j.budget_seconds, j.idempotent_refire,
                 ps.key AS req_key, ps.value AS req,
                 (ps.value->>'requested_at')::timestamptz AS req_at,
                 'gha_dispatch_' || substring(j.unit_call FROM '^gha-dispatch:([a-z0-9-]+)$') AS stamp_key
            FROM public.job_registry j
            JOIN public.pipeline_state ps
              ON ps.key = 'gha_dispatch_request_' || substring(j.unit_call FROM '^gha-dispatch:([a-z0-9-]+)$')
           WHERE j.runner = 'github_actions' AND j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$'
             AND ps.value->>'reaped_at' IS NULL
           ORDER BY j.job
        LOOP
          -- the route's answer: the request's own outcome (consumed), else the
          -- gha_dispatch_<stem> stamp when it was written at or after the request
          SELECT COALESCE(r.req->>'outcome',
                          CASE WHEN (s.value->>'at')::timestamptz >= r.req_at THEN s.value->>'status' END),
                 COALESCE(r.req->>'http_status',
                          CASE WHEN (s.value->>'at')::timestamptz >= r.req_at THEN s.value->>'http_status' END)
            INTO v_g_status, v_g_http
            FROM (SELECT 1) one
            LEFT JOIN public.pipeline_state s ON s.key = r.stamp_key;
          SELECT bool_or(l.status = 'running'), min(l.started_at)
            INTO v_g_running, v_g_first
            FROM public.data_sync_log l
           WHERE l.pipeline = r.pipeline AND l.started_at >= r.req_at;
          SELECT l.metadata->>'phase', l.status, l.completed_at
            INTO v_g_phase, v_g_st, v_g_end
            FROM public.data_sync_log l
           WHERE l.pipeline = r.pipeline AND l.started_at >= r.req_at AND l.status <> 'running'
           ORDER BY l.completed_at DESC NULLS LAST, l.started_at DESC
           LIMIT 1;
          v_g_dec := NULL;
          v_g_why := NULL;
          v_g_ms  := NULL;
          IF v_g_status IN ('refused', 'error') THEN
            v_g_dec := 'reaped';
            v_g_why := format('failed: dispatch %s %s', v_g_status, COALESCE(v_g_http, 'no-http'));
          ELSIF COALESCE(v_g_running, false) THEN
            NULL;  -- a phase is running: an occupant (step 5)
          ELSIF v_g_phase = c_gha_tail THEN
            v_g_dec := 'reaped';
            v_g_why := CASE WHEN v_g_st = 'failed' THEN 'failed: GHA ' || c_gha_tail || ' failed'
                            ELSE 'succeeded: GHA' END;
            v_g_ms  := round(EXTRACT(epoch FROM (v_g_end - v_g_first)) * 1000)::int;
          ELSIF v_g_end IS NOT NULL AND v_g_end < v_now - c_gha_quiet THEN
            v_g_dec := 'reaped';
            v_g_why := format('failed: GHA %s %s', COALESCE(v_g_phase, '(no phase)'), v_g_st);
          ELSIF v_g_first IS NULL AND v_g_status IS NULL AND v_now > r.req_at + c_gha_fire_lapse THEN
            v_g_dec := 'missed';
            v_g_why := format('no dispatch by %s — the request route did not fire (N2); idempotent_refire %s; '
                              'the row stays due inside its window',
                              date_trunc('second', r.req_at + c_gha_fire_lapse), r.idempotent_refire);
          ELSIF v_g_first IS NULL AND v_now > r.req_at + make_interval(secs => COALESCE(r.budget_seconds, 18000)) THEN
            v_g_dec := 'reaped';
            v_g_why := format('failed: GHA no %s row within %s s of the request', r.pipeline,
                              COALESCE(r.budget_seconds, 18000));
          END IF;
          IF v_g_dec IS NULL THEN
            v_gha_jobs  := v_gha_jobs  || r.job;
            v_gha_names := v_gha_names || r.req_key;
            CONTINUE;
          END IF;
          -- D-h (FIX-1337): the kill-path sweep. A SIGTERM'd claimant leaves
          -- its session hold rows; with no session HELD (the lock, not the
          -- label) they are leftovers. The clearGuardedHolds SQL verbatim
          -- (prod-session.ts) — never a human hold, never a cadence row.
          v_swept := NULL;
          IF (EXISTS (SELECT 1 FROM public.rollup_watch_overrides o
                       WHERE o.hold_reason LIKE 'prod session held: %' OR o.note = c_sweep_note)
              OR EXISTS (SELECT 1 FROM public.pipeline_state WHERE key = 'prod_session'))
             AND NOT COALESCE((public.prod_session_state()->>'held')::boolean, true) THEN
            UPDATE public.rollup_watch_overrides
               SET held_since = NULL, hold_reason = NULL, updated_at = now()
             WHERE hold_reason LIKE 'prod session held: %';
            GET DIAGNOSTICS v_swept = ROW_COUNT;
            DELETE FROM public.rollup_watch_overrides
             WHERE note = c_sweep_note AND held_since IS NULL AND retired_at IS NULL AND cadence_hours IS NULL;
            DELETE FROM public.pipeline_state WHERE key = 'prod_session';
          END IF;
          INSERT INTO public.dispatch_log
            (source, job, decision, reason, armed_jobname, armed_for, unit_ms)
          VALUES
            (v_source, r.job, v_g_dec,
             left(v_g_why || CASE WHEN v_swept IS NOT NULL THEN format('; swept %s hold(s)', v_swept) ELSE '' END, 400),
             r.req_key, r.req_at, v_g_ms);
          UPDATE public.pipeline_state
             SET value = value || jsonb_build_object('reaped_at', v_now, 'reap', v_g_dec || ': ' || left(v_g_why, 200)),
                 updated_at = now()
           WHERE key = r.req_key;
        END LOOP;

        -- ── 4. the box ────────────────────────────────────────────────────
        v_box := public.box_is_saturated(p_include_watchdog_wall := false);
        IF COALESCE((v_box->>'saturated')::boolean, true) THEN
          v_decision := 'skipped';
          v_reason   := 'box: ' || COALESCE(v_box->>'reason', 'unknown');
          v_box_out  := v_box->'readings';
          EXIT body;
        END IF;
        -- FIX-1354 (D2): the mirror, read ONCE per tick: step 4's own readings,
        -- never pipeline_state per row. A stale or absent mirror leaves it NULL
        -- and step 6's headroom test is skipped (fail-open; mem_stale counts it).
        IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
          v_mem_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
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
        v_armed_jobs  := v_armed_jobs  || v_gha_jobs;   -- N2 (FIX-1336): a GHA request not yet reaped
        v_armed_names := v_armed_names || v_gha_names;  -- is an occupant, as an armed one-shot is

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

        -- D-a (FIX-1322): the VACUUM occupant, once per tick — a VACUUM running
        -- in this database (autovacuum included), else an armed VACUUM
        -- one-shot not yet reaped. NULL when neither. Read by `io:` below.
        SELECT 'vacuum:' || COALESCE(c.relname::text, p.relid::text, 'pid ' || p.pid)
          INTO v_vacuum_live
          FROM pg_stat_progress_vacuum p
          LEFT JOIN pg_class c ON c.oid = p.relid
         WHERE p.datname = current_database()
         ORDER BY p.pid
         LIMIT 1;
        IF v_vacuum_live IS NULL THEN
          SELECT j.job INTO v_vacuum_live
            FROM public.job_registry j
           WHERE j.job = ANY (v_armed_jobs) AND j.unit_call ~* '^\s*VACUUM'
           ORDER BY j.job
           LIMIT 1;
        END IF;

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
                 j.phase_lock, j.phase_due_at,
                 j.runner, j.by_window_minutes, j.yield_to, j.yield_lead_seconds,
                 CASE WHEN j.unit_shape = 'bare'
                      THEN to_regclass(substring(j.unit_call FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)'))
                 END AS vac_rel
            FROM public.job_registry j
           WHERE (j.runner = 'pg_cron'
                  OR (j.runner = 'github_actions' AND j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$'))  -- N2 (FIX-1336)
             AND j.deadline_rule NOT LIKE 'at %'
             AND j.job <> c_tick_job
           -- FIX-1331: a row that yields is visited after every peer, so the
           -- peers' ttds are in v_ttds when its yield is read. The pick ranks
           -- by (priority, ttd, job) explicitly; the order moves nothing else.
           ORDER BY cardinality(j.yield_to) > 0, j.priority, j.job
        LOOP
          v_rows := v_rows + 1;
          v_ttd := NULL;
          v_bad := NULL;
          v_last := NULL;
          v_term := NULL;
          v_adv_start := NULL;
          v_locked := false;
          v_next_due := NULL;

          IF r.deadline_rule ~ '^(stale_after|by) ' THEN
            IF r.pipeline IS NOT NULL THEN
              -- FIX-1330: the newest advancing row, and the next-due it reported
              -- (one read: max(completed_at) and its metadata.next_due_at).
              SELECT l.completed_at, l.metadata->>'next_due_at' INTO v_last, v_next_due
                FROM public.data_sync_log l
               WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial')
                 AND l.completed_at IS NOT NULL
               ORDER BY l.completed_at DESC
               LIMIT 1;
            ELSE
              v_last := GREATEST(
                (v_cron_last->>r.job)::timestamptz,
                (SELECT max(x.ticked_at) FROM public.dispatch_log x
                  WHERE x.armed_jobid IS NOT NULL AND x.job = r.job
                    AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'));
            END IF;
          END IF;

          -- D-b (FIX-1323): the phase lock, a per-row opt-in. Only a
          -- phase_lock row with a recorded due reads its last advancing
          -- unit's START: a pipeline's newest complete|partial row (the row
          -- v_last came from), a bare row's newest `reaped succeeded`
          -- one-shot's armed_for. On time = it started inside the arm window
          -- after that due (due → the next odd tick <= 2 min → +2 min to the
          -- one-shot, +2 more on a :15/:45 skip <= 6 min; 4 ticks covers it).
          IF r.phase_lock AND r.phase_due_at IS NOT NULL THEN
            IF r.pipeline IS NOT NULL THEN
              SELECT max(l.started_at) INTO v_adv_start
                FROM public.data_sync_log l
               WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial')
                 AND l.completed_at = v_last;
            ELSE
              SELECT x.armed_for INTO v_adv_start
                FROM public.dispatch_log x
               WHERE x.armed_jobid IS NOT NULL AND x.job = r.job
                 AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'
               ORDER BY x.ticked_at DESC
               LIMIT 1;
            END IF;
            v_locked := COALESCE(v_adv_start >= r.phase_due_at
                                 AND v_adv_start < r.phase_due_at + make_interval(secs => 4 * v_dials.tick_seconds),
                                 false);
          END IF;

          BEGIN
            IF r.deadline_rule LIKE 'stale_after %' THEN
              v_iv  := substring(r.deadline_rule FROM '^stale_after\s+(.+)$')::interval;
              -- FIX-1330 (D-f): a unit that reported its own next-due holds the
              -- row until then — GREATEST(last + interval, next_due_at).
              v_ttd := CASE WHEN v_last IS NULL THEN interval '-1 second'
                            WHEN v_locked THEN GREATEST(r.phase_due_at + v_iv,
                              CASE WHEN v_next_due ~ '^\d{4}-\d\d-\d\d[ T]' THEN v_next_due::timestamptz END) - v_now
                            ELSE GREATEST(v_last + v_iv,
                              CASE WHEN v_next_due ~ '^\d{4}-\d\d-\d\d[ T]' THEN v_next_due::timestamptz END) - v_now END;
              v_term := CASE WHEN v_last IS NULL THEN 'null_anchor' ELSE 'stale_after' END;

            ELSIF r.deadline_rule LIKE 'by %' THEN
              -- D-d (FIX-1329): daily, weekly and monthly slots.
              v_slot_prev := public.cron_prev_slot(substring(r.deadline_rule FROM '^by\s+(.+)$'), v_now);
              v_slot_next := public.cron_next_slot(substring(r.deadline_rule FROM '^by\s+(.+)$'), v_now);
              IF v_slot_prev IS NULL OR v_slot_next IS NULL THEN
                v_bad := 'by: unsupported schedule (daily M H * * *, weekly M H * * D, monthly M H D * * only)';
              ELSE
                -- D-b (N2): with by_window_minutes, a slot not met is due only
                -- inside [slot, slot + window); past it the row waits for the
                -- next slot, and the lapse writes no row of its own.
                v_ttd := CASE WHEN v_last IS NULL OR v_last < v_slot_prev
                              THEN CASE WHEN r.by_window_minutes IS NOT NULL
                                         AND v_now >= v_slot_prev + make_interval(mins => r.by_window_minutes)
                                        THEN v_slot_next - v_now
                                        ELSE v_slot_prev - v_now END
                              ELSE v_slot_next - v_now END;
                v_term := 'by';
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
                v_pct_ttd := CASE WHEN v_dead >= v_trigger * v_m[1]::numeric / 100
                                  THEN interval '-1 second' END;
                -- D-c (FIX-1326): a floor with no anchor (no last_vacuum, no
                -- last_autovacuum, no reaped succeeded row) is DUE, as a
                -- stale_after with no v_last is. D-b: a phase-locked floor
                -- anchors to the previous due.
                v_floor_ttd := CASE WHEN v_m[2] IS NULL THEN NULL
                                    WHEN v_lastvac IS NULL THEN interval '-1 second'
                                    WHEN v_locked THEN (r.phase_due_at + v_m[2]::interval) - v_now
                                    ELSE (v_lastvac + v_m[2]::interval) - v_now END;
                v_ttd := LEAST(v_pct_ttd, v_floor_ttd);
                v_term := CASE WHEN v_floor_ttd IS NOT NULL AND v_floor_ttd <= COALESCE(v_pct_ttd, v_floor_ttd)
                               THEN CASE WHEN v_lastvac IS NULL THEN 'null_anchor' ELSE 'floor' END
                               WHEN v_pct_ttd IS NOT NULL THEN 'pct' END;
              END IF;

            ELSE
              v_bad := 'unknown deadline form';
            END IF;
          EXCEPTION WHEN OTHERS THEN
            v_bad := SQLERRM;
            v_ttd := NULL;
          END;
          v_ttds := v_ttds || jsonb_build_object(r.job, v_ttd);  -- FIX-1331: the peers' ttds, once per tick

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
          -- D8 (FIX-1354): the headroom test is the ladder's second rung, below.
          v_why := NULL;
          -- I6 (FIX-1316): the re-arm cooldown, before 'live'. n = this job's
          -- `reaped` rows armed after its last ADVANCING completion: a
          -- pipeline's complete|partial row (v_last's source), or for a bare
          -- row the newest `reaped succeeded`, so only its non-succeeded reaps
          -- count. `missed` never counts. In cooldown until the newest such
          -- reap + LEAST(dial x 2^(n-1), 24 h); dial 0 = off. It self-clears on
          -- the first advancing completion.
          IF v_dials.rearm_cooldown_seconds > 0 THEN
            v_adv := CASE WHEN r.pipeline IS NOT NULL
              THEN COALESCE(v_last,
                     (SELECT max(l.completed_at) FROM public.data_sync_log l
                       WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial')))
              ELSE GREATEST(v_last,
                     (SELECT max(x.ticked_at) FROM public.dispatch_log x
                       WHERE x.armed_jobid IS NOT NULL AND x.job = r.job
                         AND x.decision = 'reaped' AND x.reason LIKE 'succeeded%'))
            END;
            SELECT count(*), max(x.ticked_at), (array_agg(x.reason ORDER BY x.ticked_at DESC))[1]
              INTO v_cd_n, v_cd_at, v_cd_reason
              FROM public.dispatch_log x
             WHERE x.armed_jobid IS NOT NULL AND x.job = r.job AND x.decision = 'reaped'
               AND (v_adv IS NULL OR x.armed_for > v_adv)
               AND (r.pipeline IS NOT NULL OR x.reason NOT LIKE 'succeeded%');
            IF r.runner = 'github_actions' THEN
              -- N2 (FIX-1336): a GHA reap carries no jobid; its request key links it.
              SELECT count(*), max(x.ticked_at), (array_agg(x.reason ORDER BY x.ticked_at DESC))[1]
                INTO v_cd_n, v_cd_at, v_cd_reason
                FROM public.dispatch_log x
               WHERE x.armed_jobid IS NULL AND x.armed_jobname LIKE 'gha_dispatch_request_%'
                 AND x.job = r.job AND x.decision = 'reaped' AND x.ticked_at > v_now - interval '1 day'
                 AND (v_adv IS NULL OR x.armed_for > v_adv);
            END IF;
            IF v_cd_n >= 1 THEN
              v_cd_until := v_cd_at + make_interval(secs =>
                LEAST(v_dials.rearm_cooldown_seconds * 2 ^ LEAST(v_cd_n - 1, 30), 86400));
              -- D-f (FIX-1332): a unit that WROTE when it clears is honoured.
              -- The newest `skipped` row since the last advance carrying
              -- metadata.gate.backoff_until (crawl_gate's backoff /
              -- peer_backoff exits) sets the re-arm to that + 60 s; the ladder
              -- is not consulted then. An unreadable instant leaves the ladder.
              v_cd_bo := NULL;
              IF r.pipeline IS NOT NULL THEN
                BEGIN
                  SELECT (l.metadata->'gate'->>'backoff_until')::timestamptz INTO v_cd_bo
                    FROM public.data_sync_log l
                   WHERE l.pipeline = r.pipeline AND l.status = 'skipped'
                     AND l.started_at > COALESCE(v_adv, '-infinity'::timestamptz)
                   ORDER BY l.started_at DESC
                   LIMIT 1;
                EXCEPTION WHEN OTHERS THEN
                  v_cd_bo := NULL;
                END;
              END IF;
              IF v_cd_bo IS NOT NULL THEN
                v_cd_until := GREATEST(v_cd_bo + interval '60 seconds', v_now);
              END IF;
              IF v_cd_until > v_now AND v_cd_bo IS NOT NULL THEN
                v_why := format('backoff: %s (unit says until %s; %s non-advancing reap(s))',
                                r.job, date_trunc('second', v_cd_bo), v_cd_n);
              ELSIF v_cd_until > v_now THEN
                v_why := format('cooldown: %s (%s non-advancing reap(s), last %L at %s; re-arm at %s)',
                                r.job, v_cd_n, left(v_cd_reason, 40),
                                date_trunc('second', v_cd_at), date_trunc('second', v_cd_until));
              END IF;
            END IF;
          END IF;
          -- FIX-1331 (D-e): the yield, in the pick. A yield_to peer that is
          -- live (the census), or whose own ttd is within ± yield_lead_seconds
          -- (the lead before its slot; the same span past it, as crawl_gate's
          -- peer grace bounded a peer that never starts). Only a peer this
          -- tick looped (eligible) is in v_ttds: an `at …` peer never yields.
          v_yield := NULL;
          IF cardinality(r.yield_to) > 0 THEN
            SELECT CASE WHEN y.job = ANY (v_live_jobs) THEN format('yield: %s live', y.job)
                        ELSE format('yield: %s due in %s', y.job, date_trunc('second', (v_ttds->>y.job)::interval)) END
              INTO v_yield
              FROM unnest(r.yield_to) WITH ORDINALITY AS y(job, ord)
             WHERE v_ttds ? y.job
               AND (y.job = ANY (v_live_jobs)
                    OR abs(EXTRACT(epoch FROM (v_ttds->>y.job)::interval)) <= r.yield_lead_seconds)
             ORDER BY (y.job = ANY (v_live_jobs)) DESC, y.ord
             LIMIT 1;
          END IF;
          IF v_why IS NOT NULL THEN
            NULL;  -- the cooldown (I6) is the first reason
          ELSIF v_mem_avail IS NOT NULL
                AND v_mem_avail - COALESCE(r.cap_mb, c_cap_default) < v_dials.headroom_target_mb THEN
            -- D8 (FIX-1354): MemAvailable less this row's cap must leave the
            -- headroom dial, or the row waits. Before 'live'; every runner.
            v_why := format('headroom: %s MB avail − %s MB cap < %s MB', v_mem_avail,
                            COALESCE(r.cap_mb, c_cap_default), v_dials.headroom_target_mb);
          ELSIF r.job = ANY (v_live_jobs) THEN
            v_why := 'live';
          ELSIF r.unit_shape = 'bare' AND r.unit_call ~* '^\s*VACUUM' AND v_vacuum_live IS NOT NULL THEN
            v_why := 'io: vacuum live (' || v_vacuum_live || ')';  -- D-a (FIX-1322): one VACUUM at a time
          ELSIF v_yield IS NOT NULL THEN
            v_why := v_yield;
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
              -- D-e (FIX-1333): the row it outranks is queued.
              IF v_pick_job IS NOT NULL THEN
                v_excluded := v_excluded || ('queued (' || v_pick_job || ')');
              END IF;
              v_pick_job    := r.job;
              v_pick_pri    := r.priority;
              v_pick_ttd    := v_ttd;
              v_pick_call   := r.unit_call;
              v_pick_rule   := r.deadline_rule;
              v_pick_budget := r.budget_seconds;
              v_pick_term   := v_term;
              v_pick_lock   := r.phase_lock;
            ELSE
              v_excluded := v_excluded || ('queued (' || r.job || ')');
            END IF;
          ELSE
            v_excluded := v_excluded || (v_why || ' (' || r.job || ')');  -- D-e: every blocked due row
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
        -- N2 (FIX-1336): a github_actions row arms a REQUEST STAMP. The route
        -- (*/5 21-23 * * *, /api/cron/gha-dispatch/nightly-request) fires on
        -- it; a fresh arm replaces a stale unconsumed one. No one-shot, no
        -- cron_job_budget row (the workflow's timeout-minutes is the bound).
        IF v_pick_call ~ '^gha-dispatch:[a-z0-9-]+$' THEN
          v_req_key := 'gha_dispatch_request_' || substring(v_pick_call FROM '^gha-dispatch:([a-z0-9-]+)$');
          INSERT INTO public.pipeline_state (key, value, updated_at)
          VALUES (v_req_key,
                  jsonb_build_object('job', v_pick_job, 'requested_at', v_now, 'dispatch_log_id', NULL,
                                     'consumed_at', NULL, 'outcome', NULL, 'http_status', NULL, 'reaped_at', NULL),
                  now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
          v_decision   := 'armed';
          v_job        := v_pick_job;
          v_armed_name := v_req_key;
          v_armed_for  := v_now;
          v_floor      := (SELECT COALESCE(max(runid), 0) FROM cron.job_run_details);
          v_box_out    := v_box->'readings';
          v_reason     := v_pick_rule || ' → ' || date_trunc('second', v_pick_ttd)::text || '; request ' || v_req_key;
          EXIT body;
        END IF;
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
        -- I2 (FIX-1316): the runid floor. Every run row this one-shot gets is
        -- above it, so the reap and the status LATERAL start their scan here.
        v_floor := (SELECT COALESCE(max(runid), 0) FROM cron.job_run_details);
        v_armed_id := cron.schedule(v_armed_name, v_sched, v_pick_call);
        -- D-b (FIX-1323): the due this arm came from, for a phase_lock row armed
        -- from its stale_after or floor term; NULL for every other arm (pct, a
        -- NULL anchor, by, phase_lock false). Written only on change, so an
        -- unlocked row's arm writes nothing.
        UPDATE public.job_registry
           SET phase_due_at = CASE WHEN v_pick_lock AND v_pick_term IN ('stale_after', 'floor')
                                   THEN v_now + v_pick_ttd END
         WHERE job = v_pick_job
           AND phase_due_at IS DISTINCT FROM (CASE WHEN v_pick_lock AND v_pick_term IN ('stale_after', 'floor')
                                                   THEN v_now + v_pick_ttd END);

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
      v_floor      := NULL;
      v_excluded   := '{}';
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
     armed_jobid, armed_jobname, armed_for, runid_floor, excluded)
  VALUES
    (v_source, v_job, v_decision, v_reason, v_live_caps, v_live_units, v_box_out,
     v_armed_id, v_armed_name, v_armed_for, v_floor, NULLIF(v_excluded, '{}'))
  RETURNING * INTO v_row;
  IF v_decision = 'armed' AND v_req_key IS NOT NULL THEN  -- N2: the stamp names its armed row
    UPDATE public.pipeline_state
       SET value = value || jsonb_build_object('dispatch_log_id', v_row.id)
     WHERE key = v_req_key;
  END IF;

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
  'vercel (the box-health route''s re-fire), manual. runid floor (FIX-1316): the arm records '
  'max(runid) and the reap reads above it; re-arm cooldown (FIX-1316): a due row with '
  'non-advancing reaps waits platform_dials.rearm_cooldown_seconds × 2^(n−1), capped at 24 h. '
  'B1 (cc-239): one VACUUM at a time (io: vacuum live, FIX-1322); per-row phase lock '
  '(job_registry.phase_lock / phase_due_at, FIX-1323); a dead_tuples floor with no anchor is due '
  '(FIX-1326); by reads daily / weekly / monthly slots (cron_prev_slot / cron_next_slot, FIX-1329); '
  'every due row not armed in dispatch_log.excluded (FIX-1333); the cooldown honours a unit''s own '
  'metadata.gate.backoff_until (FIX-1332). N2 (cc-243): a github_actions row whose unit_call is '
  'gha-dispatch:<stem> is eligible and arms a request stamp (pipeline_state gha_dispatch_request_<stem>) '
  'that the */5 nightly-request route fires, reaped off its pipeline rows (FIX-1336); a by row with '
  'by_window_minutes is due only inside its window; yield_to / yield_lead_seconds exclude a row as '
  'yield: <peer> live | due in <iv> (FIX-1331); a stale_after row honours its unit''s own '
  'metadata.next_due_at (FIX-1330); the GHA reap sweeps leftover session holds when no session is held '
  '(FIX-1337). FIX-1354 (cc-251): box: memory when the swap ceiling is reached (step 4, via '
  'box_is_saturated); per due row, MemAvailable − cap_mb < platform_dials.headroom_target_mb excludes '
  'it as headroom: … (step 6, after the cooldown, before live); a stale mirror skips the test.';

ALTER TABLE public.job_registry DROP COLUMN IF EXISTS anchor_cadence;

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM '64c8271e7601095d275c68eff5187931' THEN
    RAISE EXCEPTION '[fix1361-revert] dispatch_one_unit md5 % — expected the pre-FIX-1361 pin 64c8271e7601095d275c68eff5187931', v_d;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_registry' AND column_name = 'anchor_cadence') THEN
    RAISE EXCEPTION '[fix1361-revert] job_registry.anchor_cadence still present';
  END IF;
  RAISE NOTICE '[fix1361-revert] dispatch_one_unit back on 64c8271e7601095d275c68eff5187931; job_registry.anchor_cadence dropped';
END $$;
