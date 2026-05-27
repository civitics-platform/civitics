-- 20260526000002_xsr_public_read_rls.sql
-- FIX-408: public-read RLS policy on external_source_refs.
--
-- xsr has shipped with RLS enabled and zero policies since cutover
-- (20260421000001_stage1_02_external_source_refs.sql:L49-L50). That works
-- for pipelines (service_role bypasses RLS unconditionally), but it forces
-- every request-path attribution read to instantiate createAdminClient.
-- FIX-398's fetchAttributionForEntity adopted a lazy admin-client dance for
-- exactly this reason; the /api/attribution route does the same.
--
-- The metadata audit (FIX-403/408 design decision #5) confirmed xsr.metadata
-- carries only pipeline-context references (committee names, sync
-- watermarks, public reference fields) — no PII or credentials. Per-source
-- key inventory is in the FIX-408 commit body.
--
-- After this lands the helper + route collapse to a single client
-- (publishable-key for both reads).

CREATE POLICY xsr_public_read
  ON public.external_source_refs
  FOR SELECT
  TO anon, authenticated
  USING (true);
