/**
 * FIX-251 · LittleSis ingestion pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LittleSis attribution — CC-BY-SA 4.0
 *
 * Data ingested by this pipeline is sourced from LittleSis
 *   https://littlesis.org
 * a project of the Public Accountability Initiative, and is licensed under
 * the Creative Commons Attribution-ShareAlike 4.0 International license:
 *   https://creativecommons.org/licenses/by-sa/4.0/
 *
 * Any derivative dataset Civitics publishes that contains rows derived from
 * LittleSis (rows in external_relationships where source='littlesis', and
 * any entity_connections edge whose evidence_source='external_relationships'
 * traces back to a LittleSis row) MUST also be licensed CC-BY-SA 4.0 and
 * attribute LittleSis. See packages/data/src/pipelines/littlesis/README.md
 * for full attribution text and usage notes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pipeline shape:
 *   1. Download entities.json.gz + relationships.json.gz, SHA256 each.
 *   2. Freshness gate: skip if both fingerprints match pipeline_state.littlesis_state.
 *   3a. Stream entities once to collect the person sort keys this run can ask
 *       about (FIX-1159), so step 3b can bound what it holds in memory.
 *   3b. Build match index from existing Civitics rows (officials + financial_entities).
 *   4. P1: stream entities, match each → anchor map + ambiguous review queue.
 *   5. P2: stream relationships, collect 0-hop edges + identify 1-hop entity ids.
 *   6. P3: stream relationships, collect 2-hop edges connecting (anchor ∪ hop1).
 *   7. Materialize hop-1 financial_entities for any LittleSis id referenced by an edge.
 *   8. Upsert all edges into external_relationships.
 *   9. Persist fingerprints + complete sync log.
 *
 * Run:
 *   pnpm --filter @civitics/data data:littlesis
 *   pnpm --filter @civitics/data data:littlesis -- --force   # bypass freshness gate
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdminClient } from "@civitics/db";
import { completeSync, failSync, skipSync, startSync, type PipelineResult } from "../sync-log";

import {
  downloadAndFingerprint,
  getStoredFingerprint,
  LITTLESIS_ENTITIES_URL,
  LITTLESIS_RELATIONSHIPS_URL,
  safeUnlink,
  storeFingerprint,
  type LittleSisEntity,
  type LittleSisRelationship,
} from "./util";
import { buildMatchIndex, collectLittleSisPersonKeys } from "./matcher";
import { pass1AnchorMatch, pass2CollectEdges, pass3CollectEdges, type AnchorMatch } from "./expand";
import {
  preloadKnownLittleSisIds,
  upsertExternalRelationships,
  upsertHop1FinancialEntities,
  upsertReviewQueue,
  upsertSourceRefs,
  type EdgeResolveTarget,
} from "./writer";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runLittleSisPipeline(opts: { force?: boolean } = {}): Promise<PipelineResult> {
  console.log("\n=== LittleSis ingestion pipeline ===");

  const logId  = await startSync("littlesis");
  const db     = createAdminClient();
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
  const force  = opts.force ?? process.argv.includes("--force");

  const entPath = join(tmpdir(), `littlesis-entities-${process.pid}.json.gz`);
  const relPath = join(tmpdir(), `littlesis-relationships-${process.pid}.json.gz`);

  try {
    // ── Download + fingerprint ───────────────────────────────────────────
    console.log("  Downloading entities.json.gz...");
    const ent = await downloadAndFingerprint(LITTLESIS_ENTITIES_URL, entPath);
    console.log(`    ${(ent.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${ent.sha256.slice(0, 12)}…`);

    console.log("  Downloading relationships.json.gz...");
    const rel = await downloadAndFingerprint(LITTLESIS_RELATIONSHIPS_URL, relPath);
    console.log(`    ${(rel.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${rel.sha256.slice(0, 12)}…`);

    result.estimatedMb = +((ent.bytes + rel.bytes) / 1024 / 1024).toFixed(2);

    // ── Freshness gate ───────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = await getStoredFingerprint(db as any);
    if (!force && stored.entities_sha === ent.sha256 && stored.relationships_sha === rel.sha256) {
      console.log(`  Both dumps unchanged since ${stored.last_run_at ?? "first run"} — skipping.`);
      await skipSync(logId, "dumps_unchanged");
      return result;
    }
    if (force) console.log("  --force: bypassing freshness gate");
    else {
      const changedEnt = stored.entities_sha      !== ent.sha256;
      const changedRel = stored.relationships_sha !== rel.sha256;
      console.log(`  Dumps changed: entities=${changedEnt} relationships=${changedRel}`);
    }

    // ── Build match index + preload existing bindings ───────────────────
    //
    // FIX-1159 — two passes, and the order is load-bearing. The entities dump
    // is already on disk (downloaded above), so the set of person sort keys
    // this run can ever look up is known BEFORE the financial_entities walk.
    // Pass 1 collects that set; pass 2 keeps only individuals whose sort key is
    // in it. Unfiltered, the map held 2,551,270 keys and the build peaked at
    // 1,282 MB RSS on the prod clone — for a dump that asks about a few tens of
    // thousands of people.
    console.log("  Collecting LittleSis person sort keys from the entities dump...");
    const personKeys = await collectLittleSisPersonKeys(entPath);

    console.log("  Building match index from Civitics rows...");
    const idx = await buildMatchIndex(personKeys);
    console.log(
      `    officials lastname keys=${idx.officialsByLastName.size}` +
      `, persons sort-keys=${idx.personsBySortKey.size}` +
      `, orgs canonical=${idx.orgsByCanonical.size}`,
    );

    console.log("  Preloading existing LittleSis bindings from external_source_refs...");
    const known = await preloadKnownLittleSisIds(db);
    console.log(`    ${known.size} existing bindings`);

    // ── P1 ───────────────────────────────────────────────────────────────
    console.log("  P1: matching entities against Civitics...");
    const p1 = await pass1AnchorMatch(entPath, idx, known);
    console.log(
      `    entities=${p1.stats.entities_seen.toLocaleString()}` +
      ` high=${p1.stats.high_matches} medium=${p1.stats.medium_matches}` +
      ` queued=${p1.stats.queued} missed=${p1.stats.missed}`,
    );

    // ── P2 + P3 ──────────────────────────────────────────────────────────
    console.log("  P2: streaming relationships for 0-hop edges + 1-hop candidates...");
    const p2 = await pass2CollectEdges(relPath, p1.anchorMap, p1.byId);
    console.log(
      `    rels=${p2.rels_seen.toLocaleString()}` +
      ` cat5_skipped=${p2.rels_skipped_category}` +
      ` zero_hop=${p2.zeroHopEdges.length} hop1_set=${p2.hop1Set.size}`,
    );

    console.log("  P3: streaming relationships for 2-hop edges...");
    const p3 = await pass3CollectEdges(relPath, p1.anchorMap, p2.hop1Set);
    console.log(`    two_hop=${p3.twoHopEdges.length}`);

    // ── Materialize hop-1 financial_entities (only those referenced by an edge) ──
    const referencedHop1 = new Set<number>();
    for (const e of p2.zeroHopEdges) {
      if (!p1.anchorMap.has(e.entity1_id)) referencedHop1.add(e.entity1_id);
      if (!p1.anchorMap.has(e.entity2_id)) referencedHop1.add(e.entity2_id);
    }
    for (const e of p3.twoHopEdges) {
      if (!p1.anchorMap.has(e.entity1_id)) referencedHop1.add(e.entity1_id);
      if (!p1.anchorMap.has(e.entity2_id)) referencedHop1.add(e.entity2_id);
    }

    const hop1Entities: LittleSisEntity[] = [];
    for (const lsId of referencedHop1) {
      if (known.has(lsId)) continue;             // already bound from a prior run
      const ent = p1.byId.get(lsId);
      if (ent) hop1Entities.push(ent);
    }
    console.log(`  Materializing ${hop1Entities.length} hop-1 entities...`);
    const hop1Upsert = await upsertHop1FinancialEntities(hop1Entities);
    console.log(
      `    inserted=${hop1Upsert.inserted} matched=${hop1Upsert.matched}` +
      ` failed=${hop1Upsert.failed} rpcErrors=${hop1Upsert.rpcErrors}`,
    );
    result.inserted += hop1Upsert.inserted + hop1Upsert.matched;
    result.failed   += hop1Upsert.failed;

    // Bind the new hop-1 LittleSis ids to their financial_entity uuids.
    // FIX-280: matched-existing rows are stamped 'canonical_match' so the
    // metadata distinguishes RPC-resolved cross-source bindings from pure
    // hop-1 inserts.
    const bindings = [...hop1Upsert.idMap].map(([lsId, entity_id]) => ({
      lsId,
      entity_type: "financial_entity",
      entity_id,
      confidence: hop1Upsert.matchedLsIds.has(lsId) ? "canonical_match" : "hop1",
    }));

    // FIX-275: persist anchor matches (matchPerson/matchOrg returning
    // kind='high'|'medium') to external_source_refs. Pre-FIX-275 these were
    // resolved in-memory but never written back — every subsequent ingest
    // re-ran matchPerson against a moving target (the 'index built from
    // financial_entities at pipeline start' shape in matcher.ts), letting
    // newly-added FEC rows knock previously-bound LS ids back into the
    // queue/miss bucket. preloadKnownLittleSisIds reads what's persisted, so
    // without this write the binding never makes it across runs.
    //
    // `known` is the preloaded set (read from external_source_refs at the
    // start of this run); anchorMap = known ∪ matched-this-run. We only
    // upsert the difference — preloaded entries are already in the table.
    for (const [lsId, anchor] of p1.anchorMap) {
      if (known.has(lsId)) continue;
      bindings.push({
        lsId,
        entity_type: anchor.civitics_type,
        entity_id:   anchor.civitics_id,
        confidence:  anchor.confidence,
      });
    }

    const refs = await upsertSourceRefs(db, bindings);
    if (refs.failed > 0) console.warn(`    [refs] ${refs.failed} bindings failed`);

    // ── Resolver: lsId → (civitics_type, civitics_id) ────────────────────
    const resolver = new Map<number, EdgeResolveTarget & { confidence: "high" | "medium" }>();
    for (const [lsId, anchor] of p1.anchorMap) {
      resolver.set(lsId, { type: anchor.civitics_type, id: anchor.civitics_id, confidence: anchor.confidence });
    }
    for (const [lsId, uuid] of hop1Upsert.idMap) {
      if (!resolver.has(lsId)) resolver.set(lsId, { type: "financial_entity", id: uuid, confidence: "medium" });
    }

    // ── Build edge inputs + upsert ───────────────────────────────────────
    const edgeInputs = buildEdgeInputs([...p2.zeroHopEdges, ...p3.twoHopEdges], resolver);
    console.log(`  Upserting ${edgeInputs.length} external_relationships...`);
    const relUpsert = await upsertExternalRelationships(edgeInputs);
    console.log(`    inserted=${relUpsert.inserted} failed=${relUpsert.failed}`);
    result.inserted += relUpsert.inserted;
    result.failed   += relUpsert.failed;

    // ── Review queue ─────────────────────────────────────────────────────
    if (p1.ambiguous.length > 0) {
      console.log(`  Queueing ${p1.ambiguous.length} ambiguous entity matches for review...`);
      const queue = await upsertReviewQueue(p1.ambiguous);
      console.log(`    queued=${queue.inserted} failed=${queue.failed}`);
    }

    // ── Persist fingerprints ─────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storeFingerprint(db as any, ent.sha256, rel.sha256);

    await completeSync(logId, result);
    console.log(`\n  ✓ Done. inserted=${result.inserted} failed=${result.failed} estimated=${result.estimatedMb} MB`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failSync(logId, msg);
    throw err;
  } finally {
    safeUnlink(entPath);
    safeUnlink(relPath);
  }
}

// ---------------------------------------------------------------------------
// Edge input builder
// ---------------------------------------------------------------------------

function buildEdgeInputs(
  rels: LittleSisRelationship[],
  resolver: Map<number, EdgeResolveTarget & { confidence: "high" | "medium" }>,
): Array<{
  rel: LittleSisRelationship; from: EdgeResolveTarget; to: EdgeResolveTarget;
  match_confidence: "high" | "medium";
}> {
  const out: Array<{ rel: LittleSisRelationship; from: EdgeResolveTarget; to: EdgeResolveTarget; match_confidence: "high" | "medium" }> = [];
  for (const rel of rels) {
    const from = resolver.get(rel.entity1_id);
    const to   = resolver.get(rel.entity2_id);
    if (!from || !to) continue;
    // Endpoints with the same (type,id) — self-loops — are never useful and
    // would create degenerate entity_connections rows. Skip silently.
    if (from.type === to.type && from.id === to.id) continue;
    out.push({
      rel,
      from: { type: from.type, id: from.id },
      to:   { type: to.type,   id: to.id   },
      match_confidence: from.confidence === "high" && to.confidence === "high" ? "high" : "medium",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runLittleSisPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export type { AnchorMatch };
