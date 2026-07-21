-- =============================================================================
-- FIX-872 — Document sector-affinity as donation-recipients-only BY DESIGN.
--
-- FIX-872 was filed as a "coverage gap": IE-only officials (385 prod / 824 local
-- — ie_support/ie_oppose FR rows but zero donations) never receive a sector-
-- affinity rollup, because backfill_official_sector_affinity_rollup() sources its
-- work-list from official_donor_totals (donation-only, FIX-869) and the incremental
-- refresh keys off the donation dirty set.
--
-- The premise that this is a BUG was reviewed and rejected (verified on local +
-- prod 2026-07-21): sector_affinity_rebuild_officials()'s own aggregation filters
-- `relationship_type = 'donation'` ONLY — it does NOT aggregate ie_support/
-- ie_oppose (the IN ('donation','ie_support','ie_oppose') filter the FIX-869
-- session saw sits in the ADJACENT donor_rollup_rebuild_recipients() MV block of
-- migration 20260715010000, not the sector-affinity helper). Widening the work-list
-- would enroll officials who produce zero rows.
--
-- DECISION (FIX-872): sector affinity is donation-recipients-only, deliberately.
-- The surface is donation-only end-to-end (route header, live fallback, rebuild
-- helper, rollup semantics), and the platform's locked IE rule (IE ≠ donation;
-- shown separately as "Independent support"; ie_oppose never in Top Donors) makes
-- IE money — especially opposition money — wrong for a "which sectors fund this
-- official" chart. An IE-only official correctly returns an empty sector-affinity
-- payload (sectors: [], totalCents: 0), served by the route's per-entity miss
-- fallback — NOT a 500.
--
-- This migration is COMMENT-ONLY — no behavior change, no function redefinition.
-- The route header comment carries the same note (apps/civitics/app/api/graph/
-- sector-affinity/route.ts).
-- =============================================================================

COMMENT ON FUNCTION public.sector_affinity_rebuild_officials(uuid[]) IS
  'FIX-777 — delete + re-aggregate official_sector_affinity_rollup for a set of '
  'recipients (per-(official, industry) dollars + distinct-donor count; single '
  'smallest tag per donor, untagged → ''Untagged''). No COMMIT: the chunked '
  'backfill commits per chunk; donor_rollup_rebuild_recipients() calls it inside '
  'its own chunk txn. '
  'FIX-872 — SCOPE: donation-only BY DESIGN. The per_donor CTE filters '
  'relationship_type=''donation'' only; ie_support/ie_oppose are intentionally '
  'excluded, so an official with only independent-expenditure money (zero '
  'donations) receives no sector-affinity rows. Deliberate — the surface answers '
  '"which sectors FUND this official" (donations); IE money (especially ie_oppose, '
  'spent AGAINST a candidate) is shown separately as "Independent support" and is '
  'wrong for a funding chart (locked IE≠donation product rule). IE-only officials '
  'being absent is not a coverage gap.';

COMMENT ON PROCEDURE public.backfill_official_sector_affinity_rollup() IS
  'FIX-777 — chunked (500 officials/chunk, COMMIT each) one-shot bootstrap of '
  'official_sector_affinity_rollup. Memory-bounded. Idempotent. Run over direct-pg '
  'per env; the incremental refresh (donor_rollup_rebuild_recipients block) keeps '
  'it fresh thereafter. FIX-869 — work-list sourced from official_donor_totals '
  '(donation-only), set-equal to the old whole-FR-table scan. '
  'FIX-872 — SCOPE: donation-recipients-only BY DESIGN. Officials with only '
  'ie_support/ie_oppose money and zero donations are intentionally outside the '
  'work-list (they are absent from official_donor_totals AND the underlying '
  'sector_affinity_rebuild_officials aggregation is donation-only). Their absence '
  'is deliberate, not a gap — IE ≠ donation; IE money is surfaced separately as '
  '"Independent support". See FIX-872.';
