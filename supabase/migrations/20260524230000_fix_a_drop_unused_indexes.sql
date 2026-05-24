-- IOWait Round 2 / FIX-A — Drop unused-and-large indexes identified in
-- audit 2026-05-24 §E (docs/audits/2026-05-24-iowait-diagnosis.md).
--
-- Each candidate was verified `idx_scan = 0` in the audit window and
-- re-verified at ship time via docs/audits/scratch/2026-05-24-round2-preflight.ts
-- against prod (all 7 still idx_scan=0).
--
-- Total working-set shrink: ~1.05 GB (prod sizes captured at ship time
-- shown next to each name). Less index data in shared_buffers leaves more
-- room for the indexes actually backing hot queries → better cache hit
-- rate everywhere, especially on entity_connections + financial_relationships.
--
-- DROP semantics: plain `DROP INDEX IF EXISTS` (transactional) with a
-- 5s lock_timeout. AccessExclusive should acquire near-instantly on an
-- unused index — no in-flight queries reference these. If the timeout
-- fires, the migration fails fast: re-run via Supabase SQL editor with
-- DROP INDEX CONCURRENTLY rather than papering over with a longer wait.
--
-- Excluded from this batch (separate Craig decision): votes_roll_call_id_official_id_key
-- (65 MB UNIQUE constraint, kept for insert-idempotency protection).

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.entity_connections_strength;             -- 468 MB
DROP INDEX IF EXISTS public.financial_relationships_metadata_gin;    -- 246 MB
DROP INDEX IF EXISTS public.entity_connections_amount;               -- 123 MB
DROP INDEX IF EXISTS public.financial_entities_display_trgm_individual; -- 117 MB
DROP INDEX IF EXISTS public.financial_relationships_occurred_at;     --  72 MB
DROP INDEX IF EXISTS public.shadow_proposals_search_vector;          --  12 MB (cutover leftover)
DROP INDEX IF EXISTS public.external_source_refs_metadata_gin;       --  11 MB (cutover leftover)
