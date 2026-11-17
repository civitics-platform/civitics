/**
 * FIX-1181 (cc-291 D6) — `link_officials_to_districts()` off PostgREST.
 *
 * Three pipelines call the linker after they write officials: the daily
 * OpenStates bulk people run, the weekly OpenStates API run and the TIGER
 * districts run. Through `db.rpc()` it ran under authenticator's 8 s bound
 * (FIX-1128's measurement), and it was cancelled there three times in four
 * nights: 2026-11-13 21:09:06Z, 11-14 22:37:44Z and 11-16 00:42:12Z (cc-287
 * read 7). pg_stat_statements records only completions: 11 calls since 10-25,
 * mean 7,357.6 ms. Each caller `console.warn`ed and carried on, so no run
 * record said the link had not happened.
 *
 * Now each caller opens a direct connection through `buildDbUrl()` (the
 * pipelines' direct-pg path; the nightly jobs carry SUPABASE_DB_PASSWORD) and
 * bounds ITS OWN statement at 60 s. The function body RESETs its statement
 * timeout (FIX-1128), so only the caller's bound applies (root CLAUDE.md
 * §Database). The outcome is returned as `district_link: {ok, ms, linked,
 * error}` for the caller's `data_sync_log` metadata.
 *
 * NEVER THROWS. A linker failure must not fail a pipeline that already landed
 * its rows (FIX-915's warn-and-continue). It is now recorded, not only logged.
 *
 * No skip. D6 allowed one only if a caller's counters could tell "no officials
 * row changed" from "changed". They cannot: `upsertLegislatorsBatch` counts
 * every upserted existing row as `updated`, and the TIGER writer counts every
 * district upsert as `inserted`, changed or not.
 *
 * The function's SQL is not edited here (precomputed keys are a later design).
 */

import type { Client } from "pg";
import { buildDbUrl } from "./heavy-rebuild";

/** The caller's statement bound for one linker call. */
export const DISTRICT_LINK_STATEMENT_TIMEOUT = "60s";

/** What a caller records under `metadata.district_link`. */
export interface DistrictLinkOutcome {
  ok: boolean;
  /** Wall time of the whole step: connect, bound, call. */
  ms: number;
  /** The function's return (officials whose link changed); 0 on failure. */
  linked: number;
  error: string | null;
}

/** The one query the step runs, on a client it does not own. */
export async function linkOfficialsOnClient(client: Pick<Client, "query">): Promise<number> {
  await client.query(`SET statement_timeout = '${DISTRICT_LINK_STATEMENT_TIMEOUT}'`);
  const res = await client.query<{ linked: number | string | null }>(
    "SELECT public.link_officials_to_districts() AS linked",
  );
  return Number(res.rows[0]?.linked ?? 0);
}

/**
 * Run the linker over a direct connection with a 60 s statement bound and
 * return its outcome. `connect` is for tests; by default it opens a `pg.Client`
 * on `buildDbUrl()`, which throws (and is recorded) when no DSN resolves.
 */
export async function linkOfficialsToDistricts(
  deps: {
    connect?: () => Promise<Pick<Client, "query" | "end">>;
    now?: () => number;
  } = {},
): Promise<DistrictLinkOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let client: Pick<Client, "query" | "end"> | null = null;
  try {
    client = await (deps.connect ?? connectDirect)();
    const linked = await linkOfficialsOnClient(client);
    return { ok: true, ms: now() - t0, linked, error: null };
  } catch (err) {
    return { ok: false, ms: now() - t0, linked: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.end().catch(() => { /* best effort */ });
  }
}

async function connectDirect(): Promise<Client> {
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: buildDbUrl(), connectionTimeoutMillis: 15_000 });
  // A backend cancelled under this client rejects the query in flight, and pg
  // then emits `error` when the socket closes. Unheard, that ends the process.
  client.on("error", () => { /* the query's rejection is the report */ });
  await client.connect();
  return client;
}
