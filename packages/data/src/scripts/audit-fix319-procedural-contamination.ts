/**
 * FIX-319 Part 1 — proposals.procedural_contamination = 1865 rows breakdown.
 *
 * Investigation only. Read-only against prod. Categorizes the 1865 rows
 * flagged by the audit check (title ~* '^on ' OR title ~* ' v\.') so we can
 * choose Branch A (audit overscoped), Branch B (real ingest leakage), or
 * Branch C (mix).
 *
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local.prod \
 *     src/scripts/audit-fix319-procedural-contamination.ts
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return "";
  if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const password = process.env.SUPABASE_DB_PASSWORD;
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!password || !m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function header(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function main(): Promise<void> {
  const dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }

  console.log(`target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // ----- Q1: total count by (source, type) -----
    header("Q1 — count by (metadata->>'source', type)");
    const q1 = await client.query<{ source: string; type: string; n: string }>(
      `SELECT
         COALESCE(metadata->>'source', '(null)') AS source,
         COALESCE(type::text, '(null)')          AS type,
         COUNT(*)                                AS n
       FROM proposals
       WHERE title ~* '^on '
          OR title ~* ' v\\.'
       GROUP BY 1, 2
       ORDER BY COUNT(*) DESC`,
    );
    let total = 0;
    for (const r of q1.rows) {
      total += Number(r.n);
      console.log(`  ${r.source.padEnd(28)} ${r.type.padEnd(20)} ${String(r.n).padStart(6)}`);
    }
    console.log(`  -------------------------------- TOTAL ${String(total).padStart(6)}`);

    // ----- Q3: regex-arm split (run before Q2 so the summary is visible early) -----
    header("Q3 — regex-arm split");
    const q3 = await client.query<{ on_only: string; vdot_only: string; both: string }>(
      `SELECT
         SUM(CASE WHEN title ~* '^on ' AND title !~* ' v\\.' THEN 1 ELSE 0 END) AS on_only,
         SUM(CASE WHEN title ~* ' v\\.' AND title !~* '^on ' THEN 1 ELSE 0 END) AS vdot_only,
         SUM(CASE WHEN title ~* '^on ' AND title ~* ' v\\.'  THEN 1 ELSE 0 END) AS both
       FROM proposals
       WHERE title ~* '^on ' OR title ~* ' v\\.'`,
    );
    const r3 = q3.rows[0];
    console.log(`  on_only   (title starts with "On ", no " v.")     ${r3.on_only}`);
    console.log(`  vdot_only (contains " v.", no "On " prefix)        ${r3.vdot_only}`);
    console.log(`  both                                                ${r3.both}`);

    // ----- Q4: ` v. ` arm by jurisdiction type + source -----
    header("Q4 — ' v.' arm by (jurisdictions.type, source)");
    const q4 = await client.query<{ juris_type: string; source: string; n: string }>(
      `SELECT
         COALESCE(j.type::text, '(null)') AS juris_type,
         COALESCE(p.metadata->>'source', '(null)') AS source,
         COUNT(*) AS n
       FROM proposals p
       LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.title ~* ' v\\.'
       GROUP BY 1, 2
       ORDER BY COUNT(*) DESC`,
    );
    for (const r of q4.rows) {
      console.log(`  ${r.juris_type.padEnd(18)} ${r.source.padEnd(28)} ${String(r.n).padStart(6)}`);
    }

    // ----- Q4b: ` ^on ` arm by jurisdiction type + source -----
    header("Q4b — '^on ' arm by (jurisdictions.type, source)");
    const q4b = await client.query<{ juris_type: string; source: string; n: string }>(
      `SELECT
         COALESCE(j.type::text, '(null)') AS juris_type,
         COALESCE(p.metadata->>'source', '(null)') AS source,
         COUNT(*) AS n
       FROM proposals p
       LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.title ~* '^on '
       GROUP BY 1, 2
       ORDER BY COUNT(*) DESC`,
    );
    for (const r of q4b.rows) {
      console.log(`  ${r.juris_type.padEnd(18)} ${r.source.padEnd(28)} ${String(r.n).padStart(6)}`);
    }

    // ----- Q2: 5-row sample per (source, type) bucket -----
    header("Q2 — 5-row sample per (source, type) bucket");
    const q2 = await client.query<{
      source: string;
      type: string;
      id: string;
      title: string;
    }>(
      `WITH ranked AS (
         SELECT
           id,
           title,
           type::text AS type,
           COALESCE(metadata->>'source', '(null)') AS source,
           ROW_NUMBER() OVER (
             PARTITION BY metadata->>'source', type::text
             ORDER BY introduced_at DESC NULLS LAST, id
           ) AS rn
         FROM proposals
         WHERE title ~* '^on ' OR title ~* ' v\\.'
       )
       SELECT source, type, id, title FROM ranked
       WHERE rn <= 5
       ORDER BY source, type, rn`,
    );
    let cursor = "";
    for (const r of q2.rows) {
      const bucket = `${r.source} | ${r.type}`;
      if (bucket !== cursor) {
        console.log(`\n  [${bucket}]`);
        cursor = bucket;
      }
      const title = r.title.length > 110 ? r.title.slice(0, 107) + "..." : r.title;
      console.log(`    ${r.id.slice(0, 8)}  ${title}`);
    }

    // ----- Extra: any (source IS NULL) rows? if so what do they look like -----
    header("Extra — rows with metadata->>'source' IS NULL (if any in flag set)");
    const qx = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM proposals
        WHERE (title ~* '^on ' OR title ~* ' v\\.')
          AND metadata->>'source' IS NULL`,
    );
    console.log(`  count: ${qx.rows[0].n}`);
    if (Number(qx.rows[0].n) > 0) {
      const qxs = await client.query<{ id: string; type: string; title: string; jurisdiction_id: string | null }>(
        `SELECT id, type::text AS type, title, jurisdiction_id
           FROM proposals
          WHERE (title ~* '^on ' OR title ~* ' v\\.')
            AND metadata->>'source' IS NULL
          ORDER BY introduced_at DESC NULLS LAST
          LIMIT 10`,
      );
      for (const r of qxs.rows) {
        const title = r.title.length > 90 ? r.title.slice(0, 87) + "..." : r.title;
        console.log(`    ${r.id.slice(0, 8)}  type=${r.type.padEnd(10)} juris=${(r.jurisdiction_id ?? "(null)").slice(0, 8)}  ${title}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
