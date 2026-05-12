-- 20260512000002_financial_entities_canonical_trgm.sql
-- FIX-238: canonical_name becomes the unified search target.
--
-- Pre-FIX-238 individual donor canonical_name was the LAST-FIRST fingerprint
-- form ("MUSK ELON"), which trigram-matches "musk" or "elon" but not the
-- natural-order query "elon musk". FIX-236 worked around this with a per-
-- query OR fallback that escaped commas in display_name. After FIX-238:
--
--   * Pipeline writes canonical_name in natural "FIRST [MI] LAST" form
--     (canonicalDonorName helper in indiv.ts).
--   * A one-off backfill rewrites the existing ~540K (prod) / ~988K (local)
--     individual rows.
--   * Search route ilikes canonical_name directly.
--
-- This index makes that ilike index-served instead of seq-scanning the table.
-- Full (non-partial) coverage: non-individual canonical_name has its
-- corporate suffix stripped ("GOLDMAN SACHS GROUP" not "GOLDMAN SACHS GROUP
-- INC"), so it's a slightly better trigram target than display_name for them
-- too. Graph routes that still ilike display_name keep using the existing
-- partial display_trgm (FIX-195) — out of scope here.

BEGIN;

CREATE INDEX IF NOT EXISTS financial_entities_canonical_trgm
  ON public.financial_entities
  USING GIN (canonical_name gin_trgm_ops);

COMMENT ON INDEX public.financial_entities_canonical_trgm IS
  'Trigram name search over canonical_name across all entity_types (FIX-238). Backs natural-order donor search via the post-backfill FIRST-LAST canonical form.';

COMMIT;

-- DOWN:
--   BEGIN;
--   DROP INDEX IF EXISTS public.financial_entities_canonical_trgm;
--   COMMIT;
