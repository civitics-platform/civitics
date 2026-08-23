-- FIX-1093 / FIX-1094 — two read-only helper functions the dashboard self-test
-- suite needs and PostgREST cannot express.
--
-- Both are pure readers. Neither writes, and neither is reachable from an
-- unauthenticated request: EXECUTE is revoked from anon/authenticated and
-- granted only to service_role, which is the role the status-snapshot cron
-- path (/api/cron/platform-snapshot → computeStatusPayload) runs as.
--
-- WHY FUNCTIONS AND NOT POSTGREST QUERIES
--
--   1. check_senate_reference_cohort — the vote fixture is a GROUP BY … HAVING
--      aggregate ("how many senators clear N vote_yes edges"). PostgREST has no
--      aggregate-with-having form, and the alternatives are worse: one probe per
--      senator is 100 round trips, and reading the pg_cron-refreshed
--      entity_connection_stats_mv rollup instead would mask the exact regression
--      the fixture exists to catch (a resolver bug that strands vote edges on
--      candidate stubs is invisible until the rollup next refreshes).
--
--   2. check_cron_job_escalations — cron.job / cron.job_run_details live in the
--      `cron` schema, which PostgREST does not expose and service_role cannot
--      read. The existing check_cron_job_health() reads them but answers a
--      different question over a different window, and its response is 222 kB at
--      a 26 h lookback (measured on prod 2026-08-22) because it carries every
--      run row. Fetching that from the snapshot cron every 10 minutes to throw
--      99.9% of it away would be ~960 MB/month of egress against a 5 GB budget —
--      the very budget the dashboard's own resource-warning card tracks. So this
--      function CALLS check_cron_job_health() in-database, strips `runs` there,
--      and returns only the compact escalating keys. Single source of truth for
--      the missing-daily / canary-liveness rules, no wire cost.

-- ── 1. Senate reference cohort ───────────────────────────────────────────────
--
-- COHORT DEFINITION — read this before changing any predicate.
--
-- "Active federal senator" is NOT `role_title = 'Senator' AND tier = 'elected'`.
-- On prod that predicate matches 1,512 rows because OpenStates state-legislature
-- upper chambers also title their members "Senator" (local matches 102 — the
-- clone is thinner, so a local-only check would have looked fine and shipped a
-- 15x-wrong cohort to prod). The source-provenance exclusions below are the same
-- ones get_officials_breakdown() uses to split federal/state/judges, and they
-- resolve the cohort to exactly 100 on BOTH local and prod.
--
-- The function returns a deterministically sampled member (lowest id) alongside
-- the aggregate so the search fixture and the vote fixture are provably talking
-- about the same cohort. The sample rotates on its own as the roster changes —
-- that is intended. `sample_name` is fed to the search RPC as a query string; it
-- is never rendered (self-test `detail` strings stay neutral, FIX-1076/1093).
CREATE OR REPLACE FUNCTION public.check_senate_reference_cohort(
  p_min_edges integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH cohort AS (
    SELECT o.id, o.full_name
    FROM public.officials o
    WHERE o.is_active
      AND o.tier = 'elected'
      AND o.role_title = 'Senator'
      AND NOT (o.source_ids ? 'openstates_id')
      AND NOT (o.source_ids ? 'courtlistener_person_id')
  ),
  covered AS (
    SELECT ec.from_id
    FROM public.entity_connections ec
    JOIN cohort c ON c.id = ec.from_id
    WHERE ec.from_type = 'official'
      AND ec.connection_type = 'vote_yes'
    GROUP BY ec.from_id
    HAVING count(*) > p_min_edges
  ),
  sample AS (
    SELECT id, full_name FROM cohort ORDER BY id LIMIT 1
  )
  SELECT jsonb_build_object(
    'cohort_size',  (SELECT count(*) FROM cohort),
    'with_edges',   (SELECT count(*) FROM covered),
    'min_edges',    p_min_edges,
    'sample_id',    (SELECT id::text FROM sample),
    'sample_name',  (SELECT full_name FROM sample)
  );
$$;

COMMENT ON FUNCTION public.check_senate_reference_cohort(integer) IS
  'FIX-1093 — neutral self-test fixture source. Returns the active-federal-senator '
  'cohort size, how many clear p_min_edges vote_yes entity_connections, and one '
  'deterministically sampled member (lowest id). Measured 57 ms prod / 36 ms local.';

REVOKE ALL ON FUNCTION public.check_senate_reference_cohort(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_senate_reference_cohort(integer) TO service_role;

-- ── 2. Consecutive pg_cron failure streaks ───────────────────────────────────
--
-- THE REFERENCE INCIDENT. entity-connection-stats-rebuild (`0 16 * * 1,3`) failed
-- its last three firings on prod — 2026-08-10 (statement timeout), 2026-08-17 and
-- 2026-08-19 (both "job startup timeout") — and nothing on the dashboard said so.
-- cc-79 made rollup staleness publicly visible; this makes the *cause* visible.
--
-- Streak, not count-in-window: the every-2-minute watchdogs logged 169 startup
-- timeouts in a single day on 2026-08-19 and then recovered completely. Counting
-- failures would red-flag them forever; counting the TRAILING run of failures
-- reports them as healthy the moment they succeed again, while a twice-weekly job
-- that has failed every firing since 08-10 stays flagged.
--
-- 336 h (14 d), because a `1,3`-day-of-week job fires twice a week: a 26 h window
-- can only ever contain one of its firings, so "consecutive" is unanswerable
-- there. pg_cron history on prod retains back to 2026-06-29 (12,197 rows), so
-- this window is comfortably inside retention.
--
-- Only 'succeeded' and 'failed' rows participate. An in-flight 'running' /
-- 'starting' row is not evidence of anything yet and must not be able to open a
-- streak. Jobs are keyed by NAME in the output; jobid is deliberately absent
-- (it is an unstable local handle that means nothing to a dashboard reader).
--
-- `missing_daily` and `canary_liveness` ride along from check_cron_job_health()
-- as CONTEXT, and the dashboard test deliberately does not fail on them. They
-- already escalate inside the daily canary, so re-escalating here buys no
-- coverage — and on any instance without a live pg_cron (i.e. every local Docker
-- database, where nothing has ever fired) they are permanently true, which would
-- pin the test red forever. A self-test that is always red is a self-test nobody
-- reads. The failure-streak arm, by contrast, means the same thing everywhere.
CREATE OR REPLACE FUNCTION public.check_cron_job_escalations(
  p_lookback_hours integer DEFAULT 336,
  p_min_streak     integer DEFAULT 2
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'cron', 'pg_catalog'
AS $$
DECLARE
  v_since   timestamptz := now() - make_interval(hours => p_lookback_hours);
  v_failing jsonb;
  v_jobs    integer;
  v_health  jsonb;
BEGIN
  -- Degrade cleanly rather than raising where pg_cron is absent, matching
  -- check_cron_job_health()'s contract — the caller distinguishes "no pg_cron
  -- here" from "pg_cron is fine" and neither is a test failure.
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object(
      'available',      false,
      'lookback_hours', p_lookback_hours,
      'min_streak',     p_min_streak,
      'jobs_active',    0,
      'failing',        '[]'::jsonb,
      'missing_daily',  '[]'::jsonb,
      'canary_liveness', 'null'::jsonb
    );
  END IF;

  SELECT count(*) INTO v_jobs FROM cron.job WHERE active;

  -- 26 h is check_cron_job_health()'s own default and the window its
  -- missing-daily rule is reasoned against; do not pass p_lookback_hours here.
  -- `- 'runs'` is what keeps this call free: the array it drops is the entire
  -- 222 kB.
  v_health := public.check_cron_job_health(26) - 'runs';

  WITH terminal AS (
    SELECT d.jobid,
           d.status,
           d.return_message,
           row_number() OVER (PARTITION BY d.jobid ORDER BY d.start_time DESC) AS rn
    FROM cron.job_run_details d
    WHERE d.start_time >= v_since
      AND d.status IN ('succeeded', 'failed')
  ),
  streak AS (
    -- Position of the newest success minus one = length of the trailing failure
    -- run. No success in the window at all → every terminal row is a failure.
    SELECT jobid,
           COALESCE(min(rn) FILTER (WHERE status = 'succeeded'), max(rn) + 1) - 1 AS fail_streak,
           max(rn) AS runs_in_window
    FROM terminal
    GROUP BY jobid
  )
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'jobname'), '[]'::jsonb)
    INTO v_failing
  FROM (
    SELECT jsonb_build_object(
             'jobname',        j.jobname,
             'schedule',       j.schedule,
             'fail_streak',    s.fail_streak,
             'runs_in_window', s.runs_in_window,
             'last_failed_at', (SELECT max(d2.start_time)
                                  FROM cron.job_run_details d2
                                 WHERE d2.jobid = j.jobid AND d2.status = 'failed'),
             'last_message',   left(COALESCE((SELECT t2.return_message FROM terminal t2
                                               WHERE t2.jobid = j.jobid AND t2.rn = 1), ''), 120)
           ) AS t
    FROM cron.job j
    JOIN streak s ON s.jobid = j.jobid
    WHERE j.active
      AND s.fail_streak >= p_min_streak
  ) f;

  RETURN jsonb_build_object(
    'available',       true,
    'lookback_hours',  p_lookback_hours,
    'min_streak',      p_min_streak,
    'jobs_active',     v_jobs,
    'failing',         v_failing,
    'missing_daily',   COALESCE(v_health->'missing_daily', '[]'::jsonb),
    'canary_liveness', COALESCE(v_health->'canary_liveness', 'null'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.check_cron_job_escalations(integer, integer) IS
  'FIX-1094 — active pg_cron jobs whose TRAILING run of terminal firings is all '
  'failures, >= p_min_streak long, inside p_lookback_hours, plus the compact '
  'missing_daily / canary_liveness keys from check_cron_job_health(26) with its '
  '222 kB runs array stripped in-database. Companion to check_cron_job_health(): '
  'that one answers "did anything fail or go silent in the last day", this one '
  'answers "is anything stuck failing". Jobs keyed by name, never jobid.';

REVOKE ALL ON FUNCTION public.check_cron_job_escalations(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_cron_job_escalations(integer, integer) TO service_role;
