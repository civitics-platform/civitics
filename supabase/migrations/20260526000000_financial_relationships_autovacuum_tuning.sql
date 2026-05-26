-- FIX-346 — autovacuum tuning for financial_relationships.
--
-- Background: FIX-345 diagnostic (2026-05-24) surfaced that a cold EXISTS
-- probe filtered by `relationship_type IN ('contract','grant')` dirtied
-- 1,418 pages on a single read — visibility-map bloat from autovacuum not
-- keeping up with FEC ingestion + merge churn (FIX-375, FIX-379) on this
-- table. Compounded by a 31-day idle-in-transaction connection terminated
-- on 2026-05-24 that had been blocking VACUUM for that entire window.
--
-- Re-measure on 2026-05-25 (one day after the blocking-tx termination):
--   n_live_tup:       6,182,185
--   n_dead_tup:       1,170,794
--   dead_pct:         15.92%
--   last_autovacuum:  2026-05-13 (12 days ago)
--   last_autoanalyze: 2026-05-17 (8 days ago)
--
-- The 31-day idle-in-tx termination did NOT trigger catch-up — default
-- autovacuum (vacuum_scale_factor=0.2) only fires at 20% dead tuples and
-- this table sat at 16% with no recent run. Mirrors the structural
-- problem FIX-331 solved for entity_connections: bulk-load + churn cadence
-- is too fast for the 20% default to keep visibility maps fresh between
-- read-path queries.
--
-- Fix: tighten to the FIX-331 thresholds (vacuum at 5%, analyze at 2%) so
-- autovacuum runs within hours of each FEC ingest, not days. The one-off
-- VACUUM (ANALYZE) to clear current bloat runs separately as a script —
-- VACUUM cannot run inside a function/transaction block, so it can't ship
-- as part of this migration.

ALTER TABLE public.financial_relationships SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
