/**
 * FIX-251 · LittleSis writer — batched upserts.
 *
 * Three tables touched:
 *   financial_entities                    (new hop-1 entities, dedup by canonical_name+entity_type
 *                                          for orgs; LittleSis-id-discriminated canonical_name for
 *                                          individuals to avoid common-name collisions)
 *   external_source_refs                  (binds LittleSis entity id → financial_entity uuid;
 *                                          UNIQUE(source, external_id) is the idempotency arbiter)
 *   external_relationships                (edges, UNIQUE(source, source_id))
 *   external_relationships_review_queue   (ambiguous matches for FIX-252 human review)
 */

import type { createAdminClient } from "@civitics/db";
import { refreshPrimarySourceForEntities } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import {
  type LittleSisEntity,
  type LittleSisRelationship,
  CATEGORY_NAMES,
  CATEGORY_TO_CONNECTION_TYPE,
  littleSisOrgEntityType,
} from "./util";
import type { AnchorMatch, AmbiguousMatch } from "./expand";

type Db = ReturnType<typeof createAdminClient>;

const RESOLVE_BATCH    = 50;     // FIX-280 — RPC + INSERT bounded concurrency per chunk
const REL_CHUNK        = 500;
const REVIEW_CHUNK     = 500;
const REFS_CHUNK       = 500;
const KNOWN_LOAD_PAGE  = 1000;

// ---------------------------------------------------------------------------
// Pre-load existing LittleSis ↔ Civitics bindings from external_source_refs
// so re-runs reuse existing rows without re-INSERTing.
// ---------------------------------------------------------------------------

export async function preloadKnownLittleSisIds(db: Db): Promise<Map<number, AnchorMatch>> {
  const out = new Map<number, AnchorMatch>();
  let page = 0;
  while (true) {
    const { data } = await (db as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, v: string) => {
            range: (from: number, to: number) => Promise<{ data: unknown[] | null }>;
          };
        };
      };
    })
      .from("external_source_refs")
      .select("external_id, entity_type, entity_id, metadata")
      .eq("source", "littlesis")
      .range(page * KNOWN_LOAD_PAGE, (page + 1) * KNOWN_LOAD_PAGE - 1);
    const rows = (data ?? []) as Array<{
      external_id: string; entity_type: string; entity_id: string;
      metadata: Record<string, unknown> | null;
    }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const ls = Number(r.external_id);
      if (!Number.isFinite(ls)) continue;
      // confidence in storage can be 'high' | 'medium' | 'hop1' | 'canonical_match'
      // (FIX-280). Collapse anything that isn't 'high' to 'medium' for the
      // in-memory AnchorMatch shape — edge match_confidence treats medium as
      // the conservative default and never promotes hop-1 rows to high.
      const storedConf = r.metadata?.["confidence"];
      out.set(ls, {
        civitics_type: r.entity_type as "official" | "financial_entity",
        civitics_id:   r.entity_id,
        confidence:    storedConf === "high" ? "high" : "medium",
      });
    }
    if (rows.length < KNOWN_LOAD_PAGE) break;
    page++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// hop-1 financial_entities — resolve-or-insert via resolve_entity_by_canonical
// (Strategy D Session 3, FIX-280)
//
// Before inserting a new financial_entities row for a LittleSis hop-1 entity,
// ask the database whether an existing row with the same canonical_name
// already exists from any source (FEC, IRS 990, EDGAR, or an earlier
// LittleSis run). On single-match we bind the LS id to that row via
// external_source_refs(source='littlesis') instead of inserting a duplicate.
// On 0-match or multi-match (RPC returns NULL) we INSERT a new row.
//
// For Persons we pass p_entity_type='individual' so the RPC's
// `donor_fingerprint IS NOT NULL` filter rules out matching LS-only
// individuals under common names. For Orgs we pass p_entity_type=NULL so a
// LittleSis 'other'/'corporation' row can bind to an IRS 990 'nonprofit' row
// under the same canonical (Heritage Foundation case from investigation
// §5.6); the single-match-only contract still blocks unsafe collisions.
//
// FIX-272 closeout: the `[LS:<id>]` suffix that used to discriminate Person
// canonicals (originally at writer.ts:107 before FIX-280) was removed at the
// same time as the RPC switch. Match-first via resolve_entity_by_canonical
// supersedes its collision-prevention purpose, and no production rows ever
// carried the suffix anyway — 0 of 84,811 LS-bound individuals per
// investigation §3.2(d) / OOS #1 (re-confirmed 2026-05-18: still 0 rows in
// local DB matching `canonical_name LIKE '%[LS:%'`). The pre-FIX-271 LS rows
// without the suffix stay as-is; the cross-source merge backfill in FIX-271
// is the destructive cleanup path, not a retroactive suffix add.
//
// Idempotency for previously-bound LS ids is upstream via
// preloadKnownLittleSisIds + the `known.has(lsId)` filter in index.ts — no
// LS id ever reaches this code path after a successful prior binding, so
// the helper does not re-check external_source_refs.
// ---------------------------------------------------------------------------

interface UpsertHop1Result {
  /** lsId → financial_entity uuid (covers both newly-inserted and matched-existing) */
  idMap:        Map<number, string>;
  /** newly INSERTed (no canonical match found) */
  inserted:     number;
  /** RPC single-match (bound to existing row instead of INSERTing) */
  matched:      number;
  /** per-row INSERT or canonicalization failures */
  failed:       number;
  /** RPC errors that fell through to INSERT path (degraded-mode visibility) */
  rpcErrors:    number;
  /** lsIds that came from RPC match (caller stamps confidence='canonical_match') */
  matchedLsIds: Set<number>;
}

async function resolveOrInsertHop1(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ent: LittleSisEntity,
): Promise<{ id: string; created: boolean; rpcError: boolean } | null> {
  const canonical = canonicalizeEntityName(ent.name);
  if (!canonical) return null;   // empty after canonicalization — skip

  const entityType = ent.primary_ext === "Person"
    ? "individual"
    : littleSisOrgEntityType(ent.types);
  const rpcType = entityType === "individual" ? "individual" : null;

  const { data: matchedId, error: rpcErr } = await db.rpc(
    "resolve_entity_by_canonical",
    { p_canonical_name: canonical, p_entity_type: rpcType, p_state: null },
  );
  let rpcError = false;
  if (rpcErr) {
    console.warn(`  [littlesis] resolve_entity_by_canonical failed for LS:${ent.id}: ${rpcErr.message}`);
    rpcError = true;
    // Fall through to INSERT in degraded mode.
  } else if (matchedId) {
    console.log(`  [littlesis] LS:${ent.id} canonical-bound to existing entity ${matchedId} (canonical="${canonical}", entity_type=${entityType})`);
    return { id: matchedId as string, created: false, rpcError: false };
  }

  const { data: ins, error: insErr } = await db
    .from("financial_entities")
    .insert({
      canonical_name:       canonical,
      display_name:         (ent.name ?? "").slice(0, 255),
      entity_type:          entityType,
      fec_committee_id:     null,
      total_donated_cents:  0,
      total_received_cents: 0,
      metadata: {
        source:        "littlesis",
        littlesis_id:  ent.id,
        blurb:         ent.blurb ?? null,
        website:       ent.website ?? null,
        types:         ent.types ?? [],
        aliases:       ent.aliases ?? [],
      },
    })
    .select("id")
    .single();
  if (insErr) {
    console.warn(`  [littlesis] financial_entities insert failed for LS:${ent.id}: ${insErr.message}`);
    return null;
  }
  return { id: (ins as { id: string }).id, created: true, rpcError };
}

export async function upsertHop1FinancialEntities(
  db: Db,
  entities: LittleSisEntity[],
): Promise<UpsertHop1Result> {
  const idMap        = new Map<number, string>();
  const matchedLsIds = new Set<number>();
  let inserted  = 0;
  let matched   = 0;
  let failed    = 0;
  let rpcErrors = 0;
  if (entities.length === 0) return { idMap, inserted, matched, failed, rpcErrors, matchedLsIds };

  // FIX-273: intra-source dedupe. Two LittleSis entities with the same
  // canonical_name + entity_type that both arrive in the same ingest race
  // each other through resolveOrInsertHop1 — both query RPC concurrently,
  // both see no existing FE row (RESOLVE_BATCH parallelism), both INSERT.
  // Result: two FE rows for the same LS-side dupe (the Paul Singer
  // LS:59970/LS:101660 pattern from investigation §9 OOS #2). Group by
  // (canonical, entity_type) up front; only the first LS entity in each
  // group goes through the RPC+INSERT, and every other LS-id in the group
  // binds to the same financial_entity uuid. preloadKnownLittleSisIds in
  // a future run will see all the bindings via external_source_refs.
  const groups = new Map<string, LittleSisEntity[]>();
  for (const ent of entities) {
    const canonical = canonicalizeEntityName(ent.name);
    if (!canonical) continue;
    const entityType = ent.primary_ext === "Person"
      ? "individual"
      : littleSisOrgEntityType(ent.types);
    const key = `${canonical}|${entityType}`;
    const list = groups.get(key) ?? [];
    list.push(ent);
    groups.set(key, list);
  }
  const representatives = [...groups.values()].map((g) => g[0]!);
  const dupesCollapsed  = entities.length - representatives.length;
  if (dupesCollapsed > 0) {
    console.log(`  [littlesis] intra-source dedupe: ${entities.length} entities → ${representatives.length} groups (${dupesCollapsed} duplicates folded)`);
  }

  for (let i = 0; i < representatives.length; i += RESOLVE_BATCH) {
    const chunk = representatives.slice(i, i + RESOLVE_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await Promise.all(chunk.map((ent) => resolveOrInsertHop1(db as any, ent)));
    for (let j = 0; j < chunk.length; j++) {
      const rep = chunk[j]!;
      const res = results[j];
      if (res === null) { failed++; continue; }
      // Map every LS-id in the rep's group to the resolved/inserted entity.
      const canonical = canonicalizeEntityName(rep.name);
      const entityType = rep.primary_ext === "Person"
        ? "individual"
        : littleSisOrgEntityType(rep.types);
      const group = groups.get(`${canonical}|${entityType}`) ?? [rep];
      for (const member of group) {
        idMap.set(member.id, res.id);
        if (!res.created) matchedLsIds.add(member.id);
      }
      if (res.created) inserted++;
      else            matched++;
      if (res.rpcError) rpcErrors++;
    }
  }

  return { idMap, inserted, matched, failed, rpcErrors, matchedLsIds };
}

// ---------------------------------------------------------------------------
// LittleSis-format date → ISO date
//
// LittleSis encodes unknown precision as `00` for month and/or day, e.g.
// "2002-00-00" (year only), "2020-07-00" (year+month). Postgres rejects both.
// We coerce `00` → `01` to keep the year (and month, when known) and drop
// the date entirely if the shape isn't YYYY-MM-DD or yields an impossible
// month/day after coercion.
// ---------------------------------------------------------------------------

function safeLittleSisDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, moRaw, dRaw] = m;
  const mo = moRaw === "00" ? "01" : moRaw!;
  const d  = dRaw  === "00" ? "01" : dRaw!;
  const moN = Number(mo); const dN = Number(d);
  if (moN < 1 || moN > 12 || dN < 1 || dN > 31) return null;
  // Round-trip via Date to reject impossible dates like Feb 30 / Jun 31.
  const iso = `${y}-${mo}-${d}`;
  const dt  = new Date(`${iso}T00:00:00Z`);
  if (isNaN(dt.getTime())) return null;
  if (dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

// ---------------------------------------------------------------------------
// external_source_refs binding for newly-inserted hop1 entities
// ---------------------------------------------------------------------------

export async function upsertSourceRefs(
  db: Db,
  bindings: Array<{ lsId: number; entity_type: string; entity_id: string; confidence?: string }>,
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0, failed = 0;
  if (bindings.length === 0) return { inserted, failed };

  for (let i = 0; i < bindings.length; i += REFS_CHUNK) {
    const chunk = bindings.slice(i, i + REFS_CHUNK);
    const payload = chunk.map((b) => ({
      source:       "littlesis",
      external_id:  String(b.lsId),
      entity_type:  b.entity_type,
      entity_id:    b.entity_id,
      source_url:   `https://littlesis.org/entities/${b.lsId}`,
      last_seen_at: new Date().toISOString(),
      metadata:     { confidence: b.confidence ?? "hop1" },
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from("external_source_refs")
      .upsert(payload, { onConflict: "source,external_id" });
    if (error) {
      console.error(`  [littlesis] external_source_refs chunk failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    inserted += chunk.length;
  }

  // FIX-397: refresh primary_source for each entity_type touched. LittleSis
  // writes both 'official' and 'financial_entity' bindings; dispatch per
  // type so the helper picks the right table.
  const byType = new Map<string, string[]>();
  for (const b of bindings) {
    const list = byType.get(b.entity_type) ?? [];
    list.push(b.entity_id);
    byType.set(b.entity_type, list);
  }
  for (const [entityType, ids] of byType) {
    if (entityType === "official" || entityType === "financial_entity") {
      await refreshPrimarySourceForEntities(db, entityType, ids);
    }
  }

  return { inserted, failed };
}

// ---------------------------------------------------------------------------
// external_relationships upsert
//
// Each edge needs FROM/TO resolved to a (civitics_type, civitics_id). The
// caller passes a combined resolver Map<lsId → {type,id}>. We drop any edge
// where either endpoint resolves to nothing (defensive — pass-3 logic
// shouldn't produce these but bulk dumps occasionally surprise).
// ---------------------------------------------------------------------------

export interface EdgeResolveTarget { type: "official" | "financial_entity"; id: string; }

interface ExternalRelInput {
  rel: LittleSisRelationship;
  from: EdgeResolveTarget;
  to:   EdgeResolveTarget;
  match_confidence: "high" | "medium";   // weakest endpoint confidence
}

export async function upsertExternalRelationships(
  db: Db,
  edges: ExternalRelInput[],
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0, failed = 0;
  if (edges.length === 0) return { inserted, failed };

  // Client-side de-dup on source_id (LittleSis sometimes duplicates rel ids
  // when the dump straddles a record update — keep the highest source_updated_at).
  const merged = new Map<string, ExternalRelInput>();
  for (const e of edges) {
    const key = String(e.rel.id);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, e); continue; }
    const a = existing.rel.updated_at ?? "";
    const b = e.rel.updated_at ?? "";
    if (b > a) merged.set(key, e);
  }
  const records = [...merged.values()].map((e) => {
    const connectionType = CATEGORY_TO_CONNECTION_TYPE[e.rel.category_id] ?? "affiliated_with";
    const descParts = [e.rel.description1, e.rel.description2]
      .map((s) => (s ?? "").trim()).filter(Boolean);
    return {
      source:            "littlesis",
      source_id:         String(e.rel.id),
      source_url:        `https://littlesis.org/relationships/${e.rel.id}`,
      source_updated_at: e.rel.updated_at ?? null,
      from_type:         e.from.type,
      from_id:           e.from.id,
      to_type:           e.to.type,
      to_id:             e.to.id,
      connection_type:   connectionType,
      raw_category:      String(e.rel.category_id),
      raw_category_name: CATEGORY_NAMES[e.rel.category_id] ?? null,
      description:       descParts.length > 0 ? descParts.join(" / ").slice(0, 500) : null,
      amount_cents:      typeof e.rel.amount === "number" && e.rel.currency === "USD"
                           ? Math.round(e.rel.amount * 100)
                           : null,
      occurred_at:       safeLittleSisDate(e.rel.start_date),
      ended_at:          safeLittleSisDate(e.rel.end_date),
      is_current:        e.rel.is_current ?? null,
      match_confidence:  e.match_confidence,
      metadata: {
        category_attributes: e.rel.category_attributes ?? {},
        currency:            e.rel.currency ?? null,
        goods:               e.rel.goods ?? null,
        is_featured:         e.rel.is_featured ?? null,
        raw_start_date:      e.rel.start_date ?? null,
        raw_end_date:        e.rel.end_date ?? null,
      },
    };
  });

  for (let i = 0; i < records.length; i += REL_CHUNK) {
    const chunk = records.slice(i, i + REL_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from("external_relationships")
      .upsert(chunk, { onConflict: "source,source_id" });
    if (error) {
      console.error(`  [littlesis] external_relationships chunk ${i}-${i + chunk.length} failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    inserted += chunk.length;
  }
  return { inserted, failed };
}

// ---------------------------------------------------------------------------
// review queue upsert (ambiguous matches)
// ---------------------------------------------------------------------------

export async function upsertReviewQueue(
  db: Db,
  rows: AmbiguousMatch[],
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0, failed = 0;
  if (rows.length === 0) return { inserted, failed };

  const records = rows.map((r) => ({
    source:                 "littlesis",
    source_entity_id:       r.source_entity_id,
    source_relationship_id: null,
    source_payload:         r.source_payload as unknown as Record<string, unknown>,
    candidate_matches:      r.candidate_matches,
    reason:                 r.reason,
    status:                 "pending",
  }));

  for (let i = 0; i < records.length; i += REVIEW_CHUNK) {
    const chunk = records.slice(i, i + REVIEW_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from("external_relationships_review_queue")
      .upsert(chunk, { onConflict: "source,source_entity_id,source_relationship_id" });
    if (error) {
      // PostgREST won't accept a NULL component of the conflict target via
      // upsert; fall back to insert-then-ignore via the unique constraint.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: err2 } = await (db as any)
        .from("external_relationships_review_queue")
        .insert(chunk);
      if (err2 && !err2.message?.includes("duplicate key")) {
        console.warn(`  [littlesis] review_queue chunk failed: ${err2.message}`);
        failed += chunk.length;
        continue;
      }
    }
    inserted += chunk.length;
  }
  return { inserted, failed };
}
