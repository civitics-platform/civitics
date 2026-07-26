/**
 * FIX-898 — one-time sweep of the pending official TAG enrichment backlog.
 *
 * FIX-896 retired AI issue-area classification for officials, which stops NEW
 * official tag tasks being enqueued. This marks the rows already staged.
 *
 * WHAT IT DOES
 *   Forward (default): currently-PENDING official `tag` rows
 *                      -> status = 'skipped_feature_retired'.
 *   Reverse (--reverse): marked rows -> 'pending'.
 *
 * Rows are MARKED, never deleted — same recoverable-status pattern as FIX-895.
 * The status value is deliberately NOT FIX-895's 'skipped_no_source_text': that
 * one means "the entity isn't ready" and its reverse sweep re-enters a row the
 * moment the entity acquires text, which must never resurrect a retired
 * feature's backlog. See queue-status.ts FEATURE_RETIRED_STATUS.
 *
 * SCOPE — entity_type='official' AND task_type='tag' ONLY.
 *   Official SUMMARY tasks are untouched by design (official AI summaries are a
 *   separate policy question, unanswered by FIX-896). The run asserts the
 *   summary count is unchanged rather than trusting the WHERE clause.
 *
 * IDEMPOTENT / RE-RUNNABLE
 *   Both directions are `UPDATE ... WHERE status = <the other one>`, so a second
 *   run touches 0 rows. No hardcoded ids.
 *
 * MEASURED BEFORE (2026-07-26, pre-sweep)
 *   local  official tag pending 5,917 | official summary pending 2,677
 *   prod   official tag pending 8,886 | official summary pending 2,779
 *
 * USAGE
 *   Local (default target; safe to iterate):
 *     pnpm --filter @civitics/data data:sweep-official-tags -- --dry-run
 *     pnpm --filter @civitics/data data:sweep-official-tags
 *     pnpm --filter @civitics/data data:sweep-official-tags -- --reverse
 *
 *   Prod (requires BOTH an env pointing at Pro AND --allow-prod):
 *     pnpm --filter @civitics/data exec tsx --env-file=<ABS>/.env.local.prod \
 *       <ABS>/packages/data/src/scripts/sweep-official-tags.ts --allow-prod
 *
 *   --dry-run wraps the UPDATE in BEGIN/ROLLBACK and reports the row count the
 *   transaction WOULD touch, changing nothing. Always run it first.
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_RETIRED_STATUS } from "../pipelines/enrichment/queue-status";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_FILE = join(HERE, "sweep-official-tags.sql");

const DRY_RUN = process.argv.includes("--dry-run");
const REVERSE = process.argv.includes("--reverse");

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

/**
 * Pull one `-- @block <name> ... -- @endblock` section out of the .sql file.
 * Keeping the statements in a real .sql file (rather than inline template
 * strings) means the predicate can be reviewed and proven with psql directly.
 */
function sqlBlock(name: "forward" | "reverse"): string {
  const raw = readFileSync(SQL_FILE, "utf8");
  const re = new RegExp(`-- @block ${name}\\r?\\n([\\s\\S]*?)-- @endblock`);
  const m = raw.match(re);
  if (!m?.[1]) throw new Error(`Block "${name}" not found in ${SQL_FILE}`);
  return m[1].trim();
}

type ShapeRow = { task_type: string; status: string; n: string };

/** Full official-slice queue shape — both task types, every status. */
const SHAPE_SQL = `
  SELECT task_type, status, count(*)::bigint AS n
    FROM public.enrichment_queue
   WHERE entity_type = 'official'
   GROUP BY 1, 2
   ORDER BY 1, 2
`;

function printShape(label: string, rows: ShapeRow[]): void {
  console.log(`\n${label}`);
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const w = Math.max(8, ...rows.map((r) => r.status.length));
  console.log(`  ${"task".padEnd(8)}  ${"status".padEnd(w)}  ${"rows".padStart(7)}`);
  console.log(`  ${"-".repeat(8)}  ${"-".repeat(w)}  ${"-".repeat(7)}`);
  let total = 0;
  for (const r of rows) {
    total += Number(r.n);
    console.log(`  ${r.task_type.padEnd(8)}  ${r.status.padEnd(w)}  ${String(r.n).padStart(7)}`);
  }
  console.log(`  ${"-".repeat(8)}  ${"-".repeat(w)}  ${"-".repeat(7)}`);
  console.log(`  ${"TOTAL".padEnd(8)}  ${"".padEnd(w)}  ${String(total).padStart(7)}`);
}

function pick(rows: ShapeRow[], task: string, status: string): number {
  return Number(rows.find((r) => r.task_type === task && r.status === status)?.n ?? 0);
}

async function main(): Promise<void> {
  const prod = isProd();
  if (prod && !process.argv.includes("--allow-prod")) {
    console.error(
      `✗ Active env points at PROD but --allow-prod was not passed.\n` +
        `  This script WRITES enrichment_queue.status on ~8.9k official tag rows.\n` +
        `  Add --allow-prod explicitly. Refusing to write to prod by accident.`,
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const direction = REVERSE ? "REVERSE (marked → pending)" : "FORWARD (pending → marked)";

  console.log(`# FIX-898 — official TAG backlog sweep (feature retired, FIX-896)`);
  console.log(`Env:        ${prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker"}`);
  console.log(`Connection: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Direction:  ${direction}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY RUN (BEGIN → count → ROLLBACK, writes nothing)" : "LIVE WRITE"}`);
  console.log(`Scope:      entity_type='official' AND task_type='tag'`);
  console.log(`Status:     ${FEATURE_RETIRED_STATUS}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Long sweep on a direct pg.Client — session-level SET is valid here (the
    // service_role ~8s PostgREST ceiling does not apply).
    await client.query("SET statement_timeout = '600s'");

    const before = (await client.query(SHAPE_SQL)).rows as ShapeRow[];
    printShape("BEFORE — enrichment_queue, entity_type='official':", before);

    const totalBefore = Number(
      (await client.query(`SELECT count(*)::bigint AS n FROM public.enrichment_queue`)).rows[0].n,
    );
    const summaryPendingBefore = pick(before, "summary", "pending");

    // The write always runs inside an explicit transaction so --dry-run can
    // report the exact affected row count and then discard it.
    await client.query("BEGIN");
    const res = await client.query(sqlBlock(REVERSE ? "reverse" : "forward"));
    const affected = res.rowCount ?? 0;

    console.log(
      `\n${DRY_RUN ? "WOULD UPDATE" : "UPDATED"}: ${affected} enrichment_queue row(s) ` +
        `→ ${REVERSE ? "pending" : FEATURE_RETIRED_STATUS}`,
    );

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("ROLLBACK — nothing was written.");
      return;
    }

    await client.query("COMMIT");
    console.log("COMMIT — sweep applied.");

    const after = (await client.query(SHAPE_SQL)).rows as ShapeRow[];
    printShape("AFTER — enrichment_queue, entity_type='official':", after);

    // ── Post-conditions. Assert rather than trust the WHERE clause. ──────────
    let failed = false;

    // 1. Forward: no pending official tag rows survive.
    if (!REVERSE) {
      const leftover = pick(after, "tag", "pending");
      if (leftover !== 0) {
        console.error(`\n✗ POST-CONDITION FAILED: ${leftover} official tag row(s) still pending. Expected 0.`);
        failed = true;
      } else {
        console.log(`\n✓ Post-condition: zero pending official tag rows remain.`);
      }
    }

    // 2. Official SUMMARY rows are untouched — the scope guarantee this sweep
    //    makes to the still-live official summary path.
    const summaryPendingAfter = pick(after, "summary", "pending");
    if (summaryPendingAfter !== summaryPendingBefore) {
      console.error(
        `\n✗ POST-CONDITION FAILED: pending official SUMMARY rows changed ` +
          `${summaryPendingBefore} → ${summaryPendingAfter}. This sweep must not touch them.`,
      );
      failed = true;
    } else {
      console.log(`✓ Post-condition: pending official summary rows unchanged (${summaryPendingAfter}).`);
    }

    // 3. Nothing is ever deleted — prove the row count is conserved.
    const totalAfter = Number(
      (await client.query(`SELECT count(*)::bigint AS n FROM public.enrichment_queue`)).rows[0].n,
    );
    if (totalAfter !== totalBefore) {
      console.error(
        `\n✗ POST-CONDITION FAILED: enrichment_queue total changed ${totalBefore} → ${totalAfter}. ` +
          `This sweep marks rows, it never deletes them.`,
      );
      failed = true;
    } else {
      console.log(`✓ enrichment_queue total rows (nothing deleted): ${totalAfter}`);
    }

    if (failed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
