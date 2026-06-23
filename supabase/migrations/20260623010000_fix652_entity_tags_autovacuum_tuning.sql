-- FIX-652 — autovacuum tuning for entity_tags.
--
-- Background: the nightly rule tagger rebuilds the 'size' (and 'pre_vote'
-- /'internal') rule-tag categories by DELETE-all + INSERT…SELECT.
-- rebuild_financial_entity_size_tags() alone deletes and re-inserts ~2.33M
-- 'financial_entity'/'size' rows every night (FIX-443/444). A churn of that size
-- on DEFAULT autovacuum (vacuum_scale_factor=0.2 → only triggers at 20% dead) lets
-- dead tuples pile up between runs: entity_tags bloated to ~2.2 GB at ~16% dead
-- ratio, and on the 2026-06-22 run autovacuum was still working the table
-- *concurrently* with the rebuild, competing for IO on the cache-starved Pro box.
-- Same fingerprint as FIX-650 (entity_connections) and the original FIX-331.
--
-- entity_tags is a request-path read (tags render on entity pages + lists), so
-- keeping the visibility map fresh also protects the planner's index-only scans
-- for those reads.
--
-- Fix mirrors FIX-331's entity_connections tuning: trigger autovacuum at 5% dead
-- tuples and re-analyze at 2%, so reclaim keeps pace with the nightly churn
-- instead of lagging days behind. This does NOT compact the existing ~2.2 GB of
-- bloat — that needs a one-time VACUUM FULL / pg_repack (FIX-652 reclaim step,
-- run off-peak; see done.log / the FIX-650 reclaim precedent). It prevents the
-- bloat from re-accumulating after the reclaim.

ALTER TABLE public.entity_tags SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
