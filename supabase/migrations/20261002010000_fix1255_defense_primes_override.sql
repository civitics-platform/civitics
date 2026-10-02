-- FIX-1255 — twelve defense IT and R&D primes get a curated `defense` override
-- (the first cohort on the FIX-922 uuid arm).
--
-- WHY. FIX-1252 tags each contractor by its dollar-dominant NAICS code, and
-- FIX-1245 ranks a rule (NAICS) tag ahead of an ai tag. For these twelve the
-- dominant code is 5415 computer systems design, 5417 R&D, 334 electronics, or
-- 51 information, all of which the map sends to `tech`, while the ai tag said
-- `defense`. After both landed, the contract chord moved $91.8B of their
-- contract dollars from Defense & Aerospace to Technology & Communications
-- (cc-176 read 3; jobid 28 wrote it into both contract rollups Thu 10-01 14:00
-- UTC). The codes are correct for the work; the industry is defense. Craig,
-- 2026-10-01 17:25 PDT: a curated `defense` override for these twelve, by name.
-- The other fifteen contractors whose pick changed are accepted as their
-- dominant code's industry; see FIX-1255's bullet.
--
-- THE ROWS come from docs/audits/2026-10-01-fix1255-defense-primes.tsv, which
-- was written from a prod read (cc-180 read 3, 03:49 UTC 2026-10-02). Each name
-- resolves to exactly one row by name plus cc-176's dominant code. All are
-- corporations with no fec_committee_id, $0 donated and no existing override,
-- so the uuid arm is the only key that reaches them. The Blue Origin and Humana
-- rows already in this table are their PACs (C00557793, C00271007), not these
-- contractor rows. Same-company siblings that Craig's call did not name (CACI
-- NSS, the L3Harris subsidiaries, Blue Origin Texas and Washington, SAAB
-- Aktiebolag, ...) are listed in the cc-180 report, not here.
--
-- WHAT THE NIGHTLY DOES WITH IT. tagFinancialEntities() reads the table through
-- the FIX-922 uuid arm, drops every computed industry tag for these twelve (the
-- `tech` NAICS rows), and emits one curated `defense` row each. Each of them
-- already holds a generated_by='ai' `defense` row on that same key (entity,
-- 'defense', 'industry'), and FIX-1259 (c4b21847) stops a writer from
-- overwriting another writer's provenance. So the curated row is NOT written
-- while the ai row stands. The ai `defense` row is then the entity's only
-- industry row, and primary_industry_tag() picks defense. If the ai row ever
-- goes, the curated row takes the key on the next nightly. Either way the pick
-- is defense. Unlike FIX-916, FIX-921 and FIX-923, this migration deliberately
-- does NOT delete the ai rows: they agree with the override, and keeping
-- another writer's judgment is the point of FIX-1259.
--
-- IDEMPOTENT: the insert upserts on the synthetic key, and the assertions hold
-- on an already-migrated env.

BEGIN;

-- ── 1. Pre-check: every id is a contractor row with no override elsewhere ────
-- A missing row, a row that is an FEC committee (it belongs on the committee
-- arm), or a row some other cohort already curates is a STOP — ON CONFLICT
-- would silently re-source another cohort's row.
DO $do$
DECLARE
  v_ids   uuid[] := ARRAY[
    '2d39711b-3d07-4351-aa28-8c4390f780fe', '2d489f9f-e419-45c3-b3c3-d3204254b68e',
    '775ffe3e-5607-4559-a6fc-4d766892087b', '0c779898-b3b5-4dc0-8b3e-c0c505ec94ad',
    'b3fd7d61-8708-44cc-81c4-96c914a2989a', '6f39ee2d-1d52-44dc-8bfe-97168b08d54b',
    '07f586a3-4996-47a6-97fc-55bf06f7dcf3', 'bcf3792f-35b2-4daf-ae0f-c132784e1d24',
    '8e46bf37-380d-48a4-a4b8-244d036b93f3', 'dae656c9-02c4-4030-bd52-814c69ad5e6d',
    '7e7bcd33-1ca0-40ab-8777-d4f900d241f0', 'e05486a3-4687-476a-950e-39b65281bd47']::uuid[];
  v_found int;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_found FROM public.financial_entities WHERE id = ANY (v_ids);
  IF v_found <> 12 THEN
    RAISE EXCEPTION 'FIX-1255: % of 12 cohort ids resolve to financial_entities rows. Refusing to seed.', v_found;
  END IF;

  SELECT string_agg(fe.display_name || ' [' || fe.fec_committee_id || ']', '; ') INTO v_bad
    FROM public.financial_entities fe
   WHERE fe.id = ANY (v_ids) AND fe.fec_committee_id IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1255: cohort rows carry an fec_committee_id and belong on the committee arm: %', v_bad;
  END IF;

  SELECT string_agg(o.fec_committee_id || ' (' || o.source || ')', '; ') INTO v_bad
    FROM public.financial_entity_industry_overrides o
   WHERE o.financial_entity_id = ANY (v_ids)
     AND o.source <> 'fix1255-defense-primes-2026-10-01';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1255: cohort rows are already curated by another cohort: %', v_bad;
  END IF;
END
$do$;

-- ── 2. The override rows (uuid arm: key = 'fe:' || financial_entity_id) ─────
INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, financial_entity_id, industry, display_name_at_audit, audited_sector, source, note)
VALUES
  ('fe:2d39711b-3d07-4351-aa28-8c4390f780fe', '2d39711b-3d07-4351-aa28-8c4390f780fe', 'defense', 'AEROJET ROCKETDYNE OF DE, INC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541712 (5417 R&D -> tech); defense prime by Craig 2026-10-01'),
  ('fe:2d489f9f-e419-45c3-b3c3-d3204254b68e', '2d489f9f-e419-45c3-b3c3-d3204254b68e', 'defense', 'BLUE ORIGIN MANUFACTURING, LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541715 (5417 R&D -> tech); defense prime by Craig 2026-10-01'),
  ('fe:775ffe3e-5607-4559-a6fc-4d766892087b', '775ffe3e-5607-4559-a6fc-4d766892087b', 'defense', 'CACI, INC. - FEDERAL', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541512 (5415 computer systems design -> tech); defense prime by Craig 2026-10-01'),
  ('fe:0c779898-b3b5-4dc0-8b3e-c0c505ec94ad', '0c779898-b3b5-4dc0-8b3e-c0c505ec94ad', 'defense', 'Harris Corporation', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 517310 (51 information -> tech); defense prime by Craig 2026-10-01'),
  ('fe:b3fd7d61-8708-44cc-81c4-96c914a2989a', 'b3fd7d61-8708-44cc-81c4-96c914a2989a', 'defense', 'KBR WYLE SERVICES, LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541715 (5417 R&D -> tech); defense prime by Craig 2026-10-01'),
  ('fe:6f39ee2d-1d52-44dc-8bfe-97168b08d54b', '6f39ee2d-1d52-44dc-8bfe-97168b08d54b', 'defense', 'L3HARRIS TECHNOLOGIES, INC.', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 334220 (334 electronics manufacturing -> tech); defense prime by Craig 2026-10-01'),
  ('fe:07f586a3-4996-47a6-97fc-55bf06f7dcf3', '07f586a3-4996-47a6-97fc-55bf06f7dcf3', 'defense', 'LAWRENCE LIVERMORE NATIONAL SECURITY, LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541710 (5417 R&D -> tech); defense prime by Craig 2026-10-01'),
  ('fe:bcf3792f-35b2-4daf-ae0f-c132784e1d24', 'bcf3792f-35b2-4daf-ae0f-c132784e1d24', 'defense', 'SAAB, INC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 334511 (334 electronics manufacturing -> tech); defense prime by Craig 2026-10-01'),
  ('fe:8e46bf37-380d-48a4-a4b8-244d036b93f3', '8e46bf37-380d-48a4-a4b8-244d036b93f3', 'defense', 'SCIENCE APPLICATIONS INTERNATIONAL CORPORATION', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541512 (5415 computer systems design -> tech); defense prime by Craig 2026-10-01'),
  ('fe:dae656c9-02c4-4030-bd52-814c69ad5e6d', 'dae656c9-02c4-4030-bd52-814c69ad5e6d', 'defense', 'SMARTRONIX, LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541512 (5415 computer systems design -> tech); defense prime by Craig 2026-10-01'),
  ('fe:7e7bcd33-1ca0-40ab-8777-d4f900d241f0', '7e7bcd33-1ca0-40ab-8777-d4f900d241f0', 'defense', 'The MITRE Corporation', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541715 (5417 R&D -> tech); defense prime by Craig 2026-10-01'),
  ('fe:e05486a3-4687-476a-950e-39b65281bd47', 'e05486a3-4687-476a-950e-39b65281bd47', 'defense', 'WESTINGHOUSE GOVERNMENT SERVICES LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 334517 (334 electronics manufacturing -> tech); defense prime by Craig 2026-10-01')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector,
      source                = EXCLUDED.source,
      note                  = EXCLUDED.note;

-- ── 3. Cohort + total assertions ─────────────────────────────────────────────
DO $do$
DECLARE
  v_cohort int;
  v_total  int;
BEGIN
  SELECT count(*) INTO v_cohort
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.id = o.financial_entity_id
   WHERE o.source = 'fix1255-defense-primes-2026-10-01'
     AND o.industry = 'defense'
     AND o.fec_committee_id = 'fe:' || o.financial_entity_id::text;
  IF v_cohort <> 12 THEN
    RAISE EXCEPTION 'FIX-1255: expected 12 resolved defense rows in the cohort, found %.', v_cohort;
  END IF;

  -- 742 (FIX-916) + 50 (FIX-921) + 1 (FIX-923) + 12 (this) = 805. A collision
  -- with an existing cohort would be absorbed by ON CONFLICT and present as a
  -- shrunken count; the pre-check above names it first.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 805 THEN
    RAISE EXCEPTION
      'FIX-1255: override table should hold 805 rows (742 + 50 + 1 + 12 FIX-1255), holds %.', v_total;
  END IF;

  RAISE NOTICE 'FIX-1255 OK — % defense primes seeded on the uuid arm (table now % rows).', v_cohort, v_total;
END
$do$;

COMMIT;
