-- 20260905000300_fix1147_entity_tags_tag_statistics.sql
-- FIX-1147 — entity_tags.tag gets a statistics target, not a planner hint.
--
-- ── THE MEASUREMENT ────────────────────────────────────────────────────────
-- pg_stats for public.entity_tags on prod, 2026-09-04:
--
--   attname       attstattarget   n_distinct   most_common_vals length
--   ───────────   ─────────────   ──────────   ──────────────────────
--   entity_type   (unset → 100)            3   3
--   tag_category  (unset → 100)            8   8
--   tag           (unset → 100)           42   21
--
-- The table is 2,935,886 rows / 2,714 MB and carries roughly 55 distinct tags.
-- At the default target of 100 the sample is large enough to hold only 21 of
-- them in the MCV list, and n_distinct itself comes back as 42 — an
-- extrapolation, not a census. Local reads the same shape (n_distinct 42, MCV
-- 21 of 55 actual).
--
-- Anything outside those 21 falls through to the ndistinct fallback:
-- `tag = 'health'` estimates 124 rows against an actual 8,480, a 68x
-- underestimate. That is HALF of what made the FIX-902
-- `fetchEntityIdsByIndustryTag` plan choose a Sort it did not need — the
-- planner believed it was sorting a hundred rows. The other half is a
-- correlation error that no per-column target can reach, and it only became
-- visible once this half was fixed. See the extended-statistics section.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- SET STATISTICS 1000 on the column. At that target the MCV list holds every
-- tag the table has, so a tag predicate is estimated from a stored frequency
-- rather than from 1/n_distinct. No index, no hint, no `enable_sort = off` — a
-- session GUC would have "fixed" the plan by lying to the planner about a
-- different thing, and would not have travelled to any other query over the
-- same column.
--
-- Cost: a larger sample at analyze time and a longer pg_statistic row. On a
-- table this size the analyze sample is already the dominant term and 1000 is
-- the conventional ceiling for a low-cardinality, high-skew column.
--
-- ── NO MANUAL ANALYZE ON PROD, AND THE RECEIPT THAT IMPLIES ────────────────
-- `SET STATISTICS` is a catalog change only: it takes effect at the NEXT
-- analyze, not at push time. entity_tags is rewritten wholesale by the daily
-- taggers and carries `autovacuum_analyze_scale_factor = 0.02` (FIX-652), so
-- autoanalyze fires on it routinely — `last_autoanalyze` read
-- 2026-09-04 07:13:58 UTC, the morning of this migration. Forcing an ANALYZE on
-- a 2.7 GB prod table by hand to save one cycle is exactly the kind of
-- unnecessary heavy prod operation the standing rule exists to prevent.
--
-- The same is true of the statistics object below: CREATE STATISTICS records
-- what to collect; ANALYZE collects it.
--
-- So the receipt for this FIX is the PLAN ON THE DAY AFTER the push, read once
-- `pg_stat_user_tables.last_autoanalyze` for entity_tags has advanced past the
-- push. Expect `tag = 'health'` to estimate ~10 k, the three-predicate filter to
-- estimate ~9 k rather than ~180, and the fetchEntityIdsByIndustryTag plan to
-- lose its Sort. The push itself is only two catalog rows: `attstattarget =
-- 1000` in pg_attribute and one entry in pg_statistic_ext.
--
-- ── EXTENDED STATISTICS TOO — AND THE MEASUREMENT THAT PROVED IT ───────────
-- The statistics target alone was NOT enough, and only measuring showed it.
-- All numbers below are from the clone, which reads the same pg_stats shape as
-- prod (n_distinct 42, MCV 21 before; 55 actual tags).
--
--   after SET STATISTICS 1000 + ANALYZE:
--     pg_stats.tag                       n_distinct 50, MCV length 50
--     WHERE tag='health'                 est 10,117   actual  9,710   ← fixed
--     WHERE tag='health'
--       AND tag_category='industry'      est    186   actual  9,710   ← 52x low
--     …AND entity_type='financial_entity'
--       ORDER BY entity_id LIMIT 2000    est    183   actual  8,908
--                                        Sort still chosen, 1,391 buffers
--
-- So the single-column fix worked exactly as intended and the plan did not
-- change, because the remaining error is not a frequency error at all: it is
-- the planner multiplying `tag='health'` by `tag_category='industry'` as if the
-- two were independent. They are perfectly dependent — every 'health' row IS an
-- 'industry' row (9,710 of 9,710) — so the product understates by the whole
-- selectivity of the second predicate. No per-column target can express that;
-- it takes a statistics object over the combination.
--
--   after CREATE STATISTICS … (dependencies, mcv) + ANALYZE:
--     the same query                     est  9,074   actual  8,908   (2% off)
--     plan: Index Only Scan using entity_tags_fe_industry_content,
--           Heap Fetches 0, NO Sort, 91 buffers (was 1,391)
--
-- The Sort disappears because the planner now believes the row count and picks
-- the index whose order already satisfies ORDER BY entity_id, so LIMIT 2000
-- stops early instead of sorting 8,908 rows first. That is FIX-902's
-- fetchEntityIdsByIndustryTag shape, and it is a 15x reduction in buffers
-- touched — with no `enable_sort = off`, no new index, and no query change.
--
-- Both objects are therefore in this migration, in that order, because the
-- second is only interpretable once the first is right.
--
-- ── LOCKING ────────────────────────────────────────────────────────────────
-- ALTER TABLE … SET STATISTICS is a catalog update: no rewrite, no data
-- movement. It still needs a brief ACCESS EXCLUSIVE lock, which queues behind
-- long reads AND blocks new queries behind it — so `lock_timeout` bounds the
-- damage, and the migration fails loudly rather than stalling the table. Note
-- `SET`, not `SET LOCAL`: the Supabase CLI does not wrap a migration in a
-- transaction, so SET LOCAL would warn 25P01 and do nothing.
--
-- Cross-ref FIX-902, FIX-652.
--
-- Fixes: FIX-1147
-- ─────────────────────────────────────────────────────────────────────────────

SET lock_timeout = '5s';

ALTER TABLE public.entity_tags ALTER COLUMN tag SET STATISTICS 1000;

-- CREATE STATISTICS takes only a SHARE UPDATE EXCLUSIVE lock (it does not block
-- reads or writes), but it is kept inside the same bounded window for the same
-- reason: this migration should either take its locks promptly or fail loudly.
CREATE STATISTICS IF NOT EXISTS public.entity_tags_type_cat_tag (dependencies, mcv)
  ON entity_type, tag_category, tag
  FROM public.entity_tags;

RESET lock_timeout;

COMMENT ON STATISTICS public.entity_tags_type_cat_tag IS
  'FIX-1147 — (entity_type, tag_category, tag) are functionally dependent: every '
  'tag belongs to exactly one category, so the planner''s independence assumption '
  'understated tag+category by 52x (186 est vs 9,710 actual) even with tag''s own '
  'MCV list complete. Restores the estimate to ~2% and lets '
  'fetchEntityIdsByIndustryTag use the ordered index instead of sorting. '
  'Populated by ANALYZE like any other statistic.';

COMMENT ON COLUMN public.entity_tags.tag IS
  'FIX-1147 — statistics target 1000 (default 100). ~55 distinct tags over 2.9 M '
  'rows: at the default only 21 reached the MCV list, so any other tag was '
  'estimated at 1/n_distinct and read tens of times low. Fixes the single-column '
  'estimate only (measured 10,117 est vs 9,710 actual); the correlated '
  'tag/tag_category product needs entity_tags_type_cat_tag alongside it. Takes '
  'effect at the next autoanalyze — the table carries analyze scale factor 0.02 '
  'and is rewritten daily by the taggers, so no manual ANALYZE is needed.';

-- Guard: prove the catalog actually took the value. -1 means "use the default"
-- and would mean the ALTER silently did nothing.
DO $$
DECLARE v_target int;
BEGIN
  SELECT attstattarget INTO v_target
  FROM pg_attribute
  WHERE attrelid = 'public.entity_tags'::regclass AND attname = 'tag';

  IF v_target IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION '[fix1147] entity_tags.tag attstattarget is % — expected 1000', v_target;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_statistic_ext
    WHERE stxnamespace = 'public'::regnamespace AND stxname = 'entity_tags_type_cat_tag'
  ) THEN
    RAISE EXCEPTION '[fix1147] statistics object entity_tags_type_cat_tag missing';
  END IF;

  RAISE NOTICE '[fix1147] entity_tags.tag attstattarget = 1000 and entity_tags_type_cat_tag exists (both effective at next autoanalyze)';
END $$;
