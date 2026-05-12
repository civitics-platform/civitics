/**
 * FIX-251 · LittleSis 2-hop expansion.
 *
 * P1 (entities, in-memory):    build byId map + match against Civitics → anchor set
 * P2 (relationships, stream):  collect 0-hop edges (both endpoints anchored)
 *                              + queue 1-hop entity ids
 * P3 (relationships, stream):  collect 2-hop edges connecting (anchor ∪ hop1) sets
 *
 * Memory budget: byId holds the full parsed entity payload through to
 * materialization. LittleSis ships ~600k entities; ~500 bytes each parsed →
 * ~300 MB. Hard abort threshold defaults to RSS > 1.5 GB or byId.size > 2M.
 */

import {
  type LittleSisEntity,
  type LittleSisRelationship,
  shouldSkipCategory,
  streamGzipJson,
} from "./util";
import { matchOrg, matchPerson, type MatchIndex } from "./matcher";

// Defaults sized for NODE_OPTIONS=--max-old-space-size=8192. Lower these
// (env LITTLESIS_RSS_ABORT_MB) if running on a smaller heap. The pipeline
// holds the decompressed entities buffer + parsed entity map + 3 match
// indexes simultaneously; peak RSS is dominated by the JSON.parse() of the
// 300-500 MB decompressed entities dump (~3x temporary spike during parse).
const RSS_WARN_MB  = Number(process.env["LITTLESIS_RSS_WARN_MB"]  ?? 4096);
const RSS_ABORT_MB = Number(process.env["LITTLESIS_RSS_ABORT_MB"] ?? 6144);
const MAX_ENTITIES = 2_000_000;

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// ---------------------------------------------------------------------------
// Pass 1: load entities + match → anchor set
// ---------------------------------------------------------------------------

export interface AnchorMatch {
  civitics_type: "official" | "financial_entity";
  civitics_id:   string;
  confidence:    "high" | "medium";
}

export interface AmbiguousMatch {
  source_entity_id: string;
  source_payload:   LittleSisEntity;
  candidate_matches: Array<{ id: string; type: string; reason: string }>;
  reason: string;
}

export interface P1Result {
  byId:       Map<number, LittleSisEntity>;
  anchorMap:  Map<number, AnchorMatch>;
  ambiguous:  AmbiguousMatch[];
  stats: {
    entities_seen: number;
    high_matches:  number;
    medium_matches: number;
    queued:        number;
    missed:        number;
  };
}

export async function pass1AnchorMatch(
  entitiesPath: string,
  idx: MatchIndex,
  alreadyKnown: Map<number, AnchorMatch>,
): Promise<P1Result> {
  const byId      = new Map<number, LittleSisEntity>();
  const anchorMap = new Map<number, AnchorMatch>(alreadyKnown);
  const ambiguous: AmbiguousMatch[] = [];
  const stats = { entities_seen: 0, high_matches: 0, medium_matches: 0, queued: 0, missed: 0 };

  let lastWarn = 0;
  for await (const ent of streamGzipJson<LittleSisEntity>(entitiesPath)) {
    if (!ent || typeof ent.id !== "number") continue;
    byId.set(ent.id, ent);
    stats.entities_seen++;

    if (byId.size > MAX_ENTITIES) {
      throw new Error(`LittleSis: entities map > ${MAX_ENTITIES}; aborting before OOM (FIX-252 escape hatch)`);
    }
    if (stats.entities_seen % 50_000 === 0) {
      const r = rssMb();
      if (r > RSS_ABORT_MB) throw new Error(`LittleSis: RSS ${r} MB exceeded abort threshold ${RSS_ABORT_MB} MB`);
      if (r > RSS_WARN_MB && r - lastWarn > 100) {
        console.warn(`  [memory] entities=${stats.entities_seen.toLocaleString()} rss=${r}MB`);
        lastWarn = r;
      }
    }

    if (anchorMap.has(ent.id)) continue;   // already-known from external_source_refs pre-load

    const match = ent.primary_ext === "Person" ? matchPerson(ent, idx)
                 : ent.primary_ext === "Org"   ? matchOrg(ent, idx)
                 : { kind: "miss" as const };

    if (match.kind === "high" || match.kind === "medium") {
      anchorMap.set(ent.id, {
        civitics_type: match.civitics_type,
        civitics_id:   match.civitics_id,
        confidence:    match.kind,
      });
      if (match.kind === "high") stats.high_matches++; else stats.medium_matches++;
    } else if (match.kind === "queue") {
      ambiguous.push({
        source_entity_id:  String(ent.id),
        source_payload:    ent,
        candidate_matches: match.candidates,
        reason:            match.reason,
      });
      stats.queued++;
    } else {
      stats.missed++;
    }
  }

  return { byId, anchorMap, ambiguous, stats };
}

// ---------------------------------------------------------------------------
// Pass 2: collect 0-hop edges + identify hop1 candidates
// ---------------------------------------------------------------------------

export interface P2Result {
  zeroHopEdges: LittleSisRelationship[];
  hop1Set:      Set<number>;
  rels_seen:    number;
  rels_skipped_category: number;
}

export async function pass2CollectEdges(
  relsPath: string,
  anchorMap: Map<number, AnchorMatch>,
  byId: Map<number, LittleSisEntity>,
): Promise<P2Result> {
  const zeroHopEdges: LittleSisRelationship[] = [];
  const hop1Set = new Set<number>();
  let rels_seen = 0;
  let rels_skipped_category = 0;

  for await (const rel of streamGzipJson<LittleSisRelationship>(relsPath)) {
    if (!rel || typeof rel.entity1_id !== "number" || typeof rel.entity2_id !== "number") continue;
    rels_seen++;
    if (shouldSkipCategory(rel.category_id)) { rels_skipped_category++; continue; }

    const a = anchorMap.has(rel.entity1_id);
    const b = anchorMap.has(rel.entity2_id);
    if (a && b) {
      zeroHopEdges.push(rel);
    } else if (a && !b) {
      // Only add to hop1 if we actually have the entity record (guards against
      // dangling endpoints in malformed dumps).
      if (byId.has(rel.entity2_id)) hop1Set.add(rel.entity2_id);
    } else if (!a && b) {
      if (byId.has(rel.entity1_id)) hop1Set.add(rel.entity1_id);
    }
  }

  return { zeroHopEdges, hop1Set, rels_seen, rels_skipped_category };
}

// ---------------------------------------------------------------------------
// Pass 3: collect 2-hop edges (anchor↔hop1 and hop1↔hop1)
// ---------------------------------------------------------------------------

export interface P3Result {
  twoHopEdges: LittleSisRelationship[];
}

export async function pass3CollectEdges(
  relsPath: string,
  anchorMap: Map<number, AnchorMatch>,
  hop1Set: Set<number>,
): Promise<P3Result> {
  const twoHopEdges: LittleSisRelationship[] = [];

  for await (const rel of streamGzipJson<LittleSisRelationship>(relsPath)) {
    if (!rel || typeof rel.entity1_id !== "number" || typeof rel.entity2_id !== "number") continue;
    if (shouldSkipCategory(rel.category_id)) continue;

    const a = anchorMap.has(rel.entity1_id);
    const b = anchorMap.has(rel.entity2_id);
    if (a && b) continue;          // already in zeroHop
    const h1 = hop1Set.has(rel.entity1_id);
    const h2 = hop1Set.has(rel.entity2_id);
    if ((a && h2) || (h1 && b) || (h1 && h2)) {
      twoHopEdges.push(rel);
    }
  }

  return { twoHopEdges };
}
