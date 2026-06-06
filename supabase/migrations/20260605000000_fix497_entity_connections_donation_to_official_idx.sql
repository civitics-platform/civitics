-- FIX-497 — partial covering index for the graph group-route donor aggregation.
--
-- /api/graph/group?governingBody=senate (and the legacy chamber=senate branch)
-- pages this query once per 100-member batch, then SUMs per donor:
--
--   SELECT from_id, amount_cents
--   FROM entity_connections
--   WHERE connection_type='donation' AND to_type='official'
--     AND from_type='financial_entity' AND to_id IN (<batch>)
--   ORDER BY id            -- stable pagination key for fetchAllRows .range()
--
-- The existing entity_connections_to (to_type, to_id) index backs the to_id
-- filter but carries neither `id` (so the ORDER BY is an external-merge disk
-- sort) nor the projected columns (so every matching row is a heap fetch). On
-- prod (5.18M-row table; 304,797 donation rows for the 100 sitting senators) the
-- full ordered aggregate was a 70.3 s on-disk sort under cold cache, and the
-- per-page deep-OFFSET form 63.5 s — both blow past the role's 8 s
-- statement_timeout, so fetchAllRows hit a mid-paging 57014 that the route
-- swallowed into donorCount:0 + 200 (FIX-497 root cause). FIX-494 is the same
-- bug on House (649,252 donation rows / 436 members — NOT a data gap).
--
-- This partial covering index holds exactly the donation→official→from-
-- financial_entity subset, ordered (to_id, id) and INCLUDE-ing the two projected
-- columns, so the planner runs an index-only scan (no heap) and only a tiny
-- sort for ORDER BY id. Validated on prod in a rolled-back transaction
-- (2026-06-05):
--
--   full ordered aggregate (305k rows):  70,289 ms -> 530 ms
--   deep page (LIMIT 1000 OFFSET 40000): 63,505 ms -> 216 ms
--   index size: 127 MB, build ~11 s
--
-- 530 ms worst-case is well under the route's 8 s JS budget
-- (DONOR_FETCH_BUDGET_MS in app/api/graph/group/route.ts), so no per-gb
-- donor-rollup materialization is needed — FIX-497 Track B2 gate NOT triggered.
--
-- Plain CREATE INDEX (not CONCURRENTLY): `supabase db push` wraps each migration
-- in a transaction and CONCURRENTLY cannot run inside one (the recurring
-- Pro-Small blocker — FIX-360/FIX-443). Only the Sun/Wed 08:00 UTC rebuild
-- writes entity_connections, so the ~11 s build lock outside that window is
-- harmless. The migration role's short statement_timeout would abort the build
-- over millions of rows, so raise it for this transaction only (matches the
-- 20260530030000 donation-rollup index migration).
SET LOCAL statement_timeout = '600s';

CREATE INDEX IF NOT EXISTS entity_connections_donation_to_official_idx
  ON public.entity_connections (to_id, id) INCLUDE (from_id, amount_cents)
  WHERE connection_type = 'donation' AND to_type = 'official' AND from_type = 'financial_entity';

COMMENT ON INDEX public.entity_connections_donation_to_official_idx IS
  'FIX-497 — backs the graph group-route donor aggregation (WHERE '
  'connection_type=donation AND to_type=official AND from_type=financial_entity '
  'AND to_id IN (...) ORDER BY id). Partial covering: index-only scan, no heap, '
  'no external sort. Prod EXPLAIN: 70.3s -> 0.53s full aggregate. Also resolves '
  'FIX-494 (identical timeout on House).';
