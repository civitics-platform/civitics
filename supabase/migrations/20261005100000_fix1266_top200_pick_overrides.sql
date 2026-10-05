-- 20261005100000_fix1266_top200_pick_overrides.sql
--
-- FIX-1266 — six industry overrides on the COMMITTEE arm (cohort 6; 808 → 814)
-- =============================================================================
--
-- THE ROWS come from docs/audits/2026-10-05-fix1266-top200-overrides.tsv. The
-- evidence file is docs/audits/2026-10-04-fix1266-top200-pick-audit.md (§6) and
-- its proposed-overrides TSV. Every row carries a real fec_committee_id, so
-- financial_entity_id is NULL (the FIX-916 arm, not FIX-922's uuid arm).
--
--   C00097568  EMPLOYEES OF RTX CORPORATION PAC   (Q)  → defense
--   C00327189  VALUE IN ELECTING WOMEN PAC         (W)  → NULL
--   C00550970  EQUALITY PAC                        (W)  → NULL
--   C00448696  SENATE CONSERVATIVES FUND           (W)  → NULL
--   C00745745  IN UNION USA                        (O)  → labor
--   C00528448  UAW EDUCATION FUND                  (O)  → labor
--
-- The first four are the donation top-200's wrong and none verdicts (Craig
-- 2026-10-04). The last two are FIX-1280's residuals (Craig 2026-10-05).
-- FIX-1280 makes the keyword pass read an O/U/V/W committee's connected
-- organisation instead of its own name. In Union USA's connected org is the
-- literal NONE, so it would lose a correct labor row. UAW Education Fund's
-- sponsor name ("…AUTOMOBILE AEROSPACE…") would add a defense row that wins the
-- alphabetical tie-break over labor. Read on prod 2026-10-05 04:13–04:25 UTC
-- (cc-196 read 2): each id resolves to exactly one non-synthetic
-- financial_entities row, and none is in the override table.
--
-- HOW A NULL OVERRIDE DE-TAGS, AND WHY THIS MIGRATION DELETES THREE ai ROWS.
-- tagFinancialEntities() (rules.ts) reads the table through two LEFT JOINs, one
-- per arm. applyIndustryOverrides() then drops every computed keyword or NAICS
-- industry row for an overridden entity and emits one curated row, or none when
-- `industry` IS NULL. That is the whole NULL mechanism. It filters the rows the
-- tagger is about to write, and it cannot reach a row another writer owns. The
-- rule clear is scoped to generated_by='rule' and clearCuratedIndustryTags() to
-- 'curated', so an ai row survives both. primary_industry_tag() ranks curated >
-- rule-before-ai > confidence and never reads this table. The three NULL
-- committees hold ONLY an ai `lobby` row (0.80 / 0.65 / 0.75, created
-- 2026-04-29), so without a delete their picks would stay `lobby`.
-- On prod, before this migration, every one of the 367 NULL overrides held zero
-- industry rows: FIX-916, FIX-921 and FIX-923 each deleted the ai rows their
-- curation shadowed. Section 3 does the same for these three ai rows, and only
-- these (Craig 2026-10-05). FIX-1255 kept its ai rows because they AGREED with
-- the override; these disagree with it. The ai classifier skips every
-- overridden committee (FIX-917), so it will not write them again.
--
-- WHAT THE NIGHTLY DOES WITH THE REST. RTX and UAW Education Fund hold no
-- industry row today; each gets a curated row. In Union USA's rule `labor` row
-- is replaced by a curated `labor` row: same pick, new provenance. Section 3
-- gives the three NULL rows their effect at once. The tail
-- (sync_rollup_industry_labels, FIX-1240) carries the four pick changes into
-- official_donor_rollup_mv.
--
-- NO OTHER entity_tags WRITE. The non-NULL rows need none, since no ai row
-- disagrees with them (asserted in section 4).
--
-- IDEMPOTENT. The insert upserts on fec_committee_id. The delete is scoped to
-- this cohort's NULL rows and finds 0 rows on a second apply. The assertions
-- hold on an already-migrated env.

BEGIN;

-- ── 1. Pre-check ───────────────────────────────────────────────────────────
-- A missing id, a synthetic (Franklin) row, or a committee another cohort
-- already curates is a STOP. ON CONFLICT would silently re-source another
-- cohort's row, so it is checked on both arms.
DO $do$
DECLARE
  v_ids   text[] := ARRAY['C00097568', 'C00327189', 'C00550970', 'C00448696',
                          'C00745745', 'C00528448'];
  v_found int;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_found FROM public.financial_entities WHERE fec_committee_id = ANY (v_ids);
  IF v_found <> 6 THEN
    RAISE EXCEPTION 'FIX-1266: % of 6 committee ids resolve to financial_entities rows. Refusing to seed.', v_found;
  END IF;

  SELECT string_agg(fe.display_name || ' [' || fe.fec_committee_id || ']', '; ') INTO v_bad
    FROM public.financial_entities fe
   WHERE fe.fec_committee_id = ANY (v_ids) AND COALESCE(fe.is_synthetic, false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1266: synthetic rows are never curated: %', v_bad;
  END IF;

  SELECT string_agg(o.fec_committee_id || ' (' || o.source || ')', '; ') INTO v_bad
    FROM public.financial_entity_industry_overrides o
    LEFT JOIN public.financial_entities fe ON fe.id = o.financial_entity_id
   WHERE (o.fec_committee_id = ANY (v_ids) OR fe.fec_committee_id = ANY (v_ids))
     AND o.source <> 'fix1266-top200-2026-10-05';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1266: already curated by another cohort: %', v_bad;
  END IF;
END
$do$;

-- ── 2. The override rows (committee arm: financial_entity_id NULL) ─────────
INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, financial_entity_id, industry, display_name_at_audit, audited_sector, source, note)
VALUES
  ('C00097568', NULL, 'defense', 'EMPLOYEES OF RTX CORPORATION POLITICAL ACTION COMMITTEE', 'top200_pick_audit', 'fix1266-top200-2026-10-05', 'FIX-1266: RTX Corporation (Raytheon) carries NO industry tag: the defense keyword list has ''raytheon'', nothing matches ''RTX'''),
  ('C00327189', NULL, NULL, 'VALUE IN ELECTING WOMEN POLITICAL ACTION COMMITTEE', 'top200_pick_audit', 'fix1266-top200-2026-10-05', 'FIX-1266: candidate-support PAC — no industry (Craig 2026-10-04); its ai lobby row is deleted (Craig 2026-10-05), so the pick reads none'),
  ('C00550970', NULL, NULL, 'EQUALITY PAC', 'top200_pick_audit', 'fix1266-top200-2026-10-05', 'FIX-1266: caucus PAC — no industry (Craig 2026-10-04); its ai lobby row is deleted (Craig 2026-10-05), so the pick reads none'),
  ('C00448696', NULL, NULL, 'SENATE CONSERVATIVES FUND', 'top200_pick_audit', 'fix1266-top200-2026-10-05', 'FIX-1266: ideological PAC — no industry (Craig 2026-10-04); its ai lobby row is deleted (Craig 2026-10-05), so the pick reads none'),
  ('C00745745', NULL, 'labor', 'IN UNION USA', 'labor_union', 'fix1266-top200-2026-10-05', 'FIX-1266/FIX-1280: union super PAC; connected org NONE, so the sponsor rule drops its keyword row (Craig 2026-10-05)'),
  ('C00528448', NULL, 'labor', 'UAW EDUCATION FUND', 'labor_union', 'fix1266-top200-2026-10-05', 'FIX-1266/FIX-1280: UAW''s super PAC; its sponsor name adds defense via ''aerospace'', which would win the pick (Craig 2026-10-05)')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET financial_entity_id   = EXCLUDED.financial_entity_id,
      industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector,
      source                = EXCLUDED.source,
      note                  = EXCLUDED.note;

-- ── 3. The three ai rows the NULL overrides cannot reach ───────────────────
-- Scoped through this cohort's own NULL rows, never by a bare id list, so it
-- can only ever touch the ai industry rows of a committee this migration says
-- has no industry. 3 on first apply (prod and the clone read the same three);
-- 0 on any re-apply.
DO $do$
DECLARE
  v_deleted int;
  v_left    int;
BEGIN
  WITH del AS (
    DELETE FROM public.entity_tags et
     USING public.financial_entities fe,
           public.financial_entity_industry_overrides o
     WHERE et.entity_type      = 'financial_entity'
       AND et.tag_category     = 'industry'
       AND et.generated_by     = 'ai'
       AND et.entity_id        = fe.id
       AND fe.fec_committee_id = o.fec_committee_id
       AND o.financial_entity_id IS NULL
       AND o.industry IS NULL
       AND o.source            = 'fix1266-top200-2026-10-05'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  IF v_deleted NOT IN (0, 3) THEN
    RAISE EXCEPTION 'FIX-1266: expected to delete 3 ai industry rows (0 on re-apply), deleted %.', v_deleted;
  END IF;

  -- The invariant every other NULL override already holds: no industry row.
  SELECT count(*) INTO v_left
    FROM public.entity_tags et
    JOIN public.financial_entities fe ON fe.id = et.entity_id
    JOIN public.financial_entity_industry_overrides o ON o.fec_committee_id = fe.fec_committee_id
   WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     AND o.source = 'fix1266-top200-2026-10-05' AND o.industry IS NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'FIX-1266: % industry row(s) still on a NULL-override committee of this cohort.', v_left;
  END IF;

  RAISE NOTICE 'FIX-1266: deleted % generated_by=''ai'' industry row(s) for the three NULL overrides', v_deleted;
END
$do$;

-- ── 4. Cohort + total assertions ───────────────────────────────────────────
DO $do$
DECLARE
  v_cohort int;
  v_nulls  int;
  v_total  int;
  v_bad    text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE o.industry IS NULL) INTO v_cohort, v_nulls
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.fec_committee_id = o.fec_committee_id
   WHERE o.source = 'fix1266-top200-2026-10-05'
     AND o.financial_entity_id IS NULL
     AND NOT COALESCE(fe.is_synthetic, false);
  IF v_cohort <> 6 THEN
    RAISE EXCEPTION 'FIX-1266: expected 6 resolved non-synthetic rows in the cohort, found %.', v_cohort;
  END IF;
  IF v_nulls <> 3 THEN
    RAISE EXCEPTION 'FIX-1266: expected 3 NULL-industry rows in the cohort, found %.', v_nulls;
  END IF;

  -- A non-NULL override whose committee also held an ai row for a DIFFERENT
  -- industry would leave that committee with two industries: the curated row
  -- wins the pick, but the ai row survives every clear. None of the three
  -- holds one (read 2); this keeps it that way.
  SELECT string_agg(o.fec_committee_id || ' ai ' || et.tag, '; ') INTO v_bad
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.fec_committee_id = o.fec_committee_id
    JOIN public.entity_tags et ON et.entity_id = fe.id
   WHERE o.source = 'fix1266-top200-2026-10-05' AND o.industry IS NOT NULL
     AND et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     AND et.generated_by = 'ai' AND et.tag <> o.industry;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1266: an ai row disagrees with a non-NULL override: %', v_bad;
  END IF;

  -- 742 (FIX-916) + 50 (FIX-921) + 1 (FIX-923) + 13 (FIX-1255) + 2 (FIX-1204) + 6 (this) = 814.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 814 THEN
    RAISE EXCEPTION
      'FIX-1266: override table should hold 814 rows (742 + 50 + 1 + 13 + 2 + 6 FIX-1266), holds %.', v_total;
  END IF;

  RAISE NOTICE 'FIX-1266 OK — six committee-arm overrides (cohort %, % NULL, table % rows).', v_cohort, v_nulls, v_total;
END
$do$;

COMMIT;
