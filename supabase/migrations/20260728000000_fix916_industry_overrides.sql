-- FIX-916 — curated industry overrides for financial entities.
--
-- GENERATED FROM  docs/audits/2026-07-27-industry-tag-overrides.tsv
-- Do not hand-edit the seed block below. The TSV is the reviewable provenance
-- for every row here; regenerate rather than patching SQL by hand.
--
-- WHAT THIS IS
-- ------------
-- The 2026-07-27 dollar-weighted audit hand-classified 1,438 donors covering
-- 90-100% of each industry tag's donation dollars, against a measured baseline
-- of no tag above 79% accuracy and a 41% median (see FIX-908). It produced a
-- 742-donor override list: 380 donors carrying the WRONG industry and
-- 362 that are not industries at all (leadership PACs, party committees and
-- abstract vanity PACs -- WinRed, NRSC, Save America, Huck PAC, AmeriPAC were
-- all tagged 'lobby').
--
-- This was a deliberate HAND CURATION, not an AI re-run. See FIX-917 for the
-- guard that stops the AI classifier re-tagging the de-tagged committees.
--
-- KEYED ON fec_committee_id, NOT financial_entities.id
-- ----------------------------------------------------
-- UUIDs are not portable across a re-seed; FEC committee IDs are the stable
-- external key, and financial_entities.fec_committee_id already carries a UNIQUE
-- index. Verified 2026-07-27: all 742 audited donors have a
-- fec_committee_id and all 742 are distinct.
--
-- industry IS NULL IS A POSITIVE ASSERTION
-- ----------------------------------------
-- It means "this donor carries no industry, ever" -- NOT "unknown". The producer
-- must SUPPRESS tagging for these, not merely omit them: several trip the
-- keyword list on their own names. Note the 362 NULLs include 27 donors whose
-- audited sector has no bucket in the vocabulary at all (waste services,
-- education, nonprofits, professional associations). Those are deliberately NULL
-- and NOT 'other' -- an "Other" pill tells a reader nothing, and NULL is the
-- honest state. Do not "improve" them to 'other'.
--
-- APPLICATION LIVES IN packages/data/src/pipelines/tags/rules.ts
-- -------------------------------------------------------------
-- tagFinancialEntities() calls clear_financial_entity_rule_tags(['industry']),
-- which DELETEs every generated_by='rule' industry row and re-inserts from the
-- keyword list. An override applied anywhere else is shadowed on the next
-- nightly. See the block comment above applyIndustryOverrides().

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.financial_entity_industry_overrides (
  fec_committee_id      text PRIMARY KEY,
  -- NULL = "no industry, ever" (see header). Non-null must be a VALID_INDUSTRIES
  -- member; the CHECK below is generated from packages/data/src/pipelines/tags/
  -- topics.ts and pinned against it by industry-overrides.test.ts, so this is a
  -- mirror with a drift alarm rather than a second source of truth.
  industry              text NULL,
  display_name_at_audit text,
  audited_sector        text,
  source                text NOT NULL DEFAULT 'audit-2026-07-27',
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.financial_entity_industry_overrides IS
  'FIX-916. Hand-curated industry assignments for financial entities, keyed on '
  'fec_committee_id. Applied as the last word inside tagFinancialEntities() -- '
  'anywhere else and the nightly keyword rebuild shadows it. industry IS NULL '
  'means "no industry, ever" (a positive assertion), not "unknown". Source of '
  'truth for the rows is docs/audits/2026-07-27-industry-tag-overrides.tsv.';

COMMENT ON COLUMN public.financial_entity_industry_overrides.industry IS
  'NULL = positive assertion that this entity has no industry (political '
  'committee, or a sector with no bucket in the vocabulary). Must SUPPRESS '
  'tagging, not merely omit it.';

COMMENT ON COLUMN public.financial_entity_industry_overrides.audited_sector IS
  'The finer-grained sector the auditor actually recorded (e.g. credit_union, '
  'electric_utility, leadership_or_party_pac). Carried into entity_tags.metadata '
  'so the number behind the coarse label stays auditable.';

-- Idempotent CHECK add: the constraint list mirrors VALID_INDUSTRIES.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_entity_industry_overrides'::regclass
       AND conname  = 'financial_entity_industry_overrides_industry_vocab'
  ) THEN
    ALTER TABLE public.financial_entity_industry_overrides
      ADD CONSTRAINT financial_entity_industry_overrides_industry_vocab
      CHECK (industry IS NULL OR industry = ANY (ARRAY['health', 'oil_gas', 'finance', 'tech', 'defense', 'real_estate', 'labor', 'agriculture', 'legal', 'retail', 'transportation', 'lobby', 'utilities', 'manufacturing', 'mining', 'media']));
  END IF;
END
$do$;

-- Pipeline-internal only -- there is no read path from the app. RLS on with zero
-- policies plus an explicit REVOKE: Supabase's platform default privileges
-- auto-GRANT anon/authenticated on every new public table (FIX-834/835).
ALTER TABLE public.financial_entity_industry_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_entity_industry_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_entity_industry_overrides TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Seed -- 742 rows (380 re-assigned, 362 de-tagged)
--    Generated from the audit TSV. ON CONFLICT DO UPDATE so re-applying the
--    migration converges rather than erroring.
-- ---------------------------------------------------------------------------

INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, industry, display_name_at_audit, audited_sector)
VALUES
  ('C00007880', 'finance', 'AMERICA''S CREDIT UNIONS PAC OF CREDIT UNION NATIONAL ASSOCIATION, INC.', 'credit_union'),
  ('C00694323', NULL, 'WINRED', 'leadership_or_party_pac'),
  ('C00040998', 'retail', 'NATIONAL AUTOMOBILE DEALERS ASSOCIATION POLITICAL ACTION COMMITTEE', 'retail_general'),
  ('C00002469', 'labor', 'MACHINISTS NON PARTISAN POLITICAL LEAGUE OF THE INTERNATIONAL ASSOCIATION OF MACHINISTS & AEROSPACE WORKERS', 'labor_union'),
  ('C00096156', 'manufacturing', 'HONEYWELL INTERNATIONAL POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00010868', 'real_estate', 'AMERICAN COUNCIL OF ENGINEERING COMPANIES (ACEC/PAC)', 'engineering_construction'),
  ('C00002972', 'utilities', 'NATIONAL RURAL ELECTRIC COOPERATIVE ASSOCIATION AMERICA''S ELECTRIC COOPERATIVES PAC', 'rural_electric_coop'),
  ('C00035451', 'labor', 'AIR LINE PILOTS ASSOCIATION PAC', 'labor_union'),
  ('C00007542', 'labor', 'INTERNATIONAL ASSOCIATION OF SHEET METAL, AIR, RAIL AND TRANSPORTATION WORKERS POLITICAL ACTION LEAGUE', 'labor_union'),
  ('C00024968', 'health', 'AMERICAN OPTOMETRIC ASSOCIATION POLITICAL ACTION COMMITTEE', 'health_provider'),
  ('C00211318', 'legal', 'DELOITTE POLITICAL ACTION COMMITTEE', 'accounting_consulting'),
  ('C00227744', 'legal', 'ERNST & YOUNG POLITICAL ACTION COMMITTEE', 'accounting_consulting'),
  ('C00467431', NULL, 'THE EYE OF THE TIGER POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00004036', 'labor', 'SEIU COPE (SERVICE EMPLOYEES INTERNATIONAL UNION COMMITTEE ON POLITICAL EDUCATION)', 'labor_union'),
  ('C00428052', NULL, 'MAJORITY COMMITTEE PAC--MC PAC', 'leadership_or_party_pac'),
  ('C00027466', NULL, 'NRSC', 'leadership_or_party_pac'),
  ('C00004812', 'finance', 'MORTGAGE BANKERS ASSOCIATION POLITICAL ACTION COMMITTEE (MORPAC)', 'mortgage_finance'),
  ('C00193631', 'finance', 'THE FARM CREDIT COUNCIL POLITICAL ACTION COMMITTEE', 'bank'),
  ('C00542365', 'manufacturing', 'TOYOTA MOTOR NORTH AMERICA, INC POLITICAL ACTION COMMITTEE (TOYOTA/LEXUS PAC)', 'auto_manufacturing'),
  ('C00113811', 'real_estate', 'NATIONAL ELECTRICAL CONTRACTORS ASSOCIATION POLITICAL ACTION COMMITTEE', 'construction_contractor'),
  ('C00448373', NULL, 'HUCK PAC', 'leadership_or_party_pac'),
  ('C00089458', 'mining', 'NATIONAL STONE, SAND & GRAVEL ASSOCIATION ROCKPAC', 'hardrock_mining'),
  ('C00441949', 'lobby', 'JSTREETPAC', 'single_issue_advocacy'),
  ('C00359539', 'health', 'AMERICAN ACADEMY OF DERMATOLOGY ASSOCIATION POLITICAL ACTION COMMITTEE (SKINPAC)', 'health_provider'),
  ('C00271338', NULL, 'AMERIPAC: THE FUND FOR A GREATER AMERICA', 'leadership_or_party_pac'),
  ('C00076810', 'manufacturing', 'GENERAL MOTORS COMPANY POLITICAL ACTION COMMITTEE (GM PAC)', 'auto_manufacturing'),
  ('C00477653', 'tech', 'COX ENTERPRISES PAC (COXPAC) INC.', 'telecom_cable'),
  ('C00002766', 'labor', 'UNITED FOOD AND COMMERCIAL WORKERS INTERNATIONAL UNION ACTIVE BALLOT CLUB', 'labor_union'),
  ('C00008268', 'labor', 'TRANSPORT WORKERS UNION OF AMERICA POLITICAL CONTRIBUTIONS COMMITTEE', 'labor_union'),
  ('C00010470', 'transportation', 'UNION PACIFIC CORP. FUND FOR EFFECTIVE GOVERNMENT', 'railroad'),
  ('C00411116', 'defense', 'SPACE EXPLORATION TECHNOLOGIES CORP. PAC', 'aerospace_civil'),
  ('C00140061', 'health', 'NATIONAL EMERGENCY MEDICINE POLITICAL ACTION COMMITTEE / AMERICAN COLLEGE OF EMERGENCY PHYSICIANS', 'health_provider'),
  ('C00267849', 'labor', 'ALLIED PILOTS ASSOCIATION POLITICAL ACTION COMMITTEE', 'labor_union'),
  ('C00009985', 'media', 'NATIONAL ASSOCIATION OF BROADCASTERS POLITICAL ACTION COMMITTEE (NABPAC)', 'media_entertainment'),
  ('C00148031', 'manufacturing', 'CATERPILLAR INC. POLITICAL ACTION COMMITTEE (CATPAC)', 'industrial_manufacturing'),
  ('C00563726', NULL, 'MR. SOUTHERN MISSOURIAN IN THE HOUSE PAC', 'leadership_or_party_pac'),
  ('C00344234', NULL, 'PAC TO THE FUTURE', 'leadership_or_party_pac'),
  ('C00617803', NULL, 'JOBS, EDUCATION, & FAMILIES FIRST  JEFF PAC', 'leadership_or_party_pac'),
  ('C00639229', NULL, 'AMERICAN REVIVAL PAC', 'unknown_abstract_pac'),
  ('C00592089', NULL, 'ELECTING MAJORITY MAKING EFFECTIVE REPUBLICANS PAC', 'leadership_or_party_pac'),
  ('C00303339', 'real_estate', 'NATIONAL ASSOCIATION OF REAL ESTATE INVESTMENT TRUSTS, INC. POLITICAL ACTION COMMITTEE', 'real_estate'),
  ('C00173153', 'health', 'AMERICAN ASSOCIATION OF NURSE ANESTHETISTS SEPARATE SEGREGATED FUND (CRNA-PAC)', 'health_provider'),
  ('C00280222', 'legal', 'KPMG PARTNERS/PRINCIPALS AND EMPLOYEES PAC', 'accounting_consulting'),
  ('C00480863', 'lobby', 'NATIONAL SHOOTING SPORTS FOUNDATION, INC. POLITICAL ACTION COMMITTEE (NSSF PAC)', 'single_issue_advocacy'),
  ('C00580068', 'lobby', 'PROGRESSIVE TURNOUT PROJECT', 'ideological_advocacy'),
  ('C00066472', 'finance', 'AMERICAN PROPERTY CASUALTY INSURANCE ASSOCIATION POLITICAL ACTION COMMITTEE (INSURING AMERICA PAC)', 'insurance'),
  ('C00552851', NULL, 'HOUSE FREEDOM FUND', 'leadership_or_party_pac'),
  ('C00574970', NULL, 'FAIR SHOT PAC', 'unknown_abstract_pac'),
  ('C00250399', 'retail', 'AUTOMOTIVE FREE INTERNATIONAL TRADE PAC', 'retail_general'),
  ('C00091561', NULL, 'NATIONAL ACTIVE AND RETIRED FEDERAL EMPLOYEES ASSOCIATION POLITICAL ACTION COM (NARFE-PAC)', 'professional_assoc_other'),
  ('C00346353', 'manufacturing', 'CRH AMERICAS, INC. PAC', 'industrial_manufacturing'),
  ('C00431361', 'finance', 'TEACHERS INSURANCE ANNUITY ASSOCIATION OF AMERICA PAC (TIAA PAC)', 'insurance'),
  ('C00570226', NULL, 'SEAL PAC SUPPORTING ELECTING AMERICAN LEADERS PAC', 'leadership_or_party_pac'),
  ('C00573261', 'lobby', 'END CITIZENS UNITED', 'single_issue_advocacy'),
  ('C00340943', 'health', 'DAVITA INC. POLITICAL ACTION COMMITTEE (DAPAC)', 'health_provider'),
  ('C00002840', 'labor', 'UAW - V - CAP (UAW VOLUNTARY COMMUNITY ACTION PROGRAM) ''INT''L UNION UNITED AUTOMOBILE AEROSPACE & AGRICULTURAL IMPLEMENT WORKERS OF AMERICA UAW', 'labor_union'),
  ('C00064774', 'utilities', 'NEXTERA ENERGY, INC. POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00104299', 'finance', 'JPMORGAN CHASE & CO. FEDERAL POLITICAL ACTION COMMITTEE', 'bank'),
  ('C00204099', 'manufacturing', 'DEERE & COMPANY PAC (AKA JOHN DEERE PAC)', 'industrial_manufacturing'),
  ('C00084491', 'lobby', 'INTERNATIONAL FRANCHISE ASSOCIATION FRANCHISING POLITICAL ACTION COMMITTEE INC', 'business_trade_assoc_multisector'),
  ('C00409730', NULL, 'NEW DEMOCRAT COALITION ACTION FUND', 'leadership_or_party_pac'),
  ('C00685297', NULL, 'ELECT DEMOCRATIC WOMEN', 'leadership_or_party_pac'),
  ('C00196246', 'health', 'AMERICAN ACADEMY OF OPHTHALMOLOGY INC POLITICAL COMMITTEE (OPHTHPAC)', 'health_provider'),
  ('C00350744', 'finance', 'THE GOLDMAN SACHS GROUP, INC. POLITICAL ACTION COMMITTEE', 'securities_investment'),
  ('C00072025', 'labor', 'NATIONAL RURAL LETTER CARRIERS'' ASSOCIATION POLITICAL ACTION COMMITTEE', 'labor_union'),
  ('C00027532', 'labor', 'AMERICAN MARITIME OFFICERS VOLUNTARY POLITICAL ACTION FUND', 'labor_union'),
  ('C00540187', NULL, 'INNOVATION POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00271007', 'health', 'HUMANA INC. POLITICAL ACTION COMMITTEE', 'health_insurer'),
  ('C00771246', NULL, 'JOHNSON LEADERSHIP FUND', 'leadership_or_party_pac'),
  ('C00363879', 'utilities', 'ENTERGY CORPORATION EMPLOYEE POLITICAL ACTION COMMITTEE (ENPAC)', 'electric_utility'),
  ('C00336743', 'retail', 'ASIAN AMERICAN HOTEL OWNERS ASSOCIATION PAC (AAHOA PAC)', 'hospitality_travel'),
  ('C00252940', 'lobby', 'LEAGUE OF CONSERVATION VOTERS ACTION FUND', 'single_issue_advocacy'),
  ('C00083535', 'utilities', 'DUKE ENERGY CORPORATION PAC', 'electric_utility'),
  ('C00384818', 'health', 'CVS HEALTH PAC', 'health_insurer'),
  ('C00544817', 'finance', 'STATE FARM MUTUAL AUTOMOBILE INSURANCE COMPANY FEDERAL POLITICAL ACTION COMMITTEE (STATE FARM FEDERAL PAC)', 'insurance'),
  ('C00764233', 'lobby', 'DEFEND THE VOTE', 'single_issue_advocacy'),
  ('C00012914', 'finance', 'AMERICAN LAND TITLE ASSOCIATION TITLE INDUSTRY PAC (TIPAC)', 'financial_trade_assoc'),
  ('C00107300', 'transportation', 'AMERICAN AIRLINES INC. POLITICAL ACTION COMMITTEE (AAPAC)', 'airline'),
  ('C00252338', 'manufacturing', 'AMERICAN CHEMISTRY COUNCIL PAC', 'chemicals'),
  ('C00749481', NULL, 'RAPTOR PAC', 'unknown_abstract_pac'),
  ('C00623512', NULL, 'IN THE ARENA PAC', 'unknown_abstract_pac'),
  ('C00004473', 'tech', 'NATIONAL TELECOMMUNICATIONS COOPERATIVE ASSOCIATION RURAL BROADBAND PAC', 'telecom_cable'),
  ('C00165159', NULL, 'REPUBLICAN MAINSTREET PARTNERSHIP PAC', 'leadership_or_party_pac'),
  ('C00013961', 'real_estate', 'SHEET METAL & AIR CONDITIONING CONTRACTORS'' NATIONAL ASSOC., INC. POLITICAL ACTION COMMITTEE', 'construction_contractor'),
  ('C00503680', 'finance', 'CROP INSURANCE PROFESSIONALS ASSOCIATION PAC-CIPA PAC', 'financial_trade_assoc'),
  ('C00034405', 'manufacturing', 'INTERNATIONAL PAPER POLITICAL ACTION COMMITTEE (IP-PAC)', 'industrial_manufacturing'),
  ('C00114132', 'health', 'AMERICAN VETERINARY MEDICAL ASSOCIATION POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00219642', 'retail', 'ENTERPRISE HOLDINGS, INC. / ENTERPRISE MOBILITY POLITICAL ACTION COMMITTEE', 'hospitality_travel'),
  ('C00375360', 'health', 'AMERICAN COLLEGE OF CARDIOLOGY PAC (HEARTPAC)', 'health_trade_assoc'),
  ('C00095869', 'utilities', 'POWERPAC OF THE EDISON ELECTRIC INSTITUTE', 'electric_utility'),
  ('C00451153', NULL, 'GRIDIRON-PAC', 'unknown_abstract_pac'),
  ('C00540146', NULL, 'FIRST IN FREEDOM PAC', 'unknown_abstract_pac'),
  ('C00411553', 'health', 'AMERICAN ACADEMY OF FAMILY PHYSICIANS POLITICAL ACTION COMMITTEE (FAMMEDPAC)', 'health_trade_assoc'),
  ('C00570945', NULL, 'E-PAC', 'leadership_or_party_pac'),
  ('C00422774', NULL, 'FRONTLINE USA', 'unknown_abstract_pac'),
  ('C00433060', NULL, 'REPUBLICAN GOVERNANCE GROUP/TUESDAY GROUP PAC', 'leadership_or_party_pac'),
  ('C00379628', 'manufacturing', 'NUCOR CORPORATION POLITICAL ACTION COMMITTEE', 'steel_metals'),
  ('C00397851', 'health', 'CENTENE CORPORATION POLITICAL ACTION COMMITTEE (CENTENE PAC)', 'health_insurer'),
  ('C00340075', 'manufacturing', 'BASF CORPORATION EMPLOYEES POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00144774', 'utilities', 'SOUTHERN COMPANY EMPLOYEES PAC', 'electric_utility'),
  ('C00497131', NULL, 'PURPOSE PAC', 'unknown_abstract_pac'),
  ('C00852012', NULL, 'TEAM MCCORMICK', 'leadership_or_party_pac'),
  ('C00262295', 'tech', 'CTIA - THE WIRELESS ASSOCIATION POLITICAL ACTION COMMITTEE', 'telecom_cable'),
  ('C00404392', NULL, 'CONSERVATIVE OPPORTUNITY LEADERSHIP AND ENTERPRISE PAC', 'leadership_or_party_pac'),
  ('C00495028', NULL, 'HMP', 'unknown_abstract_pac'),
  ('C00360669', 'labor', 'SOUTHWEST AIRLINES PILOTS'' ASSOCIATION POLITICAL ACTION COMMITTEE (SWAPA PAC)', 'labor_union'),
  ('C00019653', 'utilities', 'EDISON INTERNATIONAL PAC', 'electric_utility'),
  ('C00573709', NULL, 'CA LUV PAC (CALIFORNIA LEADERSHIP UNITED FOR VICTORY PAC)', 'unknown_abstract_pac'),
  ('C00279216', 'media', 'IHEARTMEDIA INC. PAC', 'media_entertainment'),
  ('C00399196', NULL, 'BUILDING RELATIONSHIPS IN DIVERSE GEOGRAPHIC ENVIRONMENTS PAC', 'leadership_or_party_pac'),
  ('C00000935', NULL, 'DCCC', 'leadership_or_party_pac'),
  ('C00007948', 'manufacturing', 'WEYERHAEUSER COMPANY POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00245548', 'manufacturing', 'NATIONAL MARINE MANUFACTURERS ASSOCIATION AND MARINE RETAILERS ASSOCIATION BOAT PAC', 'industrial_manufacturing'),
  ('C00114025', 'real_estate', 'NATIONAL READY MIXED CONCRETE ASSN. PAC (CONCRETEPAC)', 'construction_contractor'),
  ('C00435933', 'health', 'AMERICAN ACADEMY OF NEUROLOGY BRAINPAC', 'health_trade_assoc'),
  ('C00108209', 'utilities', 'DOMINION ENERGY, INC. POLITICAL ACTION COMMITTEE - DOMINION PAC', 'electric_utility'),
  ('C00015933', 'utilities', 'PINNACLE WEST CAPITAL CORPORATION PAC', 'electric_utility'),
  ('C00450692', 'utilities', 'POET PAC', 'renewables'),
  ('C00141218', 'utilities', 'EXELON CORPORATION POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00365536', NULL, 'CHC BOLD PAC', 'leadership_or_party_pac'),
  ('C00326439', NULL, 'HOUSE CONSERVATIVES FUND', 'leadership_or_party_pac'),
  ('C00008839', 'health', 'AMERICAN PODIATRIC MEDICAL ASSOCIATION POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00557793', 'defense', 'BLUE ORIGIN LLC POLITICAL ACTION COMMITTEE (BLUE ORIGIN PAC)', 'aerospace_civil'),
  ('C00046474', 'manufacturing', 'FORD MOTOR COMPANY CIVIC ACTION FUND', 'auto_manufacturing'),
  ('C00488262', 'labor', 'NETJETS ASSOCIATION OF SHARED AIRCRAFT PILOTS PAC; NJASAP PAC', 'labor_union'),
  ('C00013342', 'labor', 'UNITED MINE WORKERS OF AMERICA - COAL MINERS POLITICAL ACTION COMMITTEE', 'labor_union'),
  ('C00793711', 'utilities', 'CONSTELLATION ENERGY CORPORATION EMPLOYEE POLITICAL ACTION COMMITTEE (CEPAC)', 'nuclear'),
  ('C00188177', 'legal', 'H&R BLOCK INC. POLITICAL ACTION COMMITTEE (BLOCKPAC)', 'accounting_consulting'),
  ('C00008748', 'utilities', 'SEMPRA ENERGY EMPLOYEES POLITICAL ACTION COMMITTEE- FEDERAL', 'gas_utility'),
  ('C00432260', 'lobby', 'CLUB FOR GROWTH PAC', 'ideological_advocacy'),
  ('C00495887', NULL, 'TOMORROW IS MEANINGFUL PAC', 'leadership_or_party_pac'),
  ('C00177469', 'utilities', 'PG&E CORPORATION EMPLOYEES ENERGYPAC', 'electric_utility'),
  ('C00504530', NULL, 'CONGRESSIONAL LEADERSHIP FUND', 'leadership_or_party_pac'),
  ('C00475665', 'utilities', 'GROWTH ENERGY PAC', 'renewables'),
  ('C00097865', 'oil_gas', 'NATSO INC. NATSO PAC', 'fuel_marketing_distribution'),
  ('C00414474', 'finance', 'AMERIPRISE FINANCIAL INC. POLITICAL ACTION COMMITTEE (AMERIPRISEPAC)', 'securities_investment'),
  ('C00034132', 'real_estate', 'FLUOR CORPORATION POLITICAL ACTION COMMITTEE (FLUOR PAC)', 'engineering_construction'),
  ('C00131185', NULL, 'AIRCRAFT OWNERS AND PILOTS ASSOCIATION POLITICAL ACTION COMMITTEE', 'professional_assoc_other'),
  ('C00274944', 'health', 'COLLEGE OF AMERICAN PATHOLOGISTS POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00418897', 'lobby', 'VOTEVETS', 'ideological_advocacy'),
  ('C00325936', 'health', 'SOCIETY OF THORACIC SURGEONS POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00244863', 'real_estate', 'NATIONAL ROOFING CONTRACTORS ASSOCIATION ROOF PAC', 'construction_contractor'),
  ('C00469429', NULL, 'CMR POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00572271', NULL, 'BUILDING AMERICA''S REPUBLICAN REPRESENTATION PAC', 'leadership_or_party_pac'),
  ('C00296640', NULL, 'REPUBLICAN MAJORITY FUND', 'leadership_or_party_pac'),
  ('C00034488', 'retail', 'ANHEUSER-BUSCH COMPANIES LLC POLITICAL ACTION COMMITTEE', 'alcohol'),
  ('C00373696', 'health', 'AMERICAN PSYCHIATRIC ASSOCIATION POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00150367', 'finance', 'NATIONAL VENTURE CAPITAL ASSOCIATION VENTUREPAC', 'private_equity_vc'),
  ('C00199711', 'health', 'HEALTH CARE SERVICE CORPORATION EMPLOYEES'' POLITICAL ACTION COMMITTEE', 'health_insurer'),
  ('C00541169', 'manufacturing', 'NATIONAL ASSOCIATION OF MANUFACTURERS PAC (NAM-PAC)', 'industrial_manufacturing'),
  ('C00112896', 'oil_gas', 'CONOCOPHILLIPS SPIRIT PAC', 'oil_gas_upstream'),
  ('C00139659', 'lobby', 'JOINT ACTION COMMITTEE FOR POLITICAL AFFAIRS', 'single_issue_advocacy'),
  ('C00693002', 'media', 'FOX CORPORATION POLITICAL ACTION COMMITTEE (FOX PAC)', 'media_entertainment'),
  ('C00363945', 'manufacturing', 'SYNGENTA CORPORATION EMPLOYEE POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00358903', 'health', 'AMERICAN ASSOCIATION OF NURSE PRACTITIONERS POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00410068', NULL, 'FRATERNITY & SORORITY POLITICAL ACTION COMMITTEE', 'education'),
  ('C00239848', 'utilities', 'NUCLEAR ENERGY INSTITUTE FEDERAL POLITICAL ACTION COMMITTEE', 'nuclear'),
  ('C00493700', NULL, 'BLUE HEN FEDERAL PAC', 'leadership_or_party_pac'),
  ('C00268904', 'manufacturing', 'TRINITY INDUSTRIES EMPLOYEE POLITICAL ACTION COMMITTEE (SF) INC.', 'industrial_manufacturing'),
  ('C00390161', NULL, 'EUREKA POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00480228', NULL, 'CONTINUING AMERICA''S STRENGTH AND SECURITY PAC', 'unknown_abstract_pac'),
  ('C00075820', NULL, 'NRCC', 'leadership_or_party_pac'),
  ('C00672733', NULL, 'BULLDOG PAC', 'unknown_abstract_pac'),
  ('C00631051', NULL, 'ABRAHAM LINCOLN PAC', 'unknown_abstract_pac'),
  ('C00483487', NULL, 'BRINGING REPUBLICAN EXCELLENCE TO TOWN PAC', 'leadership_or_party_pac'),
  ('C00817338', NULL, 'MVL PAC', 'unknown_abstract_pac'),
  ('C00525600', NULL, 'OFF THE SIDELINES PAC', 'leadership_or_party_pac'),
  ('C00042366', NULL, 'DSCC', 'leadership_or_party_pac'),
  ('C00571000', NULL, 'TRUE NORTH PAC', 'unknown_abstract_pac'),
  ('C00374447', 'real_estate', 'AECOM PAC', 'engineering_construction'),
  ('C00390674', NULL, 'FREEDOM FUND', 'unknown_abstract_pac'),
  ('C00188193', 'lobby', 'WOMEN''S POLITICAL COMMITTEE FEDERAL', 'ideological_advocacy'),
  ('C00567388', 'media', 'NEXSTAR MEDIA GROUP, INC. POLITICAL ACTION COMMITTEE (NEXSTAR PAC)', 'media_entertainment'),
  ('C00089086', 'health', 'THE AMERICAN OCCUPATIONAL THERAPY ASSOCIATION, INC. POLITICAL ACTION COMMITTEE (AOTPAC)', 'health_trade_assoc'),
  ('C00497073', NULL, 'LOBO PAC', 'unknown_abstract_pac'),
  ('C00039461', 'manufacturing', 'BALL CORPORATION POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00503151', NULL, 'UPPER HAND FUND', 'unknown_abstract_pac'),
  ('C00017525', 'health', 'AMERICAN NURSES ASSOCIATION PAC', 'health_trade_assoc'),
  ('C00007450', 'utilities', 'AMERICAN GAS ASSOCIATION POLITICAL ACTION COMMITTEE', 'gas_utility'),
  ('C00531764', NULL, 'A NEW NATION PAC', 'unknown_abstract_pac'),
  ('C00409003', NULL, 'HEARTLAND VALUES PAC', 'leadership_or_party_pac'),
  ('C00366070', 'labor', 'FAA MANAGERS ASSOCIATION INC. PAC', 'labor_union'),
  ('C00107771', 'utilities', 'XCEL ENERGY EMPLOYEE POLITICAL ACTION COMMITTEE (XPAC)', 'electric_utility'),
  ('C00551853', NULL, 'OORAH! POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00679860', 'lobby', 'ANIMAL WELLNESS ACTION PAC', 'single_issue_advocacy'),
  ('C00442368', NULL, 'COMMON VALUES PAC', 'unknown_abstract_pac'),
  ('C00408260', 'legal', 'THE GRANT THORNTON ADVISORS LLC POLITICAL ACTION COMMITTEE', 'accounting_consulting'),
  ('C00413948', NULL, 'ARKANSAS FOR LEADERSHIP POLITICAL ACTION COMMITTEE (ARKPAC)', 'unknown_abstract_pac'),
  ('C00461418', 'labor', 'NATIONAL UNION OF HEALTHCARE WORKERS FEDERAL COMMITTEE ON POLITICAL EDUCATION', 'labor_union'),
  ('C00228106', 'utilities', 'PPL CORPORATION PEOPLE FOR GOOD GOVERNMENT', 'electric_utility'),
  ('C00206136', 'utilities', 'AMEREN CORPORATION FEDERAL POLITICAL ACTION COMMITTEE (AMEREN FEDPAC)', 'electric_utility'),
  ('C00697326', NULL, 'ON WISCONSIN PAC, INC.', 'unknown_abstract_pac'),
  ('C00457754', 'retail', 'U.S. TRAVEL ASSOCIATION PAC', 'hospitality_travel'),
  ('C00348607', 'lobby', 'IMPACT', 'single_issue_advocacy'),
  ('C00544254', NULL, 'PERIMETER PAC', 'unknown_abstract_pac'),
  ('C00692327', NULL, 'LETS GET TO WORK PAC', 'unknown_abstract_pac'),
  ('C00654475', NULL, 'SMART SOLUTIONS PAC', 'unknown_abstract_pac'),
  ('C00492058', NULL, 'LEADERSHIP AND ACCOUNTABILITY ARE NATIONAL KEYS PAC', 'leadership_or_party_pac'),
  ('C00073056', 'labor', 'MASTERS, MATES AND PILOTS POLITICAL CONTRIBUTION FUND', 'labor_union'),
  ('C00200865', NULL, 'ROAD TO FREEDOM CAMPAIGN COMMITTEE', 'leadership_or_party_pac'),
  ('C00693796', NULL, 'BUCKEYE LIBERTY POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00116020', 'manufacturing', 'VULCAN MATERIALS COMPANY POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00074096', 'manufacturing', 'DOW INC. PAC (DOWPAC)', 'chemicals'),
  ('C00226548', 'utilities', 'VISTRA EMPLOYEE POLITICAL ACTION COMMITTEE OF VISTRA CORP.', 'electric_utility'),
  ('C00029348', 'manufacturing', 'AMERICAN FOREST & PAPER ASSOCIATION POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00410308', NULL, 'SHORE PAC', 'unknown_abstract_pac'),
  ('C00683508', NULL, 'FOREVER YOUTH ORGANIZATION UTILIZING A NEW GENERATION PAC', 'leadership_or_party_pac'),
  ('C00389429', 'manufacturing', 'CALPORTLAND COMPANY POLITICAL ACTION COMMITTEE (CALPORTLANDPAC)', 'industrial_manufacturing'),
  ('C00096842', 'utilities', 'THE AMERICAN ELECTRIC POWER COMMITTEE FOR RESPONSIBLE GOVERNMENT', 'electric_utility'),
  ('C00391797', NULL, 'DIRIGO PAC', 'leadership_or_party_pac'),
  ('C00540054', NULL, 'NEBRASKA SANDHILLS PAC', 'unknown_abstract_pac'),
  ('C00546119', 'health', 'SELECT MEDICAL CORPORATION PAC', 'health_provider'),
  ('C00340364', 'health', 'BLUE SHIELD OF CALIFORNIA PAC (SHIELD PAC)', 'health_insurer'),
  ('C00210666', 'health', 'AMERICAN SPEECH-LANGUAGE-HEARING ASSOCIATION PAC (ASHA PAC)', 'health_trade_assoc'),
  ('C00458158', 'retail', 'LKQ CORPORATION EMPLOYEE GOOD GOVERNMENT FUND', 'retail_general'),
  ('C00081547', 'utilities', 'DTE ENERGY COMPANY POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00489336', NULL, 'WILD AND WONDERFUL PAC', 'unknown_abstract_pac'),
  ('C00507574', NULL, 'MOTOR CITY PAC', 'unknown_abstract_pac'),
  ('C00785816', NULL, 'LIFTOFF PAC', 'unknown_abstract_pac'),
  ('C00566851', NULL, 'JOBS OPPORTUNITY AND NEW IDEAS PAC', 'leadership_or_party_pac'),
  ('C00431601', NULL, 'OCEANS PAC', 'unknown_abstract_pac'),
  ('C00517235', NULL, 'TURQUOISE PAC', 'unknown_abstract_pac'),
  ('C00083857', 'oil_gas', 'OCCIDENTAL PETROLEUM CORPORATION POLITICAL ACTION COMMITTEE', 'oil_gas_upstream'),
  ('C00679191', 'lobby', 'DIGIDEMS PAC', 'ideological_advocacy'),
  ('C00368696', NULL, 'RESPONSIBILITY AND FREEDOM WORK PAC (RFWPAC)', 'leadership_or_party_pac'),
  ('C00406801', 'utilities', 'AVANGRID POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00757419', NULL, 'SD PAC', 'unknown_abstract_pac'),
  ('C00607721', NULL, 'LAND OF OPPORTUNITY PAC', 'unknown_abstract_pac'),
  ('C00034785', 'finance', 'ACPAC ACA INTERNATIONAL POLITICAL ACTION COMMITTEE', 'financial_trade_assoc'),
  ('C00629311', NULL, 'GRANITE VALUES PAC', 'unknown_abstract_pac'),
  ('C00629709', 'lobby', 'NO LABELS PAC', 'ideological_advocacy'),
  ('C00412791', NULL, 'FORWARD TOGETHER PAC', 'unknown_abstract_pac'),
  ('C00365270', NULL, 'M-PAC', 'unknown_abstract_pac'),
  ('C00048579', 'utilities', 'SALT RIVER VALLEY WATER USERS'' ASSOCIATION POLITICAL INVOLVEMENT COMMITTEE ( SRPPIC)', 'electric_utility'),
  ('C00304832', 'retail', 'CONSTELLATION BRANDS INC POLITICAL ACTION COMMITTEE', 'alcohol'),
  ('C00576090', NULL, 'EVERGREEN PAC', 'unknown_abstract_pac'),
  ('C00542027', NULL, 'BIG SKY OPPORTUNITY PAC', 'leadership_or_party_pac'),
  ('C00172833', 'finance', 'AMERICAN ASSOCIATION OF CROP INSURERS PAC', 'insurance'),
  ('C00145037', 'utilities', 'SOUTHERN COMPANY GAS EMPLOYEES PAC', 'gas_utility'),
  ('C00486928', 'lobby', 'ALZHEIMERS IMPACT MOVEMENT POLITICAL ACTION COMMITTEE', 'single_issue_advocacy'),
  ('C00010124', 'retail', 'ASSOCIATED EQUIPMENT DISTRIBUTORS POLITICAL ACTION COMMITTEE', 'retail_general'),
  ('C00409276', NULL, 'MAKING A RESPONSIBLE STAND FOR HOUSEHOLDS IN AMERICA PAC', 'leadership_or_party_pac'),
  ('C00589309', NULL, 'BLUE MOMENTUM PAC', 'leadership_or_party_pac'),
  ('C00762682', NULL, 'STEER PAC', 'unknown_abstract_pac'),
  ('C00431874', NULL, 'FOLLOW THE NORTH STAR FUND', 'leadership_or_party_pac'),
  ('C00140855', 'utilities', 'FIRSTENERGY CORP POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00338020', 'health', 'ARGENTUM''S SILVER PAC', 'health_provider'),
  ('C00489427', NULL, 'BUILDING LEADERSHIP AND INSPIRING NEW ENTERPRISE PAC', 'leadership_or_party_pac'),
  ('C00783167', NULL, 'WORKING FOR OHIO', 'leadership_or_party_pac'),
  ('C00202184', NULL, 'WATERPAC - NATIONAL RURAL WATER ASSOCIATION POLITICAL COMMITTEE', 'other_services'),
  ('C00439992', NULL, 'KEYSTONE AMERICA PAC', 'leadership_or_party_pac'),
  ('C00163048', NULL, 'CAP-PAC SEPARATE SEGREGATED FUND OF THE NATIONAL COMMUNITY ACTION FOUNDATION INC', 'nonprofit_other'),
  ('C00633248', 'lobby', '314 ACTION FUND', 'ideological_advocacy'),
  ('C00016386', 'retail', 'AMERICAN BAKERS ASSOCIATION AMERICAN BAKERS POLITICAL ACTION COMMITTEE', 'food_beverage_manufacturer'),
  ('C00879619', NULL, 'SCHIFF(T) THE SENATE', 'leadership_or_party_pac'),
  ('C00634774', NULL, 'COMMON SENSE FOR AMERICA PAC', 'unknown_abstract_pac'),
  ('C00525212', NULL, 'VICTORY AND FREEDOM PAC (VAF PAC)', 'unknown_abstract_pac'),
  ('C00771238', NULL, 'DEFEND THE DREAM', 'unknown_abstract_pac'),
  ('C00249342', 'health', 'AMERICAN SOCIETY OF PLASTIC SURGEONS PLASTYPAC', 'health_provider'),
  ('C00349373', 'retail', 'GULF STATES TOYOTA INC FEDERAL POLITICAL ACTION COMMITTEE', 'retail_general'),
  ('C00142299', 'real_estate', 'JACOBS SOLUTIONS, INC. POLITICAL ACTION COMMITTEE (JACOBS PAC)', 'engineering_construction'),
  ('C00410092', NULL, 'PEOPLE''S VOICE PAC', 'unknown_abstract_pac'),
  ('C00392738', NULL, 'HOOPS PAC', 'unknown_abstract_pac'),
  ('C00370122', NULL, 'COMMITTEE FOR A DEMOCRATIC FUTURE', 'leadership_or_party_pac'),
  ('C00022368', 'retail', 'NATIONAL ASSOCIATION OF CHAIN DRUG STORES, INC. POLITICAL ACTION COMMITTEE', 'retail_general'),
  ('C00458570', NULL, 'A NEW DIRECTION PAC', 'unknown_abstract_pac'),
  ('C00571323', NULL, 'TOGETHER HOLDING OUR MAJORITY PAC', 'leadership_or_party_pac'),
  ('C00629212', NULL, 'ALL FOR OUR COUNTRY LEADERSHIP PAC', 'leadership_or_party_pac'),
  ('C00109306', 'lobby', 'NATIONAL ASSOCIATION OF WHOLESALER-DISTRIBUTORS POLITICAL ACTION COMMITTEE', 'business_trade_assoc_multisector'),
  ('C00689208', NULL, 'RVFPAC', 'unknown_abstract_pac'),
  ('C00543207', NULL, 'BADLANDS PAC', 'leadership_or_party_pac'),
  ('C00567693', NULL, 'HAWAII PAC', 'leadership_or_party_pac'),
  ('C00753947', NULL, 'LA BAMBA PAC', 'leadership_or_party_pac'),
  ('C00403592', NULL, 'NARRAGANSETT BAY PAC', 'leadership_or_party_pac'),
  ('C00106740', 'health', 'AMERICA''S HEALTH INSURANCE PLANS, INC. PAC (AHIP PAC)', 'health_insurer'),
  ('C00744532', 'lobby', 'SUPPORT TAXFIGHTERS & ELECT EFFECTIVE LEADERS PAC', 'ideological_advocacy'),
  ('C00755173', NULL, 'HONOR COURAGE COMMITMENT PAC', 'unknown_abstract_pac'),
  ('C00493221', NULL, 'THE GUARDIAN FUND', 'unknown_abstract_pac'),
  ('C00507962', 'utilities', 'AES CORPORATION POLITICAL ACTION COMMITTEE; THE', 'electric_utility'),
  ('C00693127', NULL, 'BUILDING BRIDGES PAC', 'unknown_abstract_pac'),
  ('C00710848', 'lobby', 'DMFI PAC', 'single_issue_advocacy'),
  ('C00569871', NULL, 'DOING RIGHT - RESULTS ACTION UNITY LEADERSHIP PAC', 'leadership_or_party_pac'),
  ('C00655423', NULL, 'BRIDGE THE GAP PAC', 'unknown_abstract_pac'),
  ('C00416743', NULL, 'VICTORY NOW PAC', 'unknown_abstract_pac'),
  ('C00450916', 'finance', 'ASURION LLC POLITICAL ACTION COMMITTEE (ASURION PAC)', 'insurance'),
  ('C00259572', 'utilities', 'AMERICAN CLEAN POWER ASSOCIATION CLEANPOWER PAC', 'renewables'),
  ('C00471540', 'lobby', 'ENVIRONMENTAL DEFENSE ACTION FUND PAC (EDAF PAC)', 'single_issue_advocacy'),
  ('C00571976', NULL, 'THE PETER NORBECK LEADERSHIP PAC', 'leadership_or_party_pac'),
  ('C00368142', 'media', 'OFFICE OF THE COMMISSIONER OF MAJOR LEAGUE BASEBALL POLITICAL ACTION COMMITTEE', 'media_entertainment'),
  ('C00696591', NULL, 'ACROSS THE AISLE PAC', 'unknown_abstract_pac'),
  ('C00692319', NULL, 'VPP', 'unknown_abstract_pac'),
  ('C00235655', NULL, 'BLUEGRASS COMMITTEE', 'leadership_or_party_pac'),
  ('C00353797', 'manufacturing', 'SIEMENS CORPORATION PAC', 'industrial_manufacturing'),
  ('C00531590', NULL, 'PATRIOTS IN ACTION', 'unknown_abstract_pac'),
  ('C00065219', 'retail', 'WINE INSTITUTE PAC', 'alcohol'),
  ('C00379479', NULL, 'THE HAWKEYE PAC', 'leadership_or_party_pac'),
  ('C00389403', 'manufacturing', 'SPECIALTY EQUIPMENT MARKET ASSOCIATION & PERFORMANCE RACING, INC. PAC (SEMA & PRI PAC)', 'auto_manufacturing'),
  ('C00566562', NULL, 'BACKPAC', 'unknown_abstract_pac'),
  ('C00563601', NULL, 'SUPPORTING HOUSE PROBLEM SOLVERS - SHP PAC', 'leadership_or_party_pac'),
  ('C00331694', NULL, 'AMERICA WORKS FEDERAL PAC', 'unknown_abstract_pac'),
  ('C00493072', NULL, 'DAKOTA PAC', 'leadership_or_party_pac'),
  ('C00248849', 'manufacturing', 'CROPLIFE AMERICA POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00167759', 'media', 'PARAMOUNT GLOBAL POLITICAL ACTION COMMITTEE', 'media_entertainment'),
  ('C00249532', 'retail', 'AMERICAN SPORTFISHING ASSOCIATION POLITICAL ACTION COMMITTEE', 'retail_general'),
  ('C00567545', NULL, 'BOOTS POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00305318', NULL, 'BLUE DOG POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00101485', 'manufacturing', 'ECOLAB INC. POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00051979', 'utilities', 'NISOURCE INC. PAC', 'gas_utility'),
  ('C00455717', NULL, 'FREE STATE PAC', 'leadership_or_party_pac'),
  ('C00347195', NULL, 'PRAIRIE POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00219444', 'finance', 'NATIONAL STRUCTURED SETTLEMENTS TRADE ASSOCIATION PAC', 'insurance'),
  ('C00647420', NULL, 'BOLD ACTIVE CONSERVATIVES OF NEBRASKA PAC', 'leadership_or_party_pac'),
  ('C00313700', 'finance', 'TRANSUNION POLITICAL ACTION COMMITTEE (TU PAC)', 'fintech_payments'),
  ('C00539601', NULL, 'PINEAPPLE PAC', 'unknown_abstract_pac'),
  ('C00513176', NULL, 'CONGRESSIONAL PROGRESSIVE CAUCUS PAC', 'leadership_or_party_pac'),
  ('C00823351', NULL, 'REPUBLICANS UNITED TO DEFEND YOU PAC', 'leadership_or_party_pac'),
  ('C00113159', 'manufacturing', 'EASTMANPAC-POLITICAL ACTION COMMITTEE OF EASTMAN CHEMICAL COMPANY', 'chemicals'),
  ('C00479998', 'utilities', 'TENASKA INC EMPLOYEES POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00770255', NULL, 'SIX PAC', 'unknown_abstract_pac'),
  ('C00197749', 'media', 'TWDC ENTERPRISES 18 CORP. EMPLOYEES PAC AKA ''THE WALT DISNEY COMPANY EMPLOYEES PAC'' OR ''DISNEY PAC''', 'media_entertainment'),
  ('C00574103', 'health', 'U.S. ANESTHESIA PARTNERS, INC. PAC D/B/A/ USAP PAC', 'health_provider'),
  ('C00411173', 'finance', 'COMMERCIAL REAL ESTATE FINANCE COUNCIL PAC', 'mortgage_finance'),
  ('C00113753', 'manufacturing', 'JOHNSON CONTROLS INC. PAC', 'industrial_manufacturing'),
  ('C00011262', 'labor', 'BROTHERHOOD OF RAILROAD SIGNALMEN POLITICAL ACTION COMMITTEE', 'labor_union'),
  ('C00687582', NULL, 'GIDDY UP PAC', 'unknown_abstract_pac'),
  ('C00306175', 'manufacturing', 'LYONDELL CHEMICAL COMPANY PAC', 'chemicals'),
  ('C00492983', NULL, 'NUTMEG PAC', 'leadership_or_party_pac'),
  ('C00447284', NULL, 'NATIONAL ASSOCIATION OF PROFESSIONAL EMPLOYER ORGANIZATIONS (NAPEO PAC)', 'other_services'),
  ('C00251009', 'labor', 'UNITED PILOTS PAC/UNITED AIRLINES MASTER EXECUTIVE COUNCIL', 'labor_union'),
  ('C00040659', 'finance', 'NAFCU PAC OF CREDIT UNION NATIONAL ASSOCIATION, INC.', 'credit_union'),
  ('C00762591', NULL, 'SAVE AMERICA', 'leadership_or_party_pac'),
  ('C00494112', NULL, 'BEEPAC (BUILDING ECONOMIC EMPOWERMENT PAC)', 'unknown_abstract_pac'),
  ('C00712695', NULL, 'VITORIA PAC', 'unknown_abstract_pac'),
  ('C00388934', NULL, 'FUND FOR AMERICA''S FUTURE', 'unknown_abstract_pac'),
  ('C00014555', 'retail', 'FOOD MARKETPLACE INC. POLITICAL ACTION COMMITTEE FMI FOODPAC', 'grocery'),
  ('C00404194', 'finance', 'GENWORTH FINANCIAL, INC. POLITICAL ACTION COMMITTEE (GENWORTH PAC)', 'insurance'),
  ('C00375584', NULL, 'GREAT LAKES PAC', 'unknown_abstract_pac'),
  ('C00426809', NULL, 'MADISON PAC; THE', 'unknown_abstract_pac'),
  ('C00319723', 'defense', 'NATIONAL BUSINESS AVIATION ASSOCIATION INC POLITICAL ACTION COMMITTEE (NBAA-PAC)', 'aerospace_civil'),
  ('C00075473', 'utilities', 'CMS ENERGY CORPORATION EMPLOYEES FOR BETTER GOVERNMENT- FEDERAL', 'electric_utility'),
  ('C00489419', 'health', 'AKSM UROLOGY POLITICAL ACTION COMMITTEE ''AKSM UROLOGY PAC''', 'health_provider'),
  ('C00439521', NULL, 'AMERICAN SECURITY PAC', 'unknown_abstract_pac'),
  ('C00538835', NULL, 'COMMON GROUND PAC', 'unknown_abstract_pac'),
  ('C00536540', NULL, 'JOBS, FREEDOM, AND SECURITY PAC', 'unknown_abstract_pac'),
  ('C00832501', NULL, 'AMERICAN EXCELLENCE PAC', 'unknown_abstract_pac'),
  ('C00522094', 'health', 'PSYCHOLOGY PAC OF AMERICAN PSYCHOLOGICAL ASSOCIATION SERVICES INC.', 'health_trade_assoc'),
  ('C00425470', NULL, 'DEMOCRATS WIN SEATS (DWS PAC)', 'leadership_or_party_pac'),
  ('C00324483', 'utilities', 'BERKSHIRE HATHAWAY ENERGY COMPANY PAC', 'electric_utility'),
  ('C00633156', NULL, 'I GOT YOUR BACK PAC', 'unknown_abstract_pac'),
  ('C00544957', 'health', 'USACS PAC', 'health_provider'),
  ('C00468314', 'finance', 'DEMOCRACY ENGINE, INC., PAC', 'fintech_payments'),
  ('C00813063', NULL, 'LEADERSHIP AND LOYALTY ONLY TO AMERICA PAC', 'unknown_abstract_pac'),
  ('C00692111', NULL, 'VELVET HAMMER PAC', 'unknown_abstract_pac'),
  ('C00382150', NULL, 'THE GEO GROUP, INC. POLITICAL ACTION COMMITTEE', 'other_services'),
  ('C00821058', NULL, 'ALABAMA FIRST PAC', 'unknown_abstract_pac'),
  ('C00239780', 'health', 'PHILIPS NORTH AMERICA LLC POLITICAL ACTION COMMITTEE', 'medical_device'),
  ('C00506907', NULL, 'ASPIRE PAC', 'unknown_abstract_pac'),
  ('C00647354', NULL, 'TEAM AMERICA - BRINGING AMERICA TOGETHER PAC', 'unknown_abstract_pac'),
  ('C00411694', 'transportation', 'SALTCHUK RESOURCES, INC. PAC', 'maritime_shipping'),
  ('C00438291', NULL, 'DENALI LEADERSHIP PAC', 'leadership_or_party_pac'),
  ('C00636753', 'legal', 'ACADEMY OF RAIL LABOR ATTORNEYS POLITICAL ACTION COMMITTEE', 'trial_lawyers'),
  ('C00280909', 'labor', 'TRANSPORTATION TRADES DEPARTMENT AFL-CIO POLITICAL ACTION COMMITTEE (TTD/PAC)', 'labor_union'),
  ('C00719971', NULL, 'SENATE EAGLE PAC', 'unknown_abstract_pac'),
  ('C00060087', 'manufacturing', 'STANLEY BLACK & DECKER, INC. POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00762328', NULL, 'FIGHT ON PAC', 'unknown_abstract_pac'),
  ('C00388462', 'utilities', 'ITC HOLDINGS CORP. PAC (ITC PAC)', 'electric_utility'),
  ('C00767871', NULL, 'REV UP PAC', 'unknown_abstract_pac'),
  ('C00345793', 'media', 'RELX INC. POLITICAL ACTION COMMITTEE', 'media_entertainment'),
  ('C00118208', 'real_estate', 'AMERICAN ROAD & TRANSPORTATION BUILDERS ASSOCIATION PAC', 'construction_contractor'),
  ('C00524314', NULL, 'AMERICA''S FIRST PAC', 'unknown_abstract_pac'),
  ('C00188011', 'transportation', 'NATIONAL TANK TRUCK CARRIERS INC POLITICAL ACTION COMMITTEE', 'trucking'),
  ('C00494302', NULL, 'LEAD ENCOURAGE ELECT PAC', 'unknown_abstract_pac'),
  ('C00405555', 'manufacturing', 'NATIONAL COUNCIL OF TEXTILE ORGANIZATIONS INC POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00100131', 'manufacturing', 'THE GOODYEAR TIRE & RUBBER COMPANY GOOD GOVERNMENT FUND (GOODYEAR GOOD GOVERNMENT FUND)', 'auto_manufacturing'),
  ('C00479899', 'real_estate', 'WOOLPERT, INC. PAC', 'engineering_construction'),
  ('C00574921', 'legal', 'RYAN LLC POLITICAL ACTION COMMITTEE (RYANPAC)', 'accounting_consulting'),
  ('C00526715', NULL, 'GREATER TOMORROW POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00299321', 'retail', 'MGM RESORTS INTERNATIONAL  PAC', 'gaming_casino'),
  ('C00734012', 'health', 'ASCO ASSOCIATION POLITICAL ACTION COMMITTEE (ASCO ASSOCIATION PAC)', 'health_trade_assoc'),
  ('C00678813', 'lobby', 'CONSERVATIVES HARVESTING SUCCESS PAC', 'ideological_advocacy'),
  ('C00160630', 'mining', 'DRUMMOND COMPANY, INC. POLITICAL ACTION COMMITTEE (DPAC)', 'coal_mining'),
  ('C00360008', 'retail', 'NATIONAL THOROUGHBRED RACING ASSOCIATION POLITICAL ACTION COMMITTEE/HORSE PAC', 'gaming_casino'),
  ('C00445379', NULL, 'MAKING AMERICA PROSPEROUS PAC', 'unknown_abstract_pac'),
  ('C00383489', 'utilities', 'PUBLIC SERVICE ENTERPRISE GROUP INC. POLITICAL ACTION COMMITTEE (PEGPAC)', 'electric_utility'),
  ('C00425439', NULL, 'THOROUGHBRED PAC', 'unknown_abstract_pac'),
  ('C00481531', NULL, 'TEXAS REPUBLICANS UNITED POLITICAL ACTION COMMITTEE (TRU PAC)', 'leadership_or_party_pac'),
  ('C00491936', NULL, 'COMMON SENSE COLORADO', 'unknown_abstract_pac'),
  ('C00083758', 'utilities', 'NATIONAL FUEL GAS COMPANY FEDERAL POLITICAL ACTION COMMITTEE', 'gas_utility'),
  ('C00792127', 'tech', 'FAIR ISAAC CORPORATION POLITICAL ACTION COMMITTEE (FICO PAC)', 'software_internet'),
  ('C00590471', 'labor', 'LOCAL 881 UNITED FOOD AND COMMERCIAL WORKERS POLITICAL ACTION FUND', 'labor_union'),
  ('C00686816', NULL, 'AMERICA RELOADED', 'unknown_abstract_pac'),
  ('C00336057', 'tech', 'UNITED STATES CELLULAR CORPORATION POLITICAL ACTION COMMITTEE', 'telecom_cable'),
  ('C00551168', NULL, 'PUGET PAC', 'unknown_abstract_pac'),
  ('C00366468', NULL, 'CORECIVIC, INC. POLITICAL ACTION COMMITTEE (CORECIVIC PAC)', 'other_services'),
  ('C00834507', NULL, 'BUILDING UP DEMOCRACY''S DREAM', 'unknown_abstract_pac'),
  ('C00583153', NULL, 'VALOR PAC', 'unknown_abstract_pac'),
  ('C00691972', 'manufacturing', 'ALLISON TRANSMISSION INC. POLITICAL ACTION COMMITTEE', 'auto_manufacturing'),
  ('C00214148', 'agriculture', 'AMERICAN PEANUT SHELLERS ASSOCIATION POLITICAL ACTION COMMITTEE', 'agriculture_trade_assoc'),
  ('C00492025', 'lobby', 'AMERICAN DEFENSE AND MILITARY PAC', 'ideological_advocacy'),
  ('C00632323', 'lobby', 'DEFEND OUR CONSERVATIVE SENATE PAC (DOC''S PAC)', 'ideological_advocacy'),
  ('C00433680', NULL, 'TREASURE STATE PAC', 'unknown_abstract_pac'),
  ('C00495556', NULL, 'TRINET GROUP INC POLITICAL ACTION COMMITTEE', 'other_services'),
  ('C00664318', NULL, 'DEMOCRACY SUMMER LEADERSHIP PAC', 'leadership_or_party_pac'),
  ('C00021295', 'health', 'BRACEPAC', 'medical_device'),
  ('C00325993', NULL, 'DEFEND AMERICA PAC', 'unknown_abstract_pac'),
  ('C00699140', 'finance', 'LSTA, INC. PAC', 'financial_trade_assoc'),
  ('C00378695', NULL, 'VICTORY IN NOVEMBER ELECTION PAC', 'unknown_abstract_pac'),
  ('C00770297', NULL, 'BAKER PAC', 'leadership_or_party_pac'),
  ('C00571174', NULL, 'SERVE AMERICA PAC', 'leadership_or_party_pac'),
  ('C00226472', NULL, 'ARPAC', 'unknown_abstract_pac'),
  ('C00383521', 'retail', 'INTERNATIONAL FOODSERVICE DISTRIBUTORS ASSOCIATION POLITICAL ACTION COMMITTEE', 'restaurant_foodservice'),
  ('C00691501', NULL, 'REJOICE PAC', 'unknown_abstract_pac'),
  ('C00077305', 'utilities', 'ALABAMA POWER CO EMPLOYEES FEDERAL POLITICAL ACTION CMTE (APC EMPLOYEES FEDERAL PAC)', 'electric_utility'),
  ('C00135541', NULL, 'TO PROTECT OUR HERITAGE PAC', 'unknown_abstract_pac'),
  ('C00769109', 'labor', 'HEALTH JOBS JUSTICE', 'labor_union'),
  ('C00500025', NULL, 'RECLAIM AMERICA PAC', 'leadership_or_party_pac'),
  ('C00832147', NULL, 'MITTEN PAC', 'unknown_abstract_pac'),
  ('C00497842', NULL, 'STRATEGY PAC', 'unknown_abstract_pac'),
  ('C00300376', 'finance', 'THE DOCTORS COMPANY FEDERAL PAC (DOCPAC)', 'insurance'),
  ('C00649525', NULL, 'RESTORING OUR NATION PAC', 'unknown_abstract_pac'),
  ('C00565630', NULL, 'MAINTAINING ALL REPUBLICANS IN OFFICE PAC', 'leadership_or_party_pac'),
  ('C00597062', NULL, 'BUDDY PAC', 'leadership_or_party_pac'),
  ('C00041566', NULL, 'AMERICAN SOCIETY OF ASSOCIATION EXECUTIVES (ASAE) PAC', 'professional_assoc_other'),
  ('C00458257', 'lobby', 'EMPLOYEE OWNED S CORPORATIONS OF AMERICA PAC (ESCA PAC)', 'business_trade_assoc_multisector'),
  ('C00110585', NULL, 'CITIZENS ORGANIZED POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00377143', NULL, 'BUILD AMERICA PAC', 'unknown_abstract_pac'),
  ('C00649772', NULL, 'REVIVING AMERICAN JOBS AGAIN PAC', 'leadership_or_party_pac'),
  ('C00421982', 'utilities', 'SOLAR ENERGY INDUSTRIES ASSOCIATION PAC (SOLARPAC)', 'renewables'),
  ('C00493270', 'manufacturing', 'HEIDELBERG MATERIALS US, INC. POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00653188', 'media', 'BMI POLITICAL ACTION COMMITTEE (BMI PAC)', 'media_entertainment'),
  ('C00840462', NULL, 'BUDWINSKI PAC', 'unknown_abstract_pac'),
  ('C00370585', 'defense', 'MAXAR TECHNOLOGIES INC. PAC (MAXARPAC)', 'defense_contractor'),
  ('C00344648', NULL, 'RELY ON YOUR BELIEFS FUND', 'leadership_or_party_pac'),
  ('C00701680', NULL, 'HOPE PAC', 'unknown_abstract_pac'),
  ('C00392464', 'media', 'UNIVERSAL MUSIC GROUP EMPLOYEE ACTION FUND', 'media_entertainment'),
  ('C00559302', NULL, 'FS PAC', 'unknown_abstract_pac'),
  ('C00525543', NULL, 'PROJECT WEST POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00195024', NULL, 'MARYLAND ASSOCIATION FOR CONCERNED CITIZENS POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00084871', 'manufacturing', 'CELANESE CORPORATION POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00760397', NULL, 'NO NONSENSE PAC', 'leadership_or_party_pac'),
  ('C00264770', 'agriculture', 'AGRICULTURAL RETAILERS ASSOCIATION POLITICAL ACTION COMMITTE', 'agriculture_trade_assoc'),
  ('C00832576', NULL, 'GREAT CHAIN PAC', 'leadership_or_party_pac'),
  ('C00680132', NULL, 'TRIED-AND-TRUE PAC', 'leadership_or_party_pac'),
  ('C00863373', NULL, 'BEST AT BRINGING ENTREPRENEURIAL RESULTS NEVER IMAGINED OR ENVISIONED PAC', 'leadership_or_party_pac'),
  ('C00640490', NULL, 'ONWARD TOGETHER COMMITTEE', 'leadership_or_party_pac'),
  ('C00128678', 'manufacturing', 'SOUTHEASTERN LUMBER MANUFACTURERS ASSOC POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00481176', NULL, 'CONCERNED AMERICANS FOR FREEDOM & OPPORTUNITY PAC (CAFO PAC)', 'leadership_or_party_pac'),
  ('C00564187', NULL, 'EDUCATE AND INNOVATE PAC', 'unknown_abstract_pac'),
  ('C00525071', 'manufacturing', 'COMMERCIAL METALS COMPANY PAC (CMC PAC)', 'steel_metals'),
  ('C00290973', 'manufacturing', 'CLEVELAND-CLIFFS INC. POLITICAL ACTION COMMITTEE', 'steel_metals'),
  ('C00387464', NULL, 'ALAMO PAC', 'leadership_or_party_pac'),
  ('C00446237', 'labor', 'NATIONAL NURSES UNITED PAC - A FUND FOR A HEALTHY AMERICA', 'labor_union'),
  ('C00143560', 'health', 'ACADEMY OF NUTRITION AND DIETETICS POLITICAL ACTION COMMITTEE', 'health_trade_assoc'),
  ('C00168070', 'health', 'AMERICAN AMBULANCE ASSOCIATION FEDERAL PAC (AKA AMBU-PAC)', 'health_trade_assoc'),
  ('C00362640', 'utilities', 'CALPINE CORPORATION PAC', 'electric_utility'),
  ('C00692715', NULL, 'HELP ELECT REPUBLICANS NOW', 'leadership_or_party_pac'),
  ('C00770511', 'lobby', 'TZEDEK PAC', 'ideological_advocacy'),
  ('C00656777', NULL, 'JAM PAC', 'unknown_abstract_pac'),
  ('C00252684', 'health', 'CAMBIA HEALTH SOLUTIONS INC. PAC', 'health_insurer'),
  ('C00119008', NULL, 'WASTE MANAGEMENT EMPLOYEES BETTER GOVERNMENT FUND', 'other_services'),
  ('C00379180', 'manufacturing', 'NATIONAL ASSOCIATION OF CHEMICAL DISTRIBUTORS RESPONSIBLE DISTRIBUTION POLITICAL ACTION COMMITTEE', 'chemicals'),
  ('C00394650', 'agriculture', 'JBS USA FOOD COMPANY PAC', 'agribusiness_processor'),
  ('C00770214', NULL, 'CHAMPION AMERICAN VALUES', 'unknown_abstract_pac'),
  ('C00769810', 'health', 'OWENS & MINOR, INC. POLITICAL ACTION COMMITTEE (OWENS & MINOR PAC)', 'medical_device'),
  ('C00765644', NULL, 'BIG IDEAS CREATE EXCELLENCE PAC', 'leadership_or_party_pac'),
  ('C00103697', 'real_estate', 'BECHTEL GROUP, INC. POLITICAL ACTION COMMITTEE (BECHTEL POLITICAL ACTION COMMITTEE)', 'engineering_construction'),
  ('C00756825', NULL, 'DELIVERS PAC', 'leadership_or_party_pac'),
  ('C00386029', 'real_estate', 'HNTB HOLDINGS LTD. PAC', 'engineering_construction'),
  ('C00523936', NULL, 'IRON MOUNTAIN INCORPORATED EMPLOYEES PAC (IMPAC)', 'other_services'),
  ('C00529909', 'health', 'AIR METHODS CORPORATION POLITICAL ACTION COMMITTEE (AMPAC)', 'health_provider'),
  ('C00161570', 'utilities', 'AMERICAN PUBLIC POWER ASSOCIATION, PUBLIC OWNERSHIP OF ELECTRIC RESOURCES PAC', 'electric_utility'),
  ('C00837435', NULL, '2024 THUNE REPUBLICAN SENATE VICTORY', 'leadership_or_party_pac'),
  ('C00132092', 'utilities', 'ALLIANT ENERGY CORPORATION EMPLOYEE''S POLITICAL ACTION COMM', 'electric_utility'),
  ('C00738260', NULL, 'POINT ACTION PAC, INC.', 'leadership_or_party_pac'),
  ('C00346288', 'health', 'THE PREMIER, INC. EMPLOYEES'' CIVIC ACTION FUND', 'health_provider'),
  ('C00457242', 'health', 'BLUE CROSS BLUE SHIELD OF ALABAMA PAC', 'health_insurer'),
  ('C00442996', 'manufacturing', 'ASSOCIATION OF EQUIPMENT MANUFACTURERS PAC', 'industrial_manufacturing'),
  ('C00437244', 'utilities', 'INVENERGY LLC PAC', 'renewables'),
  ('C00363648', NULL, 'FIRST STATE PAC', 'unknown_abstract_pac'),
  ('C00635367', NULL, 'TENACIOUS PAC', 'leadership_or_party_pac'),
  ('C00746735', 'manufacturing', 'HMS SCRAP PAC', 'steel_metals'),
  ('C00499400', 'transportation', 'TRALAPAC (TRUCK RENTING AND LEASING ASSOCIATION PAC)', 'trucking'),
  ('C00692202', NULL, 'COURAGE TO CHANGE', 'leadership_or_party_pac'),
  ('C00785899', 'lobby', 'EQUALITY PROJECT PAC', 'single_issue_advocacy'),
  ('C00760827', 'lobby', 'DEMAND JUSTICE PAC', 'single_issue_advocacy'),
  ('C00423228', 'health', 'AMERICAN GASTROENTEROLOGICAL ASSOCIATION INC. PAC', 'health_trade_assoc'),
  ('C00493361', NULL, 'RAZOR PAC', 'leadership_or_party_pac'),
  ('C00753475', NULL, 'BAPS PUBLIC AFFAIRS, INC. POLITICAL ACTION COMMITTEE (BAPS PAC)', 'nonprofit_other'),
  ('C00431403', NULL, 'VOTE TO ELECT REPUBLICANS NOW PAC', 'leadership_or_party_pac'),
  ('C00279497', 'manufacturing', 'POLARIS INDUSTRIES POLITICAL PARTICIPATION PROGRAM', 'auto_manufacturing'),
  ('C00237065', 'manufacturing', 'PORTLAND CEMENT ASSOCIATION INC. (CEMENT PAC)', 'industrial_manufacturing'),
  ('C00311944', 'labor', 'DGA-PAC THE POLITICAL ACTION COMMITTEE OF THE DIRECTORS GUILD OF AMERICA INC.', 'labor_union'),
  ('C00450320', NULL, 'INVEST IN A STRONG AND SECURE AMERICA', 'leadership_or_party_pac'),
  ('C00574368', 'legal', 'CROWELL & MORING LLP POLITICAL ACTION COMMITTEE (C&M PAC)', 'law_firm'),
  ('C00250407', 'utilities', 'SOUTHERN NUCLEAR OPERATING COMPANY, INC. PAC', 'nuclear'),
  ('C00467837', NULL, 'EDPAC', 'unknown_abstract_pac'),
  ('C00012310', 'real_estate', 'BLACK & VEATCH POLITICAL ACTION COMMITTEE (BLACK & VEATCH PAC)', 'engineering_construction'),
  ('C00363838', 'manufacturing', 'HUNTSMAN CORPORATION PAC (HUNTSMAN PAC)', 'chemicals'),
  ('C00760124', NULL, 'NATIONAL VICTORY ACTION FUND', 'unknown_abstract_pac'),
  ('C00196089', 'lobby', 'THE ESOP ASSOCIATION PAC', 'business_trade_assoc_multisector'),
  ('C00493924', NULL, 'REINVENTING A NEW DIRECTION POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00621912', 'retail', '1-800 CONTACTS, INC. PAC', 'retail_general'),
  ('C00807909', NULL, 'STOP COLLECTIVISM OR TOTALITARIANISM TRIUMPHS PAC', 'leadership_or_party_pac'),
  ('C00416131', NULL, 'MIDWEST VALUES PAC', 'leadership_or_party_pac'),
  ('C00762930', NULL, 'BE VICTORIOUS OVER DEMOCRATS PAC', 'leadership_or_party_pac'),
  ('C00652701', NULL, 'VNA HOLDING INC. POLITICAL ACTION COMMITTEE (VG PAC)', 'other_services'),
  ('C00784694', NULL, 'TKJ PAC', 'unknown_abstract_pac'),
  ('C00586859', 'finance', 'MORTGAGE GUARANTY INSURANCE CORPORATION POLITICAL ACTION COMMITTEE (''MGIC-PAC'')', 'mortgage_finance'),
  ('C00142158', NULL, 'REWORLD WASTE, LLC POLITICAL ACTION COMMITTEE (REWORLD WASTE PAC)', 'other_services'),
  ('C00764886', NULL, 'LASTING INVESTMENTS STRENGTHENING AMERICA PAC', 'leadership_or_party_pac'),
  ('C00697375', 'manufacturing', 'MILLIKEN & COMPANY PAC', 'industrial_manufacturing'),
  ('C00381954', 'utilities', 'ATMOS ENERGY CORPORATION PAC', 'gas_utility'),
  ('C00691162', NULL, 'HOOSIER PAC', 'unknown_abstract_pac'),
  ('C00566059', NULL, 'REMEDY PAC', 'unknown_abstract_pac'),
  ('C00041608', 'agriculture', 'POTLATCHDELTIC CORPORATION POLITICAL ACTION COMMITTEE (POTLATCHDELTIC PAC)', 'agriculture_producer'),
  ('C00303883', 'manufacturing', 'CASE NEW HOLLAND INDUSTRIAL INC. EXCELLENCE IN GOVERNMENT FUND (CNH INDUSTRIAL EXCELLENCE IN GOVERNMENT FUND)', 'industrial_manufacturing'),
  ('C00228296', 'media', 'THE ASCAP LEGISLATIVE FUND FOR THE ARTS', 'media_entertainment'),
  ('C00139519', 'media', 'MOTION PICTURE ASSOCIATION INC POLITICAL ACTION COMMITTEE (MPAAMERICA PAC)', 'media_entertainment'),
  ('C00845099', NULL, 'SEND IN THE SEAL PAC', 'unknown_abstract_pac'),
  ('C00772434', NULL, 'PAC FOR AMERICA', 'unknown_abstract_pac'),
  ('C00547356', NULL, 'INLAND EMPIRE STRIKES PAC; THE', 'unknown_abstract_pac'),
  ('C00552539', NULL, 'MAKE IT WORK PAC', 'unknown_abstract_pac'),
  ('C00765982', NULL, 'STAND FOR AMERICA PAC', 'leadership_or_party_pac'),
  ('C00886036', NULL, 'ALPHA KAPPA ALPHA SORORITY PAC, INC. (AKA AKA 1908 PAC)', 'nonprofit_other'),
  ('C00321158', 'media', 'SALEM MEDIA GROUP POLITICAL ACTION COMMITTEE, INC.', 'media_entertainment'),
  ('C00774588', NULL, 'MISSION FIRST PEOPLE ALWAYS PAC', 'unknown_abstract_pac'),
  ('C00531632', NULL, 'DEFENSE, ECONOMIC RENEWAL, EDUCATION AND KNOWLEDGE PAC', 'leadership_or_party_pac'),
  ('C00349233', NULL, 'NEW MILLENNIUM PAC', 'unknown_abstract_pac'),
  ('C00085910', 'manufacturing', 'FERT PAC (THE POLITICAL ACTION COMMITTEE OF THE FERTILIZER INSTITUTE)', 'chemicals'),
  ('C00311142', 'legal', 'TROUTMAN PEPPER HAMILTON SANDERS LLP POLITICAL ACTION COMMITTEE, INC.', 'law_firm'),
  ('C00563072', 'mining', 'COEUR MINING, INC. PAC', 'hardrock_mining'),
  ('C00119354', 'health', 'TENET HEALTHCARE CORPORATION POLITICAL ACTION COMMITTEE', 'health_provider'),
  ('C00747766', 'lobby', 'TRUTH TO POWER', 'ideological_advocacy'),
  ('C00540906', NULL, 'CHERPAC', 'unknown_abstract_pac'),
  ('C00564690', NULL, 'CAPA21- FEDERAL', 'unknown_abstract_pac'),
  ('C00659060', 'real_estate', 'PCG (PERFORMANCE CONTACTING GROUP) EMPLOYEE OWNERS PAC', 'construction_contractor'),
  ('C00509356', 'real_estate', 'CERRIS INC. POLITICAL ACTION COMMITTEE (FORMERLY KNOW AS MMC CORP PAC)', 'construction_contractor'),
  ('C00420000', NULL, 'NATIONAL ASSOCIATION OF LANDSCAPE PROFESSIONALS INC. PAC', 'other_services'),
  ('C00564260', NULL, 'CLEAN PAC', 'unknown_abstract_pac'),
  ('C00489302', 'utilities', 'SUNRUN INC POLITICAL ACTION COMMITTEE (SUNRUN PAC)', 'renewables'),
  ('C00251447', NULL, 'I.P.H.F.H.A. POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00442905', 'real_estate', 'GARNEY HOLDING CO. PAC', 'construction_contractor'),
  ('C00405050', NULL, 'BRINGING EVERYONE TOGETHER THROUGH ADVOCACY', 'unknown_abstract_pac'),
  ('C00366559', 'utilities', 'NRG ENERGY INC POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00789164', 'retail', 'FOOD SOLUTIONS ACTION PAC (FSA PAC)', 'restaurant_foodservice'),
  ('C00084475', 'manufacturing', '3M COMPANY PAC', 'industrial_manufacturing'),
  ('C00485540', NULL, 'LEADERSHIP FOR AMERICA TODAY TOMORROW AND ALWAYS PAC', 'leadership_or_party_pac'),
  ('C00238204', 'lobby', 'PAKISTANI AMERICAN PUBLIC AFFAIRS COMMITTEE PAK-PAC', 'single_issue_advocacy'),
  ('C00459008', 'health', 'BROOKDALE SENIOR LIVING PAC', 'health_provider'),
  ('C00109819', 'mining', 'COALPAC, A POLITICAL ACTION COMMITTEE OF THE NATIONAL MINING ASSOCIATION', 'coal_mining'),
  ('C00413567', NULL, 'NATIONAL ASSOCIATION OF FARM SERVICE AGENCY COUNTY OFFICE EMPLOYEES INC PPC AKA NASCOE PAC', 'professional_assoc_other'),
  ('C00818740', NULL, 'CALL TO SERVICE PAC', 'unknown_abstract_pac'),
  ('C00087874', 'retail', 'CONAGRA BRANDS, INC. GOOD GOVERNMENT ASSOCIATION', 'food_beverage_manufacturer'),
  ('C00629576', NULL, 'BUILD OUR MOVEMENT PAC', 'unknown_abstract_pac'),
  ('C00724229', NULL, 'VICTORY EAST', 'unknown_abstract_pac'),
  ('C00401786', 'lobby', 'FREEDOM''S DEFENSE FUND', 'ideological_advocacy'),
  ('C00625772', NULL, 'DEMOCRATIC WOMEN OF THE SOUTH ORANGE COUNTY', 'leadership_or_party_pac'),
  ('C00570606', 'manufacturing', 'ALUMINUM ASSOCIATION POLITICAL ACTION COMMITTEE ''ALUMINUM PAC''', 'steel_metals'),
  ('C00320101', 'mining', 'FREEPORT-MCMORAN INC. CITIZENSHIP COMMITTEE', 'hardrock_mining'),
  ('C00635219', NULL, 'DELIVERING AMERICAN VALUES IN DC PAC', 'leadership_or_party_pac'),
  ('C00786368', NULL, '31 DAYS PAC', 'unknown_abstract_pac'),
  ('C00197160', NULL, 'TEXANS FOR LAMAR SMITH', 'leadership_or_party_pac'),
  ('C00287714', 'retail', 'CARNIVAL/PRINCESS HOLLAND AMERICA LINE INC. PAC (HALPAC)', 'hospitality_travel'),
  ('C00896688', NULL, 'JOBS OPPORTUNITY NOW POLITICAL ACTION COMMITTEE', 'leadership_or_party_pac'),
  ('C00892901', NULL, 'INNOVATION FOR GOOD PAC', 'unknown_abstract_pac'),
  ('C00343707', NULL, 'MAXIMUS INC POLITICAL ACTION COMMITTEE (MAXPAC)', 'other_services'),
  ('C00111880', 'manufacturing', 'CEMEX INC. EMPLOYEES PAC', 'industrial_manufacturing'),
  ('C00806893', 'lobby', 'JANE FONDA CLIMATE PAC', 'single_issue_advocacy'),
  ('C00576215', NULL, 'CHARTER SCHOOLS ACTION PAC', 'education'),
  ('C00685115', NULL, 'GROWING OUR OWN DYNAMIC ECONOMY NOW', 'leadership_or_party_pac'),
  ('C00716423', NULL, 'THE NEXT 50 PAC', 'unknown_abstract_pac'),
  ('C00630632', NULL, 'ELISE VICTORY FUND', 'leadership_or_party_pac'),
  ('C00641142', NULL, 'AMERICANS FOR LEGISLATING EXCELLENCE PAC', 'unknown_abstract_pac'),
  ('C00145623', NULL, 'AMERICAN STAFFING ASSOCIATION STAFFING PAC', 'other_services'),
  ('C00724443', NULL, 'SUNFLOWER SEEDS PAC', 'unknown_abstract_pac'),
  ('C00742346', 'lobby', 'GET AMERICA RIGHT: COMMUNITY IN ACTION', 'ideological_advocacy'),
  ('C00778308', NULL, 'SOUTHERN STATES PAC', 'unknown_abstract_pac'),
  ('C00114702', 'retail', 'OCEAN SPRAY CRANBERRIES INC. POLITICAL ACTION COMMITTEE', 'food_beverage_manufacturer'),
  ('C00767640', NULL, 'RANGER PAC', 'unknown_abstract_pac'),
  ('C00859538', NULL, 'ALSOPAC', 'unknown_abstract_pac'),
  ('C00694471', NULL, 'AMERICAN MOSAIC PAC', 'unknown_abstract_pac'),
  ('C00002790', 'manufacturing', 'OLIN CORPORATION GOOD GOVERNMENT FUND (OLIN WINCHESTER GOOD GOVERNMENT FUND)', 'chemicals'),
  ('C00446948', 'defense', 'ENGINEERING AND SOFTWARE SYSTEMS SOLUTIONS, INC. PAC', 'defense_contractor'),
  ('C00740704', 'manufacturing', 'CARRIER GLOBAL CORPORATION POLITICAL ACTION COMMITTEE', 'industrial_manufacturing'),
  ('C00459800', 'labor', 'PROFESSIONAL ENGINEERS IN CALIFORNIA GOVERNMENT FEDERAL PAC (PECG FED-PAC)', 'labor_union'),
  ('C00740605', 'legal', 'THE GUIDEHOUSE INC. POLITICAL ACTION COMMITTEE (GUIDEHOUSE PAC)', 'accounting_consulting'),
  ('C00435735', 'media', 'TELEVISAUNIVISION, INC. EMPLOYEE POLITICAL ACTION COMMITTEE', 'media_entertainment'),
  ('C00439646', NULL, 'DEMOCRATS OF ORANGE COUNTY POLITICAL ACTION COMMITTEE (DEMOC PAC)', 'leadership_or_party_pac'),
  ('C00459925', NULL, 'CHARTER OAK PAC', 'unknown_abstract_pac'),
  ('C00821744', 'finance', 'ENACT HOLDINGS, INC. POLITICAL ACTION COMMITTEE (ENACT PAC)', 'mortgage_finance'),
  ('C00727784', NULL, 'SERVICE FIRST PAC', 'unknown_abstract_pac'),
  ('C00570101', NULL, 'VIBE PAC (VICTORY BY INVESTING BUILDING EMPOWERING)', 'unknown_abstract_pac'),
  ('C00561779', NULL, 'AMERICAN INNOVATION POLITICAL ACTION COMMITTEE (AMI PAC)', 'unknown_abstract_pac'),
  ('C00345058', NULL, 'COMMON SENSE COMMON SOLUTIONS POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00577288', NULL, 'DECIDING CRITICAL RACES PAC (DCR PAC)', 'unknown_abstract_pac'),
  ('C00542431', NULL, 'JOHN BOLTON PAC', 'leadership_or_party_pac'),
  ('C00571216', NULL, 'DEFENDING AMERICAN VALUES EVERYWHERE PAC', 'leadership_or_party_pac'),
  ('C00213066', NULL, 'CAREER EDUCATION COLLEGES AND UNIVERSITIES POLITICAL ACTION COMMITTEE', 'education'),
  ('C00010793', NULL, 'THE LOOSE GROUP', 'unknown_abstract_pac'),
  ('C00484592', 'utilities', 'CLEAN FUELS ALLIANCE AMERICA POLITICAL ACTION COMMITTEE', 'renewables'),
  ('C00343947', NULL, 'NEXT CENTURY FUND', 'unknown_abstract_pac'),
  ('C00789602', 'manufacturing', 'SYLVAMO CORPORATION PAC', 'industrial_manufacturing'),
  ('C00851998', NULL, 'PENNSYLVANIA HONOR', 'unknown_abstract_pac'),
  ('C00699439', 'tech', 'ZILLOW GROUP, INC. POLITICAL ACTION COMMITTEE (ZG PAC)', 'software_internet'),
  ('C00425686', 'manufacturing', 'AMERICAN CONCRETE PIPE ASSOCIATION PAC', 'industrial_manufacturing'),
  ('C00756551', NULL, 'AMERICAN GRIT PAC', 'unknown_abstract_pac'),
  ('C00430579', NULL, 'BRAVE PAC', 'unknown_abstract_pac'),
  ('C00335257', NULL, 'HEALTH & FITNESS ASSOCIATION PAC (FITPAC)', 'other_services'),
  ('C00827881', NULL, 'CIRCLE THE WAGONS PAC', 'unknown_abstract_pac'),
  ('C00041061', 'transportation', 'AMERICAN PILOTS'' ASSOCIATION POLITICAL ACTION COMMITTEE', 'maritime_shipping'),
  ('C00484402', NULL, 'COUNTRY ROADS PAC', 'unknown_abstract_pac'),
  ('C00119776', 'utilities', 'GEORGIA POWER COMPANY FEDERAL PAC', 'electric_utility'),
  ('C00654186', NULL, 'SOCK IT TO ''EM PAC', 'unknown_abstract_pac'),
  ('C00325357', NULL, 'PIONEER POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00388777', 'finance', 'SAMMONS ENTERPRISES INC. POLITICAL ACTION COMMITTEE', 'insurance'),
  ('C00213819', 'health', 'DELTA DENTAL PLANS ASSOCIATION PAC', 'health_insurer'),
  ('C00438358', 'manufacturing', 'AMSTED INDUSTRIES INCORPORATED PAC', 'industrial_manufacturing'),
  ('C00757344', NULL, 'MAKING A DIFFERENCE PAC', 'unknown_abstract_pac'),
  ('C00163253', 'utilities', 'MDU RESOURCES GROUP GOOD GOVERNMENT FUND', 'gas_utility'),
  ('C00638130', NULL, 'COWBOY PAC', 'unknown_abstract_pac'),
  ('C00635557', NULL, 'DO RIGHT BAYOU PAC', 'unknown_abstract_pac'),
  ('C00811786', 'lobby', 'DEMOCRACY DEFENSE FUND', 'ideological_advocacy'),
  ('C00761957', NULL, 'IN OUR HANDS', 'unknown_abstract_pac'),
  ('C00819102', NULL, 'DREAMAKERS PAC', 'unknown_abstract_pac'),
  ('C00459123', NULL, 'NEW PIONEERS PAC', 'unknown_abstract_pac'),
  ('C00110478', 'mining', 'PEABODY ENERGY CORPORATION POLITICAL ACTION COMMITTEE  (PEABODY PAC)', 'coal_mining'),
  ('C00307991', NULL, 'RIPPLE OF HOPE PAC', 'unknown_abstract_pac'),
  ('C00542621', NULL, 'MAPLE PAC', 'unknown_abstract_pac'),
  ('C00636837', NULL, 'STAR PAC', 'unknown_abstract_pac'),
  ('C00048702', 'utilities', 'NATIONAL GRID USA POLITICAL ACTION COMMITTEE', 'electric_utility'),
  ('C00582726', NULL, 'JUMP INTO ACTION FOR CONSERVATIVES TO KEEP OUR IDEAS ELEVATED PAC', 'leadership_or_party_pac'),
  ('C00571943', NULL, 'FOSTERING PROGRESS PAC', 'unknown_abstract_pac'),
  ('C00820100', NULL, 'HELPING EXCEPTIONAL LEADERS ORGANIZE PAC (HELO PAC)', 'unknown_abstract_pac'),
  ('C00779827', NULL, 'MAX MILLER VICTORY', 'leadership_or_party_pac'),
  ('C00498931', NULL, 'COMMONWEALTH PAC', 'unknown_abstract_pac'),
  ('C00304634', 'mining', 'MINEPAC, A POLITICAL ACTION COMMITTEE OF THE NATIONAL MINING ASSOCIATION', 'coal_mining'),
  ('C00435024', 'lobby', 'CENTER FOR SPORTFISHING POLICY POLITICAL ACTION COMMITTEE AKA CENTER PAC', 'single_issue_advocacy'),
  ('C00253187', NULL, 'BUFFALO RIVER POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00330233', 'mining', 'ALLIANCE COAL, LLC PAC', 'coal_mining'),
  ('C00525238', NULL, 'IMPACT COMMITTEE', 'unknown_abstract_pac'),
  ('C00491654', 'lobby', 'CITIZENS FOR PROSPERITY IN AMERICA TODAY PAC', 'ideological_advocacy'),
  ('C00721233', NULL, 'BEAT THE ODDS PAC', 'unknown_abstract_pac'),
  ('C00743344', 'health', 'VILLAGEMD PAC', 'health_provider'),
  ('C00211524', 'agriculture', 'TEXAS AND SOUTHWESTERN CATTLE RAISERS ASSOCIATION PAC', 'agriculture_trade_assoc'),
  ('C00708172', NULL, 'PA-FIRST PAC', 'unknown_abstract_pac'),
  ('C00525030', NULL, 'TOGETHER EVERYONE REALIZES REAL IMPACT AKA TERRI PAC', 'leadership_or_party_pac'),
  ('C00034298', 'manufacturing', 'PPG INDUSTRIES INC. PAC', 'chemicals'),
  ('C00485979', 'tech', 'COGNIZANT TECHNOLOGY SOLUTIONS CORPORATION POLITICAL ACTION COMMITTEE (COGNIZANT PAC)', 'software_internet'),
  ('C00101592', 'utilities', 'PUGET SOUND ENERGY INC. PAC FOR GOOD GOVERNMENT', 'electric_utility'),
  ('C00849323', 'labor', 'INDEPENDENT PILOTS ASSOCIATION POLITICAL ACTION COMMITTEE (IPAC)', 'labor_union'),
  ('C00143867', 'finance', 'EQUIFAX INC. POLITICAL ACTION COMMITTEE', 'fintech_payments'),
  ('C00099267', NULL, 'TEXAS DEMOCRATIC PARTY', 'leadership_or_party_pac'),
  ('C00828996', 'finance', 'HEALTHEQUITY, INC PURPLE POLITICAL ACTION COMMITTEE (HEALTHEQUITY PURPLE POLITICAL ACTION COMMITTEE)', 'fintech_payments'),
  ('C00325076', 'lobby', 'CAMPAIGN FOR WORKING FAMILIES', 'ideological_advocacy'),
  ('C00571182', NULL, 'GETTING STUFF DONE PAC (GSD-PAC)', 'unknown_abstract_pac'),
  ('C00545236', NULL, 'NEW VOICE PAC', 'unknown_abstract_pac'),
  ('C00523233', 'utilities', 'EDF RENEWABLES, INC. PAC', 'renewables'),
  ('C00691147', NULL, 'ROUGHRIDER PAC', 'unknown_abstract_pac'),
  ('C00816108', 'lobby', 'HISPANIC LEADERSHIP TRUST PARTNERSHIP', 'ideological_advocacy'),
  ('C00829408', NULL, 'PAC IN THE SADDLE', 'unknown_abstract_pac'),
  ('C00652883', NULL, 'ALTERMAN MANAGEMENT GROUP, INC. PAC', 'other_services'),
  ('C00603134', NULL, 'VISIONARY PAC', 'unknown_abstract_pac'),
  ('C00762369', NULL, 'SUMMITT PAC', 'unknown_abstract_pac'),
  ('C00692640', NULL, 'FIGHTING FOR MISSOURI PAC', 'unknown_abstract_pac'),
  ('C00409110', NULL, 'GREEN MOUNTAIN PAC', 'unknown_abstract_pac'),
  ('C00450866', NULL, 'CONCORDIA POLITICAL ACTION COMMITTEE, INC.', 'unknown_abstract_pac'),
  ('C00385534', NULL, 'LEGPAC', 'unknown_abstract_pac'),
  ('C00208322', NULL, 'MANAGEMENT AND TRAINING CORPORATION POLITICAL ACTION COMMITTEE', 'other_services'),
  ('C00819425', NULL, 'OLD BREED PAC', 'unknown_abstract_pac'),
  ('C00669929', NULL, 'COMMON GOOD PAC', 'unknown_abstract_pac'),
  ('C00498360', 'lobby', 'TRUTH IS MARKETS WORK FUND', 'ideological_advocacy'),
  ('C00590356', NULL, 'BUILDING AND RESTORING THE AMERICAN DREAM FUND', 'unknown_abstract_pac'),
  ('C00809012', NULL, 'FROGMAN PAC', 'unknown_abstract_pac'),
  ('C00076737', 'utilities', 'SOUTHWEST GAS CORPORATION POLITICAL ACTION COMMITTEE', 'gas_utility'),
  ('C00686832', NULL, 'WAY TO LEAD PAC', 'unknown_abstract_pac'),
  ('C00571802', NULL, 'SENSIBLE AMERICAN SOLUTIONS SUPPORTING EVERYONE PAC', 'leadership_or_party_pac'),
  ('C00571042', 'finance', 'MOTORSPORTS ACCEPTANCE CORPORATION POLITICAL ACTION COMMITTEE (SPEED PAC)', 'consumer_lending'),
  ('C00490235', NULL, 'AMERICA''S FUTURE, TOGETHER', 'unknown_abstract_pac'),
  ('C00406553', 'lobby', 'PROGRESSIVE VOTERS OF AMERICA', 'ideological_advocacy'),
  ('C00842583', 'real_estate', 'AFFORDABLE HOUSING TAX CREDIT COALITION POLITICAL ACTION COMMITTEE (AFFORDABLE HOUSING PAC', 'real_estate'),
  ('C00764290', 'utilities', 'BLOOM ENERGY CORPORATION PAC (BE PAC)', 'renewables'),
  ('C00720920', 'real_estate', 'EMPLOYEES OF QUANTA SERVICES, INC.', 'engineering_construction'),
  ('C00466870', NULL, 'LEADERSHIP FOR ENTERPRISE AND OPPORTUNITY PAC', 'unknown_abstract_pac'),
  ('C00545137', NULL, 'LEADERSHIP OPPORTUNITY INNOVATION SERVICE PAC', 'leadership_or_party_pac'),
  ('C00432096', NULL, 'KEYSTONE ALLIANCE POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00502096', NULL, 'MICHIGAN''S FUTURE PAC', 'unknown_abstract_pac'),
  ('C00822601', NULL, 'MISSOURI SCHMITT VICTORY COMMITTEE 2022', 'leadership_or_party_pac'),
  ('C00248948', NULL, 'PEOPLE HELPING PEOPLE', 'unknown_abstract_pac'),
  ('C00486720', NULL, 'SEA CHANGE PAC', 'unknown_abstract_pac'),
  ('C00432393', 'retail', 'CRUISE LINES INTERNATIONAL ASSOCIATION PAC (CLIA PAC)', 'hospitality_travel'),
  ('C00688549', NULL, 'DAKOTA LEADERSHIP PAC', 'unknown_abstract_pac'),
  ('C00841908', NULL, 'A PLEASANT PENINSULA PAC', 'unknown_abstract_pac'),
  ('C00343590', 'real_estate', 'MECHANICAL CONTRACTORS ASSOCIATION OF AMERICA POLITICAL ACTION COMMITTEE (MCA-PAC)', 'construction_contractor'),
  ('C00829119', NULL, 'BACPAC', 'unknown_abstract_pac'),
  ('C00575894', 'lobby', 'BLUE POWER PAC', 'ideological_advocacy'),
  ('C00788596', NULL, 'LANKFORD YOUNG VICTORY COMMITTEE', 'leadership_or_party_pac'),
  ('C00726729', NULL, 'SOUTH JERSEY UNITED IN TRUST (SJUIT) PAC', 'unknown_abstract_pac'),
  ('C00818542', NULL, 'FIELD OF DREAMS PAC', 'unknown_abstract_pac'),
  ('C00752790', NULL, 'JOBS AND THE ECONOMY PAC', 'unknown_abstract_pac'),
  ('C00824342', NULL, 'WAY BACK PAC', 'unknown_abstract_pac'),
  ('C00766774', NULL, 'MARJORIE TAYLOR GREENE''S PEOPLE OVER POLITICIANS COMMITTEE', 'leadership_or_party_pac'),
  ('C00877621', NULL, 'MAINTAINING AMERICAN COMPETITIVENESS PAC', 'unknown_abstract_pac'),
  ('C00657262', NULL, 'GO PAC GO', 'unknown_abstract_pac'),
  ('C00516526', 'manufacturing', 'ALLIANCE FOR AUTOMOTIVE INNOVATION POLITICAL ACTION COMMITTEE', 'auto_manufacturing'),
  ('C00524603', NULL, 'KEEP AMERICA ROLLING', 'unknown_abstract_pac'),
  ('C00374355', 'defense', 'SHIPBUILDERS COUNCIL OF AMERICA PAC', 'defense_contractor'),
  ('C00004101', 'real_estate', 'NATIONAL UTILITY CONTRACTORS ASSOCIATION LEGISLATIVE INFORMATION AND ACTION COMMITTEE', 'construction_contractor'),
  ('C00691634', 'manufacturing', 'ADVANCED DRAINAGE SYSTEMS, INC. PAC', 'industrial_manufacturing'),
  ('C00711747', 'manufacturing', 'THE GREENBRIER COMPANIES, INC. PAC (AKA GREENBRIER PAC)', 'industrial_manufacturing'),
  ('C00281717', 'real_estate', 'AMERICAN TRAFFIC SAFETY SERVICES ASSOCIATION PAC', 'construction_contractor'),
  ('C00841114', NULL, 'JUSTICE VICTORY COMMITTEE', 'leadership_or_party_pac'),
  ('C00580894', 'retail', 'VAIL RESORTS EMPLOYEE POLITICAL ACTION COMMITTEE', 'hospitality_travel'),
  ('C00816728', 'health', 'MARQUIS MASTER SC, INC. PAC (MARQUIS PAC)', 'health_provider'),
  ('C00368902', 'real_estate', 'DAVID VOLKERT & ASSOCIATES, INC. POLITICAL ACTION COMMITTEE (''DVA/HC PAC'')', 'engineering_construction'),
  ('C00034355', 'manufacturing', 'PEOPLE PAC (PACCAR INC EMPLOYEES ORGANIZED FOR POLITICAL LEADERSHIP AND EDUCATION PAC)', 'auto_manufacturing'),
  ('C00491589', 'legal', 'NATIONAL CREDITORS BAR ASSOCIATION PAC', 'legal_trade_assoc'),
  ('C00213348', 'manufacturing', 'HOLCIM US EMPLOYEES PAC', 'industrial_manufacturing'),
  ('C00629832', NULL, 'BUILDING OPPORTUNITIES FOR A STRONGER TOMORROW B.O.S.T. PAC', 'leadership_or_party_pac'),
  ('C00764753', 'lobby', 'AHORA PAC', 'ideological_advocacy'),
  ('C00361253', 'real_estate', 'FLORIDA TRANSPORTATION BUILDERS ASSOCIATION, INC. FEDERAL PAC', 'construction_contractor'),
  ('C00239947', 'retail', 'CAESARS ENTERTAINMENT, INC. POLITICAL ACTION COMMITTEE', 'gaming_casino'),
  ('C00542514', NULL, 'VIGOR PAC', 'unknown_abstract_pac'),
  ('C00390963', 'health', 'ARDENT LEGACY HOLDINGS LLC GOOD GOVERNMENT FUND', 'health_provider'),
  ('C00399642', 'retail', 'LAS VEGAS SANDS CORP. POLITICAL ACTION COMMITTEE (SANDS PAC)', 'gaming_casino'),
  ('C00373910', 'retail', 'GLOBAL BUSINESS TRAVEL ASSOCIATION PAC (BUSINESS TRAVEL PAC)', 'hospitality_travel'),
  ('C00633818', NULL, 'OLD NORTH STATE PAC', 'unknown_abstract_pac'),
  ('C00764415', 'transportation', 'APL PAC', 'maritime_shipping'),
  ('C00357608', NULL, 'CALIFORNIA WATER SERVICE GROUP POLITICAL ACTION COMMITTEE', 'other_services'),
  ('C00200089', 'manufacturing', 'OWENS CORNING BETTER GOVERNMENT FUND', 'industrial_manufacturing'),
  ('C00128975', 'manufacturing', 'CMHA BLOCK & PAVER PAC CONCRETE MASONRY AND HARDSCAPES VALLEY DRIVE', 'industrial_manufacturing'),
  ('C00411769', 'finance', 'QC HOLDINGS, INC. POLITICAL ACTION COMMITTEE', 'consumer_lending'),
  ('C00401034', NULL, 'BUILDING FOUNDATIONS & LANDMARK OPPORTUNITIES PAC (BFLO PAC)', 'unknown_abstract_pac'),
  ('C00571570', NULL, 'INLAND EMPIRE LEADERSHIP PAC', 'unknown_abstract_pac'),
  ('C00378950', NULL, 'SMOKE BEND ASSOCIATES LLC FEDERAL POLITICAL ACTION COMMITTEE', 'unknown_abstract_pac'),
  ('C00906669', NULL, 'NESTPOINT PAC', 'unknown_abstract_pac'),
  ('C00263731', 'retail', 'RED ROCK RESORTS, INC. PAC', 'gaming_casino'),
  ('C00172635', 'oil_gas', 'BASS BROTHERS ENTERPRISES INC. - POLITICAL ACTION COMMITTEE', 'oil_gas_upstream'),
  ('C00156935', 'legal', 'AMERICAN INTELLECTUAL PROPERTY LAW ASSOCIATION (AIPLA) PAC', 'legal_trade_assoc'),
  ('C00523613', 'manufacturing', 'DEXTER APACHE HOLDINGS INC PAC (''DEXTER APACHE PAC'')', 'industrial_manufacturing'),
  ('C00214866', 'real_estate', 'STV GROUP INC POLITICAL ACTION COMMITTEE', 'engineering_construction'),
  ('C00630541', NULL, 'BLOCK BY BLOCK PAC', 'unknown_abstract_pac'),
  ('C00428391', NULL, 'REPUBLIC SERVICES INC. EMPLOYEES FOR BETTER GOVT. PAC', 'other_services')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector;

-- ---------------------------------------------------------------------------
-- 3. Seed assertions
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  v_total   int;
  v_nonnull int;
  v_null    int;
  v_orphan  int;
  v_sample  text;
BEGIN
  SELECT count(*), count(industry), count(*) - count(industry)
    INTO v_total, v_nonnull, v_null
    FROM public.financial_entity_industry_overrides;

  IF v_total <> 742 OR v_nonnull <> 380 OR v_null <> 362 THEN
    RAISE EXCEPTION
      'FIX-916 seed assertion failed: expected 742/380/362 (total/non-null/null), got %/%/%',
      v_total, v_nonnull, v_null;
  END IF;

  -- Decision 10: an override with no matching financial_entity is a HARD ERROR,
  -- not a skip. Expected zero -- every id came from a join against
  -- financial_entities -- so a non-zero count means the override list and the
  -- entity table disagree and seeding partially would hide that.
  SELECT count(*) INTO v_orphan
    FROM public.financial_entity_industry_overrides o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.financial_entities fe
      WHERE fe.fec_committee_id = o.fec_committee_id
   );

  IF v_orphan > 0 THEN
    SELECT string_agg(o.fec_committee_id, ', ')
      INTO v_sample
      FROM (
        SELECT o.fec_committee_id
          FROM public.financial_entity_industry_overrides o
         WHERE NOT EXISTS (
           SELECT 1 FROM public.financial_entities fe
            WHERE fe.fec_committee_id = o.fec_committee_id
         )
         ORDER BY o.fec_committee_id
         LIMIT 20
      ) o;
    RAISE EXCEPTION
      'FIX-916: % override row(s) reference an fec_committee_id absent from financial_entities (first 20: %). Refusing to seed partially.',
      v_orphan, v_sample;
  END IF;

  RAISE NOTICE 'FIX-916 seed OK: % rows (% re-assigned, % de-tagged), 0 orphans',
    v_total, v_nonnull, v_null;
END
$do$;

-- ---------------------------------------------------------------------------
-- 4. One-time cleanup of the surviving generated_by='ai' industry rows
--
-- clear_financial_entity_rule_tags() only removes generated_by='rule' rows, so
-- the AI-derived industry tags persist forever unless deleted explicitly -- and
-- they carry MOST of the dollars (93.7% of 'lobby', 71.5% of 'oil_gas', 66.4% of
-- 'defense' as measured 2026-07-27). Left in place they would shadow the
-- curation on every consuming surface.
--
-- Scoped to donors in the override table ONLY. AI rows for non-overridden donors
-- are the unaudited tail and are deliberately left alone.
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
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RAISE NOTICE 'FIX-916: deleted % generated_by=''ai'' industry row(s) for overridden donors', v_deleted;
END
$do$;

COMMIT;
