-- FIX-911 / FIX-920 — remove the `other` industry rows the AI classifier wrote.
--
-- BACKGROUND. ai-classifier.ts coerced every model abstention and every
-- unparseable answer to the literal `other` and wrote it to entity_tags as a
-- real industry row. `other` is not a member of VALID_INDUSTRIES, so those rows
-- are out-of-vocabulary drift of exactly the class FIX-890's write-boundary
-- guard exists to stop -- they escaped it because that guard lives in the drain
-- path and this one upserts over PostgREST. The writer is fixed in the same
-- commit as this migration; this cleans up what it already wrote.
--
-- WHY DELETE RATHER THAN RELABEL. `other` asserts nothing a reader can use. An
-- "Other" pill is strictly worse than no pill -- it occupies a tier-1 slot on
-- the donor card while conveying less than blank space. Same reasoning as the
-- 362 NULL curated overrides in FIX-916, which assert "no industry, ever" for
-- precisely this class of committee.
--
-- THE EIGHT, INSPECTED INDIVIDUALLY (prod + local, 2026-07-29 -- identical sets).
-- Seven are leadership PACs, joint fundraising committees or ideological PACs.
-- They have no industry, so `other` was the model telling the truth in a
-- vocabulary that had no way to express it. Note the confidences: 0.20-0.30,
-- i.e. the model was not confident, because it was abstaining.
--
--   TEAM ROGERS                  C00884296  0.20  leadership PAC
--   ROSENDALE VICTORY FUND       C00749788  0.20  joint fundraising committee
--   STOP MAGA PAC                C00549014  0.20  ideological PAC
--   TEAM MCHENRY                 C00544650  0.30  leadership PAC
--   LEAN FORWARD AMERICA         C00930396  0.30  ideological PAC
--   COURAGEOUS LEADERS           C00843029  0.20  leadership PAC
--   SAM BROWN VICTORY COMMITTEE  C00845396  0.20  joint fundraising committee
--
-- THE EIGHTH IS DELIBERATELY LEFT IN PLACE:
--
--   HILL-ROM HOLDINGS, INC. PAC  C00448993  0.85  *** A REAL INDUSTRY ***
--
-- Hill-Rom Holdings is a hospital-equipment and medical-technology manufacturer
-- (patient beds, monitoring; acquired by Baxter International in 2021). That is
-- plainly `health`, not an abstention -- and its confidence is 0.85 against
-- 0.20-0.30 for the other seven, which is the tell: the model was NOT
-- abstaining, it recognised the company and the coercion threw the answer away
-- while keeping the confidence number. That is the FIX-908 root cause captured
-- in a single row: at classification time the vocabulary had no `health` key
-- (it was `pharma`), so a correct answer like "healthcare" or "medical" was not
-- a vocabulary member and got collapsed to `other`.
--
-- It is NOT deleted here because deleting it would discard a correct
-- classification, and NOT relabelled here because assigning an industry is the
-- curated-override table's job (FIX-916), not a cleanup migration's -- and
-- extending that list was explicitly out of scope for this change. Tracked as
-- its own FIX; the surviving row also gives the FIX-920 skip-with-warning path
-- a live row to exercise, which is a better test than a fixture.
--
-- IDEMPOTENT: scoped to an explicit fec_committee_id list, so re-applying it on
-- an already-clean env deletes nothing and raises no exception. It cannot
-- over-delete, and under-deleting is the correct no-op.

BEGIN;

DO $do$
DECLARE
  v_deleted  int;
  v_remaining int;
  v_names    text;
BEGIN
  WITH del AS (
    DELETE FROM public.entity_tags et
     USING public.financial_entities fe
     WHERE et.entity_type  = 'financial_entity'
       AND et.tag_category = 'industry'
       AND et.tag          = 'other'
       AND et.entity_id    = fe.id
       AND fe.fec_committee_id IN (
         'C00884296',  -- TEAM ROGERS
         'C00749788',  -- ROSENDALE VICTORY FUND
         'C00549014',  -- STOP MAGA PAC
         'C00544650',  -- TEAM MCHENRY
         'C00930396',  -- LEAN FORWARD AMERICA
         'C00843029',  -- COURAGEOUS LEADERS
         'C00845396'   -- SAM BROWN VICTORY COMMITTEE
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RAISE NOTICE 'FIX-911: deleted % `other` industry row(s) (7 expected on an env that has not run this before)', v_deleted;

  -- Drift alarm, NOTICE-level. After this migration the only out-of-vocabulary
  -- industry row that should exist anywhere is HRPAC's. Anything else means a
  -- writer we have not found yet is still producing junk -- which is the whole
  -- premise of FIX-911, so it is worth naming rather than counting.
  SELECT count(*), string_agg(DISTINCT fe.display_name || ' [' || et.tag || ']', '; ')
    INTO v_remaining, v_names
    FROM public.entity_tags et
    JOIN public.financial_entities fe ON fe.id = et.entity_id
   WHERE et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
     AND et.tag <> ALL (ARRAY['health','oil_gas','finance','tech','defense',
                              'real_estate','labor','agriculture','legal',
                              'retail','transportation','lobby','utilities',
                              'manufacturing','mining','media']);

  IF v_remaining > 1 THEN
    RAISE WARNING 'FIX-911: % out-of-vocabulary industry row(s) remain (1 expected -- HRPAC). Offenders: %',
      v_remaining, v_names;
  ELSE
    RAISE NOTICE 'FIX-911: % out-of-vocabulary industry row(s) remain as expected: %',
      v_remaining, COALESCE(v_names, '(none)');
  END IF;
END
$do$;

COMMIT;
