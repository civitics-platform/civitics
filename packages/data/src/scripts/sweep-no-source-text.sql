-- FIX-895 — one-time (idempotent, re-runnable) sweep of the enrichment backlog.
--
-- Marks currently-PENDING proposal tag/summary rows whose entity holds no usable
-- source text with status = 'skipped_no_source_text'. Rows are MARKED, never
-- deleted, so they stay recoverable — see the reverse sweep at the bottom.
--
-- The predicate MUST stay identical to `hasUsableSourceText()` in
-- packages/data/src/pipelines/enrichment/queue.ts, which is
-- `classifyProposalContext(...) === "full_summary"`:
--
--     length(trim(coalesce(summary_plain,''))) > 100
--     AND lower(trim(summary_plain)) <> lower(trim(title))   -- title masquerade
--
-- If the TS gate and this SQL disagree, the sweep marks rows the gate would
-- re-create (or vice versa) and the backlog oscillates. Change both together.
--
-- Scope: entity_type='proposal' only. Officials and financial entities build
-- their enrichment context from structured aggregates, not prose, so "has source
-- text" is not the right question for them (separate decision — PR 3).
--
-- Placeholders substituted by sweep-no-source-text.ts:
--   :mode        'forward' | 'reverse'  (which statement block runs)
-- This file is parameter-free SQL; the runner selects the block.

\set ON_ERROR_STOP on

-- ===========================================================================
-- BLOCK: forward sweep  (pending -> skipped_no_source_text)
-- ===========================================================================
-- @block forward
UPDATE public.enrichment_queue q
   SET status     = 'skipped_no_source_text',
       claimed_at = NULL,
       claimed_by = NULL,
       last_error = NULL
  FROM public.proposals p
 WHERE p.id = q.entity_id::uuid
   AND q.entity_type = 'proposal'
   AND q.task_type IN ('tag', 'summary')
   AND q.status = 'pending'
   AND NOT (
         length(trim(coalesce(p.summary_plain, ''))) > 100
     AND lower(trim(coalesce(p.summary_plain, ''))) <> lower(trim(coalesce(p.title, '')))
   );
-- @endblock

-- ===========================================================================
-- BLOCK: reverse sweep  (skipped_no_source_text -> pending)
-- ===========================================================================
-- Returns a marked row to the queue once its entity actually acquired text.
-- This is what makes decision 7 ("marked, never deleted") real: nothing is
-- lost, and a Legistar matter that later gains a summary re-enters the queue.
-- @block reverse
UPDATE public.enrichment_queue q
   SET status     = 'pending',
       claimed_at = NULL,
       claimed_by = NULL,
       last_error = NULL
  FROM public.proposals p
 WHERE p.id = q.entity_id::uuid
   AND q.entity_type = 'proposal'
   AND q.task_type IN ('tag', 'summary')
   AND q.status = 'skipped_no_source_text'
   AND length(trim(coalesce(p.summary_plain, ''))) > 100
   AND lower(trim(coalesce(p.summary_plain, ''))) <> lower(trim(coalesce(p.title, '')));
-- @endblock
