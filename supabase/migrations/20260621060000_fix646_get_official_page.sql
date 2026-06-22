-- FIX-646: collapse the officials/[id] render N+1 into one RPC.
--
-- The page fanned out ~13 render-path reads (vote count, recent votes + a
-- two-step proposal hydration, all-votes-for-tagging, AI summary, career,
-- promises, civic responses, synthetic answer-count, spending + agency/entity
-- name resolution). get_official_page(uuid) returns all of them as one jsonb
-- payload, mirroring the exact shapes the page builds today so the render JSX is
-- unchanged. Modeled on get_jurisdiction_page (FIX-634): SECURITY INVOKER (all
-- reads are public, RLS USING(true)), EXECUTE to anon.
--
-- DELIBERATELY EXCLUDED (kept as their own page queries — see FIX-646 notes):
--   * the official base row — fetched via getCachedOfficial, React.cache-shared
--     with generateMetadata (moving it here would double-fetch the official).
--   * official_donor_rollup_mv + the FIX-635 bounded fallback — already
--     MV-optimized; a single RPC would have to cram up to ~10k donor rows into
--     this payload. Stays a separate query.
--
-- Proposal hydration is done in SQL here: votes.bill_proposal_id = proposals.id
-- (NOT a real FK to proposals — it FKs bill_details(proposal_id) — but the value
-- equals proposals.id, so the join is valid). bill_number via a scalar subquery
-- to avoid row multiplication. The "spending" section faithfully reproduces the
-- page's behavior: top-10 contracts/grants globally (the existing query is not
-- filtered by official), gated on the official having a jurisdiction_id.

CREATE OR REPLACE FUNCTION public.get_official_page(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT jsonb_build_object(
    'vote_count',
      (SELECT count(*) FROM votes v WHERE v.official_id = p_id),

    -- Recent 100 votes, newest first, each with its proposal (+ bill_number).
    'recent_votes',
      coalesce((
        SELECT jsonb_agg(to_jsonb(rv) ORDER BY rv.voted_at DESC NULLS LAST)
        FROM (
          SELECT v.id, v.vote, v.voted_at, v.roll_call_id, v.bill_proposal_id,
            CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'short_title', p.short_title,
              'bill_details', (
                SELECT jsonb_build_object('bill_number', bd.bill_number)
                FROM bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
              )
            ) END AS proposals
          FROM votes v
          LEFT JOIN proposals p ON p.id = v.bill_proposal_id
          WHERE v.official_id = p_id
          ORDER BY v.voted_at DESC NULLS LAST
          LIMIT 100
        ) rv
      ), '[]'::jsonb),

    -- Up to 500 votes (unordered) for the issue-tagging + vote-breakdown pass.
    'all_votes',
      coalesce((
        SELECT jsonb_agg(to_jsonb(av))
        FROM (
          SELECT v.vote, v.bill_proposal_id,
            CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'short_title', p.short_title,
              'bill_details', (
                SELECT jsonb_build_object('bill_number', bd.bill_number)
                FROM bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
              )
            ) END AS proposals
          FROM votes v
          LEFT JOIN proposals p ON p.id = v.bill_proposal_id
          WHERE v.official_id = p_id
          LIMIT 500
        ) av
      ), '[]'::jsonb),

    'ai_summary',
      (SELECT jsonb_build_object('summary_text', a.summary_text)
       FROM ai_summary_cache a
       WHERE a.entity_type = 'official' AND a.entity_id = p_id
         AND a.summary_type = 'profile'
       LIMIT 1),

    'career_history',
      coalesce((
        SELECT jsonb_agg(to_jsonb(c) ORDER BY c.started_at DESC NULLS LAST)
        FROM (
          SELECT id, organization, role_title, started_at, ended_at,
                 is_government, revolving_door_flag, revolving_door_explanation
          FROM career_history
          WHERE official_id = p_id
          ORDER BY started_at DESC NULLS LAST
          LIMIT 20
        ) c
      ), '[]'::jsonb),

    'promises',
      coalesce((
        SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.made_at DESC NULLS LAST)
        FROM (
          SELECT id, title, description, status, made_at, deadline,
                 resolved_at, source_url, source_quote
          FROM promises
          WHERE official_id = p_id
          ORDER BY made_at DESC NULLS LAST
          LIMIT 10
        ) pr
      ), '[]'::jsonb),

    -- Civic responsiveness windows, newest first, with the linked initiative.
    'civic_responses',
      coalesce((
        SELECT jsonb_agg(to_jsonb(cr) ORDER BY cr.window_opened_at DESC NULLS LAST)
        FROM (
          SELECT r.id, r.initiative_id, r.response_type, r.responded_at,
                 r.window_closes_at, r.window_opened_at,
            CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'type', p.type,
              'initiative_details', (
                SELECT jsonb_build_object('scope', idt.scope::text)
                FROM initiative_details idt WHERE idt.proposal_id = p.id LIMIT 1
              )
            ) END AS proposals
          FROM civic_initiative_responses r
          LEFT JOIN proposals p ON p.id = r.initiative_id
          WHERE r.official_id = p_id
          ORDER BY r.window_opened_at DESC NULLS LAST
          LIMIT 20
        ) cr
      ), '[]'::jsonb),

    -- Synthetic-official passive disclaimer signal (page gates on is_synthetic).
    'passive_answer_count',
      (SELECT count(*) FROM entity_comments ec
        WHERE ec.entity_type = 'official' AND ec.entity_id = p_id
          AND ec.kind = 'answer' AND ec.status = 'visible'),

    -- Spending: top-10 contracts/grants (faithfully NOT official-filtered, as the
    -- page's query isn't), gated on the official having a jurisdiction_id.
    'spending',
      CASE WHEN (SELECT jurisdiction_id FROM officials WHERE id = p_id) IS NULL
        THEN '[]'::jsonb
        ELSE coalesce((
          SELECT jsonb_agg(to_jsonb(s) ORDER BY s.amount_cents DESC NULLS LAST)
          FROM (
            SELECT fr.id,
              coalesce(fe.display_name, 'Unknown recipient') AS recipient_name,
              fr.relationship_type AS award_type,
              coalesce(fr.amount_cents, 0) AS amount_cents,
              fr.occurred_at AS award_date,
              (fr.metadata->>'description') AS description,
              coalesce(ag.name, 'Unknown agency') AS awarding_agency
            FROM financial_relationships fr
            LEFT JOIN agencies ag ON ag.id = fr.from_id
            LEFT JOIN financial_entities fe ON fe.id = fr.to_id
            WHERE fr.relationship_type IN ('contract', 'grant')
              AND fr.amount_cents > 0
            ORDER BY fr.amount_cents DESC
            LIMIT 10
          ) s
        ), '[]'::jsonb)
      END
  );
$$;

ALTER FUNCTION public.get_official_page(uuid) SET statement_timeout = '8s';

GRANT EXECUTE ON FUNCTION public.get_official_page(uuid) TO anon, authenticated, service_role;
