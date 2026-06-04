-- FIX-476: get_top_connected_officials(p_limit) — honest top-N over the whole
-- entity_connections table via GROUP BY, replacing the request-path sample in
-- /api/graph/connections (default view) that did two `.limit(3000)` selects —
-- silently capped to 1000 by PostgREST max_rows, with NO ORDER BY, so the
-- "top 10 most connected officials" were the 10 most frequent within an
-- arbitrary 1000-row slice of ~143k rows (i.e. effectively random).
--
-- Counts an official's degree across BOTH edge directions (from_type/to_type =
-- 'official'). RPCs aren't subject to the PostgREST row cap, so the GROUP BY
-- sees every row. statement_timeout sized for a cold GROUP BY over the table.
--
-- Reverse: DROP FUNCTION public.get_top_connected_officials(integer);

CREATE OR REPLACE FUNCTION public.get_top_connected_officials(p_limit integer DEFAULT 10)
RETURNS TABLE (entity_id uuid, connection_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT entity_id, count(*) AS connection_count
    FROM (
      SELECT from_id AS entity_id FROM public.entity_connections WHERE from_type = 'official'
      UNION ALL
      SELECT to_id   AS entity_id FROM public.entity_connections WHERE to_type   = 'official'
    ) s
   GROUP BY entity_id
   ORDER BY connection_count DESC, entity_id
   LIMIT GREATEST(p_limit, 0);
$$;

ALTER FUNCTION public.get_top_connected_officials(integer) SET statement_timeout = '60s';
