-- FIX-1180 (A) — the idempotent twin of scripts/fix1180-build-votes-index.mjs.
--
-- WHAT THIS IS FOR. The index itself is built out-of-band, CONCURRENTLY, by that
-- script, because CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block and `supabase db push` wraps each migration in one. Against prod, this
-- migration is therefore a NO-OP: the index is already there when it runs. Its
-- job is to be the build path for local, for CI, and for any environment rebuilt
-- from zero — so the schema a fresh database gets is the schema prod has.
-- Same pairing as FIX-1118 (20260901230000) and FIX-883.
--
-- WHY THE INDEX. get_official_page's `recent_votes` sub-query orders by
--   ORDER BY voted_at DESC NULLS LAST
-- and the index that already exists, `votes_official_voted_at`, is
-- (official_id, voted_at) ASC. Scanning an ASC index backwards produces
-- DESC NULLS FIRST, which is a different ordering, so the planner cannot use it
-- for this sort. It falls back to a bitmap scan of the official's ENTIRE vote
-- history plus a top-N heapsort to 100 rows — on every page view, for every
-- official. Measured on the clone (cc-137 §3): the section costs 6,034 buffers
-- and drops to 731 with this index; the whole RPC goes 13,274 -> 7,989 for
-- Warnock (-40 %), and 14,882 -> 7,702 for the worst official measured (-48 %).
-- 408 officials have more than 1,000 votes.
--
-- WHY NOT JUST DROP `NULLS LAST` FROM THE RPC. That would also work — `voted_at`
-- has zero nulls (0 of 982,966 on prod) — and it is cheaper. It is not what this
-- lands, deliberately: option (A) was chosen because adding an index cannot
-- change which rows a page shows, and editing the ORDER BY of a live RPC can.
-- The index matches the RPC's existing text exactly. `get_official_page` is NOT
-- touched by this migration.
--
-- The ASC index is NOT dropped. It still serves range predicates on voted_at and
-- the plain (official_id, voted_at) ordering; dropping an index is a separate,
-- destructive decision with its own evidence bar.

CREATE INDEX IF NOT EXISTS votes_official_voted_at_desc
  ON public.votes (official_id, voted_at DESC NULLS LAST);

COMMENT ON INDEX public.votes_official_voted_at_desc IS
  'FIX-1180 (A) — matches get_official_page recent_votes ORDER BY voted_at DESC '
  'NULLS LAST exactly, which votes_official_voted_at (ASC) cannot serve: a '
  'backward scan of it is DESC NULLS FIRST. Turns a full per-official vote-history '
  'bitmap scan + top-N sort into an index scan (clone: section 6,034 -> 731 '
  'buffers, whole RPC -40 to -48 %). Built CONCURRENTLY out-of-band 2026-09-20.';
