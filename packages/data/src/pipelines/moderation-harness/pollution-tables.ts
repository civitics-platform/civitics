/**
 * The moderation harness's zero-pollution watch: every table a fixture could
 * mutate. The rollback should leave every count unchanged.
 *
 * Schema-qualified since FIX-825. The fixtures mint ephemeral `auth.users` +
 * `public.users` rows inside the rolled-back transaction (createUser /
 * createAgedUser / createSyntheticUser), and a rollback that failed to take
 * would leak them while the run still reported zero pollution — the way ~30
 * bare-id `auth.users` rows leaked and poisoned admin.listUsers (FIX-660).
 * Kept out of index.ts so it can be tested without running the harness.
 */

export interface PollutionTable {
  schema: "public" | "auth";
  table: string;
}

export const POLLUTION_TABLES: readonly PollutionTable[] = [
  { schema: "public", table: "entity_comments" },
  { schema: "public", table: "content_flags" },
  { schema: "public", table: "comment_ratings" },
  { schema: "public", table: "entity_positions" },
  { schema: "public", table: "position_events" },
  { schema: "public", table: "evidence_cards" },
  { schema: "public", table: "citations" },
  { schema: "public", table: "investigations" },
  { schema: "auth", table: "users" },
  { schema: "public", table: "users" },
];

/** `schema.table` — the report's label for a watched table. */
export function pollutionLabel(t: PollutionTable): string {
  return `${t.schema}.${t.table}`;
}

/** The count statement for one watched table, identifiers quoted. */
export function pollutionCountSql(t: PollutionTable): string {
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
  return `SELECT count(*)::bigint AS n FROM ${q(t.schema)}.${q(t.table)}`;
}
