-- 20260525053643_norton_dc_delegate_jurisdiction.sql
-- FIX-C / FIX-377: Eleanor Holmes Norton (DC, bioguide N000147) is also
-- misrouted to the 'United States' umbrella jurisdiction on prod. Local
-- already had her correctly at the DC district jurisdiction (fips=11,
-- type='district') because openstates seeded DC there. Prod's congress
-- ingest wrote her to federalId before the OpenStates DC pass landed.
--
-- One-shot UPDATE only fires if she's currently at the federal umbrella.
-- Idempotent on re-run; safe locally where she's already correct.
--
-- FIX-516 (2026-06-11, authorized edit): guarded with a seed-presence check so
-- a from-zero replay skips with a NOTICE instead of the '[FIX-377] DC district
-- jurisdiction not found' EXCEPTION. Recorded as applied on both envs —
-- replay-only effect.

DO $$
DECLARE
  v_federal_id uuid;
  v_dc_id      uuid;
  v_updated    int;
BEGIN
  -- FIX-516 replay-from-zero guard — seed-presence check; body unchanged.
  IF EXISTS (SELECT 1 FROM jurisdictions WHERE fips_code = '11' AND type = 'district') THEN

  SELECT id INTO v_federal_id FROM jurisdictions WHERE fips_code='00' AND type='country';
  SELECT id INTO v_dc_id      FROM jurisdictions WHERE fips_code='11' AND type='district';

  IF v_dc_id IS NULL THEN
    RAISE EXCEPTION '[FIX-377] DC district jurisdiction (fips=11) not found';
  END IF;

  UPDATE officials
     SET jurisdiction_id = v_dc_id,
         updated_at      = now()
   WHERE source_ids->>'congress_gov' = 'N000147'
     AND jurisdiction_id = v_federal_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RAISE NOTICE '[FIX-377] Norton re-routed: % row(s)', v_updated;

  ELSE
    RAISE NOTICE '[FIX-516] 20260525053643 skipped: seed absent (DC district jurisdiction, fips=11)';
  END IF;
END $$;
