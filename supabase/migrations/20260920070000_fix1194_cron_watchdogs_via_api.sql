-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1194 P2-A — the two */2 watchdogs become callable from a Vercel cron
-- route, so the guard no longer dies with the patient.
--
-- ── THE FAILURE THIS ANSWERS ─────────────────────────────────────────────────
--
-- A large FR/EC landing starves pg_cron of background workers while its derived
-- work drains. Both */2 watchdog jobs — `cron-job-budget-watchdog` (FIX-1063)
-- and `derived-mvs-unit-watchdog` (FIX-1030/1035) — then fail with
-- `job startup timeout` and enforce nothing, which is precisely the window in
-- which something is over budget. Measured: cc-130 counted 117 fork failures in
-- the set-1 drain, 41 of them under an ordinary `contract-flow-rollups-refresh`;
-- cc-139 found 2026-09-07's 12/30 and 10/30 under the FIX-1165 apply with NO DB
-- trace at all; FIX-1123 recorded 2026-08-31 06:06-12:05 with EVERY watchdog
-- firing failing `job startup timeout`. A watchdog that cannot fork is not a
-- watchdog — the same lesson FIX-1130 learned for the front door.
--
-- The answer is a SECOND, INDEPENDENT firing path that does not need pg_cron to
-- fork: Vercel's scheduler calls a route, the route calls this function through
-- PostgREST on an ordinary `authenticator` connection. pg_cron keeps its two
-- jobs exactly as they are — belt AND braces, not braces instead of belt. Both
-- paths are idempotent by construction: FIX-1063's ledger is keyed on `runid`
-- (PK) and FIX-1030's guard is `metadata ? 'watchdog_canceled_at'`, so the two
-- paths racing cancels the target at most once regardless of who wins.
--
-- ── WHY A WRAPPER AND NOT A DIRECT .rpc() ON THE TWO FUNCTIONS ──────────────
--
-- The design of record said the route would call `enforce_cron_job_budgets()`
-- over PostgREST. It could not have. Measured on prod 2026-09-21:
--
--   (a) Both functions are SECURITY INVOKER (`pg_proc.prosecdef = f`), on
--       purpose — FIX-1030's header: "pg_cancel_backend against a
--       postgres-owned backend needs superuser or pg_signal_backend; the
--       pg_cron job runs as postgres and therefore has it. Making this SECURITY
--       DEFINER would create a 'cancel any backend' primitive reachable by
--       whoever holds EXECUTE, for no benefit."
--   (b) `service_role` DOES hold EXECUTE on both — Supabase's default grant,
--       which survived because every REVOKE in the family (FIX-1063:278,
--       FIX-1101:420, FIX-1030:663, FIX-1035:224) names PUBLIC/anon/
--       authenticated and never service_role. EXECUTE alone is worthless here.
--   (c) Running AS service_role, neither function can do its job:
--         has_schema_privilege('service_role','cron','USAGE')      = false
--         pg_has_role('service_role','pg_signal_backend','MEMBER') = false
--       So the FROM cron.job_run_details read fails at the schema gate — note
--       the table SELECT grant IS present and is unreachable without schema
--       USAGE — and pg_cancel_backend against a postgres-owned backend would be
--       refused even if the read succeeded.
--
-- `postgres` is NOT superuser on Supabase (`pg_roles.rolsuper = f`) but IS a
-- member of `pg_signal_backend` (true), and owns both functions. A SECURITY
-- DEFINER function owned by `postgres` therefore runs with both the `cron`
-- schema USAGE and the signal membership the work needs. That is the whole
-- mechanism, and it is why the wrapper's WIDTH is the thing to argue about.
--
-- ── THE PRIMITIVE'S WIDTH, IN FIX-1030'S OWN TERMS ──────────────────────────
--
-- FIX-1030 refused SECURITY DEFINER because it would create a "cancel any
-- backend" primitive. This function is not that one. It takes NO PARAMETERS and
-- accepts NO PID. It cancels only what the two existing functions already
-- select, on their own unchanged predicates:
--
--   * the budget watchdog: a `running` row in cron.job_run_details whose
--     jobname is listed in public.cron_job_budget, past its budget_seconds,
--     with a non-null job_pid, no prior cron_job_budget_action row for that
--     runid, and a live non-idle pg_stat_activity row whose query matches the
--     CALL target parsed out of the job's own command;
--   * the unit watchdog: the single `running` refresh_derived_mvs data_sync_log
--     row's published metadata.backend_pid, past its unit budget, not already
--     stamped watchdog_canceled_at.
--
-- Whoever holds EXECUTE on this function gains exactly one capability: "run the
-- two watchdogs now". They cannot name a target, widen a predicate, or raise a
-- budget. EXECUTE is granted to service_role only, and revoked from PUBLIC,
-- anon and authenticated (FIX-834: Supabase default-grants EXECUTE on new
-- functions, so the REVOKE is load-bearing).
--
-- Rule 34 does not apply: no existing definition is redefined here. Both inner
-- functions are CALLED, not copied — a copy would be a second predicate to keep
-- in step with the first, and the whole point is that there is one predicate
-- with two firing paths.
--
-- ── WHY NO statement_timeout ANYWHERE IN THIS FILE ──────────────────────────
--
-- Not as proconfig (FIX-1128: a routine-level SET is inert — armed once by the
-- server at the start of the top-level statement, so changing the GUC from
-- inside that statement changes what current_setting() reports and nothing
-- else; measured both directions in
-- docs/audits/2026-09-13-fix1128-experiments.md), and not as a SET in the body
-- either, for the same reason. This call already has TWO real bounds and a
-- third would only be a third place to look:
--
--   1. `authenticator`'s role-level statement_timeout, inherited by
--      service_role — 8 s (cc-137).
--   2. The route's own client-side race — withDbTimeout(..., 10_000).
--
-- Both are stated here so nobody adds a third.
--
-- ── acted_via ───────────────────────────────────────────────────────────────
--
-- Additive, NOT NULL DEFAULT 'pg_cron', closed vocabulary of two. The inner
-- INSERT stamps the default, so every historical row reads 'pg_cron' and every
-- pg_cron firing continues to. The wrapper re-labels only the rows THIS call
-- produced, identified by the runids in its own return value. The receipt
-- FIX-1194 is waiting for is a 'vercel' row appearing in a fork burst while
-- pg_cron's own firings show `job startup timeout`.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cron_job_budget_action
  ADD COLUMN IF NOT EXISTS acted_via text NOT NULL DEFAULT 'pg_cron';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cron_job_budget_action'::regclass
      AND conname  = 'cron_job_budget_action_acted_via_chk'
  ) THEN
    ALTER TABLE public.cron_job_budget_action
      ADD CONSTRAINT cron_job_budget_action_acted_via_chk
      CHECK (acted_via IN ('pg_cron', 'vercel'));
  END IF;
END $$;

COMMENT ON COLUMN public.cron_job_budget_action.acted_via IS
  'FIX-1194 — which firing path produced this cancel: pg_cron (the */2 job, the '
  'default the inner INSERT stamps) or vercel (run_cron_watchdogs(), re-labelled '
  'by the wrapper for the runids of its own call). A vercel row in a window '
  'where pg_cron''s firings failed `job startup timeout` is the receipt that the '
  'second path did the work the first could not.';


-- ─────────────────────────────────────────────────────────────────────────────
-- run_cron_watchdogs() — the narrow wrapper.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_cron_watchdogs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  v_budget   jsonb := jsonb_build_object('error', 'not evaluated');
  v_unit     jsonb := jsonb_build_object('action', 'error', 'reason', 'not evaluated');
  v_runids   bigint[];
  v_labelled int := 0;
BEGIN
  -- Each inside its own handler, so one failing never blinds the other. The
  -- precedent is FIX-1101's own ec-window call inside enforce_cron_job_budgets:
  -- a failed unit SURFACES in the payload, it does not hide its sibling.
  BEGIN
    v_budget := public.enforce_cron_job_budgets();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[run_cron_watchdogs] budget watchdog failed: %', SQLERRM;
    v_budget := jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
  END;

  BEGIN
    v_unit := public.enforce_derived_mvs_unit_budget();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[run_cron_watchdogs] unit watchdog failed: %', SQLERRM;
    v_unit := jsonb_build_object('action', 'error', 'reason', SQLERRM, 'sqlstate', SQLSTATE);
  END;

  -- Re-label ONLY what this call produced. The runids come from this call's own
  -- return value; the acted_via = 'pg_cron' predicate means a row an overlapping
  -- pg_cron firing already claimed is never stolen; the 5-minute floor means a
  -- historical row carrying a recycled runid cannot be touched.
  SELECT array_agg((a->>'runid')::bigint)
    INTO v_runids
  FROM jsonb_array_elements(COALESCE(v_budget->'actions', '[]'::jsonb)) AS a;

  IF v_runids IS NOT NULL AND array_length(v_runids, 1) > 0 THEN
    UPDATE public.cron_job_budget_action
    SET acted_via = 'vercel'
    WHERE runid     = ANY (v_runids)
      AND acted_via = 'pg_cron'
      AND acted_at >= now() - interval '5 minutes';
    GET DIAGNOSTICS v_labelled = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'via',       'vercel',
    'budget',    v_budget,
    'unit',      v_unit,
    'labelled',  v_labelled,
    'at',        now());
END;
$$;

REVOKE ALL ON FUNCTION public.run_cron_watchdogs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_cron_watchdogs() TO service_role;

COMMENT ON FUNCTION public.run_cron_watchdogs() IS
  'FIX-1194 P2-A — fires BOTH */2 watchdogs from outside pg_cron, so a fork '
  'starvation that kills the scheduler does not also kill the guard. SECURITY '
  'DEFINER because service_role has neither USAGE on schema cron nor membership '
  'of pg_signal_backend (measured on prod 2026-09-21), and postgres — the owner '
  'of both inner functions — has both. The primitive is NOT FIX-1030''s feared '
  '"cancel any backend": no parameters, no pid input, and it cancels only what '
  'enforce_cron_job_budgets() and enforce_derived_mvs_unit_budget() already '
  'select on their own unchanged predicates. Each inner call is wrapped so one '
  'failing surfaces rather than hiding its sibling. No statement_timeout here '
  'by design — the real bounds are authenticator''s 8 s role GUC and the '
  'route''s 10 s client race (FIX-1128: a routine-level SET is inert).';
