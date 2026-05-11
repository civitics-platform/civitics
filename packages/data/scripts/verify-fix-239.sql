-- Verification queries for FIX-239 Layer 1 + FIX-244.
-- Run with:  psql "$SUPABASE_DB_URL" -f packages/data/scripts/verify-fix-239.sql
--
-- §2.3 anchor cases — expected to collapse: 1 row each (MR-only variants merged).
-- §2.4 anchor cases — expected to stay split: ≥ 2 rows each.
-- Invariants — must hold post-migration.

\echo
\echo === §2.3 anchor cases (should collapse) ===

\echo --- MCKEE JACK 37363 ---
SELECT count(*) AS row_count, sum(total_donated_cents)/100.0 AS total_dollars
FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'MCKEE JACK%' AND metadata->>'zip5'='37363';

\echo --- SCHWARZMAN STEPHEN 10154 ---
SELECT count(*), sum(total_donated_cents)/100.0
FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'SCHWARZMAN STEPHEN%' AND metadata->>'zip5'='10154';

\echo --- WINKLEVOSS CAMERON 10010 ---
SELECT count(*), sum(total_donated_cents)/100.0
FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'WINKLEVOSS CAMERON%' AND metadata->>'zip5'='10010';

\echo --- CHILDS JOHN 32963 ---
SELECT count(*), sum(total_donated_cents)/100.0
FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'CHILDS JOHN%' AND metadata->>'zip5'='32963';

\echo --- LEVY EDWARD 48009 ---
SELECT count(*), sum(total_donated_cents)/100.0
FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'LEVY EDWARD%' AND metadata->>'zip5'='48009';

\echo
\echo === §2.4 anchor cases (should stay split) ===

\echo --- PEROT ROSS 75219 ---
SELECT canonical_name, count(*) FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'PEROT ROSS%' AND metadata->>'zip5'='75219'
GROUP BY canonical_name ORDER BY canonical_name;

\echo --- SMITH WILLIAM 03854 ---
SELECT canonical_name, count(*) FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'SMITH WILLIAM%' AND metadata->>'zip5'='03854'
GROUP BY canonical_name ORDER BY canonical_name;

\echo --- TAYLOR ROBERT 37027 ---
SELECT canonical_name, count(*) FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'TAYLOR ROBERT%' AND metadata->>'zip5'='37027'
GROUP BY canonical_name ORDER BY canonical_name;

\echo --- O'BRIEN (now OBRIEN) 20007 ---
SELECT canonical_name, count(*) FROM financial_entities
WHERE entity_type='individual' AND canonical_name LIKE 'OBRIEN%' AND metadata->>'zip5'='20007'
GROUP BY canonical_name ORDER BY canonical_name;

\echo
\echo === Invariants ===

\echo --- 0a. donor_fingerprint UNIQUE holds (zero output expected) ---
SELECT donor_fingerprint, count(*) FROM financial_entities
WHERE entity_type='individual' AND donor_fingerprint IS NOT NULL
GROUP BY 1 HAVING count(*) > 1 LIMIT 5;

\echo --- 0b. No orphan from_id pointing at deleted donors ---
SELECT count(*) AS orphan_count FROM financial_relationships fr
WHERE fr.from_type='financial_entity'
  AND NOT EXISTS (SELECT 1 FROM financial_entities fe WHERE fe.id = fr.from_id);

\echo --- 0c. relcycle UNIQUE holds (zero output expected) ---
SELECT relationship_type, from_id, to_id, cycle_year, count(*)
FROM financial_relationships
GROUP BY 1,2,3,4 HAVING count(*) > 1 LIMIT 5;

\echo --- 0d. Total individual row count ---
SELECT count(*) AS individuals FROM financial_entities WHERE entity_type='individual';

\echo --- 0e. Apostrophe fix: O'BRIEN should NOT fragment on single 'O' token ---
SELECT count(*) AS leading_O_count FROM financial_entities
WHERE entity_type='individual'
  AND canonical_name ~ '^O ';
-- Pre-fix: ~2,965 rows with leading 'O ' (broken O'BRIEN tokenization).
-- Post-fix: should be 0 (or near-0 — only legitimate "O" names).

\echo --- 0f. Sample new fingerprints for sanity ---
SELECT display_name, canonical_name, donor_fingerprint
FROM financial_entities
WHERE entity_type='individual'
  AND (display_name ILIKE '%musk, elon%' OR display_name ILIKE '%schwarzman, stephen%')
ORDER BY total_donated_cents DESC NULLS LAST
LIMIT 10;
