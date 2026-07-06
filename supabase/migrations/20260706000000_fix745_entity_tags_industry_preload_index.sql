-- 20260706000000_fix745_entity_tags_industry_preload_index.sql
-- FIX-745 (surfaced by the FIX-743 supervised force_weekly run, GHA 28755577316).
--
-- runAiClassifier (tag-industry; logs under the `tag_ai` sync-log name) preloads
-- the set of already-industry-tagged financial_entity ids before deciding which
-- PACs still need an AI industry tag. The read (ai-classifier.ts ~L164, via
-- selectAllOrThrow) is:
--
--     SELECT entity_id FROM entity_tags
--     WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
--     ORDER BY id
--     OFFSET :n LIMIT 1000
--
-- No existing index serves this predicate + id-order:
--   entity_tags_pkey                      (id)
--   entity_tags_..._key                   (entity_type, entity_id, tag, tag_category)
--   idx_entity_tags_entity                (entity_type, entity_id)
--   idx_entity_tags_tag                   (tag, tag_category)
--   idx_entity_tags_topic (partial)       (tag_category, tag) WHERE tag_category='topic'
--   idx_entity_tags_visibility            (visibility, confidence)
--
-- so the planner uses entity_tags_pkey to satisfy ORDER BY id and FILTERs the
-- predicate row-by-row. entity_tags is 2.38M rows / 527 MB heap; only 30,815 are
-- industry FE tags, so it discards ~76,503 non-matching rows just to fill the
-- first 1,000. Prod EXPLAIN ANALYZE (cold): 38,744 ms — well past the 8s
-- authenticator/service_role statement cap, so the PostgREST read is cancelled
-- after 3 attempts and the whole tag-industry stage aborts every weekly (Sunday-
-- equivalent) run, silently skipping industry tagging.
-- (The sibling PAC preload is fine — 1.3 s — so this one index is the whole fix.)
--
-- The covering index (entity_type, tag_category, id) turns the read into a
-- bounded index range scan: equality seek on the two leading columns, then id is
-- the 3rd key so rows come out already ordered by id — the ORDER BY / OFFSET /
-- LIMIT pagination rides the index directly, no filter, no sort. << 8 s.
--
-- Build strategy: plain (transactional) CREATE INDEX IF NOT EXISTS, matching the
-- established repo precedent (FIX-195 / FIX-335 / FIX-504). entity_tags is
-- read-heavy with pipeline-driven, off-peak writes; a build-time SHARE lock
-- blocks only writers (the nightly taggers), never the live site's reads. To
-- apply with ZERO write lock, pre-build CONCURRENTLY against prod BEFORE
-- `pnpm db:push:prod`, which makes the IF NOT EXISTS below a safe no-op:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS entity_tags_type_category_id
--     ON public.entity_tags (entity_type, tag_category, id);

BEGIN;

CREATE INDEX IF NOT EXISTS entity_tags_type_category_id
  ON public.entity_tags (entity_type, tag_category, id);

COMMENT ON INDEX public.entity_tags_type_category_id IS
  'Covering index for the ai-classifier industry preload: WHERE entity_type=? '
  'AND tag_category=? ORDER BY id (paginated). Equality on the two leading cols '
  'plus id as the 3rd key makes the read a bounded index range scan in id order, '
  'replacing a 38s pkey-scan-and-filter that blew the 8s prod statement cap '
  '(FIX-745, surfaced by FIX-743).';

COMMIT;

-- DOWN:
--   BEGIN;
--   DROP INDEX IF EXISTS public.entity_tags_type_category_id;
--   COMMIT;
