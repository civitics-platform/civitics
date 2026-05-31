-- ============================================================================
-- 20260531000100_rls_isactive_decision.sql
--
-- is_active anon-RLS gate remediation. DECISION MADE 2026-05-31: **Option A** —
-- relax officials / governing_bodies / agencies to USING(true) and move
-- active/"former" handling to the display layer.
--
-- See docs/audits/2026-05-31-rls-audit.md §3 for the counts/samples behind this.
-- Resolves FIX-412 (officials 404) + FIX-413 (gb visibility). FIX-415 is NOT this
-- bug (it is NULL primary_source on 8 agencies) and is intentionally untouched.
--
-- ⚠️  STAGED, NOT YET APPLIED. Apply only on explicit go-ahead, together with the
--     sibling 20260531000000_rls_hardening_safe.sql:
--       local:  supabase migration up --local
--       prod :  supabase db push --db-url <prod direct-connection>
--                 (NOT --linked — cli_login_postgres role-alter bug)
--
-- Follow-up (separate, not blocking): a display-layer "Former / Inactive" badge +
-- default active-only filter on the officials / institutions hub UIs, so relaxing
-- the gate does not make every inactive row read as if it were current.
-- ============================================================================

-- ── OPTION A (CHOSEN) — relax the three gates to USING(true) ─────────────────
ALTER POLICY public_officials_select        ON public.officials        USING (true);
ALTER POLICY public_governing_bodies_select ON public.governing_bodies USING (true);
ALTER POLICY public_agencies_select         ON public.agencies         USING (true);

-- Under Option A the institutions SECURITY DEFINER view can safely become
-- security_invoker: the underlying gates are now permissive, so the view returns
-- the same rows it does today (definer) while becoming consistent with direct
-- table reads. Clears linter security_definer_view for institutions. (FIX-455)
ALTER VIEW public.institutions SET (security_invoker = true);


-- ============================================================================
-- Alternatives NOT chosen (kept for the record — do NOT uncomment):
--
-- OPTION B — keep the gate, curate is_active per row (FIX-413 audit-half):
--   UPDATE public.governing_bodies SET is_active = true WHERE id IN (/* curated */);
--   UPDATE public.officials        SET is_active = true WHERE id IN (/* curated */);
--   (Under B, do NOT flip institutions to security_invoker — it would 404 the
--    still-inactive gbs' /institutions/[id] detail pages.)
--
-- OPTION C — per-table mix (e.g. relax officials + governing_bodies, keep agencies):
--   ALTER POLICY public_officials_select        ON public.officials        USING (true);
--   ALTER POLICY public_governing_bodies_select ON public.governing_bodies USING (true);
--   (institutions invoker flip only safe if every unioned table's gate is permissive.)
-- ============================================================================
