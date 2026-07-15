# RPC EXECUTE-grant security audit (FIX-695 follow-up)

**Date:** 2026-07-14 · **Scope:** every `public.*` function that `anon` or
`authenticated` can `EXECUTE` on **prod** (Supabase Pro `xsazcoxinpgttgquwvuf`).
**Trigger:** FIX-695 found `increment_service_usage` was anon-executable by
default (Supabase grants `EXECUTE` to `anon`/`authenticated` on every new function
unless explicitly revoked), letting anyone `POST /rest/v1/rpc/<fn>` directly and
bypass the calling Next route's allow-list. This audit sizes the blast radius and
classifies each function keep/revoke/needs-Craig with evidence.

## How the enumeration was built (all read-only against prod)

- **Enumerate:** `pg_proc` joined to `pg_namespace`, filtered to
  `has_function_privilege('anon'|'authenticated', oid, 'EXECUTE')`, with
  `prosecdef` (DEFINER vs invoker) and the explicit `proacl` grantees.
  → **196 rows / 195 unique names** anon/authenticated-executable
  (`treemap_officials_by_donations` has two overloaded signatures).
  **89 SECURITY DEFINER**, 107 invoker. Every one carries the default
  `anon,authenticated,service_role` EXECUTE grant.
- **Caller/client map:** grepped the repo for every `.rpc("fn")` call site and
  classified the **client** each uses — `createAdminClient()` → **service_role**
  (bypasses RLS, does *not* need an anon/authenticated grant) vs
  `createServerClient`/`createBrowserClient`/`createPublicClient` →
  **publishable/session** (anon or authenticated, *does* need the grant). Key
  finding: **most API routes call read-RPCs via `createAdminClient()`** — so even
  though the route serves anon visitors, the RPC executes as service_role and
  revoking anon/authenticated does not break it while closing the direct-PostgREST
  bypass.

## Safety gates checked BEFORE deciding any revoke

1. **RLS policies** — dumped every `USING`/`WITH CHECK` expression on `public.*`.
   The only function referenced is `auth.uid()`. **No `public.*` function is used
   in an RLS policy**, so revoking EXECUTE cannot break policy evaluation.
2. **Views & generated columns** — for a normal view, function EXECUTE is checked
   against the *querying* role. Checked `pg_get_viewdef` for all public views and
   all generated-column expressions: **zero** references to any of these functions.
   No view/generated-column landmine.
3. **Nested-call closure (the real landmine).** An **INVOKER** function reachable
   by anon that internally calls another function requires anon to have EXECUTE on
   the nested one too (DEFINER parents don't propagate — their inner calls run as
   owner). Built the in-DB call graph from `pg_proc.prosrc` and computed the
   transitive **anon-keep closure** from the confirmed anon/publishable/session
   entry points. Result: **24 functions** anon/authenticated must retain — every
   one is in the KEEP-anon set below, and none appear in the revoke set. Notable
   protected chains: `get_{agency,gb,jurisdiction}_page → *_page_live →
   {get_plum_book_last_change, get_institution_recent_votes, get_jurisdiction_activity,
   jurisdiction_boundary_svg}`; `count_synthetic_donor_records →
   count_synthetic_financial_records`.
4. **Cron/pipeline tie.** Confirmed the no-`.rpc()`-caller rebuild/refresh/prune
   functions are invoked by pg_cron `CALL` procedures (`refresh_derived_mvs`,
   `run_entity_connections_rebuild`, `run_rule_taggers`,
   `refresh_*_incremental`, …) or by `createAdminClient()` pipeline scripts — i.e.
   they *are* tied to admin/service_role callers, just not via PostgREST.

## Verdict tally (195 unique functions)

| verdict | count | meaning |
|---|---|---|
| **REVOKE** (anon + authenticated) | 123 | only legit caller is service_role/admin/pipeline/cron/direct-pg (or a nested-in-DEFINER helper). Keep `service_role`. |
| **REVOKE-anon-only** | 2 | authenticated legitimately calls it (session self-check); revoke `anon` only, keep `authenticated`+`service_role`. |
| **KEEP-anon** | 24 | anon/authenticated legitimately execute via a publishable/session SSR page/route (or nested-called by one). The closure — untouched. |
| **KEEP-auth (user-action)** | 11 | `createServerClient` session, authenticated user write; already NOT anon-executable. Untouched. |
| **KEEP-trigger (inert)** | 15 | RETURNS trigger — PostgREST won't expose it as an RPC; grant is inert. Untouched. |
| **KEEP-helper (pure)** | 7 | pure stateless helper, no privileged action, no anon exposure of consequence. Untouched. |
| **NEEDS-CRAIG** | 13 | **no caller anywhere** (repo/cron/proc/direct-pg/nested), read-only. Per guardrail, flagged not auto-revoked. |

Of the **125 revoked**, **52 are SECURITY DEFINER** (the priority exposures —
they bypass RLS) and 73 are invoker (mostly mutating rebuild/refresh machinery
whose anon exposure is a DoS/data-mutation vector even under invoker RLS).

## NEEDS-CRAIG — RESOLVED (FIX-835): all 13 revoked

**Update 2026-07-14:** Craig confirmed revoke. **FIX-835**
(`20260714010000_fix835_revoke_needs_craig_rpc_execute.sql`) revokes
anon+authenticated EXECUTE on all 13 (service_role kept). Anon/auth-executable
public-fn count dropped **72 → 59**. The paragraph below is the original
flag rationale, retained for the record.

All 13 are read-only functions with **no demonstrable caller** (their only repo
references are in generated `database.ts` types). They are almost certainly
admin/analytics-intent (donor rollups, pageview analytics siblings of the
service_role `/dashboard` funcs, a grant check) and thus *likely* safe to revoke,
but with no caller I can't tie them to an admin-only client — so per the audit
guardrail they are **flagged, not revoked**:

`get_official_donors`, `get_group_donor_totals`, `get_pac_donations_by_party`,
`get_current_usage`, `has_active_official_grant`, and the eight unused pageview
analytics fns `get_pv_{bots,countries,devices,sources,summary,top_officials,top_pages,top_proposals}`.

---

## Full classification

### REVOKE — 123

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `backfill_governing_body_slugs` | invoker | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `backfill_jurisdiction_boundary` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `check_rebuild_autovacuum_status` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `chord_contract_flows` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_donor_brackets_for_official` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_donor_state_party_flows` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_donor_type_party_flows` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_industry_flows` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_industry_flows_for_official` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_sector_vote_for_officials` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_subject_party_flows` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `chord_top_pacs_for_official` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `clear_financial_entity_rule_tags` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `compute_alignment_score` | DEFINER | createAdminClient() in auth-gated my-representatives route | service_role-executed & route is auth-gated; anon grant unneeded |
| `count_independent_corroborations` | DEFINER | createAdminClient() admin moderation route (requireAdmin) | service_role-only; currently authenticated-executable — revoke both |
| `detect_brigade_candidates` | invoker | SF-P4 shadow moderation detector; admin/harness-only (project memory), run via direct SQL | moderation-internal; never anon |
| `donor_party_rollup_rebuild_donors` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `donor_rollup_rebuild_recipients` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `expire_lapsed_grants` | DEFINER | pg_cron / nightly-sync cron (service_role, CRON_SECRET) | cron/admin only |
| `financial_entity_donation_totals_rebuild` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `financial_entity_donation_totals_window` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `financial_entity_received_totals_rebuild` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `financial_entity_received_totals_window` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `financial_entity_recipient_count_rebuild` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `financial_entity_recipient_count_window` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `find_entity_path` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_browse_facets` | invoker | createAdminClient() (service_role) in api/browse|search|comments route | service_role-executed; anon grant unneeded |
| `get_browse_page` | invoker | createAdminClient() (service_role) in api/browse|search|comments route | service_role-executed; anon grant unneeded |
| `get_connection_counts` | invoker | createAdminClient() (service_role) in api/browse|search|comments route | service_role-executed; anon grant unneeded |
| `get_connection_type_counts` | invoker | createAdminClient() api/claude/status internals | service_role-only; internal status snapshot |
| `get_crossgroup_sector_totals` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_database_size_bytes` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `get_drift_source_presence` | invoker | createAdminClient() api/claude/status internals | service_role-only; internal status snapshot |
| `get_entity_comment_highlights` | DEFINER | createAdminClient() (service_role) in api/browse|search|comments route | service_role-executed; anon grant unneeded |
| `get_entity_position_rollup` | DEFINER | nested-called only by a SECURITY DEFINER parent (owner context) | no anon path (definer parent runs as owner); no direct caller |
| `get_financial_entity_naics` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `get_group_connections` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_group_sector_totals` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_official_bipartisan_stats` | DEFINER | tag pipeline via DIRECT-PG (exceeds 8s cap) — not PostgREST | no PostgREST anon caller; postgres role has EXECUTE regardless |
| `get_official_donor_rollup` | DEFINER | tag pipeline via DIRECT-PG (exceeds 8s cap) — not PostgREST | no PostgREST anon caller; postgres role has EXECUTE regardless |
| `get_officials_breakdown` | invoker | createAdminClient() api/claude/status internals | service_role-only; internal status snapshot |
| `get_officials_by_filter` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_pac_treemap_by_party` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_pac_treemap_by_sector` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_pv_entry_pages` | invoker | createAdminClient() /dashboard analytics (service_role) | service_role-executed; anon grant unneeded |
| `get_pv_top_transitions` | invoker | createAdminClient() /dashboard analytics (service_role) | service_role-executed; anon grant unneeded |
| `get_quality_counts` | invoker | createAdminClient() api/claude/status internals | service_role-only; internal status snapshot |
| `get_supabase_auth_mau` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `get_supabase_cpu_max` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `get_supabase_max_connections` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `get_supabase_self_metrics` | DEFINER | service_role monitoring/pipeline (supabase-usage/prometheus/sync-log/canary) | infra-metric/size exfil if anon-callable; only service_role callers |
| `get_top_connected_officials` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `get_vote_agreement_matrix` | invoker | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `has_active_constituent_grant` | DEFINER | createAdminClient() comments write-path; nested by DEFINER submit_* | only service_role caller; nested calls run as owner |
| `increment_snapshot_view` | DEFINER | createAdminClient() snapshot/graph route (service_role) — view-counter WRITE | service_role-executed; anon must not increment counters directly |
| `investigation_citation_target_exists` | DEFINER | nested-called only by a SECURITY DEFINER parent (owner context) | no anon path (definer parent runs as owner); no direct caller |
| `jurisdictions_containing_point` | DEFINER | createAdminClient() verify-constituent route (service_role) | only service_role caller; no anon/publishable caller |
| `link_federal_reps_to_districts` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `link_officials_to_districts` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `promote_candidate_to_elected` | invoker | promotion pipeline (FIX-761) admin script (raw SQL) — WRITE | heavy privileged rewrite; never anon |
| `prune_kill_switch_events` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `prune_platform_usage_snapshot` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `prune_status_snapshot` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `reap_stale_sync_log` | invoker | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `rebuild_all_primary_sources` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_browse_facet_counts` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_ec_donations_full_prepare` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_ec_donations_full_window` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_appointments` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_contracts` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_cosponsors` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_donations` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_donations_full` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_external` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_gifts` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_holds` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_investigation` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_lobbying` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_oversight` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_votes` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_connections_votes_full` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_entity_search_index` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_financial_entity_donation_totals` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_financial_entity_donation_totals_full` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_financial_entity_ie_totals` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_financial_entity_received_totals` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_financial_entity_size_tags` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_official_donation_totals` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_official_donation_totals_full` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `rebuild_pre_vote_timing_tags` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `recompute_comment_bridge_scores` | invoker | createAdminClient() post-auth in comments route | service_role-executed |
| `record_enrichment_failure` | DEFINER | enrichment pipeline + admin route (createAdminClient) | service_role-only |
| `refresh_agency_page_cache` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_chord_donor_state_party_flows_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_chord_donor_type_party_flows_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_chord_industry_flows_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_chord_subject_party_flows_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_commons_active_threads_mv` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_connection_type_counts` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_donor_party_rollup_mv` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_entity_connection_stats_mv` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_entity_engagement_rollup_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_gb_page_cache` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_group_donor_rollup` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_homepage_agency_counts_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_homepage_stats_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_jurisdiction_page_cache` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_official_content_ids` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_official_donor_rollup_mv` | DEFINER | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_official_homepage_stats_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_official_sector_dollars_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_pipeline_runtime_stats_mv` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_primary_source_for_entities` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_proposal_popularity` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_proposal_trending` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `refresh_spending_totals` | invoker | pg_cron CALL wrapper / pipeline script (createAdminClient) — mutating rebuild/refresh | admin/cron machinery; anon-call = DoS/data-mutation exposure |
| `resolve_entity_by_canonical` | invoker | EDGAR pipeline (createAdminClient) | pipeline-only |
| `search_graph_entities` | DEFINER | createAdminClient() api/claude/status internals | service_role-only; internal status snapshot |
| `treemap_officials_by_donations` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `treemap_recipients_by_contracts` | DEFINER | createAdminClient() (service_role) in api/graph/* route | route serves anon but RPC runs as service_role → anon grant unneeded; closes direct-PostgREST bypass |
| `upsert_county_jurisdiction` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |
| `upsert_district_jurisdiction` | DEFINER | pipeline script (createAdminClient) — write/maintenance | pipeline-only |

### REVOKE-anon-only — 2

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `has_active_answerer_grant` | DEFINER | createServerClient session — authenticated self-check (admin/answerer grant) | authenticated legitimately calls it; anon has no business → revoke anon, keep authenticated+service_role |
| `has_active_platform_admin_grant` | DEFINER | createServerClient session — authenticated self-check (admin/answerer grant) | authenticated legitimately calls it; anon has no business → revoke anon, keep authenticated+service_role |

### NEEDS-CRAIG(no-caller-read) — 13

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `get_current_usage` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_group_donor_totals` | DEFINER | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_official_donors` | DEFINER | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pac_donations_by_party` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_bots` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_countries` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_devices` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_sources` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_summary` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_top_officials` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_top_pages` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `get_pv_top_proposals` | invoker | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |
| `has_active_official_grant` | DEFINER | NO caller anywhere (repo/cron/proc/direct-pg/nested) — read-only | can't tie to an admin-only caller; per guardrail flag rather than auto-revoke (likely-safe but Craig's call) |

### KEEP-anon — 24

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `count_initiative_signatures` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `count_synthetic_donor_records` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `count_synthetic_financial_records` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `find_jurisdictions_by_location` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `find_representatives_by_location` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_agency_page` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_agency_page_live` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_entity_questions` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_entity_statements` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_gb_page` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_gb_page_live` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_institution_recent_votes` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_jurisdiction_activity` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_jurisdiction_page` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_jurisdiction_page_live` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_official_page` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_plum_book_last_change` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_position_rollup_display` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_proposal_counts_by_agency` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_sitemap_official_ids` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `get_topic_proposal_page` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `jurisdiction_boundary_svg` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `official_is_content_bearing` | invoker | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |
| `query_districts` | DEFINER | publishable/session SSR page or route (or nested-called by one, INVOKER chain) | anon+authenticated legitimately execute this; revoking breaks a live public surface |

### KEEP-auth(user-action) — 11

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `add_citation` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `add_evidence_card` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `create_investigation` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `get_user_receipts` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `rate_evidence` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `set_community_note_endorsement` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `set_entity_position` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `set_investigation_findings` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `set_statement_vote` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `submit_comment` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |
| `submit_statement` | DEFINER | createServerClient(cookies()) session — authenticated user action; already NOT anon-executable | authenticated must retain EXECUTE; anon already excluded |

### KEEP-trigger(inert) — 15

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `bill_details_sync_denorm` | invoker | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_comments_bump_activity` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_comments_flag_autotrip` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_comments_pin_immutable` | invoker | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_comments_refresh_rating_summary` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_comments_stamp_answered` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `entity_statements_flag_autotrip` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `evidence_cards_corroboration_autotrip` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `evidence_cards_flag_autotrip` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `evidence_cards_refresh_rating_summary` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `position_events_bump_delta` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `proposals_search_vector_update` | invoker | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `set_updated_at` | invoker | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `statement_votes_refresh_summary` | DEFINER | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |
| `update_updated_at_column` | invoker | trigger function (RETURNS trigger) | PostgREST does not expose trigger-return functions as RPC; grant is inert → no action |

### KEEP-helper(pure) — 7

| fn | secdef | caller / client | reason |
|---|---|---|---|
| `author_excluded_from_standing` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `author_is_synthetic` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `canonical_donor_fingerprint` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `civitics_slugify` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `is_synthetic_entity` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `normalize_pv_path` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
| `source_priority` | invoker | pure stateless helper; no direct caller, nested only in owner/admin contexts | no privileged action & no anon exposure of consequence; leave untouched |
