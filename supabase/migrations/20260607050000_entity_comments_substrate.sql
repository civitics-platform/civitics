-- FIX-519 (C0): unified entity_comments substrate.
--
-- Replaces three incompatible comment systems (civic_comments,
-- official_community_comments, civic_initiative_arguments) with one
-- polymorphic table consumed by every entity detail page. Several columns
-- ship now but stay dormant for later phases (bridge_score / map_x / map_y,
-- conditions_md, the 'hidden_by_jury' status).
--
-- Polymorphic shape mirrors entity_tags (text discriminator) but with a CHECK
-- constraint. RLS hygiene mirrors 20260531000000_rls_hardening_safe.sql.
--
-- Replay-safe on an EMPTY database: no seed-data dependencies; the backfill is
-- plain idempotent DML guarded by NOT EXISTS that no-ops on empty sources.

-- ---------------------------------------------------------------------------
-- a. entity_comments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_comments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type                 text NOT NULL
    CHECK (entity_type IN ('proposal','official','jurisdiction','institution','financial_entity','district')),
  entity_id                   uuid NOT NULL,
  parent_id                   uuid REFERENCES public.entity_comments(id) ON DELETE CASCADE,
  thread_root_id              uuid,                       -- denormalized; root comments = own id; app-enforced depth <= 3
  author_id                   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind                        text NOT NULL DEFAULT 'discussion',
  stance                      text CHECK (stance IN ('support','oppose','conditional','neutral')),
  conditions_md               text,                       -- C1 conditional-support workflow; dormant
  body                        text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 2000),
  status                      text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible','needs_review','hidden_by_jury','withdrawn')),
  bridge_score                numeric,                    -- C1 nightly scorer; dormant
  map_x                       numeric,                    -- C1 debate map; dormant
  map_y                       numeric,                    -- C1 debate map; dormant
  rating_summary              jsonb NOT NULL DEFAULT '{}'::jsonb,
  constituent_jurisdiction_id uuid,                       -- snapshot-at-write badge (decision 11)
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Page read: visible/collapsed comments for an entity, newest first.
CREATE INDEX IF NOT EXISTS entity_comments_page_idx
  ON public.entity_comments (entity_type, entity_id, created_at DESC)
  WHERE status IN ('visible','needs_review');
-- Thread assembly.
CREATE INDEX IF NOT EXISTS entity_comments_thread_root_idx
  ON public.entity_comments (thread_root_id);
-- Rate-limit counts + author profile.
CREATE INDEX IF NOT EXISTS entity_comments_author_idx
  ON public.entity_comments (author_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- b. comment_ratings (two-axis ternary; private rows, public aggregate)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comment_ratings (
  comment_id uuid NOT NULL REFERENCES public.entity_comments(id) ON DELETE CASCADE,
  rater_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agree      smallint CHECK (agree IN (-1,0,1)),
  valuable   smallint CHECK (valuable IN (-1,0,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, rater_id)
);

-- ---------------------------------------------------------------------------
-- c. Triggers
-- ---------------------------------------------------------------------------

-- updated_at maintenance (house set_updated_at() helper).
DROP TRIGGER IF EXISTS entity_comments_set_updated_at ON public.entity_comments;
CREATE TRIGGER entity_comments_set_updated_at
  BEFORE UPDATE ON public.entity_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS comment_ratings_set_updated_at ON public.comment_ratings;
CREATE TRIGGER comment_ratings_set_updated_at
  BEFORE UPDATE ON public.comment_ratings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- (i) rating-summary maintenance: recompute the four counters into the
--     denormalized rating_summary, preserving any legacy_upvotes seed.
--     search_path is UNQUOTED comma-separated — the quoted form breaks on prod Pro.
CREATE OR REPLACE FUNCTION public.entity_comments_refresh_rating_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_comment_id uuid := COALESCE(NEW.comment_id, OLD.comment_id);
  v_agree_up   int;
  v_agree_down int;
  v_val_up     int;
  v_val_down   int;
  v_legacy     jsonb;
BEGIN
  SELECT
    count(*) FILTER (WHERE agree = 1),
    count(*) FILTER (WHERE agree = -1),
    count(*) FILTER (WHERE valuable = 1),
    count(*) FILTER (WHERE valuable = -1)
  INTO v_agree_up, v_agree_down, v_val_up, v_val_down
  FROM public.comment_ratings
  WHERE comment_id = v_comment_id;

  SELECT COALESCE(rating_summary -> 'legacy_upvotes', '0'::jsonb)
  INTO v_legacy
  FROM public.entity_comments
  WHERE id = v_comment_id;

  UPDATE public.entity_comments
  SET rating_summary = jsonb_build_object(
        'agree_up',       COALESCE(v_agree_up, 0),
        'agree_down',     COALESCE(v_agree_down, 0),
        'valuable_up',    COALESCE(v_val_up, 0),
        'valuable_down',  COALESCE(v_val_down, 0),
        'legacy_upvotes', COALESCE(v_legacy, '0'::jsonb)
      )
  WHERE id = v_comment_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS comment_ratings_summary_aiud ON public.comment_ratings;
CREATE TRIGGER comment_ratings_summary_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.comment_ratings
  FOR EACH ROW EXECUTE FUNCTION public.entity_comments_refresh_rating_summary();

-- (ii) flag auto-trip: when an entity_comment accumulates >= 3 unresolved
--      content_flags, collapse it (visible -> needs_review). Never auto-hide.
CREATE OR REPLACE FUNCTION public.entity_comments_flag_autotrip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_unresolved int;
BEGIN
  IF NEW.content_type <> 'entity_comment' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
  INTO v_unresolved
  FROM public.content_flags
  WHERE content_type = 'entity_comment'
    AND content_id = NEW.content_id
    AND resolved = false;

  IF v_unresolved >= 3 THEN
    UPDATE public.entity_comments
    SET status = 'needs_review'
    WHERE id = NEW.content_id
      AND status = 'visible';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_flags_entity_comment_autotrip ON public.content_flags;
CREATE TRIGGER content_flags_entity_comment_autotrip
  AFTER INSERT ON public.content_flags
  FOR EACH ROW EXECUTE FUNCTION public.entity_comments_flag_autotrip();

-- ---------------------------------------------------------------------------
-- d. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.entity_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_ratings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_comments_select      ON public.entity_comments;
DROP POLICY IF EXISTS entity_comments_insert_own  ON public.entity_comments;
DROP POLICY IF EXISTS entity_comments_update_own  ON public.entity_comments;

-- Public can read visible/collapsed comments; authors always see their own
-- (covers withdrawn + hidden_by_jury for the author).
CREATE POLICY entity_comments_select ON public.entity_comments
  FOR SELECT TO anon, authenticated
  USING (status IN ('visible','needs_review') OR author_id = auth.uid());
CREATE POLICY entity_comments_insert_own ON public.entity_comments
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid());
CREATE POLICY entity_comments_update_own ON public.entity_comments
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid());
-- No DELETE policy: withdraw via status, never hard delete.

DROP POLICY IF EXISTS comment_ratings_select_own ON public.comment_ratings;
DROP POLICY IF EXISTS comment_ratings_insert_own ON public.comment_ratings;
DROP POLICY IF EXISTS comment_ratings_update_own ON public.comment_ratings;
DROP POLICY IF EXISTS comment_ratings_delete_own ON public.comment_ratings;

-- Ratings are private rows; public reads come from rating_summary only.
CREATE POLICY comment_ratings_select_own ON public.comment_ratings
  FOR SELECT TO authenticated USING (rater_id = auth.uid());
CREATE POLICY comment_ratings_insert_own ON public.comment_ratings
  FOR INSERT TO authenticated WITH CHECK (rater_id = auth.uid());
CREATE POLICY comment_ratings_update_own ON public.comment_ratings
  FOR UPDATE TO authenticated USING (rater_id = auth.uid());
CREATE POLICY comment_ratings_delete_own ON public.comment_ratings
  FOR DELETE TO authenticated USING (rater_id = auth.uid());

-- Table privileges (RLS still gates rows). Writes from route handlers go
-- through the service_role admin client; the authenticated grants are
-- belt-and-braces for direct REST.
GRANT SELECT                 ON public.entity_comments TO anon;
GRANT SELECT, INSERT, UPDATE ON public.entity_comments TO authenticated;
GRANT ALL                    ON public.entity_comments TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.comment_ratings TO authenticated;
GRANT ALL                            ON public.comment_ratings TO service_role;

-- ---------------------------------------------------------------------------
-- e. Backfill (idempotent; reuses the source UUID as the new PK so parent_id
--    references resolve for free and the NOT EXISTS guard is a simple id check)
-- ---------------------------------------------------------------------------

-- civic_comments -> entity_comments('proposal')
-- position: support/oppose -> stance + same kind; neutral -> stance neutral,
-- kind discussion; question -> kind question (no stance); null -> discussion.
INSERT INTO public.entity_comments
  (id, entity_type, entity_id, parent_id, author_id, kind, stance, body, status,
   rating_summary, metadata, created_at, updated_at)
SELECT
  c.id, 'proposal', c.proposal_id, c.parent_id, c.user_id,
  CASE
    WHEN c.position = 'question'            THEN 'question'
    WHEN c.position IN ('support','oppose') THEN c.position
    ELSE 'discussion'
  END,
  CASE
    WHEN c.position IN ('support','oppose','neutral') THEN c.position
    ELSE NULL
  END,
  c.body,
  CASE WHEN c.is_deleted THEN 'withdrawn' ELSE 'visible' END,
  jsonb_build_object('legacy_upvotes', c.upvotes),
  jsonb_build_object('legacy', jsonb_build_object(
    'table', 'civic_comments', 'id', c.id::text, 'upvotes', c.upvotes)),
  c.created_at, c.updated_at
FROM public.civic_comments c
WHERE NOT EXISTS (SELECT 1 FROM public.entity_comments e WHERE e.id = c.id);

-- official_community_comments -> entity_comments('official'), kind discussion
INSERT INTO public.entity_comments
  (id, entity_type, entity_id, parent_id, author_id, kind, body, status,
   rating_summary, metadata, created_at, updated_at)
SELECT
  o.id, 'official', o.official_id, NULL, o.user_id, 'discussion', o.body,
  CASE WHEN o.is_deleted THEN 'withdrawn' ELSE 'visible' END,
  jsonb_build_object('legacy_upvotes', o.upvotes),
  jsonb_build_object('legacy', jsonb_build_object(
    'table', 'official_community_comments', 'id', o.id::text, 'upvotes', o.upvotes)),
  o.created_at, o.updated_at
FROM public.official_community_comments o
WHERE NOT EXISTS (SELECT 1 FROM public.entity_comments e WHERE e.id = o.id);

-- civic_initiative_arguments -> entity_comments('proposal') (initiative_id IS a proposals.id)
-- comment_type -> kind (null -> discussion); side for/against -> stance support/oppose;
-- is_deleted -> withdrawn. Rows with a null author_id (legacy ON DELETE SET NULL)
-- cannot be represented (author_id is NOT NULL) and are skipped.
INSERT INTO public.entity_comments
  (id, entity_type, entity_id, parent_id, author_id, kind, stance, body, status,
   metadata, created_at, updated_at)
SELECT
  a.id, 'proposal', a.initiative_id, a.parent_id, a.author_id,
  COALESCE(a.comment_type, 'discussion'),
  CASE a.side WHEN 'for' THEN 'support' WHEN 'against' THEN 'oppose' ELSE NULL END,
  a.body,
  CASE WHEN a.is_deleted THEN 'withdrawn' ELSE 'visible' END,
  jsonb_build_object('legacy', jsonb_build_object(
    'table', 'civic_initiative_arguments', 'id', a.id::text)),
  a.created_at, a.updated_at
FROM public.civic_initiative_arguments a
WHERE a.author_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.entity_comments e WHERE e.id = a.id);

-- Recompute thread_root_id for every row (root comments -> own id).
WITH RECURSIVE chain AS (
  SELECT id, parent_id, id AS root
  FROM public.entity_comments
  WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, ch.root
  FROM public.entity_comments c
  JOIN chain ch ON c.parent_id = ch.id
)
UPDATE public.entity_comments ec
SET thread_root_id = chain.root
FROM chain
WHERE ec.id = chain.id
  AND ec.thread_root_id IS DISTINCT FROM chain.root;

-- civic_initiative_argument_votes -> comment_ratings(valuable=1, agree=0).
-- The old single-axis vote meant "good argument", not "I agree".
-- (Fires the rating-summary trigger.)
INSERT INTO public.comment_ratings (comment_id, rater_id, agree, valuable, created_at, updated_at)
SELECT v.argument_id, v.user_id, 0, 1, v.created_at, v.created_at
FROM public.civic_initiative_argument_votes v
WHERE EXISTS (SELECT 1 FROM public.entity_comments e WHERE e.id = v.argument_id)
  AND NOT EXISTS (
    SELECT 1 FROM public.comment_ratings r
    WHERE r.comment_id = v.argument_id AND r.rater_id = v.user_id);

-- civic_initiative_argument_flags -> content_flags('entity_comment').
-- off_topic->off_topic, misleading->misinformation, duplicate->other(note),
-- other->other. (Fires the flag-autotrip trigger.)
INSERT INTO public.content_flags (content_type, content_id, user_id, reason, note, created_at)
SELECT
  'entity_comment', f.argument_id, f.user_id,
  (CASE f.flag_type
     WHEN 'off_topic'  THEN 'off_topic'
     WHEN 'misleading' THEN 'misinformation'
     WHEN 'duplicate'  THEN 'other'
     ELSE 'other'
   END)::flag_reason,
  CASE WHEN f.flag_type = 'duplicate' THEN 'duplicate' ELSE NULL END,
  f.created_at
FROM public.civic_initiative_argument_flags f
WHERE EXISTS (SELECT 1 FROM public.entity_comments e WHERE e.id = f.argument_id)
  AND NOT EXISTS (
    SELECT 1 FROM public.content_flags cf
    WHERE cf.content_type = 'entity_comment'
      AND cf.content_id = f.argument_id
      AND cf.user_id = f.user_id);

-- Provenance / count check.
DO $$
DECLARE
  v_src   bigint;
  v_dst   bigint;
BEGIN
  SELECT (SELECT count(*) FROM public.civic_comments)
       + (SELECT count(*) FROM public.official_community_comments)
       + (SELECT count(*) FROM public.civic_initiative_arguments WHERE author_id IS NOT NULL)
  INTO v_src;
  SELECT count(*) FROM public.entity_comments INTO v_dst;
  RAISE NOTICE 'entity_comments backfill: legacy source rows (eligible) = %, entity_comments rows = %', v_src, v_dst;
END $$;

-- ---------------------------------------------------------------------------
-- f. Freeze legacy: drop INSERT/UPDATE policies (keep SELECT; keep tables/data)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS civic_comments_insert                    ON public.civic_comments;
DROP POLICY IF EXISTS civic_comments_update                    ON public.civic_comments;
DROP POLICY IF EXISTS official_community_comments_insert       ON public.official_community_comments;
DROP POLICY IF EXISTS official_community_comments_update_own   ON public.official_community_comments;
DROP POLICY IF EXISTS civic_args_insert_own                    ON public.civic_initiative_arguments;
DROP POLICY IF EXISTS civic_args_update_own                    ON public.civic_initiative_arguments;
DROP POLICY IF EXISTS civic_arg_votes_insert_own               ON public.civic_initiative_argument_votes;

-- ---------------------------------------------------------------------------
-- g. Repoint reads to entity_comments (preserve column names/shapes)
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE (not DROP) so the dependent proposal_trending_24h MV
-- survives. Column set/order/types are identical to the civic_comments def.
CREATE OR REPLACE VIEW public.proposal_comment_stats AS
  SELECT
    ec.entity_id AS proposal_id,
    count(*)::integer AS comment_count,
    count(DISTINCT ec.author_id)::integer AS distinct_commenters,
    max(ec.created_at) AS last_commented_at,
    count(*) FILTER (WHERE ec.created_at >= (now() - '24:00:00'::interval))::integer AS comments_24h,
    count(*) FILTER (WHERE ec.created_at >= (now() - '7 days'::interval))::integer AS comments_7d
  FROM public.entity_comments ec
  WHERE ec.entity_type = 'proposal'
    AND ec.status IN ('visible','needs_review')
  GROUP BY ec.entity_id;

-- Preserve the deliberate security_invoker flip from the RLS audit.
ALTER VIEW public.proposal_comment_stats SET (security_invoker = true);

-- proposal_trending_24h reads the view above, so a refresh repoints it.
REFRESH MATERIALIZED VIEW public.proposal_trending_24h;

COMMENT ON TABLE public.entity_comments IS
  'Unified polymorphic comment substrate (C0, FIX-519). Replaces civic_comments / official_community_comments / civic_initiative_arguments. Public reads visible/needs_review; ratings live in comment_ratings (private rows, public rating_summary).';
COMMENT ON TABLE public.comment_ratings IS
  'Two-axis ternary comment ratings (agree/valuable). Private rows (own-row RLS); public aggregate maintained in entity_comments.rating_summary by trigger.';
