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

const ENTITY_CHUNK     = 500;
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
      out.set(ls, {
        civitics_type: r.entity_type as "official" | "financial_entity",
        civitics_id:   r.entity_id,
        confidence:    (r.metadata?.["confidence"] as "high" | "medium") ?? "medium",
      });
    }
    if (rows.length < KNOWN_LOAD_PAGE) break;
    page++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// hop-1 financial_entities upsert
//
// For LittleSis Persons (entity_type='individual') we append an `[LS:<id>]`
// suffix to canonical_name. Common surnames + first names collide otherwise,
// and the existing UNIQUE(canonical_name, entity_type) would silently merge
// two different people. Org names are distinct enough that merging by
// canonical_name is correct (Goldman Sachs Group = Goldman Sachs Group).
// ---------------------------------------------------------------------------

interface UpsertHop1Result {
  /** lsId → financial_entity uuid (covers both newly-inserted and matched-existing) */
  idMap:    Map<number, string>;
  inserted: number;
  failed:   number;
}

export async function upsertHop1FinancialEntities(
  db: Db,
  entities: LittleSisEntity[],
): Promise<UpsertHop1Result> {
  const idMap = new Map<number, string>();
  let inserted = 0;
  let failed   = 0;
  if (entities.length === 0) return { idMap, inserted, failed };

  const records = entities.map((ent) => {
    const baseCanonical = canonicalizeEntityName(ent.name);
    const entityType = ent.primary_ext === "Person"
      ? "individual"
      : littleSisOrgEntityType(ent.types);
    const canonical = entityType === "individual"
      ? `${baseCanonical} [LS:${ent.id}]`        // discriminator suffix
      : baseCanonical;
    return {
      _lsId: ent.id,
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
    };
  });

  // Bare INSERT — `(canonical_name, entity_type)` is NOT uniquely-constrained
  // on the table post-FIX-181 (donor_fingerprint UNIQUE is the only individuals
  // arbiter; PACs use fec_committee_id UNIQUE). LittleSis hop-1 entities have
  // neither, so we can't piggyback on either constraint. Idempotency is
  // instead enforced upstream by the `external_source_refs(source='littlesis')`
  // preload — entities already bound to a LittleSis id never reach this code
  // path. Risk: same canonical_name + entity_type as a pre-existing non-
  // LittleSis row produces a duplicate row; accepted for v1 and documented.
  for (let i = 0; i < records.length; i += ENTITY_CHUNK) {
    const chunk = records.slice(i, i + ENTITY_CHUNK);
    const lsByCanonical = new Map<string, number>();
    for (const r of chunk) lsByCanonical.set(r.canonical_name, r._lsId);

    const payload = chunk.map(({ _lsId: _, ...rest }) => rest);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("financial_entities")
      .insert(payload)
      .select("id, canonical_name");
    if (error) {
      console.error(`  [littlesis] financial_entities chunk ${i}-${i + chunk.length} failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    for (const row of (data ?? []) as Array<{ id: string; canonical_name: string }>) {
      const lsId = lsByCanonical.get(row.canonical_name);
      if (lsId !== undefined) {
        idMap.set(lsId, row.id);
        inserted++;
      }
    }
  }

  return { idMap, inserted, failed };
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
