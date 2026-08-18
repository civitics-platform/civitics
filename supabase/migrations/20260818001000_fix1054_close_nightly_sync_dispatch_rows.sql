-- =============================================================================
-- FIX-1054 — reconcile the nightly-sync dispatch rows that never left
-- status='triggered'.
--
-- WHAT WAS MEASURED (prod, 2026-08-18): 104 rows with pipeline='nightly-sync',
-- status='triggered', completed_at IS NULL, running continuously from
-- 2026-04-30 to 2026-08-17 — essentially every nightly dispatch ever made.
--
-- THE WRITER, NAMED: apps/civitics/app/api/cron/nightly-sync/route.ts. It is a
-- Vercel-cron canary that inserts the row to prove the scheduler is alive and
-- then returns; the actual pipeline runs in GitHub Actions and reports under
-- `nightly_cron` and the per-stage pipeline names, all of which close correctly.
-- Nothing was ever going to close the dispatch row, because the dispatch is
-- instantaneous — the row was recording a completed handoff in an in-flight
-- vocabulary. That route is fixed in the same commit to write status
-- 'dispatched' with completed_at = started_at.
--
-- ONE CORRECTION TO THE BULLET, from reading the catalog rather than assuming:
-- the FIX-1054 bullet says "the reaper has 104 permanent candidates it either
-- skips or re-examines forever". It does not. reap_stale_sync_log's predicate is
-- `WHERE dsl.status = 'running' AND dsl.started_at < NOW() - ...`, so these rows
-- were never in its candidate set. The real cost was the one the bullet leads
-- with and that stands: any freshness/liveness scan over unclosed rows had to
-- special-case this population, and a genuinely hung dispatch was
-- indistinguishable from the 104 benign ones.
--
-- WHY 'dispatched' AND NOT 'reaped'. These rows are not reaped work — nothing
-- was killed and no runtime was lost. Reusing 'reaped' would put a fabricated
-- incident into the very ledger FIX-971/FIX-979 built to keep honest. They are
-- successful dispatches, and they get a status that says so. completed_at is set
-- to started_at because that is the truth: the dispatch began and ended in the
-- same instant. The resulting zero span is already handled — FIX-978 excludes
-- zero-span writers from rate baselines by design.
--
-- Idempotent: re-running matches nothing once the backfill has run.
-- =============================================================================

UPDATE public.data_sync_log
   SET status       = 'dispatched',
       completed_at = started_at,
       metadata     = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                        'reconciled_by',   'FIX-1054',
                        'reconciled_at',   now(),
                        'reconcile_note',
                        'Dispatch marker written by the Vercel-cron canary and never closed, '
                        'because the dispatch is instantaneous and no code path owned the close. '
                        'Retro-closed at started_at (zero span, which is the truth) and moved off '
                        'the in-flight vocabulary. NOT a reaped run: nothing was killed and no '
                        'runtime was lost.')
 WHERE pipeline     = 'nightly-sync'
   AND status       = 'triggered'
   AND completed_at IS NULL;
