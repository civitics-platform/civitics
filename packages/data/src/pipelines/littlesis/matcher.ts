/**
 * FIX-251 · LittleSis matcher — deterministic entity resolution.
 *
 * No AI in the default path. Three indices built from existing Civitics rows:
 *   - officialsByLastName  →  politicians (federal + state)
 *   - personsBySortKey     →  individual donors from FEC bulk (FIX-239 dedup)
 *   - orgsByCanonical      →  PACs, corps, unions, party committees
 *
 * Person matching uses an alphabetical sort key on name tokens so a LittleSis
 * "Elon Musk" matches a FEC indiv "MUSK ELON R" without us needing to know
 * which slot is the surname.
 *
 * Match outcomes:
 *   high   — exact canonical match, single candidate (or single after state-narrow)
 *   medium — single candidate, narrowing wasn't possible (state hint missing) but
 *            no other candidates competed
 *   queue  — 2-3+ candidates that survive narrowing → human-in-loop FIX-252
 *   miss   — zero candidates; the entity becomes a hop-1 financial_entity if a
 *            future edge references it
 */

import { canonicalizeEntityName } from "../fec-bulk/writer";
import { type LittleSisEntity, parseStateHint } from "./util";
import { buildDbUrl } from "../../lib/heavy-rebuild";

// ---------------------------------------------------------------------------
// Row shapes — only the columns we need, pre-narrowed
// ---------------------------------------------------------------------------

export interface OfficialRow {
  id:         string;
  full_name:  string;
  first_name: string | null;
  last_name:  string | null;
  state_abbr: string | null;
  role_title: string | null;
}

export interface FinancialEntityRow {
  id:             string;
  canonical_name: string;
  entity_type:    string;
}

export interface MatchIndex {
  officialsByLastName: Map<string, OfficialRow[]>;
  personsBySortKey:    Map<string, FinancialEntityRow[]>;
  orgsByCanonical:     Map<string, FinancialEntityRow[]>;
}

// ---------------------------------------------------------------------------
// Build the in-memory match indices from Civitics rows
// ---------------------------------------------------------------------------

/**
 * Alphabetical-sorted token key. Orders surname-first and first-name-first
 * variants into the same string so we can match across data sources whose
 * name conventions differ.
 *
 *   canonicalize("Elon Musk")  → "ELON MUSK"   → sort → "ELON MUSK"
 *   canonicalize("MUSK ELON")  → "MUSK ELON"   → sort → "ELON MUSK"
 *   canonicalize("Elon R Musk")→ "ELON R MUSK" → sort → "ELON MUSK R"
 *
 * Single-letter middle initials are kept in the key. That matches FIX-239's
 * decision to leave middle initials in canonical_name rather than collapse.
 */
export function personSortKey(canonical: string): string {
  return canonical
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * FIX-294 — load the index via a direct pg.Client, not PostgREST `.range()`
 * pagination.
 *
 * The old path paginated ~2.45M `financial_entities` (+28.6K officials) into
 * memory through Kong as ~2,480 sequential PostgREST round-trips. Under prod
 * IOWait that round-trip storm stalls and eats the shared 120-min nightly
 * enrichment budget, so the GHA job gets cancelled and the orphan reaper marks
 * the run failed (`reaped_orphan`, 2026-06-07 / 2026-05-17).
 *
 * Direct-pg (via `buildDbUrl()` — same resolution local Docker vs prod pooler
 * used by `selectDirect`/`runHeavyRebuild`) collapses that into a handful of
 * streamed queries with no 8s role cap and no 1,000-row PostgREST max_rows cap.
 * The FE scan is keyset-chunked (`WHERE id > $last ORDER BY id LIMIT 100k`) so
 * peak RSS stays flat rather than buffering 2.45M rows at once.
 *
 * Behaviour-preserving: the in-memory Map shapes, the persons-vs-orgs split,
 * `personSortKey`, and every column read are identical to the paginated path —
 * only the load mechanism changed. Match outputs are invariant by construction.
 */
export async function buildMatchIndex(): Promise<MatchIndex> {
  const officialsByLastName = new Map<string, OfficialRow[]>();
  const personsBySortKey    = new Map<string, FinancialEntityRow[]>();
  const orgsByCanonical     = new Map<string, FinancialEntityRow[]>();

  const t0 = process.hrtime.bigint();
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    // A few wide reads; the FE scan can take minutes on prod. Raise the
    // SESSION timeout past the gateway/role caps (mirrors heavy-rebuild.ts).
    await client.query("SET statement_timeout = '90min'");

    // ── officials (single direct query; ~28.6k rows) ─────────────────────
    const officials = await client.query<{
      id: string; full_name: string;
      first_name: string | null; last_name: string | null;
      metadata: Record<string, unknown> | null; role_title: string | null;
    }>("SELECT id, full_name, first_name, last_name, metadata, role_title FROM officials");
    for (const r of officials.rows) {
      const last = (r.last_name ?? r.full_name.split(/\s+/).pop() ?? "")
        .toUpperCase().replace(/[^A-Z]/g, "");
      if (!last) continue;
      const stateAbbr =
        (r.metadata?.["state_abbr"] as string | undefined)
        ?? (r.metadata?.["state"]      as string | undefined)
        ?? null;
      const row: OfficialRow = {
        id:         r.id,
        full_name:  r.full_name,
        first_name: r.first_name,
        last_name:  r.last_name,
        state_abbr: stateAbbr ? stateAbbr.toUpperCase() : null,
        role_title: r.role_title,
      };
      const list = officialsByLastName.get(last) ?? [];
      list.push(row);
      officialsByLastName.set(last, list);
    }

    // ── financial_entities, keyset-chunked to bound memory (~2.45M rows) ──
    //
    // Individuals (~2.37M FEC indiv donors) build only the sort-key index, not
    // a name-token-prefix index, to keep memory bounded. Org count is ~30k.
    // Reading in id-ordered chunks keeps peak RSS flat — a single 2.45M-row
    // buffer would spike past the ~1 GB the paginated path already peaked at.
    const CHUNK  = 100_000;
    let   lastId = "00000000-0000-0000-0000-000000000000";
    while (true) {
      const page = await client.query<FinancialEntityRow>(
        "SELECT id, canonical_name, entity_type FROM financial_entities " +
          "WHERE id > $1 ORDER BY id LIMIT $2",
        [lastId, CHUNK],
      );
      const rows = page.rows;
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!r.canonical_name) continue;
        if (r.entity_type === "individual") {
          const key  = personSortKey(r.canonical_name);
          if (!key) continue;
          const list = personsBySortKey.get(key) ?? [];
          list.push(r);
          personsBySortKey.set(key, list);
        } else {
          const list = orgsByCanonical.get(r.canonical_name) ?? [];
          list.push(r);
          orgsByCanonical.set(r.canonical_name, list);
        }
      }
      lastId = rows[rows.length - 1]!.id;
      if (rows.length < CHUNK) break;
    }
  } finally {
    await client.end();
  }

  const secs  = (Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1);
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(
    `[littlesis] match index built in ${secs}s, rss=${rssMb}MB, ` +
    `officials=${officialsByLastName.size}, persons=${personsBySortKey.size}, orgs=${orgsByCanonical.size}`,
  );

  return { officialsByLastName, personsBySortKey, orgsByCanonical };
}

// ---------------------------------------------------------------------------
// Match result types
// ---------------------------------------------------------------------------

export type MatchResult =
  | { kind: "high";   civitics_type: "official" | "financial_entity"; civitics_id: string }
  | { kind: "medium"; civitics_type: "official" | "financial_entity"; civitics_id: string }
  | { kind: "queue";  candidates: Array<{ id: string; type: string; reason: string }>; reason: string }
  | { kind: "miss" };

// ---------------------------------------------------------------------------
// Person match (LittleSis primary_ext === "Person")
//
// Order:
//   1. Try officials by last_name. Narrow by state hint + first-name prefix.
//   2. If no official match: try financial_entities individuals by sort key.
//   3. Otherwise: miss.
// ---------------------------------------------------------------------------

export function matchPerson(ent: LittleSisEntity, idx: MatchIndex): MatchResult {
  if (ent.primary_ext !== "Person") return { kind: "miss" };

  const canonical = canonicalizeEntityName(ent.name);
  if (!canonical) return { kind: "miss" };
  const tokens = canonical.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { kind: "miss" };  // single-name LittleSis entries are too risky

  // ── Officials match ─────────────────────────────────────────────────────
  // LittleSis Person names are FIRST-LAST order: last token is surname.
  const lsLast  = tokens[tokens.length - 1]!.replace(/[^A-Z]/g, "");
  const lsFirst = tokens[0]!.replace(/[^A-Z]/g, "");
  const officials = idx.officialsByLastName.get(lsLast) ?? [];

  if (officials.length > 0) {
    const stateHint = parseStateHint(ent);
    const stateNarrowed = stateHint
      ? officials.filter((o) => o.state_abbr === stateHint)
      : officials;
    const pool = stateNarrowed.length > 0 ? stateNarrowed : officials;

    if (pool.length === 1) {
      return {
        kind: stateHint && stateNarrowed.length === 1 ? "high" : "medium",
        civitics_type: "official",
        civitics_id:   pool[0]!.id,
      };
    }

    if (lsFirst.length >= 3) {
      const firstNarrowed = pool.filter((o) =>
        (o.first_name ?? "").toUpperCase().replace(/[^A-Z]/g, "").startsWith(lsFirst.slice(0, 3)),
      );
      if (firstNarrowed.length === 1) {
        return {
          kind: stateHint ? "high" : "medium",
          civitics_type: "official",
          civitics_id:   firstNarrowed[0]!.id,
        };
      }
      if (firstNarrowed.length > 1) {
        return {
          kind: "queue",
          reason: "multi_after_state_and_first_prefix",
          candidates: firstNarrowed.slice(0, 5).map((o) => ({
            id: o.id, type: "official", reason: "narrowed_by_state_and_first",
          })),
        };
      }
    }

    return {
      kind: "queue",
      reason: pool.length <= 5 ? "multi_after_state_narrow" : "too_many_lastname_hits",
      candidates: pool.slice(0, 5).map((o) => ({
        id: o.id, type: "official", reason: "lastname_match",
      })),
    };
  }

  // ── Financial-entity individual match (donor side) ──────────────────────
  const key   = personSortKey(canonical);
  const hits  = idx.personsBySortKey.get(key) ?? [];
  if (hits.length === 1) {
    return {
      kind: "medium",
      civitics_type: "financial_entity",
      civitics_id:   hits[0]!.id,
    };
  }
  if (hits.length > 1) {
    return {
      kind: "queue",
      reason: "multi_individual_donors",
      candidates: hits.slice(0, 5).map((h) => ({
        id: h.id, type: "financial_entity", reason: "sort_key_collision",
      })),
    };
  }
  return { kind: "miss" };
}

// ---------------------------------------------------------------------------
// Org match (LittleSis primary_ext === "Org")
// ---------------------------------------------------------------------------

export function matchOrg(ent: LittleSisEntity, idx: MatchIndex): MatchResult {
  if (ent.primary_ext !== "Org") return { kind: "miss" };

  const canonical = canonicalizeEntityName(ent.name);
  if (!canonical) return { kind: "miss" };

  const hits = idx.orgsByCanonical.get(canonical) ?? [];
  if (hits.length === 1) {
    return {
      kind: "high",
      civitics_type: "financial_entity",
      civitics_id:   hits[0]!.id,
    };
  }
  if (hits.length > 1) {
    // Prefer the hit whose entity_type aligns with LittleSis types[]. e.g.
    // a LittleSis "PoliticalFundraising" Org should resolve to a PAC over a
    // generic corporation if both exist under the same canonical_name.
    const types = (ent.types ?? []).map((s) => s.toLowerCase());
    const prefer = (et: string): number => {
      if (types.some((t) => t.includes("political_fundraising") || t.includes("politicalfundraising")) && (et === "pac" || et === "super_pac")) return 2;
      if (types.some((t) => t.includes("labor")) && et === "union") return 2;
      if (types.some((t) => t.includes("business") || t.includes("publiccompany")) && et === "corporation") return 2;
      return 0;
    };
    const ranked = [...hits].sort((a, b) => prefer(b.entity_type) - prefer(a.entity_type));
    if (prefer(ranked[0]!.entity_type) > 0 && prefer(ranked[1]?.entity_type ?? "") < prefer(ranked[0]!.entity_type)) {
      return {
        kind: "medium",
        civitics_type: "financial_entity",
        civitics_id:   ranked[0]!.id,
      };
    }
    return {
      kind: "queue",
      reason: "multi_canonical_org",
      candidates: hits.slice(0, 5).map((h) => ({
        id: h.id, type: "financial_entity", reason: `canonical_match (${h.entity_type})`,
      })),
    };
  }
  return { kind: "miss" };
}
