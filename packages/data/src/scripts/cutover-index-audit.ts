/**
 * FIX-341 — Cutover-dropped-indexes audit.
 *
 * Read every pre-cutover migration (filename sorts BEFORE
 * `20260422000000_promote_shadow_to_public.sql`), extract their CREATE INDEX
 * statements, and compare against current `pg_indexes` on the DB pointed at by
 * the active `.env.local`. Reports a triage list of indexes that exist in pre-
 * cutover migration history but are missing from the live DB.
 *
 * Output: docs/audits/cutover-index-audit-<DATE>{,-local}.{md,json}. The script
 * is read-only — no auto-restore. Each MISSING_UNEXPLAINED row is for human
 * triage to decide between restore / intentionally-dropped / restore-with-new
 * shape.
 *
 * Usage (from packages/data):
 *   pnpm data:audit-cutover-indexes
 */

import { Client } from "pg";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const CUTOVER_FILENAME = "20260422000000_promote_shadow_to_public.sql";
const MIGRATIONS_DIR = resolve(__dirname, "../../../../supabase/migrations");
const AUDITS_DIR = resolve(__dirname, "../../../../docs/audits");

type IndexDef = {
  index_name: string;
  table_name: string;
  columns: string[];
  raw_statement: string;
  is_unique: boolean;
  source_migration: string;
};

type LiveIndex = {
  index_name: string;
  table_name: string;
  definition: string;
  columns: string[];
};

type Classification =
  | "PRESENT"
  | "INTENTIONAL_REPLACED"
  | "INTENTIONAL_RESHAPED"
  | "INTENTIONAL_DROPPED"
  | "MISSING_UNEXPLAINED";

type ClassifiedRow = IndexDef & {
  classification: Classification;
  notes?: string;
};

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    return "";
  }
  if (!password) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

const CREATE_INDEX_RE =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:(?:\w+)\.)?(\w+)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)/gi;

const DROP_INDEX_RE =
  /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:(?:\w+)\.)?(\w+)/gi;

function extractCreateIndexes(sqlBody: string, sourceMigration: string): IndexDef[] {
  const found: IndexDef[] = [];
  const droppedLater = new Set<string>();

  // Collect DROP INDEX names so we can skip CREATE INDEX statements that are
  // immediately undone within the same file (intra-migration churn).
  const dropMatches = sqlBody.matchAll(DROP_INDEX_RE);
  for (const m of dropMatches) {
    droppedLater.add(m[1].toLowerCase());
  }

  const matches = sqlBody.matchAll(CREATE_INDEX_RE);
  for (const m of matches) {
    const indexName = m[2];
    const tableName = m[3];
    const columnsCsv = m[4];
    const isUnique = Boolean(m[1]);

    if (droppedLater.has(indexName.toLowerCase())) continue;

    const columns = columnsCsv
      .split(",")
      .map((c) =>
        c
          .trim()
          .replace(/\s+(ASC|DESC)$/i, "")
          .replace(/\s+(NULLS\s+(FIRST|LAST))$/i, "")
          .replace(/\s+gin_trgm_ops$/i, "")
          .replace(/\s+text_pattern_ops$/i, "")
          .replace(/\s+varchar_pattern_ops$/i, "")
          .trim()
          .toLowerCase(),
      )
      .filter((c) => c.length > 0);

    found.push({
      index_name: indexName,
      table_name: tableName.toLowerCase(),
      columns,
      raw_statement: m[0].replace(/\s+/g, " ").trim(),
      is_unique: isUnique,
      source_migration: sourceMigration,
    });
  }

  return found;
}

function extractDropIndexes(sqlBody: string): Set<string> {
  const dropped = new Set<string>();
  const matches = sqlBody.matchAll(DROP_INDEX_RE);
  for (const m of matches) {
    dropped.add(m[1].toLowerCase());
  }
  return dropped;
}

function columnSetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join("|");
  const sb = [...b].sort().join("|");
  return sa === sb;
}

async function listLiveColumns(
  client: Client,
): Promise<Map<string, Set<string>>> {
  const res = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const map = new Map<string, Set<string>>();
  for (const row of res.rows) {
    const t = row.table_name.toLowerCase();
    if (!map.has(t)) map.set(t, new Set());
    map.get(t)!.add(row.column_name.toLowerCase());
  }
  return map;
}

async function listLiveIndexes(client: Client): Promise<Map<string, LiveIndex>> {
  const res = await client.query<{
    indexname: string;
    tablename: string;
    indexdef: string;
  }>(
    `SELECT indexname, tablename, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'`,
  );
  const map = new Map<string, LiveIndex>();
  for (const row of res.rows) {
    // Parse the indexdef to extract columns — same regex shape as migrations.
    const parsed = extractCreateIndexes(row.indexdef, `pg_indexes:${row.indexname}`);
    const columns = parsed[0]?.columns ?? [];
    map.set(row.indexname.toLowerCase(), {
      index_name: row.indexname,
      table_name: row.tablename.toLowerCase(),
      definition: row.indexdef,
      columns,
    });
  }
  return map;
}

function classify(
  preIdx: IndexDef,
  live: Map<string, LiveIndex>,
  postCutover: IndexDef[],
  postCutoverDrops: Set<string>,
  liveColumns: Map<string, Set<string>>,
): { classification: Classification; notes?: string } {
  // a. Present on live DB
  if (live.has(preIdx.index_name.toLowerCase())) {
    return { classification: "PRESENT" };
  }

  // b. Same name re-created by cutover or later migration
  const sameName = postCutover.find(
    (p) => p.index_name.toLowerCase() === preIdx.index_name.toLowerCase(),
  );
  if (sameName) {
    return {
      classification: "INTENTIONAL_REPLACED",
      notes: `Recreated by ${sameName.source_migration}.`,
    };
  }

  // c. Different name but same (table, column set) — first check post-cutover
  //    migration files (likely a Stage 1 rename or partial-index conversion).
  const reshape = postCutover.find(
    (p) =>
      p.table_name === preIdx.table_name &&
      columnSetEqual(p.columns, preIdx.columns),
  );
  if (reshape) {
    return {
      classification: "INTENTIONAL_RESHAPED",
      notes: `Likely renamed/reshaped to ${reshape.index_name} in ${reshape.source_migration}.`,
    };
  }

  // c'. Different name but same (table, column set) — also check live DB.
  //     Stage 1 shadow.* migrations are pre-cutover by filename, so any live
  //     index that covers the same columns under a different name (e.g.
  //     shadow_proposals_governing_body_id covering proposals.governing_body_id)
  //     is a rename, not a true loss.
  if (preIdx.columns.length > 0) {
    for (const liveIdx of live.values()) {
      if (
        liveIdx.table_name === preIdx.table_name &&
        columnSetEqual(liveIdx.columns, preIdx.columns)
      ) {
        return {
          classification: "INTENTIONAL_RESHAPED",
          notes: `Live DB has ${liveIdx.index_name} covering the same (table, columns).`,
        };
      }
    }
  }

  // d. Explicit DROP INDEX in cutover or post-cutover migration
  if (postCutoverDrops.has(preIdx.index_name.toLowerCase())) {
    return {
      classification: "INTENTIONAL_DROPPED",
      notes: "DROP INDEX in cutover or post-cutover migration.",
    };
  }

  // d'. Table or any referenced column no longer exists on live — index could
  //     not possibly survive. Treat as INTENTIONAL_DROPPED (table/column
  //     dropped intentionally is itself the implicit DROP INDEX).
  const tableCols = liveColumns.get(preIdx.table_name);
  if (!tableCols) {
    return {
      classification: "INTENTIONAL_DROPPED",
      notes: `Table public.${preIdx.table_name} no longer exists.`,
    };
  }
  // Only check column existence when the column spec is a plain identifier
  // (not an expression like "(metadata->>'x')" or "to_tsvector(...)").
  const plainCols = preIdx.columns.filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
  const missingCols = plainCols.filter((c) => !tableCols.has(c));
  if (plainCols.length > 0 && missingCols.length === plainCols.length) {
    return {
      classification: "INTENTIONAL_DROPPED",
      notes: `Column(s) no longer exist on public.${preIdx.table_name}: ${missingCols.join(", ")}.`,
    };
  }

  return { classification: "MISSING_UNEXPLAINED" };
}

function isProdUrl(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  return /supabase\.co/.test(supabaseUrl) && !/127\.0\.0\.1/.test(supabaseUrl);
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function renderRow(r: ClassifiedRow): string {
  const cols = r.columns.join(", ");
  const raw = r.raw_statement.length > 200
    ? r.raw_statement.slice(0, 197) + "..."
    : r.raw_statement;
  const notes = r.notes ? r.notes.replace(/\|/g, "\\|") : "";
  return `| \`${r.index_name}\` | \`${r.table_name}\` | ${cols} | \`${r.source_migration}\` | ${notes} | \`${raw.replace(/\|/g, "\\|")}\` |`;
}

function renderTable(rows: ClassifiedRow[]): string {
  if (rows.length === 0) return "_(none)_\n";
  const header =
    "| index_name | table | columns | source_migration | notes | raw_statement |\n" +
    "|---|---|---|---|---|---|";
  const body = rows.map(renderRow).join("\n");
  return `${header}\n${body}\n`;
}

async function writeReport(
  classifications: ClassifiedRow[],
  outputDir: string,
  suffix: string,
  meta: {
    dbHost: string;
    runAt: string;
    preCutoverMigrationCount: number;
    preCutoverIndexCount: number;
    liveIndexCount: number;
  },
): Promise<{ mdPath: string; jsonPath: string }> {
  await mkdir(outputDir, { recursive: true });
  const stamp = todayStamp();
  const mdPath = join(outputDir, `cutover-index-audit-${stamp}${suffix}.md`);
  const jsonPath = join(outputDir, `cutover-index-audit-${stamp}${suffix}.json`);

  const byClass = {
    PRESENT: classifications.filter((c) => c.classification === "PRESENT"),
    MISSING_UNEXPLAINED: classifications.filter(
      (c) => c.classification === "MISSING_UNEXPLAINED",
    ),
    INTENTIONAL_REPLACED: classifications.filter(
      (c) => c.classification === "INTENTIONAL_REPLACED",
    ),
    INTENTIONAL_RESHAPED: classifications.filter(
      (c) => c.classification === "INTENTIONAL_RESHAPED",
    ),
    INTENTIONAL_DROPPED: classifications.filter(
      (c) => c.classification === "INTENTIONAL_DROPPED",
    ),
  };

  const md = [
    `# Cutover-dropped-indexes audit — ${stamp}`,
    "",
    `- Ran at: \`${meta.runAt}\``,
    `- DB host: \`${meta.dbHost}\``,
    `- Pre-cutover migrations scanned: ${meta.preCutoverMigrationCount}`,
    `- Pre-cutover CREATE INDEX statements extracted: ${meta.preCutoverIndexCount}`,
    `- Live \`public\` indexes on target DB: ${meta.liveIndexCount}`,
    "",
    "Buckets:",
    `- PRESENT: ${byClass.PRESENT.length}`,
    `- MISSING_UNEXPLAINED: ${byClass.MISSING_UNEXPLAINED.length}`,
    `- INTENTIONAL_REPLACED: ${byClass.INTENTIONAL_REPLACED.length}`,
    `- INTENTIONAL_RESHAPED: ${byClass.INTENTIONAL_RESHAPED.length}`,
    `- INTENTIONAL_DROPPED: ${byClass.INTENTIONAL_DROPPED.length}`,
    "",
    `## Front page: MISSING_UNEXPLAINED (${byClass.MISSING_UNEXPLAINED.length})`,
    "",
    "High-signal triage list. Each row is an index that existed in pre-cutover",
    "migration history but was not found by any other heuristic (no same-name",
    "rebuild, no same-table+columns reshape, no explicit DROP INDEX). For each,",
    "decide: restore as-is / restore with new shape / intentionally dropped.",
    "",
    renderTable(byClass.MISSING_UNEXPLAINED),
    "",
    `## Collapsed: INTENTIONAL_* (${byClass.INTENTIONAL_REPLACED.length + byClass.INTENTIONAL_RESHAPED.length + byClass.INTENTIONAL_DROPPED.length} total)`,
    "",
    "<details>",
    `<summary>INTENTIONAL_REPLACED (${byClass.INTENTIONAL_REPLACED.length}) — same name recreated by cutover or later migration</summary>`,
    "",
    renderTable(byClass.INTENTIONAL_REPLACED),
    "",
    "</details>",
    "",
    "<details>",
    `<summary>INTENTIONAL_RESHAPED (${byClass.INTENTIONAL_RESHAPED.length}) — different name, same (table, column set) — likely partial-index conversion or rename</summary>`,
    "",
    renderTable(byClass.INTENTIONAL_RESHAPED),
    "",
    "</details>",
    "",
    "<details>",
    `<summary>INTENTIONAL_DROPPED (${byClass.INTENTIONAL_DROPPED.length}) — explicit DROP INDEX in cutover or post-cutover migration</summary>`,
    "",
    renderTable(byClass.INTENTIONAL_DROPPED),
    "",
    "</details>",
    "",
    `## PRESENT — ${byClass.PRESENT.length} pre-cutover indexes still live on the DB.`,
    "",
    "_(No table — these are the happy path. See JSON output for the full list.)_",
    "",
  ].join("\n");

  await writeFile(mdPath, md, "utf8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        run_at: meta.runAt,
        db_host: meta.dbHost,
        pre_cutover_migration_count: meta.preCutoverMigrationCount,
        pre_cutover_index_count: meta.preCutoverIndexCount,
        live_index_count: meta.liveIndexCount,
        counts: Object.fromEntries(
          Object.entries(byClass).map(([k, v]) => [k, v.length]),
        ),
        classifications,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { mdPath, jsonPath };
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const runningProd = isProdUrl(supabaseUrl);
  const suffix = runningProd ? "" : "-local";

  const dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");

  // Read migrations
  const allMigrations = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const preCutover = allMigrations.filter((f) => f < CUTOVER_FILENAME);
  const postCutoverFiles = allMigrations.filter((f) => f >= CUTOVER_FILENAME);

  const preCutoverIndexes: IndexDef[] = [];
  for (const f of preCutover) {
    const body = await readFile(join(MIGRATIONS_DIR, f), "utf8");
    preCutoverIndexes.push(...extractCreateIndexes(body, f));
  }

  const postCutoverIndexes: IndexDef[] = [];
  const postCutoverDrops = new Set<string>();
  for (const f of postCutoverFiles) {
    const body = await readFile(join(MIGRATIONS_DIR, f), "utf8");
    postCutoverIndexes.push(...extractCreateIndexes(body, f));
    for (const name of extractDropIndexes(body)) {
      postCutoverDrops.add(name);
    }
  }

  // De-dup pre-cutover indexes by name, keeping the LATEST source_migration
  // (later migrations can recreate the same name with a different shape).
  const preCutoverByName = new Map<string, IndexDef>();
  for (const idx of preCutoverIndexes) {
    preCutoverByName.set(idx.index_name.toLowerCase(), idx);
  }
  const dedupedPreCutover = Array.from(preCutoverByName.values());

  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const dbHost = new URL(cleanUrl).host;
  console.log(`Connected to: ${dbHost}`);
  console.log(`Pre-cutover migrations scanned: ${preCutover.length}`);
  console.log(`Pre-cutover CREATE INDEX (deduped by name): ${dedupedPreCutover.length}`);

  const live = await listLiveIndexes(client);
  console.log(`Live public indexes: ${live.size}`);
  const liveColumns = await listLiveColumns(client);

  const classifications: ClassifiedRow[] = dedupedPreCutover.map((idx) => {
    const c = classify(
      idx,
      live,
      postCutoverIndexes,
      postCutoverDrops,
      liveColumns,
    );
    return { ...idx, ...c };
  });

  await client.end();

  const runAt = new Date().toISOString();
  const { mdPath, jsonPath } = await writeReport(
    classifications,
    AUDITS_DIR,
    suffix,
    {
      dbHost,
      runAt,
      preCutoverMigrationCount: preCutover.length,
      preCutoverIndexCount: dedupedPreCutover.length,
      liveIndexCount: live.size,
    },
  );

  const missing = classifications.filter(
    (c) => c.classification === "MISSING_UNEXPLAINED",
  );
  console.log(`\nResults written:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
  console.log(`\nMISSING_UNEXPLAINED: ${missing.length}`);
  if (missing.length > 0) {
    for (const r of missing) {
      console.log(`  - ${r.index_name}  on ${r.table_name}(${r.columns.join(", ")})  [${r.source_migration}]`);
    }
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
