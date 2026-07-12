import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type ConnectionType = Database["public"]["Tables"]["entity_connections"]["Row"]["connection_type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["entity_connections"]["Row"];

type EntityType = "official" | "governing_body" | "proposal" | "agency" | "organization";

/** All connections originating from an entity. */
export async function getConnectionsFrom(
  db: DB,
  fromType: EntityType,
  fromId: string,
  connectionType?: ConnectionType
): Promise<Row[]> {
  let query = db
    .from("entity_connections")
    .select("*")
    .eq("from_type", fromType)
    .eq("from_id", fromId)
    .order("strength", { ascending: false });

  if (connectionType) {
    query = query.eq("connection_type", connectionType);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** All connections pointing to an entity. */
export async function getConnectionsTo(
  db: DB,
  toType: EntityType,
  toId: string,
  connectionType?: ConnectionType
): Promise<Row[]> {
  let query = db
    .from("entity_connections")
    .select("*")
    .eq("to_type", toType)
    .eq("to_id", toId)
    .order("strength", { ascending: false });

  if (connectionType) {
    query = query.eq("connection_type", connectionType);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** All connections for an entity (both directions combined). */
export async function getAllConnectionsForEntity(
  db: DB,
  entityType: EntityType,
  entityId: string
): Promise<{ outgoing: Row[]; incoming: Row[] }> {
  const [outgoing, incoming] = await Promise.all([
    getConnectionsFrom(db, entityType, entityId),
    getConnectionsTo(db, entityType, entityId),
  ]);
  return { outgoing, incoming };
}

/** One row per node along a path, ordered start → end (FIX-693). */
export interface EntityPathSegment {
  hop: number;
  entity_id: string;
  entity_type: string | null;
  entity_label: string | null;
  /** Type of the edge that led INTO this node — null on the first row. */
  connection_type: string | null;
}

/**
 * Shortest path between two entities via the find_entity_path RPC (FIX-693):
 * bidirectional-edge BFS over entity_connections with a 50k visited-node cap,
 * max 6 hops. The former find_shortest_path RPC was never installed; this is
 * the single pathfinding implementation, shared with /api/graph/pathfinder
 * and the snapshot route. From/to types are no longer needed — the BFS keys
 * on ids alone.
 *
 * Returns an ordered node list, or [] when no path exists within maxHops
 * (or the RPC is not yet deployed).
 */
export async function getShortestPath(
  db: DB,
  fromId: string,
  toId: string,
  maxHops = 3
): Promise<EntityPathSegment[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc("find_entity_path", {
    p_from_id: fromId,
    p_to_id: toId,
    p_max_hops: maxHops,
  });
  if (error) {
    // Function not yet deployed — return empty path
    if (error.code === "PGRST202") return [];
    throw error;
  }
  return (data ?? []) as EntityPathSegment[];
}

/** Connections filtered by type (e.g. all donations). */
export async function listConnectionsByType(
  db: DB,
  connectionType: ConnectionType,
  limit = 100
): Promise<Row[]> {
  const { data, error } = await db
    .from("entity_connections")
    .select("*")
    .eq("connection_type", connectionType)
    .order("strength", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
