-- =============================================================================
-- FIX-878 — chord_contract_flows() → RETURNS jsonb (defeat the PostgREST 1k cap).
--
-- chord_contract_flows() is the read fn behind /api/graph/spending?type=chord.
-- As of FIX-838 it is a SETOF function returning one row per (agency, sector)
-- pair — 1,491 rows on prod (1,170 local post-FIX-873-refresh). PostgREST caps
-- ANY response at max_rows=1,000, so the route silently receives only the
-- top-1,000 flows by total_cents and aggregates agency/sector totals from that
-- truncated set — a ~$17.7B tail (~0.7% of the $2.59T total) missing from the
-- chord, failing OPEN (no error, just short). Surfaced verifying FIX-873.
--
-- This is the reference-postgrest-rpc-row-cap rule: a set-returning RPC that can
-- exceed 1,000 rows must return ONE jsonb aggregate instead (no cap inside SQL),
-- never .range()-paginate. So convert the read fn to RETURNS jsonb — a single
-- row: the full flows array via jsonb_agg. Both branches stay safe:
--   • bootstrapped  → jsonb_agg over contract_agency_sector_rollup (the full set)
--   • pre-bootstrap → jsonb_agg over chord_contract_flows_full()'s rows
-- The array ELEMENT shape is byte-identical to the old SETOF row
-- ({agency_id, agency_name, agency_acronym, sector, total_cents, award_count}),
-- so the route parses `data` as the same array and the SpendingGraph response
-- envelope is unchanged.
--
-- SCOPE: only the read fn changes. chord_contract_flows_full() stays SETOF
-- (break-glass, FIX-838/873 body — untouched), as do the rollup tables and the
-- weekly refresh cron. Base is the LIVE fn body (pg_get_functiondef, local
-- 2026-07-21 — the FIX-838 read-fn body; FIX-873 only touched the _full bodies
-- + the rebuild proc, never this read fn), only the return type + jsonb wrapping
-- changed.
--
-- Return-type change forces DROP+CREATE (CREATE OR REPLACE cannot change a
-- function's return type). DROP re-triggers Supabase's default EXECUTE grant to
-- anon/authenticated, so the FIX-834 service_role-only posture is re-asserted
-- below. Nothing in-DB calls chord_contract_flows() (the route is the only
-- caller, at runtime via RPC), so the DROP has no dependency fallout.
-- =============================================================================

DROP FUNCTION IF EXISTS public.chord_contract_flows();

CREATE FUNCTION public.chord_contract_flows()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bootstrapped boolean;
  v_result       jsonb;
BEGIN
  SELECT (value->>'bootstrapped')::boolean INTO v_bootstrapped
  FROM public.pipeline_state WHERE key = 'contract_flow_rollups_state';

  IF COALESCE(v_bootstrapped, false) THEN
    -- Fast path: aggregate the full rollup into one jsonb array (no 1k cap).
    SELECT COALESCE(jsonb_agg(t ORDER BY t.total_cents DESC), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT r.agency_id, r.agency_name, r.agency_acronym, r.sector,
             r.total_cents, r.award_count
      FROM public.contract_agency_sector_rollup r
    ) t;
    RETURN v_result;
  END IF;

  -- Not yet bootstrapped → live-compute, same dataset, wrapped in one jsonb.
  SELECT COALESCE(jsonb_agg(t ORDER BY t.total_cents DESC), '[]'::jsonb)
  INTO v_result
  FROM public.chord_contract_flows_full() t;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.chord_contract_flows() IS
  'FIX-878 — full agency × sector contract-flow chord as ONE jsonb array '
  '(jsonb_agg over contract_agency_sector_rollup; live-compute fallback to '
  'chord_contract_flows_full() until the rollup is bootstrapped). Returns jsonb '
  'rather than SETOF so the >1,000-row flow set is not truncated by PostgREST''s '
  'max_rows cap (FIX-838''s SETOF form silently dropped the tail). Array element '
  'shape unchanged — /api/graph/spending?type=chord parses data as the array.';

-- DROP+CREATE re-default-grants EXECUTE to anon/authenticated (FIX-695/834) —
-- re-assert the route-gated service_role-only posture (route calls via
-- createAdminClient = service_role).
REVOKE ALL ON FUNCTION public.chord_contract_flows() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_contract_flows() TO service_role;

-- PostgREST: changed function signature (SETOF → scalar jsonb) → reload schema.
NOTIFY pgrst, 'reload schema';
