-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1003 (completion) — finish vacuum ownership for the donor-rollup write
-- path and the never-vacuumed chord matviews.
--
-- 20260809000000 landed the first half: per-table autovacuum overrides on all
-- six rollup arms, plus a scheduled VACUUM (ANALYZE) for the two LARGE arms
-- (official_donor_rollup_mv, treemap_individuals_rollup). This migration closes
-- the three gaps that half left open. It only ADDs; nothing here alters what
-- 20260809000000 established.
--
-- ── WHAT THE WRITE-PATH ENUMERATION ACTUALLY SAYS ──────────────────────────
-- Derived from the catalog on prod 2026-08-09, not from a hand-kept list:
--
--   refresh_official_donor_rollup_incremental()   writes data_sync_log,
--                                                 pipeline_state
--     └─ donor_rollup_rebuild_recipients()        writes official_donor_rollup_mv,
--                                                 official_donor_totals
--          ├─ small_dollar_rebuild_officials()             → official_small_dollar_rollup
--          ├─ sector_affinity_rebuild_officials()          → official_sector_affinity_rollup
--          ├─ treemap_individuals_rebuild_officials()      → treemap_individuals_rollup
--          └─ treemap_individual_brackets_rebuild_officials() → official_donor_bracket_totals
--
-- The four sub-rebuilders call nothing further, so the tree TERMINATES and the
-- six-arm set is complete and closed. All six are relkind='r' despite the `_mv`
-- suffix on official_donor_rollup_mv, so ALTER TABLE ... SET applies cleanly.
--
-- pipeline_state is in that write set and was missed: the chunk loop UPDATEs it
-- once per chunk (29 times in the 2026-08-09 12:00 run) on a 27-live-row table,
-- and it measured 44 dead / 62.0% dead / 0% all-visible on prod. Every pipeline
-- in the system reads it.
--
-- ── GAP 1: the four SMALL arms had an override but no scheduled vacuum ──────
-- Absolute dead-tuple counts on these are small, which is exactly why they look
-- safe and are not. Dead PERCENTAGE is what drives the FIX-884 mechanism: a
-- heap page loses its all-visible mark if ANY tuple on it is dead, and these
-- tables are dense — official_donor_totals is 6,782 rows in 117 pages (58
-- rows/page). A few hundred scattered dead rows can un-mark most of the heap.
-- Measured 2026-08-08, that is precisely what happened: official_donor_totals
-- and official_small_dollar_rollup read 18.6% dead at 32.5% / 31.7%
-- all-visible. Vacuuming all six on prod cost 8.4 s total, and the four here
-- are 966 of the 51,468 pages involved — the marginal cost is noise.
--
-- ── GAP 2: four chord matviews are refreshed CONCURRENTLY and never vacuumed ─
-- refresh_chord_{donor_state_party,donor_type_party,industry,subject_party}
-- _flows_mv() all use REFRESH MATERIALIZED VIEW CONCURRENTLY, which is a
-- DELETE+INSERT diff-merge and therefore leaves dead tuples — unlike a plain
-- REFRESH, which rewrites the heap and leaves none. On prod all four sat at
-- 0.0% all-visible, at 61.4 / 40.8 / 27.3 / 24.9 percent dead.
--
-- Being straight about the payoff: these are 1-5 page relations. The
-- operational cost of their bloat is near zero, and this will NOT help
-- FIX-966 — refresh_chord_donor_state_party_flows_mv() is slow because of what
-- it READS (financial_relationships, 10.2M rows), not the 5 pages it writes.
-- They are included because they are in the same never-vacuumed condition, the
-- fix is free, and leaving a known gap open to be re-discovered later is how
-- FIX-961 became FIX-995.
--
-- ── GAP 3: on tiny relations the THRESHOLD is the binding term ──────────────
-- The autovacuum trigger is `threshold + scale_factor x reltuples`. On a large
-- table the threshold (default 50) is rounding error and only the scale factor
-- is a lever. On a 27-row matview the scale-factor term is 1.35 and the
-- THRESHOLD is the whole trigger — so scale_factor alone would change nothing.
-- chord_donor_type_party_flows_mv needs ~3 refreshes to reach the default
-- 50 + 0.2 x 27 = 55.4, which is why it was found sitting at 43 dead. The
-- tiny relations below therefore get an explicit lowered threshold; the six
-- arms correctly do not (20260809000000 set scale factor only, which is right
-- for them).
--
-- ── WHY 0.05/0.02 ON THE ARMS AND NOT donor_party_rollup_mv's 0.02/0.01 ─────
-- Deliberate, and left as 20260809000000 set it. At 0.05,
-- official_donor_rollup_mv autovacuums roughly every 340 recipients of work
-- (~50,332 dead tuples at ~148 rows/recipient), so a long run trips it a few
-- times mid-flight — cheap here (32,784 pages, seconds) and beneficial. At
-- 0.02 it would fire roughly every 136 recipients, which starts to look like
-- the 2026-08-08 FEC case where financial_relationships' own bulk write tripped
-- its own autovacuum and the two split I/O. The scheduled job below is the
-- primary mechanism; autovacuum is the backstop.
--
-- ── CADENCE: measured, not assumed ─────────────────────────────────────────
-- The open question was whether one daily vacuum is enough, i.e. whether the
-- 12:00 firing runs degraded by the 09:00 firing's dead tuples. Measured on
-- 2026-08-09, both firings complete and against arms manually vacuumed the
-- evening before:
--     09:00 firing   247 recipients   23m43s   5.76 s/recipient
--     12:00 firing 1,447 recipients   2h17m    5.69 s/recipient
-- Per-recipient cost is FLAT across the pair. The 12:00 run was long because it
-- carried 5.9x the recipients, not because it ran dirty. One firing's worth of
-- dead tuples does not measurably degrade the next; the 08-02 → 08-08
-- regression to ~108 s/recipient was cumulative over ~12 firings with no
-- vacuum at all.
--
-- So a twice-daily vacuum keyed to the WRITE cadence is sufficient, and that is
-- what 20260809000000 chose (`5 11,14`, `10 11,14` — just after each 2h FIX-1002
-- budget window closes). The jobs added here extend that same cadence rather
-- than inventing a second one. This is already tighter than the existing
-- precedent, which is twice-WEEKLY: jobids 6/30/31 (ec-, fe-, dpr-vacuum-analyze)
-- all run `0 2 * * 0,3`.
--
-- Cross-ref FIX-943 (the standing bulk-rewrite vacuum rule), FIX-884 (the
-- all-visible / heap-fetch mechanism), FIX-1002 (the bounded run this pairs
-- with), FIX-966 (chord refresh budget — explicitly NOT addressed here).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Scheduled VACUUM (ANALYZE) for the four small arms.
--
--    One job per table, exactly as jobids 6/30/31 do. Two VACUUMs CANNOT share
--    a cron command: pg_cron sends it as a simple query and multiple statements
--    there run in an implicit transaction block, which VACUUM may not.
--
--    :12/:14/:16/:18 past 11 and 14 UTC, behind the existing :05 and :10, so all
--    six land within 13 minutes of each FIX-1002 budget window closing and the
--    next firing always starts clean.
--
--    FIX-688 unschedule+schedule idiom, correct here: these are NEW jobs with no
--    cron.job_run_details history to orphan (unlike jobid 24, where FIX-968
--    deliberately used alter_job to preserve it). It also makes this migration
--    re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_job text;
BEGIN
  FOREACH v_job IN ARRAY ARRAY[
    'odt-vacuum-analyze',
    'osdr-vacuum-analyze',
    'osar-vacuum-analyze',
    'odbt-vacuum-analyze'
  ] LOOP
    BEGIN
      PERFORM cron.unschedule(v_job);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule(
  'odt-vacuum-analyze',
  '12 11,14 * * *',
  'VACUUM (ANALYZE) public.official_donor_totals;'
);

SELECT cron.schedule(
  'osdr-vacuum-analyze',
  '14 11,14 * * *',
  'VACUUM (ANALYZE) public.official_small_dollar_rollup;'
);

SELECT cron.schedule(
  'osar-vacuum-analyze',
  '16 11,14 * * *',
  'VACUUM (ANALYZE) public.official_sector_affinity_rollup;'
);

SELECT cron.schedule(
  'odbt-vacuum-analyze',
  '18 11,14 * * *',
  'VACUUM (ANALYZE) public.official_donor_bracket_totals;'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Autovacuum overrides for the CONCURRENTLY-refreshed chord matviews.
--
--    Threshold-led, per the tiny-relation reasoning in the header: at 20 + 0.05
--    x reltuples, a single CONCURRENT refresh's diff is enough to trip every
--    one of these. No cron job — four more jobs to vacuum 11 pages total would
--    be ceremony, and autovacuum genuinely suffices once the trigger is
--    reachable.
--
--    ALTER MATERIALIZED VIEW, not ALTER TABLE: these are relkind='m'.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER MATERIALIZED VIEW public.chord_donor_state_party_flows_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);
ALTER MATERIALIZED VIEW public.chord_donor_type_party_flows_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);
ALTER MATERIALIZED VIEW public.chord_industry_flows_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);
ALTER MATERIALIZED VIEW public.chord_subject_party_flows_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pipeline_state — in the rollup's write set, missed by the first half.
--
--    The chunk loop UPDATEs it once per chunk to persist the cursor in the same
--    transaction as the chunk's work (FIX-944), so a 29-chunk run turns over a
--    27-row table roughly whole. Measured 62.0% dead at 0% all-visible. Same
--    threshold-led treatment as the chord matviews, for the same reason.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pipeline_state
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. FIX-943 compliance for THIS migration.
--
--    Nothing above bulk-rewrites a table — these are catalog changes and cron
--    rows only — so the standing "end by vacuuming what you rewrote" rule has
--    no work to do here. The one-time cleanup of the backlog these settings now
--    prevent is deliberately NOT run inline: VACUUM cannot run inside a
--    migration's transaction, and the newly-reachable autovacuum triggers plus
--    the 11:12-11:18 / 14:12-14:18 jobs clear it on their own within a day.
-- ─────────────────────────────────────────────────────────────────────────────
