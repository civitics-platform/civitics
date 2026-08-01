/**
 * FIX-462 — direct-pg bulk upsert for the FEC indiv stage.
 *
 * The FEC individual-contributions stage upserts ~768k donor entities and
 * ~1.1M donation relationships per Sunday. Pre-FIX-462 those went through
 * PostgREST `.upsert()` in 500-row chunks (writer.ts) — ~1,500 round-trips per
 * phase against million-row tables, every chunk subject to the prod ~8s role /
 * statement_timeout. Slow chunks were SILENTLY DROPPED (`failed += chunk`,
 * 2,500 + 1,500 rows lost on the 2026-05-31 run alone) and the cumulative
 * wall-clock (24 + 36 + 21 min observed) pushed fec-phase past its 120-min
 * budget, SIGTERM mid-stream every Sunday.
 *
 * This routes those upserts through a single persistent `pg.Client` over the
 * session pooler with the SESSION-level statement_timeout raised past the
 * gateway cap — the same pattern as lib/heavy-rebuild.ts and
 * scripts/rebuild-entity-connections.ts:
 *   - no 8s cap  → no dropped chunks → no weekly data loss
 *   - one connection + larger chunks → far fewer round-trips
 *
 * The conflict arbiters are the FULL (non-partial) unique indexes
 *   financial_entities_donor_fingerprint_unique     (donor_fingerprint)
 *   financial_relationships_relcycle_unique          (relationship_type, from_id, to_id, cycle_year)
 * so a bare `ON CONFLICT (cols) DO UPDATE SET <rest> = EXCLUDED.<rest>` matches
 * PostgREST's default merge-duplicates resolution byte-for-byte.
 */

import type { Client } from "pg";
import { buildDbUrl } from "./heavy-rebuild";

// Postgres caps bind parameters at 65535 per statement. The widest indiv table
// is financial_relationships (12 columns); 4000 rows × 12 = 48000 params keeps
// comfortable margin while collapsing ~1,500 PostgREST calls to a few hundred.
const DEFAULT_CHUNK = 4000;

/**
 * Open a direct session-pooler (or local Docker) connection, raise the SESSION
 * statement_timeout past the gateway cap, run `fn`, and always close the
 * connection. Mirrors runHeavyRebuild()'s connection lifecycle.
 */
export async function withDirectClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    // '90min' matches the rebuild-entity-connections / heavy-rebuild precedent
    // (generous, not unbounded). The indiv upserts finish in minutes once the
    // 8s role cap is gone; this ceiling only guards against a pathological run.
    await client.query("SET statement_timeout = '90min'");
    return await fn(client);
  } finally {
    await client.end();
  }
}

// 90 minutes in ms — the session statement_timeout applied to every pooled
// connection (node-postgres runs `SET statement_timeout` on connect from this
// config value). Matches the withDirectClient ceiling above.
const DIRECT_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * FIX-586 — like withDirectClient but a small connection Pool, for callers that
 * fan a bounded number of concurrent per-row queries (e.g. the LittleSis
 * resolve-or-insert loop, RESOLVE_BATCH=50). A single Client serialises queued
 * queries, collapsing that concurrency; a Pool keeps `max` in flight. Each
 * connection gets the raised statement_timeout via pg's `statement_timeout`
 * config option. The pool is always drained in `finally`.
 */
export async function withDirectPool<T>(
  fn: (pool: import("pg").Pool) => Promise<T>,
  max = 8,
): Promise<T> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: buildDbUrl(),
    statement_timeout: DIRECT_TIMEOUT_MS,
    max,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * FIX-586 — refresh primary_source for a batch of entities over a direct
 * connection (raised timeout), instead of the admin PostgREST path whose 8s
 * role cap timed out the financial_entity refresh (n=90484) on prod
 * 2026-06-14. Advisory: callers swallow failures (the nightly
 * rebuild_all_primary_sources() safety net covers drift), so this only logs.
 */
export async function refreshPrimarySourceDirect(
  entityType: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  try {
    await withDirectClient((client) =>
      client.query(`SELECT public.refresh_primary_source_for_entities($1, $2::uuid[])`, [
        entityType,
        entityIds,
      ]),
    );
  } catch (err) {
    console.warn(
      `  [primary-source] refresh failed (${entityType}, n=${entityIds.length}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface BulkUpsertSpec {
  /** Bare table name in the `public` schema. */
  table: string;
  /** Ordered column names; each row in `rows` must align to this order. */
  columns: string[];
  /** Conflict-arbiter columns (must back a full unique index). */
  conflictColumns: string[];
  /**
   * Columns to `DO UPDATE SET col = EXCLUDED.col` on conflict. Defaults to all
   * non-conflict columns (matches PostgREST merge-duplicates). An empty array
   * forces `DO NOTHING`.
   */
  updateColumns?: string[];
  /** Columns whose value is JSON-serialized and cast `::jsonb`. */
  jsonbColumns?: string[];
  /** Columns to RETURNING (rows come back in `BulkUpsertResult.returned`). */
  returningColumns?: string[];
  /** Greppable label for per-chunk failure logs (defaults to `table`). */
  label?: string;
  /** Rows aligned to `columns`. */
  rows: unknown[][];
  /** Override the default chunk size. */
  chunkSize?: number;
  /** FIX-754: absolute row offset to start from — rows before it were already
   *  committed by a prior (killed) run. Clamped to [0, rows.length]. */
  startRowOffset?: number;
  /** FIX-754: awaited after every chunk attempt with the absolute row offset
   *  now processed (success and failure alike — a failed chunk is counted and
   *  not retried on resume, matching the live-run accounting). The hook must
   *  swallow its own errors; a cursor-persistence hiccup must not fail the
   *  upsert. */
  onChunkProcessed?: (processedRows: number) => Promise<void> | void;
}

export interface BulkUpsertResult {
  upserted: number;
  failed: number;
  returned: Record<string, unknown>[];
}

function quoteIdent(id: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(id)) {
    throw new Error(`direct-pg-upsert: unsafe identifier ${JSON.stringify(id)}`);
  }
  return `"${id}"`;
}

/**
 * Build a parameterized multi-row `INSERT ... ON CONFLICT` statement for
 * `rowCount` rows. Pure (no I/O) so it can be unit-tested. Placeholders run
 * $1..$(rowCount*columns.length) in row-major order; jsonb columns get a
 * `::jsonb` cast on their placeholder.
 */
export function buildUpsertStatement(spec: {
  table: string;
  columns: string[];
  conflictColumns: string[];
  updateColumns?: string[];
  jsonbColumns?: string[];
  returningColumns?: string[];
  rowCount: number;
}): string {
  const { table, columns, conflictColumns, rowCount } = spec;
  if (columns.length === 0) throw new Error("direct-pg-upsert: columns is empty");
  if (rowCount <= 0) throw new Error("direct-pg-upsert: rowCount must be > 0");

  const jsonb = new Set(spec.jsonbColumns ?? []);
  const colList = columns.map(quoteIdent).join(", ");

  const tuples: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = columns.map((c) => (jsonb.has(c) ? `$${p++}::jsonb` : `$${p++}`));
    tuples.push(`(${placeholders.join(", ")})`);
  }

  const conflict = conflictColumns.map(quoteIdent).join(", ");
  const updateCols = spec.updateColumns ?? columns.filter((c) => !conflictColumns.includes(c));
  const onConflict =
    updateCols.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updateCols
          .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
          .join(", ")}`;

  const returning = spec.returningColumns?.length
    ? ` RETURNING ${spec.returningColumns.map(quoteIdent).join(", ")}`
    : "";

  return (
    `INSERT INTO public.${quoteIdent(table)} (${colList}) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT (${conflict}) ${onConflict}${returning}`
  );
}

/**
 * Chunked bulk upsert over an already-connected direct-pg client. A chunk that
 * throws is logged and counted as `failed` (matching the pre-FIX-462 PostgREST
 * accounting); every query is its own implicit transaction (autocommit), so one
 * failed chunk does not poison the rest. With the 90min session timeout these
 * failures should not occur — `failed > 0` now signals a real data/constraint
 * problem rather than the old timeout drops.
 *
 * DO NOT wrap this function in a transaction (FIX-949). The autocommit-per-chunk
 * behaviour is load-bearing, not an oversight:
 *   - FIX-754's `startRowOffset` resume exists ONLY because chunks commit
 *     independently — "rows before the offset already landed in a prior run" is
 *     false the moment the whole loop shares one transaction, and the FEC-indiv
 *     and LittleSis resume paths would silently start re-doing committed work
 *     (or, worse, believe they had).
 *   - The `failed += chunk` accounting likewise assumes a poisoned chunk does not
 *     abort its siblings; inside a transaction the first failure aborts the txn
 *     and every subsequent chunk errors with "current transaction is aborted".
 *
 * Atomicity is the CALLER's job. A caller that needs clear-then-upsert to be
 * all-or-nothing opens its own `BEGIN`/`COMMIT` on the client it passes in —
 * see the three rule taggers in pipelines/tags/rules.ts, where a nightly killed
 * mid-upsert with the DELETEs already committed truncated prod's industry tags
 * (FIX-945). Those callers do not use `startRowOffset`, so the two mechanisms
 * never have to coexist on one call.
 */
export async function bulkUpsert(client: Client, spec: BulkUpsertSpec): Promise<BulkUpsertResult> {
  const chunkSize = spec.chunkSize ?? DEFAULT_CHUNK;
  const jsonb = new Set(spec.jsonbColumns ?? []);
  const label = spec.label ?? spec.table;
  let upserted = 0;
  let failed = 0;
  const returned: Record<string, unknown>[] = [];

  // FIX-754: resume support. `upserted`/`failed`/`returned` cover only the rows
  // processed THIS run — rows before the offset already landed in a prior run.
  const startRowOffset = Math.min(Math.max(0, spec.startRowOffset ?? 0), spec.rows.length);
  if (startRowOffset > 0) {
    console.log(
      `    ${label} resuming at row ${startRowOffset.toLocaleString()}/${spec.rows.length.toLocaleString()} (FIX-754)`,
    );
  }

  for (let i = startRowOffset; i < spec.rows.length; i += chunkSize) {
    const chunk = spec.rows.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;

    const sql = buildUpsertStatement({
      table: spec.table,
      columns: spec.columns,
      conflictColumns: spec.conflictColumns,
      updateColumns: spec.updateColumns,
      jsonbColumns: spec.jsonbColumns,
      returningColumns: spec.returningColumns,
      rowCount: chunk.length,
    });

    const params: unknown[] = [];
    for (const row of chunk) {
      for (let c = 0; c < spec.columns.length; c++) {
        const col = spec.columns[c]!;
        const val = row[c];
        params.push(jsonb.has(col) ? JSON.stringify(val ?? {}) : val);
      }
    }

    try {
      const res = await client.query(sql, params);
      if (spec.returningColumns?.length) returned.push(...(res.rows as Record<string, unknown>[]));
      upserted += chunk.length;
    } catch (err) {
      console.error(
        `    ${label} chunk ${i}-${i + chunk.length} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failed += chunk.length;
    }

    if (spec.onChunkProcessed) await spec.onChunkProcessed(i + chunk.length);
  }

  return { upserted, failed, returned };
}
