-- FIX-889 + FIX-891 — proposal tag_category drift repair.
--
-- Run via packages/data/src/scripts/recategorize-proposal-complexity-tags.ts,
-- which wraps this whole file in ONE transaction and either COMMITs (--apply)
-- or ROLLBACKs (default). Do not add BEGIN/COMMIT here — the runner owns the
-- transaction so the dry-run proof and the real run execute identical SQL.
--
-- IDEMPOTENT: both UPDATEs are scoped by the state they change, so a second
-- run matches zero rows and reports 0/0.
--
-- STATEMENT ORDER MATTERS for reporting only; the two UPDATEs are independent.

-- ── Report: before ─────────────────────────────────────────────────────────
SELECT 'before' AS phase, tag_category, count(*) AS rows
  FROM public.entity_tags
 WHERE entity_type = 'proposal'
   AND tag IN ('technical', 'accessible')
 GROUP BY tag_category
 ORDER BY tag_category;

SELECT 'before' AS phase, ai_model, count(*) AS rows
  FROM public.entity_tags
 WHERE entity_type = 'proposal'
   AND generated_by = 'ai'
   AND ai_model IS NOT NULL
 GROUP BY ai_model
 ORDER BY rows DESC;

-- ── FIX-889 collision guard ────────────────────────────────────────────────
-- entity_tags carries UNIQUE (entity_type, entity_id, tag, tag_category). If a
-- proposal already had BOTH a topic-category and a quality-category row for the
-- same complexity tag, moving the topic row would collide. Measured 0 on local
-- and prod (there are no quality rows at all yet), but a silent
-- ON CONFLICT DO NOTHING would turn a future collision into invisible data
-- loss, so abort loudly and let a human decide instead.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.entity_tags src
    JOIN public.entity_tags dst
      ON  dst.entity_type  = src.entity_type
      AND dst.entity_id    = src.entity_id
      AND dst.tag          = src.tag
      AND dst.tag_category = 'quality'
   WHERE src.entity_type  = 'proposal'
     AND src.tag_category = 'topic'
     AND src.tag IN ('technical', 'accessible');

  IF n > 0 THEN
    RAISE EXCEPTION
      'FIX-889 collision guard: % row(s) already have a quality-category twin; '
      'the re-categorization would violate '
      'entity_tags_entity_type_entity_id_tag_tag_category_key. Resolve these by '
      'hand before re-running — do NOT suppress with ON CONFLICT.', n;
  END IF;
END $$;

-- ── FIX-889: move complexity classifications out of the topic category ──────
-- `technical` / `accessible` describe how a proposal's text READS, not what it
-- is ABOUT. The drain path (drain-v1) wrote them as topics, making them the #1
-- and #2 "topics" by volume and poisoning every consumer of proposal topics.
-- `quality` is already a first-class rendered category (EntityTags.tsx
-- CATEGORY_STYLES + CATEGORY_ORDER position 6), so no UI change is required.
-- Re-categorized, never deleted — the classification itself is legitimate work.
UPDATE public.entity_tags
   SET tag_category = 'quality'
 WHERE entity_type  = 'proposal'
   AND tag_category = 'topic'
   AND tag IN ('technical', 'accessible');

-- ── FIX-891: normalize the duplicate Haiku identifier ───────────────────────
-- `claude-haiku-4-5` and `claude-haiku-4-5-20251001` are the same model
-- recorded two ways, so per-model cost/provenance audits double-count the
-- pipeline. Scoped to AI-generated proposal rows, which is where every
-- undated row lives (verified: all 3,589 are entity_type='proposal' AND
-- generated_by='ai'). The 4 `claude-opus-4-7` rows are deliberately untouched
-- — an expensive model reaching a Haiku-only drain pipeline is a separate
-- question and normalizing it away would destroy the evidence.
UPDATE public.entity_tags
   SET ai_model = 'claude-haiku-4-5-20251001'
 WHERE entity_type  = 'proposal'
   AND generated_by = 'ai'
   AND ai_model     = 'claude-haiku-4-5';

-- ── Report: after ──────────────────────────────────────────────────────────
SELECT 'after' AS phase, tag_category, count(*) AS rows
  FROM public.entity_tags
 WHERE entity_type = 'proposal'
   AND tag IN ('technical', 'accessible')
 GROUP BY tag_category
 ORDER BY tag_category;

SELECT 'after' AS phase, ai_model, count(*) AS rows
  FROM public.entity_tags
 WHERE entity_type = 'proposal'
   AND generated_by = 'ai'
   AND ai_model IS NOT NULL
 GROUP BY ai_model
 ORDER BY rows DESC;

-- ── Residual out-of-vocabulary topic tags ──────────────────────────────────
-- Should be empty except the four singleton tags awaiting a disposition
-- decision (justice, small_business, homeland_security, infrastructure).
-- `aviation` is NOT listed here — FIX-889 adopted it into VALID_TOPICS.
SELECT 'residual_oov' AS phase, tag, count(*) AS rows
  FROM public.entity_tags
 WHERE entity_type  = 'proposal'
   AND tag_category = 'topic'
   AND tag NOT IN (
     'climate','healthcare','finance','education','housing','transportation',
     'aviation','agriculture','energy','defense','technology','labor',
     'immigration','civil_rights','veterans','food_safety',
     'consumer_protection','environment','public_health','trade','other'
   )
 GROUP BY tag
 ORDER BY rows DESC;
