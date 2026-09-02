-- FIX-1108 class (filed under FIX-1103/FIX-1108) — close the data_sync_log rows
-- left stranded 'running' by the FIX-1063 budget watchdog.
--
-- ── THE PROMPT'S THREE NAMED ROWS ARE ALREADY CLOSED. THIS IS A NO-OP FOR THEM.
--
-- cc-prompt-98 expected to find three rows stranded 'running':
--   entity_connection_stats_rebuild  started 2026-08-24 16:00 (the FIX-1103 row)
--   financial_entity_totals_refresh  started 2026-08-25 10:00 (FIX-1108)
--   run_rule_taggers                 started 2026-08-25 16:00 (FIX-1108)
-- All three read status='reaped' on prod as of 2026-09-02 01:35 UTC, closed not
-- by a migration but by the FIX-968 orphan reaper, whose own error_message is on
-- each row: 'reaped_orphan — no completion after 60 min; the pipeline's own
-- backend …'. A fourth, entity_connection_stats_rebuild started 2026-08-26
-- 16:00 (the second jobid-16 firing that preceded a postmaster restart), was
-- reaped the same way. The mechanism designed for this class worked; the rows
-- did not need a hand-written UPDATE. They are named here only so the next
-- reader does not go looking for them.
--
-- ONE THING WORTH RECORDING ABOUT THOSE FOUR: the reaper closes them 'reaped'
-- but leaves completed_at NULL, so the row carries no span at all. That is
-- weaker than what this migration writes below and weaker than the FIX-1028
-- precedent, which copies an observed end instant. Not corrected here — those
-- rows are no longer 'running' and rewriting them is outside this migration's
-- UPDATE-only, status-scoped contract. Flagged for the FIX-1028/FIX-1035 sweep.
--
-- ── THE FULL CENSUS, prod 2026-09-02 01:35 UTC ────────────────────────────────
-- data_sync_log WHERE status='running' AND started_at < now() - interval '2 hours'
-- returns exactly TWO rows, and neither is one the prompt named. Both are fresh
-- 2026-09-01 casualties of the same defect, and pg_stat_activity holds nothing
-- but background workers behind either — no live backend, nothing to adopt them:
--
--   treemap_individuals_global_refresh  f13e35ef…  started 09-01 14:00:00.183308
--     pg_cron jobid 26 runid 26129. cron_job_budget_action: pid 97080 signaled
--     at 15:30:06.861785 after 5409.8s against a 5400s budget. The backend exited
--     at cron.job_run_details.end_time = 2026-09-01 15:30:20.844838+00 with
--     'canceling statement due to user request' raised inside an INSERT. That is
--     the observed end instant and it is what completed_at is set to below.
--
--   run_rule_taggers                    bb0a0edf…  started 09-01 16:00:01.049628
--     pg_cron jobid 12 (weekly). cron_job_budget_action: pid 106783 signaled at
--     18:04:03.503988 after 7515.9s against a 7200s budget. Backend exited at
--     cron.job_run_details.end_time = 2026-09-01 18:05:20.702166+00. Same defect,
--     same procedure, seven days after the 08-25 row FIX-1108 was filed on.
--
-- NOTHING IS DELIBERATELY LEFT OPEN. Neither row can be adopted by a resume:
-- both jobs are weekly (next firings 09-08), and each firing opens its OWN
-- data_sync_log row — the 08-18 and 08-25 and 09-01 rows for these two pipelines
-- are three distinct ids, so there is no run in flight to close from underneath
-- (contrast the fec_bulk case FIX-1028's migration correctly left alone).
--
-- ── WHY 'reaped' AND NOT 'complete' ───────────────────────────────────────────
-- Both are cancel artifacts. The work was killed and real runtime was lost, so
-- the terminal status records a reap, and completed_at is copied from
-- cron.job_run_details rather than taken from now(), so the recorded span is the
-- span that actually happened (FIX-1035: started_at to now() is arithmetic, not
-- a measurement).
--
-- ── THE DEFECT ITSELF IS NOT FIXED HERE ───────────────────────────────────────
-- FIX-1108 stays OPEN. Probed pg_proc.prosrc on prod 2026-09-02: both
-- run_rule_taggers and refresh_financial_entity_totals_incremental still carry
-- only WHEN OTHERS, which per FIX-1028 does not match query_canceled (57014), so
-- the watchdog's cancel blows past the handler and skips the terminal UPDATE.
-- NEW THIS SESSION: refresh_treemap_individuals_global is a THIRD procedure with
-- the same hole (has_qc=false, has_others=true) — it is in cron_job_budget, it
-- was cancelled on 09-01, and it stranded its row for exactly this reason. It is
-- not named in the FIX-1108 bullet. Add it to that sweep's target list.
--
-- Idempotent: scoped by id + status, so a re-run matches nothing.
-- Expected to match ZERO rows on the local clone — the clone predates both.
-- Cross-ref FIX-1103, FIX-1108, FIX-1028, FIX-1063, FIX-968, FIX-1035.

UPDATE public.data_sync_log
   SET status       = 'reaped',
       completed_at = TIMESTAMPTZ '2026-09-01 15:30:20.844838+00',
       error_message = COALESCE(error_message,
                        'canceling statement due to user request (FIX-1063 budget watchdog, pid 97080)'),
       metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'reconciled_by', 'FIX-1103/FIX-1108 (cc-prompt-98)',
                        'reconciled_at', now(),
                        'reconcile_note',
                        'Cancelled by the FIX-1063 cron-job budget watchdog at 2026-09-01 '
                        '15:30:06.861785 UTC (cron_job_budget_action: jobid 26, runid 26129, '
                        'pid 97080, age 5409.8s against a 5400s budget, signaled=t). completed_at '
                        'is the OBSERVED backend exit from cron.job_run_details.end_time for runid '
                        '26129, not now(). The row stranded because '
                        'refresh_treemap_individuals_global carries only WHEN OTHERS, which does '
                        'not match query_canceled (57014) — the FIX-1108 defect in a third '
                        'procedure that bullet does not name. Reaped, not complete.')
 WHERE id     = 'f13e35ef-158e-4d93-8f84-81f874a615cd'
   AND status = 'running';

UPDATE public.data_sync_log
   SET status       = 'reaped',
       completed_at = TIMESTAMPTZ '2026-09-01 18:05:20.702166+00',
       error_message = COALESCE(error_message,
                        'canceling statement due to user request (FIX-1063 budget watchdog, pid 106783)'),
       metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'reconciled_by', 'FIX-1103/FIX-1108 (cc-prompt-98)',
                        'reconciled_at', now(),
                        'reconcile_note',
                        'Cancelled by the FIX-1063 cron-job budget watchdog at 2026-09-01 '
                        '18:04:03.503988 UTC (cron_job_budget_action: jobid 12, runid 26258, '
                        'pid 106783, age 7515.9s against a 7200s budget, signaled=t). completed_at '
                        'is the OBSERVED backend exit from cron.job_run_details.end_time for runid '
                        '26258, not now(). This is the SECOND run_rule_taggers row stranded by the '
                        'same missing WHEN query_canceled handler FIX-1108 was filed on — the '
                        'first was 2026-08-25, seven days earlier. Reaped, not complete.')
 WHERE id     = 'bb0a0edf-0e3b-4dfc-90ac-7f45091e377d'
   AND status = 'running';
