-- =============================================================================
-- FIX-240 — Add ie_support / ie_oppose to financial_relationship_type
--
-- These two new enum values are the discriminator for FEC Schedule E
-- (independent expenditures). The existing 4-column unique arbiter on
-- (relationship_type, from_id, to_id, cycle_year) naturally keeps S and O
-- rows distinct because relationship_type differs — no new column, no new
-- index needed. Raw 'S'/'O' from FEC still rides in metadata.support_oppose
-- for downstream consumers that want to render the distinction.
--
-- The accompanying CREATE OR REPLACE FUNCTION lives in the next migration
-- (20260510000001) so the enum value is committed before any plpgsql body
-- references it. Splitting also matches the project's prior pattern
-- (e.g. migration 0020 only adds enum values, function changes ship later).
-- =============================================================================

ALTER TYPE public.financial_relationship_type ADD VALUE IF NOT EXISTS 'ie_support';
ALTER TYPE public.financial_relationship_type ADD VALUE IF NOT EXISTS 'ie_oppose';
