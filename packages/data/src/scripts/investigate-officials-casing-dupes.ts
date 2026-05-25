/**
 * FIX-325 investigation script.
 *
 * Surfaces clusters of active `officials` rows whose `lower(trim(full_name))`
 * key collides — i.e., the same real person likely landed as multiple rows
 * because the ingest upsert key was case-sensitive on full_name OR because
 * multiple writers inserted the same person without coordination.
 *
 * Writes a markdown report under docs/audits/. The merge plan that consumes
 * this output is FIX-A (queued follow-up).
 *
 * Usage:
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local \
 *     src/scripts/investigate-officials-casing-dupes.ts
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) return "";
  // Local Docker — no password needed, fixed default.
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

interface ClusterRow {
  key:       string;
  n:         string;
  ids:       string[];
  variants:  string[];
  titles:    string[];
  tiers:     string[];
  sources:   string[];
}

interface SourceBreakdownRow {
  source_key: string;
  cluster_count: string;
  row_count: string;
}

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
  await client.connect();
  const host = new URL(cleanUrl).host;
  const isLocal = /127\.0\.0\.1|localhost/.test(host);
  console.log(`Connected to: ${host} (${isLocal ? "local" : "prod"})\n`);

  // ── 1. Cluster query ────────────────────────────────────────────────────
  const clusters = await client.query<ClusterRow>(`
    SELECT
      lower(trim(full_name))                       AS key,
      COUNT(*)::text                                AS n,
      array_agg(id::text  ORDER BY created_at ASC) AS ids,
      array_agg(DISTINCT full_name)                AS variants,
      array_agg(DISTINCT COALESCE(role_title, '<null>')) AS titles,
      array_agg(DISTINCT COALESCE(tier, '<null>'))       AS tiers,
      array_agg(DISTINCT key) FILTER (WHERE key IS NOT NULL) AS sources
    FROM officials,
         LATERAL jsonb_object_keys(COALESCE(source_ids, '{}'::jsonb)) AS key
    WHERE is_active = true
    GROUP BY 1
    HAVING COUNT(*) > 1
    ORDER BY n DESC, key
  `);

  const totalClusters = clusters.rowCount ?? 0;
  const totalDupeRows = clusters.rows.reduce((s, r) => s + Number(r.n), 0);
  console.log(`Total casing-dupe clusters: ${totalClusters.toLocaleString()}`);
  console.log(`Total dupe rows: ${totalDupeRows.toLocaleString()}\n`);

  if (totalClusters > 0) {
    console.log("Top 10 by cluster size:");
    for (const r of clusters.rows.slice(0, 10)) {
      console.log(`  ${r.n}× ${r.key}  (sources: ${r.sources.join(", ")})`);
    }
    console.log("");
  }

  // ── 2. Source-key breakdown ────────────────────────────────────────────
  // Which source_ids keys (congress_gov, openstates_id, fec_candidate_id,
  // plum_id, wikidata_id, congress_nomination_id, …) appear in the
  // dupe-cluster set? Drives the merge spec's per-source strategy.
  const sourceBreakdown = await client.query<SourceBreakdownRow>(`
    WITH dupe_clusters AS (
      SELECT lower(trim(full_name)) AS key
        FROM officials
       WHERE is_active = true
       GROUP BY 1
      HAVING COUNT(*) > 1
    ),
    dupe_rows AS (
      SELECT o.id, o.source_ids, lower(trim(o.full_name)) AS cluster_key
        FROM officials o
        JOIN dupe_clusters dc ON dc.key = lower(trim(o.full_name))
       WHERE o.is_active = true
    )
    SELECT
      source_key                                AS source_key,
      COUNT(DISTINCT dr.cluster_key)::text      AS cluster_count,
      COUNT(*)::text                            AS row_count
      FROM dupe_rows dr,
           LATERAL jsonb_object_keys(COALESCE(dr.source_ids, '{}'::jsonb)) AS source_key
     GROUP BY 1
     ORDER BY (COUNT(*))::int DESC
  `);

  console.log("Source-pipeline breakdown across dupe clusters:");
  for (const r of sourceBreakdown.rows) {
    console.log(`  ${r.source_key.padEnd(28)} ${r.cluster_count} clusters, ${r.row_count} rows`);
  }
  console.log("");

  // ── 3. Write markdown report ───────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const suffix = isLocal ? "-local" : "";
  const outPath = path.resolve(
    path.join(
      __dirname,
      `../../../../docs/audits/${today}-officials-casing-dupes${suffix}.md`
    )
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const top20 = clusters.rows.slice(0, 20);

  let md = "";
  md += `# Officials casing-dupe investigation — ${today}${isLocal ? " (local)" : ""}\n\n`;
  md += `Generated by \`packages/data/src/scripts/investigate-officials-casing-dupes.ts\`.\n`;
  md += `DB host: \`${host}\`. Feeds the FIX-A merge spec; ingest-side\n`;
  md += `normalization shipped in this PR closes the new-dupe inflow.\n\n`;
  md += `## Summary\n\n`;
  md += `- Active-row casing-dupe clusters: **${totalClusters.toLocaleString()}**\n`;
  md += `- Total dupe rows in those clusters: **${totalDupeRows.toLocaleString()}**\n\n`;

  md += `## Source-pipeline breakdown\n\n`;
  md += `| source_ids key | clusters touched | rows touched |\n`;
  md += `|---|--:|--:|\n`;
  for (const r of sourceBreakdown.rows) {
    md += `| \`${r.source_key}\` | ${r.cluster_count} | ${r.row_count} |\n`;
  }
  md += `\n`;

  md += `## Top 20 clusters by size\n\n`;
  md += `| key (lower(trim(full_name))) | n | variants | role_titles | tiers | source keys |\n`;
  md += `|---|--:|---|---|---|---|\n`;
  for (const r of top20) {
    const variants = r.variants.map(v => `\`${v.replace(/\|/g, "\\|")}\``).join("<br>");
    const titles   = r.titles.slice(0, 5).map(t => `\`${t.replace(/\|/g, "\\|")}\``).join("<br>");
    const tiers    = r.tiers.join(", ");
    const sources  = (r.sources ?? []).join(", ");
    md += `| \`${r.key.replace(/\|/g, "\\|")}\` | ${r.n} | ${variants} | ${titles} | ${tiers} | ${sources} |\n`;
  }
  md += `\n`;

  md += `## Notes\n\n`;
  md += `Cluster definition is \`lower(trim(full_name))\` only. Some clusters are\n`;
  md += `genuine namesakes (different people sharing a common name), especially\n`;
  md += `the candidate-heavy ones from FEC cn{yy}.zip ingest. The merge spec\n`;
  md += `(FIX-A) must therefore pick clusters whose internal rows share at\n`;
  md += `least one of: a stable external ID across rows, an overlapping\n`;
  md += `\`external_relationships\` neighborhood (shared edges in LittleSis),\n`;
  md += `or matching state + role family — not raw name match alone.\n\n`;
  md += `Per the FIX-325 prompt, clusters whose tier-array contains both\n`;
  md += `\`elected\` and \`candidate\` for **different real people** are\n`;
  md += `out-of-scope for FIX-A — those collide via the FIX-248 promotion\n`;
  md += `path, and merging them blind would conflate distinct identities.\n`;

  fs.writeFileSync(outPath, md);
  console.log(`Wrote audit report: ${outPath}`);

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
