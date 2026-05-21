/**
 * Data integrity audit (FIX-067)
 *
 * Runs read-only structural checks against a Postgres database — by default
 * the prod read-only role (COWORK_READONLY_DB_URL). Writes a dated JSON +
 * Markdown report to docs/audits/.
 *
 *   pnpm --filter @civitics/data data:audit
 *   pnpm --filter @civitics/data data:audit -- --strict
 *   pnpm --filter @civitics/data data:audit -- --db-url postgresql://...
 *   pnpm --filter @civitics/data data:audit -- --out docs/audits
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { officialsChecks } from "./checks/officials";
import { proposalsChecks } from "./checks/proposals";
import { votesChecks } from "./checks/votes";
import { referentialChecks } from "./checks/referential";
import { writeReport, printStdoutTable, summarize } from "./reporter";
import type { AuditReport, Check, CheckContext, CheckResult } from "./types";

const CHECKS: { name: string; run: Check }[] = [
  { name: "officials", run: officialsChecks },
  { name: "proposals", run: proposalsChecks },
  { name: "votes", run: votesChecks },
  { name: "referential", run: referentialChecks },
];

interface Args {
  dbUrl: string;
  strict: boolean;
  outDir: string;
  allowProd: boolean;
}

// Workspace root, derived from this file's location:
//   packages/data/src/pipelines/integrity-audit/index.ts → up 5 levels.
// INIT_CWD would be the right idea, but pnpm v9 on Windows doesn't reliably
// set it for `pnpm <script>` invocations, so we anchor on a fixed file-system
// path that doesn't depend on how the script was launched. (FIX-299)
function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "..");
}

function defaultOutDir(): string {
  return resolve(workspaceRoot(), "docs/audits");
}

// CI (and any session-pooler-only environment) only carries the project
// password + URL, not a pre-baked readonly DSN. Mirror buildDbUrl() in
// pipelines/index.ts so the audit can run from the weekly GHA workflow
// without a separate secret.
function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    "";
  let strict = false;
  let outDir = defaultOutDir();
  let allowProd = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) {
      dbUrl = args[++i];
    } else if (a === "--strict") {
      strict = true;
    } else if (a === "--out" && args[i + 1]) {
      outDir = args[++i];
    } else if (a === "--allow-prod") {
      allowProd = true;
    } else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: data:audit [--db-url <url>] [--strict] [--out <dir>] [--allow-prod]",
      );
      process.exit(0);
    }
  }
  // Relative --out is resolved against the workspace root, so `--out
  // docs/audits` always lands at repo-root/docs/audits regardless of whether
  // the script was launched from the workspace root or from packages/data/.
  // The bug this fixes: the GHA workflow ran `pnpm --filter @civitics/data
  // data:audit -- --out docs/audits`, which historically resolved against
  // packages/data/ → reports written under packages/data/docs/audits/ →
  // the workflow's commit step at repo root found nothing → silent no-op.
  // (FIX-299)
  if (!isAbsolute(outDir)) {
    outDir = resolve(workspaceRoot(), outDir);
  }
  if (!dbUrl) {
    dbUrl = constructDbUrlFromEnv();
  }
  if (!dbUrl) {
    // eslint-disable-next-line no-console
    console.error(
      "ERROR: no database URL. Set COWORK_READONLY_DB_URL or SUPABASE_DB_URL, " +
        "or provide SUPABASE_DB_PASSWORD + NEXT_PUBLIC_SUPABASE_URL, or pass --db-url.",
    );
    process.exit(2);
  }
  return { dbUrl, strict, outDir, allowProd };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const { dbUrl, strict, outDir, allowProd } = parseArgs(process.argv);
  const start = Date.now();
  // Strip sslmode from the URL so we can set SSL options ourselves. New pg
  // versions treat URL sslmode=require as verify-full, which fails against
  // Supabase's cert chain. We accept the chain explicitly.
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const ctx: CheckContext = {
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params as unknown[] | undefined);
      return res.rows as T[];
    },
  };

  const all: CheckResult[] = [];
  for (const { name, run } of CHECKS) {
    try {
      const results = await run(ctx);
      all.push(...results);
    } catch (err) {
      all.push({
        category: `${name}.failed_to_run`,
        severity: "error",
        expected: "ran cleanly",
        actual: "threw",
        sample: [String(err)],
        detail: `Check group '${name}' threw: ${(err as Error).message ?? err}`,
      });
    }
  }

  await client.end();

  const report: AuditReport = {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    dbHost: hostFromUrl(dbUrl),
    results: all,
    summary: summarize(all),
  };

  const { jsonPath, mdPath } = writeReport(report, outDir, allowProd);
  printStdoutTable(report);
  // eslint-disable-next-line no-console
  console.log(`\nWrote: ${jsonPath}\nWrote: ${mdPath}`);

  if (strict && report.summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
