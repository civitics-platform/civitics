-- FIX-345 — single-RPC presence check for derived-drift source rules.
--
-- Replaces the 11-parallel COUNT(*) fan-out in
-- apps/civitics/app/api/claude/status/_lib/sections.ts's checkDerivedDrift.
--
-- Background: status_snapshot.section_times shows per-rule breakdown
-- where two rules dominate derived_drift wall-clock —
--   derived_drift:contract_award     12729 ms  (.in IN ('contract','grant'))
--   derived_drift:donation            8334 ms  (.eq 'donation')
-- Other 9 rules sub-500ms. RPC get_connection_type_counts() itself is
-- 0 ms via shared promise.
--
-- Diagnostic via EXPLAIN ANALYZE (prod, 2026-05-24):
--   COUNT(*) WHERE relationship_type='donation'        TIMED OUT (>30s)
--   COUNT(*) WHERE relationship_type IN ('contract','grant') TIMED OUT
--   EXISTS contract/grant — cold seq scan: 22 s, dirtied 1418 pages
--   composite UNION ALL of 11 EXISTS (warm): 34 ms wall-clock, 0.6 ms exec
--
-- Root cause: relationship_type='donation' and IN ('contract','grant')
-- match ~5M and ~1.4M rows respectively. Planner picks Seq Scan for
-- COUNT(*) on those values. The scan has to count all matching rows.
-- For rare values (gift/honorarium, lobbying_spend) planner picks
-- Index Only Scan and the per-rule cost stays sub-200ms — that's why
-- the other 9 rules were never slow.
--
-- The drift detection only uses the source count as a boolean
-- (`source > 0`, see checkDerivedDrift). Replacing the COUNT with
-- EXISTS keeps the semantic identical but lets the planner stop at
-- the first matching row regardless of total cardinality. The
-- composite query is one round-trip, parallel-safe within the function.

CREATE OR REPLACE FUNCTION public.get_drift_source_presence()
RETURNS TABLE(rule_type TEXT, has_rows BOOLEAN)
LANGUAGE sql
STABLE
AS $$
  SELECT 'donation'::TEXT,        EXISTS (SELECT 1 FROM public.financial_relationships WHERE relationship_type = 'donation')
  UNION ALL SELECT 'vote_yes'::TEXT,       EXISTS (SELECT 1 FROM public.votes WHERE vote = 'yes')
  UNION ALL SELECT 'vote_no'::TEXT,        EXISTS (SELECT 1 FROM public.votes WHERE vote = 'no')
  UNION ALL SELECT 'vote_abstain'::TEXT,   EXISTS (SELECT 1 FROM public.votes WHERE vote = 'abstain')
  UNION ALL SELECT 'co_sponsorship'::TEXT, EXISTS (SELECT 1 FROM public.proposal_cosponsors WHERE date_withdrawn IS NULL)
  UNION ALL SELECT 'appointment'::TEXT,    EXISTS (SELECT 1 FROM public.career_history WHERE is_government = true AND governing_body_id IS NOT NULL)
  UNION ALL SELECT 'oversight'::TEXT,      EXISTS (SELECT 1 FROM public.agencies WHERE governing_body_id IS NOT NULL)
  UNION ALL SELECT 'holds_position'::TEXT, EXISTS (SELECT 1 FROM public.financial_relationships WHERE relationship_type IN ('owns_stock', 'owns_bond', 'property') AND ended_at IS NULL)
  UNION ALL SELECT 'gift_received'::TEXT,  EXISTS (SELECT 1 FROM public.financial_relationships WHERE relationship_type IN ('gift', 'honorarium'))
  UNION ALL SELECT 'contract_award'::TEXT, EXISTS (SELECT 1 FROM public.financial_relationships WHERE relationship_type IN ('contract', 'grant'))
  UNION ALL SELECT 'lobbying'::TEXT,       EXISTS (SELECT 1 FROM public.financial_relationships WHERE relationship_type = 'lobbying_spend');
$$;

GRANT EXECUTE ON FUNCTION public.get_drift_source_presence()
  TO authenticated, service_role;
