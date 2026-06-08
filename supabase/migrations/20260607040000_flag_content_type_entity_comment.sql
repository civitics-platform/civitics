-- FIX-519 (C0): extend flag_content_type with 'entity_comment'.
--
-- This lives in its OWN migration on purpose: an enum value added by
-- ALTER TYPE ... ADD VALUE cannot be referenced by other statements inside
-- the SAME transaction. The Supabase CLI runs each migration file in its own
-- transaction, so isolating the ADD VALUE here lets the substrate migration
-- (20260607050000) reference 'entity_comment' in trigger bodies and the flag
-- backfill.
--
-- The unified comments substrate routes all comment flags through the shared
-- content_flags table, so the discriminator needs a label for the new
-- entity_comments rows.

ALTER TYPE flag_content_type ADD VALUE IF NOT EXISTS 'entity_comment';
