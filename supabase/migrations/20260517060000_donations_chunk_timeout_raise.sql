-- =============================================================================
-- FIX-291 — raise rebuild_entity_connections_donations() statement_timeout
-- from 60min → 90min.
--
-- The donations chunk is the long pole of the chunked rebuild (FIX-263) — it
-- aggregates 4.1M+ financial_relationships rows (donations + ie_support) into
-- entity_connections, plus the recipient_count UPDATE for individual donors
-- (FIX-194 block 1b). As FEC data has grown through May 2026, the chunk
-- pushed past 60 min on prod (last successful prod run 2026-05-13: 60 min
-- for donations, exactly at the cap). That timeout was the trigger for the
-- 5/13 partial run and the 5/14/5/17 GHA SIGTERMs documented in
-- docs/audits/missing-nightlies-2026-05-10-to-16.md.
--
-- Paired with the GHA workflow split (FIX-291) — rebuild moves to its own
-- 4-hour-budget workflow on a Sun + Wed cadence so the donations chunk
-- doesn't have to fight the daily nightly's 120-min wall-clock pressure.
--
-- Implementation: function-level GUC via ALTER FUNCTION. PostgreSQL stacks
-- the function-level statement_timeout above whatever the session has set,
-- so this value wins inside the donations chunk body regardless of the
-- caller's session timeout. No CREATE OR REPLACE FUNCTION needed — body
-- is unchanged.
-- =============================================================================

ALTER FUNCTION public.rebuild_entity_connections_donations()
  SET statement_timeout = '90min';
