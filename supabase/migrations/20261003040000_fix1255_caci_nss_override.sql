-- FIX-1255 — CACI NSS joins the defense-prime override cohort (cohort 13 across
-- two migrations; the override table goes 805 → 806).
--
-- WHY. 20261002010000_fix1255_defense_primes_override.sql seeded twelve
-- defense IT and R&D primes whose dollar-dominant NAICS code sends them to
-- `tech`. cc-180 read 3 listed CACI NSS beside them as the one same-company
-- sibling with the same shape: a `corporation` with no fec_committee_id, no
-- override, `defense/ai@0.85` beside a `tech/rule` NAICS row, and a pick of
-- `tech`. Craig, 2026-10-03 (cc-184 D2): seed it into the same cohort, same
-- audited_sector, same source. The applied migration is frozen history and is
-- not edited; its 12 / 805 asserts stay true of the state it left.
--
-- THE ROW comes from docs/audits/2026-10-03-fix1255-caci-nss.tsv, written from
-- a prod read (cc-184, 23:16-23:18 UTC 2026-10-03): `CACI NSS, LLC`
-- 8fc669b7-378f-4f52-b6f2-adff2485801c is the ONLY financial_entities row
-- matching '%caci%nss%'; contract + grant rows $2,038,000,870.48, of which
-- $245,132,377.39 carry a naics_code; dominant code 541519 (5415 computer
-- systems design → tech, $160.8M of the coded dollars); industry rows
-- `defense/ai 0.85` (2026-04-25) and `tech/rule 0.85` naics 541519;
-- primary_industry_tag → tech.
--
-- WHAT THE NIGHTLY DOES WITH IT. As for the twelve: tagFinancialEntities()
-- reads the override through the FIX-922 uuid arm and drops the computed
-- `tech` NAICS row. The entity already holds `defense/ai` on the exact key the
-- curated row would use, and FIX-1259 keeps another writer's provenance, so
-- the curated row is not written while the ai row stands and the ai row is the
-- entity's only industry row. primary_industry_tag() picks defense either way.
-- No ai row is deleted here (cc-184 D1).
--
-- IDEMPOTENT: the insert upserts on the synthetic key, and the assertions hold
-- on an already-migrated env.

BEGIN;

-- ── 1. Pre-check: the id is a contractor row with no override elsewhere ──────
-- A missing row, a row that is an FEC committee (it belongs on the committee
-- arm), or a row some other cohort already curates is a STOP — ON CONFLICT
-- would silently re-source another cohort's row.
DO $do$
DECLARE
  v_ids   uuid[] := ARRAY['8fc669b7-378f-4f52-b6f2-adff2485801c']::uuid[];
  v_found int;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_found FROM public.financial_entities WHERE id = ANY (v_ids);
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'FIX-1255: % of 1 CACI NSS id resolve to financial_entities rows. Refusing to seed.', v_found;
  END IF;

  SELECT string_agg(fe.display_name || ' [' || fe.fec_committee_id || ']', '; ') INTO v_bad
    FROM public.financial_entities fe
   WHERE fe.id = ANY (v_ids) AND fe.fec_committee_id IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1255: the CACI NSS row carries an fec_committee_id and belongs on the committee arm: %', v_bad;
  END IF;

  SELECT string_agg(o.fec_committee_id || ' (' || o.source || ')', '; ') INTO v_bad
    FROM public.financial_entity_industry_overrides o
   WHERE o.financial_entity_id = ANY (v_ids)
     AND o.source <> 'fix1255-defense-primes-2026-10-01';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1255: the CACI NSS row is already curated by another cohort: %', v_bad;
  END IF;
END
$do$;

-- ── 2. The override row (uuid arm: key = 'fe:' || financial_entity_id) ──────
INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, financial_entity_id, industry, display_name_at_audit, audited_sector, source, note)
VALUES
  ('fe:8fc669b7-378f-4f52-b6f2-adff2485801c', '8fc669b7-378f-4f52-b6f2-adff2485801c', 'defense', 'CACI NSS, LLC', 'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01', 'FIX-1255: dominant NAICS 541519 (5415 computer systems design -> tech); defense prime by Craig 2026-10-03 (cc-180 read 3 sibling)')
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
  -- The cohort spans both FIX-1255 migrations: the twelve + CACI NSS.
  SELECT count(*) INTO v_cohort
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.id = o.financial_entity_id
   WHERE o.source = 'fix1255-defense-primes-2026-10-01'
     AND o.industry = 'defense'
     AND o.fec_committee_id = 'fe:' || o.financial_entity_id::text;
  IF v_cohort <> 13 THEN
    RAISE EXCEPTION 'FIX-1255: expected 13 resolved defense rows in the cohort (12 + CACI NSS), found %.', v_cohort;
  END IF;

  -- 742 (FIX-916) + 50 (FIX-921) + 1 (FIX-923) + 12 (FIX-1255) + 1 (this) = 806.
  -- A collision with an existing cohort would be absorbed by ON CONFLICT and
  -- present as a shrunken count; the pre-check above names it first.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 806 THEN
    RAISE EXCEPTION
      'FIX-1255: override table should hold 806 rows (742 + 50 + 1 + 12 + 1 FIX-1255), holds %.', v_total;
  END IF;

  RAISE NOTICE 'FIX-1255 OK — CACI NSS seeded on the uuid arm (cohort now %, table now % rows).', v_cohort, v_total;
END
$do$;

COMMIT;
