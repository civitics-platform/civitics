-- =============================================================================
-- 20260920060000_fix922_industry_override_financial_entity_id.sql
-- FIX-922 — an industry override must be able to address a donor that has no
-- fec_committee_id.
--
-- THE GAP
-- -------
-- financial_entity_industry_overrides (20260728000000_fix916) is keyed on
-- fec_committee_id text PRIMARY KEY, and its header states the reason: UUIDs
-- are not portable across a re-seed, FEC committee ids are the stable external
-- key, and all 742 audited donors had one. That is still true of the 792
-- curated rows — and it silently excludes every donor that is not an FEC
-- committee. There is no key with which to write the row.
--
-- Measured on prod 2026-09-20 — donors with fec_committee_id IS NULL,
-- total_donated_cents > 0 and an industry tag:
--
--   a222d616-0487-48ac-af68-0ec7eca301ba  Ridge Coal Legacy Trust
--     $265,000   oil_gas  (rule)
--   8a1e3c6f-03b1-46d0-9f61-42693de6f154  Cumberland Energy Action Fund
--     $135,000   oil_gas  (ai)
--   ae4d58df-917c-47ef-80c9-0ebf8d096189  Pharmaceutical Care Management Assoc.
--      $15,000   health   (rule)
--   dac6b3f9-aebc-406d-a587-01998408f03b  NRA Political Victory Fund
--       $1,500   lobby    (rule)
--
--   4 donors, $416,500. The two oil_gas rows are escapees of exactly the kind
--   FIX-921 swept — and FIX-921's mechanism could not reach them.
--
-- THE KEY SHAPE
-- -------------
-- fec_committee_id stays PRIMARY KEY: 792 curated rows are keyed on it and it
-- is still the right key for anything that HAS one. A UUID-keyed row takes a
-- SYNTHETIC primary key, 'fe:' || financial_entity_id, with the uuid also
-- carried in its own column. So:
--
--   * one primary key, one row shape, no nullable-PK contortion;
--   * the two arms are distinguishable by inspection ('C…' vs 'fe:…');
--   * the CHECK below makes the synthetic key and the uuid column mutually
--     derivable, so they cannot disagree — it is not merely a prefix rule.
--
-- NO FOREIGN KEY, DELIBERATELY
-- ----------------------------
-- The obvious `REFERENCES financial_entities(id) ON DELETE CASCADE` is wrong
-- for THIS table. FIX-916's reader comment is explicit that an override whose
-- key no longer resolves must be "surfaced and counted rather than silently
-- vanishing", because the likely cause is a FIX-544 entity merge and the right
-- response is to re-point one row, not to lose a hand-audited assignment. A
-- cascade does the opposite: a merge deletes the loser entity and takes the
-- curation with it, silently. RESTRICT is worse — it would abort the merge.
--
-- Without a FK, a dangling uuid behaves exactly like a dangling committee id:
-- the reader's LEFT JOIN leaves entity_id NULL and it lands in the
-- orphanOverrides warning. Same failure mode, one code path, and it matches the
-- committee arm, which has never had a FK either.
--
-- THE TSV
-- -------
-- No row is inserted here. The two oil_gas escapees are a CURATION and belong
-- to Craig, like every other row in this table — their ids are listed above so
-- they can be added deliberately, in a 20260801020000_fix923-shaped migration.
--
-- The existing audit TSVs are NOT rewritten with an empty seventh column.
-- industry-overrides.test.ts parses them POSITIONALLY (c[0], c[1], c[2], c[4]),
-- both are closed artifacts of dated audits, and FIX-921 already set the
-- precedent that a new cohort gets its own file with its own drift alarm. A
-- uuid-keyed cohort is a new cohort: its TSV leads with financial_entity_id in
-- place of fec_committee_id.
-- =============================================================================

BEGIN;

ALTER TABLE public.financial_entity_industry_overrides
  ADD COLUMN IF NOT EXISTS financial_entity_id uuid NULL;

COMMENT ON COLUMN public.financial_entity_industry_overrides.financial_entity_id IS
  'FIX-922. Set ONLY for a donor with no fec_committee_id; such a row carries '
  'the synthetic primary key ''fe:'' || financial_entity_id. NULL for every '
  'committee-keyed row. No FK on purpose — a dangling id must surface in the '
  'tagger''s orphanOverrides warning (a FIX-544 merge to re-point), not '
  'cascade-delete a hand-audited assignment.';

-- The synthetic key and the uuid are mutually derivable. Stronger than a
-- prefix rule: it also forbids 'fe:<some other uuid>'.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_entity_industry_overrides'::regclass
       AND conname  = 'financial_entity_industry_overrides_key_shape'
  ) THEN
    ALTER TABLE public.financial_entity_industry_overrides
      ADD CONSTRAINT financial_entity_industry_overrides_key_shape
      CHECK (
        (financial_entity_id IS NULL     AND fec_committee_id NOT LIKE 'fe:%')
        OR
        (financial_entity_id IS NOT NULL AND fec_committee_id = 'fe:' || financial_entity_id::text)
      );
  END IF;
END
$do$;

-- One override per entity on the uuid arm. A plain UNIQUE would already permit
-- many NULLs in Postgres; the partial says so explicitly and keeps the index to
-- the handful of uuid-keyed rows.
CREATE UNIQUE INDEX IF NOT EXISTS financial_entity_industry_overrides_fe_id_key
  ON public.financial_entity_industry_overrides (financial_entity_id)
  WHERE financial_entity_id IS NOT NULL;

COMMIT;
