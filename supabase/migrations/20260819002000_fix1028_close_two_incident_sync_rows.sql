-- FIX-1028 class — close the two data_sync_log rows stranded 'running' by the
-- 2026-08-18 REST-API incident and its recovery.
--
-- Both are CANCEL ARTIFACTS: the work really was killed and real runtime was
-- lost, so both close as 'reaped', never as 'complete'. The end instants are
-- taken from cron.job_run_details rather than from now(), so the recorded span
-- is the span that actually happened.
--
--   treemap_individuals_global_refresh   0ac717b9…  started 08-18 08:15:02
--     pg_cron jobid 26. Ran 1h47m57s with no effective bound and starved the
--     catalog query PostgREST needs for its schema cache — the 09:45-10:41 UTC
--     503 PGRST002 outage. Ended by pg_cancel_backend at 10:02:59 during
--     recovery. cron.job_run_details end_time = 2026-08-18 10:02:59.258134+00.
--     Its own metadata carries budget_seconds=16200, which is exactly the
--     decorative-budget problem FIX-1063 fixes: a procedure cannot bound itself,
--     and 16200 would not have saved the box even if it could.
--
--   run_rule_taggers                     73cd673f…  started 08-18 10:00:04
--     pg_cron jobid 12, weekly cadence. Killed by the project restart that
--     recovered PostgREST — its job_run_details row reads 'server restarted'
--     with a NULL end_time, so there is no observed end instant to copy. Closed
--     at the incident's recovery boundary (10:41 UTC, when REST returned 200)
--     and the note says so explicitly rather than implying a measured span.
--
-- NOT INCLUDED — the third stranded row is deliberately left open:
--   fec_bulk  0d009b67…  started 08-18 03:54:39, github_run_id 32097136492
-- That is the cc-65 phase-4 backfill, SIGTERM'd at its 350-minute cap with
-- resumable state banked. A resume is scheduled into the 2026-08-19 01:00-05:00
-- UTC window and may legitimately adopt or supersede that row. Closing it from
-- underneath a run that is about to resume is exactly how bookkeeping starts
-- lying, so it stays 'running' until the resume resolves. FIX-1065 covers the
-- separate reason it was not closed by mark-killed at the time (mark-killed
-- rides PostgREST, which was the thing that was down).
--
-- Idempotent: scoped by id + status, so a re-run matches nothing.
-- Cross-ref FIX-1028, FIX-1063, FIX-1065, FIX-971, FIX-979.

UPDATE public.data_sync_log
   SET status       = 'reaped',
       completed_at = TIMESTAMPTZ '2026-08-18 10:02:59.258134+00',
       error_message = COALESCE(error_message,
                        'canceling statement due to user request (pg_cancel_backend during incident recovery)'),
       metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'reconciled_by', 'FIX-1028-class (cc-prompt-63 rider c)',
                        'reconciled_at', now(),
                        'reconcile_note',
                        'Cancelled by pg_cancel_backend at 2026-08-18 10:02:59 UTC after running '
                        '1h47m57s unbounded and starving PostgREST''s schema-cache catalog query '
                        '(the 09:45-10:41 UTC 503 PGRST002 outage). completed_at is the observed '
                        'cron.job_run_details end_time, not now(). Reaped, not complete: the merge '
                        'did not finish and its runtime was lost.')
 WHERE id     = '0ac717b9-0b55-43c1-9c0c-d8d1dd2c5a53'
   AND status = 'running';

UPDATE public.data_sync_log
   SET status       = 'reaped',
       completed_at = TIMESTAMPTZ '2026-08-18 10:41:00+00',
       error_message = COALESCE(error_message, 'server restarted (incident recovery)'),
       metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'reconciled_by', 'FIX-1028-class (cc-prompt-63 rider c)',
                        'reconciled_at', now(),
                        'completed_at_is_estimated', true,
                        'reconcile_note',
                        'Killed by the project restart that recovered PostgREST on 2026-08-18. Its '
                        'pg_cron run row reads "server restarted" with a NULL end_time, so no '
                        'observed end instant exists; completed_at is set to the recovery boundary '
                        '(10:41 UTC, when REST returned 200) and flagged estimated. Reaped, not '
                        'complete.')
 WHERE id     = '73cd673f-6a95-44ad-a527-de91b524b387'
   AND status = 'running';
