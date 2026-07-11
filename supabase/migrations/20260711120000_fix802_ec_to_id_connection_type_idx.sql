-- FIX-802 — to-side mirror of entity_connections_from_id_connection_type.
--
-- Every entity-focused /api/graph/connections bucket filters
-- or(from_id.eq.X, to_id.eq.X) [+ connection_type IN (...)]. The from side
-- rides (from_id, connection_type), but the only general to-side index led
-- with to_type (entity_connections_to), which PostgREST's or() can't supply —
-- the planner's BitmapOr fell back to a FULL scan of the ~5.7M-entry index on
-- every request (measured 66s cold / 161ms warm on the prod clone for Allred's
-- vote bucket, which matches zero rows). On cache-starved prod Small that scan
-- is the IOWait 500 class the graph routes hit.
--
-- With this index the to side becomes the same few-probe range scan as the
-- from side, for every bucket (votes, oversight, investigation, raw
-- donation/opposition fallback) and every focus entity type.
CREATE INDEX IF NOT EXISTS entity_connections_to_id_connection_type
  ON public.entity_connections (to_id, connection_type);
