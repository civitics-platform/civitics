-- FIX-1151 — drop officials.total_received_cents and its index.
--
-- FIX-942 moved the authoritative per-official donation total to
-- official_donor_totals.total_cents, maintained incrementally by the jobid 24
-- donor rollup. The officials column kept its shape but lost every reader and,
-- with the FIX-702/726 move of the recompute to pg_cron, every scheduled
-- writer. What remained was a column whose value drifts further from the truth
-- every night, plus a 928 kB index nobody probes.
--
-- Dependency audit, prod 2026-09-06:
--
--   * pg_depend across pg_rewrite (views, matviews, rules) on the column: 0 rows.
--   * Functions whose prosrc mentions total_received_cents: 8, of which 6 are
--     financial_entities.total_received_cents (a DIFFERENT, live column that is
--     NOT touched here) and 2 reference the officials column only in COMMENTS:
--       - rebuild_entity_search_index  -- "the authoritative per-official
--         donation total is official_donor_totals.total_cents, NOT
--         officials.total_received_cents"
--       - small_dollar_rebuild_officials -- a comment about matching grain
--     Neither reads it. The comments are left as-is: they explain a choice, and
--     the choice is still the right one now that the column is gone.
--   * Repo grep: every TypeScript reference resolves to
--     financial_entities.total_received_cents (the donors page, the entity
--     search route, the FEC writer's skip-overwrite column lists) or to the
--     SearchOfficial.total_received_cents PAYLOAD field, which
--     /api/browse/typeahead populates from entity_search_index.amount_cents.
--     No reader of the officials column is left.
--
-- The two remaining actual writers are the deprecated recompute functions. They
-- are dropped in the same migration rather than left behind: a break-glass
-- function that references a dropped column is not break-glass, it is a
-- guaranteed error the next time someone reaches for it. Their deprecation
-- COMMENTs (FIX-942) already name official_donor_totals.total_cents as the
-- replacement, and that guidance now lives here.
--
-- financial_entities.total_received_cents is a separate live column with live
-- writers (financial_entity_received_totals_rebuild and friends) and is
-- deliberately untouched.

-- 1. The two deprecated writers. No routine caller: FIX-942 marked them
--    break-glass only, and nothing scheduled has invoked them since.
DROP FUNCTION IF EXISTS public.rebuild_official_donation_totals();
DROP FUNCTION IF EXISTS public.rebuild_official_donation_totals_full();

-- 2. The index, then the column. 928 kB on prod, so a plain DROP INDEX is fine
--    -- the CONCURRENTLY rule is for indexes big enough that the ACCESS
--    EXCLUSIVE lock is a visible stall. DROP COLUMN would drop the index with
--    it; naming it explicitly keeps the intent auditable.
DROP INDEX IF EXISTS public.officials_total_received_cents;

ALTER TABLE public.officials DROP COLUMN IF EXISTS total_received_cents;
