-- =============================================================================
-- FIX-253 follow-on · Prefix-friendly index on financial_entities.donor_fingerprint
--
-- The FIX-239 UNIQUE index on donor_fingerprint (added in
-- 20260502120000_financial_entities_donor_fingerprint.sql) is plain btree.
-- Under the default en_US.UTF-8 collation Postgres can't use that index for
-- LIKE 'prefix%' scans, so the FIX-253 EDGAR matcher's
--   donor_fingerprint LIKE '<name>|%'
-- query degrades to a seq scan over 558k rows on prod. Common surnames
-- (ADAMS KATE, KHAN SABIH, etc.) hit the 5s statement_timeout.
--
-- text_pattern_ops makes the index byte-wise — exactly what LIKE 'X%' needs.
-- The existing UNIQUE index stays in place; queries on `=` keep using it.
-- =============================================================================

CREATE INDEX IF NOT EXISTS financial_entities_donor_fingerprint_pattern
  ON public.financial_entities (donor_fingerprint text_pattern_ops);
