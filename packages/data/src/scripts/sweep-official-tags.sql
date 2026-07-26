-- FIX-898 — one-time (idempotent, re-runnable) sweep of the pending official
-- TAG enrichment backlog.
--
-- FIX-896 retired AI issue-area classification for officials. That stops NEW
-- official tag tasks being enqueued (the seed-backlog leg and the ai-tagger
-- queue-mode leg both went with the classifier), but it does not touch the rows
-- already staged. This marks them:
--
--     entity_type='official' AND task_type='tag' AND status='pending'
--         -> status = 'skipped_feature_retired'
--
-- Rows are MARKED, never deleted — see the reverse block at the bottom.
--
-- WHY A DISTINCT STATUS (not FIX-895's 'skipped_no_source_text')
--   'skipped_no_source_text' means "the ENTITY isn't ready yet", and FIX-895's
--   reverse sweep re-enters such a row the moment its entity acquires text —
--   it re-derives eligibility from the text alone and knows nothing about which
--   features exist. If retired official tags carried that status, the first
--   time the source-text reverse sweep widened past proposals it would happily
--   resurrect a retired feature's entire backlog. 'skipped_feature_retired'
--   means "the TASK isn't valid" — no change to the official can make it worth
--   draining, because there is nothing left to drain it into.
--
-- SCOPE — task_type='tag' ONLY.
--   Official SUMMARY tasks are deliberately untouched. Whether an official
--   profile summary is defensible is a separate policy question from whether an
--   issue-area LABEL is, and FIX-896 answered only the second. Prod-measured
--   2026-07-26: 8,886 pending official tag rows, 2,779 pending official summary
--   rows. This sweep touches the first number and must leave the second exactly
--   where it is — the runner asserts that.
--
-- Placeholders: none. This file is parameter-free SQL; the runner selects a
-- block by name (-- @block <name> ... -- @endblock), same as
-- sweep-no-source-text.sql.

\set ON_ERROR_STOP on

-- ===========================================================================
-- BLOCK: forward sweep  (pending -> skipped_feature_retired)
-- ===========================================================================
-- @block forward
UPDATE public.enrichment_queue q
   SET status     = 'skipped_feature_retired',
       claimed_at = NULL,
       claimed_by = NULL,
       last_error = NULL
 WHERE q.entity_type = 'official'
   AND q.task_type   = 'tag'
   AND q.status      = 'pending';
-- @endblock

-- ===========================================================================
-- BLOCK: reverse sweep  (skipped_feature_retired -> pending)
-- ===========================================================================
-- The recoverability path. Unlike FIX-895's reverse sweep — which re-derives
-- eligibility from the entity's text, so it can run unattended — this one is a
-- deliberate policy reversal: it returns EVERY marked official tag row to the
-- queue. Only run it if the decision in FIX-896 is actually reversed, and note
-- that the enqueue legs would have to be restored first or the backlog simply
-- drains into a vocabulary guard that rejects every result (drain/vocabulary.ts
-- `official: {}`).
-- @block reverse
UPDATE public.enrichment_queue q
   SET status     = 'pending',
       claimed_at = NULL,
       claimed_by = NULL,
       last_error = NULL
 WHERE q.entity_type = 'official'
   AND q.task_type   = 'tag'
   AND q.status      = 'skipped_feature_retired';
-- @endblock
