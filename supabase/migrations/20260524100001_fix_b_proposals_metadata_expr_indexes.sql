-- FIX-359 (IOWait Round 1, FIX-B) — expression indexes on every
-- proposals.metadata->>'<key>' that appears in a runtime WHERE filter.
--
-- Audit 2026-05-24 §B #3 + #8 + §D hot-tables: 26,068 seq_scans + 1.64 B
-- tup_read of public.proposals over the pg_stat_statements window, almost
-- entirely from JSONB-path lookups against metadata. Two distinct shapes
-- found in the codebase via grep:
--
--   (a) WHERE metadata->>'agency_id' = '<acronym>'         — equality
--   (b) WHERE metadata->>'comment_period_end' > '<iso>'    — range
--       (+ ORDER BY metadata->>'comment_period_end')
--
-- Plain CREATE INDEX (no CONCURRENTLY) because public.proposals is ~90 MB
-- heap with ~73k rows — the index build is sub-second and a brief
-- table lock is acceptable. CONCURRENTLY+supabase-db-push transactionality
-- is fiddly; the build cost here doesn't justify the complication.

-- ── 1. agency_id (equality WHERE filter) ─────────────────────────────────
--
-- Already created by FIX-303 / 20260520000000_get_proposal_counts_by_agency.sql
-- as idx_proposals_metadata_agency_id. Re-issued IF NOT EXISTS to guarantee
-- the index is present on every environment after FIX-358's audit raised
-- doubt about whether prod's pg_stat_statements seq_scan counts reflect a
-- missed deploy.
--
-- Call sites (equality on (metadata->>'agency_id')):
--   apps/civitics/app/proposals/page.tsx           (proposals list w/ agency filter)
--   apps/civitics/app/proposals/[id]/page.tsx      (related proposals on detail page)
--   apps/civitics/app/agencies/[slug]/page.tsx     (agency detail — 4 distinct queries)
--   apps/civitics/app/api/cron/notify-followers/route.ts (per-agency followers cron)
--   supabase/migrations/20260520000000_get_proposal_counts_by_agency.sql
--   supabase/migrations/20260523010000_homepage_agency_counts_mv.sql
CREATE INDEX IF NOT EXISTS idx_proposals_metadata_agency_id
  ON public.proposals ((metadata->>'agency_id'));

COMMENT ON INDEX public.idx_proposals_metadata_agency_id IS
  'Expression index on metadata->>''agency_id''. Original FIX-303; re-affirmed '
  'by FIX-359 (IOWait Round 1) after audit 2026-05-24 §B #3 + #8.';

-- ── 2. comment_period_end (range WHERE filter + ORDER BY) ────────────────
--
-- NEW. Heavy gt/lt/order use across the homepage, dashboard, proposals
-- list, and agency detail surfaces. Audit 2026-05-24 §D shows seq_tup_read
-- on proposals = 1.64 B, far beyond what agency_id-equality alone would
-- account for. Local EXPLAIN (ANALYZE, BUFFERS) before this index:
--
--   Parallel Seq Scan on proposals  (cost=0.00..12012.77 rows=10142)
--     Filter: ((metadata ->> 'comment_period_end'::text) > '2026-05-24...')
--     Buffers: shared hit=462 read=11069
--   Execution Time: 22.563 ms
--
-- Storing the extracted text means the range comparison stays a text
-- comparison. ISO 8601 strings sort lexicographically the same as
-- timestamps, so the index is semantically correct for the gt/lt usage.
--
-- Call sites (gt/lt/order on (metadata->>'comment_period_end')):
--   apps/civitics/app/page.tsx                       (homepage upcoming-comment list)
--   apps/civitics/app/dashboard/page.tsx             (dashboard upcoming-comment list)
--   apps/civitics/app/proposals/page.tsx             (proposals list, open-comment sort)
--   apps/civitics/app/agencies/[slug]/page.tsx       (agency upcoming-comment list)
CREATE INDEX IF NOT EXISTS proposals_metadata_comment_period_end_expr
  ON public.proposals ((metadata->>'comment_period_end'));

COMMENT ON INDEX public.proposals_metadata_comment_period_end_expr IS
  'Expression index on metadata->>''comment_period_end''. FIX-359. Backs '
  'gt/lt/order range queries on the homepage, dashboard, proposals list, '
  'and agency detail (audit 2026-05-24 §D hot tables).';
