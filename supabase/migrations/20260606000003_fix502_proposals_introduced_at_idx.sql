-- FIX-502: proposals introduced_at ORDER BY has no index -> full-sort timeout
--
-- The PostgREST query behind the /proposals list (all+newest path), the newest
-- carousel, and the home-page fallback runs:
--
--   SELECT id,title,type,status,summary_plain,summary_model,introduced_at,metadata
--   FROM proposals
--   ORDER BY introduced_at DESC NULLS LAST
--   LIMIT $1 OFFSET $2
--
-- with no selective WHERE. There was no index on proposals(introduced_at)
-- anywhere in migration history, so every request full-scanned + sorted the
-- entire proposals table. As the table grew this began exceeding
-- statement_timeout on prod (many timeout errors).
--
-- The index MUST declare DESC NULLS LAST to match the ORDER BY exactly: a
-- backward scan of a default (ASC NULLS LAST) btree yields DESC NULLS FIRST,
-- which the planner cannot use to satisfy "DESC NULLS LAST" without a sort.
--
-- Plain CREATE INDEX (no CONCURRENTLY) per project precedent for this table
-- (see 20260524100001) so it runs inside the migration transaction. The build
-- takes a brief ACCESS EXCLUSIVE lock on writes; the proposals write path is
-- pipeline-only (not user-facing), so this is acceptable.

CREATE INDEX IF NOT EXISTS proposals_introduced_at_desc
  ON public.proposals (introduced_at DESC NULLS LAST);
