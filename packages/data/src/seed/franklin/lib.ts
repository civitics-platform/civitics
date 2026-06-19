/**
 * Shared plumbing for the State of Franklin S1 seed (FIX-607).
 *
 * Everything runs over a single direct `pg.Client`:
 *   - Plain table writes run as the `postgres` role (RLS bypassed).
 *   - The investigation / evidence-card path runs the live RPCs
 *     (add_evidence_card, add_citation, promote_evidence_edge) which read
 *     auth.uid(); we impersonate a synthetic author by setting
 *     `request.jwt.claims` for the duration of those calls (see withAuthor()).
 *
 * Idempotency is keyed on the authored logical `seed_key`, persisted in
 * public.franklin_seed_map (seed_key -> table_name, row_id). Re-running resolves
 * the existing row and UPDATEs its mutable columns instead of inserting.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

export const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Backdate synthetic accounts so the live creation caps / new-account throttles
// never treat the seeded investigator as a brand-new account.
export const SEED_EPOCH = "2026-05-01T12:00:00Z";
// Deterministic "occurred" dates for the synthetic money + votes.
export const MONEY_DATE = "2026-03-01";
export const VOTE_DATE = "2026-04-15T15:00:00Z";

export function dataDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "data");
}

export function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(dataDir(), name), "utf8")) as T;
}

/** Serialize a value destined for a jsonb column. */
export function jb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export class SeedCtx {
  readonly client: Client;
  private readonly map = new Map<string, { table: string; id: string }>();

  constructor(client: Client) {
    this.client = client;
  }

  async loadMap(): Promise<void> {
    const r = await this.client.query<{ seed_key: string; table_name: string; row_id: string }>(
      `SELECT seed_key, table_name, row_id FROM public.franklin_seed_map`,
    );
    for (const row of r.rows) this.map.set(row.seed_key, { table: row.table_name, id: row.row_id });
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  maybeId(key: string): string | null {
    return this.map.get(key)?.id ?? null;
  }

  id(key: string): string {
    const e = this.map.get(key);
    if (!e) throw new Error(`franklin seed: seed_key not resolved: "${key}"`);
    return e.id;
  }

  async record(key: string, table: string, id: string): Promise<void> {
    await this.client.query(
      `INSERT INTO public.franklin_seed_map (seed_key, table_name, row_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (seed_key) DO UPDATE SET table_name = EXCLUDED.table_name, row_id = EXCLUDED.row_id`,
      [key, table, id],
    );
    this.map.set(key, { table, id });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params);
    return res.rows as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (rows.length === 0) throw new Error(`franklin seed: expected a row, got none for: ${sql}`);
    return rows[0];
  }

  /**
   * Run `fn` with auth.uid() resolving to the given synthetic user, so the
   * SECURITY DEFINER investigation RPCs attribute writes to that author.
   * Scoped to a transaction (is_local = true) so it never leaks.
   */
  async withAuthor<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      const out = await fn();
      await this.client.query("COMMIT");
      return out;
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }
}

/** Upsert a synthetic user (auth.users + public.users), keyed on seed_key. */
export async function upsertUser(
  ctx: SeedCtx,
  key: string,
  displayName: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const existing = ctx.maybeId(key);
  const meta = { ...metadata, seed_key: key };
  if (existing) {
    await ctx.query(
      `UPDATE public.users SET display_name = $1, metadata = $2::jsonb, is_synthetic = true WHERE id = $3`,
      [displayName, jb(meta), existing],
    );
    return existing;
  }
  const row = await ctx.one<{ id: string }>(
    `WITH a AS (
       INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id
     )
     INSERT INTO public.users (id, display_name, metadata, is_synthetic, created_at, last_seen)
     SELECT id, $1, $2::jsonb, true, $3, $3 FROM a
     RETURNING id`,
    [displayName, jb(meta), SEED_EPOCH],
  );
  await ctx.record(key, "users", row.id);
  return row.id;
}

/** Grant a synthetic user an active `staff` role so creation caps don't bite. */
export async function grantStaff(ctx: SeedCtx, userId: string): Promise<void> {
  await ctx.query(
    `INSERT INTO public.entity_grants (user_id, target_type, target_id, role, status, granted_at)
     VALUES ($1, 'global', NULL, 'staff', 'active', $2)
     ON CONFLICT (user_id, role, target_type, target_id) WHERE status = 'active' DO NOTHING`,
    [userId, SEED_EPOCH],
  );
}

/**
 * Generic upsert for a table with a uuid `id` PK, keyed on seed_key.
 * `cols` is the full column set for both INSERT and UPDATE. jsonb columns must
 * already be stringified and their key suffixed with `::jsonb` is handled by the
 * caller via the `jsonbCols` set.
 */
export async function upsertById(
  ctx: SeedCtx,
  key: string,
  table: string,
  cols: Record<string, unknown>,
  jsonbCols: Set<string> = new Set(),
): Promise<string> {
  const entries = Object.entries(cols);
  const cast = (name: string, ph: string) => (jsonbCols.has(name) ? `${ph}::jsonb` : ph);
  const existing = ctx.maybeId(key);
  if (existing) {
    const sets = entries.map(([c], i) => `${c} = ${cast(c, `$${i + 1}`)}`).join(", ");
    await ctx.query(`UPDATE public.${table} SET ${sets} WHERE id = $${entries.length + 1}`, [
      ...entries.map((e) => e[1]),
      existing,
    ]);
    return existing;
  }
  const names = entries.map((e) => e[0]).join(", ");
  const placeholders = entries.map(([c], i) => cast(c, `$${i + 1}`)).join(", ");
  const row = await ctx.one<{ id: string }>(
    `INSERT INTO public.${table} (${names}) VALUES (${placeholders}) RETURNING id`,
    entries.map((e) => e[1]),
  );
  await ctx.record(key, table, row.id);
  return row.id;
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? full, last: parts.slice(1).join(" ") || parts[0] || full };
}
