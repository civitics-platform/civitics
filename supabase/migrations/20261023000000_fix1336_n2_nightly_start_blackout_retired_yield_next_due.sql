-- =============================================================================
-- FIX-1336, FIX-1124 (part 2), FIX-1331, FIX-1330, FIX-1337 — N2: the
-- nightly's START becomes a dispatched unit; the blackout retires; the crawls'
-- yield moves into the pick; the crawl reports its own next-due; the GHA reap
-- sweeps leftover session holds. cc-243, 2026-10-23.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (a) job_registry + by_window_minutes int CHECK (> 0), yield_to text[] NOT
--       NULL DEFAULT '{}', yield_lead_seconds int NOT NULL DEFAULT 0. No
--       dispatch_log column: a GHA arm's armed_jobname (nullable text) carries
--       its request key, armed_jobid NULL (read 4 — an existing column fits).
--   (b) consume_gha_dispatch_request(stem, outcome, http) — SECURITY DEFINER,
--       service_role only: the route marks the request it fired.
--   (c) dispatch_one_unit() — 20261020000000 (B1) VERBATIM (prosrc md5
--       cfc9ed48517cd7de6fa76cf807dd1f37 = prod at cc-243 read 3) plus:
--         GHA admission  the pick admits runner github_actions when unit_call
--                        is gha-dispatch:<stem> (the six gha: rows stay `at`).
--         by window      a by row with by_window_minutes is due only inside
--                        [slot, slot + window); past it, next slot (D-b).
--         GHA arm        writes pipeline_state gha_dispatch_request_<stem>
--                        {job, requested_at, dispatch_log_id, consumed_at,
--                        outcome, http_status, reaped_at} instead of
--                        cron.schedule; armed row armed_jobid NULL,
--                        armed_jobname = the key; no cron_job_budget row.
--         GHA reap (3b)  per live request: a refused/error answer → reaped
--                        failed: dispatch <status> <http>; a running row →
--                        live; the tail phase (enrichment-tail) terminal →
--                        reaped succeeded: GHA (unit_ms = tail end − first
--                        start; failed tail → failed); another terminal row
--                        ≥ 10 min quiet → reaped failed: GHA <phase> <status>;
--                        no answer and no row by arm + 20 min → missed (the
--                        row stays due in its window); no row by arm +
--                        budget → reaped failed. Live requests join the
--                        census as armed units. The I6 ladder counts a GHA
--                        reap by its request key (it has no jobid).
--         sweep (D-h)    on a GHA reap, when prod_session_state() reads
--                        unheld and session rows exist: clearGuardedHolds'
--                        SQL verbatim + the stale prod_session label →
--                        `; swept N hold(s)` (FIX-1337, rule 285).
--         yield (D-e)    yield_to / yield_lead_seconds: after cooldown / live
--                        / io, before group busy — `yield: <peer> live`, or
--                        `yield: <peer> due in <iv>` when the peer's own ttd
--                        (this tick's, v_ttds) is within ± the lead. A
--                        yielding row is looped after its peers; an `at …`
--                        peer is never looped and never yields (FIX-1331).
--         next_due (D-f) a stale_after pipeline row reads its newest
--                        advancing row's metadata.next_due_at in the same
--                        read as v_last; due = GREATEST(last + interval,
--                        next_due_at) (FIX-1330).
--       get_dispatcher_status(): live[] lists unreaped GHA requests;
--       registry.eligible counts what the pick admits.
--   (d) prod_op_gate() — 20260920150000 VERBATIM; check (c): an empty or
--       absent ec_crawl.blackout is NO window (source 'none (FIX-1124 part
--       2)'); c_blackout_from / c_blackout_to removed. in_blackout() is
--       unchanged (it already reads [] as false).
--   (e) run_entity_connections_rebuild() — 20261009030000 VERBATIM + 9 lines:
--       the cycle-closing unit (the one that DELETEs
--       entity_connections_rebuild_cursor) whose terminal row is `complete`
--       writes metadata.next_due_at = clock_timestamp() +
--       min_cycle_interval_minutes (ec_crawl config; 360), only when > 0.
--   (f) data, each matched on its exact old value: nightly `at 0 21 * * *` →
--       `by 0 21 * * *` window 120, idempotent_refire true; ec-crawl /
--       fe-crawl gates {prod_session,blackout} → {prod_session}, yield_to the
--       two dailies, lead 1800; ec_crawl.blackout → []; ec_crawl / fe_crawl
--       yield_to → [] (crawl_gate's peer_* branches go inert — the receipts'
--       Peers counters stop moving by design).
--   (g) read-back — RAISEs on any miss; prints the new md5s.
--
-- WHY: spec D6 + v1.2 ("N2's mechanism (DB → route) is a stamp the route
-- polls"); design-fix1124 D4 (part 2: what guards the 06:00 stack is the
-- dispatcher's caps / max_concurrent_units 2 / groups + the yield); FIX-1331
-- (crawl_gate's peer_due reads cron.job and CONTINUEs on a parked peer — dead
-- since 10-13); FIX-1330 option 2 (each cycle gap cost ~4 non-advancing
-- one-shots and opened the next cycle up to ~2 h late, rule 332).
--
-- NETS: platform_dials.pause; the GHA `schedule:` fallback (0 21, ~1.6–2.7 h
-- late, dedup'd by the preflight's already_ran) for a lapsed window; the
-- legacy `0 21` Vercel entry still fires while the row reads `at …`.
--
-- ROLLBACK: scripts/fix1336-revert-dispatcher-n2.sql (pause first; the B1
-- bodies verbatim + the rows and config back), scripts/fix1336-revert-prod-op-
-- gate.sql, scripts/fix1330-revert-ec-rebuild-next-due.sql.
--
-- IDEMPOTENT: IF NOT EXISTS / CREATE OR REPLACE; the data edits match on old
-- values ("already" NOTICEs on a second apply). Applied twice on the clone.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- (a) the columns — dispatch_log first (the tick's lock order, B1)
-- ═══════════════════════════════════════════════════════════════════════════

-- dispatch_log needs no column: a GHA arm's armed_jobname carries its request
-- key (gha_dispatch_request_<stem>, armed_jobid NULL), and its reap / missed
-- row carries the same key and armed_for (read 4, cc-243).

ALTER TABLE public.job_registry
  ADD COLUMN IF NOT EXISTS by_window_minutes  int,
  ADD COLUMN IF NOT EXISTS yield_to           text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS yield_lead_seconds int    NOT NULL DEFAULT 0;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.job_registry'::regclass
                    AND conname = 'job_registry_by_window_minutes_check') THEN
    ALTER TABLE public.job_registry
      ADD CONSTRAINT job_registry_by_window_minutes_check CHECK (by_window_minutes > 0);
  END IF;
END $chk$;

COMMENT ON COLUMN public.job_registry.by_window_minutes IS
  'N2 (FIX-1336, cc-243) — for a by rule: the slot is due only inside [slot, slot + window); past it the '
  'row waits for the next slot (the lapse writes no row). NULL = I3''s rule (due until met).';
COMMENT ON COLUMN public.job_registry.yield_to IS
  'FIX-1331 (cc-243) — jobs this row yields to: a due row is excluded `yield: <peer> live` when a peer is '
  'live, or `yield: <peer> due in <iv>` when the peer''s own ttd is within ± yield_lead_seconds. Only an '
  'eligible peer (looped by the pick) yields anyone; an `at …` peer never does.';
COMMENT ON COLUMN public.job_registry.yield_lead_seconds IS
  'FIX-1331 (cc-243) — the lead (and the grace past the peer''s slot) for yield_to, seconds.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (b) consume_gha_dispatch_request() — the route marks the request it fired
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.consume_gha_dispatch_request(
  p_stem    text,
  p_outcome text,
  p_http    integer DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_value jsonb;
BEGIN
  IF p_stem IS NULL OR p_stem !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN
    RAISE EXCEPTION 'consume_gha_dispatch_request: stem % is not a slug', COALESCE(quote_literal(p_stem), 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('dispatched', 'refused', 'error') THEN
    RAISE EXCEPTION 'consume_gha_dispatch_request: outcome % is not dispatched|refused|error',
      COALESCE(quote_literal(p_outcome), 'NULL')
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.pipeline_state
     SET value = value || jsonb_build_object('consumed_at', clock_timestamp(), 'outcome', p_outcome,
                                             'http_status', p_http),
         updated_at = now()
   WHERE key = 'gha_dispatch_request_' || p_stem
     AND value->>'consumed_at' IS NULL
  RETURNING value INTO v_value;
  RETURN v_value;  -- NULL: there was no pending request
END;
$function$;

ALTER FUNCTION public.consume_gha_dispatch_request(text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_gha_dispatch_request(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_gha_dispatch_request(text, text, integer) TO service_role;

COMMENT ON FUNCTION public.consume_gha_dispatch_request(text, text, integer) IS
  'N2 (FIX-1336, cc-243) — /api/cron/gha-dispatch/nightly-request marks the request stamp it fired '
  '(pipeline_state gha_dispatch_request_<stem>): consumed_at, outcome, http_status. Only an unconsumed '
  'request moves; NULL when there was none. The dispatcher''s reap reads the outcome. service_role only.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (c) dispatch_one_unit() — 20261020000000 (B1) VERBATIM + the N2 hunks
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
  '(FIX-1337).';


-- ═══════════════════════════════════════════════════════════════════════════
-- (c) get_dispatcher_status() — 20261020000000 (B1) VERBATIM + the N2 hunks
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

  SELECT l.ticked_at, l.source, l.decision, l.job, l.reason, l.excluded INTO v_last
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
  -- N2 (FIX-1336): a GHA arm is a request stamp, live until its reap.
  SELECT v_live || COALESCE(jsonb_agg(jsonb_build_object(
           'job', ps.value->>'job', 'armed_jobname', ps.key, 'armed_for', ps.value->'requested_at',
           'run_status', CASE WHEN ps.value->>'consumed_at' IS NULL THEN 'requested'
                              ELSE 'dispatch ' || COALESCE(ps.value->>'outcome', '?') END) ORDER BY ps.key), '[]'::jsonb)
    INTO v_live
    FROM public.pipeline_state ps
   WHERE ps.key LIKE 'gha_dispatch_request_%' AND ps.value->>'reaped_at' IS NULL;

  SELECT jsonb_build_object(
           'rows',      count(*),
           'eligible',  count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'
                                           AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')),
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
    'last_excluded',      v_last.excluded,
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
  'each one-shot''s run rows above its arm''s floor; re-arm cooldown dial in dials. last_excluded '
  '(FIX-1333, cc-239): the newest tick row''s dispatch_log.excluded. N2 (FIX-1336, cc-243): live[] '
  'also lists a GHA request stamp not yet reaped (run_status requested | dispatch <outcome>); '
  'registry.eligible counts what the pick admits (pg_cron, or a gha-dispatch:<stem> unit_call).';


-- ═══════════════════════════════════════════════════════════════════════════
-- (d) prod_op_gate() — 20260920150000 VERBATIM + the FIX-1124 part 2 hunk
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
  v_wd_rows   jsonb;  -- FIX-1194 cc-153: the watchdog rows from the one (d) scan
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
         (SELECT count(*) FROM d WHERE d.startup_timeout AND d.start_time > p_now - interval '60 minutes'),
         (SELECT max(d.start_time) FROM d WHERE d.startup_timeout AND d.start_time > p_now - interval '60 minutes'),
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
      'detail', format('%s job startup timeout failure(s) in the last 60 min, latest %s', v_n,
                       to_char(v_t AT TIME ZONE 'UTC', 'HH24:MI:SS')),
      'retry_after', v_t + interval '60 minutes');
  END IF;

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


-- ═══════════════════════════════════════════════════════════════════════════
-- (e) run_entity_connections_rebuild() — 20261009030000 VERBATIM + the FIX-1330 hunk
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text, IN p_max_units integer DEFAULT NULL::integer)
 LANGUAGE plpgsql
AS $procedure$DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- EXCEPTION WHEN OTHERS does not match query_canceled, so before this the 6h
  -- statement_timeout blew straight through both handlers below and out of the
  -- procedure, skipping the terminal UPDATE and stranding the row 'running'.
  v_canceled   text := NULL;
  -- ── FIX-1056 — budget + durable per-arm resume checkpoint ─────────────────
  -- 5h, deliberately 1h under the 6h `postgres` role statement_timeout so the
  -- terminal bookkeeping below is never the thing that gets cancelled. Do NOT
  -- raise this to 6h: the margin IS the feature. FIX-1071 mirrors this value in
  -- cron_job_budget as an OUTSIDE bound, because this one is checked at arm
  -- boundaries and therefore cannot bound a single arm.
  c_budget_default interval := interval '5 hours';
  c_budget        interval;
  c_cursor_key    text     := 'entity_connections_rebuild_cursor';
  c_budget_key    text     := 'entity_connections_rebuild_budget';
  c_cycle_max_age interval := interval '7 days';
  v_cursor        jsonb;
  v_done_arms     text[]   := ARRAY[]::text[];
  v_cycle_started timestamptz;
  v_cycle_closed  boolean  := false;  -- FIX-1330 (cc-243): this unit cleared the cursor
  v_budget_out    boolean  := false;
  v_arm_started   timestamptz;
  v_arm_failed    boolean;
  v_arm_timings   jsonb    := '{}'::jsonb;
  v_next_arm      text     := NULL;
  v_resumed       boolean  := false;
  -- ── FIX-1069 — the donations arm is windowed in BOTH modes ────────────────
  v_don_arm       text;
  v_incr_target   timestamptz := NULL;
  v_bootstrap     boolean  := false;
  v_closed        boolean;
  -- ── FIX-1101 ──────────────────────────────────────────────────────────────
  c_inflight_key  text     := 'entity_connections_window_inflight';
  v_interlock     jsonb;
  -- ── FIX-1111 — the crawl ──────────────────────────────────────────────────
  v_crawl        boolean := (p_max_units IS NOT NULL);
  v_units_run    int     := 0;
  v_unit_capped  boolean := false;
  v_gate         jsonb;
  v_unit_t0      timestamptz;
  v_unit_secs    numeric;
  v_rec          jsonb;
  v_backoff_set  boolean := false;
  v_win_since    timestamptz;
  v_unit_log     jsonb   := '[]'::jsonb;
  -- ── FIX-1115 — entity_connection_stats as 16 bounded windows ──────────────
  c_stats_arm    text    := 'entity_connection_stats_windows';
  c_stats_key    text    := 'entity_connection_stats_progress';
  v_stats_prog   jsonb;
  v_stats_done   int[]   := ARRAY[]::int[];
  v_stats_fp     text;
  v_stats_res    jsonb;
  v_stats_ups    bigint  := 0;
  v_stats_del    bigint  := 0;
  -- ── FIX-1117 — the per-arm source-change gate ─────────────────────────────
  c_fp_key       text    := 'ec_arm_source_fingerprints';
  v_fp           text;
  v_fp_prev      text;
  v_fp_t0        timestamptz;
  v_fp_secs      numeric := 0;
  v_gated_arms   text[]  := ARRAY[]::text[];
  -- ── FIX-1270 — park a generic arm after two consecutive cancels (cc-188) ───
  c_park_key      text    := 'ec_arm_parked';
  v_park          jsonb;
  v_last_two      text[];
  v_parked_now    text    := NULL;
  v_parked_detail text    := NULL;
  v_parked_arms   text[]  := ARRAY[]::text[];
  v_unparked_arms text[]  := ARRAY[]::text[];
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo         uuid;
  v_hi         uuid;
  v_win        bigint;
  v_donations_total bigint;
  i            int;
  -- FIX-1028 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- FIX-1111 — a unit cap of 0 or less is meaningless; treat it as a caller bug
  -- rather than silently doing nothing forever on a */15 schedule.
  IF v_crawl AND p_max_units < 1 THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  -- ── Concurrency guard (session advisory lock; survives the COMMITs below) ───
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'skipped', now(), now(),
      jsonb_build_object(
        'mode', p_mode,
        'skip_reason', 'advisory lock held by a concurrent entity_connections rebuild',
        'source', 'pg_cron'
      )
    );
    RAISE NOTICE '[rebuild] advisory lock held — skipping (mode=%)', p_mode;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connections_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rebuild] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- ── FIX-1111 — the crawl gate ─────────────────────────────────────────────
  -- Crawl mode only: p_max_units IS NULL is byte-for-byte today's behaviour, so
  -- an operator's unbounded manual run is never blocked by a policy written for
  -- a */15 background job.
  --
  -- Placed AFTER the advisory-lock guard (so the unlock below is unconditional)
  -- and BEFORE the FEC interlock, because it is strictly cheaper: two
  -- pipeline_state reads and one indexed data_sync_log aggregate, against the
  -- interlock's pg_locks scan.
  --
  -- LOGGING ASYMMETRY, deliberate. Only `backoff` writes a data_sync_log row.
  -- At */15 a blackout or cooldown skip would write up to 96 rows a day saying
  -- "I did nothing, on purpose", drowning the very log that FIX-1107-class
  -- diagnosis is read from. Backoff is rare, means the box is throttled, and is
  -- exactly what you want to find in that log. The other two are counted in
  -- ec_crawl.skips and RAISEd, which is greppable without being noise.
  IF v_crawl THEN
    v_gate := public.ec_crawl_gate();
    IF NOT (v_gate->>'run')::boolean THEN
      IF v_gate->>'reason' = 'backoff' THEN
        INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
        VALUES (
          'entity_connections_rebuild', 'skipped', v_started, clock_timestamp(),
          jsonb_build_object(
            'mode',        p_mode,
            'source',      'pg_cron',
            'skip_reason', v_gate->>'detail',
            'crawl',       true,
            'max_units',   p_max_units,
            'gate',        v_gate));
      END IF;

      UPDATE public.pipeline_state
         SET value = value
                   || jsonb_build_object(
                        'skips',
                        COALESCE(value->'skips', '{}'::jsonb)
                        || jsonb_build_object(
                             v_gate->>'reason',
                             COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                             'last_skip_at',     clock_timestamp(),
                             'last_skip_reason', v_gate->>'reason')),
             updated_at = now()
       WHERE key = 'ec_crawl';

      RAISE NOTICE '[rebuild/crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;
  END IF;

  -- ── FIX-1101 — the widened FEC interlock ──────────────────────────────────
  -- Defers BEFORE the log row goes 'running', before the cursor read and before
  -- any cycle is opened, so a deferred firing leaves no state behind and the
  -- next firing is indistinguishable from a first one.
  --
  -- The status is its own value, 'deferred', not 'skipped': a skip means a peer
  -- rebuild is already doing this work, a defer means the work is deliberately
  -- postponed. Conflating them would make the two indistinguishable in exactly
  -- the log this line of work is diagnosed from.
  --
  -- Placed AFTER the advisory-lock guard, so at this point we HOLD the rebuild
  -- lock and the unlock below is both required and unconditional.
  --
  -- FIX-1111 — this is also the whole Monday fix. jobid 22 is retired by the
  -- crawl, and the weekly FIX-903 FEC replay now simply defers crawl firings
  -- while it holds the lock or leaves a run_state. When it clears, the crawl's
  -- next unit runs — and if the replay spent the day's I/O budget, that unit's
  -- DURATION says so and the sensor above backs off 2 h. No schedule arithmetic.
  v_interlock := public.fec_bulk_interlock_state();

  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'deferred', v_started, clock_timestamp(),
      jsonb_build_object(
        'mode',          p_mode,
        'source',        'pg_cron',
        'defer_reason',  v_interlock->>'reason',
        'fec_interlock', v_interlock)
    );
    RAISE WARNING '[rebuild] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- A stale marker does NOT defer, but it must not be silent either: a
  -- run_state that never clears would otherwise convert one bad run into an
  -- indefinitely skipped arm.
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[rebuild] fec_bulk_run_state present but STALE (%s old) — proceeding; the marker is stranded and wants investigating',
      v_interlock->>'run_state_age';
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer. FIX-1069 re-measured the same for a FUNCTION's
  -- proconfig on the plain SELECT path (the GUC does change inside the body; the
  -- timer does not re-arm) and REMOVED the decorative 45min/90min guards from
  -- the donations arm functions rather than leave them to mislead.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the repro
  -- paths exercise the SHIPPED code path rather than a test variant of it.
  SELECT GREATEST(interval '1 second', make_interval(secs => (value->>'seconds')::numeric))
    INTO c_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  c_budget := COALESCE(c_budget, c_budget_default);

  -- ── FIX-1056 — read the resume cursor BEFORE opening the log row ───────────
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;

  IF v_cursor IS NOT NULL
     AND v_cursor->>'mode' = p_mode
     AND (v_cursor->>'cycle_started_at')::timestamptz > now() - c_cycle_max_age
  THEN
    v_cycle_started := (v_cursor->>'cycle_started_at')::timestamptz;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[])
      INTO v_done_arms
      FROM jsonb_array_elements_text(COALESCE(v_cursor->'completed_arms', '[]'::jsonb)) x;
    v_resumed := COALESCE(array_length(v_done_arms, 1), 0) > 0;
    IF v_resumed THEN
      RAISE NOTICE '[rebuild] resuming cycle started % — % arm(s) already banked: %',
        v_cycle_started, array_length(v_done_arms, 1), array_to_string(v_done_arms, ', ');
    END IF;
  ELSE
    -- No cursor, wrong mode, or a cycle too old to trust: start fresh.
    v_cycle_started := v_started;
    v_done_arms     := ARRAY[]::text[];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object(
      'mode', p_mode,
      'source', 'pg_cron',
      'resumed', v_resumed,
      'cycle_started_at', v_cycle_started,
      'budget_seconds', round(EXTRACT(epoch FROM c_budget))::int,
      'arms_banked_on_entry', to_jsonb(v_done_arms),
      -- FIX-1111
      'crawl', v_crawl,
      'max_units', p_max_units
    )
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  IF NOT COALESCE(
       (SELECT (split_part(opt, '=', 2))::boolean
          FROM pg_catalog.pg_class c, unnest(c.reloptions) AS opt
         WHERE c.oid = 'public.entity_connections'::regclass
           AND opt LIKE 'autovacuum_enabled=%'),
       true
     ) THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE WARNING '[rebuild] startup reconcile: autovacuum was stranded OFF on entity_connections — re-enabled (FIX-885)';
  END IF;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ═══ DONATIONS ARM — 16 COMMITTED WINDOWS, BOTH MODES (FIX-703/FIX-1069) ═══
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint, so the
  -- CALL-level budget never becomes an atomic multi-hour txn.
  --
  -- FIX-1069 — this is the change that matters. Before it this whole block was
  -- gated on `IF v_full`, and BOTH scheduled jobs run mode='incremental', so on
  -- prod the windowed path was unreachable code while the incremental arm ran
  -- as one 6-hour statement that banked nothing and wrote nothing.
  --
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. reconcile_recipient_count() survives as a break-glass full
  -- recompute with NO caller and NO cron job (FIX-736 unscheduled it; the
  -- FIX-1056 comment correction records why that mattered).
  v_don_arm := CASE WHEN v_full THEN 'donations_full_windows' ELSE 'donations_incr_windows' END;

  IF NOT (v_don_arm = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();

    -- ── prepare ──────────────────────────────────────────────────────────────
    IF v_full THEN
      BEGIN
        PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donations prepare: %s', SQLERRM);
        RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;
    ELSE
      -- FIX-1069 — stages the dirty set ONCE per cycle and returns the cycle
      -- target. Free on resume: an open cycle whose staging table is still
      -- populated returns immediately without rebuilding anything.
      BEGIN
        v_incr_target := public.rebuild_ec_donations_incr_prepare();
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare CANCELED: %', SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;

      -- A NULL target means no watermark has ever been set. The incremental
      -- path only touches donors present in its dirty set, so it cannot clear
      -- an edge whose donor has vanished from financial_relationships; a true
      -- bootstrap must go through the full windowed path, which range-DELETEs.
      IF v_canceled IS NULL
         AND v_incr_target IS NULL
         AND COALESCE(array_length(v_failures, 1), 0) = 0
      THEN
        v_bootstrap := true;
        v_don_arm   := 'donations_full_windows';
        RAISE WARNING '  [donations/incr] no watermark — bootstrapping via the FULL windowed path';
        BEGIN
          PERFORM public.rebuild_ec_donations_full_prepare();
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations prepare: %s', SQLERRM);
          RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
        END;
        COMMIT;
      END IF;
    END IF;

    -- ── the 16 windows ───────────────────────────────────────────────────────
    v_donations_total := 0;
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        -- ── FIX-1111 — skip a banked window BEFORE spending a unit on it ─────
        -- rebuild_ec_donations_incr_window() already returns 0 immediately for a
        -- window level with the cycle target; this hoists that same check into
        -- the driver so an already-banked window does not consume the crawl's
        -- one unit. Without it, a crawl firing that met 15 banked windows would
        -- "run" window 1 in ~0 s, count it, and exit — livelock at one useless
        -- firing every 15 minutes forever.
        --
        -- Read-only and exactly the function's own predicate, so NULL-mode
        -- behaviour is unchanged: the call it replaces returned 0 anyway.
        IF NOT v_full AND NOT v_bootstrap THEN
          SELECT (value->'windows'->>(i - 1)::text)::timestamptz
            INTO v_win_since
            FROM public.pipeline_state
           WHERE key = 'entity_connections_donations';

          IF v_win_since IS NOT NULL AND v_win_since >= v_incr_target THEN
            RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', i;
            CONTINUE;
          END IF;
        END IF;

        -- ── FIX-1111 — the unit cap ─────────────────────────────────────────
        -- Checked AFTER the skip above, so the cap is only ever spent on a
        -- window that will do real work.
        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, i);
          RAISE NOTICE '  [donations] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          -- FIX-1069 — name the arm AND the window. The end-of-run lookup below
          -- only covers v_fns, which never contains the donations window arm.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        -- ── FIX-1101 — publish the in-flight window ────────────────────────
        -- Must be COMMITted before the window starts, or the watchdog — which
        -- runs in a different backend — cannot see it. FIX-1030's shape.
        -- clock_timestamp(), not now(): now() is transaction_timestamp() and
        -- would date the window to whenever this transaction began.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_inflight_key, jsonb_build_object(
                  'window_idx',  i,
                  'started_at',  clock_timestamp(),
                  'backend_pid', pg_backend_pid(),
                  'mode',        p_mode,
                  'log_id',      v_log_id))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now();
        COMMIT;

        v_unit_t0 := clock_timestamp();   -- FIX-1111
        v_win     := 0;                   -- FIX-1111 — so a cancel records 0 rows, not NULL

        BEGIN
          IF v_full OR v_bootstrap THEN
            v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          ELSE
            -- p_idx is 0-based, to match the window watermark keys "0".."15".
            v_win := public.rebuild_ec_donations_incr_window(i - 1, v_lo, v_hi, v_incr_target);
          END IF;
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        EXCEPTION
        -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error
        -- EXCEPT query_canceled and assert_failure.
        WHEN query_canceled THEN
          v_canceled := format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          -- FIX-1101 — name the arm AND the window, matching what the BUDGET
          -- exit above already does. Before this, a cancelled window closed the
          -- row with next_arm = 'donations_incr_windows' and the window index
          -- only in cancel_detail, so the two exit paths described the same
          -- situation differently and next_arm alone could not tell an operator
          -- where to resume. Now that FIX-1101's watchdog makes a per-window
          -- cancel a ROUTINE outcome rather than an incident, that asymmetry
          -- would be read every week.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
        WHEN OTHERS THEN
          -- Per-window catch: one bad window must not abort the rest; the run is
          -- reported `failed`.
          v_failures := v_failures || format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
        END;
        -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction —
        -- PL/pgSQL forbids COMMIT inside one). This is the point at which the
        -- window's edges AND, in incremental mode, its watermark become durable
        -- together. Neither can land without the other.
        COMMIT;

        -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────
        -- A CANCELLED window is still counted and still recorded. It spent the
        -- I/O either way, and a 1,800 s cancel against a ~346 s median is
        -- precisely the reading that should trip the backoff — that is the
        -- sensor working, not an edge case to exclude.
        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     CASE WHEN v_full OR v_bootstrap THEN 'donations_full_window'
                          ELSE 'donations_incr_window' END,
                     format('%s window %s/16', v_don_arm, i),
                     v_unit_secs, v_win,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled' ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          -- The sensor must never be able to fail the run it is measuring.
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;

        -- FIX-1111 — the sensor tripped. In crawl mode stop here and let the
        -- gate hold the next firings off; in NULL mode the backoff is RECORDED
        -- for the crawl to obey but does NOT change this run's behaviour, which
        -- is what "NULL = today's behaviour" has to mean.
        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    -- FIX-1111 — `AND NOT v_unit_capped` is load-bearing. Without it a crawl
    -- firing that ran ONE window would fall into this branch, and although
    -- rebuild_ec_donations_incr_close() correctly refuses to close a cycle
    -- whose windows still lag (FIX-1069c), the arm would still be appended to
    -- v_done_arms below — so the NEXT firing would skip the entire donations
    -- arm with 15 windows unbuilt. The cap exit is an incomplete pass and must
    -- be treated exactly like a budget exit.
    IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1069 — close the incremental cycle: drop the staging rows and set
      -- the scalar watermark. Returns false if any window still lags, which
      -- cannot happen on this branch but is checked rather than assumed.
      IF NOT v_full AND NOT v_bootstrap THEN
        BEGIN
          v_closed := public.rebuild_ec_donations_incr_close(v_incr_target);
          IF NOT v_closed THEN
            RAISE WARNING '  [donations/incr] cycle NOT closed — a window still lags the target';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations incr close: %s', SQLERRM);
          RAISE WARNING '  [donations/incr] close FAILED: %', SQLERRM;
        END;
      END IF;

      IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_done_arms := v_done_arms || v_don_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
      END IF;
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed, %) — % (% edges)',
      CASE WHEN v_full THEN 'full' WHEN v_bootstrap THEN 'bootstrap' ELSE 'incremental' END,
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
           WHEN v_unit_capped THEN 'UNIT CAP'
           WHEN v_canceled IS NOT NULL THEN 'CANCELED'
           ELSE 'complete' END,
      v_donations_total;
  ELSE
    RAISE NOTICE '  [chunk] donations (windowed) — SKIPPED (already banked this cycle)';
  END IF;

  -- ── Remaining chunks (external + investigation MUST stay last) ─────────────
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_votes_full',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  ELSE
    -- FIX-1069 — 'rebuild_entity_connections_donations' REMOVED. That entry is
    -- what routed the incremental donations arm through the generic
    -- single-statement EXECUTE below; it is now driven as 16 committed windows
    -- above. The function still exists as a break-glass single-shot.
    v_fns := ARRAY[
      'rebuild_entity_connections_votes',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  END IF;

  FOREACH v_fn IN ARRAY v_fns LOOP
    -- FIX-1028 — a cancel in the donations windows above skips the chunks too.
    EXIT WHEN v_canceled IS NOT NULL;
    -- FIX-1056 — and so does a budget exhaustion in those windows.
    EXIT WHEN v_budget_out;
    -- FIX-1111 — and so does a unit-cap or backoff exit. Placed BEFORE the
    -- banked-arm CONTINUE so v_next_arm keeps the window index the donations
    -- exit already wrote into it, rather than being overwritten with the first
    -- outstanding chunk arm.
    EXIT WHEN v_unit_capped;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- ── FIX-1117 — the source-change gate ───────────────────────────────────
    -- Placed AFTER the banked-arm skip and BEFORE the unit cap, for exactly the
    -- reason the banked-window skip sits before the window cap: a gated arm did
    -- no work, so it must not consume the firing's one unit. A cycle whose ten
    -- arms are all unchanged therefore finishes in ONE firing rather than ten,
    -- and that is most of the saving — the ring measured _external and
    -- _contracts rebuilding byte-identical row counts (2 x 574,209 and
    -- 3 x 189,949) for ~1,244 s of writer per cycle.
    --
    -- ⚠ FAIL OPEN. A NULL fingerprint — unknown arm, probe error, or no stored
    -- previous value — RUNS the arm. The only path that skips is "I measured
    -- this source before the last successful build, I measured it now, and the
    -- two are equal". A gate that can silently freeze an arm is the FIX-885
    -- stranded-flag class and is strictly worse than the waste it removes.
    v_fp      := NULL;
    v_fp_prev := NULL;
    v_fp_t0   := clock_timestamp();
    BEGIN
      v_fp := public.ec_arm_source_fingerprint(v_fn);
    EXCEPTION
    -- FIX-1028 — by name, and it earns its place here: the probe is a statement
    -- like any other, so the FIX-1063 watchdog can land on it, and OTHERS does
    -- not match query_canceled. Without this a cancelled probe would escape the
    -- procedure entirely and strand the log row 'running'.
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', v_fn, SQLERRM);
      v_next_arm := v_fn;
      RAISE WARNING '  [gate] % — fingerprint probe CANCELED: %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [gate] % — fingerprint probe FAILED (%) — running the arm', v_fn, SQLERRM;
      v_fp := NULL;
    END;
    EXIT WHEN v_canceled IS NOT NULL;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    -- ── FIX-1270 — a parked arm is skipped until its source moves ───────────
    -- Parked by the block after the unit record below, after two consecutive
    -- cancels. Skipped WITHOUT spending a unit and banked for the cycle — the
    -- gated-arm shape — so the cycle can close and the stats fingerprint can
    -- advance behind it. It stays parked until its fingerprint differs from the
    -- one it was parked on (cleared here, automatically) or an operator deletes
    -- pipeline_state.ec_arm_parked->'<arm>'. A NULL fingerprint on either side
    -- proves nothing, so it does not unpark: running it is what livelocked.
    v_park := NULL;
    SELECT value->v_fn INTO v_park FROM public.pipeline_state WHERE key = c_park_key;
    IF v_park IS NOT NULL THEN
      IF v_fp IS NOT NULL AND (v_park->>'fp') IS NOT NULL AND v_fp <> (v_park->>'fp') THEN
        UPDATE public.pipeline_state
           SET value = value - v_fn, updated_at = now()
         WHERE key = c_park_key;
        COMMIT;
        v_unparked_arms := v_unparked_arms || v_fn;
        RAISE WARNING '  [park] % — source changed since it was parked (% -> %); unparked, running it',
          v_fn, v_park->>'fp', v_fp;
      ELSE
        v_done_arms   := v_done_arms   || v_fn;
        v_parked_arms := v_parked_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);
        -- rows = 0 and seconds = the probe: unratable and far under the
        -- absolute trip, so the mark can never feed the backoff sensor.
        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)',
                                               v_fp_secs, 0, 'skipped_parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        RAISE WARNING '  [chunk] % — SKIPPED (parked since %: %); delete pipeline_state.ec_arm_parked->''%'' to retry it',
          v_fn, v_park->>'since', v_park->>'last_detail', v_fn;
        CONTINUE;
      END IF;
    END IF;

    IF v_fp IS NOT NULL THEN
      SELECT value->'arms'->v_fn->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_fp THEN
      -- Unchanged. Bank it for this cycle — an arm whose source did not move IS
      -- built, and refusing to bank it would stop the cycle ever closing — then
      -- carry straight on to the next arm without spending a unit.
      v_done_arms  := v_done_arms  || v_fn;
      v_gated_arms := v_gated_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);

      -- The ring gets a "skipped_unchanged" mark so the lag metric can tell an
      -- IDLE arm from a GATED one. rows = 0 makes the entry unratable under
      -- FIX-1111b (rate is NULL below backoff_min_rows), so it is excluded from
      -- the median rate by construction and cannot drag down the baseline the
      -- next REAL run of this class is judged against. That property is why the
      -- mark can live in the same ring rather than needing a second one.
      BEGIN
        v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      RAISE NOTICE '  [chunk] % — SKIPPED (source unchanged since last build: %)', v_fn, v_fp;
      CONTINUE;
    END IF;

    -- FIX-1111 — the unit cap, after the banked-arm skip for the same reason
    -- the window cap sits after the banked-window skip: a cap must only ever be
    -- spent on work that will actually run.
    IF v_crawl AND v_units_run >= p_max_units THEN
      v_unit_capped := true;
      v_next_arm    := v_fn;
      RAISE NOTICE '  [chunk] % — UNIT CAP reached (% unit(s)); banking and exiting', v_fn, v_units_run;
      EXIT;
    END IF;

    -- FIX-1056 — stop BEFORE starting an arm the budget cannot cover, so the
    -- exit lands on an arm boundary with the cursor and the log row intact
    -- rather than being cancelled mid-statement by the 6h axe.
    IF clock_timestamp() - v_started >= c_budget THEN
      v_budget_out := true;
      v_next_arm   := v_fn;
      RAISE WARNING '  [chunk] % — BUDGET EXHAUSTED (%s elapsed); banking % arm(s) and exiting',
        v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
        COALESCE(array_length(v_done_arms, 1), 0);
      EXIT;
    END IF;

    v_arm_started := clock_timestamp();
    v_arm_failed  := false;
    v_n           := 0;   -- FIX-1111 — so a cancelled arm records 0 rows, not NULL
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION
    -- FIX-1028 — by name; see the donations handler above.
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — CANCELED (statement_timeout or operator cancel): %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      v_arm_failed := true;
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;

    -- FIX-1056 — per-arm elapsed, recorded for EVERY outcome. This is the
    -- observability gap that let the 08-17 overrun be attributed to the arm the
    -- axe hit rather than the arm that spent the hours.
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank the arm only if it neither cancelled nor raised. A
    -- cancelled arm rolled back, so re-running it next firing is exactly right.
    IF v_canceled IS NULL AND NOT v_arm_failed THEN
      v_done_arms := v_done_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();

      -- ── FIX-1117 — store the fingerprint this build CONSUMED ──────────────
      -- v_fp was captured BEFORE the arm ran. Re-reading the source here would
      -- mark any write that landed DURING the run as already consumed and gate
      -- it away forever; storing the pre-run value means such a write is seen
      -- next cycle and the arm runs again. Conservative in the only safe
      -- direction. Merged key-wise rather than jsonb_set()-ed, so a registry row
      -- that somehow lacks the 'arms' object still gets written correctly.
      IF v_fp IS NOT NULL THEN
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_fp_key, jsonb_build_object('arms',
                  jsonb_build_object(v_fn,
                    jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb)
                      || jsonb_build_object('arms',
                           COALESCE(ps.value->'arms', '{}'::jsonb)
                           || jsonb_build_object(v_fn,
                                jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))),
              updated_at = now();
      END IF;
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────────
    v_units_run := v_units_run + 1;
    v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_arm_started));
    BEGIN
      v_rec := public.ec_crawl_record_unit(
                 v_fn, v_fn, v_unit_secs, v_n,
                 CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                      WHEN v_arm_failed          THEN 'failed'
                      ELSE 'ok' END);
      IF (v_rec->>'backoff_set')::boolean THEN
        v_backoff_set := true;
      END IF;
      v_unit_log := v_unit_log || jsonb_build_array(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
    END;
    COMMIT;

    -- ── FIX-1270 — the second consecutive cancel parks the arm ─────────────
    -- A generic arm is ONE statement: a cancel rolls it back whole and banks
    -- nothing, the unit record above trips the 2 h backoff (seconds >= 1500),
    -- and before this the next firing retried the SAME arm into the same wall —
    -- every 2 h, forever, with the cycle never closing (census 2026-10-04
    -- §2.6 item 6; _contracts 2026-08-31, 1,878 s, 0 rows). Read the ring: if
    -- this arm's last two entries — real runs plus its '(parked)' marks, which
    -- break the chain so an unparked arm gets two fresh tries — are both
    -- 'canceled', park it, bank it for the cycle, clear the cancel and carry on
    -- to the next arm instead of EXITing. The first cancel still EXITs exactly
    -- as before. If the record above failed there is no ring entry, no park,
    -- and the old behaviour.
    IF v_canceled IS NOT NULL THEN
      SELECT array_agg(t.outcome ORDER BY t.ord DESC) INTO v_last_two
        FROM (SELECT u.value->>'outcome' AS outcome, u.ord
                FROM public.pipeline_state ps,
                     jsonb_array_elements(COALESCE(ps.value->'recent_units', '[]'::jsonb))
                       WITH ORDINALITY AS u(value, ord)
               WHERE ps.key = 'ec_crawl'
                 AND u.value->>'unit' IN (v_fn, v_fn || ' (parked)')
               ORDER BY u.ord DESC
               LIMIT 2) t;

      IF COALESCE(array_length(v_last_two, 1), 0) = 2
         AND v_last_two[1] = 'canceled' AND v_last_two[2] = 'canceled' THEN
        v_parked_now    := v_fn;
        v_parked_detail := v_canceled;
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_park_key, jsonb_build_object(v_fn, jsonb_build_object(
                  'since',       clock_timestamp(),
                  'cancels',     2,
                  'last_detail', v_canceled,
                  'fp',          v_fp,
                  'log_id',      v_log_id)))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb) || EXCLUDED.value,
              updated_at = now();

        v_done_arms := v_done_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)', 0, 0, 'parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        v_parked_arms := v_parked_arms || v_fn;
        v_canceled    := NULL;
        RAISE WARNING '  [park] % — PARKED after 2 consecutive cancels; the cycle carries on without it: %',
          v_fn, v_parked_detail;
      END IF;
    END IF;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;

    -- FIX-1111 — sensor tripped; crawl mode stops, NULL mode carries on.
    IF v_crawl AND v_backoff_set THEN
      v_unit_capped := true;
      EXIT;
    END IF;
  END LOOP;

  -- ═══ EC STATS ARM — 16 BOUNDED, GATED WINDOWS (FIX-1115) ═══════════════════
  -- LAST in the cycle by construction: it aggregates entity_connections, so it
  -- has to run after every arm that writes edges — including _external and
  -- _investigation, which are themselves pinned last.
  --
  -- Shaped exactly like the donations windows above, and for the same reasons:
  -- one window is one unit, each window COMMITs, an already-banked window is
  -- skipped WITHOUT spending a unit (or a firing that met 15 banked windows
  -- would "run" window 1 in ~0 s and livelock at one useless firing every 15
  -- minutes), and per-window progress is durable so a cancel loses at most one
  -- window.
  --
  -- THE STALENESS THIS CLEARS: entity_connection_stats_mv last rebuilt
  -- successfully 2026-08-05 while the crawl writes edges continuously, so the
  -- first gated pass is a full 16-window backfill of three weeks of drift. At
  -- one unit per */15 firing that is ~4 h of wall clock, paced under the same
  -- sensor and blackout as everything else — which is the entire point of doing
  -- it here rather than in a 6-hour cron job.
  IF c_stats_arm = ANY(v_done_arms) THEN
    RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', c_stats_arm;
  ELSIF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped THEN
    v_arm_started := clock_timestamp();

    -- ── the FIX-1117 gate, over entity_connections itself ───────────────────
    v_fp_t0    := clock_timestamp();
    v_stats_fp := NULL;
    BEGIN
      v_stats_fp := public.ec_arm_source_fingerprint(c_stats_arm);
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', c_stats_arm, SQLERRM);
      v_next_arm := c_stats_arm;
      RAISE WARNING '  [ec-stats] fingerprint probe CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [ec-stats] fingerprint probe FAILED (%) — running the arm', SQLERRM;
      v_stats_fp := NULL;
    END;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    v_fp_prev := NULL;
    IF v_canceled IS NULL AND v_stats_fp IS NOT NULL THEN
      SELECT value->'arms'->c_stats_arm->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_canceled IS NOT NULL THEN
      NULL;   -- fall through to the terminal bookkeeping below

    ELSIF v_stats_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_stats_fp THEN
      -- No edge has been written since the last successful stats build. Bank the
      -- arm and move on without spending a unit. On a day where the gate above
      -- also silenced the ten source arms, this is the whole cycle costing
      -- nothing but probes.
      v_done_arms  := v_done_arms  || c_stats_arm;
      v_gated_arms := v_gated_arms || c_stats_arm;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_stats_key;
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(c_stats_arm, round(v_fp_secs)::int);
      BEGIN
        v_rec := public.ec_crawl_record_unit(c_stats_arm, c_stats_arm || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;
      RAISE NOTICE '  [chunk] % — SKIPPED (entity_connections unchanged since last build: %)',
        c_stats_arm, v_stats_fp;

    ELSE
      -- ── resume this cycle's per-window progress ──────────────────────────
      SELECT value INTO v_stats_prog FROM public.pipeline_state WHERE key = c_stats_key;
      IF v_stats_prog IS NOT NULL
         AND (v_stats_prog->>'cycle_started_at')::timestamptz = v_cycle_started
      THEN
        SELECT COALESCE(array_agg(x::int), ARRAY[]::int[])
          INTO v_stats_done
          FROM jsonb_array_elements_text(COALESCE(v_stats_prog->'done', '[]'::jsonb)) x;
        -- Keep the fingerprint the FIRST firing of this arm captured. A pass
        -- that spans four hours of firings must record what it actually
        -- consumed, not a value re-read at the end with edges written between.
        v_stats_fp := COALESCE(v_stats_prog->>'fp', v_stats_fp);
        IF COALESCE(array_length(v_stats_done, 1), 0) > 0 THEN
          RAISE NOTICE '  [ec-stats] resuming — %/16 window(s) already banked this cycle',
            array_length(v_stats_done, 1);
        END IF;
      ELSE
        v_stats_done := ARRAY[]::int[];
      END IF;

      FOR i IN 1..16 LOOP
        -- Banked window: skip BEFORE the cap, never spending a unit on a no-op.
        IF (i - 1) = ANY(v_stats_done) THEN
          RAISE NOTICE '    [ec-stats] window %/16 — SKIPPED (already banked this cycle)', i;
          CONTINUE;
        END IF;

        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, i);
          RAISE NOTICE '  [ec-stats] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          v_next_arm   := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        v_unit_t0    := clock_timestamp();
        v_n          := 0;   -- so a cancelled window records 0 rows, not NULL
        v_arm_failed := false;
        BEGIN
          v_stats_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
          v_n         := (v_stats_res->>'upserted')::bigint + (v_stats_res->>'deleted')::bigint;
          v_stats_ups := v_stats_ups + (v_stats_res->>'upserted')::bigint;
          v_stats_del := v_stats_del + (v_stats_res->>'deleted')::bigint;

          -- The window's rows and the window's progress become durable in the
          -- SAME transaction. FIX-1112's rule in its strongest form: there is no
          -- ratchet to lose, because the progress marker IS part of the chunk.
          INSERT INTO public.pipeline_state (key, value)
          VALUES (c_stats_key, jsonb_build_object(
                    'cycle_started_at', v_cycle_started,
                    'done',             to_jsonb(v_stats_done || (i - 1)),
                    'fp',               v_stats_fp))
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now();

          RAISE NOTICE '    [ec-stats] window %/16 [%..%) — % upserted, % deleted, % groups',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'),
            v_stats_res->>'upserted', v_stats_res->>'deleted', v_stats_res->>'groups';
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('%s window %s/16: %s', c_stats_arm, i, SQLERRM);
          v_next_arm := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_arm_failed := true;
          v_failures := v_failures || format('%s window %s: %s', c_stats_arm, i, SQLERRM);
          RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;

        -- Claim the window only once its transaction actually committed.
        -- PL/pgSQL variables are NOT rolled back by a subtransaction abort, so
        -- appending inside the block above would let a failed INSERT leave this
        -- array claiming a window that never banked.
        IF v_canceled IS NULL AND NOT v_arm_failed THEN
          v_stats_done := v_stats_done || (i - 1);
        END IF;

        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     'entity_connection_stats_window',
                     format('%s window %s/16', c_stats_arm, i),
                     v_unit_secs, v_n,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                          WHEN v_arm_failed          THEN 'failed'
                          ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        EXIT WHEN v_canceled IS NOT NULL;

        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_stats_ups + v_stats_del;
      v_arm_timings := v_arm_timings || jsonb_build_object(
        c_stats_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

      -- Bank the ARM only on a clean, complete pass over all sixteen windows —
      -- the same "AND NOT v_unit_capped" discipline the donations arm needs, and
      -- for the same reason: a cap exit is an INCOMPLETE pass, and banking it
      -- would make the next firing skip the whole arm with windows unbuilt.
      IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
         AND COALESCE(array_length(v_failures, 1), 0) = 0
         AND COALESCE(array_length(v_stats_done, 1), 0) = 16
      THEN
        v_done_arms := v_done_arms || c_stats_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();

        IF v_stats_fp IS NOT NULL THEN
          INSERT INTO public.pipeline_state AS ps (key, value)
          VALUES (c_fp_key, jsonb_build_object('arms',
                    jsonb_build_object(c_stats_arm,
                      jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))))
          ON CONFLICT (key) DO UPDATE
            SET value = COALESCE(ps.value, '{}'::jsonb)
                        || jsonb_build_object('arms',
                             COALESCE(ps.value->'arms', '{}'::jsonb)
                             || jsonb_build_object(c_stats_arm,
                                  jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))),
                updated_at = now();
        END IF;

        DELETE FROM public.pipeline_state WHERE key = c_stats_key;
        COMMIT;
      END IF;

      RAISE NOTICE '  [chunk] % — % (% upserted, % deleted)', c_stats_arm,
        CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
             WHEN v_unit_capped THEN 'UNIT CAP'
             WHEN v_canceled IS NOT NULL THEN 'CANCELED'
             ELSE 'complete' END,
        v_stats_ups, v_stats_del;
    END IF;
  END IF;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;

  -- ── FIX-1056 — cycle bookkeeping ───────────────────────────────────────────
  -- FIX-1069 — the donations WINDOW arm is in v_fns in neither mode, so it has
  -- to be named explicitly here. Without this, a run whose donations windows
  -- never banked could compute v_next_arm = NULL and sit one gate away from
  -- reporting 'complete'. Only computed when nothing already claimed it — a
  -- budget exit sets it with the window index attached.
  IF v_next_arm IS NULL THEN
    IF NOT (v_don_arm = ANY(v_done_arms)) THEN
      v_next_arm := v_don_arm;
    ELSE
      -- WITH ORDINALITY because unnest() ordering is not contractually
      -- guaranteed and "first outstanding arm" has to mean first in ARM ORDER,
      -- not first returned.
      SELECT f INTO v_next_arm
        FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
       WHERE NOT (u.f = ANY(v_done_arms))
       ORDER BY u.ord
       LIMIT 1;
    END IF;
    -- FIX-1115 — the stats arm is not a member of v_fns either, and it is LAST,
    -- so it is only the outstanding arm once every other one has banked.
    IF v_next_arm IS NULL AND NOT (c_stats_arm = ANY(v_done_arms)) THEN
      v_next_arm := c_stats_arm;
    END IF;
  END IF;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: the donations windows can fail
    -- without being banked while every v_fns arm succeeds, which would
    -- otherwise clear the cursor on a run that still owes work. Leaving the
    -- cursor is safe either way — each arm is an idempotent DELETE-then-INSERT
    -- over its own connection_type — but clearing it on a failed pass would
    -- throw away the record of what still needs redoing.
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    v_cycle_closed := true;
    -- FIX-1115 — belt-and-braces: the stats arm clears this itself when it
    -- banks, but a cycle can close having GATED the arm on a firing where the
    -- key was already gone, and a stale key carrying a dead cycle_started_at
    -- would otherwise sit here until the next stats pass ignored it.
    DELETE FROM public.pipeline_state WHERE key = c_stats_key;
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── FIX-1101 — the belt-and-braces clear (playbook C3) ────────────────────
  -- Unconditional, and NOT gated on this run having published anything: this is
  -- the "put it where it can FIRE" backstop, and it must be able to clean up
  -- state this run did not create. Reached on every software exit from the
  -- procedure — convergence, budget exit, a caught cancel, per-arm failures.
  -- Only a hard terminate or a crash skips it, and that case is the watchdog's.
  DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
  COMMIT;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        -- FIX-1270 — so is the firing that PARKS an arm: its
                        -- edges are stale until the park clears. Only that
                        -- firing; a later one that skips the parked arm is
                        -- judged on its own outcome and lists it in parked_arms.
                        WHEN v_parked_now IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        -- FIX-1111 — so is a unit-cap exit, and it is the crawl's
                        -- NORMAL outcome rather than an incident. It must still be
                        -- 'partial' (work remains), but `unit_capped` in metadata
                        -- is what distinguishes ~96 routine crawl exits a day from
                        -- the budget exhaustions FIX-969 counts.
                        WHEN v_unit_capped THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        -- FIX-1056 — arms left unrun without a cancel or a budget
                        -- exit can only mean a failure skipped them; never claim
                        -- 'complete' while v_next_arm is non-NULL.
                        WHEN v_next_arm IS NOT NULL THEN 'partial'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      -- FIX-1270 — a park leads the message; whatever else ended the run
      -- follows it (concat_ws skips the NULL side).
      error_message = left(concat_ws('; ',
                        CASE WHEN v_parked_now IS NOT NULL
                             THEN format('arm parked after 2 consecutive cancels: %s (%s)',
                                         v_parked_now, v_parked_detail) END,
                      CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +2 on the arm count: the donations window arm and
                          -- (FIX-1115) the stats window arm are both bankable
                          -- but neither is a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 2), 1000)
                        -- FIX-1111 — an ORDERLY, expected stop. Worded so it can
                        -- never be mistaken for a budget blowout in a grep.
                        WHEN v_unit_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s; resumable at arm %s',
                                 v_units_run,
                                 CASE WHEN v_backoff_set THEN ' then BACKOFF tripped' ELSE '' END,
                                 COALESCE(v_next_arm, '?')), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END), 1000),
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- FIX-1056
                        'budget_exhausted', v_budget_out,
                        'arm_timings', v_arm_timings,
                        'arms_banked', to_jsonb(v_done_arms),
                        'next_arm', v_next_arm,
                        'cycle_started_at', v_cycle_started,
                        -- FIX-1069 — the donations cycle target this run drove
                        -- its windows toward, so a partial run's remaining work
                        -- is readable from the log row alone.
                        'donations_target_at', v_incr_target,
                        'donations_bootstrap', v_bootstrap,
                        -- FIX-1111
                        'crawl', v_crawl,
                        'max_units', p_max_units,
                        'units_run', v_units_run,
                        'unit_capped', v_unit_capped,
                        'backoff_tripped', v_backoff_set,
                        'units', v_unit_log,
                        -- FIX-1115
                        'stats_upserted', v_stats_ups,
                        'stats_deleted', v_stats_del,
                        -- FIX-1117 — which arms this firing skipped as unchanged.
                        -- Distinguishable from an idle arm, which simply never
                        -- appears, and from a banked one, which is in arms_banked
                        -- without being here.
                        'gated_arms', to_jsonb(v_gated_arms),
                        'gated_count', COALESCE(array_length(v_gated_arms, 1), 0),
                        -- FIX-1270 — parked_arms: parked by this firing or
                        -- skipped by it as parked; parked_now: the one this
                        -- firing parked; unparked_arms: cleared because their
                        -- source moved. Absent from the log = nothing parked.
                        'parked_arms', to_jsonb(v_parked_arms),
                        'parked_now', v_parked_now,
                        'parked_detail', v_parked_detail,
                        'unparked_arms', to_jsonb(v_unparked_arms)
                      )
  WHERE id = v_log_id;
  -- FIX-1330 (cc-243): a cycle-closing COMPLETE row reports its own next-due
  -- (crawl_gate's cycle_cooldown clock: complete rows, min_cycle_interval_minutes).
  UPDATE public.data_sync_log l
     SET metadata = l.metadata || jsonb_build_object('next_due_at', clock_timestamp() + make_interval(mins => c.gap))
    FROM (SELECT COALESCE((value->>'min_cycle_interval_minutes')::int, 0) AS gap
            FROM public.pipeline_state WHERE key = 'ec_crawl') c
   WHERE v_cycle_closed AND l.id = v_log_id AND l.status = 'complete' AND c.gap > 0;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, % unit(s), next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN v_unit_capped THEN 'UNIT CAP'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), v_units_run, COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.run_entity_connections_rebuild(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text, integer) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- (f) the data edits — each matched on its exact old value (idempotent)
-- ═══════════════════════════════════════════════════════════════════════════

DO $fix1336_data$
DECLARE
  n int;
BEGIN
  -- N2: the nightly START is a dispatched unit.
  UPDATE public.job_registry
     SET deadline_rule     = 'by 0 21 * * *',
         by_window_minutes = 120,
         idempotent_refire = true,
         note              = note || '; N2 (cc-243, FIX-1336) from at 0 21 * * *: by 0 21 * * * window 120 min, '
                                     'fired via the gha-dispatch request stamp',
         updated_at        = now()
   WHERE job = 'nightly' AND deadline_rule = 'at 0 21 * * *';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[fix1336] nightly row: % (by 0 21 * * * window 120)', CASE WHEN n = 1 THEN 'updated' ELSE 'already' END;

  -- FIX-1124 part 2 + FIX-1331: the crawls lose the blackout gate and yield in the pick.
  UPDATE public.job_registry
     SET gates              = '{prod_session}',
         yield_to           = '{rule-taggers-daily,refresh-derived-mvs-daily}',
         yield_lead_seconds = 1800,
         note               = note || '; FIX-1124 part 2 + FIX-1331 (cc-243): blackout gate retired; yield_to '
                                      'rule-taggers-daily, refresh-derived-mvs-daily lead 1800 s in the pick',
         updated_at         = now()
   WHERE job IN ('ec-crawl', 'fe-crawl') AND gates = '{prod_session,blackout}';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[fix1336] crawl rows: % updated (% already)', n, 2 - n;

  -- FIX-1124 part 2: the blackout window retires (the key stays, an operator override).
  UPDATE public.pipeline_state
     SET value = jsonb_set(value, '{blackout}', '[]'::jsonb), updated_at = now()
   WHERE key = 'ec_crawl' AND value->'blackout' = '[{"from": "05:45", "to": "09:00"}]'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[fix1336] ec_crawl.blackout: %', CASE WHEN n = 1 THEN 'set []' ELSE 'already' END;

  -- FIX-1331: crawl_gate's peer_* branches go inert (the pick owns the yield).
  UPDATE public.pipeline_state
     SET value = jsonb_set(value, '{yield_to}', '[]'::jsonb), updated_at = now()
   WHERE key IN ('ec_crawl', 'fe_crawl')
     AND value->'yield_to' = '[{"job": "refresh-derived-mvs-daily", "lead_s": 1800, "pipeline": "refresh_derived_mvs"},
                               {"job": "rule-taggers-daily", "lead_s": 1800, "pipeline": "run_rule_taggers"}]'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[fix1336] crawl config yield_to: % set [] (% already)', n, 2 - n;
END $fix1336_data$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (g) read-back — RAISE on any miss; print the new md5s
-- ═══════════════════════════════════════════════════════════════════════════

DO $fix1336$
DECLARE
  v_missing  text[] := '{}';
  v_reg      jsonb;
  v_pg_elig  int;
  v_gate     jsonb;
  v_src      text;
  v_md5_d    text;
  v_md5_g    text;
  v_md5_p    text;
  v_md5_e    text;
BEGIN
  -- the columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'job_registry' AND column_name = 'by_window_minutes' AND data_type = 'integer') THEN
    v_missing := v_missing || 'job_registry.by_window_minutes int';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'job_registry' AND column_name = 'yield_to' AND udt_name = '_text'
                  AND is_nullable = 'NO') THEN
    v_missing := v_missing || 'job_registry.yield_to text[] NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'job_registry' AND column_name = 'yield_lead_seconds' AND data_type = 'integer'
                  AND is_nullable = 'NO') THEN
    v_missing := v_missing || 'job_registry.yield_lead_seconds int NOT NULL';
  END IF;

  -- the nightly row
  IF NOT EXISTS (SELECT 1 FROM public.job_registry WHERE job = 'nightly' AND deadline_rule = 'by 0 21 * * *'
                    AND by_window_minutes = 120 AND gates = '{prod_session}' AND idempotent_refire
                    AND runner = 'github_actions' AND unit_call = 'gha-dispatch:nightly') THEN
    v_missing := v_missing || 'nightly row by 0 21 * * * / window 120 / {prod_session} / idempotent_refire';
  END IF;
  -- eligible = the pg_cron rows + exactly ONE github_actions row (the nightly)
  v_reg := public.get_dispatcher_status()->'registry';
  SELECT count(*) INTO v_pg_elig FROM public.job_registry
   WHERE runner = 'pg_cron' AND deadline_rule NOT LIKE 'at %';
  IF (v_reg->>'eligible')::int IS DISTINCT FROM v_pg_elig + 1 THEN
    v_missing := v_missing || format('registry.eligible %s <> pg_cron %s + 1', v_reg->>'eligible', v_pg_elig);
  END IF;
  -- the crawl rows
  IF (SELECT count(*) FROM public.job_registry WHERE job IN ('ec-crawl', 'fe-crawl') AND gates = '{prod_session}'
         AND yield_to = '{rule-taggers-daily,refresh-derived-mvs-daily}' AND yield_lead_seconds = 1800) <> 2 THEN
    v_missing := v_missing || 'ec-crawl / fe-crawl gates {prod_session}, yield_to the two dailies, lead 1800';
  END IF;
  -- the blackout is retired, and the crawls' own yield is inert
  IF public.in_blackout('ec_crawl', '2026-10-23 06:00Z') THEN
    v_missing := v_missing || 'in_blackout(ec_crawl, 10-23 06:00Z) still true';
  END IF;
  v_gate := public.prod_op_gate(600, '2026-10-23 06:00:00Z');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_gate->'blocked_by', '[]'::jsonb)) b
              WHERE b->>'name' = 'blackout') THEN
    v_missing := v_missing || 'prod_op_gate(600, 10-23 06:00Z) still blocked_by blackout';
  END IF;
  IF (SELECT value->'yield_to' FROM public.pipeline_state WHERE key = 'ec_crawl') IS DISTINCT FROM '[]'::jsonb
     OR (SELECT value->'yield_to' FROM public.pipeline_state WHERE key = 'fe_crawl') IS DISTINCT FROM '[]'::jsonb THEN
    v_missing := v_missing || 'ec_crawl / fe_crawl yield_to = []';
  END IF;
  -- the consume function and its grant
  IF to_regprocedure('public.consume_gha_dispatch_request(text,text,integer)') IS NULL
     OR NOT has_function_privilege('service_role', 'public.consume_gha_dispatch_request(text,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.consume_gha_dispatch_request(text,text,integer)', 'EXECUTE') THEN
    v_missing := v_missing || 'consume_gha_dispatch_request(text,text,integer), service_role only';
  END IF;

  -- the bodies carry the hunks and moved
  SELECT md5(prosrc), prosrc INTO v_md5_d, v_src FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%gha_dispatch_request_%' OR v_src NOT LIKE '%by_window_minutes%'
     OR v_src NOT LIKE '%yield: %s live%' OR v_src NOT LIKE '%next_due_at%' OR v_src NOT LIKE '%swept %s hold(s)%' THEN
    v_missing := v_missing || 'dispatch_one_unit carries the N2 hunks';
  END IF;
  IF v_md5_d IS NULL OR v_md5_d = 'cfc9ed48517cd7de6fa76cf807dd1f37' THEN
    v_missing := v_missing || 'dispatch_one_unit body replaced (still B1)';
  END IF;
  SELECT md5(prosrc), prosrc INTO v_md5_g, v_src FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%gha_dispatch_request_%' OR v_md5_g IS NULL OR v_md5_g = '1cf4b7745f4c89ce978935648c87c92b' THEN
    v_missing := v_missing || 'get_dispatcher_status body replaced with the GHA live rows';
  END IF;
  SELECT md5(prosrc), prosrc INTO v_md5_p, v_src FROM pg_proc
   WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%c_blackout_from%' OR v_src NOT LIKE '%none (FIX-1124 part 2)%' THEN
    v_missing := v_missing || 'prod_op_gate: the blackout constants gone, an empty array is no window';
  END IF;
  SELECT md5(prosrc), prosrc INTO v_md5_e, v_src FROM pg_proc
   WHERE proname = 'run_entity_connections_rebuild' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%next_due_at%' OR v_src NOT LIKE '%v_cycle_closed := true;%' THEN
    v_missing := v_missing || 'run_entity_connections_rebuild writes next_due_at on the cycle-closing unit';
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1336] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1336] read-back ok: nightly by 0 21 * * * window 120; registry %; crawls {prod_session} yield_to the two dailies lead 1800; blackout [] (in_blackout false, prod_op_gate no c); crawl yield_to []; consume_gha_dispatch_request', v_reg;
  RAISE NOTICE '[fix1336] md5 dispatch_one_unit % / get_dispatcher_status %', v_md5_d, v_md5_g;
  RAISE NOTICE '[fix1336] md5 prod_op_gate % / run_entity_connections_rebuild %', v_md5_p, v_md5_e;
END $fix1336$;
