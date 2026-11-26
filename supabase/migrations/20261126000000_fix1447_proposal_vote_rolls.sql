-- 20261126000000_fix1447_proposal_vote_rolls.sql
-- FIX-1447 — public.proposal_vote_rolls(uuid): one row per roll of a proposal,
-- the page's one vote read (cc-317 D1; design of record: cc-317's prompt D1–D12).
--
-- WHY. The proposal page read votes only for type 'bill', took the newest 100
--   rows across every roll and tallied them as if they were one vote. A bill
--   with several rolls (prod, cc-317 read 4: 304 of 1,090 voted bills, max 57
--   rolls / 18,408 rows) printed 100 members of one roll; nominations (735 with
--   votes) and resolutions (497) printed nothing. This function groups the
--   stored rows by roll and returns each roll's own counts.
--
-- WHAT THE COUNTS ARE. A roll's stored rows are short of the roll: votes holds
--   a row only for a member Civitics has an officials row for (FIX-1448). Prod,
--   read 3: the median House roll stores 323 rows, the Senate 84; 170 House
--   rolls read Passed / Agreed to with stored yes <= stored no, and 96 read
--   Failed with yes > no (suspension needs two thirds). So `rows_on_record` and
--   the counts are "recorded here", never a result; `vote_result` is the
--   source's own result when one is stored (Senate: 330 of 2,223 rolls), else
--   NULL. The page never derives a verdict from the counts (cc-317 D2).
--
-- THE SHAPE (D1). LANGUAGE sql STABLE, security invoker, no SET (nothing here
--   is a statement_timeout; check:proconfig has nothing to flag). The filter is
--   the equality on bill_proposal_id and nothing else, so the body reads
--   votes_bill whatever the argument. One scan, grouped twice: by (roll,
--   chamber, party) and then by (roll, chamber). `by_party` keys are democrat,
--   republican, independent and other (officials.party NULL or any other value,
--   or no officials row); paired_yes / paired_no / abstain count under the
--   top-level `other` and nowhere in by_party.
--
-- THE ORDER. Newest first: voted_at DESC, then the roll number inside a day
--   (FIX-1409's `substring(roll_call_id FROM '([0-9]+)$')::numeric DESC`, since
--   voted_at is a date and text order puts house-99 above house-100), then
--   roll_call_id DESC.
--
-- THE GRANTS (a deviation from D1, with evidence). vote_roll_class() and
--   vote_question_class() are REVOKEd from anon and authenticated by
--   20261117000000 (FIX-1409). A security-invoker caller runs them as its own
--   role, so on the clone `SET ROLE anon; SELECT vote_roll_class(...)` reads
--   "permission denied for function vote_roll_class". Both are LANGUAGE sql
--   IMMUTABLE functions of their text arguments and read no table, so this file
--   grants them EXECUTE to anon and authenticated as well; their bodies are not
--   touched. All three names are in the FIX-1113 grant allow-list.
--
-- IDEMPOTENT. CREATE OR REPLACE + GRANT; the guard admits a first apply (no
--   function) or a re-apply (this file's body). No table, no row, no rewrite.

-- ── 0. Guard: the class helpers are FIX-1409's bodies ─────────────────────────

DO $$
DECLARE
  v_roll text;
  v_q    text;
  v_self text;
BEGIN
  SELECT md5(prosrc) INTO v_roll FROM pg_proc WHERE oid = to_regprocedure('public.vote_roll_class(text, text)');
  SELECT md5(prosrc) INTO v_q    FROM pg_proc WHERE oid = to_regprocedure('public.vote_question_class(text)');
  SELECT md5(prosrc) INTO v_self FROM pg_proc WHERE oid = to_regprocedure('public.proposal_vote_rolls(uuid)');
  IF v_roll IS DISTINCT FROM 'a4280226054c9f2f2b4aae4e0a1cec0c' THEN
    RAISE EXCEPTION '[fix1447] vote_roll_class md5 % is not FIX-1409''s a4280226054c9f2f2b4aae4e0a1cec0c — the roll class moved; re-read it before landing this file',
      COALESCE(v_roll, '(no function)');
  END IF;
  IF v_q IS DISTINCT FROM '82f25f8aa4f58ab81486bedb4faaa831' THEN
    RAISE EXCEPTION '[fix1447] vote_question_class md5 % is not FIX-1409''s 82f25f8aa4f58ab81486bedb4faaa831 — the question class moved; re-read it before landing this file',
      COALESCE(v_q, '(no function)');
  END IF;
  IF v_self IS NOT NULL AND v_self <> '35ee10d8653a61d2b9b4b96ec28eb69b' THEN
    RAISE EXCEPTION '[fix1447] proposal_vote_rolls already exists with md5 % (not this file''s 35ee10d8653a61d2b9b4b96ec28eb69b) — print the definition; do not replace it',
      v_self;
  END IF;
  RAISE NOTICE '[fix1447] guard: vote_roll_class % · vote_question_class % · proposal_vote_rolls %',
    v_roll, v_q, COALESCE(v_self, '(new)');
END $$;

-- ── 1. proposal_vote_rolls(uuid) ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.proposal_vote_rolls(p_proposal_id uuid)
RETURNS TABLE (
  roll_call_id   text,
  chamber        text,
  vote_question  text,
  roll_class     text,
  voted_at       timestamptz,
  source_url     text,
  vote_result    text,
  rows_on_record integer,
  yes            integer,
  no             integer,
  present        integer,
  not_voting     integer,
  other          integer,
  by_party       jsonb
)
LANGUAGE sql
STABLE
AS $function$
  WITH per_party AS (
    SELECT v.roll_call_id,
           v.chamber,
           CASE o.party::text
             WHEN 'democrat'    THEN 'democrat'
             WHEN 'republican'  THEN 'republican'
             WHEN 'independent' THEN 'independent'
             ELSE 'other'
           END AS party,
           max(v.vote_question)                          AS vote_question,
           min(v.voted_at)                               AS voted_at,
           max(v.source_url)                             AS source_url,
           max(nullif(v.metadata->>'vote_result', ''))   AS vote_result,
           count(*)::integer                             AS n,
           count(*) FILTER (WHERE v.vote = 'yes')::integer        AS yes,
           count(*) FILTER (WHERE v.vote = 'no')::integer         AS no,
           count(*) FILTER (WHERE v.vote = 'present')::integer    AS present,
           count(*) FILTER (WHERE v.vote = 'not_voting')::integer AS not_voting
    FROM public.votes v
    LEFT JOIN public.officials o ON o.id = v.official_id
    WHERE v.bill_proposal_id = p_proposal_id
    GROUP BY v.roll_call_id, v.chamber, 3
  )
  SELECT pp.roll_call_id,
         pp.chamber,
         max(pp.vote_question),
         public.vote_roll_class(max(pp.vote_question), pp.roll_call_id),
         min(pp.voted_at),
         max(pp.source_url),
         max(pp.vote_result),
         sum(pp.n)::integer,
         sum(pp.yes)::integer,
         sum(pp.no)::integer,
         sum(pp.present)::integer,
         sum(pp.not_voting)::integer,
         sum(pp.n - pp.yes - pp.no - pp.present - pp.not_voting)::integer,
         jsonb_object_agg(pp.party, jsonb_build_object(
           'yes', pp.yes, 'no', pp.no, 'present', pp.present, 'not_voting', pp.not_voting))
  FROM per_party pp
  GROUP BY pp.roll_call_id, pp.chamber
  ORDER BY min(pp.voted_at) DESC,
           substring(pp.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST,
           pp.roll_call_id DESC
$function$;

COMMENT ON FUNCTION public.proposal_vote_rolls(uuid) IS
  'FIX-1447 (cc-317 D1) — one row per roll of a proposal, newest first: the '
  'question, chamber, roll class (vote_roll_class), date, source link, the '
  'source''s own result when stored (else NULL), and the STORED rows'' counts. '
  'A roll''s stored rows are short of the roll (FIX-1448): rows_on_record and '
  'the counts are what Civitics holds, never the official count, and never a '
  'result. The proposal page''s one vote read.';

-- ── 2. Grants ─────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.proposal_vote_rolls(uuid) TO anon, authenticated, service_role;

-- The two helpers it calls run as the caller (see THE GRANTS above).
GRANT EXECUTE ON FUNCTION public.vote_roll_class(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_question_class(text) TO anon, authenticated;

-- ── 3. Read-back ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_want CONSTANT text := '35ee10d8653a61d2b9b4b96ec28eb69b';
  v_oid  oid := to_regprocedure('public.proposal_vote_rolls(uuid)');
  v_d    text;
  v_cfg  text[];
  v_vol  "char";
  v_sec  boolean;
  v_role text;
  v_fn   text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '[fix1447] read-back: proposal_vote_rolls(uuid) does not exist';
  END IF;
  SELECT md5(prosrc), proconfig, provolatile, prosecdef INTO v_d, v_cfg, v_vol, v_sec FROM pg_proc WHERE oid = v_oid;
  IF v_d IS DISTINCT FROM c_want THEN
    RAISE EXCEPTION '[fix1447] read-back: proposal_vote_rolls md5 % is not this file''s %', v_d, c_want;
  END IF;
  IF v_cfg IS NOT NULL OR v_vol <> 's' OR v_sec THEN
    RAISE EXCEPTION '[fix1447] read-back: proposal_vote_rolls proconfig % volatile % secdef % (want NULL, s, false)', v_cfg, v_vol, v_sec;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.proposal_vote_rolls(uuid)', 'public.vote_roll_class(text, text)', 'public.vote_question_class(text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '[fix1447] read-back: % cannot EXECUTE %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE '[fix1447] read-back ok: proposal_vote_rolls % · proconfig NULL · STABLE · invoker · anon/authenticated/service_role EXECUTE on it and both class helpers', v_d;
END $$;
