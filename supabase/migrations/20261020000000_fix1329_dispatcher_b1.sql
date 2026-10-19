-- =============================================================================
-- FIX-1322, FIX-1323, FIX-1326, FIX-1329, FIX-1333, FIX-1332 — dispatcher B1:
-- the first change to the pick's BODY since M1 (20261016230000). Six small
-- hunks in dispatch_one_unit, one key in get_dispatcher_status, two slot
-- functions, three columns. cc-239, 2026-10-20.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) dispatch_log.excluded text[] FIRST, then job_registry.phase_lock
--       boolean NOT NULL DEFAULT false + job_registry.phase_due_at timestamptz.
--       dispatch_log before job_registry: a tick reads dispatch_log (step 3,
--       the reap) before job_registry (step 5, the census), and this file
--       takes them in the same order so it cannot deadlock with a tick in
--       flight.
--   (2) public.cron_next_slot(text, timestamptz) — the first slot >= p_now —
--       and public.cron_prev_slot(text, timestamptz) — the newest slot <=
--       p_now. Exactly three forms, UTC, NULL on anything else (fail-closed):
--         daily    M H * * *      weekly  M H * * D (one day-of-week 0–6)
--         monthly  M H D * *      (one day-of-month 1–28)
--       minute <= 59, hour <= 23. Lists (0 9,12), ranges and */N stay
--       unsupported. LANGUAGE sql, STABLE, no SET clause. Every cast sits
--       behind a nested CASE whose WHEN folds to a constant for a constant
--       schedule, so a refused form is never cast at plan time.
--       cron_next_daily() (20261004075000, read by crawl_gate's peer_due)
--       becomes a wrapper over cron_next_slot() for the daily form only; its
--       header (STABLE, SECURITY INVOKER, search_path, the p_now default) is
--       unchanged.
--   (3) dispatch_one_unit(text) — CREATE OR REPLACE from 20261016230000's text
--       VERBATIM (prosrc md5 98660b34c17c5c537fc3d2e03d021440 = prod at cc-239
--       read 3) plus these hunks only:
--         D-a FIX-1322  step 5: v_vacuum_live, once per tick — a VACUUM in
--                       pg_stat_progress_vacuum for this database (autovacuum
--                       included) → 'vacuum:<relname>', else an armed one-shot
--                       not yet reaped whose registry unit_call is a VACUUM →
--                       its job. Step 6 chain: a `bare` row whose unit_call is
--                       a VACUUM is excluded `io: vacuum live (<occupant>)`,
--                       after `live` and before `group busy`. cost_class stays
--                       unread (fe-crawl is `io` and must not wait on a
--                       vacuum); a CALL row is never excluded by it.
--         D-b FIX-1323  the phase lock, a PER-ROW opt-in. For a phase_lock row
--                       with a recorded phase_due_at whose last advancing unit
--                       STARTED in [phase_due_at, phase_due_at + 4 ticks) —
--                       on time: due → the next odd tick <= 2 min → +2 min to
--                       the one-shot, +2 more on a :15/:45 skip <= 6 min — the
--                       stale_after deadline and the dead_tuples floor anchor
--                       to phase_due_at + interval, not to the unit's end. The
--                       start is a pipeline's newest complete|partial row (the
--                       row v_last came from) or a bare row's newest `reaped
--                       succeeded` one-shot's armed_for, read only for a
--                       locked row with a due. ARM writes phase_due_at = now +
--                       ttd for a locked row armed from its stale_after or
--                       floor term, NULL for every other arm (pct, a NULL
--                       anchor, by, phase_lock false), and only on change — an
--                       unlocked row's arm writes nothing. A late unit (gated
--                       for hours, a pct firing) is not on time → fixed-delay
--                       from its end, then re-locks; no double-run by
--                       construction.
--         D-c FIX-1326  a dead_tuples floor with no anchor (no last_vacuum, no
--                       last_autovacuum, no reaped succeeded row) is DUE
--                       (-1 second), as a stale_after with no v_last is.
--         D-d FIX-1329  the by branch reads cron_prev_slot / cron_next_slot:
--                       due at the previous slot when nothing completed since
--                       it, else at the next. I3 unchanged in meaning; the
--                       `- interval '1 day'` shortcut goes.
--         D-e FIX-1333  every DUE row that is not the picked row → v_excluded:
--                       `<reason> (<job>)` when blocked, `queued (<job>)` when
--                       merely outranked. The final INSERT writes it (NULL when
--                       empty). `reason` keeps the single best-ranked blocker.
--         D-f FIX-1332  the I6 cooldown honours a pipeline unit's own
--                       metadata->'gate'->>'backoff_until' (crawl_gate's
--                       backoff / peer_backoff exits WRITE it — 20260911000200
--                       :1357-1363, 20261009030000:263-276): the newest
--                       `skipped` row since the last advance carries one →
--                       re-arm at GREATEST(that + 60 s, now), reason `backoff:
--                       <job> (unit says until <t>; <n> non-advancing
--                       reap(s))`, the ladder not consulted. One indexed read,
--                       only for a due pipeline row with >= 1 non-advancing
--                       reap — zero on a quiet tick.
--   (4) get_dispatcher_status() — M1's text + `last_excluded` (the newest tick
--       row's array).
--   (5) a read-back DO block that RAISEs on any miss and prints the new md5
--       pair — the pair every later prompt's read 3 pins.
--
-- WHY (measured):
--   D-a  only fr-vacuum-analyze is dispatched today and the cron vacuums sit at
--        fixed slots (04:30 ec / 04:50 fe), so the overlap needs a pct firing on
--        a cron slot — possible, not seen. It is FIX-1152's
--        SEQUENTIAL-NOT-CONCURRENT rule with an owner, and the precondition for
--        the small-vacuum MOVEs (s12).
--   D-b  donor-rollup drifted 03:25 → 15:29 → 03:33 → 15:37 → 03:41 → 16:05 →
--        04:09 → 16:31Z in eight cycles (cc-234 / 237 / 238 / 239 read 9a), the
--        05:45Z blackout in ~17 days; fr's floor 03:00 → 03:03 → 03:09 →
--        03:17Z (cc-235 / 237 / 238), the 04:30 EC vacuum band in ~3 weeks.
--        Per-row because a phase-locked `stale_after 10 minutes` would run
--        ec-crawl every 10 min instead of ~14: fixed-delay is a GAP after each
--        unit, which is what a crawl wants.
--   D-c  cc-235 Item 3: the clone's FR has last_vacuum NULL and no reaped row,
--        so fr produced no armed row and no `next:` line at all.
--   D-d  rule-taggers-weekly could not RETURN on `by 0 16 * * 2` (cc-237; the
--        stale_after 7 days bridge, FIX-1328).
--   D-e  ec-crawl's two cooldown rungs on 10-18 never appeared in a reason:
--        fe sorted first (cc-237 What contradicted).
--   D-f  10-18: ec-crawl's sensor tripped at 03:01:31Z (backoff_until
--        05:01:31Z); both crawls laddered to 04:41 / 04:53Z, then into the
--        blackout, and restarted ~09:01Z — ~4 h after the instant the unit had
--        written down (cc-238).
--
-- MEASUREMENT (cc-239 Phase 0, prod 2026-10-19 23:19–23:28Z): md5
-- 98660b34c17c5c537fc3d2e03d021440 / 4c9d0eb0cd85f9f46b38a9947cc94785;
-- registry {rows 54, eligible 7}; no phase_lock / phase_due_at / excluded
-- column; no cron_next_slot / cron_prev_slot; postgres is a member of
-- pg_read_all_stats (pg_stat_progress_vacuum.relid is readable for
-- autovacuum); no trigger on job_registry or dispatch_log (the ARM UPDATE moves
-- no updated_at); run_rule_taggers last complete|partial 2026-10-13
-- 16:15:02.71Z.
--
-- NETS: platform_dials.pause (the hard stop for the arm); the box skip (step
-- 4); every row's own gates; the budget watchdog for CALL one-shots; the
-- postgres role's 3 h ceiling; the I6 ladder / the D-f backoff cooldown; the
-- body revert below.
--
-- ROLLBACK: scripts/fix1329-revert-dispatcher-b1.sql — the M1 bodies verbatim
-- (re-asserting the M1 md5 pair), cron_next_daily's 20261004075000 body, DROP
-- the two slot functions and the three columns. Working order: pause = true →
-- every disp-% run row terminal → scripts/fix1334-revert-rule-taggers-by.sql
-- (the rows; a `by` weekly row must not meet the M1 body) → this body revert
-- → pause = false.
--
-- IDEMPOTENT: IF NOT EXISTS and CREATE OR REPLACE throughout; the clone gets
-- it twice through `db-query.mjs --local --file` (rule 241).
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the columns — dispatch_log first (the tick's lock order)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.dispatch_log
  ADD COLUMN IF NOT EXISTS excluded text[];

COMMENT ON COLUMN public.dispatch_log.excluded IS
  'FIX-1333 — on a tick row, every DUE job_registry row that was not armed: '
  '''<reason> (<job>)'' when an exclusion blocked it, ''queued (<job>)'' when the pick merely '
  'outranked it. NULL when there was none. `reason` keeps the single best-ranked blocker.';

ALTER TABLE public.job_registry
  ADD COLUMN IF NOT EXISTS phase_lock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phase_due_at timestamptz;

COMMENT ON COLUMN public.job_registry.phase_lock IS
  'FIX-1323 — per-row opt-in: when the last advancing unit started on time (within 4 ticks after '
  'phase_due_at), the stale_after deadline / the dead_tuples floor anchors to phase_due_at instead of '
  'the unit''s end, so a slot-like row does not drift by the arm latency every cycle.';

COMMENT ON COLUMN public.job_registry.phase_due_at IS
  'FIX-1323 — written by dispatch_one_unit at ARM: the due instant (now + ttd) of a phase_lock row '
  'armed from its stale_after or floor term; NULL after an arm from the pct term, a NULL anchor or '
  'a by rule. Never written for a phase_lock = false row.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (2) the slot functions (D-d) + cron_next_daily as a wrapper
-- ═══════════════════════════════════════════════════════════════════════════

-- One expression each, no sub-select (a SubLink blocks inlining). The
-- candidate slot c is this period's slot in UTC wall time — today (daily), the
-- next/last such weekday (weekly), this month's day (monthly) — and the outer
-- CASE steps it once: next = c, or c + step when c < now; prev = c, or
-- c - step when c > now.
CREATE OR REPLACE FUNCTION public.cron_next_slot(p_schedule text, p_now timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN p_schedule ~ '^\d+ \d+ \* \* \*$'
      OR p_schedule ~ '^\d+ \d+ \* \* [0-6]$'
      OR p_schedule ~ '^\d+ \d+ ([1-9]|1\d|2[0-8]) \* \*$' THEN
      CASE
        WHEN split_part(p_schedule, ' ', 1)::numeric <= 59
         AND split_part(p_schedule, ' ', 2)::numeric <= 23 THEN
          (CASE WHEN split_part(p_schedule, ' ', 5) <> '*'
                THEN (p_now AT TIME ZONE 'UTC')::date
                     + ((split_part(p_schedule, ' ', 5)::int
                         - extract(dow FROM (p_now AT TIME ZONE 'UTC')::date)::int + 7) % 7)
                WHEN split_part(p_schedule, ' ', 3) <> '*'
                THEN make_date(extract(year FROM (p_now AT TIME ZONE 'UTC'))::int,
                               extract(month FROM (p_now AT TIME ZONE 'UTC'))::int,
                               split_part(p_schedule, ' ', 3)::int)
                ELSE (p_now AT TIME ZONE 'UTC')::date
           END
           + make_time(split_part(p_schedule, ' ', 2)::int, split_part(p_schedule, ' ', 1)::int, 0)
           + CASE
               WHEN (CASE WHEN split_part(p_schedule, ' ', 5) <> '*'
                          THEN (p_now AT TIME ZONE 'UTC')::date
                               + ((split_part(p_schedule, ' ', 5)::int
                                   - extract(dow FROM (p_now AT TIME ZONE 'UTC')::date)::int + 7) % 7)
                          WHEN split_part(p_schedule, ' ', 3) <> '*'
                          THEN make_date(extract(year FROM (p_now AT TIME ZONE 'UTC'))::int,
                                         extract(month FROM (p_now AT TIME ZONE 'UTC'))::int,
                                         split_part(p_schedule, ' ', 3)::int)
                          ELSE (p_now AT TIME ZONE 'UTC')::date
                     END
                     + make_time(split_part(p_schedule, ' ', 2)::int, split_part(p_schedule, ' ', 1)::int, 0))
                    < (p_now AT TIME ZONE 'UTC')
               THEN CASE WHEN split_part(p_schedule, ' ', 5) <> '*' THEN interval '7 days'
                         WHEN split_part(p_schedule, ' ', 3) <> '*' THEN interval '1 month'
                         ELSE interval '1 day' END
               ELSE interval '0'
             END) AT TIME ZONE 'UTC'
      END
  END
$function$;

REVOKE ALL ON FUNCTION public.cron_next_slot(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_next_slot(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.cron_next_slot(text, timestamptz) IS
  'FIX-1329 — the first slot of a cron schedule at or after p_now (a slot equal to p_now is now), UTC. '
  'Exactly three forms: daily ''M H * * *'', weekly ''M H * * D'' (one day-of-week 0–6), monthly '
  '''M H D * *'' (one day-of-month 1–28); minute <= 59, hour <= 23. NULL for anything else (lists, '
  'ranges, */N) — the dispatcher reads NULL as unsupported_deadline. No SET clause (inlinable).';

CREATE OR REPLACE FUNCTION public.cron_prev_slot(p_schedule text, p_now timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN p_schedule ~ '^\d+ \d+ \* \* \*$'
      OR p_schedule ~ '^\d+ \d+ \* \* [0-6]$'
      OR p_schedule ~ '^\d+ \d+ ([1-9]|1\d|2[0-8]) \* \*$' THEN
      CASE
        WHEN split_part(p_schedule, ' ', 1)::numeric <= 59
         AND split_part(p_schedule, ' ', 2)::numeric <= 23 THEN
          (CASE WHEN split_part(p_schedule, ' ', 5) <> '*'
                THEN (p_now AT TIME ZONE 'UTC')::date
                     - ((extract(dow FROM (p_now AT TIME ZONE 'UTC')::date)::int
                         - split_part(p_schedule, ' ', 5)::int + 7) % 7)
                WHEN split_part(p_schedule, ' ', 3) <> '*'
                THEN make_date(extract(year FROM (p_now AT TIME ZONE 'UTC'))::int,
                               extract(month FROM (p_now AT TIME ZONE 'UTC'))::int,
                               split_part(p_schedule, ' ', 3)::int)
                ELSE (p_now AT TIME ZONE 'UTC')::date
           END
           + make_time(split_part(p_schedule, ' ', 2)::int, split_part(p_schedule, ' ', 1)::int, 0)
           - CASE
               WHEN (CASE WHEN split_part(p_schedule, ' ', 5) <> '*'
                          THEN (p_now AT TIME ZONE 'UTC')::date
                               - ((extract(dow FROM (p_now AT TIME ZONE 'UTC')::date)::int
                                   - split_part(p_schedule, ' ', 5)::int + 7) % 7)
                          WHEN split_part(p_schedule, ' ', 3) <> '*'
                          THEN make_date(extract(year FROM (p_now AT TIME ZONE 'UTC'))::int,
                                         extract(month FROM (p_now AT TIME ZONE 'UTC'))::int,
                                         split_part(p_schedule, ' ', 3)::int)
                          ELSE (p_now AT TIME ZONE 'UTC')::date
                     END
                     + make_time(split_part(p_schedule, ' ', 2)::int, split_part(p_schedule, ' ', 1)::int, 0))
                    > (p_now AT TIME ZONE 'UTC')
               THEN CASE WHEN split_part(p_schedule, ' ', 5) <> '*' THEN interval '7 days'
                         WHEN split_part(p_schedule, ' ', 3) <> '*' THEN interval '1 month'
                         ELSE interval '1 day' END
               ELSE interval '0'
             END) AT TIME ZONE 'UTC'
      END
  END
$function$;

REVOKE ALL ON FUNCTION public.cron_prev_slot(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_prev_slot(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.cron_prev_slot(text, timestamptz) IS
  'FIX-1329 — the newest slot of a cron schedule at or before p_now, UTC. The same three forms as '
  'cron_next_slot(); NULL for anything else. No SET clause (inlinable).';


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
BEGIN
  IF p_schedule IS NULL OR p_schedule !~ '^\d+ \d+ \* \* \*$' THEN
    RETURN NULL;
  END IF;
  RETURN public.cron_next_slot(p_schedule, p_now);
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_next_daily(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_next_daily(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.cron_next_daily(text, timestamptz) IS
  'FIX-1124 — the next firing of a daily M H * * * schedule at or after p_now, UTC; NULL for any other '
  'form. Since FIX-1329 (cc-239) a wrapper over cron_next_slot() for the daily form only. Read by '
  'crawl_gate''s peer_due.';


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) dispatch_one_unit() — 20261016230000 VERBATIM + D-a/b/c/d/e/f
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
          v_term := NULL;
          v_adv_start := NULL;
          v_locked := false;

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
              v_ttd := CASE WHEN v_last IS NULL THEN interval '-1 second'
                            WHEN v_locked THEN (r.phase_due_at + v_iv) - v_now
                            ELSE (v_last + v_iv) - v_now END;
              v_term := CASE WHEN v_last IS NULL THEN 'null_anchor' ELSE 'stale_after' END;

            ELSIF r.deadline_rule LIKE 'by %' THEN
              -- D-d (FIX-1329): daily, weekly and monthly slots.
              v_slot_prev := public.cron_prev_slot(substring(r.deadline_rule FROM '^by\s+(.+)$'), v_now);
              v_slot_next := public.cron_next_slot(substring(r.deadline_rule FROM '^by\s+(.+)$'), v_now);
              IF v_slot_prev IS NULL OR v_slot_next IS NULL THEN
                v_bad := 'by: unsupported schedule (daily M H * * *, weekly M H * * D, monthly M H D * * only)';
              ELSE
                v_ttd := CASE WHEN v_last IS NULL OR v_last < v_slot_prev
                              THEN v_slot_prev - v_now
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
          IF v_why IS NOT NULL THEN
            NULL;  -- the cooldown (I6) is the first reason
          ELSIF r.job = ANY (v_live_jobs) THEN
            v_why := 'live';
          ELSIF r.unit_shape = 'bare' AND r.unit_call ~* '^\s*VACUUM' AND v_vacuum_live IS NOT NULL THEN
            v_why := 'io: vacuum live (' || v_vacuum_live || ')';  -- D-a (FIX-1322): one VACUUM at a time
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
  'metadata.gate.backoff_until (FIX-1332).';


-- ═══════════════════════════════════════════════════════════════════════════
-- (4) get_dispatcher_status() — 20261016230000 VERBATIM + last_excluded
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
  '(FIX-1333, cc-239): the newest tick row''s dispatch_log.excluded.';



-- ═══════════════════════════════════════════════════════════════════════════
-- (5) read-back — RAISE on any miss; print the new md5 pair
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_md5_d   text;
  v_md5_g   text;
  v_md5_c   text;
  v_src     text;
BEGIN
  -- (1) the columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'dispatch_log'
                    AND column_name = 'excluded' AND data_type = 'ARRAY' AND udt_name = '_text') THEN
    v_missing := v_missing || 'dispatch_log.excluded text[]';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_registry'
                    AND column_name = 'phase_lock' AND data_type = 'boolean'
                    AND is_nullable = 'NO' AND column_default = 'false') THEN
    v_missing := v_missing || 'job_registry.phase_lock boolean NOT NULL DEFAULT false';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_registry'
                    AND column_name = 'phase_due_at' AND data_type = 'timestamp with time zone') THEN
    v_missing := v_missing || 'job_registry.phase_due_at timestamptz';
  END IF;

  -- (2) the slot functions: the three forms, equal-is-now, fail-closed
  IF public.cron_next_slot('0 16 * * 2', '2026-10-19 00:00Z') IS DISTINCT FROM '2026-10-20 16:00:00+00'::timestamptz THEN
    v_missing := v_missing || format('cron_next_slot(0 16 * * 2, 10-19 00:00Z) = %s', public.cron_next_slot('0 16 * * 2', '2026-10-19 00:00Z'));
  END IF;
  IF public.cron_prev_slot('0 16 * * 2', '2026-10-19 00:00Z') IS DISTINCT FROM '2026-10-13 16:00:00+00'::timestamptz THEN
    v_missing := v_missing || format('cron_prev_slot(0 16 * * 2, 10-19 00:00Z) = %s', public.cron_prev_slot('0 16 * * 2', '2026-10-19 00:00Z'));
  END IF;
  IF public.cron_next_slot('30 6 * * *', '2026-10-20 06:30Z') IS DISTINCT FROM '2026-10-20 06:30:00+00'::timestamptz THEN
    v_missing := v_missing || 'cron_next_slot(30 6 * * *, 10-20 06:30Z) — a slot equal to now is now';
  END IF;
  IF public.cron_prev_slot('5 3 15 * *', '2026-10-19 00:00Z') IS DISTINCT FROM '2026-10-15 03:05:00+00'::timestamptz THEN
    v_missing := v_missing || format('cron_prev_slot(5 3 15 * *, 10-19 00:00Z) = %s', public.cron_prev_slot('5 3 15 * *', '2026-10-19 00:00Z'));
  END IF;
  IF public.cron_next_slot('0 9,12 * * *', now()) IS NOT NULL THEN
    v_missing := v_missing || 'cron_next_slot(0 9,12 * * *) not NULL (a list)';
  END IF;
  IF public.cron_next_slot('*/15 * * * *', now()) IS NOT NULL THEN
    v_missing := v_missing || 'cron_next_slot(*/15 * * * *) not NULL (a step)';
  END IF;
  IF public.cron_next_daily('30 6 * * *', now()) IS DISTINCT FROM public.cron_next_slot('30 6 * * *', now()) THEN
    v_missing := v_missing || 'cron_next_daily(30 6 * * *) <> cron_next_slot (the wrapper)';
  END IF;
  IF public.cron_next_daily('0 16 * * 2', now()) IS NOT NULL THEN
    v_missing := v_missing || 'cron_next_daily(0 16 * * 2) not NULL (daily form only)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('cron_next_slot', 'cron_prev_slot')
                AND (proconfig IS NOT NULL OR prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql')
                     OR provolatile <> 's' OR prosecdef)) THEN
    v_missing := v_missing || 'cron_next_slot / cron_prev_slot: LANGUAGE sql, STABLE, no SET clause, INVOKER';
  END IF;

  -- (3)/(4) the bodies carry the hunks, and moved from M1
  SELECT md5(prosrc), prosrc INTO v_md5_d, v_src FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%io: vacuum live (%' OR v_src NOT LIKE '%phase_due_at%' OR v_src NOT LIKE '%excluded%'
     OR v_src NOT LIKE '%cron_prev_slot%' OR v_src NOT LIKE '%backoff: %s (unit says until %s;%' THEN
    v_missing := v_missing || 'dispatch_one_unit carries the B1 hunks';
  END IF;
  SELECT md5(prosrc), prosrc INTO v_md5_g, v_src FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%''last_excluded''%' THEN
    v_missing := v_missing || 'get_dispatcher_status carries last_excluded';
  END IF;
  -- The M1 bodies (20261016230000; cc-239 read 3): these must have moved.
  IF v_md5_d IS NULL OR v_md5_d = '98660b34c17c5c537fc3d2e03d021440' THEN
    v_missing := v_missing || 'dispatch_one_unit body replaced';
  END IF;
  IF v_md5_g IS NULL OR v_md5_g = '4c9d0eb0cd85f9f46b38a9947cc94785' THEN
    v_missing := v_missing || 'get_dispatcher_status body replaced';
  END IF;
  SELECT md5(prosrc) INTO v_md5_c FROM pg_proc
   WHERE proname = 'cron_next_daily' AND pronamespace = 'public'::regnamespace;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1329] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1329] read-back ok: dispatch_log.excluded, job_registry.phase_lock / phase_due_at; cron_next_slot / cron_prev_slot (daily, weekly, monthly; lists and */N NULL); cron_next_daily a daily-only wrapper (md5 %)', v_md5_c;
  RAISE NOTICE '[fix1329] md5 dispatch_one_unit % / get_dispatcher_status %', v_md5_d, v_md5_g;
END $$;
