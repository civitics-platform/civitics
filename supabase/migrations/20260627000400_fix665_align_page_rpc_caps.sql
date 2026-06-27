-- =============================================================================
-- 20260627000300_fix665_align_page_rpc_caps.sql
-- FIX-665 — align the remaining consolidated-page RPC statement_timeout caps to
-- their page clients' withDbTimeout, the FIX-662 invariant.
--
-- FIX-661 agency-spend sweep, cap-only tail. Prod EXPLAIN proved neither RPC's
-- spend/aggregate section needs a shape change:
--   * get_gb_page       has NO financial_relationships section at all.
--   * get_official_page's global top-10 contract/grant scan already terminates
--     early on the existing financial_relationships_amount index (measured
--     9.3 ms on prod), so no LATERAL/index work is warranted.
-- But both still carry the 8s cap from FIX-647/FIX-646 while their page clients
-- give up earlier:
--   * institutions/[id] get_gb_page       -> withDbTimeout(..., 3000)
--   * officials/[id]    get_official_page  -> withDbTimeout(..., 5000)
-- An 8s function cap above a 3s/5s client timeout means the DB keeps executing
-- (burning cache-starved Pro Small I/O) for seconds after the client has already
-- returned null and degraded the render — the exact waste FIX-662 removed for
-- get_jurisdiction_page. Lower each cap to its client's value. ALTER FUNCTION
-- only; the function bodies are untouched.
-- =============================================================================

ALTER FUNCTION public.get_gb_page(uuid)       SET statement_timeout = '3s';
ALTER FUNCTION public.get_official_page(uuid) SET statement_timeout = '5s';
