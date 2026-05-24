-- FIX-338 follow-up — function-level statement_timeout for the refresh.
-- Mirrors FIX-298 / FIX-303 split shape.
--
-- The GROUP BY over entity_connections is the real work; even at 5M+ rows
-- with the entity_connections_type index it completes in <2s standalone.
-- 5 min gives ample headroom for cron-time contention without masking
-- a real perf regression.

ALTER FUNCTION public.refresh_connection_type_counts()
  SET statement_timeout = '5min';

-- get_connection_type_counts() is now a 16-row SELECT — but keep its
-- existing timeout (set in 20260518000003_get_connection_type_counts_timeout.sql)
-- intact. The 120s ceiling there is harmless overkill on a sub-ms read
-- and gives us margin if the table later grows or partial-index logic
-- gets added.
