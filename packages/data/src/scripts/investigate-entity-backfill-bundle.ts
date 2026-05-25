/**
 * Investigation for FIX-312 + FIX-313 + FIX-245 + FIX-320 entity backfill bundle.
 *
 * Four scopes, all touching financial_entities dedup:
 *
 *   FIX-312 — Org-misclassified individual rows leaked pre-FIX-274. For each
 *     canonical_name where isLikelyOrgName() returns true AND there is BOTH an
 *     entity_type='individual' row AND at least one non-individual row, report
 *     the cluster shape and whether the non-individual row carries an
 *     external_source_refs binding (irs_990 / littlesis / sec_edgar /
 *     usaspending_recipient).
 *
 *   FIX-313 — LittleSis intra-source duplicates surfaced by LS's own
 *     `merged_into` field. Downloads the LittleSis entities dump (or reads
 *     from --ls-cache), scans for `merged_into`, builds the
 *     (loser_ls_id → winner_ls_id) map, then cross-references
 *     external_source_refs to find pairs where BOTH ls_ids are currently
 *     bound to financial_entities rows.
 *
 *   FIX-245 — Particle-prefix surname residue from FIX-244. Counts
 *     financial_entities individual rows whose donor_fingerprint starts with a
 *     space-separated `O`, `D`, `DE`, `ST`, or `MC` particle.
 *
 *   FIX-320 — Orphan entity_tags. Rows with entity_type='financial_entity'
 *     whose entity_id no longer resolves to a financial_entities row. Breaks
 *     down by generated_by ('rule' vs 'ai' vs 'manual') so the path (a) bare
 *     DELETE vs path (b) re-resolve decision is well informed.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:investigate-entity-backfill-bundle
 *   pnpm --filter @civitics/data data:investigate-entity-backfill-bundle -- --skip-ls
 *   pnpm --filter @civitics/data data:investigate-entity-backfill-bundle -- --ls-cache /tmp/ls-entities.json.gz
 *
 * Writes the audit markdown to docs/audits/<YYYY-MM-DD>-entity-backfill-bundle-{local|prod}.md
 * per the FIX-323 dated-output convention.
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "node:os";
import { isLikelyOrgName } from "../pipelines/fec-bulk/indiv";
import {
  downloadAndFingerprint,
  LITTLESIS_ENTITIES_URL,
  safeUnlink,
  streamGzipJson,
} from "../pipelines/littlesis/util";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  skipLs: boolean;
  lsCache: string | null;
  keepDump: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { skipLs: false, lsCache: null, keepDump: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-ls") out.skipLs = true;
    else if (a === "--keep-dump") out.keepDump = true;
    else if (a === "--ls-cache") out.lsCache = argv[++i] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB connection — same pattern as investigate-officials-casing-dupes.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgMixCluster {
  canonical_name: string;
  indiv_ids:      string[];
  non_indiv_ids:  string[];
  // Per non-individual id, does it carry any non-FEC external_source_refs binding?
  non_indiv_has_xsr: boolean[];
  non_indiv_types:   string[];
}

interface ParticleRow {
  donor_fingerprint: string;
  canonical_name:    string;
  cnt:               number;
}

interface OrphanTagRow {
  id:           string;
  entity_id:    string;
  tag:          string;
  tag_category: string;
  display_label: string;
  generated_by: string;
  metadata:     Record<string, unknown> | null;
}

interface LsMergedPair {
  loser_ls_id:  number;
  winner_ls_id: number;
  loser_name:   string;
  winner_name:  string | null; // only known if winner entity also appears in dump
}

// ---------------------------------------------------------------------------
// FIX-312 — org-misclassified individual cluster scan
// ---------------------------------------------------------------------------

async function scopeFix312(client: Client): Promise<OrgMixCluster[]> {
  // Pull all canonicals with mixed entity types; filter in JS with the real
  // isLikelyOrgName() so the heuristic stays single-sourced (no SQL drift).
  const rs = await client.query<{
    canonical_name: string;
    indiv_ids:     string[];
    non_indiv_ids: string[];
    non_indiv_types: string[];
  }>(`
    WITH per_canonical AS (
      SELECT
        canonical_name,
        array_agg(id::text)
          FILTER (WHERE entity_type = 'individual')                AS indiv_ids,
        array_agg(id::text)
          FILTER (WHERE entity_type <> 'individual')               AS non_indiv_ids,
        array_agg(entity_type)
          FILTER (WHERE entity_type <> 'individual')               AS non_indiv_types
      FROM public.financial_entities
      WHERE canonical_name IS NOT NULL AND canonical_name <> ''
      GROUP BY canonical_name
    )
    SELECT canonical_name, indiv_ids, non_indiv_ids, non_indiv_types
      FROM per_canonical
     WHERE coalesce(array_length(indiv_ids, 1), 0)     >= 1
       AND coalesce(array_length(non_indiv_ids, 1), 0) >= 1
  `);

  // Filter to canonicals matching isLikelyOrgName.
  const candidates = rs.rows.filter((r) => isLikelyOrgName(r.canonical_name));
  if (candidates.length === 0) return [];

  // For each candidate cluster, check whether each non-individual id has a
  // non-FEC external_source_refs binding.
  const allNonIndivIds = candidates.flatMap((c) => c.non_indiv_ids);
  const xsrSet = new Set<string>();
  if (allNonIndivIds.length > 0) {
    const xsr = await client.query<{ entity_id: string }>(
      `SELECT DISTINCT entity_id::text
         FROM public.external_source_refs
        WHERE entity_type = 'financial_entity'
          AND source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient')
          AND entity_id::text = ANY($1::text[])`,
      [allNonIndivIds],
    );
    for (const row of xsr.rows) xsrSet.add(row.entity_id);
  }

  return candidates.map((c) => ({
    canonical_name: c.canonical_name,
    indiv_ids:      c.indiv_ids,
    non_indiv_ids:  c.non_indiv_ids,
    non_indiv_has_xsr: c.non_indiv_ids.map((id) => xsrSet.has(id)),
    non_indiv_types: c.non_indiv_types,
  }));
}

// ---------------------------------------------------------------------------
// FIX-313 — LittleSis merged_into scan
// ---------------------------------------------------------------------------

async function ensureLsDump(lsCache: string | null, keepDump: boolean): Promise<string | null> {
  if (lsCache) {
    if (!fs.existsSync(lsCache)) {
      console.warn(`  --ls-cache ${lsCache} does not exist — downloading fresh.`);
    } else {
      console.log(`  Using LS cache: ${lsCache}`);
      return lsCache;
    }
  }
  const dest = path.join(tmpdir(), `littlesis-entities-investigate-${process.pid}.json.gz`);
  console.log(`  Downloading LittleSis entities dump to ${dest} ...`);
  const dl = await downloadAndFingerprint(LITTLESIS_ENTITIES_URL, dest);
  console.log(`    ${(dl.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${dl.sha256.slice(0, 12)}…`);
  if (!keepDump) {
    // Schedule unlink on process exit so the caller can re-use the dump
    // mid-run (FIX-313 scan happens once); if --keep-dump is passed, leave it.
  }
  return dest;
}

async function scopeFix313(
  client: Client,
  dumpPath: string,
): Promise<{
  totalScanned:     number;
  withMergedInto:   number;
  fieldName:        string | null;
  samplePairs:      LsMergedPair[];
  pairsBothBound:   LsMergedPair[];
  sampleRecordKeys: string[];
}> {
  // Stream the dump once. For each entity, record its id + name + any
  // merged_into-shaped field. The field is named `merged_into` per LS docs
  // but we also probe a couple of alternates seen in older API responses.
  let totalScanned = 0;
  let withMergedInto = 0;
  let detectedField: string | null = null;
  const pairs: LsMergedPair[] = [];
  const idToName = new Map<number, string>();
  let sampleRecordKeys: string[] = [];

  const CANDIDATE_FIELDS = ["merged_into", "merged_id", "merged"];

  for await (const raw of streamGzipJson<Record<string, unknown>>(dumpPath)) {
    totalScanned++;
    if (totalScanned === 1) {
      sampleRecordKeys = Object.keys(raw).sort();
    }
    const id = typeof raw["id"] === "number" ? (raw["id"] as number) : null;
    const name = typeof raw["name"] === "string" ? (raw["name"] as string) : "";
    if (id !== null) idToName.set(id, name);
    for (const f of CANDIDATE_FIELDS) {
      const v = raw[f];
      if (v !== null && v !== undefined && (typeof v === "number" || typeof v === "string")) {
        if (!detectedField) detectedField = f;
        const winnerId = Number(v);
        if (Number.isFinite(winnerId) && id !== null && winnerId !== id) {
          withMergedInto++;
          pairs.push({
            loser_ls_id:  id,
            winner_ls_id: winnerId,
            loser_name:   name,
            winner_name:  null,
          });
        }
        break;
      }
    }
    if (totalScanned % 100_000 === 0) {
      console.log(`    … LS scanned ${totalScanned.toLocaleString()} (merged_into=${withMergedInto.toLocaleString()})`);
    }
  }

  // Resolve winner names from the in-memory id→name map.
  for (const p of pairs) {
    p.winner_name = idToName.get(p.winner_ls_id) ?? null;
  }

  // Now cross-reference our DB: which of these pairs have BOTH ls_ids bound
  // to a financial_entities row via external_source_refs?
  const allIds = Array.from(new Set(pairs.flatMap((p) => [p.loser_ls_id, p.winner_ls_id]))).map(String);
  const bound = new Set<string>();
  if (allIds.length > 0) {
    // Chunked IN — LS pair count may be in the thousands.
    const CHUNK = 1000;
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const slice = allIds.slice(i, i + CHUNK);
      const rs = await client.query<{ external_id: string }>(
        `SELECT DISTINCT external_id
           FROM public.external_source_refs
          WHERE entity_type = 'financial_entity'
            AND source = 'littlesis'
            AND external_id = ANY($1::text[])`,
        [slice],
      );
      for (const r of rs.rows) bound.add(r.external_id);
    }
  }
  const pairsBothBound = pairs.filter(
    (p) => bound.has(String(p.loser_ls_id)) && bound.has(String(p.winner_ls_id)),
  );

  return {
    totalScanned,
    withMergedInto,
    fieldName: detectedField,
    samplePairs: pairs.slice(0, 20),
    pairsBothBound,
    sampleRecordKeys,
  };
}

// ---------------------------------------------------------------------------
// FIX-245 — particle-prefix surname residue
// ---------------------------------------------------------------------------

async function scopeFix245(client: Client): Promise<{ total: number; sample: ParticleRow[] }> {
  // Match the bullet's regex: ^[OD]\s   OR   ^(DE|ST|MC)\s
  // in donor_fingerprint, which holds the normalized name + "|" + zip5.
  const rs = await client.query<{
    donor_fingerprint: string;
    canonical_name:    string;
    cnt:               string;
  }>(`
    SELECT donor_fingerprint,
           canonical_name,
           1::text AS cnt
      FROM public.financial_entities
     WHERE entity_type = 'individual'
       AND donor_fingerprint IS NOT NULL
       AND (donor_fingerprint ~ '^[OD] '
         OR donor_fingerprint ~ '^(DE|ST|MC) ')
     ORDER BY canonical_name
     LIMIT 100
  `);
  const totalRs = await client.query<{ n: string }>(`
    SELECT count(*)::text AS n
      FROM public.financial_entities
     WHERE entity_type = 'individual'
       AND donor_fingerprint IS NOT NULL
       AND (donor_fingerprint ~ '^[OD] '
         OR donor_fingerprint ~ '^(DE|ST|MC) ')
  `);
  return {
    total: Number(totalRs.rows[0]?.n ?? 0),
    sample: rs.rows.map((r) => ({
      donor_fingerprint: r.donor_fingerprint,
      canonical_name:    r.canonical_name,
      cnt:               Number(r.cnt),
    })),
  };
}

// ---------------------------------------------------------------------------
// FIX-320 — orphan entity_tags
// ---------------------------------------------------------------------------

async function scopeFix320(client: Client): Promise<{
  total:        number;
  byGeneratedBy: Array<{ generated_by: string; n: number }>;
  sample:       OrphanTagRow[];
}> {
  const rs = await client.query<OrphanTagRow>(`
    SELECT et.id::text          AS id,
           et.entity_id::text   AS entity_id,
           et.tag,
           et.tag_category,
           et.display_label,
           et.generated_by,
           et.metadata
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_entities fe
          WHERE fe.id = et.entity_id
       )
     ORDER BY et.generated_by, et.tag_category, et.tag
     LIMIT 50
  `);
  const totalRs = await client.query<{ n: string }>(`
    SELECT count(*)::text AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_entities fe
          WHERE fe.id = et.entity_id
       )
  `);
  const breakdownRs = await client.query<{ generated_by: string; n: string }>(`
    SELECT et.generated_by, count(*)::text AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_entities fe
          WHERE fe.id = et.entity_id
       )
     GROUP BY et.generated_by
     ORDER BY count(*) DESC
  `);
  return {
    total: Number(totalRs.rows[0]?.n ?? 0),
    byGeneratedBy: breakdownRs.rows.map((r) => ({
      generated_by: r.generated_by,
      n:            Number(r.n),
    })),
    sample: rs.rows,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  const dbUrl =
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

  // ── FIX-312 ─────────────────────────────────────────────────────────────
  console.log("==> FIX-312: org-misclassified individual cluster scan");
  const fix312 = await scopeFix312(client);
  console.log(`    ${fix312.length} (canonical, has-org-row, has-individual-row) tuples`);
  for (const c of fix312.slice(0, 10)) {
    const xsrCount = c.non_indiv_has_xsr.filter(Boolean).length;
    console.log(
      `      ${c.canonical_name.padEnd(50)} indiv=${c.indiv_ids.length} non-indiv=${c.non_indiv_ids.length} types=${[...new Set(c.non_indiv_types)].join("/")} xsr=${xsrCount}/${c.non_indiv_ids.length}`,
    );
  }
  const allHaveXsr = fix312.every((c) => c.non_indiv_has_xsr.some(Boolean));
  const fix312GateMet = fix312.length < 500 && allHaveXsr && fix312.length > 0;
  console.log(`    GATE FIX-312: tuples<500 (${fix312.length}<500=${fix312.length < 500}) && every tuple has xsr (${allHaveXsr}) → SHIP=${fix312GateMet}`);
  console.log("");

  // ── FIX-313 ─────────────────────────────────────────────────────────────
  let fix313: Awaited<ReturnType<typeof scopeFix313>> | null = null;
  if (args.skipLs) {
    console.log("==> FIX-313: SKIPPED (--skip-ls)\n");
  } else {
    console.log("==> FIX-313: LittleSis merged_into scan");
    const dumpPath = await ensureLsDump(args.lsCache, args.keepDump);
    if (dumpPath) {
      fix313 = await scopeFix313(client, dumpPath);
      console.log(`    Scanned ${fix313.totalScanned.toLocaleString()} LS entities; field detected: ${fix313.fieldName ?? "(none)"}`);
      console.log(`    Records with non-self merged_into: ${fix313.withMergedInto.toLocaleString()}`);
      console.log(`    Pairs where BOTH ls_ids bound to FE rows: ${fix313.pairsBothBound.length.toLocaleString()}`);
      console.log(`    First record's keys: ${fix313.sampleRecordKeys.join(", ")}`);
      if (!args.keepDump && !args.lsCache) safeUnlink(dumpPath);
    }
    const fix313GateMet =
      fix313 !== null &&
      fix313.fieldName !== null &&
      fix313.pairsBothBound.length >= 100;
    console.log(`    GATE FIX-313: merged_into field present (${fix313?.fieldName ?? "no"}) && bound-pair count >= 100 (${fix313?.pairsBothBound.length ?? 0}>=100) → SHIP=${fix313GateMet}`);
    console.log("");
  }

  // ── FIX-245 ─────────────────────────────────────────────────────────────
  console.log("==> FIX-245: particle-prefix surname residue scan");
  const fix245 = await scopeFix245(client);
  console.log(`    ${fix245.total} rows match ^[OD]\\s or ^(DE|ST|MC)\\s in donor_fingerprint`);
  console.log("");

  // ── FIX-320 ─────────────────────────────────────────────────────────────
  console.log("==> FIX-320: orphan entity_tags scan");
  const fix320 = await scopeFix320(client);
  console.log(`    ${fix320.total} orphan entity_tags rows (entity_type='financial_entity')`);
  for (const b of fix320.byGeneratedBy) {
    console.log(`      generated_by=${b.generated_by}: ${b.n}`);
  }
  const handCuratedCount = fix320.byGeneratedBy
    .filter((b) => b.generated_by === "manual")
    .reduce((s, b) => s + b.n, 0);
  const fix320GatePathA = handCuratedCount <= 10;
  console.log(`    GATE FIX-320: manual count <= 10 (${handCuratedCount}<=10) → PATH=${fix320GatePathA ? "(a) bare DELETE" : "(b) re-resolve required"}`);
  console.log("");

  // ── Write audit markdown ────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const suffix = isLocal ? "local" : "prod";
  const outPath = path.resolve(
    path.join(
      __dirname,
      `../../../../docs/audits/${today}-entity-backfill-bundle-${suffix}.md`,
    ),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let md = "";
  md += `# Entity backfill bundle investigation — ${today} (${suffix})\n\n`;
  md += `Generated by \`packages/data/src/scripts/investigate-entity-backfill-bundle.ts\`.\n`;
  md += `DB host: \`${host}\`.\n\n`;
  md += `Bundle: FIX-312 (org-misclassified indiv merge) + FIX-313 (LittleSis merged_into merge) + FIX-245 (particle-prefix tighten) + FIX-320 (orphan entity_tags cleanup).\n\n`;

  // FIX-312
  md += `## FIX-312 — org-misclassified individual cluster scan\n\n`;
  md += `Clusters where canonical_name matches \`isLikelyOrgName()\` AND has both an \`entity_type='individual'\` row and a non-individual row.\n\n`;
  md += `- Total qualifying tuples: **${fix312.length}**\n`;
  md += `- Every tuple has a non-individual row with non-FEC external_source_refs binding: **${allHaveXsr}**\n`;
  md += `- **Gate**: ship merge if tuples < 500 AND every tuple has xsr binding → **${fix312GateMet ? "SHIP" : "DEFER"}**\n\n`;
  if (fix312.length > 0) {
    md += `Top 20 by indiv row count:\n\n`;
    md += `| canonical_name | indiv_ids | non_indiv types | xsr/N |\n`;
    md += `|---|--:|---|---|\n`;
    for (const c of fix312
      .sort((a, b) => b.indiv_ids.length - a.indiv_ids.length)
      .slice(0, 20)) {
      const xsr = c.non_indiv_has_xsr.filter(Boolean).length;
      md += `| \`${c.canonical_name.replace(/\|/g, "\\|")}\` | ${c.indiv_ids.length} | ${[...new Set(c.non_indiv_types)].join("/")} | ${xsr}/${c.non_indiv_ids.length} |\n`;
    }
    md += `\n`;
  }

  // FIX-313
  md += `## FIX-313 — LittleSis merged_into scan\n\n`;
  if (args.skipLs || !fix313) {
    md += `Skipped this run (\`--skip-ls\`). Re-run without the flag to populate.\n\n`;
  } else {
    md += `- LS entities scanned: **${fix313.totalScanned.toLocaleString()}**\n`;
    md += `- \`merged_into\`-shape field detected: \`${fix313.fieldName ?? "(none)"}\`\n`;
    md += `- Records with non-self merged value: **${fix313.withMergedInto.toLocaleString()}**\n`;
    md += `- Pairs where BOTH ls_ids bound to FE rows on this env: **${fix313.pairsBothBound.length.toLocaleString()}**\n`;
    md += `- First record's top-level keys (for shape audit): \`${fix313.sampleRecordKeys.join(", ")}\`\n`;
    const gate =
      fix313.fieldName !== null && fix313.pairsBothBound.length >= 100;
    md += `- **Gate**: ship merge if field present AND bound-pair count >= 100 → **${gate ? "SHIP" : "DEFER"}**\n\n`;
    if (fix313.pairsBothBound.length > 0) {
      md += `First 20 bound pairs (BOTH ls_ids resolve to FE rows):\n\n`;
      md += `| loser_ls_id | loser_name | winner_ls_id | winner_name |\n`;
      md += `|--:|---|--:|---|\n`;
      for (const p of fix313.pairsBothBound.slice(0, 20)) {
        md += `| ${p.loser_ls_id} | ${p.loser_name} | ${p.winner_ls_id} | ${p.winner_name ?? "?"} |\n`;
      }
      md += `\n`;
    } else if (fix313.samplePairs.length > 0) {
      md += `First 20 dump-level pairs (not necessarily bound on this env):\n\n`;
      md += `| loser_ls_id | loser_name | winner_ls_id | winner_name |\n`;
      md += `|--:|---|--:|---|\n`;
      for (const p of fix313.samplePairs) {
        md += `| ${p.loser_ls_id} | ${p.loser_name} | ${p.winner_ls_id} | ${p.winner_name ?? "?"} |\n`;
      }
      md += `\n`;
    }
  }

  // FIX-245
  md += `## FIX-245 — particle-prefix surname residue\n\n`;
  md += `- Total \`entity_type='individual'\` rows whose \`donor_fingerprint\` starts with \`O \` / \`D \` / \`DE \` / \`ST \` / \`MC \`: **${fix245.total}**\n`;
  md += `- Bullet estimate: ~60. (Always deterministic — ships regardless.)\n\n`;
  if (fix245.sample.length > 0) {
    md += `First 100 samples:\n\n`;
    md += `| donor_fingerprint | canonical_name |\n`;
    md += `|---|---|\n`;
    for (const r of fix245.sample) {
      md += `| \`${r.donor_fingerprint.replace(/\|/g, "\\|")}\` | \`${r.canonical_name.replace(/\|/g, "\\|")}\` |\n`;
    }
    md += `\n`;
  }

  // FIX-320
  md += `## FIX-320 — orphan entity_tags\n\n`;
  md += `- Total orphans (entity_type='financial_entity', entity_id missing from financial_entities): **${fix320.total}**\n`;
  md += `- Breakdown by \`generated_by\`:\n\n`;
  for (const b of fix320.byGeneratedBy) {
    md += `  - \`${b.generated_by}\`: **${b.n}**\n`;
  }
  md += `\n- Hand-curated (\`generated_by='manual'\`) count: **${handCuratedCount}**\n`;
  md += `- **Gate**: path (a) bare DELETE if manual count <= 10 → **${fix320GatePathA ? "PATH (a)" : "PATH (b)"}**\n\n`;
  if (fix320.sample.length > 0) {
    md += `First 50 orphan samples:\n\n`;
    md += `| generated_by | tag_category | tag | display_label | entity_id |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const r of fix320.sample) {
      md += `| ${r.generated_by} | ${r.tag_category} | \`${r.tag}\` | ${r.display_label} | \`${r.entity_id}\` |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(outPath, md);
  console.log(`Wrote audit report: ${outPath}`);

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
