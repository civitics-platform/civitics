-- 20260520000001_get_proposal_counts_by_agency_timeout.sql
-- FIX-303 follow-up — raise function-level statement_timeout for
-- get_proposal_counts_by_agency.
--
-- Same split shape as FIX-298 (get_connection_type_counts_timeout.sql) and
-- FIX-291 (donations_chunk_timeout_raise.sql). The full GROUP BY scan over
-- proposals (~73k rows local, similar on prod) returns sub-second under the
-- functional index, but the cron + homepage cold-cache reads can stretch
-- closer to default service_role timeout under contention. 60s gives headroom
-- without masking a real perf regression.

ALTER FUNCTION public.get_proposal_counts_by_agency()
  SET statement_timeout = '60s';
