-- =============================================================================
-- FIX-385 — backfill territory delegate + FEC candidate jurisdictions
--
-- Two root causes left ~50 territory officials parked on the federal
-- jurisdiction instead of their canonical territory rows:
--
--   (a) Congress.gov name-mismatch — `member.state` returns "Virgin Islands"
--       for the VI delegate, but STATE_DATA.name is "U.S. Virgin Islands",
--       so the name-keyed lookup in seedJurisdictions misses → fallback to
--       federalId. Code fix in [packages/data/src/jurisdictions/us-states.ts]
--       adds a CONGRESS_STATE_ALIASES map so future runs resolve correctly.
--       Stacey E. Plaskett (bioguide P000610) is the one affected row.
--
--   (b) FIX-383 silent-degradation window residue — during 2026-05-09 →
--       2026-05-25, seedJurisdictions threw on the DC-98 sub-district
--       collision and silently dropped DC + all 5 territory entries from
--       stateIds. FEC-bulk candidate ingest fell through to federalId for
--       49 territory candidates (AS/GU/MP/PR/VI). The fec-bulk code itself
--       is correct (FIX-383 fix narrowed the existence check), but
--       fec-bulk upserts by fec_candidate_id and never overwrites
--       jurisdiction_id, so these rows do not self-heal on subsequent runs.
--
-- This migration relinks both sets to their canonical territory rows.
-- Idempotent: WHERE clauses no-op if already correct, so re-applying is
-- safe. Portable across envs: canonical UUIDs are resolved from the live
-- DB rather than hardcoded.
--
-- FIX-516 (2026-06-11, authorized edit): the sanity-check DO is guarded with a
-- seed-presence check. The plain UPDATEs need no guard — with no federal
-- jurisdiction row their WHERE clauses resolve against NULL and match 0 rows.
-- Recorded as applied on both envs — replay-only effect.
-- =============================================================================

BEGIN;

WITH
  federal AS (
    SELECT id FROM public.jurisdictions
    WHERE fips_code = '00' AND type = 'country'
    LIMIT 1
  ),
  territories AS (
    SELECT j.short_name, j.id
    FROM public.jurisdictions j, federal f
    WHERE j.parent_id = f.id
      AND j.type = 'district'
      AND j.short_name IN ('AS','GU','MP','PR','VI')
  )
-- (1) Plaskett — flip from federalId to canonical VI only if currently
--     misattributed. Targets the single row keyed by bioguide P000610.
UPDATE public.officials o
SET jurisdiction_id = (SELECT id FROM territories WHERE short_name = 'VI')
WHERE source_ids->>'congress_gov' = 'P000610'
  AND o.jurisdiction_id = (SELECT id FROM federal);

-- (2) 49 FEC candidate rows currently misattributed to federalId but
--     tagged with a territory office_state. Relink each to its canonical
--     territory row based on metadata.state.
UPDATE public.officials o
SET jurisdiction_id = t.id
FROM (
  SELECT id FROM public.jurisdictions
  WHERE fips_code = '00' AND type = 'country' LIMIT 1
) f,
     (
  SELECT j.short_name, j.id
  FROM public.jurisdictions j
  WHERE j.type = 'district'
    AND j.short_name IN ('AS','GU','MP','PR','VI')
) t
WHERE o.jurisdiction_id = f.id
  AND o.source_ids ? 'fec_candidate_id'
  AND (o.metadata->>'state') = t.short_name;

-- Sanity guard: 0 territory-tagged candidates and 0 P000610 row should
-- remain on federalId after this migration.
DO $$
DECLARE
  remaining_fec INT;
  remaining_plaskett INT;
  federal_id UUID;
BEGIN
  -- FIX-516 replay-from-zero guard — seed-presence check; body unchanged.
  IF EXISTS (SELECT 1 FROM public.jurisdictions WHERE fips_code = '00' AND type = 'country') THEN

  SELECT id INTO federal_id FROM public.jurisdictions
  WHERE fips_code = '00' AND type = 'country' LIMIT 1;

  SELECT COUNT(*) INTO remaining_fec FROM public.officials
  WHERE jurisdiction_id = federal_id
    AND source_ids ? 'fec_candidate_id'
    AND (metadata->>'state') IN ('AS','GU','MP','PR','VI');

  SELECT COUNT(*) INTO remaining_plaskett FROM public.officials
  WHERE jurisdiction_id = federal_id
    AND source_ids->>'congress_gov' = 'P000610';

  IF remaining_fec > 0 THEN
    RAISE EXCEPTION 'FIX-385 backfill incomplete: % FEC territory rows remain on federalId', remaining_fec;
  END IF;
  IF remaining_plaskett > 0 THEN
    RAISE EXCEPTION 'FIX-385 backfill incomplete: P000610 (Plaskett) remains on federalId';
  END IF;

  ELSE
    RAISE NOTICE '[FIX-516] 20260525223048 sanity check skipped: seed absent (federal jurisdiction)';
  END IF;
END $$;

COMMIT;
