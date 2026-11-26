-- FIX-1449 (cc-325) — get_official_page(uuid): the officials page's votes say
-- what they count, and the spending list that was never the official's is gone.
--
-- One function body; same signature, same proconfig (search_path only), same
-- STABLE, same SECURITY INVOKER, same grants. Against the body this replaces
-- (20260621060000_fix646_get_official_page.sql, ALTERed by 20260627000400 and
-- 20260913000000; md5(prosrc) cefb35bb5ad3e8406df6b7ec1086e6ab on the clone AND
-- prod, cc-325 read 2):
--
--   * 'spending' is removed (D1). It selected the ten largest contract / grant
--     rows of financial_relationships with no filter on the official, so every
--     official with a jurisdiction showed the same ten awards as "Government
--     Spending". No stored row ties a contract to an official; nothing
--     replaces it.
--   * 'recent_votes' (100) and 'all_votes' (500) each gain vote_question,
--     chamber and roll_class = vote_roll_class(vote_question, roll_call_id)
--     (FIX-1409's 'final' | 'advance' | 'other') (D3). 'all_votes' also gains
--     voted_at and roll_call_id, and an ORDER BY: it was LIMIT 500 in no order,
--     so the page's breakdown and issue bars came from an arbitrary 500 of an
--     official's up-to-2,828 votes (D2 shape b: the page now says "Last 500").
--     Inside a day both lists order by the roll number, cc-317's key (text
--     order puts house-99 above house-100). The plans still read
--     votes_official_voted_at_desc with an Incremental Sort (presorted key
--     voted_at), so the tiebreak costs ~10 buffers, not a sort of the set.
--   * Both vote lists hydrate each distinct proposal once: a LATERAL subquery,
--     kept a scan of its own by OFFSET 0, which Memoize caches together with
--     its bill_number. The old form ran the bill_details scalar subplan once
--     per VOTE (600 loops x 4 buffers). The payload is unchanged.
--
-- WHY SHAPE (b), NOT (a). D2's rule: build the exact all-votes breakdown only if
-- the new body's buffers (hit + read) are at or under the old body's for the
-- clone's heaviest officials. Measured on the clone (cc-325 Item 1, three
-- officials at 2,560 votes, two runs each, identical): old 4,166 / 4,669 /
-- 4,632; shape (a) 5,774 / 6,252 / 6,203 (one pass over the official's whole
-- vote heap adds ~2,100-2,550 buffers and ~175 ms); this body 3,713 / 3,683 /
-- 3,683. (a) is over in all three; this body is under in all three.
--
-- GUARD: the live body is the old one (or this one, on a re-run),
-- vote_roll_class is FIX-1409's, and anon and authenticated can EXECUTE both
-- class helpers (cc-317 granted them; this SECURITY INVOKER body runs as the
-- caller). READ-BACK: the new md5, the proconfig, STABLE, invoker and the
-- grants; it prints the md5.
--
-- Revert: scripts/fix1449-revert-get-official-page.sql (the old body verbatim).

DO $$
DECLARE
  v_self text;
  v_roll text;
  v_fn   text;
  v_role text;
BEGIN
  SELECT md5(prosrc) INTO v_self FROM pg_proc WHERE oid = to_regprocedure('public.get_official_page(uuid)');
  SELECT md5(prosrc) INTO v_roll FROM pg_proc WHERE oid = to_regprocedure('public.vote_roll_class(text, text)');
  IF v_self IS DISTINCT FROM 'cefb35bb5ad3e8406df6b7ec1086e6ab' AND v_self IS DISTINCT FROM 'cae21650a7053828a739de47d33f0976' THEN
    RAISE EXCEPTION '[fix1449] get_official_page md5 % is neither FIX-646''s cefb35bb5ad3e8406df6b7ec1086e6ab nor this file''s cae21650a7053828a739de47d33f0976 — print the live body and diff it before landing this file',
      COALESCE(v_self, '(no function)');
  END IF;
  IF v_roll IS DISTINCT FROM 'a4280226054c9f2f2b4aae4e0a1cec0c' THEN
    RAISE EXCEPTION '[fix1449] vote_roll_class md5 % is not FIX-1409''s a4280226054c9f2f2b4aae4e0a1cec0c — the roll class moved; re-read it before landing this file',
      COALESCE(v_roll, '(no function)');
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.vote_roll_class(text, text)', 'public.vote_question_class(text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '[fix1449] % cannot EXECUTE % — the page RPC runs as the caller and would fail', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE '[fix1449] guard: get_official_page % · vote_roll_class %', v_self, v_roll;
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

    -- Recent 100 votes, newest first (the roll number orders a day's rolls),
    -- each with its question, chamber, roll class and proposal (+ bill_number).
    'recent_votes',
      coalesce((
        SELECT jsonb_agg(to_jsonb(rv) ORDER BY rv.voted_at DESC NULLS LAST,
                         substring(rv.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST)
        FROM (
          SELECT v.id, v.vote, v.voted_at, v.roll_call_id, v.bill_proposal_id,
            v.vote_question, v.chamber,
            public.vote_roll_class(v.vote_question, v.roll_call_id) AS roll_class,
            pj.proposals
          FROM votes v
          -- One hydration per distinct proposal: OFFSET 0 keeps the subquery
          -- its own scan, so Memoize caches the proposal WITH its bill_number.
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'short_title', p.short_title,
              'bill_details', (
                SELECT jsonb_build_object('bill_number', bd.bill_number)
                FROM bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
              )
            ) AS proposals
            FROM proposals p
            WHERE p.id = v.bill_proposal_id
            OFFSET 0
          ) pj ON true
          WHERE v.official_id = p_id
          ORDER BY v.voted_at DESC NULLS LAST,
                   substring(v.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST
          LIMIT 100
        ) rv
      ), '[]'::jsonb),

    -- The last 500 votes, newest first, for the vote breakdown and the issue
    -- bars: the same columns and hydration as recent_votes, without the id.
    'all_votes',
      coalesce((
        SELECT jsonb_agg(to_jsonb(av) ORDER BY av.voted_at DESC NULLS LAST,
                         substring(av.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST)
        FROM (
          SELECT v.vote, v.voted_at, v.roll_call_id, v.bill_proposal_id,
            v.vote_question, v.chamber,
            public.vote_roll_class(v.vote_question, v.roll_call_id) AS roll_class,
            pj.proposals
          FROM votes v
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
              'id', p.id,
              'title', p.title,
              'short_title', p.short_title,
              'bill_details', (
                SELECT jsonb_build_object('bill_number', bd.bill_number)
                FROM bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
              )
            ) AS proposals
            FROM proposals p
            WHERE p.id = v.bill_proposal_id
            OFFSET 0
          ) pj ON true
          WHERE v.official_id = p_id
          ORDER BY v.voted_at DESC NULLS LAST,
                   substring(v.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST
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
          AND ec.kind = 'answer' AND ec.status = 'visible')
  );
$function$;

GRANT EXECUTE ON FUNCTION public.get_official_page(uuid) TO anon, authenticated, service_role;


DO $$
DECLARE
  c_want CONSTANT text := 'cae21650a7053828a739de47d33f0976';
  v_oid  oid := to_regprocedure('public.get_official_page(uuid)');
  v_d    text;
  v_cfg  text[];
  v_vol  "char";
  v_sec  boolean;
  v_role text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '[fix1449] read-back: get_official_page(uuid) does not exist';
  END IF;
  SELECT md5(prosrc), proconfig, provolatile, prosecdef INTO v_d, v_cfg, v_vol, v_sec FROM pg_proc WHERE oid = v_oid;
  IF v_d IS DISTINCT FROM c_want THEN
    RAISE EXCEPTION '[fix1449] read-back: get_official_page md5 % is not this file''s %', v_d, c_want;
  END IF;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=public, extensions'] OR v_vol <> 's' OR v_sec THEN
    RAISE EXCEPTION '[fix1449] read-back: get_official_page proconfig % volatile % secdef % (want {search_path=public, extensions}, s, false)', v_cfg, v_vol, v_sec;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, 'public.get_official_page(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION '[fix1449] read-back: % cannot EXECUTE get_official_page', v_role;
    END IF;
  END LOOP;
  RAISE NOTICE '[fix1449] read-back ok: get_official_page % · proconfig % · STABLE · invoker · anon/authenticated/service_role EXECUTE', v_d, v_cfg;
END $$;
