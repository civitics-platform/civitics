/**
 * FIX-399 — diagnostic: per-table attribution binding rate.
 *
 * Originally a one-shot smoke for FIX-403/408 (`scripts/fix403-408-smoke.ts`)
 * — generalized at FIX-399 to drive the "measure don't assert" verification
 * step: reports per-table binding rates (rows with primary_source IS NOT NULL
 * vs. total) plus per-category coverage (federal/state/local/community/other).
 *
 * Reads env via `--env-file=…` (caller picks local vs prod). Uses the secret
 * key so the count subqueries don't hit RLS (xsr is public-read post-FIX-408
 * but the entity tables historically gated to authenticated users in some
 * surfaces — sticking with admin keeps the script consistent across envs).
 *
 * Usage:
 *   pnpm --filter @civitics/data diag:attribution-coverage
 *   ( source .env.local.prod && pnpm --filter @civitics/data diag:attribution-coverage )
 */

import { createAdminClientWith, createPublicClient, resolveSource } from "@civitics/db";

// `huge` marks tables where an exact unfiltered COUNT(*) is at risk of the
// ~8s prod role-read / PostgREST gateway cap (FIX-450). financial_entities is
// ~2.4M rows on prod; the COUNT intermittently exceeds the cap and resolves to
// count:null → 0, printing the impossible "bound > total". For these tables the
// total uses a planner-estimate count instead (see the loop below).
// `as const` is load-bearing: supabase-js infers the typed table (and thus
// resolves the .select/.range overloads) from the literal table name. Widening
// `table` to `string` breaks that inference, so `huge` is carried on every entry
// rather than via an optional field on a widened type.
const TABLES = [
  { table: "officials",          entityType: "official",          huge: false },
  { table: "proposals",          entityType: "proposal",          huge: false },
  { table: "agencies",           entityType: "agency",            huge: false },
  { table: "governing_bodies",   entityType: "governing_body",    huge: false },
  { table: "financial_entities", entityType: "financial_entity",  huge: true  },
] as const;

type Row = { primary_source: string | null };

// ── Transient-network resilience (FIX-414) ──────────────────────────────
//
// Against the local Docker stack (Kong/PostgREST on Windows) and, less often,
// prod, a single `{ count: "exact", head: true }` or `.range()` call can fail
// with an undici `TypeError: fetch failed` (ECONNRESET / ETIMEDOUT under the
// hood). There is no try/catch around any remote call, so one transient blip
// poisons the whole multi-table diagnostic with zeros/nulls.
//
// Wrinkle: supabase-js does NOT throw on a network failure — it resolves the
// query with `{ data: null, count: null, error: <TypeError> }`. So retrying
// requires inspecting the resolved `.error` as well as catching thrown
// exceptions. We retry ONLY transient network classes; a real PGRST/permission
// error is returned/rethrown immediately (never retried, never swallowed) so
// the script's existing tolerant behavior is unchanged apart from resilience.
const TRANSIENT =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|und_err/i;
const RETRY_ATTEMPTS = 3;

function isTransient(err: unknown): boolean {
  if (!err) return false;
  const msg =
    typeof err === "string" ? err : ((err as { message?: string }).message ?? "");
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const causeStr = cause ? `${cause.code ?? ""} ${cause.message ?? ""}` : "";
  return TRANSIENT.test(msg) || TRANSIENT.test(causeStr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a Supabase query thunk with retry-on-transient-network-error.
 * Retries on a thrown transient error OR a resolved result carrying a transient
 * `.error`. Backoff 500ms → 1s → 2s. Non-transient failures surface immediately
 * (rethrown if thrown; returned as-is if in `.error`). Transient failures that
 * outlast all attempts are surfaced the same way (last result/rethrow), so a
 * genuinely down dependency is never masked.
 */
async function withRetry<T extends { error: { message?: string } | null }>(
  fn: () => PromiseLike<T>,
  label: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fn();
      if (res?.error && isTransient(res.error) && attempt < RETRY_ATTEMPTS) {
        console.log(
          `[retry] ${label} attempt ${attempt}/${RETRY_ATTEMPTS}: ${res.error.message}`,
        );
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (e) {
      if (isTransient(e) && attempt < RETRY_ATTEMPTS) {
        console.log(
          `[retry] ${label} attempt ${attempt}/${RETRY_ATTEMPTS}: ${(e as Error).message}`,
        );
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  const url    = process.env["NEXT_PUBLIC_SUPABASE_URL"]!;
  const secret = process.env["SUPABASE_SECRET_KEY"]!;

  if (!url || !secret) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(2);
  }

  console.log("Target:", url);

  // Read-only diagnostic, intentionally pointed at local OR prod by the
  // caller's sourced env. createAdminClientWith skips the pipeline guard
  // (which is write-oriented) — matches the prior raw-createClient behavior
  // while keeping the import inside @civitics/db per the repo convention.
  const admin = createAdminClientWith(url, secret);
  const anon  = createPublicClient();

  // ── xsr smoke (FIX-403/408 carry-over) ────────────────────────────────
  const anonXsr = await withRetry(
    () =>
      anon
        .from("external_source_refs")
        .select("id", { count: "exact", head: true }),
    "xsr anon count",
  );
  console.log(
    "[xsr] anon read count:", anonXsr.count,
    "error:", anonXsr.error?.message ?? null,
  );

  // ── Per-table binding rate ────────────────────────────────────────────
  console.log("\nPer-table primary_source coverage:");
  console.log("  " + ["table", "bound", "total", "%"].map((s) => s.padEnd(22)).join(""));

  // category → table → count, plus 'other' bucket which also records the raw
  // source key for follow-up registry additions.
  const categoryByTable: Record<string, Record<string, number>> = {};
  const unknownSources = new Map<string, number>();

  for (const { table, huge } of TABLES) {
    // Huge tables (financial_entities, ~2.4M rows on prod) use a planner-estimate
    // count for the unfiltered total: an exact COUNT(*) intermittently blows the
    // ~8s gateway cap → count:null → 0 → the impossible "bound > total" (FIX-450).
    // `count:'estimated'` returns pg_class.reltuples via EXPLAIN in milliseconds, so
    // it cannot time out. PostgREST's estimated mode already falls back to an exact
    // count for small tables, but we scope it to huge tables anyway — the bound count
    // is selective enough to stay under the cap, and small tables keep exact counts.
    // NOT a transient fetch failure (FIX-414 withRetry correctly skips it) — the fix
    // is the count strategy, not a retry.
    const totalRes = await withRetry(
      () =>
        admin
          .from(table)
          .select("id", { count: huge ? "estimated" : "exact", head: true }),
      `${table} total count`,
    );
    const boundRes = await withRetry(
      () =>
        admin
          .from(table)
          .select("id", { count: "exact", head: true })
          .not("primary_source", "is", null),
      `${table} bound count`,
    );
    const total = totalRes.count ?? 0;
    const bound = boundRes.count ?? 0;
    const pct   = total > 0 ? (100 * bound) / total : 0;
    console.log(
      "  " + [table, String(bound), String(total), pct.toFixed(1) + "%"]
        .map((s) => s.padEnd(22))
        .join(""),
    );

    // Walk rows in chunks of PAGE rows (Supabase's default max page size is
    // 1000). For financial_entities (~1.1 M rows), we cap at MAX_ROWS to
    // keep the diagnostic snappy — the result is a sample, not a full
    // audit. For the smaller tables (officials/proposals/agencies, <100k),
    // the cap doesn't bind.
    const PAGE = 1000;
    const MAX_ROWS = 100000;
    let offset = 0;
    const cats: Record<string, number> = {};
    while (offset < MAX_ROWS && offset < bound) {
      const { data, error } = await withRetry(
        () =>
          admin
            .from(table)
            .select("primary_source")
            .not("primary_source", "is", null)
            .order("id") // FIX-760: stable unique order for .range() pagination
            .range(offset, offset + PAGE - 1),
        `${table} page @${offset}`,
      );
      if (error) {
        console.warn(`  (paging error on ${table} @ ${offset}: ${error.message})`);
        break;
      }
      const rows = (data ?? []) as Row[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const key = r.primary_source ?? "";
        if (!key) continue;
        const resolved = resolveSource(key);
        cats[resolved.category] = (cats[resolved.category] ?? 0) + 1;
        if (resolved.unknown) {
          unknownSources.set(key, (unknownSources.get(key) ?? 0) + 1);
        }
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    categoryByTable[table] = cats;
  }

  // ── Per-category coverage ─────────────────────────────────────────────
  console.log("\nPer-category breakdown (sample of up to 100k bound rows per table):");
  const CATEGORIES = ["federal", "state", "local", "community", "other"] as const;
  const header = ["table", ...CATEGORIES] as readonly string[];
  console.log("  " + header.map((s) => s.padEnd(16)).join(""));
  for (const { table } of TABLES) {
    const cats = categoryByTable[table] ?? {};
    const row = [
      table,
      ...CATEGORIES.map((c) => String(cats[c] ?? 0)),
    ];
    console.log("  " + row.map((s) => s.padEnd(16)).join(""));
  }

  // ── Unknown sources → candidates for resolveSource registry ──────────
  if (unknownSources.size > 0) {
    console.log("\nSources NOT in resolveSource registry (label='other'):");
    const sorted = [...unknownSources.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, count] of sorted) {
      console.log(`  ${key.padEnd(40)} ${count}`);
    }
  } else {
    console.log("\nAll observed sources are in resolveSource registry. ✓");
  }

  // ── Congress.gov sanity carry-over from FIX-403/408 smoke ─────────────
  const congressTotal = await withRetry(
    () =>
      admin
        .from("officials")
        .select("id", { count: "exact", head: true })
        .filter("source_ids->>congress_gov", "not.is", null),
    "congress source_ids count",
  );
  const xsrCongress = await withRetry(
    () =>
      admin
        .from("external_source_refs")
        .select("id", { count: "exact", head: true })
        .eq("source", "congress_gov")
        .eq("entity_type", "official"),
    "congress xsr count",
  );
  const materializedCongress = await withRetry(
    () =>
      admin
        .from("officials")
        .select("id", { count: "exact", head: true })
        .eq("primary_source", "congress_gov"),
    "congress primary_source count",
  );
  console.log("\nCongress.gov officials sanity (carried from FIX-403/408 smoke):");
  console.log("  source_ids->>congress_gov  :", congressTotal.count);
  console.log("  xsr rows (source=congress_gov):", xsrCongress.count);
  console.log("  primary_source=congress_gov:", materializedCongress.count);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
