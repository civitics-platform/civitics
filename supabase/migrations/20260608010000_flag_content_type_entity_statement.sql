-- FIX-533 (C1 Wave C): add 'entity_statement' to the flag_content_type enum.
--
-- Statement-mode statements reuse the existing content_flags → auto-needs_review
-- machinery (decision 9). New enum VALUEs must be added in their OWN migration /
-- transaction so the value is committed before any later migration references it
-- as a literal (the statement_mode migration's autotrip trigger body does).
--
-- Idempotent + replay-safe: ADD VALUE IF NOT EXISTS no-ops if already present.
ALTER TYPE public.flag_content_type ADD VALUE IF NOT EXISTS 'entity_statement';
