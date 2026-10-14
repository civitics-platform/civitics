-- 20261014010000 — FIX-1297, FIX-1293: financial_relationships_donation_updated_at,
-- the donation-types updated_at partial index (the TWIN of an out-of-band CIC).
--
-- WHAT: one partial btree over the donation-type rows of financial_relationships,
-- keyed (updated_at):
--
--   WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose')
--
-- WHY: three readers ask FR for donation-type rows by updated_at, and until now
-- the only updated_at index was the unpartial financial_relationships_updated_at,
-- with relationship_type as a Filter:
--
--   rebuild_ec_donations_incr_prepare  20260903010000:2562-2564  the MAX
--                                      20260903010000:2577-2582  the dirty INSERT's range
--   donor_rollup_rebuild_bulk          20261009030000:1726-1728  the MAX
--   get_ec_crawl_health                20261010030000:86-94      the tile's bounded count
--
-- When a non-donation row sits at the head of _updated_at (the 10-08 USASpending
-- contract rewrite, FIX-1291), the MAX walks backward through every one of them
-- before it reaches a donation row. Measured on prod 10-09..10-11: ec-crawl's
-- prepare cancelled at 1,800 s, its retry 1,280 s; every caught-up exit of
-- ec-crawl and donor-rollup 361-399 s (0.1-0.2 s through 10-08); the */30 status
-- tile's count cancelled at service_role's 8 s. With the type in the PREDICATE
-- the MAX is `Index Only Scan Backward` over donation rows only, whatever lands
-- above it, so the FIX-1297 stop-gap (one donation row re-stamped to the head,
-- cc-218/cc-217) is retired: no re-stamp after this. The enum stays in the
-- predicate, not the key: enum_eq is not leakproof (cc-158 §2 A, as FIX-1217).
--
-- Not dropped: the unpartial _updated_at stays (fe-crawl's and donor-party's
-- type-blind slices read it). donor_rollup_rebuild_bulk's dirty set keeps
-- _donor_rollup_dirty_idx (its to_type/from_type terms; cc-220 (d)).
--
-- HOW IT GOT TO PROD: built CONCURRENTLY out-of-band by
-- scripts/fix1297-build-fr-donation-updated-at-index.mjs under a FIX-950 claim
-- (cc-220): 2026-10-14 00:42:21Z -> 00:43:59Z, 97.6 s, 75,169,792 B,
-- indisvalid = true. `supabase db push` wraps each migration in a transaction, so
-- CIC cannot run here, and a plain CREATE INDEX would hold SHARE on a 15.6M-row
-- table for the build. This file is therefore a no-op on prod (IF NOT EXISTS)
-- and the real build for local / any rebuilt-from-zero environment. It was
-- written only after the read-back: pushed before the CIC, it would have built
-- BLOCKING (rule 197). The clone rehearsal built it in 62.8 s, 46,743,552 B.
--
-- The guard refuses an INVALID leftover: IF NOT EXISTS would keep it.

DO $$
DECLARE
  v_valid boolean;
BEGIN
  SELECT i.indisvalid INTO v_valid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'financial_relationships_donation_updated_at'
     AND c.relnamespace = 'public'::regnamespace;
  IF v_valid IS FALSE THEN
    RAISE EXCEPTION '[fix1297] financial_relationships_donation_updated_at exists but is INVALID — '
      'IF NOT EXISTS would keep it. DROP INDEX CONCURRENTLY it and rebuild with '
      'scripts/fix1297-build-fr-donation-updated-at-index.mjs before pushing this migration.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS financial_relationships_donation_updated_at
  ON public.financial_relationships (updated_at)
  WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose');

COMMENT ON INDEX public.financial_relationships_donation_updated_at IS
  'FIX-1297, FIX-1293 — partial index over the donation-type rows of '
  'financial_relationships, keyed (updated_at). Readers: '
  'rebuild_ec_donations_incr_prepare (20260903010000:2562-2564 the MAX, :2577-2582 '
  'the dirty range), donor_rollup_rebuild_bulk (20261009030000:1726-1728 the MAX), '
  'get_ec_crawl_health (20261010030000:86-94 the bounded count). Makes the MAX one '
  'probe whatever non-donation landing sits above it (10-09..10-11: 361-399 s '
  'caught-up exits, a 1,800 s cancel + 1,280 s retry, the 8 s tile). The enum is in '
  'the predicate, not the key (enum_eq is not leakproof; cc-158 §2). Built '
  'CONCURRENTLY out-of-band by scripts/fix1297-build-fr-donation-updated-at-index.mjs '
  'on 2026-10-14 00:42:21Z-00:43:59Z, 75,169,792 B, 97.6 s; no-op here on prod.';
