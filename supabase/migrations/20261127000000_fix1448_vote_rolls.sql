-- =============================================================================
-- FIX-1448 (cc-331 D1) — public.vote_rolls: one row per federal roll, holding
-- what the roll's own source prints: its totals, result, title and majority
-- requirement.
--
-- WHY. `votes` holds a row only for a member with an `officials` row. On prod
-- (cc-317 read 3, 2026-11-26) the median House roll stores 323 of ~432 casts
-- and the median Senate roll 84 of 100; 170 House rolls read Passed with stored
-- yes not above stored no; vote_result is empty on 1,893 of 2,223 Senate rolls
-- (FIX-1260 fixed the read for new rolls only). So a page cannot print a
-- roll's official count from `votes`, or an older Senate roll's result. The
-- roll files carry both, and the nightly parses them and keeps neither.
--
-- THE ROW. Keyed by roll_call_id, the value votes.roll_call_id holds
--   (`<year>-house-<NNN>`, `senate-<congress>-<session>-<NNNNN>`); no FK either
--   way, so neither table's writes wait on the other. Columns are named for
--   what the source prints (cc-331 read 1, 2026-11-27):
--     title                 House <vote-desc>, Senate <vote_title> (a session
--                           list's <title> is "<vote_title>; <document text>")
--     document_text         Senate <vote_document_text>; the House has none
--     result / result_text  House <vote-result> (no text); Senate <vote_result>
--                           and <vote_result_text>; a list's <result> is the
--                           short form ("Agreed to")
--     yea, nay, present,    House <vote-totals><totals-by-vote>; Senate
--     not_voting            <count> (<absent> is not_voting); a list carries
--                           yeas and nays only
--     majority_requirement  Senate <majority_requirement> (1/2, 3/5); House
--                           <vote-type>, which carries the two-thirds votes
--                           ("2/3 YEA-AND-NAY")
--     tie_breaker           Senate <tie_breaker>, only when cast
--     by_party              House <totals-by-party>, as printed
--     vote_date / voted_at  the roll's date (every source prints it) and its
--                           instant (the per-roll files carry a time; a list
--                           does not). D1 named one voted_at; read 1 split it.
--     source_modified_at    Senate <modify_date>; the House has none
--   NULL means the file that was read does not carry the field. An empty
--   element inside a present totals block is 0 (Senate <present/>). An empty
--   text element is NULL.
--
-- WHO WRITES IT. The nightly's votes phase (votes.ts, D3) for each new roll
--   whose vote rows it writes; the vote-rolls walker (vote-rolls.ts, D5) seeds
--   every stored roll and fills it from the per-roll files and the Senate
--   session lists. A per-roll file's fields are never overwritten by a list's;
--   a list fills only what is NULL; a later per-roll read replaces an earlier
--   one (vote-roll-row.ts mergeVoteRoll). Nothing reads it until cc-332.
--
-- GRANTS. RLS on, one SELECT policy to anon and authenticated (votes_select's
--   shape); SELECT to anon and authenticated; SELECT, INSERT, UPDATE to
--   service_role (the nightly upserts through PostgREST). votes carries
--   Supabase's default arwdDxtm for anon and authenticated, which RLS confines
--   to SELECT; this table grants only what that policy lets through.
--
-- CLASS: P. One empty table, its grants, policy and trigger, and a read-back.
-- ROLLBACK: DROP TABLE public.vote_rolls; (nothing reads it until cc-332; the
--   nightly's write is logged and counted, never fatal — D3).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.vote_rolls (
  roll_call_id          text PRIMARY KEY,
  chamber               text NOT NULL CHECK (chamber IN ('House', 'Senate')),
  congress              smallint NOT NULL,
  session               smallint NOT NULL CHECK (session IN (1, 2)),
  roll_number           integer NOT NULL,
  vote_date             date,
  voted_at              timestamptz,
  question              text,
  title                 text,
  document_text         text,
  result                text,
  result_text           text,
  yea                   integer,
  nay                   integer,
  present               integer,
  not_voting            integer,
  majority_requirement  text,
  tie_breaker           jsonb,
  by_party              jsonb,
  source_url            text NOT NULL,
  detail_source         text CHECK (detail_source IN ('clerk_xml', 'lis_roll_xml')),
  detail_fetched_at     timestamptz,
  detail_error          text,
  detail_error_at       timestamptz,
  list_fetched_at       timestamptz,
  source_modified_at    timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vote_rolls IS
  'FIX-1448: one row per federal roll, what its source prints (totals, result, title, majority requirement). NULL = the file read does not carry the field; an empty element in a present totals block is 0. Written by the nightly (votes.ts) and the vote-rolls walker; votes rows are NOT the official count.';

DROP TRIGGER IF EXISTS vote_rolls_updated_at ON public.vote_rolls;
CREATE TRIGGER vote_rolls_updated_at BEFORE UPDATE ON public.vote_rolls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vote_rolls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vote_rolls_select ON public.vote_rolls;
CREATE POLICY vote_rolls_select ON public.vote_rolls
  FOR SELECT TO anon, authenticated USING (true);

-- Supabase default-grants a new public table to anon, authenticated and
-- service_role, so the REVOKE names all of them.
REVOKE ALL ON TABLE public.vote_rolls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.vote_rolls TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.vote_rolls TO service_role;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';
  v_missing text[] := '{}';
  v_cols int;
  v_rls  boolean;
  v_pol  text;
  v_rows bigint;
  v_disp text;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vote_rolls';
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.vote_rolls'::regclass;
  SELECT string_agg(polname || ' ' || polcmd::text || ' ' || polroles::regrole[]::text || ' ' || pg_get_expr(polqual, polrelid), '; ')
    INTO v_pol FROM pg_policy WHERE polrelid = 'public.vote_rolls'::regclass;
  SELECT count(*) INTO v_rows FROM public.vote_rolls;
  SELECT md5(prosrc) INTO v_disp FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  IF v_cols IS DISTINCT FROM 29 THEN
    v_missing := v_missing || format('vote_rolls has %s columns, expected 29', v_cols)::text;
  END IF;
  IF v_rls IS DISTINCT FROM true THEN
    v_missing := v_missing || 'RLS is not enabled on vote_rolls'::text;
  END IF;
  IF v_pol IS DISTINCT FROM 'vote_rolls_select r {anon,authenticated} true' THEN
    v_missing := v_missing || format('policies read %L', v_pol)::text;
  END IF;
  IF NOT has_table_privilege('anon', 'public.vote_rolls', 'SELECT')
     OR has_table_privilege('anon', 'public.vote_rolls', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vote_rolls', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.vote_rolls', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.vote_rolls', 'UPDATE')
     OR has_table_privilege('service_role', 'public.vote_rolls', 'DELETE') THEN
    v_missing := v_missing || 'grants differ: SELECT to anon/authenticated, SELECT/INSERT/UPDATE to service_role, nothing else'::text;
  END IF;
  IF v_disp IS DISTINCT FROM c_disp THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (pin %s)', v_disp, c_disp)::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1448] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1448] read-back ok: vote_rolls % columns, % rows, RLS on, policy %; dispatch_one_unit %',
    v_cols, v_rows, v_pol, v_disp;
END $$;
