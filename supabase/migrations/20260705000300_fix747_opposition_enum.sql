-- FIX-747 — add 'opposition' to the connection_type enum.
--
-- ie_oppose financial_relationships (FEC Schedule E "O" — independent
-- expenditures made AGAINST a candidate, ~1,702 rows) had no entity_connections
-- edge class: the donation derivation aggregates relationship_type IN
-- ('donation','ie_support') → 'donation' and silently dropped ie_oppose. This
-- migration adds the enum value; the accompanying derivation (map ie_oppose →
-- 'opposition') lives in the NEXT migration (20260705000400) so the value is
-- committed before any function body references it — the same split the FEC IE
-- enum values used (20260510000003 → …0001). ADD VALUE also cannot run inside a
-- txn block with `IF NOT EXISTS` on some tooling, so keep it isolated.

ALTER TYPE public.connection_type ADD VALUE IF NOT EXISTS 'opposition';
