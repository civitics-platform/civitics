-- =============================================================================
-- FIX-919 — get_financial_entity_naics() aggregates the contractor (to_id) side
-- =============================================================================
--
-- THE BUG. The function aggregated fr.from_id WHERE from_type='financial_entity',
-- but USASpending writes agency → financial_entity (usaspending-bulk/writer.ts),
-- so every NAICS-bearing contract has the contractor on the to_id side. It
-- returned [] on both envs since inception, and the tagger's NAICS pass
-- (rules.ts buildNaicsIndustryTags) never emitted a row.
--
-- THE FIX. Both sides, one heap pass: each contract/grant row with a NAICS code
-- contributes its to_id when to_type = 'financial_entity' and its from_id when
-- from_type = 'financial_entity'. This is exactly the UNION ALL of the to_id arm
-- and the kept from_id arm (FE-sourced rows; 0 on the clone). It is written as a
-- LATERAL VALUES over ONE scan because the two-arm UNION ALL read the same
-- contract heap twice. Measured on the clone (2026-09-27, cold: container
-- restart + VM page cache dropped, max_parallel_workers_per_gather = 0):
--
--   two arms (UNION ALL)   585,374 buffers read   39.9 s
--   one pass (this body)   287,584 buffers read   33.2 s   → 63,419 entities
--
-- On a 256 MB-shared_buffers prod, the second arm's 2.2 GB re-read would come
-- off disk rather than the clone's page cache, so the halved read is the part
-- that matters. Plan: Bitmap Heap Scan on financial_relationships via
-- financial_relationships_contract_grant_updated_at, 284,211 heap blocks — the
-- contract slice itself; no index carries metadata->>'naics_code', so the heap
-- read is the floor for this definition.
--
-- VEHICLE (cc-166 read 6). Clone cold 33.2 s × 1.4 (cc-158's clone→prod factor)
-- = 46.6 s, under the 180 s line → the function alone, no index. Its only
-- runtime caller is the nightly enrichment tail (rules.ts, rollupJsonbDirect:
-- direct pg, session statement_timeout 90min, inside a 90-min GHA job).
--
-- WHAT IT WRITES (by the nightly, not here). The tagger clears and rewrites
-- every generated_by='rule' industry row in one transaction, so tonight's tail
-- is the backfill. Projected from the clone's recipients against prod's
-- current tags: 63,419 recipients → 44,980 map to an industry (18,439 fall in
-- the six unmapped sectors 23/56/61/71/72/81); 38,970 become new single-tag
-- entities, 2,339 agree with an existing tag (deduped), 3,671 disagree and become
-- multi-tag, ranked by primary_industry_tag() (FIX-918, landed first). NAICS wins
-- 3,621 of those, and an ai tag above 0.85 wins 50. All 42,641 are corporations with ZERO
-- donations to officials, so no donation surface moves. The contract surfaces do.
--
-- Signature, return shape and SET clauses are the prod definition's
-- (SECURITY DEFINER, search_path public, pg_temp; FIX-1128 left it with no
-- statement_timeout of its own). Only the FROM/WHERE changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_financial_entity_naics()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'entity_id',  n.entity_id,
           'naics_code', n.naics_code
         )), '[]'::jsonb)
  FROM (
    -- FIX-919: the financial_entity on EITHER side of a contract/grant — the
    -- contractor is to_id (agency → financial_entity); from_id is kept for
    -- FE-sourced rows. One heap pass; see the header for why not UNION ALL.
    SELECT side.entity_id,
           MIN(fr.metadata->>'naics_code') AS naics_code
    FROM public.financial_relationships fr
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN fr.to_type   = 'financial_entity' THEN fr.to_id   END),
      (CASE WHEN fr.from_type = 'financial_entity' THEN fr.from_id END)
    ) AS side(entity_id)
    WHERE fr.relationship_type IN ('contract', 'grant')
      AND (fr.to_type = 'financial_entity' OR fr.from_type = 'financial_entity')
      AND fr.metadata->>'naics_code' IS NOT NULL
      AND side.entity_id IS NOT NULL
    GROUP BY side.entity_id
  ) n;
$function$;
