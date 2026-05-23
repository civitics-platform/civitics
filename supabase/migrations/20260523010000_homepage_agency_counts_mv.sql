-- 20260523010000_homepage_agency_counts_mv.sql
-- FIX-330 — materialize the FIX-303 RPC payload to kill cold-cache 2s
-- timeouts on the homepage and /agencies.
--
-- FIX-303 shipped `get_proposal_counts_by_agency()` + a functional index
-- on `proposals.metadata->>'agency_id'` and a 60s function-level
-- statement_timeout (sibling migration 20260520000001). Warm-path reads
-- are sub-second, but the homepage caller at apps/civitics/app/page.tsx
-- wraps it in `withDbTimeout(..., 2000)` and intermittently trips on
-- cold cache under Vercel concurrency, surfacing as
-- `agency counts RPC error: Supabase query timed out after 2000ms` in
-- prod function logs. The FIX-303 follow-up migration's own header
-- foreshadowed this ("cold-cache reads can stretch closer to default
-- service_role timeout under contention").
--
-- Pattern matches FIX-223 (homepage_stats_mvs.sql): pre-aggregate
-- nightly, REFRESH CONCURRENTLY via unique index, served from a single
-- indexed read. After this lands, all three homepage aggregate paths
-- (hero stats, per-official Wave 3, per-agency counts) are MV-backed.
--
-- Staleness window: the `open` count uses
-- `(metadata->>'comment_period_end')::timestamptz > NOW()` evaluated at
-- refresh time, so it can drift up to ~24h between nightly refreshes.
-- Same staleness profile as `homepage_stats_mv.active_proposals_count`.
-- Acceptable per the FIX-223 precedent; the request path keeps a
-- live-compute fallback via the existing RPC for any MV-empty case.
--
-- The FIX-303 RPC `get_proposal_counts_by_agency()` and its index
-- `idx_proposals_metadata_agency_id` stay in place — the RPC is now the
-- fallback path on MV-empty reads.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.homepage_agency_counts_mv AS
SELECT
  metadata->>'agency_id' AS agency_id,
  COUNT(*)::BIGINT AS total,
  COUNT(*) FILTER (
    WHERE status = 'open_comment'
      AND (metadata->>'comment_period_end')::timestamptz > NOW()
  )::BIGINT AS open,
  NOW() AS refreshed_at
FROM public.proposals
WHERE metadata->>'agency_id' IS NOT NULL
GROUP BY 1;

CREATE UNIQUE INDEX IF NOT EXISTS homepage_agency_counts_mv_pk
  ON public.homepage_agency_counts_mv (agency_id);

GRANT SELECT ON public.homepage_agency_counts_mv
  TO anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.refresh_homepage_agency_counts_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_homepage_agency_counts_mv()
  TO authenticated, service_role;
