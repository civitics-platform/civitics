-- =============================================================================
-- FIX-1455 (cc-318) ROLLBACK — crs-summaries back to its Saturday row (data only):
-- out of the dispatcher's pick (an `at` row is never looped) and with no pipeline,
-- so step 3b reads no row of its for a request still pending.
--
-- The row half of
-- supabase/migrations/20261126004000_fix1454_fix1455_gha_one_row_reap_and_crs_walker_row.sql.
-- NOT a migration: a payload for the gated class-P path, as cc-318's STOP table
-- names it (rows FIRST, then scripts/fix1454-revert-gha-one-row-reap.sql):
--
--   pnpm run session:wait-for-gate:prod --expected-minutes 1 --census stop \
--     --poll-seconds 60 --max-wait-minutes 8 --reason "cc-318 revert: crs-summaries row" \
--     --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--             --timeout 30s --file ../../scripts/fix1455-revert-crs-summaries-row.sql"
--
-- THE START IS A COMMIT, NOT THIS FILE. cc-318 removed the Saturday cron
-- (/api/cron/gha-dispatch/crs-summaries, `0 10 * * 6`) from apps/civitics/vercel.json
-- and its plain target from GHA_DISPATCH_WORKFLOWS (apps/civitics/src/lib/gha-dispatch.ts).
-- With this row back and no cron, nothing starts the walker: restore that cron and
-- that target by a commit (or start it by hand, `gh workflow run crs-summaries.yml`).
-- The walker itself needs nothing: with max_minutes empty it walks everything due.
--
-- Matched on the NEW rule, so a row already back is left alone. The values are
-- cc-318 read 2's (prod, 2026-11-26 07:24Z), the note cc-292's verbatim.
--
-- Idempotent: a second run NOTICEs 0 rows and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule      = 'at 0 10 * * 6',
         pipeline           = NULL,
         unit_shape         = 'atomic',
         priority           = 3,
         cost_class         = 'io',
         cap_mb             = 128,
         exclusion_group    = 'proposals',
         budget_seconds     = 21000,
         gates              = '{}',
         idempotent_refire  = false,
         yield_to           = '{}',
         yield_lead_seconds = 0,
         note               = 'writes proposals.summary_plain; no data_sync_log row; no-band; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/crs-summaries, 0 10 * * 6, the slot kept) — GitHub started it 3.7–6.2 h late; on time a 350-min run ends by 15:50Z',
         updated_at         = now()
   WHERE job = 'crs-summaries'
     AND deadline_rule = 'stale_after 2 hours'
     AND unit_call = 'gha-dispatch:crs-summaries';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1455-revert] job_registry crs-summaries → at 0 10 * * 6, pipeline NULL, gates {}, yield_to {}: % row(s)', v_n;
END $$;

DO $$
DECLARE
  v_row text;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds)
    INTO v_row
    FROM public.job_registry WHERE job = 'crs-summaries';
  IF v_row IS DISTINCT FROM 'at 0 10 * * 6 | github_actions | gha-dispatch:crs-summaries | atomic | 3 | io | 128 | proposals | 21000 | {} | f | {} | 0' THEN
    RAISE EXCEPTION '[fix1455-revert] crs-summaries reads %', v_row;
  END IF;
  RAISE NOTICE '[fix1455-revert] crs-summaries back: %', v_row;
END $$;
