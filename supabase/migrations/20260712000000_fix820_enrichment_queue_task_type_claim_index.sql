-- FIX-820 — enrichment_queue drain throughput + maintenance.
--
-- (B) task_type-leading pending index so claim_enrichment_batch seeks directly
--     to one task's pending rows instead of scanning the whole pending partition
--     and filtering task_type. The claim (20260424020000_enrichment_queue_recency)
--     runs:
--       SELECT id FROM enrichment_queue
--        WHERE status='pending' AND task_type=$1
--        ORDER BY priority DESC, entity_updated_at DESC NULLS LAST
--        LIMIT $2 FOR UPDATE SKIP LOCKED
--     The only pending index today is idx_enrichment_queue_pending
--     (priority DESC, entity_updated_at DESC) WHERE status='pending' — it does
--     NOT include task_type, so a per-task claim scans+filters the whole pending
--     partition (~140k rows). A task_type-leading partial index lets the claim
--     seek one task's pending rows already in priority order.
--
--     We deliberately do NOT drop idx_enrichment_queue_pending here: a redundant
--     partial index on a 150k-row table is cheap, and a task_type-agnostic
--     consumer may still use it. Any prune is a separate follow-up FIX.
CREATE INDEX IF NOT EXISTS idx_enrichment_queue_pending_by_task
  ON public.enrichment_queue (task_type, priority DESC, entity_updated_at DESC)
  WHERE status = 'pending';

-- (A-durable) Tighten per-table autovacuum thresholds. On prod (2026-07-12) this
-- table had never been autovacuumed or analyzed (autovacuum_count=0,
-- last_analyze NULL) despite ~150k rows and heavy claim/submit status churn,
-- leaving stale planner stats and ~50% dead-tuple bloat. Default scale factor
-- 0.2 tolerates ~30k dead tuples on this table before firing; 0.05 vacuum /
-- 0.02 analyze make maintenance fire an order of magnitude sooner so the churn
-- can't re-accumulate to the disk-bound state that stalled nightly staging.
-- (The one-time VACUUM (ANALYZE) that reclaims the existing bloat cannot live in
-- a migration — VACUUM can't run inside a transaction — and is run out-of-band.)
ALTER TABLE public.enrichment_queue
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
