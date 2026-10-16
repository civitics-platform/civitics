-- =============================================================================
-- FIX-1316 — M1: RETURN donor-rollup-refresh through job_registry as
-- `stale_after 12 hours` (the first row move of the cutover, v1.3 note §2),
-- plus the dispatcher's runid floor (cc-224 I2) and re-arm cooldown (I6), and
-- the bulk procedure's 13:00Z start window retired for the DISPATCHED path.
-- cc-234, 2026-10-16.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (a) platform_dials.rearm_cooldown_seconds int NOT NULL DEFAULT 1800,
--       CHECK 0..86400 — the I6 dial; then dispatch_log.runid_floor bigint — the
--       I2 floor recorded at ARM. platform_dials FIRST: the tick and the status
--       RPC lock platform_dials before dispatch_log, and this file takes them in
--       the same order so it cannot deadlock with a tick in flight.
--   (b) dispatch_one_unit(text) and (c) get_dispatcher_status() — CREATE OR
--       REPLACE from 20261015230000's text VERBATIM plus these hunks only:
--         step 7 ARM   v_floor := (SELECT COALESCE(max(runid), 0) FROM
--                      cron.job_run_details) before cron.schedule; the final
--                      dispatch_log INSERT carries it as runid_floor (NULL on
--                      every other decision, and on `error`).
--         step 3 reap  the armed CTE carries runid_floor; the runs CTE gains
--                      `AND d.runid > (SELECT min(COALESCE(a.runid_floor, 0))
--                      FROM armed a)`. A NULL floor (a row armed before this
--                      file — none exist on prod) is 0 = the old scan.
--         step 6 pick  the re-arm cooldown — the FIRST exclusion of a due row,
--                      before 'live' (below).
--         status       live[] selects the un-reaped armed rows FIRST (a
--                      MATERIALIZED CTE, same WHERE + NOT EXISTS) and the
--                      LATERAL runs over those only, gaining `AND d.runid >
--                      COALESCE(a.runid_floor, 0)`; dials gains
--                      rearm_cooldown_seconds. The CTE is the one change the
--                      prompt did not name (Craig, cc-234): in 20261015230000's
--                      shape the anti-join sat ABOVE the LATERAL, so the LATERAL
--                      ran for every armed row of the 14-day retention and each
--                      reaped one scanned back to its own run — the floor alone
--                      bounds only a never-started row (clone EXPLAIN, 7 armed
--                      rows / 1 live: loops=7, 4,283 buffers floored, 6,301 not).
--       Nothing else in either body moves; cc-234's report carries the diff.
--   (d) public.donor_rollup_rebuild_bulk_dispatched() — the dispatched path's
--       entry point (D-d as built; see below).
--   (e) the row move: job_registry 'donor-rollup-refresh' `at 0 9,12 * * *` →
--       `stale_after 12 hours`, unit_call → the wrapper.
--   (f) its cutover hold row CONVERTED (not deleted) into a cadence_hours = 12
--       declaration, so list_scheduled_rollup_pipelines() reads it
--       has_override rather than orphan (canary-check pushes
--       orphan:<pipeline> for a pg_cron pipeline with no active job and no
--       override), and the claim's clearGuardedHolds() GC keeps it
--       (`cadence_hours IS NULL` guards its DELETE). FIX-1317 moves the canary
--       onto the registry rule; until then this mirrors it.
--   (g) cron 'donor-rollup-refresh' (jobid 24 on prod) asserted inactive by
--       NAME. The registry owns the job; two owners is a RAISE, never a fix-up.
--   (h) a read-back DO block that RAISEs on any miss.
--
-- I2 — WHY THE FLOOR. cron.job_run_details has only its runid PK and is owned
-- by supabase_admin (no index can be added). The reap and the status LATERAL
-- read it by jobid. Unfloored, that is a Seq Scan of the whole retention
-- (clone 2026-10-15: 1,039 buffers, 36,162 rows filtered; prod read
-- 2026-10-16 02:46Z: 99,165 rows / 19 MB). Floored, the reap reads the PK
-- from the oldest live arm upward.
--
-- I6 — THE COOLDOWN. For a DUE row, n = its `reaped` rows armed after its last
-- ADVANCING completion (a pipeline's data_sync_log complete|partial; for a bare
-- row the newest `reaped succeeded`, so only its non-succeeded reaps count).
-- `missed` rows never count (FIX-1137's re-arm path is untouched). With n >= 1
-- the row is excluded until the newest such reap's ticked_at +
-- LEAST(rearm_cooldown_seconds × 2^(n−1), 86400) s — 1800 → 3600 → 7200 → … →
-- 24 h — with reason `cooldown: <job> (<n> non-advancing reap(s), last
-- '<reason ≤ 40>' at <t>; re-arm at <t>)`, the nothing_due row's named blocker
-- like gated:/caps:. Why: a `skipped` (prod session held, box saturated after
-- the 600 s gate, advisory lock held) or failed run does not advance
-- `stale_after`, so without it the row re-arms every ~4 min (cc-224 #26).
-- Exponential with the same first value (Craig's #2 (b)): a hard-failing unit
-- costs ~5 attempts on day one and one a day after, with no reset vocabulary —
-- the first advancing completion clears it. rearm_cooldown_seconds = 0
-- disables it.
--
-- D-d AS BUILT — the 13:00Z start window, retired for the dispatched path by a
-- WRAPPER, not by a role GUC. donor_rollup_rebuild_bulk() refuses to START at
-- or after civitics.donor_rollup_latest_start_hour (default c_latest_hour 13,
-- 20261009030000:1511, FIX-1002), a cron-era rule the dispatcher's `live`
-- exclusion, c_budget 2 h, the 9,000 s one-shot budget row and
-- box_backoff_gate now own. Under `stale_after 12 hours` it would push every
-- second firing past 13:00Z. The ratified mechanism, `ALTER ROLE postgres SET
-- civitics.donor_rollup_latest_start_hour = '24'`, CANNOT be applied on
-- Supabase: postgres is not a superuser and civitics.* is not in
-- supautils.privileged_role_allowed_configs, so ALTER ROLE / ALTER ROLE … IN
-- DATABASE / ALTER DATABASE … SET all fail `permission denied to set
-- parameter` (clone, 2026-10-16 02:37Z; prod has_parameter_privilege(...,
-- 'SET') = f at 02:46Z). Craig chose the wrapper in cc-234.
-- donor_rollup_rebuild_bulk_dispatched() sets the GUC SESSION-scoped
-- (set_config(..., false), so it survives the inner procedure's COMMITs) and
-- CALLs the bulk. It has no SET clause and is not SECURITY DEFINER, so the
-- nested CALL stays non-atomic and the bulk's COMMITs work — measured on the
-- clone before this file was written: cfg=24 cutoff=24 before and after an
-- inner COMMIT. It restores the previous value after the CALL, so a human who
-- CALLs it from psql keeps their session as it was (the pg_cron one-shot's
-- connection ends with the job anyway). The scope is narrower than the role
-- GUC would have been: only the dispatched path loses the window; a break-glass
-- `CALL public.donor_rollup_rebuild_bulk();` still has it. It is a dial in a
-- routine until the registry carries eligibility windows.
--   Rejected again: a multi-statement unit_call (`SET …; CALL …` is an implicit
-- transaction block and the first COMMIT dies — FIX-1128, measured); editing
-- the 740-line bulk (the work-mem suite line-diffs it); a proconfig on the bulk
-- (any SET clause makes a procedure atomic and its COMMITs fail).
--
-- NETS: platform_dials.pause (the hard stop for the arm); the 9,000 s
-- cron_job_budget row the dispatcher writes for the one-shot (the */2
-- watchdog cancels an over-budget CALL); the row's FIX-950 `prod_session` gate;
-- the cooldown; the data revert below.
--
-- ROLLBACK (data): scripts/fix1316-revert-donor-rollup-return.sql, a --call
-- payload: registry row back to `at 0 9,12 * * *` + the bulk's unit_call; the
-- hold row back to the cutover hold. If a disp-donor-rollup-refresh-% one-shot
-- is armed or running, set pause = true first and wait for its `reaped` row.
-- The two columns, the dial, the two bodies and the wrapper STAY: reverting
-- them is a follow-up migration re-applying 20261015230000's bodies.
-- scripts/fix1311-unpark-derived-layer-crons.sql is valid only after that
-- revert (it would give jobid 24 two owners).
--
-- IDEMPOTENT: IF NOT EXISTS, CREATE OR REPLACE, and UPDATEs that NOTICE
-- "already returned" on a second run. The clone gets it twice through
-- `db-query.mjs --local --call --file` (rule 241).
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- (a) the two columns — platform_dials first (the tick's lock order)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.platform_dials
  ADD COLUMN IF NOT EXISTS rearm_cooldown_seconds int NOT NULL DEFAULT 1800
    CHECK (rearm_cooldown_seconds BETWEEN 0 AND 86400);

COMMENT ON COLUMN public.platform_dials.rearm_cooldown_seconds IS
  'FIX-1316 / I6 — the re-arm cooldown: a due row with n >= 1 non-advancing reaps since its '
  'last advancing completion waits LEAST(this × 2^(n−1), 86400) s after the newest one. '
  '0 disables it.';

ALTER TABLE public.dispatch_log
  ADD COLUMN IF NOT EXISTS runid_floor bigint;

COMMENT ON COLUMN public.dispatch_log.runid_floor IS
  'FIX-1316 / I2 — on an `armed` row, max(cron.job_run_details.runid) at ARM. The reap and '
  'get_dispatcher_status() read the one-shot''s run rows above it only. NULL on every other row.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (b) dispatch_one_unit() — 20261015230000 + the floor (steps 3, 7) and the
--     cooldown (step 6)
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_adv         timestamptz;  -- I6 (FIX-1316): the row's last advancing completion
  v_cd_n        int;
  v_cd_at       timestamptz;
  v_cd_reason   text;
  v_cd_until    timestamptz;
  -- step 7
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
            IF v_cd_n >= 1 THEN
              v_cd_until := v_cd_at + make_interval(secs =>
                LEAST(v_dials.rearm_cooldown_seconds * 2 ^ LEAST(v_cd_n - 1, 30), 86400));
              IF v_cd_until > v_now THEN
                v_why := format('cooldown: %s (%s non-advancing reap(s), last %L at %s; re-arm at %s)',
                                r.job, v_cd_n, left(v_cd_reason, 40),
                                date_trunc('second', v_cd_at), date_trunc('second', v_cd_until));
              END IF;
            END IF;
          END IF;
          IF v_why IS NOT NULL THEN
            NULL;  -- the cooldown (I6) is the first reason
          ELSIF r.job = ANY (v_live_jobs) THEN
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
        -- I2 (FIX-1316): the runid floor. Every run row this one-shot gets is
        -- above it, so the reap and the status LATERAL start their scan here.
        v_floor := (SELECT COALESCE(max(runid), 0) FROM cron.job_run_details);
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
      v_floor      := NULL;
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
     armed_jobid, armed_jobname, armed_for, runid_floor)
  VALUES
    (v_source, v_job, v_decision, v_reason, v_live_caps, v_live_units, v_box_out,
     v_armed_id, v_armed_name, v_armed_for, v_floor)
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
  'vercel (the box-health route''s re-fire), manual. runid floor (FIX-1316): the arm records '
  'max(runid) and the reap reads above it; re-arm cooldown (FIX-1316): a due row with '
  'non-advancing reaps waits platform_dials.rearm_cooldown_seconds × 2^(n−1), capped at 24 h.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (c) get_dispatcher_status() — 20261015230000 + the floored LATERAL + the dial
-- ═══════════════════════════════════════════════════════════════════════════

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
    -- I2 (FIX-1316): the live rows first, then one floored LATERAL each.
    WITH live AS MATERIALIZED (
      SELECT a.id, a.job, a.armed_jobid, a.armed_jobname, a.armed_for, a.runid_floor
        FROM public.dispatch_log a
       WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
         AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                          WHERE x.armed_jobid = a.armed_jobid
                            AND x.decision IN ('reaped', 'missed'))
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'job', a.job, 'armed_jobname', a.armed_jobname, 'armed_for', a.armed_for,
             'run_status', COALESCE(rd.status, 'not started')) ORDER BY a.id), '[]'::jsonb)
      INTO v_live
      FROM live a
      LEFT JOIN LATERAL (SELECT d.status FROM cron.job_run_details d
                          WHERE d.jobid = a.armed_jobid
                            AND d.runid > COALESCE(a.runid_floor, 0)
                          ORDER BY d.runid DESC LIMIT 1) rd ON true;
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
               'rearm_cooldown_seconds', v_dials.rearm_cooldown_seconds,
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
  'run status, the seven dials, registry counts, and the tick job''s active/schedule/budget. One '
  'read for the /dashboard tile (via the status snapshot) and the receipts'' §9 line. SECURITY '
  'DEFINER (owner postgres) because it reads cron.job. runid floor (FIX-1316): live[] reads '
  'each one-shot''s run rows above its arm''s floor; re-arm cooldown dial in dials.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (d) donor_rollup_rebuild_bulk_dispatched() — the dispatched path, window off
-- ═══════════════════════════════════════════════════════════════════════════
-- No SET clause and SECURITY INVOKER: either would make the nested CALL atomic
-- and the bulk's first COMMIT would fail. c_pipeline and the prod_session_state
-- mention below are what cron-job-pipelines.ts reads off the ONE routine a
-- command names (the guarded/pipeline derivation is one level deep): while a
-- disp- one-shot of this exists, it reads guarded, pipeline
-- donor_rollup_refresh, which is what it is.

CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk_dispatched()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_pipeline text := 'donor_rollup_refresh';
  v_prev     text := current_setting('civitics.donor_rollup_latest_start_hour', true);
BEGIN
  -- FIX-1316 (D-d as built): the 13:00Z start window is the dispatcher's to
  -- own now. Session-scoped so it survives the bulk's COMMITs.
  PERFORM set_config('civitics.donor_rollup_latest_start_hour', '24', false);
  RAISE NOTICE '[%] dispatched: start window retired for this call; the FIX-950 prod_session_state() guard, the box gate and the advisory lock stay the bulk''s', c_pipeline;
  CALL public.donor_rollup_rebuild_bulk();
  PERFORM set_config('civitics.donor_rollup_latest_start_hour', COALESCE(v_prev, ''), false);
END;
$procedure$;

ALTER PROCEDURE public.donor_rollup_rebuild_bulk_dispatched() OWNER TO postgres;
REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk_dispatched() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk_dispatched() TO service_role;

COMMENT ON PROCEDURE public.donor_rollup_rebuild_bulk_dispatched() IS
  'FIX-1316 — job_registry donor-rollup-refresh''s unit_call: set_config(''civitics.donor_rollup_latest_start_hour'', '
  '''24'', false) then CALL donor_rollup_rebuild_bulk(), so the dispatched path has no 13:00Z start window '
  '(the role GUC is not settable on Supabase). No SET clause, not SECURITY DEFINER: the nested CALL stays '
  'non-atomic and the bulk COMMITs. Restores the previous session value afterwards.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (e) the row move
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 12 hours',
         unit_call     = 'CALL public.donor_rollup_rebuild_bulk_dispatched();',
         note          = note || '; RETURNED 2026-10-16 (FIX-1316, cc-234): stale_after 12 h first, '
                                 '6 h after the 72 h receipt; unit_call = the wrapper that retires the '
                                 '13:00Z start window for the dispatched path (the role GUC is not settable on Supabase)',
         updated_at    = now()
   WHERE job = 'donor-rollup-refresh'
     AND deadline_rule = 'at 0 9,12 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1316] job_registry donor-rollup-refresh: at 0 9,12 * * * → stale_after 12 hours (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'donor-rollup-refresh';
    IF v_rule = 'stale_after 12 hours' THEN
      RAISE NOTICE '[fix1316] job_registry donor-rollup-refresh already returned (stale_after 12 hours) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1316] job_registry donor-rollup-refresh reads %, expected at 0 9,12 * * * or stale_after 12 hours',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (f) the cutover hold row → a cadence declaration (converted, not deleted)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n   int;
  v_row public.rollup_watch_overrides%ROWTYPE;
BEGIN
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 12,
         note          = 'FIX-1316 (cc-234) — donor-rollup-refresh RETURNED via job_registry (stale_after 12 '
                         'hours); cadence_hours mirrors the registry rule for the canary until it reads '
                         'job_registry (FIX-1317). Revert: scripts/fix1316-revert-donor-rollup-return.sql',
         updated_at    = now()
   WHERE pipeline = 'donor_rollup_refresh'
     AND hold_reason LIKE 'parked for the dispatcher cutover (cc-232%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1316] rollup_watch_overrides donor_rollup_refresh: cutover hold → cadence_hours 12 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'donor_rollup_refresh';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1316] rollup_watch_overrides has no donor_rollup_refresh row — expected the cc-232 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 12 THEN
      RAISE NOTICE '[fix1316] rollup_watch_overrides donor_rollup_refresh already a cadence row (12 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1316] donor_rollup_refresh override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
        v_row.held_since, v_row.hold_reason, v_row.cadence_hours;
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (g) one owner: the parked cron row stays parked (by NAME — FIX-946)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'donor-rollup-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1316] % cron.job rows named donor-rollup-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'donor-rollup-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1316] cron donor-rollup-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1316] jobid % inactive — registry owns it', v_jobid;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (h) read-back (D-e) — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_dial    int;
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'dispatch_log'
                    AND column_name = 'runid_floor' AND data_type = 'bigint') THEN
    v_missing := v_missing || 'dispatch_log.runid_floor bigint';
  END IF;
  SELECT rearm_cooldown_seconds INTO v_dial FROM public.platform_dials WHERE id;
  IF v_dial IS DISTINCT FROM 1800 THEN
    v_missing := v_missing || format('platform_dials.rearm_cooldown_seconds = %s, expected 1800', v_dial);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_registry
                  WHERE job = 'donor-rollup-refresh' AND deadline_rule = 'stale_after 12 hours'
                    AND unit_call = 'CALL public.donor_rollup_rebuild_bulk_dispatched();') THEN
    v_missing := v_missing || 'job_registry donor-rollup-refresh stale_after 12 hours + the wrapper unit_call';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'donor_rollup_refresh' AND cadence_hours = 12
                    AND held_since IS NULL AND retired_at IS NULL) THEN
    v_missing := v_missing || 'rollup_watch_overrides donor_rollup_refresh cadence_hours 12 / held_since NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'donor-rollup-refresh' AND active) THEN
    v_missing := v_missing || 'cron donor-rollup-refresh inactive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE proname = 'donor_rollup_rebuild_bulk_dispatched'
                    AND pronamespace = 'public'::regnamespace
                    AND prokind = 'p' AND proconfig IS NULL AND NOT prosecdef) THEN
    v_missing := v_missing || 'donor_rollup_rebuild_bulk_dispatched() a procedure with no proconfig, not SECURITY DEFINER';
  END IF;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  -- The 20261015230000 bodies (cc-234 read 3, prod 02:46Z): these must have moved.
  IF v_md5_d IS NULL OR v_md5_d = 'c253e5eeb65f1e1d269417e154fe5f16' THEN
    v_missing := v_missing || 'dispatch_one_unit body replaced';
  END IF;
  IF v_md5_g IS NULL OR v_md5_g = '5e441fac0528b97d3aff84976cc34546' THEN
    v_missing := v_missing || 'get_dispatcher_status body replaced';
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1316] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1316] read-back ok: runid_floor + rearm_cooldown_seconds 1800; donor-rollup-refresh stale_after 12 hours via donor_rollup_rebuild_bulk_dispatched(); override cadence_hours 12; cron row inactive; dispatch_one_unit % / get_dispatcher_status %',
    v_md5_d, v_md5_g;
END $$;
