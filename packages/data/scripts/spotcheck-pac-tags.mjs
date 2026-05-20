// One-shot: count distinct PACs with industry tags on local vs prod, using
// .env.local.dev and .env.local.prod directly so we don't toggle .env.local.
// Used for FIX-231 spot-check; safe to delete after.
//
// Run:  pnpm tsx packages/data/scripts/spotcheck-pac-tags.mjs
//   (the workspace's @supabase/supabase-js resolves through the @civitics/db
//    workspace package — node alone can't resolve it.)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdminClientWith } from "@civitics/db";

function parseEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function findRepoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(resolve(dir, ".env.local.dev"), "utf8");
      readFileSync(resolve(dir, ".env.local.prod"), "utf8");
      return dir;
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Could not locate .env.local.dev / .env.local.prod");
}

const REPO = findRepoRoot();
const dev  = parseEnv(resolve(REPO, ".env.local.dev"));
const prod = parseEnv(resolve(REPO, ".env.local.prod"));

async function fetchAll(client, table, sel, builder) {
  const SIZE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = client.from(table).select(sel).range(from, from + SIZE - 1);
    q = builder(q);
    const { data, error } = await q;
    if (error) { console.error(`[${table}]`, error.message); break; }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < SIZE) break;
    from += SIZE;
  }
  return out;
}

async function countTaggedPacs(label, url, key) {
  const c = createAdminClientWith(url, key);
  const pacs = await fetchAll(c, "financial_entities", "id, fec_committee_id",
    q => q.in("entity_type", ["pac", "party_committee"]));
  const pacIds = new Set(pacs.filter(p => p.fec_committee_id).map(p => p.id));
  const tags = await fetchAll(c, "entity_tags", "entity_id",
    q => q.eq("entity_type", "financial_entity").eq("tag_category", "industry"));
  const taggedIds = new Set(tags.map(t => t.entity_id));
  let taggedPacs = 0;
  for (const id of pacIds) if (taggedIds.has(id)) taggedPacs++;
  console.log(`${label.padEnd(6)} ${url}`);
  console.log(`  PACs (with fec_committee_id): ${pacIds.size}`);
  console.log(`  industry tag rows on financial_entity: ${tags.length}`);
  console.log(`  PACs tagged with industry: ${taggedPacs}`);
  return { pacs: pacIds.size, taggedPacs, totalTags: tags.length };
}

const localR = await countTaggedPacs("LOCAL", dev.NEXT_PUBLIC_SUPABASE_URL,  dev.SUPABASE_SECRET_KEY);
const prodR  = await countTaggedPacs("PROD ", prod.NEXT_PUBLIC_SUPABASE_URL, prod.SUPABASE_SECRET_KEY);

console.log("\n=== Verdict ===");
console.log(`local taggedPacs=${localR.taggedPacs}  prod taggedPacs=${prodR.taggedPacs}`);
if (prodR.taggedPacs >= localR.taggedPacs) {
  console.log("PASS — prod >= local. Safe to archive copy-pac-tags-to-prod.ts");
} else {
  console.log("FAIL — prod is missing tags. Re-run the script before archiving.");
}
