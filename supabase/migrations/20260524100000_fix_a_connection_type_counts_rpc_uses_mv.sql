-- FIX-358 (IOWait Round 1, FIX-A) — re-affirm get_connection_type_counts()
-- reads the materialized connection_type_counts table exclusively, and
-- tighten the function-level statement_timeout from FIX-298's 120s safety
-- net (sized for live aggregation over 5.1M rows) down to 5s — a 16-row
-- table read should be sub-50ms.
--
-- Background: the 2026-05-24 IOWait diagnosis (docs/audits/2026-05-24-iowait
-- -diagnosis.md §B #2) showed get_connection_type_counts() consuming 38.9M
-- block reads across 1,028 calls (~295 MB per call) — exactly the shape of
-- live GROUP BY aggregation over entity_connections.connection_type. FIX-338
-- (20260523040000_connection_type_counts_table.sql) already swapped the RPC
-- body to read from the public.connection_type_counts table, but the audit's
-- pg_stat_statements numbers either reflect pre-FIX-338 history or a missed
-- deploy. Re-issuing CREATE OR REPLACE here is idempotent and guarantees
-- prod is on the materialized-table read path.
--
-- Refresh hook: public.refresh_connection_type_counts() is called at the
-- end of every chunked rebuild from
-- packages/data/src/scripts/rebuild-entity-connections.ts AND from the
-- umbrella public.rebuild_entity_connections() RPC body (FIX-338 +
-- 20260523040002_umbrella_rebuild_calls_refresh.sql). No live-compute path
-- remains; this body MUST stay a pure read of the 16-row table.

CREATE OR REPLACE FUNCTION public.get_connection_type_counts()
RETURNS TABLE(connection_type TEXT, total BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT connection_type, total
  FROM public.connection_type_counts
  ORDER BY total DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_connection_type_counts()
  TO authenticated, service_role;

-- Tightened from 120s (FIX-298's live-aggregate ceiling) to 5s. A read of
-- 16 rows from a 1-page table should complete in sub-50ms; 5s is now the
-- safety net, not the design target. If this trips, something is wrong
-- with the connection_type_counts table itself (missing/corrupt refresh)
-- and should fail loudly rather than mask the cost.
ALTER FUNCTION public.get_connection_type_counts()
  SET statement_timeout = '5s';

COMMENT ON FUNCTION public.get_connection_type_counts() IS
  'Reads public.connection_type_counts exclusively. Refresh hook lives in '
  'packages/data/src/scripts/rebuild-entity-connections.ts and the umbrella '
  'rebuild_entity_connections() body. FIX-358 (IOWait Round 1) — re-issued '
  'to confirm the materialized read path and lowered statement_timeout '
  'from 120s to 5s (audit 2026-05-24 §B #2).';
