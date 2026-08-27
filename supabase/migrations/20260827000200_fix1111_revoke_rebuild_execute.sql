-- =============================================================================
-- FIX-1111 — REVOKE anon/authenticated EXECUTE on the recreated rebuild
--            procedure.
--
-- WHY THIS IS PART OF FIX-1111 AND NOT SCOPE CREEP. FIX-1111 DROPped
-- run_entity_connections_rebuild(text) and created (text, int). A freshly
-- created routine picks up Supabase's default grants, so the recreate
-- re-established `anon=X | authenticated=X` on it — measured on prod
-- immediately after the push:
--
--   run_entity_connections_rebuild(text,integer)
--     =X/postgres | postgres=X/postgres | anon=X/postgres
--     | authenticated=X/postgres | service_role=X/postgres
--
-- The grant is not a regression (the dropped one-arg version carried the same
-- default; FIX-1101 REVOKEd its three sibling FUNCTIONS but never this
-- PROCEDURE), but the recreate is what re-applied it, so closing it belongs
-- with the migration that did.
--
-- WHY IT MATTERS: this procedure starts a writer with a 5-hour internal budget.
-- Leaving it callable by the anonymous role means an unauthenticated
-- /rest/v1/rpc/ request is one connection away from the arm this entire line of
-- work exists to keep bounded.
--
-- SAFE: no PostgREST caller exists. Every reference in the tree is a pg_cron
-- command, a dashboard display string, or a packages/data script using a direct
-- pg.Client that connects as `postgres`. Verified by grep before writing.
--
-- Matches the posture the majority of cron-only procedures already have on prod
-- (enforce_cron_job_budgets, refresh_treemap_individuals_global,
-- rebuild_official_vote_stats, and FIX-1111's own ec_crawl_* helpers are all
-- already revoked).
--
-- Cross-ref project_rpc_execute_grant_hardening, FIX-1101, FIX-1111.
-- =============================================================================
REVOKE ALL ON PROCEDURE public.run_entity_connections_rebuild(text, int)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
