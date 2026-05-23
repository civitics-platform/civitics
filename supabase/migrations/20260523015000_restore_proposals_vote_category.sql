-- 20260523015000_restore_proposals_vote_category.sql
-- FIX-334 — restore proposals.vote_category column lost during the
-- shadow→public promotion (20260422000000).
--
-- Original migration 0019_proposal_vote_category.sql added the column +
-- index + title→category UPDATEs to the legacy public.proposals table.
-- The 20260422000000 promotion DROPped public.proposals and recreated it
-- from shadow.proposals, which had never carried vote_category — so the
-- column has been silently missing on local since the cutover and
-- callers of `.eq("vote_category", ...)` have been getting PostgREST
-- "column not found" errors swallowed by section() wrappers.
--
-- This is a prerequisite for FIX-333 (`get_quality_counts()` RPC) which
-- needs to GROUP BY vote_category. Also fixes a latent runtime failure
-- in `compute_alignment_score` (20260425102000) which references
-- `p.vote_category = 'substantive'`.
--
-- Re-applies the same shape as 0019: column + CHECK constraint + title-
-- pattern UPDATEs + index. Idempotent (IF NOT EXISTS / DEFAULT carries).

ALTER TABLE public.proposals
  ADD COLUMN IF NOT EXISTS vote_category TEXT DEFAULT 'substantive'
    CHECK (vote_category IN ('substantive', 'procedural', 'nomination', 'regulation'));

-- Procedural votes (parliamentary motions)
UPDATE public.proposals SET vote_category = 'procedural'
WHERE title IN (
  'On the Cloture Motion',
  'On Passage',
  'On the Amendment',
  'On the Conference Report',
  'On the Joint Resolution',
  'On the Resolution',
  'On the Motion',
  'On the Motion to Proceed',
  'On the Motion to Table',
  'On Cloture on the Motion',
  'On the Motion to Concur',
  'On Agreeing to the Amendment',
  'On Agreeing to the Resolution'
)
AND vote_category = 'substantive';

-- Nomination votes (judicial/cabinet/ambassador confirmations)
UPDATE public.proposals SET vote_category = 'nomination'
WHERE (
  title ILIKE 'On the Nomination%'
  OR title ILIKE '%Nomination of%'
  OR title ILIKE 'Confirmation of%'
)
AND vote_category = 'substantive';

-- Regulations.gov proposals (no source_ids column on promoted public.proposals;
-- use type='regulation' as the only available signal)
UPDATE public.proposals SET vote_category = 'regulation'
WHERE type = 'regulation'
AND vote_category = 'substantive';

CREATE INDEX IF NOT EXISTS idx_proposals_vote_category
ON public.proposals(vote_category);
