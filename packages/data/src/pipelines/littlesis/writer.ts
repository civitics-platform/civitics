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

import type { createAdminClient, ReadResult } from "@civitics/db";
import { selectAllOrThrow } from "@civitics/db";
import { withDirectClient, withDirectPool, bulkUpsert, refreshPrimarySourceDirect } from "../../lib/direct-pg-upsert";
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
const REFS_CHUNK       = 500;
const KNOWN_LOAD_PAGE  = 1000;
// FIX-741: external_relationships is 18 columns; 18 × 3000 = 54000 bind params
// stays under Postgres' 65535/statement cap while collapsing ~1,200 PostgREST
// round-trips into a handful of direct-pg statements.
const REL_DIRECT_CHUNK = 3000;

// ---------------------------------------------------------------------------
// Pre-load existing LittleSis ↔ Civitics bindings from external_source_refs
// so re-runs reuse existing rows without re-INSERTing.
// ---------------------------------------------------------------------------

export async function preloadKnownLittleSisIds(db: Db): Promise<Map<number, AnchorMatch>> {
  type RefRow = {
    external_id: string; entity_type: string; entity_id: string;
    metadata: Record<string, unknown> | null;
  };
  // FIX-545: this used to destructure `const { data }` with no error check —
  // a dead gateway returned an empty Map and the matcher re-resolved all
  // 440k entities from scratch on a run that looked clean. selectAllOrThrow
  // throws on any page error instead of degrading to known.size === 0.
  const rows = await selectAllOrThrow<RefRow>(
    "littlesis known-ids preload (external_source_refs)",
    (from, to) =>
      (db as unknown as {
        from: (t: string) => {
          select: (cols: string) => {
            eq: (col: string, v: string) => {
              range: (from: number, to: number) => PromiseLike<ReadResult<RefRow>>;
            };
          };
        };
      })
        .from("external_source_refs")
        .select("external_id, entity_type, entity_id, metadata")
        .eq("source", "littlesis")
        .range(from, to),
    { pageSize: KNOWN_LOAD_PAGE },
  );
  const out = new Map<number, AnchorMatch>();
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

// FIX-586: runs over a direct-pg Pool (raised session timeout) instead of the
// admin PostgREST client. The per-entity resolve_entity_by_canonical RPC and
// the single-row INSERT both timed out at the 8s role cap on prod 2026-06-14
// (`resolve_entity_by_canonical failed for LS:...`) as financial_entities grew.
async function resolveOrInsertHop1(
  pool: import("pg").Pool,
  ent: LittleSisEntity,
): Promise<{ id: string; created: boolean; rpcError: boolean } | null> {
  const canonical = canonicalizeEntityName(ent.name);
  if (!canonical) return null;   // empty after canonicalization — skip

  const entityType = ent.primary_ext === "Person"
    ? "individual"
    : littleSisOrgEntityType(ent.types);
  const rpcType = entityType === "individual" ? "individual" : null;

  // Positional args follow the declared order
  // resolve_entity_by_canonical(p_canonical_name, p_entity_type, p_state).
  let matchedId: string | null = null;
  let rpcError = false;
  try {
    const res = await pool.query<{ id: string | null }>(
      "SELECT public.resolve_entity_by_canonical($1, $2, $3) AS id",
      [canonical, rpcType, null],
    );
    matchedId = res.rows[0]?.id ?? null;
  } catch (err) {
    console.warn(`  [littlesis] resolve_entity_by_canonical failed for LS:${ent.id}: ${err instanceof Error ? err.message : String(err)}`);
    rpcError = true;
    // Fall through to INSERT in degraded mode.
  }
  if (matchedId) {
    console.log(`  [littlesis] LS:${ent.id} canonical-bound to existing entity ${matchedId} (canonical="${canonical}", entity_type=${entityType})`);
    return { id: matchedId, created: false, rpcError: false };
  }

  const metadata = {
    source:        "littlesis",
    littlesis_id:  ent.id,
    blurb:         ent.blurb ?? null,
    website:       ent.website ?? null,
    types:         ent.types ?? [],
    aliases:       ent.aliases ?? [],
  };
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO public.financial_entities
         (canonical_name, display_name, entity_type, fec_committee_id, total_donated_cents, total_received_cents, metadata)
       VALUES ($1, $2, $3, NULL, 0, 0, $4::jsonb)
       RETURNING id`,
      [canonical, (ent.name ?? "").slice(0, 255), entityType, JSON.stringify(metadata)],
    );
    const id = ins.rows[0]?.id;
    if (!id) return null;
    return { id, created: true, rpcError };
  } catch (err) {
    console.warn(`  [littlesis] financial_entities insert failed for LS:${ent.id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// FIX-586: no `db` param — all writes go through the direct-pg pool opened
// inside (resolve_entity_by_canonical RPC + financial_entities INSERT).
export async function upsertHop1FinancialEntities(
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

  // FIX-586: resolve/insert over a direct-pg Pool. RESOLVE_BATCH-wide
  // Promise.all keeps `max` connections in flight (a single Client would
  // serialise them); each connection carries the raised session timeout so the
  // per-entity RPC + INSERT no longer die at the 8s PostgREST role cap.
  await withDirectPool(async (pool) => {
    for (let i = 0; i < representatives.length; i += RESOLVE_BATCH) {
      const chunk = representatives.slice(i, i + RESOLVE_BATCH);
      const results = await Promise.all(chunk.map((ent) => resolveOrInsertHop1(pool, ent)));
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
  }, 10);

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
  // FIX-586: direct-pg refresh — the financial_entity refresh (n=90484) timed
  // out at the 8s role cap via the admin path on prod 2026-06-14.
  for (const [entityType, ids] of byType) {
    if (entityType === "official" || entityType === "financial_entity") {
      await refreshPrimarySourceDirect(entityType, ids);
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

// FIX-741: no `db` param — routes through the direct-pg client (raised session
// statement_timeout) instead of PostgREST 500-row .upsert() chunks. On prod the
// PostgREST path hit the ~8s role cap on slow chunks and SILENTLY dropped them
// (failed += chunk, ~4,000 external_relationships lost on 2026-07-05) — the same
// FIX-462 chunk-upsert bug class the FEC indiv path already fixed.
export async function upsertExternalRelationships(
  edges: ExternalRelInput[],
): Promise<{ inserted: number; failed: number }> {
  if (edges.length === 0) return { inserted: 0, failed: 0 };

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

  // Column order the direct-pg rows align to. ON CONFLICT (source,source_id)
  // DO UPDATE (bulkUpsert default: every non-conflict column) reproduces the
  // PostgREST merge-duplicates resolution byte-for-byte.
  const REL_COLUMNS = [
    "source", "source_id", "source_url", "source_updated_at",
    "from_type", "from_id", "to_type", "to_id",
    "connection_type", "raw_category", "raw_category_name",
    "description", "amount_cents", "occurred_at", "ended_at",
    "is_current", "match_confidence", "metadata",
  ];
  const rows: unknown[][] = records.map((r) => [
    r.source, r.source_id, r.source_url, r.source_updated_at,
    r.from_type, r.from_id, r.to_type, r.to_id,
    r.connection_type, r.raw_category, r.raw_category_name,
    r.description, r.amount_cents, r.occurred_at, r.ended_at,
    r.is_current, r.match_confidence, r.metadata,
  ]);

  const { upserted, failed } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "external_relationships",
      label:           "littlesis-external_relationships",
      columns:         REL_COLUMNS,
      conflictColumns: ["source", "source_id"],
      jsonbColumns:    ["metadata"],
      chunkSize:       REL_DIRECT_CHUNK,
      rows,
    }),
  );
  // Preserve the {inserted, failed} counter shape (FIX-686): with the raised
  // session timeout `failed > 0` now signals a real constraint problem, not a
  // silent timeout drop.
  return { inserted: upserted, failed };
}

// ---------------------------------------------------------------------------
// review queue upsert (ambiguous matches)
// ---------------------------------------------------------------------------

// FIX-741: no `db` param — routes through the direct-pg client, same as
// upsertExternalRelationships. source_relationship_id is NULL for LittleSis
// rows, so ON CONFLICT (source,source_entity_id,source_relationship_id) never
// fires (Postgres treats NULLs as distinct) — this reproduces the insert-only
// behavior the prior PostgREST NULL-conflict fallback relied on, minus the 8s
// role cap that was dropping chunks.
export async function upsertReviewQueue(
  rows: AmbiguousMatch[],
): Promise<{ inserted: number; failed: number }> {
  if (rows.length === 0) return { inserted: 0, failed: 0 };

  const records = rows.map((r) => ({
    source:                 "littlesis",
    source_entity_id:       r.source_entity_id,
    source_relationship_id: null,
    source_payload:         r.source_payload as unknown as Record<string, unknown>,
    candidate_matches:      r.candidate_matches,
    reason:                 r.reason,
    status:                 "pending",
  }));

  const QUEUE_COLUMNS = [
    "source", "source_entity_id", "source_relationship_id",
    "source_payload", "candidate_matches", "reason", "status",
  ];
  const dataRows: unknown[][] = records.map((r) => [
    r.source, r.source_entity_id, r.source_relationship_id,
    r.source_payload, r.candidate_matches, r.reason, r.status,
  ]);

  const { upserted, failed } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "external_relationships_review_queue",
      label:           "littlesis-review_queue",
      columns:         QUEUE_COLUMNS,
      conflictColumns: ["source", "source_entity_id", "source_relationship_id"],
      jsonbColumns:    ["source_payload", "candidate_matches"],
      rows:            dataRows,
    }),
  );
  return { inserted: upserted, failed };
}
