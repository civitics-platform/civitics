-- =============================================================================
-- 20260528180300_follow_entity_type_add_jurisdiction.sql
-- FIX-F (1/2): allow following a jurisdiction.
--
-- The follow_entity_type enum (20260418200000_community_auth.sql) shipped as
-- ('official', 'agency'). The /jurisdictions/[id] hub adds a Follow button, so
-- 'jurisdiction' becomes a valid follow target. user_follows.entity_id is a bare
-- UUID (no FK), so no constraint work is needed — only the enum widens.
--
-- WHY ITS OWN MIGRATION:
--   Postgres forbids USING a newly-added enum value in the same transaction it
--   was added. Nothing here uses it yet, but the repo convention (see
--   20260528180000) is to isolate ADD VALUE so it COMMITs before any consumer
--   migration runs. Portable across local Docker and Pro.
-- =============================================================================

ALTER TYPE public.follow_entity_type ADD VALUE IF NOT EXISTS 'jurisdiction';
