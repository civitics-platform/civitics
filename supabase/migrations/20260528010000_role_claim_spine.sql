-- =============================================================================
-- 20260528010000_role_claim_spine.sql
-- Role/claim spine, v1 schema.
--
-- Tables: entity_grants, grant_evidence, grant_events
-- Helper: has_active_constituent_grant(p_user_id, p_jurisdiction_id) -> boolean
--
-- v1 scope:
--   grant_role        = { constituent, platform_admin }
--   grant_target_type = { global, jurisdiction }
--   evidence_method   = { address_check, voter_roll, manual_review }
--
-- v2 expands these via pure ALTER TYPE ... ADD VALUE.
--
-- No consumer code, no UI, no API in this migration. All writes go through
-- the service role until v2 feature consumers land with INSERT policies.
-- =============================================================================

-- ── Enums ─────────────────────────────────────────────────────────────────

CREATE TYPE grant_target_type AS ENUM (
  'global',
  'jurisdiction'
);

CREATE TYPE grant_role AS ENUM (
  'constituent',
  'platform_admin'
);

CREATE TYPE grant_status AS ENUM (
  'pending', 'active', 'revoked', 'expired'
);

CREATE TYPE evidence_method AS ENUM (
  'address_check',
  'voter_roll',
  'manual_review'
);

CREATE TYPE evidence_outcome AS ENUM (
  'pending', 'approved', 'rejected', 'inconclusive'
);

-- ── grant_evidence ────────────────────────────────────────────────────────

CREATE TABLE public.grant_evidence (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  method       evidence_method NOT NULL,
  artifact_ref TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at  TIMESTAMPTZ,
  reviewer_id  UUID REFERENCES public.users(id),
  outcome      evidence_outcome NOT NULL DEFAULT 'pending',
  notes        TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX grant_evidence_user_id_idx ON public.grant_evidence(user_id);
CREATE INDEX grant_evidence_pending_idx ON public.grant_evidence(outcome) WHERE outcome = 'pending';

-- ── entity_grants ─────────────────────────────────────────────────────────

CREATE TABLE public.entity_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_type     grant_target_type NOT NULL,
  target_id       UUID,
  role            grant_role NOT NULL,
  status          grant_status NOT NULL DEFAULT 'pending',
  granted_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  granted_by      UUID REFERENCES public.users(id),
  evidence_id     UUID REFERENCES public.grant_evidence(id),
  delegated_from  UUID REFERENCES public.entity_grants(id),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT entity_grants_target_shape CHECK (
    (target_type = 'global'  AND target_id IS NULL) OR
    (target_type <> 'global' AND target_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX entity_grants_unique_active
  ON public.entity_grants(user_id, role, target_type, target_id)
  WHERE status = 'active';

CREATE INDEX entity_grants_target_active_idx
  ON public.entity_grants(target_type, target_id) WHERE status = 'active';

CREATE INDEX entity_grants_user_active_idx
  ON public.entity_grants(user_id) WHERE status = 'active';

CREATE INDEX entity_grants_expiry_idx
  ON public.entity_grants(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TRIGGER entity_grants_updated_at
  BEFORE UPDATE ON public.entity_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── grant_events (append-only ledger) ─────────────────────────────────────

CREATE TABLE public.grant_events (
  id          BIGSERIAL PRIMARY KEY,
  grant_id    UUID NOT NULL REFERENCES public.entity_grants(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  actor_id    UUID REFERENCES public.users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes       TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX grant_events_grant_id_idx ON public.grant_events(grant_id, occurred_at DESC);

-- ── Helper function — spine of every future RLS write policy ─────────────

CREATE OR REPLACE FUNCTION public.has_active_constituent_grant(
  p_user_id UUID,
  p_jurisdiction_id UUID
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.entity_grants
    WHERE user_id     = p_user_id
      AND role        = 'constituent'
      AND target_type = 'jurisdiction'
      AND target_id   = p_jurisdiction_id
      AND status      = 'active'
      AND (expires_at IS NULL OR expires_at > NOW())
  );
$$;

ALTER FUNCTION public.has_active_constituent_grant(UUID, UUID)
  SET statement_timeout = '2s';

GRANT EXECUTE ON FUNCTION public.has_active_constituent_grant(UUID, UUID)
  TO authenticated, anon;

-- ── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE public.entity_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grant_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grant_events   ENABLE ROW LEVEL SECURITY;

-- Read-own only in v1. Service-role handles all writes until feature
-- consumers land in v2.
CREATE POLICY "users_read_own_grants"
  ON public.entity_grants FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_read_own_evidence"
  ON public.grant_evidence FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_read_own_grant_events"
  ON public.grant_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.entity_grants g
    WHERE g.id = grant_events.grant_id AND g.user_id = auth.uid()
  ));
