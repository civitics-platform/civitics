-- FIX-583 (Investigations MVP PR3 of 3): promotion state machine + dispute
-- autotrip + private-person admin-clear. Design: Claude/civitics/design-investigations-mvp.md §5.
--
-- PR1 (20260614000100) shipped evidence_cards with a 5-state status
-- (proposed/corroborated/disputed/promoted/rejected) and, for edge cards, a
-- from/to/relationship_kind. This migration adds the machinery that moves a card
-- through that lifecycle:
--
--   * count_independent_corroborations() + a corroboration autotrip — an edge
--     card flips 'proposed' → 'corroborated' (PROMOTION ELIGIBILITY, never
--     promotion itself; decision 1) once ≥ CORROBORATION_THRESHOLD (=2)
--     INDEPENDENT edge cards assert the same edge. "Independent" = distinct
--     author_id AND distinct citation target (decision 2).
--   * evidence_cards_flag_autotrip() — mirrors entity_comments_flag_autotrip
--     (20260607050000): ≥3 unresolved 'investigation_evidence' flags →
--     'disputed', but ONLY for non-promoted cards (decision 7 — a reviewed,
--     promoted edge is never auto-yanked by a flag pile; it surfaces in the
--     admin dispute queue instead).
--   * investigation_edge_audit — an append-only ledger (mirrors grant_events,
--     20260528010000) of every promote / unpromote / reject / private-person
--     clear (decision 10).
--   * promote / unpromote / reject / clear admin RPCs.
--
-- Admin gate (decision 3): the moderation surface's existing ADMIN_EMAIL gate is
-- the authoritative control. ADMIN_EMAIL is not visible in SQL, so rather than
-- replicate it (or couple to the grant spine — explicitly out of scope), these
-- RPCs are SECURITY DEFINER and granted to **service_role only**. An ordinary
-- authenticated user therefore cannot reach them via PostgREST at all; the only
-- caller is the admin API route, which runs them through createAdminClient()
-- AFTER its own ADMIN_EMAIL check and passes the admin's id as p_actor_id for the
-- audit row (auth.uid() is NULL under service_role).
--
-- CORROBORATION_THRESHOLD = 2 is mirrored as a literal here from
-- packages/db/src/comment-kinds.ts.
--
-- Replay-safe: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS + CREATE. Unquoted search_path (the quoted form breaks
-- on prod Pro); per-function statement_timeout per house discipline.

-- ===========================================================================
-- a. count_independent_corroborations() — how many INDEPENDENT edge cards
--    assert this card's edge (decision 2)
-- ===========================================================================
-- "Independent" requires BOTH a distinct author_id AND a distinct cited record:
--   * one author with two citations does NOT corroborate (dedup by author);
--   * two authors citing the identical record do NOT corroborate (dedup by target).
-- The count is LEAST(distinct authors in the edge group, distinct tier-1/2
-- citation targets in the edge group). At the configured threshold of 2 this is
-- exact — when both counts ≥ 2 a valid (distinct-author, distinct-target) pair
-- always exists — and a safe monotone proxy above it (the metric is tunable).
CREATE OR REPLACE FUNCTION public.count_independent_corroborations(p_card_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH grp AS (
    SELECT ec2.id, ec2.author_id
    FROM public.evidence_cards ec1
    JOIN public.evidence_cards ec2
      ON ec2.claim_type        = 'edge'
     AND ec2.from_type         = ec1.from_type
     AND ec2.from_id           = ec1.from_id
     AND ec2.to_type           = ec1.to_type
     AND ec2.to_id             = ec1.to_id
     AND ec2.relationship_kind = ec1.relationship_kind
    WHERE ec1.id = p_card_id
      AND ec1.claim_type = 'edge'
  )
  SELECT LEAST(
    (SELECT count(DISTINCT author_id) FROM grp),
    (SELECT count(DISTINCT (c.target_type, c.target_id))
       FROM public.citations c
       JOIN grp ON grp.id = c.evidence_card_id
       WHERE c.citation_type IN ('internal_record','imported_entity'))
  )::int;
$$;

REVOKE ALL ON FUNCTION public.count_independent_corroborations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_independent_corroborations(uuid) TO authenticated, service_role;

-- ===========================================================================
-- b. Corroboration autotrip — flip 'proposed' → 'corroborated' at the threshold
-- ===========================================================================
-- Fires on citations INSERT, NOT evidence_cards INSERT: add_evidence_card inserts
-- the card BEFORE its first citation, so an evidence_cards trigger would run while
-- the corroborating card's own citation is still invisible (distinct-target
-- undercount). The citation insert is the first point where the full edge-group
-- state — every card AND every cited record — is visible. Covers both the atomic
-- add_evidence_card path and the add_citation path. Eligibility only, never
-- promotion (decision 1).
CREATE OR REPLACE FUNCTION public.evidence_cards_corroboration_autotrip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_card public.evidence_cards;
BEGIN
  SELECT * INTO v_card FROM public.evidence_cards WHERE id = NEW.evidence_card_id;
  IF v_card.id IS NULL OR v_card.claim_type <> 'edge' THEN
    RETURN NEW;
  END IF;

  -- CORROBORATION_THRESHOLD = 2 (packages/db/src/comment-kinds.ts).
  IF public.count_independent_corroborations(v_card.id) >= 2 THEN
    UPDATE public.evidence_cards ec
    SET status = 'corroborated'
    WHERE ec.claim_type        = 'edge'
      AND ec.from_type         = v_card.from_type
      AND ec.from_id           = v_card.from_id
      AND ec.to_type           = v_card.to_type
      AND ec.to_id             = v_card.to_id
      AND ec.relationship_kind = v_card.relationship_kind
      AND ec.status            = 'proposed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS citations_corroboration_autotrip ON public.citations;
CREATE TRIGGER citations_corroboration_autotrip
  AFTER INSERT ON public.citations
  FOR EACH ROW EXECUTE FUNCTION public.evidence_cards_corroboration_autotrip();

-- ===========================================================================
-- c. Dispute autotrip — ≥3 unresolved investigation_evidence flags → 'disputed'
-- ===========================================================================
-- Mirror of entity_comments_flag_autotrip (20260607050000), gated on the
-- 'investigation_evidence' content_type (reserved by 20260614000000). Promoted
-- cards are deliberately EXCLUDED from the auto-flip (decision 7): a reviewed,
-- promoted edge must never be removed by a Sybil flag pile — it surfaces in the
-- admin dispute queue (FIX-585) for manual review instead.
CREATE OR REPLACE FUNCTION public.evidence_cards_flag_autotrip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_unresolved int;
BEGIN
  IF NEW.content_type <> 'investigation_evidence' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
  INTO v_unresolved
  FROM public.content_flags
  WHERE content_type = 'investigation_evidence'
    AND content_id   = NEW.content_id
    AND resolved     = false;

  IF v_unresolved >= 3 THEN
    UPDATE public.evidence_cards
    SET status = 'disputed'
    WHERE id = NEW.content_id
      AND status IN ('proposed','corroborated');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_flags_investigation_evidence_autotrip ON public.content_flags;
CREATE TRIGGER content_flags_investigation_evidence_autotrip
  AFTER INSERT ON public.content_flags
  FOR EACH ROW EXECUTE FUNCTION public.evidence_cards_flag_autotrip();

-- ===========================================================================
-- d. investigation_edge_audit — append-only ledger (mirror grant_events)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.investigation_edge_audit (
  id               BIGSERIAL PRIMARY KEY,
  evidence_card_id uuid NOT NULL REFERENCES public.evidence_cards(id) ON DELETE CASCADE,
  event            text NOT NULL,
  actor_id         uuid REFERENCES public.users(id),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  notes            text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS investigation_edge_audit_card_idx
  ON public.investigation_edge_audit (evidence_card_id, occurred_at DESC);

ALTER TABLE public.investigation_edge_audit ENABLE ROW LEVEL SECURITY;
-- No client policies: the ledger is service_role-only (admin surface reads it via
-- the admin client). Append-only — never updated or deleted.
GRANT ALL ON public.investigation_edge_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.investigation_edge_audit_id_seq TO service_role;

COMMENT ON TABLE public.investigation_edge_audit IS
  'Investigations MVP PR3 (FIX-583): append-only ledger of admin promote / unpromote / reject / private-person-clear actions on evidence cards. Mirrors grant_events. Never mutated (decision 10).';

-- ===========================================================================
-- e. Admin RPCs (service_role-only; the ADMIN_EMAIL route is the gate)
-- ===========================================================================
-- p_actor_id is the admin's user id, passed by the route (auth.uid() is NULL
-- under the service-role client). Every action writes an audit row.

-- promote_evidence_edge — corroborated edge card → promoted + live entity_connections row
CREATE OR REPLACE FUNCTION public.promote_evidence_edge(
  p_card_id  uuid,
  p_actor_id uuid DEFAULT NULL
) RETURNS public.evidence_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_card     public.evidence_cards;
  v_best_tier int;
  v_result   public.evidence_cards;
BEGIN
  SELECT * INTO v_card FROM public.evidence_cards WHERE id = p_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;
  IF v_card.claim_type <> 'edge' THEN
    RAISE EXCEPTION 'only edge cards are promotable' USING ERRCODE = '22023';
  END IF;
  IF v_card.status <> 'corroborated' THEN
    RAISE EXCEPTION 'only a corroborated card can be promoted (status: %)', v_card.status USING ERRCODE = '42501';
  END IF;

  -- Tier floor (decision 9): only tier-1/2-cited cards are promotion-eligible.
  -- tier-1 = internal_record, tier-2 = imported_entity (tier-3 is rejected at write
  -- today, so this is a belt-and-braces guard).
  SELECT min(CASE c.citation_type WHEN 'internal_record' THEN 1 WHEN 'imported_entity' THEN 2 ELSE 3 END)
  INTO v_best_tier
  FROM public.citations c
  WHERE c.evidence_card_id = p_card_id;
  IF v_best_tier IS NULL OR v_best_tier > 2 THEN
    RAISE EXCEPTION 'only tier-1/2-cited cards are promotable' USING ERRCODE = '42501';
  END IF;

  UPDATE public.evidence_cards SET status = 'promoted' WHERE id = p_card_id RETURNING * INTO v_result;

  -- Immediately upsert the graph edge so it appears without waiting for the
  -- weekly rebuild. Authoritative edges win — ON CONFLICT DO NOTHING (mirror the
  -- _external pass). connection_type = relationship_kind (the assertable subset is
  -- all valid connection_type enum values; no enum change — decision 5).
  INSERT INTO public.entity_connections (
    from_type, from_id, to_type, to_id, connection_type,
    strength, evidence_count, evidence_source, evidence_ids
  )
  VALUES (
    v_card.from_type, v_card.from_id, v_card.to_type, v_card.to_id,
    v_card.relationship_kind::public.connection_type,
    0.400, 1, 'investigation', ARRAY[v_card.id]
  )
  ON CONFLICT (from_type, from_id, to_type, to_id, connection_type) DO NOTHING;

  INSERT INTO public.investigation_edge_audit (evidence_card_id, event, actor_id)
  VALUES (p_card_id, 'promoted', p_actor_id);

  RETURN v_result;
END;
$$;

-- unpromote_evidence_edge — reverse a promotion (delete the live row; rebuild stops re-creating it)
CREATE OR REPLACE FUNCTION public.unpromote_evidence_edge(
  p_card_id  uuid,
  p_actor_id uuid DEFAULT NULL
) RETURNS public.evidence_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_card   public.evidence_cards;
  v_result public.evidence_cards;
BEGIN
  SELECT * INTO v_card FROM public.evidence_cards WHERE id = p_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;
  IF v_card.status <> 'promoted' THEN
    RAISE EXCEPTION 'only a promoted card can be unpromoted (status: %)', v_card.status USING ERRCODE = '42501';
  END IF;

  -- Delete only the investigation-sourced row this card created. A derived edge
  -- that won the ON CONFLICT (different evidence_source) is left untouched.
  DELETE FROM public.entity_connections
  WHERE evidence_source = 'investigation'
    AND evidence_ids @> ARRAY[p_card_id];

  UPDATE public.evidence_cards SET status = 'corroborated' WHERE id = p_card_id RETURNING * INTO v_result;

  INSERT INTO public.investigation_edge_audit (evidence_card_id, event, actor_id)
  VALUES (p_card_id, 'unpromoted', p_actor_id);

  RETURN v_result;
END;
$$;

-- reject_evidence_edge — terminal rejection (also unwinds a live row if promoted)
CREATE OR REPLACE FUNCTION public.reject_evidence_edge(
  p_card_id  uuid,
  p_actor_id uuid DEFAULT NULL
) RETURNS public.evidence_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_card   public.evidence_cards;
  v_result public.evidence_cards;
BEGIN
  SELECT * INTO v_card FROM public.evidence_cards WHERE id = p_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;

  -- If a promoted card is being rejected, pull its live graph edge first.
  IF v_card.status = 'promoted' THEN
    DELETE FROM public.entity_connections
    WHERE evidence_source = 'investigation'
      AND evidence_ids @> ARRAY[p_card_id];
  END IF;

  UPDATE public.evidence_cards SET status = 'rejected' WHERE id = p_card_id RETURNING * INTO v_result;

  INSERT INTO public.investigation_edge_audit (evidence_card_id, event, actor_id)
  VALUES (p_card_id, 'rejected', p_actor_id);

  RETURN v_result;
END;
$$;

-- clear_private_person_card — admin clears subject_is_private_person for display
CREATE OR REPLACE FUNCTION public.clear_private_person_card(
  p_card_id  uuid,
  p_actor_id uuid DEFAULT NULL
) RETURNS public.evidence_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result public.evidence_cards;
BEGIN
  UPDATE public.evidence_cards
  SET subject_is_private_person = false
  WHERE id = p_card_id
  RETURNING * INTO v_result;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;

  INSERT INTO public.investigation_edge_audit (evidence_card_id, event, actor_id)
  VALUES (p_card_id, 'private_person_cleared', p_actor_id);

  RETURN v_result;
END;
$$;

-- service_role-only: the ADMIN_EMAIL-gated admin route is the only caller.
REVOKE ALL ON FUNCTION public.promote_evidence_edge(uuid, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unpromote_evidence_edge(uuid, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_evidence_edge(uuid, uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_private_person_card(uuid, uuid)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_evidence_edge(uuid, uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.unpromote_evidence_edge(uuid, uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_evidence_edge(uuid, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_private_person_card(uuid, uuid) TO service_role;
