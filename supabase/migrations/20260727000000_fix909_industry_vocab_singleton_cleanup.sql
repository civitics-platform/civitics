-- FIX-909 (with FIX-908) — donor-industry vocabulary: rename `pharma` → `health`
-- and delete the two remaining out-of-vocabulary singleton tags.
--
-- CONTEXT. A dollar-weighted audit of all twelve donor-industry tags (2026-07-27)
-- found no tag above 79% accuracy and a 41% median. FIX-908 expands the
-- vocabulary from 12 to 16 keys in code; this migration moves the DATA that the
-- rename half of that change touches. No donor is re-assigned here — the curated
-- override list that actually moves donors into the new buckets is separate.
--
-- WHY `pharma` → `health` IS A BLANKET KEY RENAME, NOT A RE-SCOPING. The entire
-- keyword list feeding the tag is health-sector (pharma, drug, medical, health,
-- biotech, physician, hospital, healthcare, medicine, surgical, dental,
-- optometry, nursing) and the audit measured the tag at 20.4% pharmaceutical but
-- 91.2% health-sector — its largest components are hospital/physician
-- associations (32.0%), health trade associations (20.7%) and health insurers
-- (11.6%). `pharma` was simply the wrong name for its own contents, so the
-- rename is correct for the unaudited tail too. There is no `saved_views` table
-- (verified 2026-07-27: to_regclass('public.saved_views') IS NULL), so no
-- persisted user state carries the old key; a back-compat alias in
-- apps/civitics/src/lib/browse/graph-compiler.ts keeps old URLs and
-- natural-language queries resolving.
--
-- WHY THIS TOUCHES MORE THAN entity_tags. A vocabulary key rename has to rewrite
-- every store that PERSISTS the key, not just the table of record. Two of them
-- are refreshed INCREMENTALLY off a dirty set, so a stale key there never
-- self-heals — and one of those is load-bearing:
-- public.official_sector_affinity_rollup is read by tagOfficials(), which calls
-- assertIndustryVocabulary() and THROWS on any value outside VALID_INDUSTRIES.
-- Renaming only entity_tags would leave `pharma` in that rollup for every
-- official whose donors did not change, and the next nightly official tagger
-- would die on the assert. That is the failure this block exists to prevent.
--
-- NOT UPDATED HERE — the two true materialized views (relkind='m', so they
-- cannot be UPDATEd, only REFRESHed): public.chord_industry_flows_mv and
-- public.official_sector_dollars_mv. Both derive from entity_tags, so their next
-- scheduled REFRESH produces `health` with no further action. They are left to
-- that cadence deliberately rather than refreshed inline: official_sector_dollars_mv
-- scans financial_relationships and a synchronous refresh inside a prod
-- migration is exactly the heavy-op-during-active-hours pattern to avoid.
-- Until then they render a stale "Pharma" arc — cosmetic, self-correcting, and
-- strictly better than an unbounded refresh in a DDL transaction.
--
-- WHY THE ENTITY_TYPE SCOPE IS `IN ('financial_entity','official')` AND NOT
-- financial_entity ALONE: entity_tags carries 325 official-side `pharma` rows
-- (the FIX-897 derived donation-affinity pills). They are owned by tagOfficials'
-- authoritative DELETE and would be rebuilt as `health` on the next nightly, but
-- leaving them means `SELECT count(*) ... WHERE tag='pharma'` stays non-zero
-- after this migration, which is neither what the verification asserts nor what
-- "the key is renamed" should mean.
--
-- IDEMPOTENT. Every statement is a WHERE-filtered UPDATE/DELETE on the old
-- value; a second run matches zero rows and the assertions expect that.

BEGIN;

DO $$
DECLARE
  v_before_rows      bigint;
  v_before_distinct  bigint;
  v_before_pharma    bigint;
  v_after_rows       bigint;
  v_after_distinct   bigint;
  v_health           bigint;
  v_n                bigint;
BEGIN
  SELECT count(*), count(DISTINCT tag)
    INTO v_before_rows, v_before_distinct
    FROM public.entity_tags
   WHERE entity_type = 'financial_entity' AND tag_category = 'industry';

  SELECT count(*) INTO v_before_pharma
    FROM public.entity_tags
   WHERE entity_type IN ('financial_entity','official')
     AND tag_category = 'industry' AND tag = 'pharma';

  RAISE NOTICE 'FIX-909 BEFORE: financial_entity/industry rows=% distinct_tags=%; pharma rows (fe+official)=%',
    v_before_rows, v_before_distinct, v_before_pharma;

  -- ── 1. `pharma` → `health` ────────────────────────────────────────────────
  -- Row COUNT must not change; only values. display_label/display_icon move in
  -- the same statement so the tag is never internally inconsistent — FIX-854
  -- exists because the same tag carrying differing display metadata across rows
  -- fans out in the chord aggregates.
  UPDATE public.entity_tags
     SET tag           = 'health',
         display_label = 'Health Care',
         display_icon  = '🏥'
   WHERE entity_type IN ('financial_entity','official')
     AND tag_category = 'industry'
     AND tag = 'pharma';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'FIX-909  entity_tags pharma->health: % row(s)', v_n;

  -- ── 2. Delete the out-of-vocabulary singletons ────────────────────────────
  -- `energy` (3 rows) and `pharmaceutical` (1 row), both generated_by='ai'
  -- residue predating the FIX-890 write-boundary guard — nothing can write them
  -- now. The three `energy` entities (Yellowstone Electric, GE Renewables,
  -- Ameresco) are USASpending contractors with ZERO donation rows, so this
  -- deletion cannot move any dollar figure. `pharmaceutical` is AHORA PAC, a
  -- Hispanic-outreach political PAC classified `pharmaceutical` at confidence
  -- 0.95 — a flat hallucination.
  --
  -- `manufacturing` is deliberately NOT deleted: FIX-908 promotes it to a real
  -- vocabulary key and its single row (NAM-PAC) is correctly tagged.
  DELETE FROM public.entity_tags
   WHERE entity_type = 'financial_entity'
     AND tag_category = 'industry'
     AND tag IN ('energy', 'pharmaceutical');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'FIX-909  entity_tags singleton delete: % row(s)', v_n;

  -- ── 3. FIX-908 label widenings ────────────────────────────────────────────
  -- Keys unchanged; only display_label/display_icon. Applied here rather than
  -- left to the next nightly so the deployed code and the stored labels agree
  -- immediately — otherwise prod renders "Health Care" beside "Finance" for up
  -- to 24h. The nightly tagger rewrites these to the same values (authoritative
  -- DELETE + reinsert from INDUSTRY_LABELS), so this is a fast-forward, not a
  -- competing writer.
  UPDATE public.entity_tags t
     SET display_label = v.label,
         display_icon  = v.icon
    FROM (VALUES
      ('oil_gas',        'Oil & Gas',                     '🛢'),
      ('finance',        'Finance & Insurance',           '📈'),
      ('tech',           'Technology & Communications',   '💻'),
      ('defense',        'Defense & Aerospace',           '🛡'),
      ('real_estate',    'Real Estate & Construction',    '🏠'),
      ('labor',          'Labor',                         '👷'),
      ('agriculture',    'Agriculture & Food',            '🌾'),
      ('legal',          'Legal & Professional Services', '⚖️'),
      ('retail',         'Consumer Goods & Services',     '🛒'),
      ('transportation', 'Transportation',                '🚛'),
      ('lobby',          'Advocacy & Lobbying',           '🏛'),
      ('manufacturing',  'Manufacturing',                 '🏭')
    ) AS v(tag, label, icon)
   WHERE t.entity_type IN ('financial_entity','official')
     AND t.tag_category = 'industry'
     AND t.tag = v.tag
     AND (t.display_label IS DISTINCT FROM v.label OR t.display_icon IS DISTINCT FROM v.icon);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'FIX-909  entity_tags label widening: % row(s)', v_n;

  -- ── 4. Derived stores that PERSIST the key ────────────────────────────────
  -- Plain tables (relkind='r'), so a direct UPDATE is correct and cheap. Each is
  -- guarded with to_regclass so this migration stays applicable to an
  -- environment that has not yet built a given rollup.

  -- official_sector_affinity_rollup (FIX-777/897) — THE load-bearing one.
  -- Incremental (DELETE per dirty recipient chunk), and assertIndustryVocabulary
  -- throws on a stale value. See the header note.
  IF to_regclass('public.official_sector_affinity_rollup') IS NOT NULL THEN
    UPDATE public.official_sector_affinity_rollup SET industry = 'health' WHERE industry = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  official_sector_affinity_rollup: % row(s)', v_n;
    DELETE FROM public.official_sector_affinity_rollup WHERE industry IN ('energy','pharmaceutical');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  official_sector_affinity_rollup singleton delete: % row(s)', v_n;
  END IF;

  -- official_donor_rollup_mv (FIX-836/704) — a TABLE despite the _mv name;
  -- incremental off the donor dirty set, so it never self-heals either.
  IF to_regclass('public.official_donor_rollup_mv') IS NOT NULL THEN
    UPDATE public.official_donor_rollup_mv
       SET industry_tag = 'health', industry_label = 'Health Care'
     WHERE industry_tag = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  official_donor_rollup_mv: % row(s)', v_n;
  END IF;

  -- donor_party_rollup_mv — also a TABLE.
  IF to_regclass('public.donor_party_rollup_mv') IS NOT NULL THEN
    UPDATE public.donor_party_rollup_mv
       SET industry_tag = 'health', industry_label = 'Health Care'
     WHERE industry_tag = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  donor_party_rollup_mv: % row(s)', v_n;
  END IF;

  -- entity_search_index — a stale key here is a FUNCTIONAL break, not cosmetic:
  -- the browse compiler now emits `health`, and an index still holding `pharma`
  -- returns zero results for the industry facet.
  IF to_regclass('public.entity_search_index') IS NOT NULL THEN
    UPDATE public.entity_search_index SET industry = 'health' WHERE industry = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  entity_search_index: % row(s)', v_n;
    UPDATE public.entity_search_index SET industry = NULL WHERE industry IN ('energy','pharmaceutical');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  entity_search_index singleton null-out: % row(s)', v_n;
  END IF;

  -- browse_facet_counts — the clickable industry facets in the browse UI. Also a
  -- functional break if left stale: the facet list would still offer "pharma",
  -- and clicking it would filter to zero rows now that the compiler emits
  -- `health`. The `energy` facet goes away entirely with its rows.
  IF to_regclass('public.browse_facet_counts') IS NOT NULL THEN
    -- Fold into an existing `health` facet row if one already exists (re-run
    -- safety), otherwise rename in place.
    DELETE FROM public.browse_facet_counts b
     WHERE b.facet_key = 'industry' AND b.facet_value = 'pharma'
       AND EXISTS (
         SELECT 1 FROM public.browse_facet_counts h
          WHERE h.kind = b.kind AND h.facet_key = 'industry' AND h.facet_value = 'health'
       );
    UPDATE public.browse_facet_counts
       SET facet_value = 'health'
     WHERE facet_key = 'industry' AND facet_value = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  browse_facet_counts pharma->health: % row(s)', v_n;

    DELETE FROM public.browse_facet_counts
     WHERE facet_key = 'industry' AND facet_value IN ('energy','pharmaceutical');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  browse_facet_counts singleton delete: % row(s)', v_n;
  END IF;

  -- Contract-flow rollups (FIX-838, weekly full rebuild). These WOULD self-heal
  -- on the Thursday refresh; updated anyway so the DB has no `pharma` anywhere
  -- the moment this migration lands.
  IF to_regclass('public.contract_agency_sector_rollup') IS NOT NULL THEN
    UPDATE public.contract_agency_sector_rollup SET sector = 'health' WHERE sector = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  contract_agency_sector_rollup: % row(s)', v_n;
  END IF;

  IF to_regclass('public.contract_recipient_rollup') IS NOT NULL THEN
    UPDATE public.contract_recipient_rollup SET industry = 'health' WHERE industry = 'pharma';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'FIX-909  contract_recipient_rollup: % row(s)', v_n;
  END IF;

  -- ── 5. Assertions ─────────────────────────────────────────────────────────
  SELECT count(*), count(DISTINCT tag)
    INTO v_after_rows, v_after_distinct
    FROM public.entity_tags
   WHERE entity_type = 'financial_entity' AND tag_category = 'industry';

  SELECT count(*) INTO v_health
    FROM public.entity_tags
   WHERE entity_type IN ('financial_entity','official')
     AND tag_category = 'industry' AND tag = 'health';

  RAISE NOTICE 'FIX-909 AFTER:  financial_entity/industry rows=% distinct_tags=%; health rows (fe+official)=%',
    v_after_rows, v_after_distinct, v_health;

  -- Conservation: the ONLY row-count change is the singleton deletes. The rename
  -- and the label widening must both be value-only.
  IF v_before_rows - v_after_rows NOT IN (0, 4) THEN
    RAISE EXCEPTION
      'FIX-909 conservation failed: financial_entity/industry rows went % -> % (delta %). '
      'Expected a delta of exactly 4 on first run (the energy+pharmaceutical deletes) '
      'or 0 on a re-run. Nothing else in this migration may change a row count.',
      v_before_rows, v_after_rows, v_before_rows - v_after_rows;
  END IF;

  -- The rename must be total: no `pharma` may survive anywhere in entity_tags.
  SELECT count(*) INTO v_n
    FROM public.entity_tags
   WHERE tag_category = 'industry' AND tag = 'pharma';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FIX-909 rename incomplete: % entity_tags row(s) still carry tag=''pharma''', v_n;
  END IF;

  -- And the deleted singletons must be gone.
  SELECT count(*) INTO v_n
    FROM public.entity_tags
   WHERE tag_category = 'industry' AND tag IN ('energy','pharmaceutical');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FIX-909 delete incomplete: % out-of-vocabulary row(s) survive', v_n;
  END IF;

  -- health must have absorbed exactly the pre-migration pharma population.
  IF v_before_pharma > 0 AND v_health <> v_before_pharma THEN
    RAISE EXCEPTION
      'FIX-909 rename lost rows: pharma was % before, health is % after (expected equal)',
      v_before_pharma, v_health;
  END IF;

  -- Nothing outside the 16-key vocabulary may remain on the financial-entity
  -- side — EXCEPT `other`, which is deliberately tolerated.
  --
  -- `other` is not vocabulary drift in the FIX-890 sense: it is a LIVE writer
  -- output. ai-classifier.ts offers "other" as an answer for abstentions and
  -- unparseable responses and then upserts it as a real tag, over PostgREST,
  -- bypassing the drain write-boundary guard entirely. Measured 2026-07-27: 8
  -- rows on prod, 0 on local. FIX-908 documented that hole at the call site and
  -- deliberately did NOT change the write behaviour — so asserting `other` away
  -- here would fail this migration on prod today, and would fail again the next
  -- time the classifier runs even if the rows were deleted. Fixing the writer
  -- (and then cleaning the rows) is its own change; this assertion tolerates
  -- `other` and catches everything else.
  SELECT count(*) INTO v_n
    FROM public.entity_tags
   WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
     AND tag NOT IN (
       'health','oil_gas','finance','tech','defense','real_estate','labor',
       'agriculture','legal','retail','transportation','lobby',
       'utilities','manufacturing','mining','media',
       'other'  -- see the note above; NOT a vocabulary member
     );
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'FIX-909 out-of-vocabulary rows remain: % financial_entity/industry row(s) carry a tag '
      'outside VALID_INDUSTRIES (and outside the tolerated `other`). Investigate before proceeding.', v_n;
  END IF;

  RAISE NOTICE 'FIX-909 OK — vocabulary is clean.';
END $$;

COMMIT;
