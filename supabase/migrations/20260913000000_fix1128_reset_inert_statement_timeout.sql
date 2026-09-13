-- FIX-1128 (Half 1) — RESET the inert statement_timeout proconfig on all 91
-- public functions that carry one, and add _fix1128_probe_sleep for the
-- service_role bound measurement.
--
-- WHY THIS IS BEHAVIOUR-NEUTRAL, NOT A TUNING CHANGE.
-- statement_timeout is armed once, by the server, at the start of a top-level
-- client statement, from the GUC value at that moment. A function-level
-- proconfig changes what current_setting() reports INSIDE the call and bounds
-- nothing. Measured on the clone (PG 17) and recorded verbatim in
-- docs/audits/2026-09-13-fix1128-experiments.md: a function with a 1s
-- proconfig slept 3s to completion. FIX-1123's 21,638s run carried "1200s" and
-- died on the postgres role's 6h ceiling, which is the only bound that was ever
-- real for it.
--
-- So these values are not guards. They are read as guards, which is the bug:
-- two of them (derive_nh_floterials, revoke_grant) were written AFTER FIX-1128
-- was filed. This migration removes the misreadable decoration; the guard that
-- stops it regrowing is pnpm check:proconfig.
--
-- WHY RESET AND NOT REDEFINITION.
-- RESET removes exactly one proconfig entry and leaves search_path and the
-- enable_* settings byte-identical. Redefining 91 functions to drop one SET
-- clause is rule 34's trap (re-state every SET clause or silently lose one) at
-- 91x the blast radius, for no gain. RESET on a function that does not carry
-- the setting is a no-op, so this file is idempotent.
--
-- BEHAVIOUR DEPENDENCY, CHECKED (rule 103). The strip is neutral only if
-- nothing reads the value back. pg_proc.prosrc on the clone and on prod: zero
-- function bodies read current_setting('statement_timeout'). The repo has one
-- reader, packages/data/src/lib/statement-timeout-probe.ts, and it reads the
-- SESSION value on a direct pg.Client to confirm a break-glass disarm — never a
-- function's proconfig. See docs/audits/2026-09-13-fix1128-proconfig-census.md.
--
-- GENERATED from docs/audits/2026-09-13-fix1128-proconfig-census.tsv. The
-- census was taken on the clone and on prod and diffed byte-identical, so the
-- identity list below is true of both.
--
-- _fix1128_probe_sleep IS TEMPORARY. It exists to measure class B's real bound
-- (does an 8s authenticator timeout follow an impersonated service_role through
-- PostgREST?) — one 10s call and one 2s control. Half 2 (cc-125) DROPs it.

-- ── the strip: 91 functions ──────────────────────────────────────────────────
ALTER FUNCTION public.add_citation(uuid,text,text,uuid,text) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.add_evidence_card(uuid,text,text,text,uuid,text,uuid,text,boolean,text,text,uuid,text) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.backfill_jurisdiction_boundary(uuid,text) RESET statement_timeout;  -- B, claimed 30s
ALTER FUNCTION public.check_sector_affinity_tag_staleness() RESET statement_timeout;  -- B, claimed 60s
ALTER FUNCTION public.chord_contract_flows_full() RESET statement_timeout;  -- C2, claimed 300s
ALTER FUNCTION public.clear_financial_entity_rule_tags(text[]) RESET statement_timeout;  -- D, claimed 120s
ALTER FUNCTION public.clear_private_person_card(uuid,uuid) RESET statement_timeout;  -- D, claimed 5s
ALTER FUNCTION public.compute_alignment_score(uuid,uuid) RESET statement_timeout;  -- B, claimed 3s
ALTER FUNCTION public.create_investigation(text,text,text,uuid,text) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.derive_nh_floterials() RESET statement_timeout;  -- B, claimed 5min
ALTER FUNCTION public.entity_comments_bump_activity() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.entity_comments_flag_autotrip() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.entity_comments_refresh_rating_summary() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.entity_comments_stamp_answered() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.entity_statements_flag_autotrip() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.evidence_cards_corroboration_autotrip() RESET statement_timeout;  -- E, claimed 3s
ALTER FUNCTION public.evidence_cards_flag_autotrip() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.evidence_cards_refresh_rating_summary() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.expire_lapsed_grants() RESET statement_timeout;  -- B, claimed 30s
ALTER FUNCTION public.get_agency_page(uuid) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.get_connection_type_counts() RESET statement_timeout;  -- B, claimed 5s
ALTER FUNCTION public.get_entity_comment_highlights(text,uuid,text) RESET statement_timeout;  -- B, claimed 5s
ALTER FUNCTION public.get_entity_position_rollup(text,uuid,text) RESET statement_timeout;  -- D, claimed 5s
ALTER FUNCTION public.get_entity_questions(text,uuid,text,text,integer,text) RESET statement_timeout;  -- A, claimed 5s
ALTER FUNCTION public.get_entity_statements(text,uuid,text,integer,text) RESET statement_timeout;  -- A, claimed 5s
ALTER FUNCTION public.get_financial_entity_naics() RESET statement_timeout;  -- D, claimed 120s
ALTER FUNCTION public.get_gb_page(uuid) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.get_group_donor_totals(uuid[]) RESET statement_timeout;  -- E, claimed 30s
ALTER FUNCTION public.get_institution_recent_votes(uuid,integer) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.get_jurisdiction_activity(uuid,integer) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.get_jurisdiction_page(uuid) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.get_official_bipartisan_stats_full() RESET statement_timeout;  -- E, claimed 300s
ALTER FUNCTION public.get_official_donor_rollup_full() RESET statement_timeout;  -- E, claimed 300s
ALTER FUNCTION public.get_official_page(uuid) RESET statement_timeout;  -- A, claimed 5s
ALTER FUNCTION public.get_position_rollup_display(text,uuid,text) RESET statement_timeout;  -- A, claimed 5s
ALTER FUNCTION public.get_proposal_counts_by_agency() RESET statement_timeout;  -- A, claimed 60s
ALTER FUNCTION public.get_quality_counts() RESET statement_timeout;  -- C2, claimed 60s
ALTER FUNCTION public.get_supabase_cpu_max(integer) RESET statement_timeout;  -- B, claimed 5s
ALTER FUNCTION public.get_top_connected_officials(integer) RESET statement_timeout;  -- B, claimed 60s
ALTER FUNCTION public.get_user_receipts(integer) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.has_active_answerer_grant(uuid,text,uuid) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.has_active_constituent_grant(uuid,uuid) RESET statement_timeout;  -- B, claimed 2s
ALTER FUNCTION public.has_active_official_grant(uuid,uuid) RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.has_active_platform_admin_grant(uuid) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.jurisdiction_boundary_svg(uuid,integer,integer) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.jurisdictions_containing_point(double precision,double precision) RESET statement_timeout;  -- B, claimed 3s
ALTER FUNCTION public.link_officials_to_districts() RESET statement_timeout;  -- B, claimed 5min
ALTER FUNCTION public.position_events_bump_delta() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.promote_evidence_edge(uuid,uuid) RESET statement_timeout;  -- D, claimed 5s
ALTER FUNCTION public.rate_evidence(uuid,smallint,smallint) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.rebuild_all_primary_sources() RESET statement_timeout;  -- C1, claimed 5min
ALTER FUNCTION public.rebuild_browse_facet_counts() RESET statement_timeout;  -- E, claimed 300s
ALTER FUNCTION public.rebuild_entity_connections() RESET statement_timeout;  -- B, claimed 60min
ALTER FUNCTION public.rebuild_entity_connections_appointments() RESET statement_timeout;  -- C1, claimed 15min
ALTER FUNCTION public.rebuild_entity_connections_contracts() RESET statement_timeout;  -- C1, claimed 30min
ALTER FUNCTION public.rebuild_entity_connections_cosponsors() RESET statement_timeout;  -- C1, claimed 10min
ALTER FUNCTION public.rebuild_entity_connections_external() RESET statement_timeout;  -- C1, claimed 15min
ALTER FUNCTION public.rebuild_entity_connections_gifts() RESET statement_timeout;  -- C1, claimed 10min
ALTER FUNCTION public.rebuild_entity_connections_holds() RESET statement_timeout;  -- C1, claimed 10min
ALTER FUNCTION public.rebuild_entity_connections_investigation() RESET statement_timeout;  -- C1, claimed 5min
ALTER FUNCTION public.rebuild_entity_connections_lobbying() RESET statement_timeout;  -- C1, claimed 10min
ALTER FUNCTION public.rebuild_entity_connections_oversight() RESET statement_timeout;  -- C1, claimed 5min
ALTER FUNCTION public.rebuild_entity_connections_votes() RESET statement_timeout;  -- C1, claimed 15min
ALTER FUNCTION public.rebuild_entity_connections_votes_full() RESET statement_timeout;  -- C1, claimed 15min
ALTER FUNCTION public.rebuild_entity_search_index() RESET statement_timeout;  -- C1, claimed 1200s
ALTER FUNCTION public.rebuild_financial_entity_donation_totals() RESET statement_timeout;  -- D, claimed 30min
ALTER FUNCTION public.rebuild_financial_entity_donation_totals_full() RESET statement_timeout;  -- E, claimed 30min
ALTER FUNCTION public.rebuild_financial_entity_ie_totals() RESET statement_timeout;  -- D, claimed 10min
ALTER FUNCTION public.rebuild_financial_entity_received_totals() RESET statement_timeout;  -- D, claimed 30min
ALTER FUNCTION public.rebuild_financial_entity_size_tags() RESET statement_timeout;  -- C1, claimed 300s
ALTER FUNCTION public.rebuild_pre_vote_timing_tags() RESET statement_timeout;  -- C1, claimed 300s
ALTER FUNCTION public.recompute_comment_bridge_scores(text,uuid) RESET statement_timeout;  -- B, claimed 120s
ALTER FUNCTION public.refresh_agency_page_cache() RESET statement_timeout;  -- B, claimed 300s
ALTER FUNCTION public.refresh_connection_type_counts() RESET statement_timeout;  -- C2, claimed 5min
ALTER FUNCTION public.refresh_gb_page_cache() RESET statement_timeout;  -- B, claimed 300s
ALTER FUNCTION public.refresh_group_donor_rollup() RESET statement_timeout;  -- C2, claimed 300s
ALTER FUNCTION public.refresh_jurisdiction_page_cache() RESET statement_timeout;  -- B, claimed 600s
ALTER FUNCTION public.refresh_official_content_ids() RESET statement_timeout;  -- B, claimed 600s
ALTER FUNCTION public.refresh_primary_source_for_entities(text,uuid[]) RESET statement_timeout;  -- B, claimed 60s
ALTER FUNCTION public.reject_evidence_edge(uuid,uuid) RESET statement_timeout;  -- D, claimed 5s
ALTER FUNCTION public.revoke_grant(uuid,grant_role,grant_target_type,uuid,uuid,text) RESET statement_timeout;  -- B, claimed 30s
ALTER FUNCTION public.set_community_note_endorsement(uuid,boolean) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.set_entity_position(text,uuid,smallint,text,uuid,text) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.set_investigation_findings(uuid,text,text) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.set_statement_vote(uuid,smallint) RESET statement_timeout;  -- A, claimed 2s
ALTER FUNCTION public.statement_votes_refresh_summary() RESET statement_timeout;  -- E, claimed 2s
ALTER FUNCTION public.submit_comment(text,uuid,text,text,text,uuid,text) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.submit_statement(text,uuid,text,uuid) RESET statement_timeout;  -- A, claimed 3s
ALTER FUNCTION public.treemap_recipients_by_contracts_full(integer) RESET statement_timeout;  -- C2, claimed 300s
ALTER FUNCTION public.unpromote_evidence_edge(uuid,uuid) RESET statement_timeout;  -- D, claimed 5s
ALTER FUNCTION public.upsert_county_jurisdiction(uuid,text,text,text,text,text) RESET statement_timeout;  -- B, claimed 5s

-- ── the class-B probe — DROPPED BY HALF 2 (cc-125) ──────────────────────────
-- SECURITY INVOKER (the default) and service_role only. Supabase default-grants
-- EXECUTE on new functions to anon and authenticated, so the REVOKE is load
-- bearing, not decoration — FIX-695/834.
CREATE OR REPLACE FUNCTION public._fix1128_probe_sleep(p_seconds int)
RETURNS int
LANGUAGE sql
AS $$ SELECT 1 FROM pg_sleep(p_seconds) $$;

REVOKE EXECUTE ON FUNCTION public._fix1128_probe_sleep(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._fix1128_probe_sleep(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public._fix1128_probe_sleep(int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public._fix1128_probe_sleep(int) TO service_role;

COMMENT ON FUNCTION public._fix1128_probe_sleep(int) IS
  'FIX-1128 Half 1 — temporary. Measures whether an impersonated service_role '
  'inherits authenticator''s 8s statement_timeout through PostgREST. Dropped by Half 2 (cc-125).';
