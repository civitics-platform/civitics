-- FIX-832 — move official_donor_rollup_mv refresh from WEEKLY to DAILY so a
-- freshly-ingested official appears in the graph next-day, not up to 7 days late.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- donor-rollup-refresh was pg_cron '0 8 * * 2' (Tue weekly) via
-- refresh_official_donor_rollup_incremental(), on the FIX-704 assumption that
-- "donations only change on the FEC Sunday ingest." FEC now lands ~nightly
-- (fec_bulk), so any recipient whose donation rows were (re)written since the
-- last Tuesday sat in the graph's RAW fallback for up to ~7 days — the FIX-809
-- cause (76 officials incl. McConnell stranded 2026-07-14, all with
-- max(updated_at) > watermark, i.e. a plain incremental catches them). This
-- migration changes the CADENCE only; the mechanism (chunked, watermark-driven,
-- advisory-locked, work_mem-bounded incremental over the FR.updated_at dirty set)
-- is unchanged (FIX-704), and the FIX-705 monthly orphan sweep is untouched.
--
-- ── Cost (measured on prod) ──────────────────────────────────────────────────
-- The nightly FEC touches nearly the whole active recipient set every night, so
-- the DAILY dirty set is ≈ the weekly one: 1-day = 7,428 recipients vs 7-day =
-- 8,164 (2026-07-13/14). Representative runtimes: 7,440 recipients / 31 min
-- (2026-07-07 weekly), 8,164 / ~64 min (2026-07-14 early). So daily is NOT much
-- smaller per run than weekly — it is the same bounded ~30-60 min chunked job,
-- run 7×/week instead of 1×. That aggregate cost is the price of next-day
-- freshness; event-triggering off the FEC watermark would collapse to the same
-- daily cadence anyway (FEC lands nightly), so a plain daily pg_cron is simpler.
--
-- ── Slot: 09:00 UTC daily ────────────────────────────────────────────────────
-- After the nightly fec_bulk (healthy completion ~08:20 UTC; 05:30-06:45 start),
-- after rebuild-ec (08:00 → ~08:42), inside the off-peak window before the
-- US-East ramp (~10:00-11:00 UTC), and clear of the 02:00 nightly + the monthly
-- sweeps (12:00-12:30 on the 1st). It reads FR directly (independent of the edge
-- rebuild), and its advisory lock differs from the rebuild's, so a rare overlap
-- with a long Wednesday rebuild tail is IO-only, not a correctness hazard; a
-- late-FEC night self-heals via the next day's run.
--
-- Idempotent (FIX-688 pattern): unschedule by name, then reschedule. Same command
-- (CALL refresh_official_donor_rollup_incremental()); the job stays active.

SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'donor-rollup-refresh';

SELECT cron.schedule(
  'donor-rollup-refresh',
  '0 9 * * *',
  $$CALL public.refresh_official_donor_rollup_incremental();$$
);
