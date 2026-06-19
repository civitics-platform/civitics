/**
 * SF-P3 shadow moderation harness (FIX-601).
 *
 * Read-only regression engine for the moderation casebook. For each fixture
 * (state-of-franklin-bible §11.1, F1–F12) it:
 *   1. opens a transaction,
 *   2. instantiates minimal synthetic bad behavior (ephemeral, non-synthetic users),
 *   3. computes what the LIVE deterministic moderation rules would do,
 *   4. ROLLS THE FIXTURE CONTENT BACK,
 *   5. writes ONE moderation_audit row (autocommit — persists past the rollback).
 *
 * It confers ZERO consequence: no flag, score, hide, or queue write survives.
 * The ONLY table it writes is moderation_audit. A zero-pollution self-check
 * compares row counts of the mutable tables before/after the whole run.
 *
 *   pnpm --filter @civitics/data data:moderation-harness
 *   pnpm --filter @civitics/data data:moderation-harness -- --strict
 *   pnpm --filter @civitics/data data:moderation-harness -- --db-url postgresql://...
 *
 * Defaults to LOCAL Docker. A prod run writes moderation_audit on prod and
 * creates+rolls-back fixture content there, so it requires --allow-prod AND a
 * supabase.co --db-url (see CLAUDE.md "Data-state changes vs schema changes").
 */

import { execSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { FIXTURES } from "./fixtures";
import { writeReport, printStdoutTable } from "./reporter";
import type { AuditRow, HarnessReport, TxContext } from "./types";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Tables a fixture could mutate. The rollback should leave every count unchanged.
const POLLUTION_TABLES = [
  "entity_comments",
  "content_flags",
  "comment_ratings",
  "entity_positions",
  "position_events",
  "evidence_cards",
  "citations",
  "investigations",
];

interface Args {
  dbUrl: string;
  strict: boolean;
  outDir: string;
  allowProd: boolean;
}

function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/data/src/pipelines/moderation-harness/index.ts → up 5 levels.
  return resolve(here, "..", "..", "..", "..", "..");
}

function defaultOutDir(): string {
  return resolve(workspaceRoot(), "docs/moderation-harness");
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl =
    process.env.SUPABASE_DB_URL ?? process.env.COWORK_READONLY_DB_URL ?? LOCAL_DB_URL;
  let strict = false;
  let outDir = defaultOutDir();
  let allowProd = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--out" && args[i + 1]) outDir = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: data:moderation-harness [--db-url <url>] [--strict] [--out <dir>] [--allow-prod]",
      );
      process.exit(0);
    }
  }
  if (!isAbsolute(outDir)) outDir = resolve(workspaceRoot(), outDir);
  return { dbUrl, strict, outDir, allowProd };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: workspaceRoot(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function tableCounts(client: Client): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const t of POLLUTION_TABLES) {
    const res = await client.query(`SELECT count(*)::bigint AS n FROM public.${t}`);
    counts.set(t, Number(res.rows[0].n));
  }
  return counts;
}

async function main(): Promise<void> {
  const { dbUrl, strict, outDir, allowProd } = parseArgs(process.argv);
  const host = hostFromUrl(dbUrl);
  const isProd = /supabase\.(co|com)/i.test(host) || /supabase\./i.test(dbUrl);

  // The harness WRITES (moderation_audit) and exercises live rules on prod tables
  // (rolled back). Guard the prod path behind an explicit flag.
  if (isProd && !allowProd) {
    // eslint-disable-next-line no-console
    console.error(
      `REFUSING to run against what looks like prod (${host}) without --allow-prod.\n` +
        "The harness writes moderation_audit and create-and-rolls-back fixture content " +
        "on the target DB. Confirm intent, then re-run with --allow-prod.",
    );
    process.exit(2);
  }

  const start = Date.now();
  const sha = gitSha();
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  // eslint-disable-next-line no-console
  console.log(
    `Shadow moderation harness — host=${host} sha=${sha} ` +
      `${isProd ? "(PROD — fixtures create-and-rollback)" : "(local)"}`,
  );

  const before = await tableCounts(client);

  let savepointSeq = 0;
  const rows: AuditRow[] = [];

  for (const fx of FIXTURES) {
    await client.query("BEGIN");
    // Per-fixture context bound to the open transaction.
    const tx: TxContext = {
      query: async <T>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params as unknown[] | undefined);
        return res.rows as T[];
      },
      createUser: async (_label?: string) => {
        // Ephemeral, NON-synthetic (so the live standing/scorer rules evaluate it).
        // Rolled back with the txn — never persists, never confers real standing.
        const res = await client.query<{ id: string }>(
          `WITH a AS (
             INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id
           ), u AS (
             INSERT INTO public.users (id, is_synthetic) SELECT id, false FROM a RETURNING id
           )
           SELECT id FROM u`,
        );
        return res.rows[0].id;
      },
      impersonate: async (userId: string) => {
        // Txn-local GUC → auth.uid() reads it; vanishes on rollback.
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: userId, role: "authenticated" }),
        ]);
      },
      expectRaise: async (sql: string, params?: unknown[]) => {
        const sp = `harness_sp_${savepointSeq++}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          await client.query(sql, params as unknown[] | undefined);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          return { raised: false };
        } catch (err) {
          // Un-poison the aborted (sub)transaction so the harness can continue.
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          const e = err as { code?: string; message?: string };
          return { raised: true, code: e.code, message: e.message };
        }
      },
    };

    let result;
    let fixtureError: unknown;
    try {
      result = await fx.run(tx);
    } catch (err) {
      fixtureError = err;
    }
    // Fixture content NEVER persists — always roll back.
    await client.query("ROLLBACK");

    if (fixtureError || !result) {
      // Harness-internal failure — never silently skip a fixture (decision: throw).
      throw new Error(
        `Fixture ${fx.id} (${fx.title}) errored: ${
          (fixtureError as Error)?.message ?? "no result returned"
        }`,
      );
    }

    const row: AuditRow = {
      fixtureId: fx.id,
      ruleId: fx.ruleId,
      expectation: fx.expectation,
      expectedVerdict: fx.expectedVerdict,
      computedVerdict: result.computedVerdict,
      match: result.match,
      notes: result.notes ?? null,
    };
    rows.push(row);

    // Append-only ledger write — the ONLY thing that survives. Autocommit (we are
    // outside any transaction here, post-ROLLBACK).
    await client.query(
      `INSERT INTO public.moderation_audit
         (sha, fixture_id, rule_id, expected_verdict, computed_verdict, match, expectation, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        sha,
        row.fixtureId,
        row.ruleId,
        row.expectedVerdict,
        row.computedVerdict,
        row.match,
        row.expectation,
        row.notes,
      ],
    );
  }

  const after = await tableCounts(client);
  await client.end();

  const pollution = POLLUTION_TABLES.map((t) => {
    const b = before.get(t) ?? 0;
    const a = after.get(t) ?? 0;
    return { table: t, before: b, after: a, delta: a - b };
  });

  const mismatches = rows.filter((r) => !r.match);
  const regressions = mismatches.filter((r) => r.expectation !== "gap").length;
  const knownFailing = mismatches.filter((r) => r.expectation === "gap").length;

  const report: HarnessReport = {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    dbHost: host,
    sha,
    rows,
    pollution,
    summary: {
      total: rows.length,
      matches: rows.length - mismatches.length,
      mismatches: mismatches.length,
      regressions,
      knownFailing,
    },
  };

  const { jsonPath, mdPath } = writeReport(report, outDir, allowProd);
  printStdoutTable(report);

  const dirty = pollution.filter((p) => p.delta !== 0);
  if (dirty.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n⚠️  POLLUTION: rows leaked past rollback — ${dirty
        .map((p) => `${p.table}+${p.delta}`)
        .join(", ")}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log("\n✅ Zero-pollution: every fixture's content rolled back cleanly.");
  }

  // eslint-disable-next-line no-console
  console.log(`\nWrote: ${jsonPath}\nWrote: ${mdPath}`);

  // CI semantics: fail on a handled/partial REGRESSION or any pollution. Never
  // fail on known-failing GAP rows (those are the backlog signal, by design).
  if (strict && (regressions > 0 || dirty.length > 0)) {
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
