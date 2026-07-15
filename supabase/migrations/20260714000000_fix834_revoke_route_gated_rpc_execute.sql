-- FIX-834: revoke default anon/authenticated EXECUTE on route-gated RPCs.
--
-- FIX-695 follow-up. Supabase's default privileges GRANT EXECUTE on every new
-- public function to anon + authenticated + service_role. Any function that is
-- only ever meant to be called by an admin/service_role client (pipeline, cron,
-- direct-pg) or is internal machinery is therefore reachable directly via
-- POST /rest/v1/rpc/<fn> by anyone holding the publishable key, bypassing the
-- calling Next route's allow-list.
--
-- Full audit + per-function evidence: docs/audits/2026-07-13-rpc-execute-grants.md
--
-- Classified all 196 anon/authenticated-executable public function signatures on
-- prod. Safety-gated the revoke on: (1) no public function referenced in any RLS
-- policy (only auth.uid()), (2) no public function referenced in any view or
-- generated-column expression, (3) a nested-INVOKER anon-keep closure of 24
-- functions that public/publishable/session surfaces transitively require — none
-- of which appear below. service_role KEEPS EXECUTE throughout (re-granted
-- explicitly, defensively). REVOKE FROM PUBLIC too, mirroring FIX-695, since a
-- PUBLIC-only revoke does NOT strip the per-role default grants.
--
-- Two-tier:
--   * 124 signatures: revoke anon + authenticated (service_role-only callers).
--   * 2 signatures: revoke anon only, keep authenticated (session self-checks).
--
-- NOT touched (documented in the audit): 24 KEEP-anon (public surfaces), 11
-- authenticated user-action fns, 15 trigger fns (inert — not RPC-exposed), 7 pure
-- helpers, and 13 no-caller read-only fns flagged for Craig's decision.

-- ============================================================================
-- Tier 1 — REVOKE anon + authenticated (keep service_role). 124 signatures.
-- ============================================================================
REVOKE ALL ON FUNCTION public.backfill_governing_body_slugs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_governing_body_slugs() TO service_role;
REVOKE ALL ON FUNCTION public.backfill_jurisdiction_boundary(p_id uuid, p_geojson text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_jurisdiction_boundary(p_id uuid, p_geojson text) TO service_role;
REVOKE ALL ON FUNCTION public.check_rebuild_autovacuum_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rebuild_autovacuum_status() TO service_role;
REVOKE ALL ON FUNCTION public.chord_contract_flows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_contract_flows() TO service_role;
REVOKE ALL ON FUNCTION public.chord_donor_brackets_for_official(p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_donor_brackets_for_official(p_official_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.chord_donor_state_party_flows(p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_donor_state_party_flows(p_official_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.chord_donor_type_party_flows(p_official_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_donor_type_party_flows(p_official_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.chord_industry_flows_for_official(p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_industry_flows_for_official(p_official_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.chord_industry_flows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_industry_flows() TO service_role;
REVOKE ALL ON FUNCTION public.chord_sector_vote_for_officials(p_official_ids uuid[], p_min_usd numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_sector_vote_for_officials(p_official_ids uuid[], p_min_usd numeric) TO service_role;
REVOKE ALL ON FUNCTION public.chord_subject_party_flows(p_official_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_subject_party_flows(p_official_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.chord_top_pacs_for_official(p_official_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_top_pacs_for_official(p_official_id uuid, p_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.clear_financial_entity_rule_tags(p_categories text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_financial_entity_rule_tags(p_categories text[]) TO service_role;
REVOKE ALL ON FUNCTION public.compute_alignment_score(p_user_id uuid, p_official_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_alignment_score(p_user_id uuid, p_official_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.count_independent_corroborations(p_card_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_independent_corroborations(p_card_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.detect_brigade_candidates(p_mode text, p_target_ids uuid[], p_window_minutes integer, p_horizon_days integer, p_min_cluster integer, p_min_cooccur_targets integer, p_new_account_days integer, p_established_days integer, p_score_threshold numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_brigade_candidates(p_mode text, p_target_ids uuid[], p_window_minutes integer, p_horizon_days integer, p_min_cluster integer, p_min_cooccur_targets integer, p_new_account_days integer, p_established_days integer, p_score_threshold numeric) TO service_role;
REVOKE ALL ON FUNCTION public.donor_party_rollup_rebuild_donors(p_donors uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.donor_party_rollup_rebuild_donors(p_donors uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.expire_lapsed_grants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_lapsed_grants() TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_donation_totals_rebuild(p_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_donation_totals_rebuild(p_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_donation_totals_window(p_lo uuid, p_hi uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_donation_totals_window(p_lo uuid, p_hi uuid) TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_received_totals_rebuild(p_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_received_totals_rebuild(p_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_received_totals_window(p_lo uuid, p_hi uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_received_totals_window(p_lo uuid, p_hi uuid) TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_recipient_count_rebuild(p_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_recipient_count_rebuild(p_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.financial_entity_recipient_count_window(p_lo uuid, p_hi uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_entity_recipient_count_window(p_lo uuid, p_hi uuid) TO service_role;
REVOKE ALL ON FUNCTION public.find_entity_path(p_from_id uuid, p_to_id uuid, p_max_hops integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_entity_path(p_from_id uuid, p_to_id uuid, p_max_hops integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_browse_facets(p_kind text, p_facets jsonb, p_q text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_browse_facets(p_kind text, p_facets jsonb, p_q text) TO service_role;
REVOKE ALL ON FUNCTION public.get_browse_page(p_kind text, p_facets jsonb, p_q text, p_sort text, p_cursor_value text, p_cursor_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_browse_page(p_kind text, p_facets jsonb, p_q text, p_sort text, p_cursor_value text, p_cursor_id uuid, p_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_connection_counts(entity_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_connection_counts(entity_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.get_connection_type_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_connection_type_counts() TO service_role;
REVOKE ALL ON FUNCTION public.get_crossgroup_sector_totals(p_group1_ids uuid[], p_group2_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_crossgroup_sector_totals(p_group1_ids uuid[], p_group2_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.get_database_size_bytes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_database_size_bytes() TO service_role;
REVOKE ALL ON FUNCTION public.get_drift_source_presence() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_drift_source_presence() TO service_role;
REVOKE ALL ON FUNCTION public.get_entity_comment_highlights(p_entity_type text, p_entity_id uuid, p_lens text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_entity_comment_highlights(p_entity_type text, p_entity_id uuid, p_lens text) TO service_role;
REVOKE ALL ON FUNCTION public.get_entity_position_rollup(p_entity_type text, p_entity_id uuid, p_lens text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_entity_position_rollup(p_entity_type text, p_entity_id uuid, p_lens text) TO service_role;
REVOKE ALL ON FUNCTION public.get_financial_entity_naics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_financial_entity_naics() TO service_role;
REVOKE ALL ON FUNCTION public.get_group_connections(p_member_ids uuid[], p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_group_connections(p_member_ids uuid[], p_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_group_sector_totals(p_member_ids uuid[], p_min_usd numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_group_sector_totals(p_member_ids uuid[], p_min_usd numeric) TO service_role;
REVOKE ALL ON FUNCTION public.get_official_bipartisan_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_official_bipartisan_stats() TO service_role;
REVOKE ALL ON FUNCTION public.get_official_donor_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_official_donor_rollup() TO service_role;
REVOKE ALL ON FUNCTION public.get_officials_breakdown() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_officials_breakdown() TO service_role;
REVOKE ALL ON FUNCTION public.get_officials_by_filter(p_chamber text, p_party text, p_state text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_officials_by_filter(p_chamber text, p_party text, p_state text) TO service_role;
REVOKE ALL ON FUNCTION public.get_pac_treemap_by_party(p_min_cents bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pac_treemap_by_party(p_min_cents bigint) TO service_role;
REVOKE ALL ON FUNCTION public.get_pac_treemap_by_sector(p_industry text, p_min_cents bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pac_treemap_by_sector(p_industry text, p_min_cents bigint) TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_entry_pages(lim integer, days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_entry_pages(lim integer, days integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_pv_top_transitions(lim integer, min_count integer, days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pv_top_transitions(lim integer, min_count integer, days integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_quality_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_quality_counts() TO service_role;
REVOKE ALL ON FUNCTION public.get_supabase_auth_mau() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supabase_auth_mau() TO service_role;
REVOKE ALL ON FUNCTION public.get_supabase_cpu_max(window_minutes integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supabase_cpu_max(window_minutes integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_supabase_max_connections() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supabase_max_connections() TO service_role;
REVOKE ALL ON FUNCTION public.get_supabase_self_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supabase_self_metrics() TO service_role;
REVOKE ALL ON FUNCTION public.get_top_connected_officials(p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_top_connected_officials(p_limit integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_vote_agreement_matrix(p_official_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_vote_agreement_matrix(p_official_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.has_active_constituent_grant(p_user_id uuid, p_jurisdiction_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_constituent_grant(p_user_id uuid, p_jurisdiction_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.increment_snapshot_view(p_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_snapshot_view(p_code text) TO service_role;
REVOKE ALL ON FUNCTION public.investigation_citation_target_exists(p_citation_type text, p_target_type text, p_target_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.investigation_citation_target_exists(p_citation_type text, p_target_type text, p_target_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.jurisdictions_containing_point(p_lng double precision, p_lat double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jurisdictions_containing_point(p_lng double precision, p_lat double precision) TO service_role;
REVOKE ALL ON FUNCTION public.link_federal_reps_to_districts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_federal_reps_to_districts() TO service_role;
REVOKE ALL ON FUNCTION public.link_officials_to_districts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_officials_to_districts() TO service_role;
REVOKE ALL ON FUNCTION public.promote_candidate_to_elected(p_elected_id uuid, p_candidate_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_candidate_to_elected(p_elected_id uuid, p_candidate_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.prune_kill_switch_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_kill_switch_events() TO service_role;
REVOKE ALL ON FUNCTION public.prune_platform_usage_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_platform_usage_snapshot() TO service_role;
REVOKE ALL ON FUNCTION public.prune_status_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_status_snapshot() TO service_role;
REVOKE ALL ON FUNCTION public.reap_stale_sync_log(stale_minutes integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(stale_minutes integer) TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_all_primary_sources() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_all_primary_sources() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_browse_facet_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_browse_facet_counts() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_ec_donations_full_prepare() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_prepare() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_ec_donations_full_window(p_lo uuid, p_hi uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_window(p_lo uuid, p_hi uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_appointments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_appointments() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_contracts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_contracts() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_cosponsors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_cosponsors() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_donations_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations_full() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_donations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_external() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_external() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_gifts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_gifts() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_holds() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_investigation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_investigation() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_lobbying() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_lobbying() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_oversight() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_oversight() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes_full() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_connections() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_search_index() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_donation_totals_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_donation_totals_full() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_donation_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_donation_totals() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_ie_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_ie_totals() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_received_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_received_totals() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_official_donation_totals_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_official_donation_totals_full() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_official_donation_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_official_donation_totals() TO service_role;
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags() TO service_role;
REVOKE ALL ON FUNCTION public.recompute_comment_bridge_scores(p_entity_type text, p_entity_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_comment_bridge_scores(p_entity_type text, p_entity_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_enrichment_failure(p_queue_id bigint, p_error text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_enrichment_failure(p_queue_id bigint, p_error text) TO service_role;
REVOKE ALL ON FUNCTION public.refresh_agency_page_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_agency_page_cache() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_chord_donor_state_party_flows_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_chord_donor_state_party_flows_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_chord_donor_type_party_flows_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_chord_donor_type_party_flows_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_chord_industry_flows_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_chord_industry_flows_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_chord_subject_party_flows_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_chord_subject_party_flows_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_commons_active_threads_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_commons_active_threads_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_connection_type_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_connection_type_counts() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_donor_party_rollup_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_entity_connection_stats_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_entity_connection_stats_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_entity_engagement_rollup_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_entity_engagement_rollup_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_gb_page_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_gb_page_cache() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_group_donor_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_group_donor_rollup() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_homepage_agency_counts_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_homepage_agency_counts_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_homepage_stats_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_homepage_stats_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_jurisdiction_page_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_jurisdiction_page_cache() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_official_content_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_official_content_ids() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_official_donor_rollup_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_official_donor_rollup_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_official_homepage_stats_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_official_homepage_stats_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_official_sector_dollars_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_official_sector_dollars_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_pipeline_runtime_stats_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pipeline_runtime_stats_mv() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_primary_source_for_entities(p_entity_type text, p_entity_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_primary_source_for_entities(p_entity_type text, p_entity_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.refresh_proposal_popularity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_proposal_popularity() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_proposal_trending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_proposal_trending() TO service_role;
REVOKE ALL ON FUNCTION public.refresh_spending_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_spending_totals() TO service_role;
REVOKE ALL ON FUNCTION public.resolve_entity_by_canonical(p_canonical_name text, p_entity_type text, p_state text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_entity_by_canonical(p_canonical_name text, p_entity_type text, p_state text) TO service_role;
REVOKE ALL ON FUNCTION public.search_graph_entities(q text, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_graph_entities(q text, lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.treemap_officials_by_donations(lim integer, p_chamber text, p_party text, p_state text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treemap_officials_by_donations(lim integer, p_chamber text, p_party text, p_state text) TO service_role;
REVOKE ALL ON FUNCTION public.treemap_officials_by_donations(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treemap_officials_by_donations(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.treemap_recipients_by_contracts(lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treemap_recipients_by_contracts(lim integer) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_county_jurisdiction(p_parent_id uuid, p_census_geoid text, p_fips_code text, p_name text, p_short_name text, p_boundary_geojson text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_county_jurisdiction(p_parent_id uuid, p_census_geoid text, p_fips_code text, p_name text, p_short_name text, p_boundary_geojson text) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_district_jurisdiction(p_parent_id uuid, p_name text, p_short_name text, p_fips_code text, p_census_geoid text, p_chamber text, p_metadata jsonb, p_geojson text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_district_jurisdiction(p_parent_id uuid, p_name text, p_short_name text, p_fips_code text, p_census_geoid text, p_chamber text, p_metadata jsonb, p_geojson text) TO service_role;

-- ============================================================================
-- Tier 2 — REVOKE anon only, keep authenticated + service_role. 2 signatures.
-- authenticated legitimately calls these as a logged-in-user self-check
-- (viewer/engagement answerer grant; admin-grant check); anon has no business
-- probing them directly.
-- ============================================================================
REVOKE ALL ON FUNCTION public.has_active_answerer_grant(p_user_id uuid, p_entity_type text, p_entity_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_answerer_grant(p_user_id uuid, p_entity_type text, p_entity_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_active_platform_admin_grant(p_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_platform_admin_grant(p_user_id uuid) TO authenticated, service_role;
