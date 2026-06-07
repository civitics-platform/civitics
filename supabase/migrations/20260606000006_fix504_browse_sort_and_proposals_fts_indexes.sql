-- 20260606000006_fix504_browse_sort_and_proposals_fts_indexes.sql
-- FIX-504 (follow-up to FIX-503 buffer-churn audit).
--
-- Two read-path indexes that close confirmed prod seq-scans:
--
-- (1) financial_entities has NO index on total_donated_cents. The financial-tab
--     browse (homepage top donors / treemap) runs
--       SELECT id FROM financial_entities
--       WHERE entity_type <> 'individual'
--       ORDER BY total_donated_cents DESC NULLS LAST LIMIT 21
--     and sorted ~78k rows live (prod cost 75505). The only ORDER BY consumer is
--     apps/civitics/app/api/search/route.ts (financial browse arm), whose chain
--     always carries .neq("entity_type","individual"), so a PARTIAL index on the
--     same predicate matches. DESC NULLS LAST mirrors the route's
--     `nullsFirst: false`. gte/lte range filters on the same chain ride the same
--     index. All other total_donated_cents reads are point reads or in-JS sorts.
--     Naming follows the existing partial-index family (FIX-195/FIX-335).
--
-- (2) proposals.search_vector (TSVECTOR, populated A=title/B=short_title/
--     C=summary_plain by a live trigger, 0001_initial_schema.sql:277-289) lost
--     its GIN index: 20260524230000_fix_a_drop_unused_indexes.sql:29 dropped
--     `shadow_proposals_search_vector` (12 MB) as "unused" — it was unused only
--     because the search route did `summary_plain ILIKE '%q%'`, which can't use
--     it, so the route seq-scanned (prod cost 20063). FIX-504 switches the route
--     to websearch_to_tsquery FTS (lexeme match), which DOES use this GIN — so
--     the index comes back under a clean (non-shadow) name.
--
-- Build strategy: plain (transactional) CREATE INDEX IF NOT EXISTS, matching the
-- established repo precedent (FIX-195, FIX-335). Both tables are read-heavy with
-- pipeline-driven, off-peak writes, so the brief SHARE lock during the build is
-- acceptable. The proposals GIN is small (~12 MB over 73k rows); the
-- financial_entities btree is a single-column bigint over ~2.3M rows (fast).
-- IF NOT EXISTS makes a zero-downtime CONCURRENTLY pre-build a safe no-op:
--
--   -- run against prod BEFORE `pnpm db:push:prod` to avoid the SHARE lock:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_entities_total_donated_nonindividual
--     ON public.financial_entities (total_donated_cents DESC NULLS LAST)
--     WHERE entity_type <> 'individual';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS proposals_search_vector
--     ON public.proposals USING GIN (search_vector);

BEGIN;

-- ── (1) Partial browse-sort index ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS financial_entities_total_donated_nonindividual
  ON public.financial_entities (total_donated_cents DESC NULLS LAST)
  WHERE entity_type <> 'individual';

COMMENT ON INDEX public.financial_entities_total_donated_nonindividual IS
  'Browse-sort support: ORDER BY total_donated_cents DESC NULLS LAST over '
  'non-individual entities (homepage top donors, treemap). Partial on '
  'entity_type <> ''individual'' to match the financial-tab browse chain in '
  'api/search/route.ts (FIX-504, follow-up to FIX-503).';

-- ── (2) Restore the proposals FTS GIN ──────────────────────────────────────
-- Back because the search route now uses websearch_to_tsquery over
-- search_vector instead of summary_plain ILIKE; the old shadow_-prefixed copy
-- was dropped as unused on 2026-05-24 (FIX-A) while the route still did ILIKE.
CREATE INDEX IF NOT EXISTS proposals_search_vector
  ON public.proposals USING GIN (search_vector);

COMMENT ON INDEX public.proposals_search_vector IS
  'FTS GIN over proposals.search_vector (title A / short_title B / summary_plain '
  'C). Restored by FIX-504 after api/search/route.ts switched proposals q-search '
  'from summary_plain ILIKE to websearch_to_tsquery; the prior '
  'shadow_proposals_search_vector copy was dropped 2026-05-24 (FIX-A) as unused '
  'because ILIKE could not use it.';

COMMIT;

-- DOWN:
--   BEGIN;
--   DROP INDEX IF EXISTS public.financial_entities_total_donated_nonindividual;
--   DROP INDEX IF EXISTS public.proposals_search_vector;
--   COMMIT;
