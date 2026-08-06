-- FIX-968 — (1) a same-day backstop firing for donor-rollup-refresh, and
--           (2) the first detector that reads cron.job_run_details, so a
--               pg_cron job that never STARTED stops being invisible.
--
-- ═══ Why ═════════════════════════════════════════════════════════════════════
-- jobid 24 (`donor-rollup-refresh`, `0 9 * * *`) died at STARTUP on 08-03,
-- 08-04 and 08-05: `cron.job_run_details.return_message = 'job startup timeout'`,
-- ending 10.1–11.4 s after start. The FIX-944 resumable procedure never ran, so
-- data_sync_log has no row at all for those days and the watermark stayed parked
-- at 2026-08-02 05:54.
--
-- Measured consequence on prod (2026-08-06, full numbers in
-- docs/audits/2026-08-06-fix968-cron-window-envelopes.md): 3,401 of 6,770
-- officials with live donations carried a wrong official_donor_totals row —
-- 2,446 of them had NO row at all — understating $2,079,909,441. Trump read
-- $500 against $42,292,553 live on every surface that trusts odt.
--
-- ═══ What the investigation actually found ═══════════════════════════════════
-- The FIX-968 bullet's stated cause — "the nightly refresh_derived_mvs window
-- stretched to 06:00–09:29 so the box is saturated at 09:00" — is true for
-- 08-05 ONLY. On 08-03 the MV block finished 06:15 (taggers 06:48) and on 08-04
-- it finished 06:10 (taggers 06:51); both were long done by 09:00. The
-- saturation on those days was OTHER cron jobs burning the full 6 h
-- statement_timeout: jobid 22 (08-03, 08:00→14:00), jobids 26 + 17 (08-04,
-- 08:15→14:15 and 08:45→14:45).
--
-- And 2 of the 9 startup timeouts in the retained window landed at 03:30 and
-- 04:15 — slots with ZERO cron overlap — during overnight GHA fec_bulk retries.
--
-- Mechanism: `cron.use_background_workers = off`, so pg_cron does not take a
-- bgworker slot per job. It opens a fresh libpq connection to localhost and
-- gives it a fixed ~10 s window. Every observed timeout bottoms out at
-- 10.1–11.4 s — that window exactly. On a 2-vCPU Pro Small under sustained load
-- from ANY source, connection setup blows 10 s and the firing is abandoned
-- silently: no queue, no retry, nothing written anywhere but one
-- job_run_details row.
--
-- So this is not a 09:00 problem, and moving jobid 24 to a different hour would
-- only relocate its exposure. There is also no band that is both unscheduled and
-- off-peak: 15:00–02:00 UTC is the only unscheduled band and it is peak US
-- traffic plus where fec_bulk retries land.
--
-- ═══ Change 1 — `0 9 * * *` → `0 9,12 * * *` ════════════════════════════════
-- 09:00 stays the primary slot (the FIX-832 rationale for it is unchanged:
-- after the nightly fec_bulk, after rebuild-ec, before the US-East ramp). 12:00
-- is a same-day backstop, so a starved START degrades from "silently skipped
-- for 24 h" to "runs three hours later".
--
-- It is nearly free because the procedure is watermark-gated: 8 of jobid 24's
-- 23 retained runs completed in ≤0.1 s on an empty dirty set. The three states:
--   * 09:00 starved      → 12:00 does the drain
--   * 09:00 ran clean    → 12:00 no-ops in ~0.1 s (empty dirty set)
--   * 09:00 still draining → 12:00 hits the advisory lock and logs
--                            status='skipped', which is already a handled state
--                            (donor-rollup-sweep.ts treats it as "nothing to do")
--
-- 12:00 keeps the job inside the existing 09:00–15:00 donor-rollup window, so no
-- operational-convention change and no documentation moves. It is clear of every
-- other job except the monthly-1st jobid 14 (fe-totals-reconcile, p50 271 s),
-- whose overlap is IO-only — different advisory lock.
--
-- Deliberately NOT a third firing at 15:00: a 15:00 start of the ~3 h 35 m drain
-- would run to ~18:30 UTC, squarely into active hours, which the
-- no-heavy-prod-ops-during-active-hours rule exists to prevent.
--
-- ═══ Change 2 — check_cron_job_health() ═════════════════════════════════════
-- The FIX-944 canary DID fire here (sync-canary-check failed 08-04 and 08-05, at
-- the first run where hours_since_complete crossed its 48 h threshold). Two gaps
-- it cannot close by design:
--
--   1. It watches the CONSEQUENCE (odt is stale), never the CAUSE. Nothing in
--      the codebase reads cron.job_run_details, so "the job never started" is
--      indistinguishable from "the job ran and had nothing to do", and the 48 h
--      threshold means a startup timeout is invisible for two days.
--   2. It covers 1 of 21 jobs. Five different jobs were starved in this window
--      (24, 27, 29, 13, 2, 12, 22). jobid 12 has failed 4 of its 5 runs at the
--      6 h ceiling with nothing watching it at all.
--
-- This is the smallest thing that makes the silence visible, and it generalises
-- to every job rather than being another per-job bolt-on.
--
-- Escalation split follows the FIX-943 precedent (report the cause, escalate on
-- the consequence — cf. bloat_degraded vs vm_degraded):
--
--   * `startup_timeouts` — ESCALATES. A firing that was silently dropped. This
--     is exactly the FIX-968 defect and it always means work did not happen.
--   * `missing_daily` — ESCALATES. A job whose schedule fires at least daily but
--     which has no job_run_details row in the window at all, i.e. pg_cron itself
--     never fired it.
--   * `timeout_blowouts` — REPORT ONLY. Seven jobs have blown the 6 h
--     statement_timeout at least once and jobid 12 does it near-weekly.
--     Escalating on it would fail the canary most Tuesdays until the rollup arms
--     are chunked (PR 3), which would train the alert to be ignored — the exact
--     failure mode FIX-943 called out. Recorded so it stays greppable.
--   * `runs` — REPORT ONLY. The full window trail, so a regression's onset is
--     findable after the fact (the FIX-885/FIX-943 "record it on every run"
--     lesson: FIX-884 went unnoticed ~4 weeks partly because nothing logged it).
--
-- Cross-ref FIX-944, FIX-951, FIX-965, FIX-952, FIX-934, FIX-943, FIX-885.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Reschedule jobid 24 with the 12:00 backstop.
--
--    DELIBERATELY `cron.alter_job` IN PLACE, NOT the FIX-688 unschedule+schedule
--    idiom used by every other cron migration here. `cron.unschedule` +
--    `cron.schedule` mints a NEW jobid (measured on local: 24 → 42), and
--    `cron.job_run_details` is keyed by jobid. Doing that here would:
--      * orphan the very run history that diagnosed this bug — jobid 24's three
--        `job startup timeout` rows are the evidence, and they would stop
--        joining to the live job;
--      * make the new check_cron_job_health() below report `missing_daily` for
--        donor-rollup-refresh on the next canary run, because a brand-new jobid
--        has no run rows — a self-inflicted false positive on deploy day, from
--        the detector shipped in the same migration to catch exactly that shape.
--
--    alter_job keeps jobid 24, its history, and the detector's continuity.
--    Still idempotent, and still falls back to cron.schedule on an environment
--    where the job does not exist yet.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'FIX-968: pg_cron not installed — skipping donor-rollup-refresh reschedule';
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'donor-rollup-refresh';

  IF v_jobid IS NULL THEN
    PERFORM cron.schedule(
      'donor-rollup-refresh',
      '0 9,12 * * *',
      $cron$CALL public.refresh_official_donor_rollup_incremental();$cron$
    );
    RAISE NOTICE 'FIX-968: donor-rollup-refresh created at 0 9,12 * * *';
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, schedule := '0 9,12 * * *');
    RAISE NOTICE 'FIX-968: donor-rollup-refresh (jobid %) moved to 0 9,12 * * * in place', v_jobid;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. check_cron_job_health() — the first reader of cron.job_run_details.
--
--    SECURITY DEFINER owned by postgres is load-bearing, not hygiene theatre:
--    `postgres` holds USAGE on schema `cron`, `service_role` does NOT (it has
--    the table grants but cannot reach the schema). Measured on prod
--    2026-08-06. So the canary — which calls this as service_role via
--    createAdminClient — can only read these tables through a definer function.
--    Same shape as check_rebuild_autovacuum_status (FIX-650/885).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_cron_job_health(
  p_lookback_hours int DEFAULT 26
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  v_since           timestamptz := now() - make_interval(hours => p_lookback_hours);
  v_startup         jsonb;
  v_missing         jsonb;
  v_blowouts        jsonb;
  v_runs            jsonb;
BEGIN
  -- Degrade cleanly where pg_cron is absent rather than raising: the canary
  -- treats a detector error as non-fatal, but a shaped empty answer keeps the
  -- meta-row trail honest instead of silently dropping the section.
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object(
      'available',        false,
      'lookback_hours',   p_lookback_hours,
      'startup_timeouts', '[]'::jsonb,
      'missing_daily',    '[]'::jsonb,
      'timeout_blowouts', '[]'::jsonb,
      'runs',             '[]'::jsonb
    );
  END IF;

  -- ESCALATING — a firing pg_cron abandoned before the job body ever ran.
  -- On this instance cron.use_background_workers=off, so this is a libpq
  -- connect that could not complete inside pg_cron's ~10 s window.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time' DESC), '[]'::jsonb)
    INTO v_startup
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'schedule',   j.schedule,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1),
             'message',    d.return_message
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%startup timeout%'
  ) s;

  -- ESCALATING — a job scheduled to fire at least daily with NO run row in the
  -- window. pg_cron writes a row for every firing including failures, so an
  -- absent row means the firing never happened at all.
  --
  -- "at least daily" = day-of-month, month and day-of-week fields are all '*'.
  -- That is exact for every schedule in use here (daily jobs are `M H * * *`;
  -- weekly carry a dow, monthly carry a dom). Non-standard syntax (@daily,
  -- step values) is deliberately not matched — a false negative is silent,
  -- which is the safe direction for a detector that escalates.
  --
  -- 26h, not 24h: consecutive firings of an at-least-daily job are at most 24h
  -- apart, so a 26h window always contains one regardless of what time the
  -- canary runs, with 2h of slack for a late start.
  --
  -- Known transient: a genuinely NEW daily job has no run rows until its first
  -- firing, so it reports here for up to a day. That is why the reschedule above
  -- uses cron.alter_job rather than unschedule+schedule — see its comment.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'jobid'), '[]'::jsonb)
    INTO v_missing
  FROM (
    SELECT jsonb_build_object(
             'jobid',    j.jobid,
             'jobname',  j.jobname,
             'schedule', j.schedule
           ) AS t
    FROM cron.job j
    WHERE j.active
      AND split_part(j.schedule, ' ', 3) = '*'
      AND split_part(j.schedule, ' ', 4) = '*'
      AND split_part(j.schedule, ' ', 5) = '*'
      AND NOT EXISTS (
        SELECT 1 FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.start_time >= v_since
      )
  ) m;

  -- REPORT ONLY — a run cancelled by the 6 h statement_timeout on the postgres
  -- role. Real failures, but seven jobs have done it and jobid 12 does it
  -- near-weekly; escalating here would fail the canary most Tuesdays until the
  -- rollup arms are chunked. Kept greppable so the trend is visible.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time' DESC), '[]'::jsonb)
    INTO v_blowouts
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'schedule',   j.schedule,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1)
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%statement timeout%'
  ) b;

  -- REPORT ONLY — the full window trail.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time'), '[]'::jsonb)
    INTO v_runs
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1),
             'status',     d.status
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
  ) r;

  RETURN jsonb_build_object(
    'available',        true,
    'lookback_hours',   p_lookback_hours,
    'startup_timeouts', v_startup,
    'missing_daily',    v_missing,
    'timeout_blowouts', v_blowouts,
    'runs',             v_runs
  );
END;
$$;

-- Script-gated only (canary → createAdminClient → service_role). No anon or
-- authenticated surface — FIX-834/835 hygiene.
REVOKE ALL ON FUNCTION public.check_cron_job_health(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cron_job_health(int) TO service_role;

COMMENT ON FUNCTION public.check_cron_job_health(int) IS
  'FIX-968 — pg_cron firing health over the last p_lookback_hours. '
  'startup_timeouts (a firing pg_cron abandoned before the body ran) and '
  'missing_daily (an at-least-daily job with no run row at all) ESCALATE; '
  'timeout_blowouts (6h statement_timeout) and runs are report-only, per the '
  'FIX-943 cause-vs-consequence split. SECURITY DEFINER because service_role '
  'lacks USAGE on schema cron. Consumed by canary-check.ts. Exists because '
  'jobid 24 was silently skipped for three days in 2026-08 with nothing '
  'reading cron.job_run_details.';
