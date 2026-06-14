-- FIX-577 (Investigations MVP PR1 of 3): add 'investigation_evidence' to the
-- flag_content_type enum.
--
-- Its own migration, separate from any usage, per the project pattern (mirrors
-- 20260608010000_flag_content_type_entity_statement.sql) — Postgres cannot add a
-- new enum value AND use it in the same transaction. PR1 only RESERVES the value;
-- the dispute → content_flags → needs_review autotrip wiring lands in PR3 (§8 of
-- Claude/civitics/design-investigations-mvp.md).
--
-- Replay-safe: ADD VALUE IF NOT EXISTS.

ALTER TYPE public.flag_content_type ADD VALUE IF NOT EXISTS 'investigation_evidence';
