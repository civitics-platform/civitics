-- FIX-1429 — read the executive-seed duplicate set and every reference to it
-- (cc-299 read 5). ONE read-only statement; run it before
-- scripts/fix1429-delete-executive-seed-duplicates.sql and again after.
--
-- Victims = every officials row of an official_seed_id after the oldest
-- (created_at, then id); the oldest is the keeper. Same rule as the delete.
--
-- Output: one row per line, ordered by section.
--   seed  — rows per seed id: victims / keepers, the keeper's id, created_at
--           and updated_at, the victims' first and newest created_at.
--   ref   — every (table, predicate) pair the delete file names, with the
--           count for the victims and for the keepers. `role` says what the
--           delete does with a victim row there:
--             refuse  — any victim row RAISEs; nothing is deleted
--             check   — official_homepage_stats_mv: allowed only with zero
--                       vote_count / donor_count / total_donations_cents
--             repoint — irs990_officers / irs990_grants_out: moved to the keeper
--             delete  — derived rows deleted with the victim
--   mv    — the victims' and keepers' official_homepage_stats_mv rows per seed
--           id, with the max of the three stats and the refresh time.
--   990   — each irs990_officers / irs990_grants_out row matched to a victim,
--           with the keeper it would move to. No rows = nothing to move.
--
-- Bounded at 30 s by its own SET LOCAL (the plain path is one transaction).
-- From the PRIMARY (the worktree's .env.local.prod is a stub), EXPLAIN first:
--   node scripts/db-query.mjs --prod --file scripts/fix1429-read-executive-seed-references.sql
-- Local: --local in place of --prod.
SET LOCAL statement_timeout = '30s';
WITH s AS (
  SELECT id, source_ids->>'official_seed_id' AS seed, created_at, updated_at,
         row_number() OVER (PARTITION BY source_ids->>'official_seed_id'
                            ORDER BY created_at, id) AS rn
    FROM public.officials
   WHERE source_ids ? 'official_seed_id'
),
v AS (
  SELECT coalesce(array_agg(id) FILTER (WHERE rn > 1), '{}'::uuid[]) AS victims,
         coalesce(array_agg(id) FILTER (WHERE rn = 1), '{}'::uuid[]) AS keepers
    FROM s
),
refs(ord, role, tbl, pred, victims, keepers) AS (VALUES
  ( 1, 'refuse', 'votes', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.votes WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.votes WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 2, 'refuse', 'entity_connections', 'from_type = ''official'' AND from_id = ANY($1)',
       (SELECT count(*) FROM public.entity_connections WHERE from_type = 'official' AND from_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_connections WHERE from_type = 'official' AND from_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 3, 'refuse', 'entity_connections', 'to_type = ''official'' AND to_id = ANY($1)',
       (SELECT count(*) FROM public.entity_connections WHERE to_type = 'official' AND to_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_connections WHERE to_type = 'official' AND to_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 4, 'refuse', 'financial_relationships', 'from_type = ''official'' AND from_id = ANY($1)',
       (SELECT count(*) FROM public.financial_relationships WHERE from_type = 'official' AND from_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.financial_relationships WHERE from_type = 'official' AND from_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 5, 'refuse', 'financial_relationships', 'to_type = ''official'' AND to_id = ANY($1)',
       (SELECT count(*) FROM public.financial_relationships WHERE to_type = 'official' AND to_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.financial_relationships WHERE to_type = 'official' AND to_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 6, 'refuse', 'official_redirects', 'old_id = ANY($1)',
       (SELECT count(*) FROM public.official_redirects WHERE old_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_redirects WHERE old_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 7, 'refuse', 'official_redirects', 'new_id = ANY($1)',
       (SELECT count(*) FROM public.official_redirects WHERE new_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_redirects WHERE new_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 8, 'refuse', 'data_flags', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.data_flags WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.data_flags WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  ( 9, 'refuse', 'user_follows', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.user_follows WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.user_follows WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (10, 'refuse', 'user_preferences', 'followed_officials && $1',
       (SELECT count(*) FROM public.user_preferences WHERE followed_officials && (SELECT victims FROM v)::uuid[]),
       (SELECT count(*) FROM public.user_preferences WHERE followed_officials && (SELECT keepers FROM v)::uuid[])),
  (11, 'refuse', 'entity_comments', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_comments WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_comments WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (12, 'refuse', 'official_community_comments', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_community_comments WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_community_comments WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (13, 'refuse', 'entity_positions', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_positions WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_positions WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (14, 'refuse', 'position_events', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.position_events WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.position_events WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (15, 'refuse', 'civic_initiative_responses', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.civic_initiative_responses WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.civic_initiative_responses WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (16, 'refuse', 'notifications', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.notifications WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.notifications WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (17, 'refuse', 'entity_statements', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_statements WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_statements WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (18, 'refuse', 'citations', 'target_id = ANY($1)',
       (SELECT count(*) FROM public.citations WHERE target_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.citations WHERE target_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (19, 'refuse', 'abuse_events', 'target_id = ANY($1)',
       (SELECT count(*) FROM public.abuse_events WHERE target_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.abuse_events WHERE target_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (20, 'refuse', 'entity_grants', 'target_id = ANY($1)',
       (SELECT count(*) FROM public.entity_grants WHERE target_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_grants WHERE target_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (21, 'refuse', 'external_source_refs', 'entity_type = ''official'' AND entity_id = ANY($1)',
       (SELECT count(*) FROM public.external_source_refs WHERE entity_type = 'official' AND entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.external_source_refs WHERE entity_type = 'official' AND entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (22, 'refuse', 'external_relationships', 'from_type = ''official'' AND from_id = ANY($1)',
       (SELECT count(*) FROM public.external_relationships WHERE from_type = 'official' AND from_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.external_relationships WHERE from_type = 'official' AND from_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (23, 'refuse', 'external_relationships', 'to_type = ''official'' AND to_id = ANY($1)',
       (SELECT count(*) FROM public.external_relationships WHERE to_type = 'official' AND to_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.external_relationships WHERE to_type = 'official' AND to_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (24, 'refuse', 'evidence_cards', 'from_id = ANY($1) OR to_id = ANY($1)',
       (SELECT count(*) FROM public.evidence_cards WHERE from_id = ANY((SELECT victims FROM v)::uuid[]) OR to_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.evidence_cards WHERE from_id = ANY((SELECT keepers FROM v)::uuid[]) OR to_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (25, 'refuse', 'ai_summary_cache', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.ai_summary_cache WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.ai_summary_cache WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (26, 'refuse', 'career_history', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.career_history WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.career_history WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (27, 'refuse', 'promises', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.promises WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.promises WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (28, 'refuse', 'lobbying_disclosures', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.lobbying_disclosures WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.lobbying_disclosures WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (29, 'refuse', 'proposal_cosponsors', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.proposal_cosponsors WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.proposal_cosponsors WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (30, 'refuse', 'official_committee_memberships', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_committee_memberships WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_committee_memberships WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (31, 'refuse', 'official_content_ids', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_content_ids WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_content_ids WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (32, 'refuse', 'bill_details', 'primary_sponsor_id = ANY($1)',
       (SELECT count(*) FROM public.bill_details WHERE primary_sponsor_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.bill_details WHERE primary_sponsor_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (33, 'refuse', 'proposal_actions', 'performed_by_id = ANY($1)',
       (SELECT count(*) FROM public.proposal_actions WHERE performed_by_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.proposal_actions WHERE performed_by_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (34, 'refuse', 'official_vote_stats', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_vote_stats WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_vote_stats WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (35, 'refuse', 'official_donor_totals', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_donor_totals WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_donor_totals WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (36, 'refuse', 'entity_activity_state', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_activity_state WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_activity_state WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (37, 'refuse', 'page_views', 'entity_type = ''official'' AND entity_id = ANY($1)',
       (SELECT count(*) FROM public.page_views WHERE entity_type = 'official' AND entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.page_views WHERE entity_type = 'official' AND entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (38, 'refuse', 'official_donor_rollup_mv', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_donor_rollup_mv WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_donor_rollup_mv WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (39, 'refuse', 'official_donor_bracket_totals', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_donor_bracket_totals WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_donor_bracket_totals WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (40, 'refuse', 'official_sector_affinity_rollup', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_sector_affinity_rollup WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_sector_affinity_rollup WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (41, 'refuse', 'official_small_dollar_rollup', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_small_dollar_rollup WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_small_dollar_rollup WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (42, 'refuse', 'entity_connection_stats_mv', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_connection_stats_mv WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_connection_stats_mv WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (43, 'refuse', 'synthetic_position_rollup', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.synthetic_position_rollup WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.synthetic_position_rollup WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (44, 'refuse', 'official_sector_dollars_mv', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_sector_dollars_mv WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_sector_dollars_mv WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (45, 'refuse', 'entity_engagement_rollup_mv', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_engagement_rollup_mv WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_engagement_rollup_mv WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (46, 'refuse', 'commons_active_threads', 'entity_id = ANY($1)',
       (SELECT count(*) FROM public.commons_active_threads WHERE entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.commons_active_threads WHERE entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (47, 'refuse', 'franklin_seed_map', 'row_id = ANY($1)',
       (SELECT count(*) FROM public.franklin_seed_map WHERE row_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.franklin_seed_map WHERE row_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (48, 'check', 'official_homepage_stats_mv', 'official_id = ANY($1)',
       (SELECT count(*) FROM public.official_homepage_stats_mv WHERE official_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.official_homepage_stats_mv WHERE official_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (49, 'repoint', 'irs990_officers', 'matched_entity_type = ''official'' AND matched_entity_id = ANY($1)',
       (SELECT count(*) FROM public.irs990_officers WHERE matched_entity_type = 'official' AND matched_entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.irs990_officers WHERE matched_entity_type = 'official' AND matched_entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (50, 'repoint', 'irs990_grants_out', 'matched_entity_type = ''official'' AND matched_entity_id = ANY($1)',
       (SELECT count(*) FROM public.irs990_grants_out WHERE matched_entity_type = 'official' AND matched_entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.irs990_grants_out WHERE matched_entity_type = 'official' AND matched_entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (51, 'delete', 'entity_tags', 'entity_type = ''official'' AND entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_tags WHERE entity_type = 'official' AND entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_tags WHERE entity_type = 'official' AND entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (52, 'delete', 'entity_search_index', 'kind = ''official'' AND entity_id = ANY($1)',
       (SELECT count(*) FROM public.entity_search_index WHERE kind = 'official' AND entity_id = ANY((SELECT victims FROM v)::uuid[])),
       (SELECT count(*) FROM public.entity_search_index WHERE kind = 'official' AND entity_id = ANY((SELECT keepers FROM v)::uuid[]))),
  (53, 'delete', 'enrichment_queue', 'entity_type = ''official'' AND entity_id = ANY($1::text[])',
       (SELECT count(*) FROM public.enrichment_queue WHERE entity_type = 'official' AND entity_id = ANY((SELECT victims FROM v)::uuid[]::text[])),
       (SELECT count(*) FROM public.enrichment_queue WHERE entity_type = 'official' AND entity_id = ANY((SELECT keepers FROM v)::uuid[]::text[])))
)
SELECT section, name, role, pred, victims, keepers, detail
  FROM (
    SELECT 1 AS sec, 0 AS ord, 'seed' AS section, seed AS name, NULL::text AS role,
           NULL::text AS pred,
           count(*) FILTER (WHERE rn > 1) AS victims,
           count(*) FILTER (WHERE rn = 1) AS keepers,
           jsonb_build_object(
             'keeper_id',           (array_agg(id) FILTER (WHERE rn = 1))[1],
             'keeper_created_at',   min(created_at) FILTER (WHERE rn = 1),
             'keeper_updated_at',   max(updated_at) FILTER (WHERE rn = 1),
             'victims_first_created',  min(created_at) FILTER (WHERE rn > 1),
             'victims_newest_created', max(created_at) FILTER (WHERE rn > 1)) AS detail
      FROM s
     GROUP BY seed
    UNION ALL
    SELECT 2, ord, 'ref', tbl, role, pred, victims, keepers, NULL
      FROM refs
    UNION ALL
    SELECT 3, 0, 'mv', s.seed, CASE WHEN s.rn > 1 THEN 'victims' ELSE 'keeper' END, NULL,
           count(m.official_id) FILTER (WHERE s.rn > 1),
           count(m.official_id) FILTER (WHERE s.rn = 1),
           jsonb_build_object(
             'max_vote_count',            max(m.vote_count),
             'max_donor_count',           max(m.donor_count),
             'max_total_donations_cents', max(m.total_donations_cents),
             'refreshed_at_min',          min(m.refreshed_at),
             'refreshed_at_max',          max(m.refreshed_at))
      FROM s
      LEFT JOIN public.official_homepage_stats_mv m ON m.official_id = s.id
     GROUP BY s.seed, s.rn > 1
    UNION ALL
    SELECT 4, 0, '990', o.person_name, 'irs990_officers', o.role_title, 1, NULL,
           jsonb_build_object('id', o.id, 'filing_id', o.filing_id,
                              'matched_entity_id', o.matched_entity_id,
                              'match_confidence', o.match_confidence,
                              'seed', vs.seed, 'keeper_id', k.id)
      FROM public.irs990_officers o
      JOIN s vs ON vs.id = o.matched_entity_id AND vs.rn > 1
      JOIN s k  ON k.seed = vs.seed AND k.rn = 1
     WHERE o.matched_entity_type = 'official'
       AND o.matched_entity_id = ANY((SELECT victims FROM v)::uuid[])
    UNION ALL
    SELECT 4, 1, '990', g.recipient_name, 'irs990_grants_out', NULL, 1, NULL,
           jsonb_build_object('id', g.id, 'filing_id', g.filing_id,
                              'matched_entity_id', g.matched_entity_id,
                              'amount_cents', g.amount_cents,
                              'seed', vs.seed, 'keeper_id', k.id)
      FROM public.irs990_grants_out g
      JOIN s vs ON vs.id = g.matched_entity_id AND vs.rn > 1
      JOIN s k  ON k.seed = vs.seed AND k.rn = 1
     WHERE g.matched_entity_type = 'official'
       AND g.matched_entity_id = ANY((SELECT victims FROM v)::uuid[])
  ) x
 ORDER BY sec, ord, name, role;
