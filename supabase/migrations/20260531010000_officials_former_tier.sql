-- FIX-249: add 'former' tier to officials + one-shot backfill from is_active.
--
-- Widens the tier CHECK (added by 20260510000007_official_tier.sql, which only
-- allowed 'elected' | 'candidate') to also accept 'former'. 'former' is the
-- semantic refinement underneath FIX-457's is_active-keyed Former badge: it is
-- set in lockstep whenever is_active goes false (the congress pipeline's
-- reconciliation pass, FIX-409, writes both together).
--
-- is_active stays the operational/display signal (FIX-457 untouched). tier
-- 'former' never contradicts it — every 'former' row is also is_active=false.
--
-- Backfill is keyed off is_active, NOT term_end: officials.ts hardcodes
-- term_end='2027-01-03' (House) / NULL (Senate), so a term_end<CURRENT_DATE
-- backfill would be unreliable. The UPDATE only touches already-inactive rows,
-- so it can never mislabel a sitting official.

ALTER TABLE public.officials
  DROP CONSTRAINT IF EXISTS officials_tier_check;

ALTER TABLE public.officials
  ADD CONSTRAINT officials_tier_check
    CHECK (tier IN ('elected', 'candidate', 'former'));

UPDATE public.officials
   SET tier = 'former'
 WHERE is_active = false
   AND tier = 'elected';
