/**
 * FIX-889 + FIX-891 — repair proposal tag_category drift.
 *
 * The drain path wrote the complexity classification (`technical` /
 * `accessible`) into `tag_category='topic'`. On prod they are the #1 and #2
 * "topics" by volume — 4,561 of 12,104 topic rows (38%) — ahead of every real
 * topic, so `/api/graph/tag-groups` offers "Technical" and "Accessible" as
 * topic groups and any consumer of proposal topics gets a plurality of
 * non-topics. `ai-tagger.ts` has always written these under `quality`; only
 * the drain path has ever actually run (zero quality rows exist; every AI
 * proposal topic row carries pipeline_version='drain-v1').
 *
 * This is a RE-CATEGORIZATION, not a deletion. The complexity signal is real
 * work and `quality` is already a first-class rendered category, so nothing in
 * the UI changes. The producer fix that stops it recurring is FIX-890
 * (drain/prompts/tag.md + drain/apply.ts + drain/vocabulary.ts).
 *
 * All SQL lives in sql/recategorize-proposal-complexity-tags.sql; this runner
 * only wraps it in a transaction and prints the result sets. DRY-RUN IS THE
 * DEFAULT: without --apply the transaction is ROLLBACKed, so the printed
 * before/after counts are a proof of what WOULD change.
 *
 * IDEMPOTENT — re-running after a successful apply matches zero rows.
 *
 * Run local (dry-run proof, writes nothing):
 *   pnpm --filter @civitics/data data:recategorize-complexity-tags
 * Run local (apply):
 *   pnpm --filter @civitics/data data:recategorize-complexity-tags -- --apply
 * Run prod (dry-run proof):
 *   pnpm --filter @civitics/data data:recategorize-complexity-tags:prod
 * Run prod (apply — requires BOTH flags, and Craig's explicit go-ahead):
 *   pnpm --filter @civitics/data data:recategorize-complexity-tags:prod -- --apply
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

/** node-pg returns an array for multi-statement simple queries, an object otherwise. */
type PgResult = { command: string; rowCount: number | null; rows: Array<Record<string, unknown>> };

function printRows(label: string, rows: Array<Record<string, unknown>>): void {
  console.log(`\n  ${label}`);
  if (rows.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const r of rows) {
    const parts = Object.entries(r)
      .filter(([k]) => k !== "phase")
      .map(([k, v]) => `${k}=${String(v)}`);
    console.log(`    ${parts.join("  ")}`);
  }
}

async function main(): Promise<void> {
  const prod = isProd();
  const apply = process.argv.includes("--apply");

  if (prod && !process.argv.includes("--allow-prod")) {
    console.error("✗ Active env points at PROD but --allow-prod was not passed. Refusing.");
    process.exit(1);
  }

  const url = buildDbUrl();
  const sqlPath = join(__dirname, "sql", "recategorize-proposal-complexity-tags.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`# FIX-889 + FIX-891 — proposal tag_category drift repair`);
  console.log(`Env:        ${prod ? "PROD (xsazcoxinpgttgquwvuf)" : "local Docker"}`);
  console.log(`Connection: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Mode:       ${apply ? "APPLY (COMMIT)" : "DRY RUN (ROLLBACK — writes nothing)"}`);
  console.log(`SQL:        ${sqlPath}`);

  const client = new Client({ connectionString: url });
  await client.connect();

  let committed = false;
  try {
    await client.query("SET statement_timeout = '120s'");
    await client.query("BEGIN");

    const raw = (await client.query(sql)) as unknown as PgResult | PgResult[];
    const results = Array.isArray(raw) ? raw : [raw];

    // Statement order mirrors the .sql file: 2 before-reports, the DO guard,
    // 2 UPDATEs, 2 after-reports, 1 residual report.
    const selects = results.filter((r) => r.command === "SELECT");
    const updates = results.filter((r) => r.command === "UPDATE");

    const beforeCategory = selects[0]?.rows ?? [];
    const beforeModel = selects[1]?.rows ?? [];
    const afterCategory = selects[2]?.rows ?? [];
    const afterModel = selects[3]?.rows ?? [];
    const residual = selects[4]?.rows ?? [];

    console.log(`\n── FIX-889 · complexity tags (technical/accessible) by category ──`);
    printRows("before:", beforeCategory);
    printRows("after: ", afterCategory);
    console.log(`\n  rows re-categorized topic -> quality: ${updates[0]?.rowCount ?? 0}`);

    console.log(`\n── FIX-891 · ai_model on AI proposal tag rows ──`);
    printRows("before:", beforeModel);
    printRows("after: ", afterModel);
    console.log(
      `\n  rows normalized claude-haiku-4-5 -> claude-haiku-4-5-20251001: ${updates[1]?.rowCount ?? 0}`,
    );

    console.log(`\n── Residual out-of-vocabulary proposal topic tags ──`);
    printRows("remaining:", residual);
    if (residual.length > 0) {
      console.log(
        `\n  NOTE: these await a per-tag disposition decision (FIX-889 design\n` +
          `  decision 5). They are NOT touched by this script — no rows are\n` +
          `  deleted anywhere in this repair.`,
      );
    }

    if (apply) {
      await client.query("COMMIT");
      committed = true;
      console.log(`\n✓ COMMITTED to ${prod ? "PROD" : "local"}.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n✓ ROLLED BACK — nothing was written. Re-run with --apply to commit.`);
    }
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(
    "[recategorize-complexity-tags] fatal:",
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
