-- =============================================================================
-- FIX-1118b — rebuild_entity_connections_contracts rejoins the FIX-1117 arm
--             gate. This is the payoff half of FIX-1118: the index shipped in
--             20260901230000, this removes the arm from `disabled_arms`.
--
-- THE MEASUREMENT THAT AUTHORISES THIS. Re-measured on PROD 2026-09-02 00:0x
-- UTC against an idle box (0 non-idle backends), using the exact probe body
-- from ec_arm_source_fingerprint('rebuild_entity_connections_contracts'):
--
--     SELECT count(*), max(updated_at)
--       FROM public.financial_relationships
--      WHERE relationship_type IN ('contract','grant');
--
--     before FIX-1118's index (2026-08-28):   111,575 ms cold / 98,204 ms warm
--     after  FIX-1118's index (2026-09-02):    16,062 ms cold /  4,897 ms warm
--
-- The plan is now what the index was built for — a Parallel Index Only Scan
-- using financial_relationships_contract_grant_updated_at (27 MB), 1,954,478
-- rows per worker, Heap Fetches 323,052, Buffers shared hit=188,395
-- read=43,781 — instead of a Parallel Bitmap Heap Scan paying 3.9M heap
-- fetches. A 6.1x improvement cold, 20x warm.
--
-- 4.9 s warm to skip a 344.6 s arm is a 70:1 ratio. For comparison the gate's
-- other probes run 20–35 ms (six arms), 1,440 ms (stats), 3,365 ms (external,
-- skipping an 899 s arm) and 4,154 ms (votes). Contracts is now the most
-- expensive probe in the set but it is the same order as votes and external,
-- and it is no longer spending prod's daily disk-burst budget (FIX-1107) at a
-- 3.5:1 ratio, which is the objection that put it in `disabled_arms`.
--
-- WHAT THIS ACTUALLY BUYS, AND IT IS NOT MAINLY THE 344.6 s. The contracts arm
-- runs un-gated on every cycle, and its rebuild REWRITES entity_connections.
-- entity_connections is the source of the entity_connection_stats_windows
-- fingerprint, so an un-gated contracts arm re-dirties the stats fingerprint
-- every cycle, which makes the 16-window stats arm (FIX-1115) recur on every
-- cycle instead of only when edges genuinely changed — roughly 1,810 s of reads
-- per cycle for zero output. Gating contracts is what breaks that loop. See
-- FIX-1124, which named the loop but could not close it without this index.
--
-- The source itself has not moved since 2026-08-13 11:09:33 (that is the live
-- max(updated_at) over the contract/grant slice, against 3,908,956 rows), so
-- the arm has rebuilt for nineteen days over a source that never changed.
--
-- FIRST CYCLE AFTER THIS MIGRATION STILL RUNS THE ARM. `disabled_arms` returns
-- NULL from the probe, and a disabled arm therefore never stored a fingerprint
-- — pipeline_state.ec_arm_source_fingerprints->'arms' has ten entries and
-- rebuild_entity_connections_contracts is not one of them. NULL stored means
-- RUN (the FIX-885 fail-open value), so the next cycle runs the arm once and
-- banks its fingerprint; gating begins on the cycle AFTER that. This is
-- expected, not a failed re-gate — do not read the first post-migration cycle
-- as evidence the gate is broken.
--
-- SURGICAL REMOVAL, NOT A RESET. The FIX-1117b migration's own header suggested
-- `value || jsonb_build_object('disabled_arms','[]')`, which would also discard
-- any OTHER arm an operator had disabled in the meantime. This filters the
-- array instead, so only the contracts entry is removed and the escape hatch
-- keeps working for everything else. It is idempotent: re-running it on a
-- database where the arm is already absent is a no-op.
--
-- TO REVERSE (one statement, no migration needed — that is why the switch is
-- data and not code):
--
--     UPDATE public.pipeline_state
--        SET value = jsonb_set(value, '{disabled_arms}',
--                      COALESCE(value->'disabled_arms','[]'::jsonb)
--                      || '["rebuild_entity_connections_contracts"]'::jsonb),
--            updated_at = now()
--      WHERE key = 'ec_arm_source_fingerprints';
--
-- WHY THIS MIGRATION EXISTS AT ALL, GIVEN THE SWITCH IS DATA. The PROD write was
-- performed by scripts/fix1118-regate-contracts-arm.mjs at 2026-09-02 00:1x UTC
-- (that script carries the precondition guard: it refuses unless the FIX-1118
-- index exists AND indisvalid). This migration is NOT that write repeated — it
-- is the fresh-database parity fix. FIX-1117b's migration SEEDS this arm INTO
-- disabled_arms, so without a counter-migration any newly provisioned database
-- replays to a state where contracts is disabled while prod has it enabled.
-- That drift is the thing being prevented here. On an already-re-gated database
-- this migration is a no-op, by construction.
--
-- Cross-ref FIX-1118, FIX-1117, FIX-1117b, FIX-1115, FIX-1124, FIX-1107.
-- =============================================================================

UPDATE public.pipeline_state
   SET value = jsonb_set(
                 value,
                 '{disabled_arms}',
                 COALESCE(
                   (SELECT jsonb_agg(d)
                      FROM jsonb_array_elements_text(
                             COALESCE(value->'disabled_arms', '[]'::jsonb)) AS d
                     WHERE d <> 'rebuild_entity_connections_contracts'),
                   '[]'::jsonb)),
       updated_at = now()
 WHERE key = 'ec_arm_source_fingerprints';

-- Refresh the function comment so the recorded measurement matches reality.
-- The body is unchanged; only the documented cost of the contracts probe moves.
COMMENT ON FUNCTION public.ec_arm_source_fingerprint(text) IS
  'FIX-1117/1117b/1118b — cheap (count, max-timestamp) fingerprint over ONE '
  'entity_connections arm''s own source scope, used by '
  'run_entity_connections_rebuild() to skip an arm whose source has not changed '
  'since that arm''s last successful build. Returns NULL for an unrecognised arm, '
  'for an arm listed in pipeline_state.ec_arm_source_fingerprints.disabled_arms, '
  'or on any probe failure — and NULL means RUN. The gate fails open in every '
  'direction (FIX-885), and the disable switch reuses that same path rather than '
  'adding a second one. Scope is per arm and deliberately BROADER than the arm''s '
  'own filter wherever they differ. The four financial_relationships arms MUST be '
  'scoped by relationship_type or a donation write would move all four every day; '
  'their labels come from the arm bodies and were checked against pg_enum (the '
  'FIX-073 rule). Measured on PROD: oversight 46 ms, gifts/holds/lobbying/'
  'cosponsors/appointments/investigation 20-35 ms, stats 1,440 ms, external '
  '3,365 ms (skipping an 899 s arm), votes 4,154 ms, and contracts 4,897 ms warm '
  '/ 16,062 ms cold as of 2026-09-02 — down from 98,204 ms warm once FIX-1118 '
  'built financial_relationships_contract_grant_updated_at, which is what let '
  'FIX-1118b take that arm back out of disabled_arms.';

NOTIFY pgrst, 'reload schema';
