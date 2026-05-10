/**
 * One-shot: copy AI-generated PAC industry tags from local → prod, mapping
 * entity_id via fec_committee_id (UUIDs differ between environments).
 *
 * Used to avoid re-burning AI credits draining the same PAC tag queue against
 * prod after the local drain (FIX-179). Idempotent — safe to re-run; conflicts
 * are upserted in place.
 *
 * Skips:
 *   - tags whose entity_id is not a current PAC (orphans from prior schema work)
 *   - tags whose PAC has no fec_committee_id (can't bridge envs)
 *   - tags whose fec_committee_id has no prod counterpart
 *
 * Conflict key: (entity_type, entity_id, tag, tag_category)
 *
 * Run from packages/data:
 *   pnpm tsx src/scripts/copy-pac-tags-to-prod.ts --dry-run
 *   pnpm tsx src/scripts/copy-pac-tags-to-prod.ts
 */
import { createAdminClientWith } from "@civitics/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnv(path: string): Record<string,string> {
  const out: Record<string,string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Walk up from cwd looking for the repo root (the dir containing both env templates).
function findRepoRoot(): string {
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
  throw new Error("Could not locate .env.local.dev / .env.local.prod relative to cwd");
}

const REPO = findRepoRoot();
const dev  = parseEnv(resolve(REPO, ".env.local.dev"));
const prod = parseEnv(resolve(REPO, ".env.local.prod"));

const DRY_RUN = process.argv.includes("--dry-run");

const local = createAdminClientWith(dev.NEXT_PUBLIC_SUPABASE_URL,  dev.SUPABASE_SECRET_KEY);
const prdb  = createAdminClientWith(prod.NEXT_PUBLIC_SUPABASE_URL, prod.SUPABASE_SECRET_KEY);

console.log(`mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
console.log(`local: ${dev.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`prod:  ${prod.NEXT_PUBLIC_SUPABASE_URL}`);

async function fetchAll<T>(client: any, table: string, sel: string, builder: (q: any) => any): Promise<T[]> {
  const SIZE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    let q = client.from(table).select(sel).range(from, from + SIZE - 1);
    q = builder(q);
    const { data, error } = await q;
    if (error) { console.error(error); break; }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < SIZE) break;
    from += SIZE;
  }
  return out;
}

type TagRow = {
  entity_id: string;
  entity_type: string;
  tag: string;
  tag_category: string;
  display_label: string;
  display_icon: string | null;
  visibility: string;
  generated_by: string;
  confidence: number | null;
  ai_model: string | null;
  pipeline_version: string | null;
  metadata: any;
};

(async () => {
  // 1. Local current PACs + fec_committee_id
  const localPacs = await fetchAll<{id:string; fec_committee_id:string|null}>(
    local, "financial_entities", "id, fec_committee_id",
    q => q.in("entity_type", ["pac","party_committee"]),
  );
  const localIdToFEC = new Map<string,string>();
  for (const fe of localPacs) {
    if (fe.fec_committee_id) localIdToFEC.set(fe.id, fe.fec_committee_id);
  }
  console.log(`Local PACs with fec_committee_id: ${localIdToFEC.size}/${localPacs.length}`);

  // 2. Prod PACs by fec_committee_id
  const prodPacs = await fetchAll<{id:string; fec_committee_id:string|null}>(
    prdb, "financial_entities", "id, fec_committee_id",
    q => q.in("entity_type", ["pac","party_committee"]),
  );
  const fecToProdId = new Map<string,string>();
  for (const fe of prodPacs) {
    if (fe.fec_committee_id) fecToProdId.set(fe.fec_committee_id, fe.id);
  }
  console.log(`Prod  PACs with fec_committee_id: ${fecToProdId.size}/${prodPacs.length}`);

  // 3. All local AI-generated industry tags on current PACs
  const localPacIds = [...localIdToFEC.keys()];
  const localPacIdSet = new Set(localPacIds);
  const localTags = await fetchAll<TagRow>(
    local, "entity_tags",
    "entity_id, entity_type, tag, tag_category, display_label, display_icon, visibility, generated_by, confidence, ai_model, pipeline_version, metadata",
    q => q.eq("entity_type","financial_entity").eq("tag_category","industry"),
  );
  const tagsOnCurrentPacs = localTags.filter(t => localPacIdSet.has(t.entity_id));
  console.log(`Local industry tags on current PACs: ${tagsOnCurrentPacs.length} (skipping ${localTags.length - tagsOnCurrentPacs.length} orphan / non-PAC tags)`);

  // 4. Map each tag's entity_id from local → prod
  const remapped: TagRow[] = [];
  let unmappable = 0;
  for (const t of tagsOnCurrentPacs) {
    const fec = localIdToFEC.get(t.entity_id);
    if (!fec) { unmappable++; continue; }
    const prodId = fecToProdId.get(fec);
    if (!prodId) { unmappable++; continue; }
    remapped.push({ ...t, entity_id: prodId });
  }
  console.log(`Remapped to prod entity_ids: ${remapped.length} (${unmappable} unmappable)`);

  if (DRY_RUN) {
    console.log("\n[dry-run] Sample remapped row:");
    console.log(JSON.stringify(remapped[0], null, 2));
    console.log(`\n[dry-run] would upsert ${remapped.length} rows to prod entity_tags`);
    return;
  }

  // 5. Upsert in chunks. Conflict key is (entity_type, entity_id, tag, tag_category).
  const CHUNK = 200;
  let upserted = 0;
  let errors = 0;
  for (let i = 0; i < remapped.length; i += CHUNK) {
    const chunk = remapped.slice(i, i + CHUNK);
    const { error } = await prdb.from("entity_tags").upsert(chunk, {
      onConflict: "entity_type,entity_id,tag,tag_category",
      ignoreDuplicates: false,
    });
    if (error) {
      errors++;
      if (errors <= 3) console.error(`  chunk ${i}-${i+chunk.length} failed:`, error.message);
    } else {
      upserted += chunk.length;
    }
  }
  console.log(`\nUpserted ${upserted}/${remapped.length} rows to prod entity_tags`);
  if (errors > 0) console.error(`  ${errors} chunk(s) failed`);

  // 6. Post-write verification: count tagged PACs on prod
  const prodTagsAfter = await fetchAll<{entity_id:string}>(
    prdb, "entity_tags", "entity_id",
    q => q.eq("entity_type","financial_entity").eq("tag_category","industry"),
  );
  const prodTaggedSet = new Set(prodTagsAfter.map(r => r.entity_id));
  const prodPacIdSet = new Set(prodPacs.map(p => p.id));
  let prodTaggedPacs = 0;
  for (const id of prodPacIdSet) if (prodTaggedSet.has(id)) prodTaggedPacs++;
  console.log(`\nProd verification:`);
  console.log(`  PACs tagged on prod after upsert: ${prodTaggedPacs} / ${prodPacIdSet.size}`);
  console.log(`  Total industry tag rows on prod financial_entity: ${prodTagsAfter.length}`);
})().then(()=>setTimeout(()=>process.exit(0),300))
   .catch(e=>{console.error(e);process.exit(1);});
