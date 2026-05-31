-- ============================================================================
-- 20260531000000_rls_hardening_safe.sql
--
-- RLS hardening — the NO-DECISION-NEEDED changes from the 2026-05-31 RLS audit.
-- See docs/audits/2026-05-31-rls-audit.md for the full findings + evidence.
--
-- ⚠️  STAGED, NOT YET APPLIED as of authoring. Apply only on explicit go-ahead:
--       local:  supabase migration up --local
--       prod :  supabase db push --db-url <prod direct-connection>
--                 (NOT --linked — that path hits the cli_login_postgres
--                  role-alter bug on this CLI version)
--
-- The is_active anon-RLS gate decision (Option A/B/C) is intentionally NOT here —
-- it lives in the sibling stub 20260531000100_rls_isactive_decision.sql.
--
-- All DDL below is env-portable (no hardcoded IDs) and re-run-safe.
-- ============================================================================

-- ── 1. page_views → LOCK ────────────────────────────────────────────────────
-- Clears linter rls_disabled_in_public + sensitive_columns_exposed (session_id).
-- Reader (api/claude/status/_lib/sections.ts) and writer (api/track-view/route.ts)
-- both use createAdminClient() = service_role (rolbypassrls=true, verified), so
-- locking does NOT affect tracking or the status dashboard. Anon currently reads
-- session_id AND (via the blanket GRANT ALL) can INSERT/UPDATE/DELETE/TRUNCATE.
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;
-- (no SELECT policy => anon/authenticated reads return zero rows)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.page_views FROM anon, authenticated;
COMMENT ON TABLE public.page_views IS
  'RLS locked (no policy). Server-only: written by api/track-view and read by the '
  'status route, both via createAdminClient (service_role bypasses RLS). Holds '
  'session_id — must never be anon-readable. RLS audit 2026-05-31.';

-- ── 2. Public-by-design transparency tables → enable RLS + public-read ───────
-- Each was RLS-OFF and anon-WRITABLE (proven: anon DELETE => HTTP 204). Enabling
-- RLS + a SELECT-only USING(true) policy preserves the already-public read surface
-- and, with no write policy + REVOKE, closes the anon write/TRUNCATE hole. Every
-- writer is a createAdminClient pipeline (service_role), unaffected by these policies.

-- proposal_cosponsors
ALTER TABLE public.proposal_cosponsors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_proposal_cosponsors_select ON public.proposal_cosponsors;
CREATE POLICY public_proposal_cosponsors_select ON public.proposal_cosponsors
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.proposal_cosponsors FROM anon, authenticated;

-- industry_codes
ALTER TABLE public.industry_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_industry_codes_select ON public.industry_codes;
CREATE POLICY public_industry_codes_select ON public.industry_codes
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.industry_codes FROM anon, authenticated;

-- lobbying_disclosures
ALTER TABLE public.lobbying_disclosures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_lobbying_disclosures_select ON public.lobbying_disclosures;
CREATE POLICY public_lobbying_disclosures_select ON public.lobbying_disclosures
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lobbying_disclosures FROM anon, authenticated;

-- irs990_officers
ALTER TABLE public.irs990_officers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_irs990_officers_select ON public.irs990_officers;
CREATE POLICY public_irs990_officers_select ON public.irs990_officers
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.irs990_officers FROM anon, authenticated;

-- irs990_filings
ALTER TABLE public.irs990_filings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_irs990_filings_select ON public.irs990_filings;
CREATE POLICY public_irs990_filings_select ON public.irs990_filings
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.irs990_filings FROM anon, authenticated;

-- irs990_grants_out
ALTER TABLE public.irs990_grants_out ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_irs990_grants_out_select ON public.irs990_grants_out;
CREATE POLICY public_irs990_grants_out_select ON public.irs990_grants_out
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.irs990_grants_out FROM anon, authenticated;

-- ── 3. external_source_refs → codify the out-of-band public-read policy ──────
-- xsr_public_read exists in the LIVE db (local + prod) but in NO migration; a fresh
-- rebuild would lose it and re-break attribution (FIX-398 silent-zero). RLS is
-- already enabled. This codifies the policy idempotently. All 19 writers are admin.
ALTER TABLE public.external_source_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xsr_public_read ON public.external_source_refs;
CREATE POLICY xsr_public_read ON public.external_source_refs
  FOR SELECT TO anon, authenticated USING (true);

-- ── 4. pipeline_state → narrow key-scoped public-read ───────────────────────
-- One anon read path: institutions/[id]/page.tsx:488 (createServerClient) reads
-- key='plum_book_state' and currently silently gets zero rows (RLS on, no policy).
-- A blanket USING(true) would expose sensitive keys (kill_switches, cost_config,
-- watermarks, manual_trigger_*). Scope the policy to the single benign public key.
DROP POLICY IF EXISTS pipeline_state_public_plum_select ON public.pipeline_state;
CREATE POLICY pipeline_state_public_plum_select ON public.pipeline_state
  FOR SELECT TO anon, authenticated USING (key = 'plum_book_state');
-- (Alternative, if you prefer zero new read surface: leave this policy out and
--  switch the institutions/[id]:488 read to createAdminClient() — that page is
--  already force-dynamic. Documented in the audit; pick one.)

-- ── 5. proposal_comment_stats → flip to security_invoker (safe) ─────────────
-- Clears linter security_definer_view. Identical rowset: the view filters
-- is_deleted=false and civic_comments' anon policy is USING(is_deleted=false), so
-- invoker-mode evaluation returns the same aggregate to anon as definer-mode today.
ALTER VIEW public.proposal_comment_stats SET (security_invoker = true);

-- ── 6. Document the leave-locked tables (rls_enabled_no_policy is intentional) ─
COMMENT ON TABLE public.enrichment_queue IS
  'RLS enabled, no policy: intentional. Server-only job queue; all access via '
  'createAdminClient (admin routes + drain/seed pipelines). RLS audit 2026-05-31.';
COMMENT ON TABLE public.external_relationships IS
  'RLS enabled, no policy: intentional. Written only by edgar/littlesis pipelines '
  '(admin); materialized into entity_connections via RPC. No anon read path. '
  'RLS audit 2026-05-31.';
COMMENT ON TABLE public.external_relationships_review_queue IS
  'RLS enabled, no policy: intentional. Admin-written review queue (edgar/littlesis). '
  'A future authenticated read policy may be added with the FIX-252 human-review UI. '
  'RLS audit 2026-05-31.';

-- ── 7. PostGIS / extension-owned exceptions (NO DDL — documentation only) ────
-- spatial_ref_sys, geography_columns, geometry_columns are owned by the postgis
-- extension. The linter flags them (rls_disabled / security_definer_view) but they
-- are the standard, accepted PostGIS exception — ALTERing them is unsafe/ineffective.
-- If you want to trim the only real surface, REVOKE anon writes on spatial_ref_sys
-- manually (left out here to avoid a migration failure if postgres is not its owner):
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spatial_ref_sys FROM anon, authenticated;
