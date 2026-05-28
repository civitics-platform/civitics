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

import { createClient } from "@supabase/supabase-js";
import { resolveSource } from "@civitics/db";

const TABLES = [
  { table: "officials",         entityType: "official"         },
  { table: "proposals",         entityType: "proposal"         },
  { table: "agencies",          entityType: "agency"           },
  { table: "governing_bodies",  entityType: "governing_body"   },
  { table: "financial_entities", entityType: "financial_entity" },
] as const;

type Row = { primary_source: string | null };

async function main() {
  const url    = process.env["NEXT_PUBLIC_SUPABASE_URL"]!;
  const secret = process.env["SUPABASE_SECRET_KEY"]!;
  const pub    = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]!;

  if (!url || !secret) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(2);
  }

  console.log("Target:", url);

  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const anon  = createClient(url, pub,    { auth: { persistSession: false } });

  // ── xsr smoke (FIX-403/408 carry-over) ────────────────────────────────
  const anonXsr = await anon
    .from("external_source_refs")
    .select("id", { count: "exact", head: true });
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

  for (const { table } of TABLES) {
    const totalRes = await admin
      .from(table)
      .select("id", { count: "exact", head: true });
    const boundRes = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .not("primary_source", "is", null);
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
      const { data, error } = await admin
        .from(table)
        .select("primary_source")
        .not("primary_source", "is", null)
        .range(offset, offset + PAGE - 1);
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
  const congressTotal = await admin
    .from("officials")
    .select("id", { count: "exact", head: true })
    .filter("source_ids->>congress_gov", "not.is", null);
  const xsrCongress = await admin
    .from("external_source_refs")
    .select("id", { count: "exact", head: true })
    .eq("source", "congress_gov")
    .eq("entity_type", "official");
  const materializedCongress = await admin
    .from("officials")
    .select("id", { count: "exact", head: true })
    .eq("primary_source", "congress_gov");
  console.log("\nCongress.gov officials sanity (carried from FIX-403/408 smoke):");
  console.log("  source_ids->>congress_gov  :", congressTotal.count);
  console.log("  xsr rows (source=congress_gov):", xsrCongress.count);
  console.log("  primary_source=congress_gov:", materializedCongress.count);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
