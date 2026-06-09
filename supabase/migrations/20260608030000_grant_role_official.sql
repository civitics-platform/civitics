-- FIX-536 (C1 Wave D): grant-spine enum values for the Q&A answer side.
--
-- The 'official' role/target are the minimal slice of the v2 role spine the
-- answer gate needs (see 20260608030100_qa_lane.sql). The full self-serve claim
-- flow (gov-email fast-path, ID review queue, admin approval UI, staff
-- delegation, re-attestation) is the v2 project proper and is OUT OF SCOPE here
-- — 'official' grants are issued MANUALLY by a platform admin via direct SQL in
-- beta, exactly as 'platform_admin' is today.
--
-- These two ALTER TYPE ... ADD VALUE statements MUST live alone in their own
-- migration: a new enum value cannot be referenced (by the helper or the policy)
-- in the same transaction that adds it. IF NOT EXISTS keeps the file replay-safe
-- on an empty DB and idempotent on re-run.

ALTER TYPE public.grant_role        ADD VALUE IF NOT EXISTS 'official';
ALTER TYPE public.grant_target_type ADD VALUE IF NOT EXISTS 'official';
