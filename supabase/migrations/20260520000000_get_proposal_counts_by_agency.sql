-- 20260520000000_get_proposal_counts_by_agency.sql
-- FIX-303 — single-RPC + functional index replacing /agencies + homepage Wave 2
-- per-agency count fan-out (up to 200 × 2 = 400 count:'exact' sub-queries per
-- pageload). Also fixes the latent JSONB-path filter bug at
-- apps/civitics/app/agencies/page.tsx:64 — the .gt('comment_period_end', now)
-- filter was silently no-op'd by PostgREST because comment_period_end is a
-- metadata->>... path, not a top-level column. Doing the cast and comparison
-- correctly inside the function ensures openProposals < totalProposals for
-- agencies whose comment windows have closed.
--
-- Returns the full agency-counts set in one round-trip. Caller builds a
-- Map<agency_id, {total, open}> and looks up per agency. Same superset-payload
-- shape as FIX-297 and FIX-298 (get_connection_type_counts).
--
-- proposals row count at migration time: ~73k local, similar order of
-- magnitude on prod (FEC dumps + regulations.gov fetches). CONCURRENTLY not
-- needed at this size; the index build is microseconds. Function-level
-- statement_timeout lives in the sibling migration matching FIX-298's split.

-- Functional index backs the GROUP BY metadata->>'agency_id' below.
-- IMMUTABLE-on-JSONB-path is safe here; the expression is deterministic.
CREATE INDEX IF NOT EXISTS idx_proposals_metadata_agency_id
  ON public.proposals ((metadata->>'agency_id'));

CREATE OR REPLACE FUNCTION public.get_proposal_counts_by_agency()
RETURNS TABLE(agency_id TEXT, total BIGINT, open BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT
    metadata->>'agency_id' AS agency_id,
    COUNT(*)::BIGINT AS total,
    COUNT(*) FILTER (
      WHERE status = 'open_comment'
        AND (metadata->>'comment_period_end')::timestamptz > NOW()
    )::BIGINT AS open
  FROM public.proposals
  WHERE metadata->>'agency_id' IS NOT NULL
  GROUP BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_proposal_counts_by_agency()
  TO authenticated, service_role, anon;
