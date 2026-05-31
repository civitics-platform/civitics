-- 20260531000200_enrichment_queue_entity_type_check.sql
-- FIX-391: lock the enrichment_queue.entity_type discriminator with a CHECK
-- constraint and refresh the stale schema comment.
--
-- The original table (20260420030000_enrichment_queue.sql:11) commented
-- entity_type as `-- 'proposal' | 'official'`, but the queue legitimately
-- holds four values in prod: proposal, official, financial_entity, agency.
-- Writers exist for all four (congress/openstates → proposal; agency-leadership
-- monthly pass → agency + official; enrichment/seed-backlog.ts → financial_entity
-- industry tags; drain/apply.ts maps financial_entity → 'industry' tag category).
-- The data shape was already correct; this migration just enforces it going
-- forward and documents it.
--
-- Pre-flight confirmed (read-only) on BOTH envs at apply time
-- (`SELECT entity_type, count(*) FROM enrichment_queue GROUP BY 1`):
--   local: financial_entity, proposal, agency, official        (4 values)
--   prod : proposal, official, financial_entity, agency        (4 values)
-- so the validating ADD CONSTRAINT touches only conforming rows and cannot fail.
--
-- Additive + idempotent. Out of scope (deferred per FIX-391): the entity_id
-- TEXT→UUID migration.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'enrichment_queue_entity_type_check'
       AND conrelid = 'public.enrichment_queue'::regclass
  ) THEN
    ALTER TABLE public.enrichment_queue
      ADD CONSTRAINT enrichment_queue_entity_type_check
      CHECK (entity_type IN ('proposal', 'official', 'financial_entity', 'agency'));
  END IF;
END $$;

COMMENT ON COLUMN public.enrichment_queue.entity_type IS
  'Enrichment target discriminator, CHECK-enforced (FIX-391). One of: '
  '''proposal'' | ''official'' | ''financial_entity'' | ''agency''. '
  'Writers: congress/openstates (proposal), agency-leadership monthly pass '
  '(agency, official), enrichment/seed-backlog.ts (financial_entity industry tags).';
