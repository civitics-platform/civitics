-- FIX-1291 — reap_stale_sync_log() spares a heartbeating row; usaspending_bulk
-- (and _assistance) held in rollup_watch_overrides (cc-214).
--
-- WHY (a). The reaper is age-only: a `running` row whose started_at is older
-- than stale_minutes is flipped to `reaped`, whatever the process behind it is
-- doing. The nightly calls it with 60 (packages/data/src/pipelines/index.ts),
-- so ANY GHA-driven run that spans a nightly start and is more than an hour old
-- is reaped while alive. Measured 2026-10-08 (docs/cc/reports/cc-209.md §4):
-- the USASpending contracts row (started 17:12:58Z) was reaped at 21:00:54Z;
-- its GHA process ran on until the 350-min cap at 23:04:58Z. mark-killed then
-- found a row that was neither `running` nor terminal and no-op'd — the longest
-- run of the week left no kill marker at all (mark-killed's half is the code
-- commit; this is the reaper's half).
--
-- WHAT (a). ONE change to the body, at the age predicate (from
-- 20260731000000_fix944_resumable_donor_rollup.sql:399-400): staleness is
-- measured from `metadata.heartbeat_at` when the row carries one, else from
-- started_at exactly as before. The USASpending pipeline stamps heartbeat_at at
-- every 1,000-row flush and part boundary (FIX-1274), so it is never reaped
-- while it writes; a silent row — heartbeat or not — is reaped on the same
-- 60-minute rule as today. The reap_note gains the sentence that says so.
-- The stamp is cast only when it LOOKS like a timestamp: the nightly reaps
-- every pipeline's rows in one statement, and one malformed stamp must not
-- make that statement throw for all of them.
--
-- Prod md5(prosrc) before this file = f333eee47eea535e9ed0deb76d775deb = the
-- 0731 body (cc-214 Phase 0, rule 34). No later migration redefines it:
-- 20260714000000_fix834 REVOKEs/GRANTs it, and 0731 then re-GRANTed
-- authenticated (prod's proacl reads {postgres, service_role, authenticated}).
-- The grants are restated below as 0731 — the file that last stated them —
-- stated them; that authenticated re-grant contradicting FIX-834 is reported
-- in cc-214, not changed here. No proconfig, before or after.
--
-- WHY (b). usaspending-bulk.yml has been workflow_dispatch-only since
-- 2026-10-08 (its Thu 10:00Z schedule came off in cc-209), but the unschedule
-- shipped without the rollup_watch_overrides hold row the convention asks for
-- in the SAME change (20260903000000_fix1135_1059_1011:74-79), so the FIX-1011
-- GHA census kept the two pipelines on the canary's watch list as overdue.
-- A hold keeps them IN pipelines[] with both thresholds NULL (that file's
-- header) — the watch list does not narrow. `note` is NOT NULL on this table.
-- The hold_reason does not start with 'prod session held: ', so a FIX-950
-- session release (clearGuardedHolds) can never clear it.
--
-- ROLLBACK.
--   (a) CREATE OR REPLACE public.reap_stale_sync_log from
--       20260731000000_fix944_resumable_donor_rollup.sql:372-403 (body
--       unchanged there), then its two GRANTs and the COMMENT.
--   (b) DELETE FROM public.rollup_watch_overrides
--        WHERE pipeline IN ('usaspending_bulk', 'usaspending_bulk_assistance')
--          AND hold_reason LIKE 'FIX-1291%';
--   The schedule's return (FIX-1291 step 4, FIX-1274 shape (2)) deletes (b)
--   in the same migration that restores the cron.

CREATE OR REPLACE FUNCTION public.reap_stale_sync_log(stale_minutes INT DEFAULT 10)
RETURNS TABLE(id UUID, pipeline TEXT, reaped_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.data_sync_log AS dsl
     SET status = 'reaped',
         error_message = format(
           'reaped_orphan — no completion after %s min; the pipeline''s own '
           'backend is gone. started_at..reap time is NOT a runtime (FIX-944).',
           stale_minutes),
         -- FIX-944: do NOT overwrite completed_at with NOW(). A row reaped
         -- hours after its backend died would otherwise report the gap as
         -- duration, which is exactly how four days of 6h statement_timeout
         -- cancellations were misread as 20h runs.
         completed_at = dsl.completed_at,
         metadata = COALESCE(dsl.metadata, '{}'::jsonb) || jsonb_build_object(
           'reaped', true,
           'reaped_at', NOW(),
           'reap_stale_minutes', stale_minutes,
           'observed_running_for_minutes',
             round(EXTRACT(epoch FROM (NOW() - dsl.started_at)) / 60)::int,
           'reap_note',
             'Elapsed since started_at is an UPPER BOUND on runtime, not a '
             'measurement. For pg_cron pipelines the true end is in '
             'cron.job_run_details.end_time. Reaped because the row''s last '
             'heartbeat (metadata.heartbeat_at, FIX-1291) - or started_at, '
             'when it never stamped one - is older than reap_stale_minutes.')
   WHERE dsl.status = 'running'
     -- FIX-1291: a row that heartbeats is alive, however old it is.
     AND COALESCE(
           CASE WHEN dsl.metadata->>'heartbeat_at' ~ '^\d{4}-\d{2}-\d{2}[ T]'
                THEN (dsl.metadata->>'heartbeat_at')::timestamptz END,
           dsl.started_at)
         < NOW() - (stale_minutes::text || ' minutes')::interval
  RETURNING dsl.id, dsl.pipeline, NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO authenticated;

COMMENT ON FUNCTION public.reap_stale_sync_log(INT) IS
  'FIX-255/944/1291 — flip stranded data_sync_log ''running'' rows to ''reaped''. '
  'FIX-944 changed the status from ''failed'' (indistinguishable from a '
  'pipeline-reported error) to ''reaped'', and stopped overwriting completed_at '
  'with NOW() — the reap timestamp lives in metadata.reaped_at so the '
  'started_at..reaped_at gap is never mistaken for a runtime. FIX-1291: '
  'staleness is measured from metadata.heartbeat_at when the row stamps one, '
  'else from started_at, so a long run that heartbeats is never reaped alive.';

-- (b) The hold rows — the convention's half that cc-209's unschedule missed.
INSERT INTO public.rollup_watch_overrides (pipeline, held_since, hold_reason, note)
VALUES
  ('usaspending_bulk', now(),
   'FIX-1291 — dispatch-only since 2026-10-08; the catch-up is a supervised op (cc-215); '
   'the schedule returns with FIX-1274 shape (2)',
   'FIX-1291 (cc-214) — usaspending-bulk.yml lost its Thu 10:00Z schedule on 2026-10-08 (cc-209); '
   'this hold is the rollup_watch_overrides row that unschedule should have carried '
   '(20260903000000 convention). Delete it in the migration that restores the schedule.'),
  ('usaspending_bulk_assistance', now(),
   'FIX-1291 — dispatch-only since 2026-10-08; the catch-up is a supervised op (cc-215); '
   'the schedule returns with FIX-1274 shape (2)',
   'FIX-1291 (cc-214) — usaspending-bulk.yml lost its Thu 10:00Z schedule on 2026-10-08 (cc-209); '
   'this hold is the rollup_watch_overrides row that unschedule should have carried '
   '(20260903000000 convention). Delete it in the migration that restores the schedule.')
ON CONFLICT (pipeline) DO NOTHING;
