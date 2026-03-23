-- 0019_proposal_vote_category.sql
-- Adds vote_category to proposals for filtering in graph and proposals page.
--
-- Categories:
--   substantive  — real legislation (bills with proper titles)
--   procedural   — parliamentary procedure (cloture, passage motions)
--   nomination   — judicial/cabinet/ambassador confirmation votes
--   regulation   — federal regulations from regulations.gov
--
-- Default behavior: graph hides procedural, shows all others.
-- Proposals page: shows regulation + substantive (non-vote) only.
--
-- Run in Supabase SQL editor before deploying code changes.

-- ── Add column ─────────────────────────────────────────────────────────────────
ALTER TABLE proposals
ADD COLUMN IF NOT EXISTS vote_category TEXT DEFAULT 'substantive'
  CHECK (vote_category IN ('substantive', 'procedural', 'nomination', 'regulation'));

-- ── Categorize procedural votes ────────────────────────────────────────────────
UPDATE proposals SET vote_category = 'procedural'
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
);

-- ── Categorize nomination votes ────────────────────────────────────────────────
UPDATE proposals SET vote_category = 'nomination'
WHERE (
  title ILIKE 'On the Nomination%'
  OR title ILIKE '%Nomination of%'
  OR title ILIKE 'Confirmation of%'
)
AND vote_category = 'substantive'; -- don't overwrite procedural

-- ── Categorize regulations.gov proposals ──────────────────────────────────────
UPDATE proposals SET vote_category = 'regulation'
WHERE (
  source_ids->>'source_system' = 'regulations_gov'
  OR type = 'regulation'
)
AND vote_category = 'substantive'; -- don't overwrite procedural or nomination

-- ── Index for fast category filtering ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proposals_vote_category
ON proposals(vote_category);

-- ── DOWN (manual rollback) ─────────────────────────────────────────────────────
-- ALTER TABLE proposals DROP COLUMN IF EXISTS vote_category;
-- DROP INDEX IF EXISTS idx_proposals_vote_category;

-- ── Verify categorization (run after migration) ────────────────────────────────
-- SELECT vote_category, COUNT(*) AS count
-- FROM proposals
-- GROUP BY vote_category
-- ORDER BY count DESC;
