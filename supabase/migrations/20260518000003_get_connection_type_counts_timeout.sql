-- 20260518000003_get_connection_type_counts_timeout.sql
-- FIX-298 follow-up — raise function-level statement_timeout for
-- get_connection_type_counts.
--
-- Post-deploy verification surfaced "canceling statement due to statement
-- timeout" on prod: the GROUP BY over 5.1 M-row entity_connections
-- (indexed on connection_type, but the planner still has to scan to
-- aggregate) exceeded service_role's default per-statement timeout when
-- called from the platform-snapshot cron path. Local at 2.5 M rows ran in
-- ~1.6 s — prod is roughly 2× and the cold-cache page reads pushed it
-- past the default. Same approach as FIX-291's donations chunk timeout
-- raise — bump the function's own GUC, leave the session default alone.

ALTER FUNCTION public.get_connection_type_counts()
  SET statement_timeout = '120s';
