-- FIX-499 — server-side donor aggregation for the graph group route (House).
--
-- Context: FIX-497 added the partial covering index that made the per-page
-- donation scan cheap (deep page 70s -> 0.2s) and fixed Senate. House still
-- exceeded the route's 8s JS budget and failed closed (donorFetchError). The
-- residual cost was NOT the OFFSET pagination — Step 0 EXPLAIN on prod
-- (2026-06-05) showed the deep OFFSET page is 241ms warm. The cost was VOLUME:
-- the route fetched all 649,252 House donation rows over ~180 sequential pages
-- per 100-member chunk and SUMmed them in JS, then resolved financial_entities
-- for all ~292k distinct donors to filter out individuals.
--
-- Keyset pagination (the originally-planned fix) was measured CATASTROPHICALLY
-- worse, not better: the row-value seek `(to_id,id) > (...)` does not compose
-- with `to_id = ANY(batch)` — the planner can't push it as a start-key into the
-- per-element index scans. Warm, same chunk, same cache:
--   OFFSET deep page: 241ms   KEYSET deep page: 17,634ms  (73x slower)
-- So keyset was dropped entirely.
--
-- This RPC collapses the per-donor SUM and the institutional-only filter into
-- one server-side aggregate — ONE round-trip instead of ~180 pages/chunk plus a
-- ~2,900-chunk financial_entities fan-out. Prod EXPLAIN (2026-06-05), warm:
--   House  (436 members, 649,252 rows): 5,404 institutional donors, ~3.8s
--   Senate (100 members, 304,797 rows): 4,139 institutional donors, ~0.7s
-- Both well under the route's DONOR_FETCH_BUDGET_MS (8s).
--
-- Two shape decisions are load-bearing — DO NOT "simplify" them away:
--   1. `agg AS MATERIALIZED` forces the GROUP BY to run and reduce to ~292k
--      donor rows BEFORE the financial_entities join. Without MATERIALIZED the
--      planner inlines the CTE and joins all 649k raw rows to the 2.45M-row
--      financial_entities table -> 13.8s / statement-timeout. The materialized
--      aggregate-then-join is what keeps it ~1s. (Measured: inlined CTE timed
--      out at 25s; MATERIALIZED = 1.0s.)
--   2. `fe.entity_type <> 'individual'` (NOT `IS DISTINCT FROM`). entity_type is
--      NOT NULL with 0 nulls on prod (2,446,344 rows checked), so `<>` is
--      semantically identical to the route's prior JS check
--      (`info.entityType === 'individual'`) AND gets the fast plan. `IS DISTINCT
--      FROM` is not optimizable the same way and pushed the query to a 15s+ plan.
--   The `NOT ILIKE '%PAC/Committee%'` filter must stay AFTER the aggregation —
--   a bare ILIKE seq-scan over all 2.45M financial_entities is pathological
--   (>25s on prod); applied to the ~292k post-aggregate donor rows it is cheap.
--
-- Mirrors get_official_donors (FIX-097 restore) — SECURITY DEFINER, same grant
-- set — but takes a cohort of official ids and does NOT reference the dropped
-- financial_entities.industry column (sector/industry is resolved separately
-- from entity_tags by the route, for the displayed top-N only).
--
-- Returns EVERY institutional donor (no row cap), so it also fixes the silent
-- FIX-476-class undercount the route had on the official branch: the prior
-- fetchAllRows `maxRows: 50000` ceiling truncated Senate's 304,797-row set to
-- 50,000, so the live "2,480 donors / $40.5M" was a partial result. This RPC
-- returns the complete set (Senate: 4,139 institutional donors).

CREATE OR REPLACE FUNCTION public.get_group_donor_totals(p_official_ids UUID[])
RETURNS TABLE(
  financial_entity_id UUID,
  entity_name         TEXT,
  entity_type         TEXT,
  total_cents         BIGINT,
  member_count        BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH agg AS MATERIALIZED (
    SELECT ec.from_id           AS fid,
           SUM(ec.amount_cents) AS total_cents,
           COUNT(*)             AS member_ct
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND ec.to_id           = ANY(p_official_ids)
    GROUP BY ec.from_id
  )
  SELECT a.fid                  AS financial_entity_id,
         fe.display_name        AS entity_name,
         fe.entity_type         AS entity_type,
         a.total_cents::BIGINT  AS total_cents,
         a.member_ct::BIGINT    AS member_count
  FROM agg a
  JOIN public.financial_entities fe ON fe.id = a.fid
  WHERE fe.entity_type <> 'individual'
    AND fe.display_name NOT ILIKE '%PAC/Committee%'
  ORDER BY a.total_cents DESC;
$$;

-- service_role default statement_timeout is 8s on Pro — a cold-cache aggregate
-- over the 5.18M-row entity_connections can exceed it. Raise the function's own
-- ceiling (per packages/db/CLAUDE.md "Function-level statement_timeout"). 30s is
-- generous headroom over the measured ~3.8s House worst case; the route's own
-- 8s DONOR_FETCH_BUDGET_MS JS race is the real governor and fails the request
-- closed (donorFetchError) long before this fires.
ALTER FUNCTION public.get_group_donor_totals(UUID[]) SET statement_timeout = '30s';

GRANT EXECUTE ON FUNCTION public.get_group_donor_totals(UUID[]) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_group_donor_totals(UUID[]) IS
  'FIX-499 — institutional donor aggregate for the graph group route. SUMs '
  'donation amount_cents per financial_entity donor across a cohort of '
  'officials, excluding individuals and the PAC/Committee placeholder, server-'
  'side in one round-trip. Replaces the route''s page-all-rows-and-SUM-in-JS '
  'path (House: ~180 pages/chunk over 649k rows -> donorFetchError). MATERIALIZED '
  'agg-then-join is load-bearing; see migration header.';
