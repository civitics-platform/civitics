-- FIX-693 v2 — bidirectional BFS. The v1 unidirectional BFS (20260711140000)
-- timed out past the 8s service-role cap on prod for a MODEST pair (degrees
-- 1929 / 227): hop 2 expands every hop-1 neighbor's edge list, and donors fan
-- out to hundreds of recipients, so the work is degree × fanout (~10^5–10^6
-- rows) on a cache-starved Small instance. v2 expands whichever frontier is
-- smaller and stops at the first meet — the dominant 2-hop shared-donor case
-- costs ~degree(from) + degree(to) rows instead.
--
-- Same contract as v1: one row per node ordered from → to; connection_type is
-- the edge that led INTO that node (NULL on the first row); empty set = no
-- path within budget. Temp-table BFS means the function only runs in a
-- read-write transaction — PostgREST POST rpc (what all call sites use) is
-- read-write; a read-only caller gets "cannot execute CREATE TABLE".
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
  v_hops       int := LEAST(GREATEST(COALESCE(p_max_hops, 3), 1), 6);
  v_cap        CONSTANT int := 50000;
  v_total      int := 2;
  v_side       text;
  v_depth_a    int := 0;
  v_depth_b    int := 0;
  v_frontier_a int := 1;
  v_frontier_b int := 1;
  v_new        int;
  v_meet       uuid;
  v_node       uuid;
  v_prev       uuid;
  v_via        text;
  v_ntype      text;
  v_next_via   text;
  v_ord        int;
BEGIN
  IF p_from_id IS NULL OR p_to_id IS NULL OR p_from_id = p_to_id THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _fix693_bbfs (
    side      text NOT NULL,
    node_id   uuid NOT NULL,
    node_type text,
    prev_id   uuid,
    via_type  text,
    depth     int NOT NULL,
    PRIMARY KEY (side, node_id)
  ) ON COMMIT DROP;
  TRUNCATE _fix693_bbfs;

  CREATE TEMP TABLE IF NOT EXISTS _fix693_path (
    ord       int PRIMARY KEY,
    node_id   uuid,
    node_type text,
    via_type  text
  ) ON COMMIT DROP;
  TRUNCATE _fix693_path;

  INSERT INTO _fix693_bbfs (side, node_id, node_type, prev_id, via_type, depth)
  VALUES ('a', p_from_id, NULL, NULL, NULL, 0),
         ('b', p_to_id,   NULL, NULL, NULL, 0);

  WHILE v_depth_a + v_depth_b < v_hops LOOP
    -- Expand whichever live frontier is smaller (ties → 'a').
    v_side := CASE WHEN v_frontier_a <= v_frontier_b THEN 'a' ELSE 'b' END;

    IF v_side = 'a' THEN
      INSERT INTO _fix693_bbfs (side, node_id, node_type, prev_id, via_type, depth)
      SELECT DISTINCT ON (n.node_id) 'a', n.node_id, n.node_type, n.prev_id, n.via_type, v_depth_a + 1
      FROM (
        SELECT ec.to_id AS node_id, ec.to_type AS node_type,
               f.node_id AS prev_id, ec.connection_type AS via_type
        FROM _fix693_bbfs f
        JOIN public.entity_connections ec ON ec.from_id = f.node_id
        WHERE f.side = 'a' AND f.depth = v_depth_a
        UNION ALL
        SELECT ec.from_id, ec.from_type, f.node_id, ec.connection_type
        FROM _fix693_bbfs f
        JOIN public.entity_connections ec ON ec.to_id = f.node_id
        WHERE f.side = 'a' AND f.depth = v_depth_a
      ) n
      ON CONFLICT (side, node_id) DO NOTHING;
      GET DIAGNOSTICS v_new = ROW_COUNT;
      v_depth_a := v_depth_a + 1;
      v_frontier_a := v_new;
    ELSE
      INSERT INTO _fix693_bbfs (side, node_id, node_type, prev_id, via_type, depth)
      SELECT DISTINCT ON (n.node_id) 'b', n.node_id, n.node_type, n.prev_id, n.via_type, v_depth_b + 1
      FROM (
        SELECT ec.to_id AS node_id, ec.to_type AS node_type,
               f.node_id AS prev_id, ec.connection_type AS via_type
        FROM _fix693_bbfs f
        JOIN public.entity_connections ec ON ec.from_id = f.node_id
        WHERE f.side = 'b' AND f.depth = v_depth_b
        UNION ALL
        SELECT ec.from_id, ec.from_type, f.node_id, ec.connection_type
        FROM _fix693_bbfs f
        JOIN public.entity_connections ec ON ec.to_id = f.node_id
        WHERE f.side = 'b' AND f.depth = v_depth_b
      ) n
      ON CONFLICT (side, node_id) DO NOTHING;
      GET DIAGNOSTICS v_new = ROW_COUNT;
      v_depth_b := v_depth_b + 1;
      v_frontier_b := v_new;
    END IF;

    v_total := v_total + v_new;

    -- Meet: first node visited by both sides, minimal combined depth.
    SELECT a.node_id INTO v_meet
    FROM _fix693_bbfs a
    JOIN _fix693_bbfs b ON b.node_id = a.node_id AND b.side = 'b'
    WHERE a.side = 'a'
    ORDER BY a.depth + b.depth, a.node_id
    LIMIT 1;

    EXIT WHEN v_meet IS NOT NULL;
    EXIT WHEN v_new = 0;        -- expanded side exhausted → no path exists
    EXIT WHEN v_total >= v_cap; -- hub-blowup guard
  END LOOP;

  IF v_meet IS NULL THEN
    RETURN;
  END IF;

  -- Stitch: A-side walk meet → from (descending ord so `from` sorts first) …
  v_ord := 0;
  v_node := v_meet;
  WHILE v_node IS NOT NULL LOOP
    SELECT t.prev_id, t.via_type, t.node_type INTO v_prev, v_via, v_ntype
    FROM _fix693_bbfs t WHERE t.side = 'a' AND t.node_id = v_node;
    INSERT INTO _fix693_path (ord, node_id, node_type, via_type)
    VALUES (v_ord, v_node, v_ntype, v_via);
    v_ord := v_ord - 1;
    v_node := v_prev;
  END LOOP;

  -- … then B-side walk from the node after meet toward `to`. On side b, a
  -- node's via_type is the edge to its parent (closer to `to`), so walking
  -- from → to, row n_{i+1} carries via(n_i).
  SELECT t.prev_id, t.via_type INTO v_node, v_via
  FROM _fix693_bbfs t WHERE t.side = 'b' AND t.node_id = v_meet;
  v_ord := 1;
  WHILE v_node IS NOT NULL LOOP
    SELECT t.node_type, t.prev_id, t.via_type INTO v_ntype, v_prev, v_next_via
    FROM _fix693_bbfs t WHERE t.side = 'b' AND t.node_id = v_node;
    INSERT INTO _fix693_path (ord, node_id, node_type, via_type)
    VALUES (v_ord, v_node, v_ntype, v_via);
    v_via := v_next_via;
    v_node := v_prev;
    v_ord := v_ord + 1;
  END LOOP;

  RETURN QUERY
  SELECT
    (row_number() OVER (ORDER BY p.ord))::int - 1,
    p.node_id,
    p.node_type,
    COALESCE(o.full_name, fe.display_name, pr.title, gb.name, ag.name, p.node_id::text),
    p.via_type
  FROM _fix693_path p
  LEFT JOIN public.officials          o  ON o.id  = p.node_id
  LEFT JOIN public.financial_entities fe ON fe.id = p.node_id
  LEFT JOIN public.proposals          pr ON pr.id = p.node_id
  LEFT JOIN public.governing_bodies   gb ON gb.id = p.node_id
  LEFT JOIN public.agencies           ag ON ag.id = p.node_id
  ORDER BY p.ord;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_entity_path(uuid, uuid, int) TO anon, authenticated, service_role;
