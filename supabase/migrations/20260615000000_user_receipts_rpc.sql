-- FIX-596 (Commons/Desk MVP PR2): get_user_receipts() — the Citizen Desk
-- "permanent record" ledger. A read-time UNION over the caller's OWN authored
-- rows across the four participation surfaces (comments / positions / evidence
-- cards / statements), projected into one common receipt shape.
--
-- hybrid receipts: read-time union; durable user_actions log deferred (design §4.1)
--
-- WHY no user_actions table: every receipt type today IS a row the user already
-- owns, so a read-time union is exact and zero-maintenance. A durable log is only
-- needed once non-row receipt types exist (outcomes, docket IDs, data-desk
-- credits) — deferred until then (design §4.1 / decision 2).
--
-- SECURITY: SECURITY DEFINER + reads auth.uid() INTERNALLY (no user-id param), so
-- it can NEVER be coaxed into returning another user's rows. Every UNION branch
-- filters on auth.uid(). Mirrors the submit_comment / set_entity_position house
-- convention (SET search_path, per-function statement_timeout).
--
-- Replay-safe on an EMPTY database: CREATE OR REPLACE, no seed dependency, no
-- backfill. search_path uses the UNQUOTED comma form (quoted form breaks on prod
-- Pro). entity_positions.stance is a smallint (-3..3), carried as-is in detail.

CREATE OR REPLACE FUNCTION public.get_user_receipts(p_limit int DEFAULT 50)
RETURNS TABLE (
  action_type text,
  entity_type text,
  entity_id   uuid,
  ref_id      uuid,
  detail      jsonb,
  created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_limit int  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  -- a. authored comments / questions / investigation evidence notes
  SELECT
    CASE
      WHEN c.entity_type = 'investigation' THEN 'evidence_note'
      WHEN c.kind = 'question'             THEN 'question'
      ELSE 'comment'
    END                                            AS action_type,
    c.entity_type                                  AS entity_type,
    c.entity_id                                    AS entity_id,
    c.id                                           AS ref_id,
    jsonb_build_object('excerpt', left(c.body, 140), 'kind', c.kind) AS detail,
    c.created_at                                   AS created_at
  FROM public.entity_comments c
  WHERE c.author_id = v_user

  UNION ALL
  -- b. stated positions (stance is smallint -3..3)
  SELECT
    'position'                                     AS action_type,
    p.entity_type                                  AS entity_type,
    p.entity_id                                    AS entity_id,
    NULL::uuid                                     AS ref_id,
    jsonb_build_object('stance', p.stance)         AS detail,
    p.created_at                                   AS created_at
  FROM public.entity_positions p
  WHERE p.user_id = v_user

  UNION ALL
  -- c. evidence cards (linked to a case file; resolves as an investigation entity)
  SELECT
    'evidence_card'                                AS action_type,
    'investigation'                                AS entity_type,
    e.investigation_id                             AS entity_id,
    e.investigation_id                             AS ref_id,
    jsonb_build_object('status', e.status, 'claim', left(e.claim_text, 140)) AS detail,
    e.created_at                                   AS created_at
  FROM public.evidence_cards e
  WHERE e.author_id = v_user

  UNION ALL
  -- d. authored crowd statements
  SELECT
    'statement'                                    AS action_type,
    s.entity_type                                  AS entity_type,
    s.entity_id                                    AS entity_id,
    s.id                                           AS ref_id,
    jsonb_build_object('excerpt', left(s.body, 140)) AS detail,
    s.created_at                                   AS created_at
  FROM public.entity_statements s
  WHERE s.author_id = v_user

  ORDER BY created_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL    ON FUNCTION public.get_user_receipts(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_receipts(int) TO authenticated;

COMMENT ON FUNCTION public.get_user_receipts(int) IS
  'FIX-596 (Desk MVP PR2): the caller''s own participation ledger — read-time UNION over entity_comments / entity_positions / evidence_cards / entity_statements WHERE the row is authored by auth.uid(). SECURITY DEFINER, no user-id param (cannot return another user''s rows). Durable user_actions log deferred (design §4.1).';
