-- =============================================================================
-- 20260528180000_jurisdiction_type_add_values.sql
-- FIX-E (1/3): Add two jurisdiction_type enum values.
--
--   federal_district          → the District of Columbia (Article I §8).
--   unincorporated_territory  → PR, VI, GU, AS, MP.
--
-- Both currently sit in the catch-all 'district' bucket alongside the ~6,775
-- real legislative / congressional districts. The re-typing UPDATEs live in the
-- NEXT migration (20260528180100), NOT here.
--
-- WHY ITS OWN MIGRATION:
--   Postgres forbids USING a newly-added enum value in the same transaction it
--   was added ("unsafe use of new value of enum type"). Supabase's migration
--   runner wraps each file in a single transaction, so the ADD VALUE statements
--   must COMMIT (i.e. finish this file) before any UPDATE can reference them.
--   Splitting the bundle across files is the portable fix — works identically
--   on local Docker and Pro.
--
-- 'county' already exists in the enum (0001_initial_schema.sql) — not re-added.
-- =============================================================================

ALTER TYPE public.jurisdiction_type ADD VALUE IF NOT EXISTS 'federal_district';
ALTER TYPE public.jurisdiction_type ADD VALUE IF NOT EXISTS 'unincorporated_territory';
