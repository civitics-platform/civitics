-- FIX-666 verification — super-PAC independent-expenditure (Schedule E) totals.
-- Run: psql "<dsn>" -f scripts/verify-ie-totals.sql

-- UDP entity + all four money columns
SELECT id, display_name, entity_type, fec_committee_id,
       total_donated_cents/100.0     AS donated_usd,
       total_ie_support_cents/100.0  AS ie_support_usd,
       total_ie_oppose_cents/100.0   AS ie_oppose_usd
FROM financial_entities
WHERE fec_committee_id = 'C00799031';

-- Internal consistency: columns must equal the live relationship sums
SELECT relationship_type, count(*), SUM(amount_cents)/100.0 AS usd
FROM financial_relationships
WHERE from_id = (SELECT id FROM financial_entities WHERE fec_committee_id='C00799031')
GROUP BY relationship_type ORDER BY usd DESC;
