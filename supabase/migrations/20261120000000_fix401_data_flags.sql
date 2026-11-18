-- FIX-401 — users can flag a data row.
--
-- content_flags covers user-generated content (comments, statements, evidence).
-- Nothing let a reader say "this official's name is misspelled" or "this source
-- is out of date" about the DATA itself. data_flags is that table: one row per
-- (entity, flagger, reason), written by POST /api/data-flags after its checks,
-- read and resolved by the admin moderation section through the service role.
--
-- Shape (cc-285 D1–D3):
--   * text + CHECK, not enum types. content_flags' enums have needed three
--     ALTER TYPE migrations; a CHECK is replaced in one statement.
--   * entity_type is the attribution vocabulary (ATTRIBUTION_ENTITY_TYPES in
--     packages/db/src/types/attribution.ts). entity_id has no FK: it is
--     polymorphic, and POST /api/data-flags checks existence with one
--     primary-key lookup in the mapped table before it writes.
--   * UNIQUE (entity_type, entity_id, flagger_user_id, reason): the same flag for
--     the same reason twice is a no-op. Its leading two columns serve the
--     per-entity lookup, so there is no separate (entity_type, entity_id) index.
--   * classification / classification_confidence / auto_resolved_at are slots
--     for a later auto-moderator. NOTHING writes them in this change.
--
-- The cap — 20 flags per flagger per rolling 24 hours — is enforced HERE, by a
-- BEFORE INSERT trigger counted on (flagger_user_id, created_at DESC), and not
-- only in the route: the insert-own policy below is a second write path (the
-- publishable key + a user's JWT, straight to PostgREST) that never passes
-- through the route. Over the cap it RAISEs 53400, the over-limit SQLSTATE the
-- comment / position / statement caps use (FIX-569); the route maps it to 429.
-- The literals 20 and '24 hours' are mirrored in apps/civitics/src/lib/data-flags.ts
-- and pinned against this file by data-flags.test.ts.
--
-- The authenticated INSERT grant is column-scoped to what a flagger supplies,
-- so a direct insert cannot pre-stamp created_at (dodging the cap's window),
-- a resolution, or a classification that would keep the row out of the queue.
--
-- promote_candidate_to_elected() (latest: 20261006010000) is deliberately NOT
-- extended in this file. A data flag is a moderation record of what a reader saw
-- at a URL; a promotion deletes the elected official row and files an
-- official_redirects row for its id (FIX-1278), so a flag's entity link still
-- lands on the surviving page and the admin can resolve it. Moving the rows is
-- filed as its own FIX, for the next redefinition of that function.
--
-- Idempotent: IF NOT EXISTS on the table and indexes, policies and the trigger
-- dropped and re-created by name, CREATE OR REPLACE on the function. No rewrite,
-- no data.

CREATE TABLE IF NOT EXISTS public.data_flags (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type               text NOT NULL
    CONSTRAINT data_flags_entity_type_check
      CHECK (entity_type IN ('official', 'proposal', 'agency', 'governing_body', 'financial_entity')),
  entity_id                 uuid NOT NULL,
  source                    text NULL
    CONSTRAINT data_flags_source_check
      CHECK (source IS NULL OR char_length(source) BETWEEN 1 AND 64),
  reason                    text NOT NULL
    CONSTRAINT data_flags_reason_check
      CHECK (reason IN ('wrong', 'outdated', 'missing_source', 'misspelled', 'other')),
  comment                   text NULL
    CONSTRAINT data_flags_comment_check
      CHECK (comment IS NULL OR char_length(comment) <= 500),
  flagger_user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at                timestamptz NOT NULL DEFAULT now(),
  classification            text NULL,
  classification_confidence numeric NULL
    CONSTRAINT data_flags_classification_confidence_check
      CHECK (classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1),
  auto_resolved_at          timestamptz NULL,
  admin_resolved_at         timestamptz NULL,
  resolved_by               uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resolution                text NULL
    CONSTRAINT data_flags_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('valid', 'invalid', 'duplicate', 'no_action')),
  CONSTRAINT data_flags_one_per_reason UNIQUE (entity_type, entity_id, flagger_user_id, reason)
);

-- The cap's count, and "my flags" newest-first.
CREATE INDEX IF NOT EXISTS data_flags_flagger_created
  ON public.data_flags (flagger_user_id, created_at DESC);

-- The admin queue: unresolved, newest first.
CREATE INDEX IF NOT EXISTS data_flags_pending
  ON public.data_flags (created_at DESC)
  WHERE admin_resolved_at IS NULL;

-- ── RLS — as content_flags has it ───────────────────────────────────────────
-- select-own and insert-own for signed-in users; no update or delete policy.
-- Admins read and resolve through the service role.
ALTER TABLE public.data_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_flags_select_own ON public.data_flags;
CREATE POLICY data_flags_select_own
  ON public.data_flags FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = flagger_user_id);

DROP POLICY IF EXISTS data_flags_insert_own ON public.data_flags;
CREATE POLICY data_flags_insert_own
  ON public.data_flags FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = flagger_user_id);

-- Grants restated. Supabase's default privileges hand a new public table ALL to
-- anon, authenticated and service_role, so the REVOKE names all of them.
REVOKE ALL ON TABLE public.data_flags FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.data_flags TO authenticated;
GRANT INSERT (entity_type, entity_id, source, reason, comment, flagger_user_id)
  ON TABLE public.data_flags TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.data_flags TO service_role;

-- ── The cap ─────────────────────────────────────────────────────────────────
-- SECURITY INVOKER: for a signed-in direct insert the count runs under
-- select-own, which is exactly the flagger's rows (insert-own pins
-- flagger_user_id to auth.uid()); the service role sees every row.
CREATE OR REPLACE FUNCTION public.data_flags_enforce_daily_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recent int;
BEGIN
  SELECT count(*) INTO v_recent
    FROM public.data_flags
   WHERE flagger_user_id = NEW.flagger_user_id
     AND created_at > now() - interval '24 hours';
  IF v_recent >= 20 THEN
    RAISE EXCEPTION 'data_flags: % flags by this user in the last 24 hours (cap 20)', v_recent
      USING ERRCODE = '53400';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.data_flags_enforce_daily_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS data_flags_daily_cap ON public.data_flags;
CREATE TRIGGER data_flags_daily_cap
  BEFORE INSERT ON public.data_flags
  FOR EACH ROW EXECUTE FUNCTION public.data_flags_enforce_daily_cap();

COMMENT ON TABLE public.data_flags IS
  'FIX-401: a reader''s flag on a data row (entity-level). Written by POST /api/data-flags; resolved in the admin moderation section. classification* / auto_resolved_at are unwritten slots for a future auto-moderator.';
