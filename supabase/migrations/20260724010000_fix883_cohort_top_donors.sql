-- =============================================================================
-- FIX-883 — get_cohort_top_donors(): one server-side aggregation to replace the
-- group route's live donor fan-out.
--
-- /api/graph/group?entity_type=official serves gb-materialized cohorts from
-- group_donor_rollup (FIX-500). Every OTHER official cohort — ad-hoc/custom
-- groups, state-narrowed gb groups (FIX-495), legacy state/party groups, and any
-- gb whose rollup row is a miss — falls through to a live path that:
--   1. pages EVERY entity_connections donation row for the members (individual
--      long tail included) via fetchAllRows under an 8s JS budget, 50k ceiling;
--   2. resolves each distinct donor's name/entity_type/sector through 100-id
--      financial_entities chunks + fetchIndustryTagsByEntityId;
--   3. only THEN discards individuals JS-side and takes the top-N institutional.
-- Individuals are ~87% of the rows fetched and are thrown away.
--
-- Senators average ~1,433 donation edges each (local, stale clone: p50 79,
-- p90 3,140, max 38,617), so a small cohort containing one whale means 30-50+
-- sequential pages inside the budget and a stage-2 fan-out of dozens-to-hundreds
-- of concurrent PostgREST chunk queries. Measured on governingBody=senate&state=TX
-- (2 members, 34,285 edges): LOCAL donorFetchError:true at 15.8s, PROD the same
-- at 8.97s — the FIX-497 fail-open firing on a request-path live aggregation.
-- A repeat local run surfaced stage 2 failing outright ("financial_entities chunk
-- error: TypeError: fetch failed", 20.7s).
--
-- This function does the whole thing in ONE round trip against the FIX-497
-- partial covering index entity_connections_donation_to_official_idx
-- (to_id, id) INCLUDE (from_id, amount_cents). Measured local (stale clone):
--   TX senators      2 members /   34k edges → 256ms
--   legacy state=CA  1000 mem  /   95k edges → 733ms
--   legacy party=dem 1000 mem  /  152k edges → 843ms
--
-- SOURCE CHOICE — deliberately entity_connections, NOT official_donor_rollup_mv.
-- The MV (FIX-518/704/809/832) looks like a fit — per-official ranked donors with
-- name/entity_type/industry already resolved — but its `rank` is computed over
-- ALL donors INCLUDING individuals, so `rank <= 200 AND entity_type <> 'individual'`
-- keeps only the institutional donors that outrank the individual long tail.
-- Measured on the TX cohort: 196 institutional donors / $1.09M top-25, against the
-- live path's 1,126 / $16.9M — a 94% understatement with 9 of 25 donors in common.
-- Ted Cruz alone carries 174 individuals in his top-200, leaving 26 institutional
-- slots. Independently, the MV is built from financial_relationships ($32.0M for
-- Cruz) while this route reads entity_connections ($41.1M) — a 28% source gap.
-- Reading the MV here would replace an honest "donor data unavailable" flag with a
-- confident wrong number. Recorded so it is not proposed again for cohort display.
--
-- Filters mirror the live path EXACTLY, so donorCount / totalDonatedUsd / the
-- top-N list are identical to what a successful live run produced:
--   * connection_type='donation', to_type='official', from_type='financial_entity'
--   * INNER JOIN financial_entities  (live: `if (!info) continue`)
--   * entity_type <> 'individual'    (live: institutional money only)
--   * display_name not matching /PAC\/Committee/i — the aggregate placeholder rows.
--     COALESCE'd so a NULL display_name is KEPT, matching JS `.test(null)` = false;
--     the route renders those as "Unknown" exactly as the rollup branch does.
--   * member_count = COUNT(*) — entity_connections is unique per
--     (from_type, from_id, to_type, to_id, connection_type), so one row per
--     (donor, official) pair, which is what the live path's `memberCount += 1` counts.
--
-- Sector resolution joins entity_tags AFTER the LIMIT (≤100 probes, not one per
-- distinct donor) and takes the deterministic smallest tag per donor — the same
-- DISTINCT ON (entity_id) ORDER BY tag pick FIX-704 standardized on, and a strict
-- improvement over fetchIndustryTagsByEntityId's arbitrary first-row-wins.
--
-- Returns ONE jsonb object, never SETOF: no PostgREST max_rows cap to reason
-- about and no pagination, regardless of cohort size (reference-postgrest-rpc-row-cap).
--
-- NOT SECURITY DEFINER — the only caller is the route's admin (service_role)
-- client, which bypasses RLS already; INVOKER keeps the blast radius minimal.
-- No in-function statement_timeout: prod's service_role role default (8s) plus
-- the route's own withDbTimeout budget already bound this, and a pathological
-- cohort surfacing 57014 is exactly the FIX-497 fail-closed path (the route
-- reports it as donorFetchErrorCode) rather than a silent wrong answer.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_cohort_top_donors(
  p_official_ids uuid[],
  p_limit        int DEFAULT 25
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH agg AS (
    -- Index-only scan on entity_connections_donation_to_official_idx.
    SELECT ec.from_id                   AS donor_id,
           SUM(ec.amount_cents)::bigint AS total_cents,
           COUNT(*)::int                AS member_count
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND ec.to_id = ANY (p_official_ids)
    GROUP BY ec.from_id
  ),
  inst AS (
    -- Institutional money only. INNER JOIN drops donors with no
    -- financial_entities row, matching the live path's `if (!info) continue`.
    SELECT a.donor_id, a.total_cents, a.member_count,
           fe.display_name AS donor_name,
           fe.entity_type
    FROM agg a
    JOIN public.financial_entities fe ON fe.id = a.donor_id
    WHERE fe.entity_type <> 'individual'
      AND COALESCE(fe.display_name, '') !~* 'PAC/Committee'
  ),
  top_n AS (
    SELECT * FROM inst
    -- donor_id breaks ties so the list is stable across identical calls.
    ORDER BY total_cents DESC, donor_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 0), 100)
  ),
  tagged AS (
    SELECT t.*, ind.display_label AS sector
    FROM top_n t
    LEFT JOIN LATERAL (
      SELECT et.display_label
      FROM public.entity_tags et
      WHERE et.entity_type  = 'financial_entity'
        AND et.tag_category = 'industry'
        AND et.entity_id    = t.donor_id
      ORDER BY et.tag
      LIMIT 1
    ) ind ON true
  )
  SELECT jsonb_build_object(
    'donors', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'donor_id',     tg.donor_id,
                 'donor_name',   tg.donor_name,
                 'entity_type',  tg.entity_type,
                 'sector',       tg.sector,
                 'total_cents',  tg.total_cents,
                 'member_count', tg.member_count
               )
               ORDER BY tg.total_cents DESC, tg.donor_id
             )
      FROM tagged tg
    ), '[]'::jsonb),
    -- Distinct institutional donors across the WHOLE cohort (live: donorMap.size).
    'donor_count', (SELECT COUNT(*)::bigint FROM inst),
    -- Sum over the RETURNED donors only (live: topDonors.reduce). Keeping this
    -- shown-only preserves the existing meta.totalDonatedUsd contract exactly.
    'shown_cents', COALESCE((SELECT SUM(total_cents)::bigint FROM top_n), 0)
  );
$$;

COMMENT ON FUNCTION public.get_cohort_top_donors(uuid[], int) IS
  'FIX-883 — top-N institutional donors for an arbitrary cohort of officials, as '
  'ONE jsonb object {donors[], donor_count, shown_cents}. Replaces the '
  '/api/graph/group official-branch live path''s paged entity_connections fan-out '
  '+ per-donor financial_entities/entity_tags chunk resolution (8s budget blown by '
  'any cohort containing a whale — FIX-497 flag). Aggregates entity_connections '
  'with the live path''s exact filters, so donorCount/totalDonatedUsd/top-N are '
  'unchanged. Deliberately NOT official_donor_rollup_mv: that MV ranks over ALL '
  'donors including individuals, so rank<=200 drops ~86% of institutional donors '
  'for whale officials (measured 94% total understatement), and it is sourced from '
  'financial_relationships rather than entity_connections. Route-gated: '
  'service_role only.';

-- Supabase default-grants EXECUTE on every new public function to anon +
-- authenticated. This one is route-gated (called with the admin client), so
-- strip both — the FIX-834/835 posture. REVOKE FROM PUBLIC too, since a
-- PUBLIC-only revoke does not remove the per-role default grants (FIX-695).
REVOKE ALL ON FUNCTION public.get_cohort_top_donors(uuid[], int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cohort_top_donors(uuid[], int) TO service_role;

-- PostgREST schema cache reload so .rpc('get_cohort_top_donors') resolves.
NOTIFY pgrst, 'reload schema';
