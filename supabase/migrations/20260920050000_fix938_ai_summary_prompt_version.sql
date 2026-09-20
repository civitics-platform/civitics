-- =============================================================================
-- 20260920050000_fix938_ai_summary_prompt_version.sql
-- FIX-938 — a prompt edit must MISS the ai_summary_cache.
--
-- THE BUG
-- -------
-- 0005_ai_summary_cache.sql's header is explicit: "Summaries are generated once
-- and read by unlimited users at no cost. Never regenerate if a row exists —
-- check cache first." The key is (entity_type, entity_id, summary_type), which
-- describes WHAT was summarized and nothing about HOW. So when a prompt is
-- corrected, every entity already in the table keeps the old framing forever:
-- the corrected prompt is only ever used for entities nobody has looked at yet.
-- FIX-931 is the worked example — it fixed an officials-profile prompt that
-- described an itemized-only donation subset as "total raised".
--
-- WHAT THIS ADDS
-- --------------
-- prompt_version text NOT NULL DEFAULT 'legacy'. The generate paths filter on
-- it, so a row carrying an older version is a cache miss and is regenerated,
-- overwriting the row. The current value per (entity_type, summary_type) lives
-- in packages/db/src/ai-prompt-versions.ts and is stamped by every producer.
--
-- THE UNIQUE KEY IS DELIBERATELY UNCHANGED
-- ----------------------------------------
-- The obvious shape is to add prompt_version to the UNIQUE, so each version
-- keeps its own row and the old text stays readable. Measured against the tree,
-- that is the wrong trade here:
--
--   * 13 read sites, not the ~6 a grep of the pipelines suggests. Three of them
--     (/api/search/entity ×3, /proposals/[id], /api/proposals/[id]/summary) do
--     not even filter summary_type, and use .maybeSingle(); one more is inside
--     a SQL function (get_official_page, 20260621060000:83) as a LIMIT 1 with
--     no ORDER BY. Every one of those becomes nondeterministic or starts
--     erroring the moment a second row per entity can exist.
--   * The display surfaces would go BLANK. On 2026-09-20 the table holds 6,888
--     rows, all (proposal, plain_language). If the readers on the home page,
--     the proposals index, the proposal detail page and entity search filtered
--     to the current version, every one of those summaries disappears until it
--     is regenerated — and regeneration is gated by a $4/month spend cap it
--     would take roughly $11 to clear. Stale framing is strictly better than no
--     summary.
--
-- One row per entity, carrying the version that produced it, buys the whole
-- mechanism (a prompt edit misses, regenerates, and REPLACES in place) with
-- none of that. Retaining superseded text for audit is a separate question and
-- wants a separate history table, not a polymorphic cache a dozen surfaces read.
--
-- THE BACKFILL STAMPS CURRENT, NOT 'legacy'
-- -----------------------------------------
-- FIX-938 changes no prompt text. The 6,888 existing rows were produced by the
-- prompts that are in the tree today, so stamping them 'legacy' would force
-- ~6,888 regenerations of summaries whose wording is not changing — ~$11 at
-- Haiku 4.5 rates, against a $4/month cap, for zero difference in output. The
-- mechanism applies to the NEXT prompt edit, which is what the bullet asked
-- for. The pre-FIX-931 framing it names as the live example has no rows to
-- invalidate: (official, profile) is EMPTY on both local and prod, measured
-- 2026-09-20 — every cached row is a proposal summary.
--
-- 'legacy' survives as the column DEFAULT so that a producer which forgets to
-- stamp a version writes a visibly-unversioned row rather than a falsely
-- current one. After this migration no row carries it.
-- =============================================================================

BEGIN;

ALTER TABLE public.ai_summary_cache
  ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'legacy';

COMMENT ON COLUMN public.ai_summary_cache.prompt_version IS
  'FIX-938. The prompt-content version that produced summary_text, per '
  '(entity_type, summary_type) pair. Source of truth for the current value is '
  'packages/db/src/ai-prompt-versions.ts; every producer stamps it and the '
  'generate paths filter on it, so a row below the current version is a cache '
  'MISS and is regenerated in place. NOT part of the UNIQUE key — see the '
  'migration header for why one row per entity is deliberate. DEFAULT '
  '''legacy'' is a tell that a producer did not stamp a version.';

-- Backfill to the CURRENT version of each pair (see the header). Kept as an
-- explicit per-pair UPDATE rather than one blanket assignment so that adding a
-- pair later cannot silently inherit a version it was never audited against.
UPDATE public.ai_summary_cache
   SET prompt_version = '2026-09-20'
 WHERE prompt_version = 'legacy'
   AND (entity_type, summary_type) IN (
     ('proposal',  'plain_language'),
     ('official',  'profile'),
     ('agency',    'profile'),
     ('financial', 'profile')
   );

-- Partial index on the rows the generate paths skip over. The cache preloads in
-- ai-summaries and seed-backlog walk (entity_type, summary_type, prompt_version)
-- to build their "already summarized" sets; without this the added predicate
-- turns those keyset walks into a filter on top of ai_summary_cache_entity_idx.
CREATE INDEX IF NOT EXISTS ai_summary_cache_version_idx
  ON public.ai_summary_cache (entity_type, summary_type, prompt_version);

COMMIT;

-- No VACUUM tail: the UPDATE rewrites at most a few thousand rows on a table
-- whose entire heap is ~7k rows, which is inside the autovacuum threshold floor
-- rather than the bulk-rewrite case the standing rule (FIX-943) is about.
