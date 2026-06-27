-- FIX-661 — partial covering index for the agency contract/grant spend rollup.
--
-- get_jurisdiction_page (FIX-634, migration 20260621020000) builds a `spend` CTE:
--   SELECT to_id, to_type, relationship_type, amount_cents, occurred_at
--   FROM financial_relationships
--   WHERE relationship_type IN ('contract','grant') AND from_type='agency'
--     AND from_id IN (<=300 agency ids)
--   ORDER BY amount_cents DESC NULLS LAST LIMIT 100
--
-- Prod EXPLAIN (ANALYZE, BUFFERS) on the US-federal jurisdiction (118 agencies,
-- 1,287,741 matching contract/grant rows) measured **213,060 ms** — the page's
-- own 8s statement_timeout cancels it long before it finishes (the captured
-- 57014 incident). The plan is a per-agency Index Scan on
-- financial_relationships_derivation (relationship_type, from_type, from_id, …)
-- whose key carries from_id but NOT amount_cents, so the ORDER BY forces a HEAP
-- fetch for every one of the 1.28M matched rows: Buffers shared read=469,034 —
-- ~469k disk reads on the IOWait-bound Pro Small instance. Identical failure
-- shape to FIX-443 (the donation rollup), and the FIX-443 index does NOT cover
-- this path: it is partial on from_type='financial_entity' AND
-- relationship_type='donation', a disjoint subset.
--
-- This partial covering index holds exactly the agency contract/grant subset,
-- keyed by from_id and INCLUDE-ing amount_cents, so the spend scan becomes an
-- index-only scan: no per-row heap read, and the top-100 is a cheap top-N
-- heapsort over the covered tuples. The predicate matches the CTE's WHERE
-- exactly so the planner can use it. State jurisdictions are unaffected either
-- way (their agency_ids set is empty — agencies are federal), but the index
-- makes the federal page tractable, and that page is the generateStaticParams
-- warm set + the most-crawled id.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because `supabase db push` wraps each
-- migration in a transaction. Only the data pipelines write
-- financial_relationships and none runs during a migration push, so the brief
-- write-lock during the build is a non-issue.
--
-- The migration role carries a short statement_timeout; building this index over
-- the ~1.3M-row agency contract/grant subset can blow past it (ERROR 57014 — the
-- FIX-443 index hit exactly this). Raise it for this migration's transaction only.
SET LOCAL statement_timeout = '600s';

CREATE INDEX IF NOT EXISTS financial_relationships_agency_spend_rollup
  ON public.financial_relationships (from_id) INCLUDE (amount_cents)
  WHERE from_type = 'agency' AND relationship_type IN ('contract', 'grant');
