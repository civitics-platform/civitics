-- FIX-923 — relabel HRPAC, the one surviving out-of-vocabulary `other` industry
-- row, to `health` via the curated-override table.
--
-- HILL-ROM HOLDINGS, INC. POLITICAL ACTION COMMITTEE (HRPAC), fec_committee_id
-- C00448993 — hospital beds and patient monitoring, acquired by Baxter
-- International in 2021. Settled from the entity record, not from the "HRPAC"
-- abbreviation. Deliberately left in place by the FIX-911 cleanup migration
-- (20260729000000), which deleted the seven true abstentions around it.
--
-- WHY THIS ROW MATTERS (the point of the bullet): its confidence was 0.85,
-- against 0.20-0.30 for the seven deleted abstentions. The pre-FIX-911 coercion
-- DISCARDED the model's correct answer while KEEPING its confidence number —
-- FIX-908's root cause reproduced in a single row: at classification time the
-- vocabulary had no `health` key (it was `pharma`), so a correct answer like
-- "healthcare" was not a vocabulary member and collapsed to `other`.
--
-- Mechanism: the existing curated-override table, no special case. The row
-- lands in financial_entity_industry_overrides; tagFinancialEntities() applies
-- that table as the last word on its next run and writes the
-- generated_by='curated' `health` tag. Its own cohort (source
-- 'fix923-hrpac-relabel') so the FIX-916 (742-row) and FIX-921 (50-row) seed
-- drift alarms stay intact.
--
-- CLOSING THIS ALSO CLOSES FIX-909's RESIDUAL `other` TOLERANCE. 20260727000000
-- tolerated `other` blanket-wide; 20260729000000 tightened that to "expect
-- exactly HRPAC, WARN on anything else". With HRPAC relabelled the tolerance
-- goes to ZERO out-of-vocabulary and becomes a hard assertion (section 4
-- below; re-runnable form in packages/data verify-sector-affinity-trigger.ts).
--
-- The `other` row deletion here is itself a tag-content change, so the FIX-958
-- signature moves and the next refresh rebuilds exactly HRPAC's recipients —
-- this migration is the first real consumer of that mechanism.
--
-- IDEMPOTENT: the insert upserts, the delete is scoped to one committee id, and
-- the assertions hold on an already-migrated env.

BEGIN;

-- ── 1. Decision-9 pre-check: no NEW `other` rows may have appeared ───────────
-- After 20260729000000 the ONLY `other` industry row anywhere should be
-- HRPAC's. Anything else means the FIX-911 classifier guard is leaking —
-- STOP-and-report (the exception aborts this migration) rather than relabel on
-- top of an active writer bug.
DO $do$
DECLARE
  v_leak  int;
  v_names text;
BEGIN
  SELECT count(*),
         string_agg(fe.display_name || ' [' || COALESCE(fe.fec_committee_id, 'NULL') || ']', '; ')
    INTO v_leak, v_names
    FROM public.entity_tags et
    JOIN public.financial_entities fe ON fe.id = et.entity_id
   WHERE et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
     AND et.tag          = 'other'
     AND COALESCE(fe.fec_committee_id, '') <> 'C00448993';

  IF v_leak > 0 THEN
    RAISE EXCEPTION
      'FIX-923 STOP: % unexpected `other` industry row(s) beyond HRPAC — the FIX-911 '
      'classifier guard is leaking; investigate the writer before relabelling. Offenders: %',
      v_leak, v_names;
  END IF;
END
$do$;

-- ── 2. The override row ──────────────────────────────────────────────────────
INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, industry, display_name_at_audit, audited_sector, source)
VALUES
  ('C00448993', 'health',
   'HILL-ROM HOLDINGS, INC. POLITICAL ACTION COMMITTEE (HRPAC)',
   'medical_devices', 'fix923-hrpac-relabel')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector,
      source                = EXCLUDED.source;

-- ── 3. One-time cleanup of HRPAC's surviving generated_by='ai' rows ──────────
-- Same reasoning as FIX-916 section 4 / FIX-921: clear_financial_entity_rule_tags()
-- is scoped to generated_by='rule', so the ai-written `other` row would persist
-- beside the incoming curated `health` row forever, breaking the
-- exactly-one-industry invariant.
DO $do$
DECLARE
  v_deleted int;
BEGIN
  WITH del AS (
    DELETE FROM public.entity_tags et
     USING public.financial_entities fe
     WHERE et.entity_type  = 'financial_entity'
       AND et.tag_category = 'industry'
       AND et.generated_by = 'ai'
       AND et.entity_id    = fe.id
       AND fe.fec_committee_id = 'C00448993'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RAISE NOTICE 'FIX-923: deleted % generated_by=''ai'' industry row(s) for HRPAC (1 expected on first apply)', v_deleted;
END
$do$;

-- ── 4. Seed + zero-tolerance assertions ──────────────────────────────────────
DO $do$
DECLARE
  v_total  int;
  v_orphan int;
  v_oov    int;
  v_names  text;
BEGIN
  -- Hard-error-on-orphan, same contract as FIX-916 decision 10 / FIX-921.
  SELECT count(*) INTO v_orphan
    FROM public.financial_entity_industry_overrides o
   WHERE o.source = 'fix923-hrpac-relabel'
     AND NOT EXISTS (
       SELECT 1 FROM public.financial_entities fe
        WHERE fe.fec_committee_id = o.fec_committee_id);
  IF v_orphan > 0 THEN
    RAISE EXCEPTION
      'FIX-923: C00448993 does not resolve to a financial_entities row. Refusing to seed.';
  END IF;

  -- Combined table: 742 (FIX-916) + 50 (FIX-921) + 1 (this) = 793. A collision
  -- with an existing cohort would be silently absorbed by ON CONFLICT and
  -- present as a shrunken count — same drift alarm as FIX-921.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 793 THEN
    RAISE EXCEPTION
      'FIX-923: override table should hold 793 rows (742 FIX-916 + 50 FIX-921 + 1 HRPAC), holds %.',
      v_total;
  END IF;

  -- THE TIGHTENED FIX-909 TOLERANCE — zero out-of-vocabulary, `other` included.
  -- 20260727000000 tolerated `other` blanket-wide; 20260729000000 narrowed that
  -- to expect-exactly-HRPAC-WARN-otherwise; with HRPAC's row deleted above this
  -- is now a hard EXCEPTION on ANY financial-entity industry tag outside the
  -- 16-key vocabulary.
  SELECT count(*),
         string_agg(DISTINCT fe.display_name || ' [' || et.tag || ']', '; ')
    INTO v_oov, v_names
    FROM public.entity_tags et
    JOIN public.financial_entities fe ON fe.id = et.entity_id
   WHERE et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
     AND et.tag <> ALL (ARRAY['health','oil_gas','finance','tech','defense',
                              'real_estate','labor','agriculture','legal',
                              'retail','transportation','lobby','utilities',
                              'manufacturing','mining','media']);
  IF v_oov <> 0 THEN
    RAISE EXCEPTION
      'FIX-923: % out-of-vocabulary industry row(s) remain (0 expected — the FIX-909 '
      'tolerance is now zero). Offenders: %', v_oov, v_names;
  END IF;

  RAISE NOTICE 'FIX-923 OK — HRPAC override seeded (table now % rows), out-of-vocabulary industry rows = 0.',
    v_total;
END
$do$;

COMMIT;
