-- =============================================================================
-- FIX-1118 — make the contracts-arm source fingerprint an index-only probe, so
-- rebuild_entity_connections_contracts can rejoin the FIX-1117 arm gate.
--
-- BACKGROUND. FIX-1117 gates each entity_connections rebuild arm on a cheap
-- "source fingerprint" (n=<count>;t=<max(updated_at)>): if the fingerprint has
-- not moved since the arm last ran, the arm is skipped. Nine of the ten arms
-- probe in milliseconds — oversight 46 ms, gifts/holds/lobbying/cosponsors/
-- appointments/investigation 20–35 ms, the entity_connections stats fingerprint
-- 1,440 ms, external_relationships 3,365 ms, votes 4,154 ms.
--
-- One did not. rebuild_entity_connections_contracts measured 111,575 ms cold and
-- 98,204 ms warm on prod 2026-08-28, so it was never a cold-cache artifact. Its
-- scope is financial_relationships WHERE relationship_type IN ('contract','grant')
-- = ~3.9M rows inside a 12 GB / 14.5M-row table, and the plan was a Parallel
-- Bitmap Heap Scan driven by financial_relationships_type: the bitmap index scan
-- is cheap, the 3.9M heap fetches are not. Dropping max(updated_at) did not help
-- — count(*) alone measured 98,692 ms with the identical plan — because no
-- existing index could serve it index-only: financial_relationships_derivation
-- leads with relationship_type but does not carry updated_at, and FR's visibility
-- map is too degraded for an index-only scan to be chosen anyway (cf. FIX-1034,
-- FIX-943, FIX-884).
--
-- Spending 98 s to avoid a 344.6 s arm is a net win but a poor ratio, and it
-- spends the exact resource — prod's daily disk burst budget, FIX-1107 — that
-- the FIX-1111 line of work exists to protect, on every cycle, up to four times
-- a day. So FIX-1117 shipped a `disabled_arms` escape in
-- pipeline_state.ec_arm_source_fingerprints and put this arm in it: a disabled
-- arm returns a NULL fingerprint, which is the gate's fail-open value, so the
-- arm ran every cycle exactly as before. Nothing was broken; one arm was un-gated.
--
-- THE SECOND-ORDER COST (the reason this is a loop-breaker, not just a saving).
-- Because the contracts arm ran un-gated on EVERY cycle, it rewrote
-- entity_connections every cycle, which re-dirtied the
-- entity_connection_stats_windows fingerprint every cycle, which forced the
-- expensive 16-window stats arm to recur on every cycle rather than only when
-- edges genuinely changed. Measured on prod 2026-09-01: the 09:45 cycle spent
-- 411 s in rebuild_entity_connections_contracts, and the 10:00 cycle then spent
-- 1,810 s in a single entity_connection_stats_windows window that inserted ZERO
-- rows. Gating contracts breaks that loop at its source.
--
-- THE INDEX. 3,908,956 matching rows; the FIX-1118 bullet estimated ~90 MB but
-- the built index measured **27 MB** on prod, roughly a third of the estimate.
-- The partial predicate matches the fingerprint query's
-- `relationship_type IN ('contract','grant')` exactly, so the planner uses it
-- directly. Measured on prod immediately after the build:
--
--   max(updated_at)  ->  Index Only Scan Backward, Limit cost=0.43..0.54.
--                        O(1). This half is fully fixed.
--   count(*)         ->  Parallel Index Only Scan (the 3.9M-row Bitmap Heap Scan
--                        is gone from the plan) BUT still minutes of wall clock,
--                        stalled on IO/DataFileRead.
--
-- The count(*) residual is NOT a plan problem and NOT a cold-cache artifact: it
-- is heap fetches. An index-only scan may only skip the heap for pages the
-- VISIBILITY MAP marks all-visible, and a heap page loses that mark if ANY tuple
-- on it is dead. financial_relationships carries ~188k dead tuples, has never
-- been autovacuumed (last_autovacuum IS NULL), and is vacuumed only by the weekly
-- jobid 38 fr-vacuum-analyze. So the index makes the scan POSSIBLE and the
-- visibility map decides whether it is actually cheap — the same coupling as
-- FIX-884 (0.9% all-visible -> 34,534 heap fetches, 20.5s of a 22.1s query) and
-- the FIX-943 bulk-rewrite vacuum rule.
--
-- CONSEQUENCE FOR SEQUENCING: this index is necessary but not sufficient. The
-- arm should be re-gated only once the count(*) half is also cheap, i.e. after a
-- VACUUM of financial_relationships has refreshed its visibility map. Re-gating
-- while count(*) still costs minutes would reinstate on every cycle the exact
-- cost FIX-1118 exists to remove.
--
-- BUILD STRATEGY — out-of-band, per repo precedent (FIX-883 / FIX-986). A plain
-- CREATE INDEX takes ACCESS EXCLUSIVE on a 12 GB table and CREATE INDEX
-- CONCURRENTLY cannot run inside a migration transaction, so the index is
-- pre-built CONCURRENTLY against prod in a supervised window BEFORE this
-- migration is pushed. The IF NOT EXISTS then makes the prod push a no-op and
-- this file remains the durable record + the local/rebuild path.
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_contract_grant_updated_at
--     ON public.financial_relationships (updated_at)
--     WHERE relationship_type IN ('contract','grant');
-- Applied CONCURRENTLY to prod 2026-09-01 (supervised); indisvalid confirmed.
--
-- The companion data change — removing 'rebuild_entity_connections_contracts'
-- from pipeline_state.ec_arm_source_fingerprints -> disabled_arms — is data, not
-- schema, so it is NOT in this migration. It ships as
-- scripts/fix1118-regate-contracts-arm.mjs and must be run against each
-- environment separately (CLAUDE.md, "Data-state changes vs schema changes").
-- =============================================================================

CREATE INDEX IF NOT EXISTS financial_relationships_contract_grant_updated_at
  ON public.financial_relationships (updated_at)
  WHERE relationship_type IN ('contract', 'grant');

COMMENT ON INDEX public.financial_relationships_contract_grant_updated_at IS
  'FIX-1118 — partial index on financial_relationships(updated_at) over the '
  '~3.9M contract/grant rows. Exists to make the FIX-1117 source fingerprint '
  'for rebuild_entity_connections_contracts an index-only probe (max(updated_at) '
  'becomes an O(1) backward scan, count(*) an index-only scan over ~90MB) '
  'instead of a 3.9M-row Parallel Bitmap Heap Scan over a 12GB table '
  '(prod: 98s -> ms-class). Gating that arm also stops it rewriting '
  'entity_connections every cycle, which is what forced the 16-window '
  'entity_connection_stats_windows arm to re-run on every cycle. '
  'Built CONCURRENTLY out-of-band; see the header of the migration that '
  'creates it. Cross-ref FIX-1117, FIX-1111, FIX-1107, FIX-1034, FIX-943.';
