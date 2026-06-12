-- FIX-557: v2 grant-spine helpers — platform-admin gate + grant-expiry sweep
-- + pending-queue index.
--
-- Depends on 20260612000000_grant_spine_v2_enums.sql having committed (split
-- per the FIX-536 enum-reference rule). Replay-safe on an empty DB: every
-- statement is CREATE OR REPLACE / IF NOT EXISTS, no seed-data dependencies.
-- search_path is UNQUOTED comma form on every function (the quoted form
-- breaks on prod Pro); per-function statement_timeout per house discipline.

-- ---------------------------------------------------------------------------
-- a. has_active_platform_admin_grant() — admin-surface gate (mirrors
--    has_active_official_grant in 20260608030100_qa_lane.sql). True iff the
--    user holds an active, unexpired global 'platform_admin' grant.
--    target_id IS NULL for target_type='global' (entity_grants_target_shape),
--    so it is deliberately not filtered on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_platform_admin_grant(
  p_user_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.entity_grants
    WHERE user_id     = p_user_id
      AND role        = 'platform_admin'
      AND target_type = 'global'
      AND status      = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;

ALTER FUNCTION public.has_active_platform_admin_grant(uuid)
  SET statement_timeout = '2s';

GRANT EXECUTE ON FUNCTION public.has_active_platform_admin_grant(uuid)
  TO authenticated, anon;

COMMENT ON FUNCTION public.has_active_platform_admin_grant(uuid) IS
  'FIX-557: true iff the user holds an active, unexpired global platform_admin grant. Gates /admin/grants (and future admin surfaces) alongside the ADMIN_EMAIL env check.';

-- ---------------------------------------------------------------------------
-- b. expire_lapsed_grants() — nightly sweep. Flips lapsed active grants to
--    'expired' and writes one grant_events row per flipped grant. Returns the
--    flipped count. Called from /api/cron/nightly-sync after the canary write
--    (no new Vercel cron — the Hobby plan caps at 2). Idempotent: a second
--    run in the same instant flips nothing and returns 0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_lapsed_grants()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '30s'
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH flipped AS (
    UPDATE public.entity_grants
    SET status = 'expired'
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING id
  ),
  logged AS (
    INSERT INTO public.grant_events (grant_id, event, actor_id, metadata)
    SELECT id, 'expired', NULL, jsonb_build_object('source', 'expire_lapsed_grants')
    FROM flipped
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM logged;

  RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_lapsed_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_lapsed_grants() TO service_role;
-- service_role only — the sweep is invoked by the cron route's admin client.
-- No authenticated/anon grant: an arbitrary signed-in user must not be able
-- to trigger status flips, even harmless ones.

COMMENT ON FUNCTION public.expire_lapsed_grants() IS
  'FIX-557: flips active grants whose expires_at has passed to status=expired, writing a grant_events event=expired row per grant. Returns the flipped count. Invoked nightly from the Vercel nightly-sync cron route via service role.';

-- ---------------------------------------------------------------------------
-- c. Pending-queue index. The existing entity_grants indexes are all partial
--    on status='active' (unique_active, target_active, user_active, expiry) —
--    nothing covers the /admin/grants queue scan (status='pending' ordered by
--    created_at). Tiny today, but a partial index keeps it index-driven as
--    grants accumulate.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS entity_grants_pending_idx
  ON public.entity_grants (created_at DESC)
  WHERE status = 'pending';
