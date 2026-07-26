/**
 * FIX-895 — one-time sweep of the text-free proposal enrichment backlog.
 *
 * FIX-894 added a source-text gate at the enqueue boundary, but that only stops
 * NEW text-free tasks. This marks the rows already staged.
 *
 * WHAT IT DOES
 *   Forward (default): currently-PENDING proposal tag/summary rows whose entity
 *   holds no usable source text  ->  status = 'skipped_no_source_text'.
 *   Reverse (--reverse):  marked rows whose entity NOW has text  ->  'pending'.
 *
 * Rows are MARKED, never deleted. Nothing is lost: the reverse sweep is the
 * recoverability path required by the design (a Legistar matter that later gains
 * a summary re-enters the queue), and it re-derives eligibility from the text
 * itself rather than from any record of what was swept.
 *
 * WHY THIS EXISTS
 *   Measured on prod 2026-07-25: of 138,807 pending proposal tasks, only 3,089
 *   had text we could honestly classify from. 127,260 were Legistar municipal
 *   matters with ZERO summary_plain (San Francisco, Austin, Seattle — their
 *   source API supplies no abstract, so they will not acquire text by waiting),
 *   plus 1,796 courtlistener/regulations_gov rows equally text-free. Draining
 *   that backlog means paying a model to invent topics and summaries from titles.
 *
 * PREDICATE
 *   Identical to hasUsableSourceText() in pipelines/enrichment/queue.ts, i.e.
 *   classifyProposalContext(...) === "full_summary":
 *     length(trim(coalesce(summary_plain,''))) > 100
 *     AND lower(trim(summary_plain)) <> lower(trim(title))
 *   The SQL lives in sweep-no-source-text.sql beside this file. If the two ever
 *   disagree the backlog oscillates — change them together.
 *
 * IDEMPOTENT / RE-RUNNABLE
 *   Both directions are `UPDATE ... WHERE status = <the other one>`, so a second
 *   run touches 0 rows. No hardcoded ids — the target set is derived by query
 *   every time.
 *
 * SCOPE
 *   entity_type='proposal' only. Officials and financial entities build their
 *   enrichment context from structured aggregates (vote counts, donor
 *   composition, committee type), not prose, so "has source text" is not the
 *   right question for them. Their enqueue policy is a separate decision.
 *
 * USAGE
 *   Local (default target; safe to iterate):
 *     pnpm --filter @civitics/data data:sweep-no-text -- --dry-run
 *     pnpm --filter @civitics/data data:sweep-no-text
 *     pnpm --filter @civitics/data data:sweep-no-text -- --reverse
 *
 *   Prod (requires BOTH an env pointing at Pro AND --allow-prod):
 *     pnpm --filter @civitics/data exec tsx --env-file=<ABS>/.env.local.prod \
 *       <ABS>/packages/data/src/scripts/sweep-no-source-text.ts --allow-prod
 *
 *   --dry-run wraps the UPDATE in BEGIN/ROLLBACK and reports the row count the
 *   transaction WOULD touch, changing nothing. Always run it first.
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_SOURCE_TEXT_STATUS } from "../pipelines/enrichment/queue-status";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_FILE = join(HERE, "sweep-no-source-text.sql");

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

type ShapeRow = {
  source: string;
  task_type: string;
  pending: string;
  qualifies: string;
  no_text: string;
};

/** Current pending-proposal queue shape, grouped by source × task type. */
const SHAPE_SQL = `
  SELECT COALESCE(p.primary_source, '(no primary_source)') AS source,
         q.task_type,
         count(*)                                                       AS pending,
         count(*) FILTER (WHERE     length(trim(coalesce(p.summary_plain,''))) > 100
                              AND lower(trim(coalesce(p.summary_plain,''))) <> lower(trim(coalesce(p.title,'')))) AS qualifies,
         count(*) FILTER (WHERE NOT (length(trim(coalesce(p.summary_plain,''))) > 100
                              AND lower(trim(coalesce(p.summary_plain,''))) <> lower(trim(coalesce(p.title,''))))) AS no_text
    FROM public.enrichment_queue q
    JOIN public.proposals p ON p.id = q.entity_id::uuid
   WHERE q.status = $1
     AND q.entity_type = 'proposal'
     AND q.task_type IN ('tag','summary')
   GROUP BY 1, 2
   ORDER BY 3 DESC
`;

function printShape(label: string, rows: ShapeRow[]): void {
  console.log(`\n${label}`);
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const w = Math.max(6, ...rows.map((r) => r.source.length));
  console.log(`  ${"source".padEnd(w)}  ${"task".padEnd(8)}  ${"rows".padStart(7)}  ${"has_text".padStart(9)}  ${"no_text".padStart(8)}`);
  console.log(`  ${"-".repeat(w)}  ${"-".repeat(8)}  ${"-".repeat(7)}  ${"-".repeat(9)}  ${"-".repeat(8)}`);
  let tp = 0, tq = 0, tn = 0;
  for (const r of rows) {
    tp += Number(r.pending); tq += Number(r.qualifies); tn += Number(r.no_text);
    console.log(
      `  ${r.source.padEnd(w)}  ${r.task_type.padEnd(8)}  ` +
      `${String(r.pending).padStart(7)}  ${String(r.qualifies).padStart(9)}  ${String(r.no_text).padStart(8)}`,
    );
  }
  console.log(`  ${"-".repeat(w)}  ${"-".repeat(8)}  ${"-".repeat(7)}  ${"-".repeat(9)}  ${"-".repeat(8)}`);
  console.log(`  ${"TOTAL".padEnd(w)}  ${"".padEnd(8)}  ${String(tp).padStart(7)}  ${String(tq).padStart(9)}  ${String(tn).padStart(8)}`);
}

async function main(): Promise<void> {
  const prod = isProd();
  if (prod && !process.argv.includes("--allow-prod")) {
    console.error(
      `✗ Active env points at PROD but --allow-prod was not passed.\n` +
        `  This script WRITES enrichment_queue.status on up to ~135k rows.\n` +
        `  Add --allow-prod explicitly. Refusing to write to prod by accident.`,
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const direction = REVERSE ? "REVERSE (marked → pending)" : "FORWARD (pending → marked)";

  console.log(`# FIX-895 — enrichment backlog source-text sweep`);
  console.log(`Env:        ${prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker"}`);
  console.log(`Connection: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Direction:  ${direction}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY RUN (BEGIN → count → ROLLBACK, writes nothing)" : "LIVE WRITE"}`);
  console.log(`Predicate:  summary_plain > 100 chars AND not a copy of the title`);
  console.log(`Status:     ${NO_SOURCE_TEXT_STATUS}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Long sweep on a direct pg.Client — session-level SET is valid here (the
    // service_role ~8s PostgREST ceiling does not apply). ~135k single-column
    // UPDATEs on prod need more than the default.
    await client.query("SET statement_timeout = '600s'");

    const readStatus = REVERSE ? NO_SOURCE_TEXT_STATUS : "pending";
    const before = (await client.query(SHAPE_SQL, [readStatus])).rows as ShapeRow[];
    printShape(`BEFORE — proposal tasks in status '${readStatus}', by source:`, before);

    // The write always runs inside an explicit transaction so --dry-run can
    // report the exact affected row count and then discard it.
    await client.query("BEGIN");
    const res = await client.query(sqlBlock(REVERSE ? "reverse" : "forward"));
    const affected = res.rowCount ?? 0;

    console.log(
      `\n${DRY_RUN ? "WOULD UPDATE" : "UPDATED"}: ${affected} enrichment_queue row(s) ` +
        `→ ${REVERSE ? "pending" : NO_SOURCE_TEXT_STATUS}`,
    );

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("ROLLBACK — nothing was written.");
    } else {
      await client.query("COMMIT");
      console.log("COMMIT — sweep applied.");

      const after = (await client.query(SHAPE_SQL, [readStatus])).rows as ShapeRow[];
      printShape(`AFTER — proposal tasks still in status '${readStatus}', by source:`, after);

      // Post-condition: every remaining pending proposal task must satisfy the
      // text predicate. On the forward sweep this is the whole point; assert it
      // rather than trusting the UPDATE.
      if (!REVERSE) {
        const leftover = after.reduce((s, r) => s + Number(r.no_text), 0);
        if (leftover !== 0) {
          console.error(
            `\n✗ POST-CONDITION FAILED: ${leftover} pending proposal task(s) still ` +
              `fail the text predicate. Expected 0.`,
          );
          process.exitCode = 1;
        } else {
          console.log(
            `\n✓ Post-condition: every remaining pending proposal task satisfies the text predicate.`,
          );
        }
      }

      // Nothing is ever deleted — prove the row count is conserved.
      const total = await client.query(
        `SELECT count(*)::bigint AS n FROM public.enrichment_queue`,
      );
      console.log(`✓ enrichment_queue total rows (nothing deleted): ${total.rows[0].n}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
