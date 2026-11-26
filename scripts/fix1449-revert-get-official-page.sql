-- scripts/fix1449-revert-get-official-page.sql
-- FIX-1449 ROLLBACK (cc-325) — puts back get_official_page(uuid) as it ran
-- before 20261126001000_fix1449_official_page_votes_say_what_they_count.sql:
-- the body of 20260621060000_fix646_get_official_page.sql VERBATIM (md5(prosrc)
-- cefb35bb5ad3e8406df6b7ec1086e6ab, LOCAL and PROD at cc-325 read 2), with the
-- live proconfig restated (CREATE OR REPLACE drops a SET it does not restate;
-- FIX-1128 RESET the old statement_timeout, so search_path is the only one)
-- and the grants FIX-646 made.
--
-- It DROPS NOTHING and writes no data. The page reads the old keys through a
-- missing-key-is-absent shim, so the deployed page renders against either body.
-- It refuses a live body that is neither FIX-1449's nor the one it puts back.
--
-- Apply:  node scripts/db-query.mjs --local --call --file scripts/fix1449-revert-get-official-page.sql
-- (prod: only on the cc-325 STOP-table step-4 row, through the gate, from the
-- primary's packages/data with --prod --call --yes-i-mean-prod --timeout 30s).

DO $$
DECLARE
  v_self text;
BEGIN
  SELECT md5(prosrc) INTO v_self FROM pg_proc WHERE oid = to_regprocedure('public.get_official_page(uuid)');
  IF v_self IS DISTINCT FROM 'cae21650a7053828a739de47d33f0976' AND v_self IS DISTINCT FROM 'cefb35bb5ad3e8406df6b7ec1086e6ab' THEN
    RAISE EXCEPTION '[fix1449 revert] get_official_page md5 % is neither FIX-1449''s cae21650a7053828a739de47d33f0976 nor FIX-646''s cefb35bb5ad3e8406df6b7ec1086e6ab',
      COALESCE(v_self, '(no function)');
  END IF;
END $$;


CREATE OR REPLACE FUNCTION public.get_official_page(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $function$
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_official_page(uuid) TO anon, authenticated, service_role;


DO $$
DECLARE
  v_d   text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_d, v_cfg FROM pg_proc WHERE oid = to_regprocedure('public.get_official_page(uuid)');
  IF v_d IS DISTINCT FROM 'cefb35bb5ad3e8406df6b7ec1086e6ab' THEN
    RAISE EXCEPTION '[fix1449 revert] read-back: get_official_page md5 % is not FIX-646''s cefb35bb5ad3e8406df6b7ec1086e6ab', v_d;
  END IF;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=public, extensions'] THEN
    RAISE EXCEPTION '[fix1449 revert] read-back: get_official_page proconfig % (want {search_path=public, extensions})', v_cfg;
  END IF;
  RAISE NOTICE '[fix1449 revert] read-back ok: get_official_page % · proconfig %', v_d, v_cfg;
END $$;
