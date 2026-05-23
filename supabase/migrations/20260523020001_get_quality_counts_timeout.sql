-- 20260523020001_get_quality_counts_timeout.sql
-- FIX-333 follow-up — function-level statement_timeout for
-- get_quality_counts. Same split shape as FIX-298 / FIX-303 timeout
-- migrations. 60 s headroom for cron cold-cache contention; the function
-- runs sub-second under the existing indexes (idx_proposals_vote_category,
-- financial_entities_entity_type, entity_connections_type,
-- idx_entity_tags_entity).

ALTER FUNCTION public.get_quality_counts()
  SET statement_timeout = '60s';
