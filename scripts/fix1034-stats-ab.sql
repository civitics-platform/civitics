-- FIX-1034 — before/after EXPLAIN gate for the two planner-statistics defects.
--
-- Run by scripts/fix1034-stats-ab.mjs. In --dry mode the whole file executes
-- inside ONE transaction that is ROLLED BACK, so prod sees no lasting change:
-- CREATE STATISTICS, ALTER TABLE ... SET (n_distinct = ...) and ANALYZE are all
-- transactional (unlike VACUUM), and ANALYZE's pg_statistic rows are visible to
-- the transaction that wrote them. That gives a true A/B on live prod data at
-- zero risk, which is the only way to satisfy FIX-1034's own landing gate:
-- "land only if none regresses".
--
-- EXPLAIN is deliberately WITHOUT ANALYZE. The gate is on estimated cost and
-- plan SHAPE, and running the real work twice on 8.5 GB of heap would cost more
-- than the fix. Shape is what actually matters here: the 2026-08-11/08-13
-- incidents were a Memoize-backed nested loop displacing a hash join.
--
-- Params are concrete prod ids (top-3 officials by rollup rows, top-5 donors by
-- donation count) so both passes plan against identical inputs.

\timing on
\set ON_ERROR_STOP on

\set OFFICIALS '''579fcb44-1f5d-46f6-b69e-7c047638833d''::uuid, ''1f7033e4-bfa5-409b-9011-58e5e6efe93a''::uuid, ''6282bdaf-b436-463a-b6d2-cf71c165148d''::uuid'
\set DONORS '''04b3a83a-3307-4449-9216-9927c52b062a''::uuid, ''016861e2-e928-4008-ab8f-f51725b5e2db''::uuid, ''7e59c437-b5bf-4b34-a553-96313a13ffc1''::uuid, ''50ced8e6-0820-4822-bd95-8f8811641182''::uuid, ''b90b98c0-5f3b-4dfd-99be-3aeafee6c4a4''::uuid'
\set ONE_OFFICIAL '''579fcb44-1f5d-46f6-b69e-7c047638833d''::uuid'

-- The EC rebuild joins FR against an UNLOGGED/temp dirty set that only exists
-- inside run_entity_connections_rebuild(). Recreate its shape so Q7 plans the
-- same join it plans in production rather than a fabricated one.
-- IF NOT EXISTS: this file is included TWICE in one transaction by the A/B
-- runner (baseline pass, then after pass), so the second include must be a
-- no-op here rather than an error.
CREATE TEMP TABLE IF NOT EXISTS _dirty_from_ids (from_type text, from_id uuid);
TRUNCATE _dirty_from_ids;
INSERT INTO _dirty_from_ids (from_type, from_id)
SELECT 'financial_entity', x FROM unnest(ARRAY[:DONORS]) AS x;
ANALYZE _dirty_from_ids;

\echo ''
\echo '################ Q1 — chord unit 3, FIX-1030 fenced (the MV as it ships) ################'
EXPLAIN
WITH donor_states AS MATERIALIZED (
  SELECT fe.id AS fe_id, upper(fe.metadata ->> 'state') AS donor_state
  FROM financial_entities fe
  WHERE length(fe.metadata ->> 'state') = 2
)
SELECT ds.donor_state,
       concat_ws(' ', initcap(COALESCE(o.party::text, 'other')),
                 CASE WHEN o.role_title ILIKE '%representative%' THEN 'House' ELSE 'Senate' END) AS party_chamber,
       sum(fr.amount_cents) / 100.0 AS total_usd
FROM financial_relationships fr
JOIN officials o ON o.id = fr.to_id AND fr.to_type = 'official'
JOIN donor_states ds ON ds.fe_id = fr.from_id AND fr.from_type = 'financial_entity'
WHERE fr.relationship_type = 'donation' AND fr.amount_cents > 0
  AND (o.source_ids ->> 'congress_gov') IS NOT NULL
GROUP BY 1, 2;

\echo ''
\echo '################ Q2 — chord unit 3 UNFENCED (the shape that wedged prod) ################'
EXPLAIN
WITH donor_states AS (
  SELECT fe.id AS fe_id, upper(fe.metadata ->> 'state') AS donor_state
  FROM financial_entities fe
  WHERE length(fe.metadata ->> 'state') = 2
)
SELECT ds.donor_state,
       concat_ws(' ', initcap(COALESCE(o.party::text, 'other')),
                 CASE WHEN o.role_title ILIKE '%representative%' THEN 'House' ELSE 'Senate' END) AS party_chamber,
       sum(fr.amount_cents) / 100.0 AS total_usd
FROM financial_relationships fr
JOIN officials o ON o.id = fr.to_id AND fr.to_type = 'official'
JOIN donor_states ds ON ds.fe_id = fr.from_id AND fr.from_type = 'financial_entity'
WHERE fr.relationship_type = 'donation' AND fr.amount_cents > 0
  AND (o.source_ids ->> 'congress_gov') IS NOT NULL
GROUP BY 1, 2;

\echo ''
\echo '################ Q3 — donor_party_rollup_rebuild_donors: agg (from_id = ANY) ################'
EXPLAIN
SELECT fr.from_id AS donor_id, COALESCE(o.party::text, 'unknown') AS party_key,
       SUM(fr.amount_cents)::bigint AS total_cents, COUNT(*)::bigint AS tx_count
FROM public.financial_relationships fr
JOIN public.officials o ON o.id = fr.to_id AND fr.to_type = 'official'
WHERE fr.relationship_type = 'donation'
  AND fr.from_type = 'financial_entity'
  AND fr.from_id = ANY (ARRAY[:DONORS])
GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown');

\echo ''
\echo '################ Q4 — donor_rollup arm 1: per_donor (to_id = ANY) ################'
EXPLAIN
SELECT fr.to_id AS official_id, fr.relationship_type::text AS relationship_type,
       fr.from_id AS donor_id, SUM(fr.amount_cents)::bigint AS total_cents,
       COUNT(*)::bigint AS tx_count
FROM public.financial_relationships fr
WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
  AND fr.from_type = 'financial_entity'
  AND fr.to_id = ANY (ARRAY[:OFFICIALS])
GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

\echo ''
\echo '################ Q5 — donor_rollup arm 2: official_donor_totals (FR LEFT JOIN FE) ################'
EXPLAIN
SELECT fr.to_id,
       SUM(COALESCE(fr.amount_cents, 0))::bigint,
       (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
       (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
       COUNT(*)::bigint
FROM public.financial_relationships fr
LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id
WHERE fr.to_type = 'official' AND fr.relationship_type = 'donation'
  AND fr.to_id = ANY (ARRAY[:OFFICIALS])
GROUP BY fr.to_id;

\echo ''
\echo '################ Q6 — treemap_individuals_rebuild_officials (FR JOIN FE individual) ################'
EXPLAIN
SELECT fr.to_id AS scope_id, COALESCE(fe.metadata->>'state', '??') AS state,
       fe.display_name AS donor_name, SUM(fr.amount_cents)::bigint AS total_cents,
       COUNT(*)::bigint AS donation_count
FROM public.financial_relationships fr
JOIN public.financial_entities fe ON fe.id = fr.from_id AND fe.entity_type = 'individual'
WHERE fr.relationship_type = 'donation' AND fr.from_type = 'financial_entity'
  AND fr.to_type = 'official' AND fr.amount_cents > 0
  AND fr.to_id = ANY (ARRAY[:OFFICIALS])
GROUP BY fr.to_id, COALESCE(fe.metadata->>'state', '??'), fe.display_name;

\echo ''
\echo '################ Q7 — rebuild_entity_connections_donations (FR JOIN dirty set) ################'
EXPLAIN
SELECT fr.from_type, fr.from_id, fr.to_type, fr.to_id,
       COUNT(*) AS evidence_count, SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
       MIN(fr.occurred_at) AS first_at, MAX(fr.occurred_at) AS last_at,
       (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
FROM public.financial_relationships fr
INNER JOIN _dirty_from_ids d ON d.from_type = fr.from_type AND d.from_id = fr.from_id
WHERE fr.relationship_type IN ('donation', 'ie_support')
GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id;

\echo ''
\echo '################ Q8 — chord_industry_flows_for_official (request-path RPC) ################'
EXPLAIN
WITH donor_industry AS (
  SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag, et.display_label, et.display_icon
  FROM public.entity_tags et
  WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
  ORDER BY et.entity_id, et.tag
)
SELECT COALESCE(di.tag, 'untagged') AS industry,
       COALESCE(MAX(di.display_label), 'Untagged') AS display_label,
       COALESCE(MAX(NULLIF(di.display_icon, '')), '') AS display_icon,
       SUM(fr.amount_cents)::BIGINT AS total_cents,
       COUNT(DISTINCT fe.id)::BIGINT AS donor_count
FROM public.financial_relationships fr
JOIN public.financial_entities fe ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
LEFT JOIN donor_industry di ON di.entity_id = fe.id
WHERE fr.relationship_type = 'donation' AND fr.to_type = 'official'
  AND fr.to_id = :ONE_OFFICIAL AND fr.amount_cents > 0
GROUP BY COALESCE(di.tag, 'untagged')
ORDER BY total_cents DESC;

\echo ''
\echo '################ Q9 — unrestricted FR x FE join (the generic risk surface) ################'
EXPLAIN
SELECT fe.entity_type, COUNT(*), SUM(fr.amount_cents)
FROM public.financial_relationships fr
JOIN public.financial_entities fe ON fe.id = fr.from_id
WHERE fr.relationship_type = 'donation' AND fr.from_type = 'financial_entity'
GROUP BY fe.entity_type;

\echo ''
\echo '################ Q10 — FR x FE with the FE state expression (both defects at once) ################'
EXPLAIN
SELECT upper(fe.metadata->>'state') AS st, COUNT(*), SUM(fr.amount_cents)
FROM public.financial_relationships fr
JOIN public.financial_entities fe ON fe.id = fr.from_id
WHERE fr.relationship_type = 'donation' AND fr.from_type = 'financial_entity'
  AND length(fe.metadata->>'state') = 2
GROUP BY upper(fe.metadata->>'state');
