-- FIX-835: revoke anon/authenticated EXECUTE on the 13 no-caller RPCs that
-- FIX-834 flagged needs-Craig and left anon-open. Craig confirmed revoke.
--
-- All 13 are read-only with ZERO callers anywhere (no .rpc(), no pg_cron/proc,
-- no direct-pg, no in-DB nested caller, no view/generated-column reference, no
-- RLS-policy reference — all verified during the FIX-834 audit,
-- docs/audits/2026-07-13-rpc-execute-grants.md), so revoking anon+authenticated
-- breaks nothing. service_role kept (re-granted defensively). See [[FIX-834]].

REVOKE ALL ON FUNCTION public.get_current_usage(p_service text, p_metric text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_usage(p_service text, p_metric text) TO service_role;
REVOKE ALL ON FUNCTION public.get_group_donor_totals(p_official_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_group_donor_totals(p_official_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.get_official_donors(p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_official_donors(p_official_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_pac_donations_by_party() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pac_donations_by_party() TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_bots() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_bots() TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_countries(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_countries(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_devices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_devices() TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_sources() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_sources() TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_summary() TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_top_officials(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_top_officials(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_top_pages(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_top_pages(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_top_proposals(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_top_proposals(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.has_active_official_grant(p_user_id uuid, p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_official_grant(p_user_id uuid, p_official_id uuid) TO service_role;
