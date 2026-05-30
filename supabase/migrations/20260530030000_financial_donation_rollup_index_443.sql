-- FIX-443 follow-up — partial covering index for the donation size rollup.
--
-- rebuild_financial_entity_size_tags() (migration 20260530020000) aggregates
--   SELECT from_id, SUM(amount_cents)
--   FROM financial_relationships
--   WHERE from_type='financial_entity' AND relationship_type='donation'
--   GROUP BY from_id
-- On prod (~4.88M donation rows of a ~6.16M-row table) the planner seq-scanned
-- the full heap — including the wide jsonb `metadata` column — burning >3min of
-- DataFileRead and blowing past the ~100s PostgREST/Cloudflare gateway timeout
-- (the client retried, and the retries lock-timed-out against the still-running
-- first call). The existing financial_relationships_derivation index
-- (relationship_type, from_type, from_id, …) does NOT carry amount_cents, so the
-- SUM still needs a heap fetch per row.
--
-- This partial covering index holds exactly the donation/from-financial_entity
-- subset, ordered by from_id and INCLUDE-ing amount_cents, so the aggregate is a
-- grouped index-only scan: no heap reads, no separate sort/hash. Same discipline
-- as votes_official_voted_at for the pre-vote timing rebuild.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because `supabase db push` wraps each
-- migration in a transaction. Only the data pipelines write
-- financial_relationships and none runs during a migration push, so the brief
-- write-lock during the build is a non-issue.
--
-- The migration role carries a short statement_timeout; building this index over
-- ~4.88M rows blows past it (ERROR 57014 on the first prod push). Raise it for
-- this migration's transaction only.
SET LOCAL statement_timeout = '600s';

CREATE INDEX IF NOT EXISTS financial_relationships_donation_size_rollup
  ON public.financial_relationships (from_id) INCLUDE (amount_cents)
  WHERE from_type = 'financial_entity' AND relationship_type = 'donation';
