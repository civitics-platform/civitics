-- FIX-557: v2 grant-spine enum values — the complete v2 vocabulary, landed in
-- one additive pass so later feature PRs never need an enum-split migration.
--
-- Only the 'official' claim flow ships a consumer in this PR; every other
-- value (verified_human, staff, jurisdiction_admin, institution_admin,
-- institution, id_document, delegation, invitation) is enum-only until a
-- feature consumes it.
--
-- These ALTER TYPE ... ADD VALUE statements MUST live alone in their own
-- migration: a new enum value cannot be referenced in the same transaction
-- that adds it (the FIX-536 precedent, 20260608030000_grant_role_official.sql).
-- IF NOT EXISTS keeps the file replay-safe on an empty DB and idempotent on
-- re-run — 'official' is re-listed harmlessly for completeness.

ALTER TYPE public.grant_role ADD VALUE IF NOT EXISTS 'official';
ALTER TYPE public.grant_role ADD VALUE IF NOT EXISTS 'verified_human';
ALTER TYPE public.grant_role ADD VALUE IF NOT EXISTS 'staff';
ALTER TYPE public.grant_role ADD VALUE IF NOT EXISTS 'jurisdiction_admin';
ALTER TYPE public.grant_role ADD VALUE IF NOT EXISTS 'institution_admin';

ALTER TYPE public.grant_target_type ADD VALUE IF NOT EXISTS 'official';
ALTER TYPE public.grant_target_type ADD VALUE IF NOT EXISTS 'institution';

ALTER TYPE public.evidence_method ADD VALUE IF NOT EXISTS 'gov_email';
ALTER TYPE public.evidence_method ADD VALUE IF NOT EXISTS 'id_document';
ALTER TYPE public.evidence_method ADD VALUE IF NOT EXISTS 'delegation';
ALTER TYPE public.evidence_method ADD VALUE IF NOT EXISTS 'invitation';
