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

/**
 * Shortest path between two entities.
 * Calls the PostgreSQL recursive CTE function.
 * This is the signature investigation feature of the connection graph.
 *
 * Returns an ordered array of connection records forming the path,
 * or an empty array if no path exists within maxHops.
 */
export async function getShortestPath(
  db: DB,
  fromType: EntityType,
  fromId: string,
  toType: EntityType,
  toId: string,
  maxHops = 6
): Promise<Row[]> {
  // Implemented as a PostgreSQL recursive CTE function (Phase 2+).
  // Stub returns empty array until the function is deployed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc("find_shortest_path", {
    p_from_type: fromType,
    p_from_id: fromId,
    p_to_type: toType,
    p_to_id: toId,
    p_max_hops: maxHops,
  });
  if (error) {
    // Function not yet deployed — return empty path
    if (error.code === "PGRST202") return [];
    throw error;
  }
  return data ?? [];
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
