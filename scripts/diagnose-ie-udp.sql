-- diagnose-ie-udp.sql — read-only diagnostics for FIX-A (UDP IE target list reconcile)
-- + FIX-669 ('U' committee mapping scope). All SELECTs — safe on prod.

-- (1) Duplicate-entity check — expect exactly ONE row
SELECT id, display_name, entity_type,
       total_ie_support_cents/100.0 AS sup_usd,
       total_ie_oppose_cents/100.0  AS opp_usd
FROM financial_entities
WHERE fec_committee_id = 'C00799031' OR display_name ILIKE '%united democracy%';

-- (2) Raw IE rows + distinct targets for UDP's entity id(s), by type & cycle
SELECT relationship_type, cycle_year,
       count(*) AS rows, count(DISTINCT to_id) AS distinct_targets,
       SUM(amount_cents)/100.0 AS usd
FROM financial_relationships
WHERE from_type='financial_entity'
  AND from_id IN (SELECT id FROM financial_entities WHERE fec_committee_id='C00799031')
  AND relationship_type IN ('ie_support','ie_oppose')
GROUP BY 1,2 ORDER BY 1,2;

-- (3) Badge count the page WOULD render (distinct to_id per direction)
SELECT relationship_type, count(DISTINCT to_id) AS unique_target_badges
FROM financial_relationships
WHERE from_type='financial_entity'
  AND from_id IN (SELECT id FROM financial_entities WHERE fec_committee_id='C00799031')
  AND relationship_type IN ('ie_support','ie_oppose')
GROUP BY 1;

-- (4) FIX-669 scope: count 'other'-typed entities that are IE spenders
SELECT count(*) AS other_ie_entities
FROM financial_entities fe
WHERE fe.entity_type='other'
  AND EXISTS (SELECT 1 FROM financial_relationships fr
              WHERE fr.from_type='financial_entity' AND fr.from_id=fe.id
                AND fr.relationship_type IN ('ie_support','ie_oppose'));
