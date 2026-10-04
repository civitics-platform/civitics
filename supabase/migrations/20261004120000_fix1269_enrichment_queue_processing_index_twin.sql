-- FIX-1269 (cc-188 M-C) — the twin of the out-of-band CREATE INDEX CONCURRENTLY.
--
-- On PROD this is a no-op: scripts/fix1269-create-snapshot-index.mjs built the
-- index CONCURRENTLY under session:wait-for-gate on 2026-10-04 02:12:56–02:13:00
-- UTC (wall 3.9 s, indisvalid = true, 16 kB) and the plain EXPLAIN read back an
-- Index Only Scan for both status-snapshot counts. This file was pushed only
-- after that read-back. On LOCAL and on any rebuilt-from-zero environment it is
-- the real build path; enrichment_queue is small enough there that a plain
-- (non-concurrent) build inside the migration transaction is seconds.
--
-- WHY: apps/civitics/app/api/claude/status/_lib/sections.ts counts
-- `status = 'processing'` and `status = 'processing' AND claimed_at < cutoff`
-- on every */30 snapshot tick. Before this index both were a Seq Scan of the
-- 274 MB heap for ~44 rows: prod pgss since 2026-09-22, 58,009 and 55,446
-- blocks read per call, mean 4.8 s, max 7.99 s against the 8 s service_role
-- bound. Clone: 19,144 buffers -> 2.

CREATE INDEX IF NOT EXISTS enrichment_queue_processing_claimed_idx
  ON public.enrichment_queue (claimed_at)
  WHERE status = 'processing';

COMMENT ON INDEX public.enrichment_queue_processing_claimed_idx IS
  'FIX-1269 — partial index over the in-flight claims of enrichment_queue. '
  'Bounds the */30 status snapshot''s two processing counts (sections.ts) to an '
  'Index Only Scan instead of a Seq Scan of the whole heap for ~44 rows. Built '
  'CONCURRENTLY out-of-band by scripts/fix1269-create-snapshot-index.mjs; the '
  'cc-188 twin migration carries the same DDL as IF NOT EXISTS.';
