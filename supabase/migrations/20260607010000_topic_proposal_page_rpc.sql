-- FIX-514: get_topic_proposal_page — server-side topics filter for /proposals.
--
-- Why: the proposals page's topics filter fetched ALL entity_tags matches for the
-- active topics (silently capped at 1,000 rows by PostgREST) and stuffed the
-- entity_ids into `.in("id", ids)` — up to 1,000 UUIDs ≈ 37 KB of request URL,
-- over Kong's header/request-line buffer → nginx 400 "Request Header Or Cookie
-- Too Large". The Promise.all + `const { data }` destructure swallowed it, so the
-- page shipped a 200 with an empty list: /proposals?topics=<common topic> rendered
-- empty for every user. It also dropped the filter entirely on zero match and
-- showed ALL proposals. This RPC joins entity_tags × proposals server-side and
-- returns one page + the exact total, so the request URL is constant-length.
-- Proposals site of FIX-510.
--
-- Semantics mirror the TS query builder in apps/civitics/app/proposals/page.tsx
-- exactly (status/type/agency/q/sort/offset/limit). The non-topics path keeps the
-- existing PostgREST builder; this function is only used when topics are active.
--
-- SECURITY INVOKER: proposals and entity_tags are both anon-readable
-- (entity_tags policy public_read_tags USING(true) + anon SELECT grant), so the
-- function runs fine under the caller's (anon) role and respects RLS.

CREATE OR REPLACE FUNCTION public.get_topic_proposal_page(
  p_tags   text[],
  p_status text,
  p_type   text,
  p_agency text,
  p_q      text,
  p_sort   text,
  p_offset int,
  p_limit  int
)
RETURNS TABLE (
  id            uuid,
  title         text,
  type          text,
  status        text,
  summary_plain text,
  summary_model text,
  introduced_at date,
  metadata      jsonb,
  total_count   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.title,
    p.type::text,
    p.status::text,
    p.summary_plain,
    p.summary_model,
    p.introduced_at,
    p.metadata,
    count(*) OVER() AS total_count
  FROM proposals p
  WHERE
    -- Status filter — mirrors page.tsx:
    --   "open"   → status='open_comment' AND comment_period_end > now
    --   "closed" → status='comment_closed' OR (status='open_comment' AND comment_period_end < now)
    --   anything else ("all") → no status filter
    -- now is formatted to match JS new Date().toISOString() so the lexical text
    -- comparison on metadata->>'comment_period_end' behaves identically to the
    -- PostgREST .gt/.lt the builder uses.
    (
      (p_status <> 'open' AND p_status <> 'closed')
      OR (
        p_status = 'open'
        AND p.status = 'open_comment'
        AND p.metadata->>'comment_period_end'
              > to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      OR (
        p_status = 'closed'
        AND (
          p.status = 'comment_closed'
          OR (
            p.status = 'open_comment'
            AND p.metadata->>'comment_period_end'
                  < to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        )
      )
    )
    -- Type filter (proposals.type is an enum; compare as text like the builder).
    AND (p_type IS NULL OR p_type = '' OR p.type::text = p_type)
    -- Agency filter (metadata JSONB).
    AND (p_agency IS NULL OR p_agency = '' OR p.metadata->>'agency_id' = p_agency)
    -- Text search on title.
    AND (p_q IS NULL OR p_q = '' OR p.title ILIKE '%' || p_q || '%')
    -- Topic filter — EXISTS join against entity_tags. When p_tags is empty/null the
    -- filter is skipped (used only by the no-topics ordering-parity check); when it
    -- has values that match nothing, EXISTS is false for every row → zero rows
    -- (the FIX-510 zero-match behavior: show none, never all).
    AND (
      p_tags IS NULL
      OR cardinality(p_tags) = 0
      OR EXISTS (
        SELECT 1 FROM entity_tags et
        WHERE et.entity_type = 'proposal'
          AND et.entity_id = p.id
          AND et.tag = ANY(p_tags)
      )
    )
  ORDER BY
    -- Exactly one of these CASE keys is non-null per call; the others collapse to
    -- NULL for every row and do not affect ordering. Mirrors the builder's
    -- newest → introduced_at DESC NULLS LAST; title → title ASC NULLS LAST;
    -- default (closing soon) → comment_period_end ASC NULLS LAST.
    CASE WHEN p_sort = 'newest' THEN p.introduced_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'title'  THEN p.title END ASC NULLS LAST,
    CASE WHEN p_sort NOT IN ('newest', 'title')
         THEN p.metadata->>'comment_period_end' END ASC NULLS LAST
  OFFSET GREATEST(p_offset, 0)
  LIMIT  LEAST(GREATEST(p_limit, 1), 100)
$$;

ALTER FUNCTION public.get_topic_proposal_page(text[], text, text, text, text, text, int, int) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.get_topic_proposal_page(text[], text, text, text, text, text, int, int) TO anon, authenticated, service_role;
