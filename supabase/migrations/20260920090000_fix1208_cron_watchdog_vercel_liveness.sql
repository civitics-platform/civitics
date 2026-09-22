-- FIX-1208 — the Vercel watchdog path gets a LIVENESS stamp.
--
-- THE PROBLEM, stated exactly. FIX-1194 P2-A is deployed: /api/cron/cron-watchdog
-- calls run_cron_watchdogs() from Vercel every 2 minutes so a fork starvation
-- that kills the pg_cron scheduler does not also kill the guard. cc-142 went
-- looking for the receipt in pg_stat_statements and found nothing, filed
-- FIX-1207, and then corrected itself: the cron IS firing, and pgss was simply
-- blind to that call. FIX-1207 closed no-op and FIX-1208 was filed for the real
-- gap — P2-A works and cannot be VERIFIED.
--
-- WHY acted_via CANNOT BE THE INSTRUMENT (rule 129, and this is the whole
-- point). cron_job_budget_action.acted_via is written only when the wrapper
-- actually re-labels a row, and it only re-labels a row when a cancel happened.
-- `canceled: 0` is the overwhelmingly common and CORRECT answer — 720 calls a
-- day, almost all of them finding nothing over budget. So acted_via is a
-- CHANGE proxy: on a healthy day it is silent, and its silence is
-- indistinguishable from the route never having run. It can prove the path
-- ACTED; it can never prove the path is ALIVE.
--
-- A liveness proxy has to be written on EVERY call, whether or not anything was
-- cancelled. That is the one row below.
--
-- WHY A WRITE INSIDE THIS FUNCTION IS, BY CONSTRUCTION, A VERCEL RECEIPT.
-- pg_cron calls enforce_cron_job_budgets() and enforce_derived_mvs_unit_budget()
-- DIRECTLY, by name, in its own two */2 job commands. run_cron_watchdogs() is
-- the wrapper, and the Vercel route is its ONLY caller. So a row stamped here
-- cannot have come from the pg_cron path — there is no code path by which it
-- could. Nothing about the instrument has to be trusted; the call graph does
-- the work.
--
-- THE DEAD-TUPLE MATH, because a row rewritten every 2 minutes is 720 updates
-- a day and that deserves stating rather than hoping. pipeline_state carries
-- FIX-1003b's threshold-led reloptions (autovacuum_vacuum_threshold = 20,
-- scale_factor = 0.05) precisely because it is a tiny, heavily-updated table.
-- Prod, read 2026-09-22: 37 rows, 16 dead, 1,997 lifetime updates and 97
-- autovacuums against the 2026-09-15 15:09:48 epoch — about 307 updates and 15
-- autovacuums a day. Trigger = 20 + 0.05 x 37 = 21.85 dead tuples, so 720 more
-- updates a day is roughly 33 more autovacuum cycles a day, on a table whose
-- heap is a couple of pages. Each cycle is milliseconds. This roughly triples
-- pipeline_state's write volume and its vacuum cadence, both from a very small
-- base, and it is the cheapest available shape: ONE row, rewritten in place,
-- never appended to.
--
-- THE STAMP IS IN ITS OWN EXCEPTION HANDLER, and that is not belt-and-braces.
-- This function's existing discipline is that each inner watchdog runs inside
-- its own handler so one failing never blinds the other. An instrument must
-- obey that rule more strictly than the things it measures: if the stamp threw
-- — a lock on pipeline_state, a constraint, anything — an unhandled error here
-- would take down the CANCEL path that P2-A exists to keep alive. A watchdog
-- that dies because its odometer jammed is worse than no odometer. So a failed
-- stamp surfaces in the payload as `stamp_error` and the watchdogs' own results
-- are returned regardless.
--
-- rule 34: the body below is PROD's, verified byte-identical to
-- 20260920070000:135-189 by pg_get_functiondef on 2026-09-22 (0 lines of diff)
-- before this edit. SECURITY DEFINER and `SET search_path = public, cron,
-- pg_catalog` are restated unchanged. rule 109 / FIX-1128: no statement_timeout
-- anywhere — the real bounds are authenticator's 8 s role GUC and the route's
-- 10 s client race, and a routine-level SET would be inert.
--
-- `at` was ALREADY in the returned jsonb. This migration does not add it; the
-- route's verdict line starts printing it, so the Vercel log itself carries the
-- DB clock and the two instruments can be compared without a query.

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
  v_stamp    text := NULL;   -- FIX-1208: why the liveness stamp failed, if it did
  v_at       timestamptz;
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

  -- ── FIX-1208 — the liveness stamp ────────────────────────────────────────
  -- Written on EVERY call, cancel or no cancel. That is the entire difference
  -- from acted_via, and it is why this can answer "is the Vercel path alive?"
  -- on a quiet day. In its own handler: see the header — an instrument must not
  -- be able to kill the guard it measures.
  v_at := now();
  BEGIN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('cron_watchdog_vercel', jsonb_build_object(
              'at',       v_at,
              'checked',  v_budget->'checked',
              'canceled', v_budget->'canceled',
              'unit',     v_unit->'action'))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[run_cron_watchdogs] liveness stamp failed: %', SQLERRM;
    v_stamp := SQLERRM;
  END;

  RETURN jsonb_build_object(
    'via',       'vercel',
    'budget',    v_budget,
    'unit',      v_unit,
    'labelled',  v_labelled,
    'at',        v_at)
    || CASE WHEN v_stamp IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('stamp_error', v_stamp) END;
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
  'route''s 10 s client race (FIX-1128: a routine-level SET is inert). '
  'FIX-1208 — stamps pipeline_state.cron_watchdog_vercel on EVERY call. '
  'acted_via is a CHANGE proxy and is silent on a day with no cancels, so it '
  'can never prove this path is alive; a stamp written unconditionally can. '
  'This wrapper''s only caller is the Vercel route (pg_cron calls the two inner '
  'functions directly), so the row is a Vercel receipt by construction. The '
  'stamp has its own EXCEPTION handler: an instrument must not be able to kill '
  'the guard it measures.';

COMMENT ON COLUMN public.cron_job_budget_action.acted_via IS
  'FIX-1194 — which firing path produced this cancel: pg_cron (the */2 job, the '
  'default the inner INSERT stamps) or vercel (run_cron_watchdogs(), re-labelled '
  'by the wrapper for the runids of its own call). A vercel row in a window '
  'where pg_cron''s firings failed `job startup timeout` is the receipt that the '
  'second path did the work the first could not. NOTE (FIX-1208): this column is '
  'a CHANGE proxy, not a liveness proxy — it is written only when a cancel '
  'happens, so it is silent on a healthy day. For "did the Vercel path run?" '
  'read pipeline_state.cron_watchdog_vercel instead.';
