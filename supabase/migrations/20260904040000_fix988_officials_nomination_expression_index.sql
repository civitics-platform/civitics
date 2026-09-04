-- FIX-988 — an expression index for the per-nominee congress_nomination_id probe.
--
-- WHAT IS SLOW
--
-- packages/data/src/pipelines/agency-leadership/index.ts runs, once per
-- confirmed nominee in the weekly agency-leadership pass:
--
--     .filter("source_ids->>congress_nomination_id", "eq", nominationId)
--
-- `officials` carries 15 indexes and not one of them covers any `source_ids`
-- expression, so every probe is a full sequential scan. Measured on prod
-- 2026-09-04:
--
--     Seq Scan on officials  (cost=0.00..3149.41 rows=186)
--       Rows Removed by Filter: 37294
--       Buffers: shared hit=2590
--     Execution Time: 391.016 ms
--
-- ~8.2 s per weekly run in aggregate. Small in absolute terms; it is in this
-- migration because it is one line and the expression is the same one the
-- nominee-matching path will keep probing as the nominee set grows.
--
-- WHY THE PARTIAL PREDICATE IS `IS NOT NULL` AND NOT `source_ids ? 'k'`
--
-- The obvious partial predicate is `WHERE source_ids ? 'congress_nomination_id'`
-- — it reads as the natural "only rows that have this key". It does not work.
-- Postgres will only use a partial index when it can PROVE the query's
-- predicate implies the index's, and it has no rule taking `source_ids->>'k' =
-- $1` to `source_ids ? 'k'`: those are different operators over different
-- expressions. Measured on the local clone with both candidates built:
--
--     WHERE (source_ids->>'congress_nomination_id') IS NOT NULL
--       → Bitmap Index Scan on probe_notnull, 1 buffer, 0.165 ms
--     WHERE source_ids ? 'congress_nomination_id'   (the only index present)
--       → Seq Scan on officials, 2,460 buffers, 9.645 ms   -- index unused
--
-- `IS NOT NULL` IS implied by `expr = $1`, because `=` is strict, so the prover
-- gets there and the index is usable. Keep the predicate matched to the
-- expression it indexes.
--
-- SIZE / LOCK
--
-- `officials` is 37,294 rows / 42 MB on prod and the qualifying subset is tiny
-- (146 rows on the local clone), so this is a sub-second plain CREATE INDEX.
-- No CONCURRENTLY: the brief ACCESS SHARE-blocking window on a 42 MB table is
-- not worth the two-phase build and the INVALID-index failure mode.
--
-- FIX-761 CHECK: the promotion surface does NOT probe this expression. A
-- repo-wide grep for `congress_nomination_id` (2026-09-04) finds it only in
-- agency-leadership/index.ts (the probe, plus three writes) and in
-- scripts/investigate-officials-casing-dupes.ts (a diagnostic that enumerates
-- source_ids keys rather than filtering on one). This index has exactly one
-- reader today.

CREATE INDEX IF NOT EXISTS officials_source_ids_congress_nomination_idx
  ON public.officials ((source_ids ->> 'congress_nomination_id'))
  WHERE (source_ids ->> 'congress_nomination_id') IS NOT NULL;

COMMENT ON INDEX public.officials_source_ids_congress_nomination_idx IS
  'FIX-988: serves the per-nominee probe in the weekly agency-leadership pass '
  '(source_ids->>congress_nomination_id = $1), which was a 391 ms seq scan per '
  'nominee on prod. Partial predicate is IS NOT NULL, not the jsonb ? operator: '
  'the planner can prove IS NOT NULL from a strict =, and cannot prove ?.';
