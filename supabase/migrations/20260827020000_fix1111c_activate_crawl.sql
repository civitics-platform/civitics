-- =============================================================================
-- FIX-1111c — PHASE 4: the crawl goes live, and the weekly batch job stands down.
--
-- Craig-gated, taken 2026-08-27 ~01:25 UTC (an empty slot: the burst ledger's
-- 18:00–01:00 window, nothing running on prod, nightly-sync 35 min out and on
-- its light Thursday path).
--
-- Done HERE, in a migration, rather than as an ad-hoc prod write — the same
-- reasoning FIX-1101 section 6 used for the un-pause it performed: the change
-- is then recorded in the repo with its justification beside it, and there is
-- no state in which prod carries the activation without the machinery.
--
-- alter_job by NAME (playbook D3), never unschedule+schedule: the entire
-- diagnosis of these jobs rests on their cron.job_run_details history, and
-- rescheduling would mint new jobids and orphan it.
--
-- ═══ WHAT CHANGES ══════════════════════════════════════════════════════════
--   ec-crawl                    inactive -> ACTIVE     (*/15, one unit/firing)
--   rebuild-ec-incremental      ACTIVE   -> paused     (jobid 2, `0 8 * * 3`)
--   rebuild-ec-incremental-mon  paused   -> paused     (jobid 22, asserted only)
--
-- jobid 2 is paused because it is THE SAME WORK AS A BURST. Leaving it on would
-- mean the arm runs twice — once as a paced crawl and once as the 21,875 s
-- Wednesday batch that is the reason this line of work exists.
--
-- BOTH JOBS STAY DEFINED, deliberately. They are not dropped, because their
-- cron.job_run_details history is the evidence base for FIX-969, FIX-1069,
-- FIX-1101 and FIX-1107, and unscheduling would orphan it.
--
-- ⚠ UN-PAUSE CONDITION FOR JOBIDS 2 AND 22: **never, unless the crawl is
-- retired.** They are not a fallback to be switched on when the crawl looks
-- slow — a slow crawl is the crawl working (see the backoff sensor). Turning
-- one back on while ec-crawl is active reintroduces exactly the burst this
-- replaces, and the procedure's advisory lock will NOT save you: it serializes
-- the two, it does not stop the batch from spending the whole day's I/O budget
-- once it gets the lock.
--
-- ═══ WHAT THE FIRST FIRINGS WILL LOOK LIKE — so a quiet log is not misread ══
-- Prod's dirty set at activation is 2,733 rows / 2,518 donors = ~157 donors per
-- window, against the 35,363/window that produced the ~346 s figure. The first
-- cycle's windows will therefore run in SECONDS, not minutes. That is correct
-- and expected, not a sign the crawl is skipping work. The first units with
-- real cost are `_contracts` (~307 s) and `_external` (~878 s), which at one
-- unit per firing land roughly 5.75 h in.
--
-- The cycle is 16 windows + 10 arms = up to 26 units ~ 6.5 h at */15, after
-- which min_cycle_interval_minutes (360) holds the next cycle off for 6 h.
--
-- Cross-ref FIX-1111 / FIX-1111b (the crawl and its corrected sensor),
-- FIX-1107 (the I/O budget), FIX-969 (the regime), FIX-1101, FIX-1052 (whose
-- "16:00, after the EC work" premise this dissolves — see the burst ledger 7).
-- =============================================================================
DO $$
DECLARE
  v_crawl  record;
  v_wed    record;
  v_mon    record;
BEGIN
  SELECT jobid, active INTO v_crawl FROM cron.job WHERE jobname = 'ec-crawl';
  SELECT jobid, active INTO v_wed   FROM cron.job WHERE jobname = 'rebuild-ec-incremental';
  SELECT jobid, active INTO v_mon   FROM cron.job WHERE jobname = 'rebuild-ec-incremental-mon';

  IF v_crawl.jobid IS NULL THEN
    RAISE EXCEPTION '[FIX-1111c] ec-crawl does not exist — 20260827000000 has not been applied';
  END IF;

  -- ── activate the crawl ────────────────────────────────────────────────────
  IF v_crawl.active THEN
    RAISE NOTICE '[FIX-1111c] ec-crawl (jobid %) already active — left alone', v_crawl.jobid;
  ELSE
    PERFORM cron.alter_job(v_crawl.jobid, active := true);
    RAISE NOTICE '[FIX-1111c] ec-crawl (jobid %) ACTIVATED — one EC unit every 15 minutes', v_crawl.jobid;
  END IF;

  -- ── stand the Wednesday batch down ────────────────────────────────────────
  IF v_wed.jobid IS NULL THEN
    RAISE WARNING '[FIX-1111c] rebuild-ec-incremental not found — expected jobid 2';
  ELSIF NOT v_wed.active THEN
    RAISE NOTICE '[FIX-1111c] rebuild-ec-incremental (jobid %) already paused — left alone', v_wed.jobid;
  ELSE
    PERFORM cron.alter_job(v_wed.jobid, active := false);
    RAISE NOTICE '[FIX-1111c] rebuild-ec-incremental (jobid %) PAUSED — the crawl now owns this arm', v_wed.jobid;
  END IF;

  -- ── assert the Monday batch is still down (never un-paused here) ──────────
  IF v_mon.jobid IS NULL THEN
    RAISE WARNING '[FIX-1111c] rebuild-ec-incremental-mon not found — expected jobid 22';
  ELSIF v_mon.active THEN
    RAISE WARNING '[FIX-1111c] rebuild-ec-incremental-mon (jobid %) is ACTIVE and should not be — pausing', v_mon.jobid;
    PERFORM cron.alter_job(v_mon.jobid, active := false);
  ELSE
    RAISE NOTICE '[FIX-1111c] rebuild-ec-incremental-mon (jobid %) confirmed paused', v_mon.jobid;
  END IF;
END;
$$;
