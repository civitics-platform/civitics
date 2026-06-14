-- FIX-577 (Investigations MVP PR1 of 3): backend foundation.
--
-- Investigations = a case file: an investigative question + evidence cards, where
-- the non-negotiable rule is NO CLAIM WITHOUT A CITATION TO A RECORD — the
-- structural moderation filter (design: Claude/civitics/design-investigations-mvp.md).
-- This migration is the DB layer only (schema + SECURITY DEFINER write RPCs + RLS).
-- The API routes are FIX-578; the case-file UI is PR2; claim→graph promotion is PR3.
--
-- Mirrors the C1 statement spine (20260608020000_statement_mode.sql): tables +
-- SECURITY DEFINER RPCs + a rating-summary trigger + per-user caps, all in one
-- migration; private ballots / public aggregates; direct REST writes denied by RLS.
--
--   * investigations   — one case file per row. ANY authenticated user may create
--                        (decision 5); the spam control is caps (decision 6), not a
--                        creation gate.
--   * evidence_cards   — claim + (atomically) its first citation. claim_type 'edge'
--                        (promotable relationship; PR3) vs 'context' (enriches the
--                        file, never promotable). relationship_kind is constrained to
--                        the human-assertable subset of connection_type so PR3
--                        promotion maps 1:1 with no enum change.
--   * citations        — provenance pointers. MVP = tiers 1–2 (internal_record /
--                        imported_entity) only; document_page / external_url columns
--                        are RESERVED but REJECTED at write (tier-3 needs counsel).
--   * evidence_ratings — two-axis (agree / valuable) private ballots; public
--                        aggregate in evidence_cards.rating_summary via trigger
--                        (mirror comment_ratings → entity_comments_refresh_rating_summary).
--
-- Discussion ABOUT an investigation rides the existing C1 entity_comments substrate:
-- 'investigation' is added to the entity_comments entity_type CHECK and to
-- submit_comment's per-entity-type kind vocab (mirrored in comment-kinds.ts;
-- guarded by the FIX-543 drift test). submit_comment is REDEFINED here (never by
-- editing the existing migration) so the drift test, which parses the LAST
-- migration defining submit_comment, points at this file.
--
-- Constants are MIRRORED here as literals from packages/db/src/comment-kinds.ts
-- (RATE_LIMITS.investigations=3, RATE_LIMITS.evidence_cards=30,
-- MAX_OPEN_INVESTIGATIONS_PER_USER=3, NEW_ACCOUNT_AGE_HOURS=24) and guarded by the
-- FIX-543 drift test. The over-limit SQLSTATE is 53400 (→ 429 at the route), the
-- same stable code the comment path uses.
--
-- Replay-safe on an EMPTY database: tables use IF NOT EXISTS; the enum value was
-- added in 20260614000000 with ADD VALUE IF NOT EXISTS; the entity_comments CHECK
-- recreate is DROP IF EXISTS + ADD (idempotent); every function is CREATE OR
-- REPLACE. search_path is the UNQUOTED comma form (the quoted form breaks on prod
-- Pro); per-function statement_timeout per house discipline.

-- ===========================================================================
-- a. investigations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.investigations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 200),
  question    text CHECK (question IS NULL OR char_length(question) <= 2000),
  -- Nullable polymorphic scope (the jurisdiction/entity the case file concerns).
  scope_type  text,
  scope_id    uuid,
  scope_note  text CHECK (scope_note IS NULL OR char_length(scope_note) <= 2000),
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','closed','archived')),
  findings_md text,
  created_by  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_seeded   boolean NOT NULL DEFAULT false,
  is_featured boolean NOT NULL DEFAULT false,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- b. evidence_cards
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.evidence_cards (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id          uuid NOT NULL REFERENCES public.investigations(id) ON DELETE CASCADE,
  author_id                 uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  claim_text                text NOT NULL CHECK (char_length(claim_text) BETWEEN 10 AND 2000),
  claim_type                text NOT NULL CHECK (claim_type IN ('edge','context')),
  -- Edge-only relationship endpoints (NULL for context). The endpoint types and
  -- relationship_kind mirror financial_relationships / entity_connections so a
  -- promoted edge card maps 1:1 onto an entity_connections row in PR3.
  from_type                 text CHECK (from_type IS NULL OR from_type IN ('financial_entity','official','agency','governing_body')),
  from_id                   uuid,
  to_type                   text CHECK (to_type IS NULL OR to_type IN ('financial_entity','official','agency','governing_body')),
  to_id                     uuid,
  -- The human-assertable subset of connection_type. Derivation-only values
  -- (vote_*, nomination_vote_*, co_sponsorship) are deliberately EXCLUDED — those
  -- must come from records, not assertions.
  relationship_kind         text CHECK (relationship_kind IS NULL OR relationship_kind IN (
                              'oversight','lobbying','revolving_door','appointment','holds_position',
                              'gift_received','contract_award','donation','family','business_partner',
                              'legal_representation','endorsement','member_of','owns','parent_of',
                              'affiliated_with'
                            )),
  status                    text NOT NULL DEFAULT 'proposed'
                              CHECK (status IN ('proposed','corroborated','disputed','promoted','rejected')),
  subject_is_private_person boolean NOT NULL DEFAULT false,
  rating_summary            jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- edge ⇒ all five endpoint cols NOT NULL; context ⇒ all NULL.
  CONSTRAINT evidence_cards_edge_shape CHECK (
    (claim_type = 'edge'
       AND from_type IS NOT NULL AND from_id IS NOT NULL
       AND to_type   IS NOT NULL AND to_id   IS NOT NULL
       AND relationship_kind IS NOT NULL)
    OR
    (claim_type = 'context'
       AND from_type IS NULL AND from_id IS NULL
       AND to_type   IS NULL AND to_id   IS NULL
       AND relationship_kind IS NULL)
  )
);

-- ===========================================================================
-- c. citations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.citations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_card_id uuid NOT NULL REFERENCES public.evidence_cards(id) ON DELETE CASCADE,
  citation_type    text NOT NULL
                     CHECK (citation_type IN ('internal_record','imported_entity','document_page','external_url')),
  -- Polymorphic target for tier-1 (internal_record) + tier-2 (imported_entity).
  target_type      text,
  target_id        uuid,
  external_url     text,     -- RESERVED for tier-3 'external_url' (rejected at write)
  excerpt          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Structural shape only; the write path additionally REJECTS tier-3 entirely.
  CONSTRAINT citations_target_shape CHECK (
    (citation_type IN ('internal_record','imported_entity') AND target_type IS NOT NULL AND target_id IS NOT NULL)
    OR (citation_type = 'external_url' AND external_url IS NOT NULL)
    OR (citation_type = 'document_page')
  )
);

-- ===========================================================================
-- d. evidence_ratings (private ballots; public aggregate is rating_summary)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.evidence_ratings (
  evidence_id uuid NOT NULL REFERENCES public.evidence_cards(id) ON DELETE CASCADE,
  rater_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agree       smallint NOT NULL DEFAULT 0 CHECK (agree IN (-1,0,1)),
  valuable    smallint NOT NULL DEFAULT 0 CHECK (valuable IN (-1,0,1)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evidence_id, rater_id)
);

-- ===========================================================================
-- e. Indexes
-- ===========================================================================
CREATE INDEX IF NOT EXISTS investigations_created_by_idx
  ON public.investigations (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS investigations_status_idx
  ON public.investigations (status, created_at DESC);
-- Featured-first listing.
CREATE INDEX IF NOT EXISTS investigations_featured_idx
  ON public.investigations (is_featured, created_at DESC)
  WHERE is_featured = true;
CREATE INDEX IF NOT EXISTS evidence_cards_investigation_idx
  ON public.evidence_cards (investigation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_cards_author_idx
  ON public.evidence_cards (author_id, created_at DESC);
-- PR3 corroboration: find independent edge cards asserting the same edge.
CREATE INDEX IF NOT EXISTS evidence_cards_edge_idx
  ON public.evidence_cards (from_type, from_id, to_type, to_id, relationship_kind)
  WHERE claim_type = 'edge';
CREATE INDEX IF NOT EXISTS citations_card_idx
  ON public.citations (evidence_card_id);

-- ===========================================================================
-- f. updated_at maintenance (house helper)
-- ===========================================================================
DROP TRIGGER IF EXISTS investigations_set_updated_at ON public.investigations;
CREATE TRIGGER investigations_set_updated_at
  BEFORE UPDATE ON public.investigations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS evidence_cards_set_updated_at ON public.evidence_cards;
CREATE TRIGGER evidence_cards_set_updated_at
  BEFORE UPDATE ON public.evidence_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS evidence_ratings_set_updated_at ON public.evidence_ratings;
CREATE TRIGGER evidence_ratings_set_updated_at
  BEFORE UPDATE ON public.evidence_ratings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- g. entity_comments entity_type CHECK — add 'investigation' (discussion rides C1)
-- ===========================================================================
-- The inline CHECK from 20260607050000 is named entity_comments_entity_type_check
-- (table_column_check convention). DROP IF EXISTS + ADD is idempotent on replay.
ALTER TABLE public.entity_comments DROP CONSTRAINT IF EXISTS entity_comments_entity_type_check;
ALTER TABLE public.entity_comments ADD CONSTRAINT entity_comments_entity_type_check
  CHECK (entity_type IN ('proposal','official','jurisdiction','institution','financial_entity','district','investigation'));

-- ===========================================================================
-- h. evidence_ratings rating-summary trigger (mirror comment_ratings)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.evidence_cards_refresh_rating_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_evidence_id uuid := COALESCE(NEW.evidence_id, OLD.evidence_id);
  v_agree_up   int;
  v_agree_down int;
  v_val_up     int;
  v_val_down   int;
BEGIN
  SELECT
    count(*) FILTER (WHERE agree = 1),
    count(*) FILTER (WHERE agree = -1),
    count(*) FILTER (WHERE valuable = 1),
    count(*) FILTER (WHERE valuable = -1)
  INTO v_agree_up, v_agree_down, v_val_up, v_val_down
  FROM public.evidence_ratings
  WHERE evidence_id = v_evidence_id;

  UPDATE public.evidence_cards
  SET rating_summary = jsonb_build_object(
        'agree_up',      COALESCE(v_agree_up, 0),
        'agree_down',    COALESCE(v_agree_down, 0),
        'valuable_up',   COALESCE(v_val_up, 0),
        'valuable_down', COALESCE(v_val_down, 0)
      )
  WHERE id = v_evidence_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS evidence_ratings_summary_aiud ON public.evidence_ratings;
CREATE TRIGGER evidence_ratings_summary_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.evidence_ratings
  FOR EACH ROW EXECUTE FUNCTION public.evidence_cards_refresh_rating_summary();

-- ===========================================================================
-- i. Citation-target existence validator (shared by add_evidence_card + add_citation)
-- ===========================================================================
-- Tier-1 (internal_record): the (target_type, target_id) must resolve to a real
-- row in the corresponding public table. Tier-2 (imported_entity): the target must
-- be a financial_entity whose primary_source marks it an imported third-party
-- network node (LittleSis / ICIJ — the "presence ≠ wrongdoing" tier-2 sources).
-- Tier-3 returns false here, but the RPCs reject tier-3 BEFORE calling this.
CREATE OR REPLACE FUNCTION public.investigation_citation_target_exists(
  p_citation_type text,
  p_target_type   text,
  p_target_id     uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN p_target_id IS NULL THEN false
    WHEN p_citation_type = 'imported_entity' THEN
      EXISTS (
        SELECT 1 FROM public.financial_entities fe
        WHERE fe.id = p_target_id
          AND fe.primary_source IN ('littlesis','icij')
      )
    WHEN p_citation_type = 'internal_record' THEN
      CASE p_target_type
        WHEN 'official'                THEN EXISTS (SELECT 1 FROM public.officials               WHERE id = p_target_id)
        WHEN 'proposal'                THEN EXISTS (SELECT 1 FROM public.proposals               WHERE id = p_target_id)
        WHEN 'vote'                    THEN EXISTS (SELECT 1 FROM public.votes                   WHERE id = p_target_id)
        WHEN 'financial_relationship'  THEN EXISTS (SELECT 1 FROM public.financial_relationships WHERE id = p_target_id)
        WHEN 'financial_entity'        THEN EXISTS (SELECT 1 FROM public.financial_entities      WHERE id = p_target_id)
        WHEN 'jurisdiction'            THEN EXISTS (SELECT 1 FROM public.jurisdictions           WHERE id = p_target_id)
        WHEN 'agency'                  THEN EXISTS (SELECT 1 FROM public.agencies                WHERE id = p_target_id)
        WHEN 'governing_body'          THEN EXISTS (SELECT 1 FROM public.governing_bodies        WHERE id = p_target_id)
        WHEN 'institution'             THEN EXISTS (SELECT 1 FROM public.institutions            WHERE id = p_target_id)
        WHEN 'entity_connection'       THEN EXISTS (SELECT 1 FROM public.entity_connections      WHERE id = p_target_id)
        ELSE false
      END
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.investigation_citation_target_exists(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.investigation_citation_target_exists(text, text, uuid) TO authenticated;

-- ===========================================================================
-- j. create_investigation() — ANY authenticated user; caps are the spam control
-- ===========================================================================
-- Open-investigation cap (MAX_OPEN_INVESTIGATIONS_PER_USER=3, HALVED for new
-- accounts < NEW_ACCOUNT_AGE_HOURS) + daily creation cap (RATE_LIMITS.investigations
-- =3). platform_admin / staff are exempt. Mirrors the bot-gate new-account halving
-- (20260613000000) and the comment-path rate-limit shape.
CREATE OR REPLACE FUNCTION public.create_investigation(
  p_title      text,
  p_question   text DEFAULT NULL,
  p_scope_type text DEFAULT NULL,
  p_scope_id   uuid DEFAULT NULL,
  p_scope_note text DEFAULT NULL
) RETURNS public.investigations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_title     text := btrim(COALESCE(p_title, ''));
  v_question  text := NULLIF(btrim(COALESCE(p_question, '')), '');
  v_exempt    boolean;
  v_is_new    boolean;     -- account younger than NEW_ACCOUNT_AGE_HOURS (24h)
  v_open_cap  int;         -- MAX_OPEN_INVESTIGATIONS_PER_USER (halved if new)
  v_daily_cap int;         -- RATE_LIMITS.investigations
  v_open      int;
  v_today     int;
  v_result    public.investigations;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF char_length(v_title) < 3 OR char_length(v_title) > 200 THEN
    RAISE EXCEPTION 'title must be between 3 and 200 characters' USING ERRCODE = '22023';
  END IF;
  IF v_question IS NOT NULL AND char_length(v_question) > 2000 THEN
    RAISE EXCEPTION 'question must be 2000 characters or fewer' USING ERRCODE = '22023';
  END IF;

  -- platform_admin / staff are exempt from every creation cap.
  v_exempt := EXISTS (
    SELECT 1 FROM public.entity_grants
    WHERE user_id     = v_user
      AND role        IN ('platform_admin','staff')
      AND target_type = 'global'
      AND status      = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  );

  IF NOT v_exempt THEN
    SELECT (now() - created_at < interval '24 hours') INTO v_is_new
    FROM public.users WHERE id = v_user;

    -- Per-user OPEN-investigation cap (the primary spam control), halved for new
    -- accounts (floors at 1 via integer division).
    v_open_cap := 3;  -- MAX_OPEN_INVESTIGATIONS_PER_USER
    IF COALESCE(v_is_new, false) THEN
      v_open_cap := v_open_cap / 2;  -- new-account halving
    END IF;
    SELECT count(*) INTO v_open
    FROM public.investigations
    WHERE created_by = v_user AND status = 'open';
    IF v_open >= v_open_cap THEN
      RAISE EXCEPTION 'open investigation limit reached (% open at once)', v_open_cap USING ERRCODE = '53400';
    END IF;

    -- Daily creation cap (rolling 24h).
    v_daily_cap := 3;  -- RATE_LIMITS.investigations
    SELECT count(*) INTO v_today
    FROM public.investigations
    WHERE created_by = v_user AND created_at >= now() - interval '1 day';
    IF v_today >= v_daily_cap THEN
      RAISE EXCEPTION 'daily investigation creation limit reached (% per day)', v_daily_cap USING ERRCODE = '53400';
    END IF;
  END IF;

  INSERT INTO public.investigations (title, question, scope_type, scope_id, scope_note, created_by)
  VALUES (v_title, v_question, NULLIF(btrim(COALESCE(p_scope_type,'')),''), p_scope_id,
          NULLIF(btrim(COALESCE(p_scope_note,'')),''), v_user)
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_investigation(text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_investigation(text, text, text, uuid, text) TO authenticated;

-- ===========================================================================
-- k. add_evidence_card() — ATOMIC card + first citation (the no-claim-without-
--    a-citation rule). A card with zero citations cannot exist.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.add_evidence_card(
  p_investigation_id        uuid,
  p_claim_text              text,
  p_claim_type              text,
  p_from_type               text DEFAULT NULL,
  p_from_id                 uuid DEFAULT NULL,
  p_to_type                 text DEFAULT NULL,
  p_to_id                   uuid DEFAULT NULL,
  p_relationship_kind       text DEFAULT NULL,
  p_subject_is_private_person boolean DEFAULT false,
  p_citation_type           text DEFAULT NULL,
  p_citation_target_type    text DEFAULT NULL,
  p_citation_target_id      uuid DEFAULT NULL,
  p_citation_excerpt        text DEFAULT NULL
) RETURNS public.evidence_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user           uuid := auth.uid();
  v_claim          text := btrim(COALESCE(p_claim_text, ''));
  v_inv_status     text;
  v_card_daily_cap int;     -- RATE_LIMITS.evidence_cards
  v_today          int;
  v_card           public.evidence_cards;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Investigation must exist and not be archived.
  SELECT status INTO v_inv_status FROM public.investigations WHERE id = p_investigation_id;
  IF v_inv_status IS NULL THEN
    RAISE EXCEPTION 'investigation not found' USING ERRCODE = '42704';
  END IF;
  IF v_inv_status = 'archived' THEN
    RAISE EXCEPTION 'investigation is archived' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_claim) < 10 OR char_length(v_claim) > 2000 THEN
    RAISE EXCEPTION 'claim must be between 10 and 2000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_claim_type NOT IN ('edge','context') THEN
    RAISE EXCEPTION 'claim_type must be edge or context' USING ERRCODE = '22023';
  END IF;

  -- Edge / context shape (the CHECK enforces it too; we RAISE a clean 400 first).
  IF p_claim_type = 'edge' THEN
    IF p_from_type IS NULL OR p_from_id IS NULL OR p_to_type IS NULL OR p_to_id IS NULL
       OR p_relationship_kind IS NULL THEN
      RAISE EXCEPTION 'an edge card requires from/to and a relationship_kind' USING ERRCODE = '22023';
    END IF;
    IF p_relationship_kind NOT IN (
        'oversight','lobbying','revolving_door','appointment','holds_position',
        'gift_received','contract_award','donation','family','business_partner',
        'legal_representation','endorsement','member_of','owns','parent_of','affiliated_with') THEN
      RAISE EXCEPTION 'relationship_kind ''%'' is not assertable', p_relationship_kind USING ERRCODE = '22023';
    END IF;
    IF p_from_type NOT IN ('financial_entity','official','agency','governing_body')
       OR p_to_type NOT IN ('financial_entity','official','agency','governing_body') THEN
      RAISE EXCEPTION 'edge endpoints must be financial_entity / official / agency / governing_body' USING ERRCODE = '22023';
    END IF;
  ELSE -- context
    IF p_from_type IS NOT NULL OR p_from_id IS NOT NULL OR p_to_type IS NOT NULL
       OR p_to_id IS NOT NULL OR p_relationship_kind IS NOT NULL THEN
      RAISE EXCEPTION 'a context card must not carry from/to/relationship_kind' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Citation: MVP is tiers 1–2 only. Reject tier-3 (document_page / external_url).
  IF p_citation_type IS NULL OR p_citation_type NOT IN ('internal_record','imported_entity') THEN
    IF p_citation_type IN ('document_page','external_url') THEN
      RAISE EXCEPTION 'tier-3 citations (document_page / external_url) are not enabled yet' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'a valid tier-1/2 citation is required (internal_record or imported_entity)' USING ERRCODE = '22023';
  END IF;
  IF NOT public.investigation_citation_target_exists(p_citation_type, p_citation_target_type, p_citation_target_id) THEN
    RAISE EXCEPTION 'citation target does not resolve to a record' USING ERRCODE = '42704';
  END IF;

  -- Per-user daily evidence-card cap (rolling 24h). New-account write throttling
  -- (Turnstile + edge limiter) is enforced at the app layer (FIX-569/570).
  v_card_daily_cap := 30;  -- RATE_LIMITS.evidence_cards
  SELECT count(*) INTO v_today
  FROM public.evidence_cards
  WHERE author_id = v_user AND created_at >= now() - interval '1 day';
  IF v_today >= v_card_daily_cap THEN
    RAISE EXCEPTION 'daily evidence-card limit reached (% per day)', v_card_daily_cap USING ERRCODE = '53400';
  END IF;

  -- Atomic: card + its first citation. The card cannot exist without a citation.
  INSERT INTO public.evidence_cards
    (investigation_id, author_id, claim_text, claim_type,
     from_type, from_id, to_type, to_id, relationship_kind, subject_is_private_person)
  VALUES
    (p_investigation_id, v_user, v_claim, p_claim_type,
     p_from_type, p_from_id, p_to_type, p_to_id, p_relationship_kind, COALESCE(p_subject_is_private_person, false))
  RETURNING * INTO v_card;

  INSERT INTO public.citations
    (evidence_card_id, citation_type, target_type, target_id, excerpt)
  VALUES
    (v_card.id, p_citation_type, p_citation_target_type, p_citation_target_id,
     NULLIF(btrim(COALESCE(p_citation_excerpt,'')),''));

  RETURN v_card;
END;
$$;

REVOKE ALL ON FUNCTION public.add_evidence_card(uuid, text, text, text, uuid, text, uuid, text, boolean, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_evidence_card(uuid, text, text, text, uuid, text, uuid, text, boolean, text, text, uuid, text) TO authenticated;

-- ===========================================================================
-- l. add_citation() — add a further citation to an existing card (author-only)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.add_citation(
  p_evidence_card_id uuid,
  p_citation_type    text,
  p_target_type      text DEFAULT NULL,
  p_target_id        uuid DEFAULT NULL,
  p_excerpt          text DEFAULT NULL
) RETURNS public.citations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_author uuid;
  v_result public.citations;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT author_id INTO v_author FROM public.evidence_cards WHERE id = p_evidence_card_id;
  IF v_author IS NULL THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;
  IF v_author <> v_user THEN
    RAISE EXCEPTION 'only the card author can add citations' USING ERRCODE = '42501';
  END IF;

  IF p_citation_type IS NULL OR p_citation_type NOT IN ('internal_record','imported_entity') THEN
    IF p_citation_type IN ('document_page','external_url') THEN
      RAISE EXCEPTION 'tier-3 citations (document_page / external_url) are not enabled yet' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'a valid tier-1/2 citation is required (internal_record or imported_entity)' USING ERRCODE = '22023';
  END IF;
  IF NOT public.investigation_citation_target_exists(p_citation_type, p_target_type, p_target_id) THEN
    RAISE EXCEPTION 'citation target does not resolve to a record' USING ERRCODE = '42704';
  END IF;

  INSERT INTO public.citations (evidence_card_id, citation_type, target_type, target_id, excerpt)
  VALUES (p_evidence_card_id, p_citation_type, p_target_type, p_target_id,
          NULLIF(btrim(COALESCE(p_excerpt,'')),''))
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.add_citation(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_citation(uuid, text, text, uuid, text) TO authenticated;

-- ===========================================================================
-- m. rate_evidence() — two-axis upsert; returns the fresh rating_summary
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.rate_evidence(
  p_evidence_id uuid,
  p_agree       smallint,
  p_valuable    smallint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_exists  boolean;
  v_summary jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_agree IS NULL OR p_agree NOT IN (-1,0,1) OR p_valuable IS NULL OR p_valuable NOT IN (-1,0,1) THEN
    RAISE EXCEPTION 'agree and valuable must each be -1, 0, or 1' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.evidence_cards WHERE id = p_evidence_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'evidence card not found' USING ERRCODE = '42704';
  END IF;

  INSERT INTO public.evidence_ratings (evidence_id, rater_id, agree, valuable)
  VALUES (p_evidence_id, v_user, p_agree, p_valuable)
  ON CONFLICT (evidence_id, rater_id) DO UPDATE
    SET agree = EXCLUDED.agree, valuable = EXCLUDED.valuable, updated_at = now();

  -- The rating-summary trigger recomputed it; return the fresh value.
  SELECT rating_summary INTO v_summary FROM public.evidence_cards WHERE id = p_evidence_id;
  RETURN v_summary;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_evidence(uuid, smallint, smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rate_evidence(uuid, smallint, smallint) TO authenticated;

-- ===========================================================================
-- n. set_investigation_findings() — creator-or-admin; findings + status
-- ===========================================================================
-- Allows open↔closed + editing findings_md by the creator (or platform_admin /
-- staff). Archiving is admin-only.
CREATE OR REPLACE FUNCTION public.set_investigation_findings(
  p_investigation_id uuid,
  p_findings_md      text DEFAULT NULL,
  p_new_status       text DEFAULT NULL
) RETURNS public.investigations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_creator uuid;
  v_exempt  boolean;
  v_result  public.investigations;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT created_by INTO v_creator FROM public.investigations WHERE id = p_investigation_id;
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'investigation not found' USING ERRCODE = '42704';
  END IF;

  v_exempt := EXISTS (
    SELECT 1 FROM public.entity_grants
    WHERE user_id     = v_user
      AND role        IN ('platform_admin','staff')
      AND target_type = 'global'
      AND status      = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  );

  IF v_creator <> v_user AND NOT v_exempt THEN
    RAISE EXCEPTION 'only the creator or an admin can edit this investigation' USING ERRCODE = '42501';
  END IF;

  IF p_new_status IS NOT NULL THEN
    IF p_new_status NOT IN ('open','closed','archived') THEN
      RAISE EXCEPTION 'status must be open, closed, or archived' USING ERRCODE = '22023';
    END IF;
    IF p_new_status = 'archived' AND NOT v_exempt THEN
      RAISE EXCEPTION 'only an admin can archive an investigation' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.investigations
  SET findings_md = COALESCE(p_findings_md, findings_md),
      status      = COALESCE(p_new_status, status)
  WHERE id = p_investigation_id
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_investigation_findings(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_investigation_findings(uuid, text, text) TO authenticated;

-- ===========================================================================
-- o. submit_comment() REDEFINITION — add 'investigation' as a comment target.
-- ===========================================================================
-- Verbatim re-emit of 20260610000100 (FIX-542) with exactly two additions:
--   (1) 'investigation' in the entity_type vocab guard, and
--   (2) a 'investigation' arm in the v_allowed CASE (kinds mirror ALLOWED_KINDS
--       .investigation in comment-kinds.ts: discussion / question / concern / evidence).
-- This becomes the LAST migration defining submit_comment, so the FIX-543 drift
-- test parses THIS file. Everything else is unchanged (answer-gate, body 10..2000,
-- depth ≤ 3, the FIX-542 20/day non-answer + 100/day answer split). 'investigation'
-- carries no jurisdiction, so it falls to the ELSE NULL constituent-snapshot arm.
CREATE OR REPLACE FUNCTION public.submit_comment(
  p_entity_type   text,
  p_entity_id     uuid,
  p_body          text,
  p_kind          text DEFAULT 'discussion',
  p_stance        text DEFAULT NULL,
  p_parent_id     uuid DEFAULT NULL,
  p_conditions_md text DEFAULT NULL
) RETURNS public.entity_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_kind         text := COALESCE(NULLIF(btrim(p_kind), ''), 'discussion');
  v_body         text := btrim(COALESCE(p_body, ''));
  v_stance       text := NULLIF(p_stance, '');
  v_allowed      text[];
  v_id           uuid := gen_random_uuid();
  v_parent       public.entity_comments;
  v_parent_depth int;
  v_thread_root  uuid;
  v_today        int;
  v_juris        uuid;
  v_result       public.entity_comments;
BEGIN
  -- auth → 401
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- entity_type vocab → 400
  IF p_entity_type NOT IN ('proposal','official','jurisdiction','institution','financial_entity','district','investigation') THEN
    RAISE EXCEPTION 'invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  -- kind ∈ per-entity-type vocab (mirrors ALLOWED_KINDS in comment-kinds.ts) → 400
  v_allowed := CASE p_entity_type
    WHEN 'proposal' THEN ARRAY['discussion','concern','amendment','question','evidence',
                               'precedent','tradeoff','stakeholder_impact','experience','cause','solution']
    WHEN 'official' THEN ARRAY['discussion','concern','question','evidence','stakeholder_impact','answer']
    WHEN 'jurisdiction' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact']
    WHEN 'institution' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact']
    WHEN 'financial_entity' THEN ARRAY['discussion']
    WHEN 'district' THEN ARRAY['discussion']
    WHEN 'investigation' THEN ARRAY['discussion','question','concern','evidence']
  END;
  IF NOT (v_kind = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid kind ''%'' for %', v_kind, p_entity_type USING ERRCODE = '22023';
  END IF;

  -- Answer-gate (was the Wave D INSERT-policy clause; now enforced here) → 403/400.
  IF v_kind = 'answer' THEN
    IF p_entity_type <> 'official' THEN
      RAISE EXCEPTION 'answers are only valid on officials' USING ERRCODE = '22023';
    END IF;
    IF p_parent_id IS NULL THEN
      RAISE EXCEPTION 'an answer must reply to a question' USING ERRCODE = '22023';
    END IF;
    IF NOT public.has_active_official_grant(v_user, p_entity_id) THEN
      RAISE EXCEPTION 'only the verified official can answer' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- stance vocab (mirrors the entity_comments.stance CHECK) → 400
  IF v_stance IS NOT NULL AND v_stance NOT IN ('support','oppose','conditional','neutral') THEN
    RAISE EXCEPTION 'invalid stance: %', v_stance USING ERRCODE = '22023';
  END IF;

  -- body length (mirrors the body CHECK 10..2000) → 400
  IF char_length(v_body) < 10 OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'comment must be between 10 and 2000 characters' USING ERRCODE = '22023';
  END IF;

  -- Threading: parent must exist, be on this entity, and keep depth ≤ 3.
  IF p_parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.entity_comments WHERE id = p_parent_id;
    IF v_parent.id IS NULL
       OR v_parent.entity_type <> p_entity_type
       OR v_parent.entity_id   <> p_entity_id THEN
      RAISE EXCEPTION 'parent comment not found' USING ERRCODE = '42704';
    END IF;
    IF v_kind = 'answer' AND v_parent.kind <> 'question' THEN
      RAISE EXCEPTION 'an answer must reply to a question' USING ERRCODE = '22023';
    END IF;
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS lvl FROM public.entity_comments WHERE id = p_parent_id
      UNION ALL
      SELECT e.id, e.parent_id, up.lvl + 1
      FROM public.entity_comments e JOIN up ON up.parent_id = e.id
    )
    SELECT max(lvl) INTO v_parent_depth FROM up;
    IF v_parent_depth + 1 > 3 THEN
      RAISE EXCEPTION 'maximum reply depth reached' USING ERRCODE = '22023';
    END IF;
    v_thread_root := COALESCE(v_parent.thread_root_id, v_parent.id);
  ELSE
    v_thread_root := v_id;
  END IF;

  -- Per-day rate limits (rolling 24h) → 429. FIX-542 split.
  IF v_kind = 'answer' THEN
    SELECT count(*) INTO v_today
    FROM public.entity_comments
    WHERE author_id = v_user AND kind = 'answer'
      AND created_at >= now() - interval '1 day';
    IF v_today >= 100 THEN
      RAISE EXCEPTION 'daily answer limit reached (100 per day)' USING ERRCODE = '53400';
    END IF;
  ELSE
    SELECT count(*) INTO v_today
    FROM public.entity_comments
    WHERE author_id = v_user AND kind <> 'answer'
      AND created_at >= now() - interval '1 day';
    IF v_today >= 20 THEN
      RAISE EXCEPTION 'daily comment limit reached (20 per day)' USING ERRCODE = '53400';
    END IF;
  END IF;

  -- Constituent badge snapshot. investigation / financial_entity / district carry
  -- no jurisdiction → ELSE NULL → no badge.
  v_juris := CASE p_entity_type
    WHEN 'jurisdiction' THEN p_entity_id
    WHEN 'proposal'     THEN (SELECT jurisdiction_id FROM public.proposals    WHERE id = p_entity_id)
    WHEN 'official'     THEN (SELECT jurisdiction_id FROM public.officials    WHERE id = p_entity_id)
    WHEN 'institution'  THEN (SELECT jurisdiction_id FROM public.institutions WHERE id = p_entity_id)
    ELSE NULL
  END;
  IF v_juris IS NOT NULL AND NOT public.has_active_constituent_grant(v_user, v_juris) THEN
    v_juris := NULL;
  END IF;

  INSERT INTO public.entity_comments
    (id, entity_type, entity_id, parent_id, thread_root_id, author_id,
     kind, stance, conditions_md, body, status, constituent_jurisdiction_id)
  VALUES
    (v_id, p_entity_type, p_entity_id, p_parent_id, v_thread_root, v_user,
     v_kind, v_stance, p_conditions_md, v_body, 'visible', v_juris)
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL    ON FUNCTION public.submit_comment(text, uuid, text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_comment(text, uuid, text, text, text, uuid, text) TO authenticated;

-- ===========================================================================
-- p. RLS
-- ===========================================================================
ALTER TABLE public.investigations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_cards  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_ratings ENABLE ROW LEVEL SECURITY;

-- investigations: public reads non-archived; creators always see their own.
-- No INSERT/UPDATE policies — the SECURITY DEFINER RPCs + service_role write.
DROP POLICY IF EXISTS investigations_select ON public.investigations;
CREATE POLICY investigations_select ON public.investigations
  FOR SELECT TO anon, authenticated
  USING (status <> 'archived' OR created_by = auth.uid());

-- evidence_cards: public reads, EXCEPT a private-person card stays hidden until it
-- is cleared (proxied by status='promoted'); authors always see their own.
DROP POLICY IF EXISTS evidence_cards_select ON public.evidence_cards;
CREATE POLICY evidence_cards_select ON public.evidence_cards
  FOR SELECT TO anon, authenticated
  USING (
    (subject_is_private_person = false OR status = 'promoted')
    OR author_id = auth.uid()
  );

-- citations: visible iff the parent card is visible to the reader (don't leak the
-- existence of a hidden private-person card via its provenance rows).
DROP POLICY IF EXISTS citations_select ON public.citations;
CREATE POLICY citations_select ON public.citations
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM public.evidence_cards ec
    WHERE ec.id = citations.evidence_card_id
      AND ((ec.subject_is_private_person = false OR ec.status = 'promoted')
           OR ec.author_id = auth.uid())
  ));

-- evidence_ratings: own-rows-only (writes via rate_evidence; belt-and-braces for
-- direct REST). Public exposure is the denormalized evidence_cards.rating_summary.
DROP POLICY IF EXISTS evidence_ratings_select_own ON public.evidence_ratings;
DROP POLICY IF EXISTS evidence_ratings_insert_own ON public.evidence_ratings;
DROP POLICY IF EXISTS evidence_ratings_update_own ON public.evidence_ratings;
DROP POLICY IF EXISTS evidence_ratings_delete_own ON public.evidence_ratings;
CREATE POLICY evidence_ratings_select_own ON public.evidence_ratings
  FOR SELECT TO authenticated USING (rater_id = auth.uid());
CREATE POLICY evidence_ratings_insert_own ON public.evidence_ratings
  FOR INSERT TO authenticated WITH CHECK (rater_id = auth.uid());
CREATE POLICY evidence_ratings_update_own ON public.evidence_ratings
  FOR UPDATE TO authenticated USING (rater_id = auth.uid());
CREATE POLICY evidence_ratings_delete_own ON public.evidence_ratings
  FOR DELETE TO authenticated USING (rater_id = auth.uid());

-- Table privileges (RLS still gates rows). Only SELECT for clients on the three
-- RPC-written tables; the SECURITY DEFINER functions insert/update as owner.
GRANT SELECT ON public.investigations TO anon, authenticated;
GRANT ALL    ON public.investigations TO service_role;
GRANT SELECT ON public.evidence_cards TO anon, authenticated;
GRANT ALL    ON public.evidence_cards TO service_role;
GRANT SELECT ON public.citations TO anon, authenticated;
GRANT ALL    ON public.citations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.evidence_ratings TO authenticated;
GRANT ALL    ON public.evidence_ratings TO service_role;

-- ===========================================================================
-- q. Table comments
-- ===========================================================================
COMMENT ON TABLE public.investigations IS
  'Investigations MVP PR1 (FIX-577): a case file = investigative question + evidence cards. ANY authenticated user creates (spam control = per-user open cap + daily caps, not a creation gate); writes via create_investigation / set_investigation_findings (SECURITY DEFINER). Public reads non-archived. Design: Claude/civitics/design-investigations-mvp.md.';
COMMENT ON TABLE public.evidence_cards IS
  'Investigations MVP PR1 (FIX-577): an evidence card = claim + (atomically) ≥1 citation — the no-claim-without-a-citation rule. claim_type edge (promotable; PR3) vs context. relationship_kind = the human-assertable subset of connection_type. Private-person cards stay hidden until cleared (status=promoted). Writes via add_evidence_card (atomic card+citation).';
COMMENT ON TABLE public.citations IS
  'Investigations MVP PR1 (FIX-577): provenance for an evidence card. MVP = tiers 1–2 (internal_record / imported_entity); document_page / external_url columns are RESERVED but rejected at write (tier-3 needs counsel). Target existence validated by investigation_citation_target_exists().';
COMMENT ON TABLE public.evidence_ratings IS
  'Investigations MVP PR1 (FIX-577): two-axis (agree / valuable) private ballots per (evidence_id, rater). Own-rows SELECT; public aggregate is the denormalized evidence_cards.rating_summary, maintained by trigger. Writes via rate_evidence().';
