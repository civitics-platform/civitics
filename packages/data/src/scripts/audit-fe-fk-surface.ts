/**
 * FIX-381 investigation: enumerate the actual polymorphic FK surface that
 * carries `(entity_type='financial_entity', entity_id=<uuid>)` references.
 *
 * The FIX-381 bullet claimed five tables beyond the canonical nine
 * (FIX-271): entity_tags, ai_summary_cache, enrichment_queue,
 * notifications, user_follows. Pre-investigation schema review suggested
 * four of those five are wrong:
 *   - notifications / user_follows discriminator is the follow_entity_type
 *     ENUM = ('official','agency') — INSERT of 'financial_entity' would error
 *   - ai_summary_cache schema comment lists only 'proposal'|'official'|'agency'
 *   - enrichment_queue entity_id is TEXT (not UUID) and comment says
 *     'proposal'|'official' only
 *
 * This script answers definitively: at the schema layer and in actual data,
 * which tables have FE refs?
 *
 * Three passes:
 *   Pass A — enumerate every polymorphic column in public.* via
 *            information_schema.columns; cross-reference with paired
 *            discriminator + constraint shape (ENUM / CHECK / free TEXT).
 *   Pass B — for each table with a discriminator, GROUP BY discriminator
 *            and count rows. Flag any 'financial_entity' value found in
 *            a table whose constraint/comment says it shouldn't be there.
 *   Pass C — for each table where 'financial_entity' refs are confirmed,
 *            count orphan rows (entity_id not present in financial_entities).
 *
 * Output: docs/audits/<YYYY-MM-DD>-fe-fk-surface-audit-{local|prod}.md
 *
 * Usage:
 *   pnpm --filter @civitics/data data:audit-fe-fk-surface
 *   ( source .env.local.prod && pnpm --filter @civitics/data data:audit-fe-fk-surface )
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) return "";
  if (/127\.0\.0\.1:54321|localhost:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const password = process.env["SUPABASE_DB_PASSWORD"];
  if (!password) return "";
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
}

interface PolymorphicSurfaceEntry {
  table: string;
  refColumn: string;
  refType: string;            // UUID, TEXT, etc.
  refNullable: boolean;
  discriminatorColumn: string | null;
  discriminatorType: string | null;   // 'text', 'follow_entity_type' (enum), etc.
  discriminatorIsEnum: boolean;
  discriminatorConstraint: string | null;  // CHECK definition if any
  enumValues: string[] | null;             // present when discriminatorIsEnum
}

interface DiscriminatorDistRow {
  discriminator: string | null;
  n: string;
}

interface OrphanCountRow {
  orphans: string;
  total_fe_refs: string;
}

const DISCRIMINATOR_NAMES_FOR = new Map<string, string>([
  ["entity_id", "entity_type"],
  ["from_id", "from_type"],
  ["to_id", "to_type"],
  ["matched_entity_id", "entity_type"],
]);

async function main(): Promise<void> {
  const dbUrl =
    process.env["COWORK_READONLY_DB_URL"] ??
    process.env["SUPABASE_DB_URL"] ??
    constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const startedAt = Date.now();
  await client.connect();
  const host = new URL(cleanUrl).host;
  const isLocal = /127\.0\.0\.1|localhost/.test(host);
  console.log(`Connected to: ${host} (${isLocal ? "local" : "prod"})\n`);

  // ─── Pass A — schema enumeration ────────────────────────────────────────
  console.log("=== Pass A — schema enumeration ===");
  const polyCols = await client.query<ColumnRow>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('entity_id','from_id','to_id','matched_entity_id')
      ORDER BY table_name, column_name`,
  );

  const allCols = await client.query<ColumnRow>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('entity_type','from_type','to_type')
      ORDER BY table_name, column_name`,
  );

  // Build (table, discriminator_col) → ColumnRow map for pairing
  const discByTable = new Map<string, Map<string, ColumnRow>>();
  for (const c of allCols.rows) {
    if (!discByTable.has(c.table_name)) discByTable.set(c.table_name, new Map());
    discByTable.get(c.table_name)!.set(c.column_name, c);
  }

  // CHECK constraints across all involved tables
  const tableSet = new Set<string>();
  for (const c of polyCols.rows) tableSet.add(c.table_name);
  for (const c of allCols.rows) tableSet.add(c.table_name);

  const checkConstraints = await client.query<{
    table_name: string;
    column_name: string;
    def: string;
  }>(
    `SELECT (conrelid::regclass)::text AS table_name,
            a.attname AS column_name,
            pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'c'
        AND (conrelid::regclass)::text = ANY ($1)
        AND a.attname IN ('entity_type','from_type','to_type')`,
    [Array.from(tableSet)],
  );
  const checkByPair = new Map<string, string>();
  for (const c of checkConstraints.rows) {
    checkByPair.set(`${c.table_name}.${c.column_name}`, c.def);
  }

  // Enum values for any USER-DEFINED discriminator types we see
  const udtNeeded = new Set<string>();
  for (const c of allCols.rows) {
    if (c.data_type === "USER-DEFINED") udtNeeded.add(c.udt_name);
  }
  const enumValues = new Map<string, string[]>();
  if (udtNeeded.size > 0) {
    const enumRows = await client.query<{ enum_name: string; enumlabel: string }>(
      `SELECT t.typname AS enum_name, e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = ANY ($1)
        ORDER BY t.typname, e.enumsortorder`,
      [Array.from(udtNeeded)],
    );
    for (const r of enumRows.rows) {
      if (!enumValues.has(r.enum_name)) enumValues.set(r.enum_name, []);
      enumValues.get(r.enum_name)!.push(r.enumlabel);
    }
  }

  const surface: PolymorphicSurfaceEntry[] = [];
  for (const c of polyCols.rows) {
    const discName = DISCRIMINATOR_NAMES_FOR.get(c.column_name);
    const discCol = discName
      ? discByTable.get(c.table_name)?.get(discName) ?? null
      : null;
    const isEnum = !!(discCol && discCol.data_type === "USER-DEFINED");
    const checkDef = discCol
      ? checkByPair.get(`${c.table_name}.${discCol.column_name}`) ?? null
      : null;
    surface.push({
      table: c.table_name,
      refColumn: c.column_name,
      refType: c.data_type,
      refNullable: c.is_nullable === "YES",
      discriminatorColumn: discCol?.column_name ?? null,
      discriminatorType: discCol
        ? isEnum
          ? discCol.udt_name
          : discCol.data_type
        : null,
      discriminatorIsEnum: isEnum,
      discriminatorConstraint: checkDef,
      enumValues: isEnum ? enumValues.get(discCol!.udt_name) ?? [] : null,
    });
  }

  console.log(`Found ${surface.length} polymorphic ref columns.`);
  for (const s of surface) {
    const discBit = s.discriminatorColumn
      ? `${s.discriminatorColumn}:${s.discriminatorType}${s.discriminatorIsEnum ? ` ENUM(${(s.enumValues ?? []).join("|")})` : s.discriminatorConstraint ? " CHECK" : " no-constraint"}`
      : "no-discriminator";
    console.log(
      `  ${s.table}.${s.refColumn} (${s.refType}${s.refNullable ? " NULL" : ""})  →  ${discBit}`,
    );
  }

  // ─── Pass B — data enumeration ─────────────────────────────────────────
  console.log("\n=== Pass B — data enumeration ===");
  interface PassBResult {
    table: string;
    discriminatorColumn: string;
    distribution: DiscriminatorDistRow[];
    feRows: number;
    enumOrCommentForbidsFE: boolean;
    forbidsReason: string | null;
  }
  const passB: PassBResult[] = [];

  // Tables where the schema/enum/comment explicitly forbids 'financial_entity'.
  // Pulled from the FIX-381 prompt + schema review:
  const FORBIDS_FE_BY_TABLE: Record<string, string> = {
    ai_summary_cache:
      "schema comment says 'proposal'|'official'|'agency' only",
    enrichment_queue:
      "schema comment says 'proposal'|'official' only; entity_id is TEXT not UUID",
    notifications:
      "discriminator is follow_entity_type ENUM = (official, agency)",
    user_follows:
      "discriminator is follow_entity_type ENUM = (official, agency)",
  };

  for (const s of surface) {
    if (!s.discriminatorColumn) continue;
    const dist = await client.query<DiscriminatorDistRow>(
      `SELECT ${s.discriminatorColumn} AS discriminator, COUNT(*)::text AS n
         FROM ${s.table}
        GROUP BY 1
        ORDER BY 2::int DESC`,
    );
    const feRow = dist.rows.find((r) => r.discriminator === "financial_entity");
    const feCount = feRow ? Number(feRow.n) : 0;
    const forbids = FORBIDS_FE_BY_TABLE[s.table];

    passB.push({
      table: s.table,
      discriminatorColumn: s.discriminatorColumn,
      distribution: dist.rows,
      feRows: feCount,
      enumOrCommentForbidsFE: Boolean(forbids),
      forbidsReason: forbids ?? null,
    });

    const summary = dist.rows
      .slice(0, 6)
      .map((r) => `${r.discriminator ?? "<null>"}:${Number(r.n).toLocaleString()}`)
      .join("  ");
    console.log(
      `  ${s.table}.${s.discriminatorColumn} (${dist.rows.length} values)  FE_rows=${feCount.toLocaleString()}  ${summary}`,
    );
  }

  // ─── Pass C — orphan check ─────────────────────────────────────────────
  console.log("\n=== Pass C — orphan check on FE-bearing tables ===");
  interface PassCResult {
    table: string;
    discriminatorColumn: string;
    refColumn: string;
    refColumnType: string;
    totalFERefs: number;
    orphans: number;
  }
  const passC: PassCResult[] = [];

  for (const p of passB) {
    if (p.feRows === 0) continue;
    const s = surface.find(
      (x) => x.table === p.table && x.discriminatorColumn === p.discriminatorColumn,
    )!;

    // enrichment_queue has entity_id as TEXT; gate the cast on a uuid regex
    // so non-uuid string values don't error the cast.
    const totalQ =
      s.refType === "uuid"
        ? `
        SELECT COUNT(*)::text AS total_fe_refs,
               COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM financial_entities fe WHERE fe.id = t.${s.refColumn}
               ))::text AS orphans
          FROM ${s.table} t
         WHERE ${s.discriminatorColumn} = 'financial_entity'`
        : `
        SELECT COUNT(*)::text AS total_fe_refs,
               COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM financial_entities fe
                  WHERE fe.id = t.${s.refColumn}::uuid
               ))::text AS orphans
          FROM ${s.table} t
         WHERE ${s.discriminatorColumn} = 'financial_entity'
           AND ${s.refColumn} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

    const result = await client.query<OrphanCountRow>(totalQ);
    const row = result.rows[0];
    if (!row) continue;
    const total = Number(row.total_fe_refs);
    const orphans = Number(row.orphans);
    passC.push({
      table: p.table,
      discriminatorColumn: p.discriminatorColumn,
      refColumn: s.refColumn,
      refColumnType: s.refType,
      totalFERefs: total,
      orphans,
    });
    console.log(
      `  ${p.table}: ${total.toLocaleString()} FE refs, ${orphans.toLocaleString()} orphans`,
    );
  }

  // ─── Compose verdict + write doc ───────────────────────────────────────
  const elapsedMs = Date.now() - startedAt;
  const realFETables = Array.from(
    new Set(passC.filter((r) => r.totalFERefs > 0).map((r) => r.table)),
  );
  const mismatches = passB.filter((p) => p.enumOrCommentForbidsFE && p.feRows > 0);
  const totalOrphans = passC.reduce((s, r) => s + r.orphans, 0);
  const tablesWithOrphans = new Set(
    passC.filter((r) => r.orphans > 0).map((r) => r.table),
  ).size;

  console.log(`\nReal FE-ref-bearing tables: ${realFETables.length}`);
  console.log(`Schema-vs-data mismatches: ${mismatches.length}`);
  console.log(`Orphans: ${totalOrphans.toLocaleString()} across ${tablesWithOrphans} tables`);
  console.log(`Audit wall time: ${(elapsedMs / 1000).toFixed(1)}s`);

  const today = new Date().toISOString().slice(0, 10);
  const suffix = isLocal ? "-local" : "-prod";
  const outPath = path.resolve(
    path.join(
      __dirname,
      `../../../../docs/audits/${today}-fe-fk-surface-audit${suffix}.md`,
    ),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let md = "";
  md += `# Financial-entity FK-rewrite surface audit — ${today}${isLocal ? " (local)" : " (prod)"}\n\n`;
  md += `Generated by [packages/data/src/scripts/audit-fe-fk-surface.ts](../../packages/data/src/scripts/audit-fe-fk-surface.ts) (\`pnpm data:audit-fe-fk-surface\`).\n\n`;
  md += `- DB host: \`${host}\`\n`;
  md += `- Ran at: \`${new Date().toISOString()}\`\n`;
  md += `- Audit wall time: ${(elapsedMs / 1000).toFixed(1)}s\n`;
  md += `- Investigates FIX-381: enumerate the canonical polymorphic FK surface that carries \`(entity_type='financial_entity', entity_id)\` references in \`public.*\`.\n\n`;

  md += `## Verdict\n\n`;
  md += `- **Real FE-ref-bearing tables:** ${realFETables.length}${realFETables.length ? ` (${realFETables.map((t) => `\`${t}\``).join(", ")})` : ""}\n`;
  md += `- **Schema-vs-data mismatches:** ${mismatches.length}`;
  if (mismatches.length) {
    md += ` — `;
    md += mismatches
      .map((m) => `\`${m.table}\` (${m.feRows.toLocaleString()} rows; forbidden because ${m.forbidsReason})`)
      .join("; ");
  }
  md += `\n`;
  md += `- **Orphans:** ${totalOrphans.toLocaleString()} rows across ${tablesWithOrphans} table(s)\n\n`;

  md += `## Pass A — polymorphic ref columns in \`public.*\`\n\n`;
  md += `Every column in \`public.*\` named \`entity_id\` / \`from_id\` / \`to_id\` / \`matched_entity_id\`, paired with its discriminator column (when one exists) and the constraint shape on that discriminator.\n\n`;
  md += `| table | ref column | ref type | discriminator | discriminator type | constraint |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const s of surface) {
    let constraint = "—";
    if (s.discriminatorIsEnum) {
      constraint = `ENUM(${(s.enumValues ?? []).join(", ")})`;
    } else if (s.discriminatorConstraint) {
      constraint = `CHECK \`${s.discriminatorConstraint.replace(/\|/g, "\\|")}\``;
    } else if (s.discriminatorColumn) {
      constraint = `none (free ${s.discriminatorType?.toUpperCase()})`;
    }
    md += `| \`${s.table}\` | \`${s.refColumn}\` | ${s.refType.toUpperCase()}${s.refNullable ? " NULL" : ""} | ${s.discriminatorColumn ? `\`${s.discriminatorColumn}\`` : "—"} | ${s.discriminatorType ?? "—"} | ${constraint} |\n`;
  }
  md += `\n`;

  md += `## Pass B — discriminator distribution per table\n\n`;
  md += `For each table with a polymorphic discriminator, the distinct discriminator values present and their row counts. \`financial_entity\` rows are flagged.\n\n`;
  for (const p of passB) {
    md += `### \`${p.table}\`.${p.discriminatorColumn}\n\n`;
    if (p.distribution.length === 0) {
      md += `(no rows)\n\n`;
      continue;
    }
    md += `| value | rows |\n|---|--:|\n`;
    for (const r of p.distribution) {
      const v = r.discriminator ?? "<null>";
      const flag = v === "financial_entity" ? " ⚑ FE" : "";
      md += `| \`${v}\`${flag} | ${Number(r.n).toLocaleString()} |\n`;
    }
    if (p.enumOrCommentForbidsFE) {
      md += `\n> Schema/enum says FE is forbidden: ${p.forbidsReason}.`;
      if (p.feRows > 0) {
        md += ` **Found ${p.feRows.toLocaleString()} FE rows — this is a schema-vs-data mismatch.**`;
      } else {
        md += ` Found 0 FE rows ✓.`;
      }
      md += `\n`;
    }
    md += `\n`;
  }

  md += `## Pass C — orphan check on FE-ref-bearing tables\n\n`;
  md += `For each table where Pass B confirmed at least one \`entity_type='financial_entity'\` row, count rows whose \`entity_id\` does not resolve to an extant \`financial_entities.id\`.\n\n`;
  if (passC.length === 0) {
    md += `No FE-ref-bearing tables to check.\n\n`;
  } else {
    md += `| table | ref column | type | FE refs | orphans |\n|---|---|---|--:|--:|\n`;
    for (const r of passC) {
      md += `| \`${r.table}\` | \`${r.refColumn}\` | ${r.refColumnType.toUpperCase()} | ${r.totalFERefs.toLocaleString()} | ${r.orphans.toLocaleString()} |\n`;
    }
    md += `\n`;
  }

  md += `## Interpretation guide\n\n`;
  md += `**Real FE-rewrite surface** = the set of tables in Pass C where \`FE refs > 0\`. These are the tables a financial-entity merge has to rewrite (or delete-then-recompute) when collapsing two FE rows into one.\n\n`;
  md += `**Mismatch rows** = data exists for a value that the schema/enum/comment says shouldn't exist. If \`mismatches\` is non-empty, a writer is creating refs the constraint should prevent — file a hygiene FIX to tighten the constraint and clean the latent rows.\n\n`;
  md += `**Orphans** = rows that survived FE deletes/merges without their ref column getting rewritten. The original FIX-320 sweep cleaned \`entity_tags\` orphans; non-zero counts here mean a new merge path is leaking.\n\n`;
  md += `**Unconstrained TEXT discriminators** (Pass A "none (free TEXT)") are drift risk — they don't fail loudly at INSERT time. Worth a constraint-tightening FIX if any such column carries FE refs that need protecting.\n`;

  fs.writeFileSync(outPath, md);
  console.log(`\nWrote audit report: ${outPath}`);

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
