-- FIX-360 (IOWait Round 1, FIX-C) — compound index on
-- public.entity_connections(from_id, connection_type) to back the worst-hit
-- user-facing query in the audit (docs/audits/2026-05-24-iowait-diagnosis.md
-- §B #9 — 326 calls × 3,995 ms × 10.9M blks at 3.9% cache hit pct).
--
-- Branch A — index missing. Investigation evidence:
--
--   1. pg_indexes WHERE tablename = 'entity_connections' (local, 2026-05-24):
--      entity_connections_from         (from_type, from_id)              128 MB
--      entity_connections_to           (to_type,   to_id)                 59 MB
--      entity_connections_type         (connection_type)                  35 MB
--      entity_connections_amount       (amount_cents) WHERE NOT NULL      23 MB
--      entity_connections_derived_at   (derived_at)                       35 MB
--      entity_connections_evidence_source                                 36 MB
--      entity_connections_strength     (strength DESC)                   117 MB
--      entity_connections_from_type_from_id_to_type_to_id_connecti_key   470 MB
--      entity_connections_pkey         (id)                              227 MB
--
--      No index on (from_id, ...) alone. entity_connections_from leads
--      with from_type — useless when the query omits from_type. The
--      unique constraint leads with from_type too. The only candidate
--      the planner can use for `WHERE from_id = X AND connection_type = Y`
--      is the (from_type, from_id) index, which forces a per-row filter
--      by connection_type.
--
--   2. EXPLAIN (ANALYZE, BUFFERS) on local (2.52M rows, busiest from_id
--      from "SELECT from_id, count(*) ... GROUP BY ... ORDER BY count DESC
--      LIMIT 1" = c07a4ff4-6998-4a04-a02e-aaf98f5aa716, 2998 rows):
--
--      Limit  (cost=0.43..2113.03 rows=50)
--        Buffers: shared read=15998
--        ->  Index Scan using entity_connections_from on entity_connections
--              Index Cond: (from_id = 'c07a4ff4-...'::uuid)
--              Filter: (connection_type = 'donation'::connection_type)
--              Rows Removed by Filter: 2998
--              Buffers: shared read=15998
--      Execution Time: 117.745 ms (warm)
--
--      The planner reads 16k buffers (130 MB) and discards every row
--      because none of c07a4ff4's 2998 connections are 'donation'. That
--      same shape on prod's 5.18M-row table with the cold-cache pressure
--      from concurrent rebuild chunks is what produces the audit's 3.9%
--      hit ratio.
--
-- Expected after-state: a tight 2-key Index Scan that touches sub-100
-- buffers per call. Verification appendix added to
-- docs/audits/2026-05-24-iowait-diagnosis.md §I Finding #4 outcome.
--
-- Plain CREATE INDEX (no CONCURRENTLY). entity_connections is 5.12 GB on
-- prod with 2.75 GB of indexes already; a btree on (from_id,
-- connection_type) over 5.18M rows is in the ~100-200 MB range. The build
-- will hold an ACCESS EXCLUSIVE-equivalent lock for the build duration
-- (~30s on prod), but writes to entity_connections only happen during
-- the chunked rebuild on Sun+Wed 08:00 UTC. Today is 2026-05-24 (Sun);
-- if this migration applies post-rebuild, the lock window is harmless.
-- CONCURRENTLY+supabase-db-push transactionality is the recurring blocker
-- on Pro Small; the brief lock here is the lesser evil.

CREATE INDEX IF NOT EXISTS entity_connections_from_id_connection_type
  ON public.entity_connections (from_id, connection_type);

COMMENT ON INDEX public.entity_connections_from_id_connection_type IS
  'Backs the graph edge fetch shape WHERE from_id = $1 AND connection_type = $2 '
  '(audit 2026-05-24 §B #9 — worst cache-hit ratio in the top 25 queries). '
  'FIX-360 (IOWait Round 1).';
