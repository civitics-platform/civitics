-- FIX-693 — install find_entity_path(), the BFS shortest-path RPC that three
-- call sites already invoke (and degrade gracefully without):
--   apps/civitics/app/api/graph/pathfinder/route.ts   (PathFinder UI)
--   apps/civitics/app/api/graph/snapshot/route.ts     (share-code path line)
--   packages/db getShortestPath()                     (repointed this commit)
--
-- Contract (matches what the call sites parse):
--   One row per node along the path, ordered start → end. `connection_type`
--   is the edge that led INTO that node (NULL on the first row — PathFinder
--   reads it from index 1 onward). Empty set = no path within budget.
--
-- Shape: iterative bidirectional-edge BFS over entity_connections (an edge
-- traverses both ways — both directions are indexed: (from_id, …) plus the
-- FIX-802 (to_id, connection_type) index). The visited set doubles as cycle
-- prevention; a hard 50k visited-node cap terminates hub blowups. No
-- in-function statement_timeout — that is a no-op for top-level PostgREST
-- RPCs (FIX-505/512); the role ceiling is the natural bound and every call
-- site already degrades gracefully on error.
CREATE OR REPLACE FUNCTION public.find_entity_path(
  p_from_id uuid,
  p_to_id uuid,
  p_max_hops int DEFAULT 3
)
RETURNS TABLE (
  hop int,
  entity_id uuid,
  entity_type text,
  entity_label text,
  connection_type text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_hops  int := LEAST(GREATEST(COALESCE(p_max_hops, 3), 1), 6);
  v_depth int := 0;
  v_new   int;
  v_total int := 1;
  v_cap   CONSTANT int := 50000;
BEGIN
  IF p_from_id IS NULL OR p_to_id IS NULL OR p_from_id = p_to_id THEN
    RETURN;
  END IF;

  -- Session-temp visited set; PK is the cycle guard. ON COMMIT DROP keeps
  -- repeated calls within one transaction safe (TRUNCATE resets between them).
  CREATE TEMP TABLE IF NOT EXISTS _fix693_bfs (
    node_id   uuid PRIMARY KEY,
    node_type text,
    prev_id   uuid,
    via_type  text,
    depth     int NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _fix693_bfs;

  INSERT INTO _fix693_bfs (node_id, node_type, prev_id, via_type, depth)
  VALUES (p_from_id, NULL, NULL, NULL, 0);

  WHILE v_depth < v_hops LOOP
    INSERT INTO _fix693_bfs (node_id, node_type, prev_id, via_type, depth)
    SELECT DISTINCT ON (n.node_id) n.node_id, n.node_type, n.prev_id, n.via_type, v_depth + 1
    FROM (
      SELECT ec.to_id AS node_id, ec.to_type AS node_type,
             f.node_id AS prev_id, ec.connection_type AS via_type
      FROM _fix693_bfs f
      JOIN public.entity_connections ec ON ec.from_id = f.node_id
      WHERE f.depth = v_depth
      UNION ALL
      SELECT ec.from_id, ec.from_type, f.node_id, ec.connection_type
      FROM _fix693_bfs f
      JOIN public.entity_connections ec ON ec.to_id = f.node_id
      WHERE f.depth = v_depth
    ) n
    ON CONFLICT (node_id) DO NOTHING;

    GET DIAGNOSTICS v_new = ROW_COUNT;
    v_total := v_total + v_new;
    v_depth := v_depth + 1;

    EXIT WHEN v_new = 0;                                                   -- frontier exhausted
    EXIT WHEN EXISTS (SELECT 1 FROM _fix693_bfs b WHERE b.node_id = p_to_id); -- target reached
    EXIT WHEN v_total >= v_cap;                                            -- hub-blowup guard
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM _fix693_bfs b WHERE b.node_id = p_to_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE walk AS (
    SELECT b.node_id, b.node_type, b.prev_id, b.via_type, b.depth
    FROM _fix693_bfs b WHERE b.node_id = p_to_id
    UNION ALL
    SELECT b.node_id, b.node_type, b.prev_id, b.via_type, b.depth
    FROM _fix693_bfs b
    JOIN walk w ON b.node_id = w.prev_id
  )
  SELECT
    w.depth,
    w.node_id,
    w.node_type,
    COALESCE(o.full_name, fe.display_name, pr.title, gb.name, ag.name, w.node_id::text),
    w.via_type
  FROM walk w
  LEFT JOIN public.officials          o  ON o.id  = w.node_id
  LEFT JOIN public.financial_entities fe ON fe.id = w.node_id
  LEFT JOIN public.proposals          pr ON pr.id = w.node_id
  LEFT JOIN public.governing_bodies   gb ON gb.id = w.node_id
  LEFT JOIN public.agencies           ag ON ag.id = w.node_id
  ORDER BY w.depth;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_entity_path(uuid, uuid, int) TO anon, authenticated, service_role;
