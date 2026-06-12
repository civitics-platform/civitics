-- =============================================================================
-- FIX-389 — backfill DC jurisdictions after FIX-383 silent-degradation window
--
-- During 2026-05-09 → 2026-05-25, seedJurisdictions() returned undefined for
-- 'DC' because of a PGRST116 multi-match (FIX-383 fix narrowed the existence
-- check by parent_id). Two callers (congress/officials, fec-bulk/candidates)
-- fell back to federalId, misattributing DC officials/candidates to the
-- federal jurisdiction.
--
-- This migration restores DC attribution for:
--   - Eleanor Holmes Norton (DC at-large delegate, id af77d55d-…)
--   - 34 FEC candidate rows with metadata.state='DC'
--
-- Both target groups are precisely identified — no ambiguity, no joins
-- against external data. Idempotent: WHERE clauses no-op if already correct.
--
-- FIX-516 (2026-06-11, authorized edit): the sanity-check DO is guarded with a
-- seed-presence check (the env-specific jurisdiction UUIDs this file targets).
-- The plain UPDATEs need no guard — on a from-zero replay neither UUID exists,
-- so both match 0 rows. Recorded as applied on both envs — replay-only effect.
-- =============================================================================

BEGIN;

-- (1) Norton — single row. Only flips if she's currently on federalId.
UPDATE public.officials
SET jurisdiction_id = '4d2aac54-6d83-4736-b446-2970e98439f5'
WHERE id = 'af77d55d-d593-4a29-a5fd-6648992fa463'
  AND jurisdiction_id = 'eb075dd5-038f-4b21-82f7-30f5c9e1d49a';

-- (2) 34 FEC candidate rows currently misattributed to federal but tagged
--     as DC in their FEC metadata.
UPDATE public.officials
SET jurisdiction_id = '4d2aac54-6d83-4736-b446-2970e98439f5'
WHERE jurisdiction_id = 'eb075dd5-038f-4b21-82f7-30f5c9e1d49a'
  AND metadata->>'state' = 'DC'
  AND source_ids ? 'fec_candidate_id';

-- Sanity check: confirm 0 DC-tagged FEC candidate rows remain on federalId.
DO $$
DECLARE
  remaining INT;
BEGIN
  -- FIX-516 replay-from-zero guard — seed-presence check; body unchanged.
  IF EXISTS (SELECT 1 FROM public.jurisdictions
              WHERE id IN ('4d2aac54-6d83-4736-b446-2970e98439f5',
                           'eb075dd5-038f-4b21-82f7-30f5c9e1d49a')) THEN

  SELECT COUNT(*) INTO remaining FROM public.officials
  WHERE jurisdiction_id = 'eb075dd5-038f-4b21-82f7-30f5c9e1d49a'
    AND metadata->>'state' = 'DC'
    AND source_ids ? 'fec_candidate_id';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'FIX-389 backfill incomplete: % rows remain on federalId', remaining;
  END IF;

  ELSE
    RAISE NOTICE '[FIX-516] 20260525211524 sanity check skipped: seed absent (prod-era jurisdiction UUIDs not present)';
  END IF;
END $$;

COMMIT;
