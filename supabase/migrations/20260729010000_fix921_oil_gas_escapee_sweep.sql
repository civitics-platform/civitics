-- FIX-921 — sweep 50 non-fossil donors out of `oil_gas`.
--
-- Second curated-override cohort. Same table, same mechanism, same write path as
-- FIX-916: rows land in public.financial_entity_industry_overrides with
-- generated_by='curated', and tagFinancialEntities() already applies that table
-- as the LAST WORD over the keyword+NAICS set. No producer change is needed --
-- and an override applied anywhere ELSE would be shadowed by a freshly
-- re-inserted keyword tag on the next nightly. See the block comment above
-- applyIndustryOverrides() in packages/data/src/pipelines/tags/rules.ts.
--
-- WHY THE `oil_gas` KEYWORD LIST OVER-CAPTURES. INDUSTRY_KEYWORDS.oil_gas
-- matches on "gas", "oil", "coal", "mining", "energy"-adjacent terms and the
-- bare token "bp". That sweeps in every gas UTILITY, every coal MINER, turbine
-- and mining-equipment MANUFACTURERS, an olive OIL trade association, and --
-- the case that started this -- CNG Holdings, which is Check 'n Go, a consumer
-- lender whose initials merely look like compressed natural gas.
--
-- FIX-908 pinned the `oil_gas` label NARROW ("Oil & Gas", not "Energy &
-- Utilities") precisely so the money_vote_influence HR 26 measure keeps meaning
-- what it says. That pin is only honest if the tag's CONTENTS are narrow too.
-- This migration makes the contents match the label.
--
-- WHY 50 AND NOT 15. The first candidate list was derived from the HR 26
-- roll-call cohort. Sweeping the WHOLE tag's 128 donating donors instead found
-- 50 -- so a cohort-derived list would have corrected the one measure being
-- looked at and left two thirds of the contamination in place everywhere else.
--
-- COMPOSITION (50 = 45 re-assigned + 5 de-tagged):
--   23  utilities      electric / gas / renewables / nuclear
--   15  mining         coal (10) + hardrock (5)
--    4  manufacturing  turbines, mining equipment, chemicals
--    2  agriculture    corn refiners, olive oil producers
--    1  finance        CNG Holdings -- consumer lending, NOT natural gas
--    5  NONE           leadership / abstract PACs + a waste-services firm
--
-- NOT INCLUDED, DELIBERATELY -- six donors that need a human call, not a guess.
-- Each is genuinely ambiguous between fossil, renewable and abstract-PAC:
--   AMERICA NEEDS NEW INNOVATION AND ENERGY PAC  $220k
--   FUEL FOR THE FUTURE PAC                       $68k
--   GENIE ENERGY PAC                              $52k
--   ABSOLUTE ENERGY PAC                           $38k  (possibly ethanol)
--   WORLD ENERGY PAC                              $35k
--   COALITION FOR RENEWABLE NATURAL GAS            $9k
--
-- NOT ADDRESSABLE -- two more escapees carry a NULL fec_committee_id, which is
-- this table's PRIMARY KEY, so the mechanism structurally cannot reach them:
-- Cumberland Energy Action Fund ($135k) and Ridge Coal Legacy Trust ($15k).
-- Measured 2026-07-29: only 4 industry-tagged donating donors are in that
-- position across the whole database ($416,500), so the key stays as-is.
-- Filed as FIX-922 rather than fixed here.
--
-- Source of truth for the rows is docs/audits/2026-07-28-oil-gas-escapees.tsv,
-- committed alongside and pinned against this file by industry-overrides.test.ts.
--
-- DATA-STATE, NOT SCHEMA. Seeding the table is only half the change: the
-- officials-side pills come from official_sector_affinity_rollup, whose
-- incremental refresh keys off financial_relationships.updated_at. A tag-only
-- change never enters that dirty set, so each env needs
-- tagFinancialEntities() re-run AND a full
-- CALL backfill_official_sector_affinity_rollup() before the pills move. That
-- trap is what left FIX-916 invisible on prod for 11 days.

BEGIN;

INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, industry, display_name_at_audit, audited_sector, source)
VALUES
  ('C00554444', 'utilities', 'ONE GAS, INC. PAC', 'gas_utility', 'audit-2026-07-28-oil-gas'),
  ('C00381020', 'utilities', 'PORTLAND GENERAL ELECTRIC CO. BI-PARTISAN COMM.', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00125732', 'utilities', 'BLACK HILLS CORPORATION PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00111310', 'utilities', 'EVERGY EMPLOYEE POWERPAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00161422', 'utilities', 'TECO ENERGY INC EMPLOYEES'' PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00144147', 'utilities', 'MISSISSIPPI POWER COMPANY FEDERAL PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00153379', 'utilities', 'NV ENERGY PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00082800', 'utilities', 'PACIFICORP - PACIFIC POWER/ROCKY MOUNTAIN POWER PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00340455', 'utilities', 'ESSENTIAL UTILITIES, INC. PAC', 'gas_utility', 'audit-2026-07-28-oil-gas'),
  ('C00041038', 'utilities', 'AVISTA EMPLOYEES FOR EFFECTIVE GOVERNMENT', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00025395', 'utilities', 'TXNM ENERGY, INC. EMPLOYEE PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00102160', 'utilities', 'EVERSOURCE ENERGY PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00083832', 'utilities', 'IDA-PAC (IDACORP)', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00102152', 'utilities', 'WASHINGTON GAS LIGHT COMPANY/SEMCO ENERGY EMPLOYEE PAC', 'gas_utility', 'audit-2026-07-28-oil-gas'),
  ('C00337808', 'utilities', 'OGE ENERGY CORP EMPLOYEES PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00524769', 'utilities', 'UNS ENERGY CORPORATION PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00068056', 'utilities', 'NORTHWESTERN ENERGY MONTANA EMPLOYEE PAC', 'electric_utility', 'audit-2026-07-28-oil-gas'),
  ('C00831206', 'utilities', 'SPIRE INC. FEDERAL PAC', 'gas_utility', 'audit-2026-07-28-oil-gas'),
  ('C00847764', 'utilities', 'CLEARWAY ENERGY INC PAC', 'renewables', 'audit-2026-07-28-oil-gas'),
  ('C00577155', 'utilities', 'APEX CLEAN ENERGY INC PAC', 'renewables', 'audit-2026-07-28-oil-gas'),
  ('C00686949', 'utilities', 'PATTERN ENERGY GROUP INC. PAC', 'renewables', 'audit-2026-07-28-oil-gas'),
  ('C00865378', 'utilities', 'MN8 ENERGY LLC PAC', 'renewables', 'audit-2026-07-28-oil-gas'),
  ('C00743468', 'utilities', 'HOLTEC INTERNATIONAL ENERGY PAC', 'nuclear', 'audit-2026-07-28-oil-gas'),
  ('C00167668', 'mining', 'ARCH RESOURCES INC. PAC (ARCHPAC)', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00279331', 'mining', 'CORE NATURAL RESOURCES, INC. (CORE PAC)', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00725804', 'mining', 'HALLADOR ENERGY COMPANY PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00410985', 'mining', 'MURRAY ENERGY CORPORATION PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00485003', 'mining', 'CLOUD PEAK ENERGY RESOURCES LLC EMPLOYEE PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00381277', 'mining', 'OHIO COAL ASSOCIATION PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00282459', 'mining', 'LIGNITE ENERGY COUNCIL PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00303685', 'mining', 'NORTH AMERICAN COAL CORP. PAC (NACPAC)', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00745513', 'mining', 'WEST VIRGINIANS FOR COAL', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00807057', 'mining', 'WARRIOR MET COAL, INC. FEDERAL PAC', 'coal_mining', 'audit-2026-07-28-oil-gas'),
  ('C00124016', 'mining', 'HECLA MINING COMPANY/HECLA LIMITED PAC', 'hardrock_mining', 'audit-2026-07-28-oil-gas'),
  ('C00206672', 'mining', 'NEWMONT CORPORATION PAC (NEWPAC)', 'hardrock_mining', 'audit-2026-07-28-oil-gas'),
  ('C00243675', 'mining', 'RIO TINTO AMERICA INC. PAC', 'hardrock_mining', 'audit-2026-07-28-oil-gas'),
  ('C00320580', 'mining', 'BARRICK GOLD OF NORTH AMERICA INC. EMPLOYEES PAF', 'hardrock_mining', 'audit-2026-07-28-oil-gas'),
  ('C00100289', 'mining', 'GEORGIA MINING ASSOCIATION PAC', 'hardrock_mining', 'audit-2026-07-28-oil-gas'),
  ('C00235911', 'manufacturing', 'CHROMALLOY CORPORATION/CHROMALLOY GAS TURBINE LLC PAC', 'industrial_manufacturing', 'audit-2026-07-28-oil-gas'),
  ('C00334581', 'manufacturing', 'KOMATSU MINING CORP. PAC', 'industrial_manufacturing', 'audit-2026-07-28-oil-gas'),
  ('C00565309', 'manufacturing', 'MITSUBISHI POWER AMERICAS, INC. PAC', 'industrial_manufacturing', 'audit-2026-07-28-oil-gas'),
  ('C00075994', 'manufacturing', 'ASHLAND LLC PAC FOR EMPLOYEES', 'chemicals', 'audit-2026-07-28-oil-gas'),
  ('C00554071', 'agriculture', 'CORN REFINERS ASSOCIATION PAC', 'agribusiness_processor', 'audit-2026-07-28-oil-gas'),
  ('C00630574', 'agriculture', 'AMERICAN OLIVE OIL PRODUCERS ASSOCIATION FEDERAL PAC', 'agriculture_trade_assoc', 'audit-2026-07-28-oil-gas'),
  ('C00441311', 'finance', 'CNG HOLDINGS, INC. PAC', 'consumer_lending', 'audit-2026-07-28-oil-gas'),
  ('C00375782', NULL, 'US ECOLOGY, INC. PAC', 'other_services', 'audit-2026-07-28-oil-gas'),
  ('C00516724', NULL, 'JOBS, ENERGY AND OUR FOUNDING FATHERS PAC', 'leadership_or_party_pac', 'audit-2026-07-28-oil-gas'),
  ('C00767863', NULL, 'AXNE PAC (AMERICANS X-PECT NEW ENERGY)', 'leadership_or_party_pac', 'audit-2026-07-28-oil-gas'),
  ('C00684506', NULL, 'YUKON KUSKO PAC INC', 'leadership_or_party_pac', 'audit-2026-07-28-oil-gas'),
  ('C00611400', NULL, 'NEW ENERGY IN WASHINGTON HOUSE PAC', 'leadership_or_party_pac', 'audit-2026-07-28-oil-gas')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector,
      source                = EXCLUDED.source;

-- ---------------------------------------------------------------------------
-- Seed assertions
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  v_sweep   int;
  v_nonnull int;
  v_null    int;
  v_total   int;
  v_orphan  int;
  v_sample  text;
BEGIN
  SELECT count(*), count(industry), count(*) - count(industry)
    INTO v_sweep, v_nonnull, v_null
    FROM public.financial_entity_industry_overrides
   WHERE source = 'audit-2026-07-28-oil-gas';

  IF v_sweep <> 50 OR v_nonnull <> 45 OR v_null <> 5 THEN
    RAISE EXCEPTION
      'FIX-921 seed assertion failed: expected 50/45/5 (total/re-assigned/de-tagged), got %/%/%',
      v_sweep, v_nonnull, v_null;
  END IF;

  -- The combined table. 742 (FIX-916) + 50 (this) = 792. Asserted so that a
  -- future cohort colliding with an existing fec_committee_id (which ON CONFLICT
  -- would silently absorb as an UPDATE) is caught rather than quietly shrinking
  -- the table.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 792 THEN
    RAISE EXCEPTION
      'FIX-921: override table should hold 792 rows (742 FIX-916 + 50 FIX-921), holds %. '
      'A collision between the two cohorts would present exactly this way.', v_total;
  END IF;

  -- Same hard-error-on-orphan contract as FIX-916 decision 10: every id came
  -- from a join against financial_entities, so a miss means the override list
  -- and the entity table disagree, and seeding partially would hide that.
  SELECT count(*) INTO v_orphan
    FROM public.financial_entity_industry_overrides o
   WHERE o.source = 'audit-2026-07-28-oil-gas'
     AND NOT EXISTS (
       SELECT 1 FROM public.financial_entities fe
        WHERE fe.fec_committee_id = o.fec_committee_id
     );

  IF v_orphan > 0 THEN
    SELECT string_agg(o.fec_committee_id, ', ')
      INTO v_sample
      FROM public.financial_entity_industry_overrides o
     WHERE o.source = 'audit-2026-07-28-oil-gas'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_entities fe
          WHERE fe.fec_committee_id = o.fec_committee_id
       );
    RAISE EXCEPTION
      'FIX-921: % override row(s) reference an fec_committee_id absent from financial_entities (%). Refusing to seed partially.',
      v_orphan, v_sample;
  END IF;

  RAISE NOTICE 'FIX-921 seed OK: 50 rows (45 re-assigned, 5 de-tagged), table now % rows, 0 orphans',
    v_total;
END
$do$;

-- ---------------------------------------------------------------------------
-- One-time cleanup of surviving generated_by='ai' industry rows for THIS cohort.
--
-- Identical reasoning to FIX-916 section 4: clear_financial_entity_rule_tags()
-- is scoped to generated_by='rule', so an AI-derived industry row persists
-- forever unless deleted explicitly -- and it would shadow the curation on every
-- consuming surface. Scoped to this sweep's 50 donors only; the unaudited tail
-- is deliberately left alone.
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  v_deleted int;
BEGIN
  WITH del AS (
    DELETE FROM public.entity_tags et
     USING public.financial_entities fe,
           public.financial_entity_industry_overrides o
     WHERE et.entity_type  = 'financial_entity'
       AND et.tag_category = 'industry'
       AND et.generated_by = 'ai'
       AND et.entity_id    = fe.id
       AND fe.fec_committee_id = o.fec_committee_id
       AND o.source = 'audit-2026-07-28-oil-gas'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RAISE NOTICE 'FIX-921: deleted % generated_by=''ai'' industry row(s) for the swept donors', v_deleted;
END
$do$;

COMMIT;
