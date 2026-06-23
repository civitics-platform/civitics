/**
 * FIX-444 — Direct-pg invocation for heavy tagger rebuilds.
 *
 * `rebuild_financial_entity_size_tags()` and `rebuild_pre_vote_timing_tags()`
 * run multi-minute on prod (the size rebuild inserts the full donor set, >2 min;
 * pre_vote ~80s). Called via PostgREST `db.rpc(...)` they die at the
 * Cloudflare/PostgREST gateway (~100s cap) while the function keeps running
 * server-side — and `callWithRetry` then fires retries while the original is
 * still executing, piling up concurrent multi-minute functions that lock-contend
 * on `entity_tags`.
 *
 * The function-level `ALTER FUNCTION ... SET statement_timeout='300s'` on these
 * RPCs does NOT extend the outer `SELECT rebuild_*()` call: Postgres arms
 * `statement_timeout` on the top-level statement using the SESSION value at
 * statement start, so the prod session default (~120s) wins. The fix is to open
 * a direct `pg.Client` over the session pooler and raise the timeout at the
 * SESSION level before the call — mirroring
 * scripts/rebuild-entity-connections.ts.
 *
 * No retry: the retry pile-up is the bug. A single attempt over the direct
 * connection; the connection always closes in `finally` before this returns.
 */

/**
 * Compose a session-pooler (or local Docker) Postgres DSN from env.
 *
 * Mirrors buildDbUrl() in scripts/rebuild-entity-connections.ts but always
 * returns a usable string (the tagger runs locally too, so the no-password local
 * case must resolve to the Docker DSN rather than null). Resolution order:
 *   1. SUPABASE_DB_URL if explicitly set (CI / readonly DSN override).
 *   2. Local Docker DSN when NEXT_PUBLIC_SUPABASE_URL points at 127.0.0.1/localhost.
 *   3. Composed session-pooler URL from SUPABASE_DB_PASSWORD + project ref.
 * Throws if none resolve — a heavy rebuild must never silently no-op.
 */
export function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (supabaseUrl.includes("127.0.0.1") || supabaseUrl.includes("localhost")) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }

  const password = process.env["SUPABASE_DB_PASSWORD"];
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!password || !m) {
    throw new Error(
      "buildDbUrl: need SUPABASE_DB_URL, a local NEXT_PUBLIC_SUPABASE_URL, or " +
        "(NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD) to compose a DSN",
    );
  }
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

// Whitelist — these are the only functions routed through the direct-pg path.
// Interpolating an arbitrary string into the SELECT would be an injection
// surface; the literal allow-list closes it while keeping the call shape simple.
const ALLOWED_REBUILDS = new Set([
  "rebuild_financial_entity_size_tags",
  "rebuild_pre_vote_timing_tags",
  // C1 Wave B (FIX-527): nightly comment bridge scorer. A 0-arg call here
  // (default args NULL/NULL) runs the full sweep and returns #comments scored.
  "recompute_comment_bridge_scores",
  // FIX-586: FEC post-cycle donor-total recompute (returns void → count 0).
  // The full-table UPDATE over financial_relationships ran >100s on prod and
  // died at the PostgREST gateway cap (`upstream request timeout`, 2026-06-14)
  // when called via admin.rpc(); the direct-pg path sidesteps both caps.
  "rebuild_financial_entity_donation_totals",
  // FIX-651: nightly spending-totals refresh (step 3b-ii, returns void → count
  // 0). The set-based UPDATE over financial_relationships (contract+grant) timed
  // out on prod 2026-06-22 ("canceling statement due to statement timeout") on
  // the capped admin.rpc() path, triggering the enrichment-phase cascade. Same
  // direct-pg lift as the donation-total recompute above.
  "refresh_spending_totals",
]);

/**
 * Run a single heavy rebuild function over a direct session-pooler connection
 * with a SESSION-level statement_timeout raised past the gateway cap. Returns
 * the bigint row count the function emits. Connection is always closed.
 *
 * @param fn  bare function name in the `public` schema (must be allow-listed)
 */
export async function runHeavyRebuild(fn: string): Promise<number> {
  if (!ALLOWED_REBUILDS.has(fn)) {
    throw new Error(`runHeavyRebuild: '${fn}' is not an allow-listed heavy rebuild`);
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    // Session-level timeout — the function-level ALTER FUNCTION GUC does not
    // re-arm the already-running top-level timer. '90min' matches the
    // rebuild-entity-connections precedent (generous, not unbounded).
    await client.query("SET statement_timeout = '90min'");
    const res = await client.query<{ count: string | number }>(
      `SELECT public.${fn}() AS count`,
    );
    return Number(res.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

// FIX-651 — jsonb-array rollup RPCs lifted off the capped PostgREST path. Each
// returns its whole result set as ONE jsonb row (see
// 20260529130000_official_tag_rollups_426_427.sql), so the direct-pg call is
// `SELECT fn() AS result` and node-postgres hands back the parsed array. The
// admin.rpc() path runs these under the 8s service_role / 100s gateway caps; the
// nightly rule tagger + enrichment aggregator retried them 5× into the
// 2026-06-22 statement_timeout cascade. The per-function ALTER FUNCTION
// statement_timeout=300s does NOT re-arm the outer statement's timer (same
// reason runHeavyRebuild exists), so the durable fix is a session-level raise
// over a direct connection.
const ALLOWED_JSONB_ROLLUPS = new Set([
  "get_official_donor_rollup",
  "get_official_bipartisan_stats",
]);

/**
 * Run an allow-listed jsonb-array rollup function over a direct session-pooler
 * connection with a raised SESSION statement_timeout, returning the parsed
 * array. THROWS on any connection/query error (pg rejects) — a partial or empty
 * rollup must never be silently consumed as "this official has no
 * votes/donations" (the FIX-426/427 contract the callers' callWithRetry/
 * rpcWithRetry used to enforce). Single attempt: the retry pile-up against a
 * still-running server-side function is the failure mode being removed, not a
 * resilience feature. Connection always closed.
 */
export async function rollupJsonbDirect<T>(fn: string): Promise<T[]> {
  if (!ALLOWED_JSONB_ROLLUPS.has(fn)) {
    throw new Error(`rollupJsonbDirect: '${fn}' is not an allow-listed jsonb rollup`);
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '90min'");
    const res = await client.query<{ result: T[] | null }>(
      `SELECT public.${fn}() AS result`,
    );
    // Both functions COALESCE to '[]'::jsonb, so result is never null; the ??
    // is belt-and-braces against a future signature change.
    return (res.rows[0]?.result ?? []) as T[];
  } finally {
    await client.end();
  }
}

/**
 * Run a single read-only SELECT over a direct session-pooler connection with a
 * raised statement_timeout, returning all rows. For reads that exceed the 8s
 * PostgREST role timeout pinned on prod — e.g. the rule tagger's non-individual
 * `financial_entities` scan, which OFFSET-paginates a filtered index scan over
 * ~1M rows and measured ~18s on prod (FIX-444). A single direct query has no 8s
 * role cap and no 1,000-row PostgREST max_rows cap, so the whole set comes back
 * in one pass with no OFFSET re-scan pathology. Connection always closed.
 *
 * SELECT-only by construction — callers pass fixed query text, not user input.
 */
export async function selectDirect<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '90min'");
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * FIX-463 — direct-pg batch invocation for promote_candidate_to_elected().
 *
 * The candidate→elected promotion RPC does ~20 transactional FK rewrites across
 * votes / financial_relationships / entity_connections / entity_tags / … and a
 * single call measured ~17s on prod — well past the PostgREST role's ~8s
 * statement_timeout, so via `db.rpc(...)` every call dies as a timeout and the
 * pair never promotes (re-detected next nightly → permanent ~22-min sink). This
 * opens ONE direct session-pooler connection, raises the SESSION
 * statement_timeout past the cap, and runs each pair's RPC in autocommit so a
 * data error on one pair doesn't poison the rest. Fixed query text + bound
 * params — no identifier interpolation. Connection always closed.
 */
export interface PromoteCandidateOutcome {
  electedId:   string;
  candidateId: string;
  result?:     { votes_moved?: number; total_fks_moved?: number };
  error?:      string;
}

export async function promoteCandidatesDirect(
  pairs: Array<{ electedId: string; candidateId: string }>,
): Promise<PromoteCandidateOutcome[]> {
  if (pairs.length === 0) return [];

  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  const outcomes: PromoteCandidateOutcome[] = [];
  try {
    await client.query("SET statement_timeout = '90min'");
    for (const p of pairs) {
      try {
        const res = await client.query<{ result: PromoteCandidateOutcome["result"] }>(
          "SELECT public.promote_candidate_to_elected($1, $2) AS result",
          [p.electedId, p.candidateId],
        );
        outcomes.push({ electedId: p.electedId, candidateId: p.candidateId, result: res.rows[0]?.result });
      } catch (err) {
        // Autocommit: a failed call aborts only its own statement; the next
        // pair proceeds on the same connection.
        outcomes.push({
          electedId:   p.electedId,
          candidateId: p.candidateId,
          error:       err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await client.end();
  }
  return outcomes;
}
