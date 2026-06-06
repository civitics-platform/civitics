-- FIX-499 (follow-up to 20260605000001) — force a custom plan for the donor
-- aggregate.
--
-- 20260605000001 created get_group_donor_totals as a LANGUAGE sql STABLE
-- SECURITY DEFINER function with a `SET statement_timeout` (via ALTER FUNCTION).
-- Both SECURITY DEFINER and an attached SET clause make a SQL function
-- NON-INLINABLE, so the planner could not fold the body into the caller's query
-- and instead planned it once as a GENERIC plan with `p_official_ids` opaque.
-- For `to_id = ANY($1)` the generic plan can't see the array's cardinality and
-- chose a pathological shape: prod measured the function call timing out at
-- >45s for BOTH House and Senate, even though the identical query with a bound
-- array parameter (custom plan) runs in ~3.8s / ~0.7s respectively.
--
-- Fix: make the body plpgsql and run it via `RETURN QUERY EXECUTE ... USING`.
-- Dynamic EXECUTE re-plans on every call with the actual parameter values, so
-- the planner always gets a CUSTOM plan (the fast one) — the SET clause and
-- SECURITY DEFINER no longer matter because there is no inlining to lose. The
-- MATERIALIZED agg-then-join and `entity_type <> 'individual'` shape decisions
-- from 20260605000001 are unchanged and still load-bearing (see that header).
--
-- Re-verified on prod after this migration: Senate ~0.7s, House ~3.8s via the
-- function call — both well under the route's 8s DONOR_FETCH_BUDGET_MS.

CREATE OR REPLACE FUNCTION public.get_group_donor_totals(p_official_ids UUID[])
RETURNS TABLE(
  financial_entity_id UUID,
  entity_name         TEXT,
  entity_type         TEXT,
  total_cents         BIGINT,
  member_count        BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $fn$
BEGIN
  RETURN QUERY EXECUTE $q$
    WITH agg AS MATERIALIZED (
      SELECT ec.from_id           AS fid,
             SUM(ec.amount_cents) AS total_cents,
             COUNT(*)             AS member_ct
      FROM public.entity_connections ec
      WHERE ec.connection_type = 'donation'
        AND ec.to_type         = 'official'
        AND ec.from_type       = 'financial_entity'
        AND ec.to_id           = ANY($1)
      GROUP BY ec.from_id
    )
    SELECT a.fid,
           fe.display_name,
           fe.entity_type,
           a.total_cents::BIGINT,
           a.member_ct::BIGINT
    FROM agg a
    JOIN public.financial_entities fe ON fe.id = a.fid
    WHERE fe.entity_type <> 'individual'
      AND fe.display_name NOT ILIKE '%PAC/Committee%'
    ORDER BY a.total_cents DESC
  $q$ USING p_official_ids;
END;
$fn$;

-- Keep the 30s function-level ceiling (service_role default is 8s on Pro). A
-- plpgsql function is never inlined, so the SET clause is free here — the
-- dynamic EXECUTE already guarantees the custom plan.
ALTER FUNCTION public.get_group_donor_totals(UUID[]) SET statement_timeout = '30s';

GRANT EXECUTE ON FUNCTION public.get_group_donor_totals(UUID[]) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_group_donor_totals(UUID[]) IS
  'FIX-499 — institutional donor aggregate for the graph group route. plpgsql + '
  'RETURN QUERY EXECUTE forces a custom plan for to_id = ANY($1) (the sql '
  'function form planned a generic plan that timed out >45s on prod). MATERIALIZED '
  'agg-then-join is load-bearing; see migration 20260605000001/000002 headers.';
