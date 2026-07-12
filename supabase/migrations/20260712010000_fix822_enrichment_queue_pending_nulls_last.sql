-- FIX-822 — align both pending indexes' entity_updated_at to DESC NULLS LAST so
-- claim_enrichment_batch's ORDER BY is index-satisfied (drops the Incremental
-- Sort). The claim (20260424020000_enrichment_queue_recency) runs:
--   ORDER BY priority DESC, entity_updated_at DESC NULLS LAST
-- but idx_enrichment_queue_pending_by_task (FIX-820) and idx_enrichment_queue_pending
-- both declare entity_updated_at DESC = NULLS FIRST (the DESC default). Postgres
-- index-order matching keys on null placement and won't fold the two even though
-- entity_updated_at is NOT NULL, leaving a residual (harmless) Incremental Sort
-- node. Realigning both to DESC NULLS LAST makes the ORDER BY fully index-ordered.
DROP INDEX IF EXISTS public.idx_enrichment_queue_pending_by_task;
CREATE INDEX idx_enrichment_queue_pending_by_task
  ON public.enrichment_queue (task_type, priority DESC, entity_updated_at DESC NULLS LAST)
  WHERE status = 'pending';

DROP INDEX IF EXISTS public.idx_enrichment_queue_pending;
CREATE INDEX idx_enrichment_queue_pending
  ON public.enrichment_queue (priority DESC, entity_updated_at DESC NULLS LAST)
  WHERE status = 'pending';
