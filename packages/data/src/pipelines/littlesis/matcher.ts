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

import type { createAdminClient } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import { type LittleSisEntity, parseStateHint } from "./util";

type Db = ReturnType<typeof createAdminClient>;

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

export async function buildMatchIndex(db: Db): Promise<MatchIndex> {
  const officialsByLastName = new Map<string, OfficialRow[]>();
  const personsBySortKey    = new Map<string, FinancialEntityRow[]>();
  const orgsByCanonical     = new Map<string, FinancialEntityRow[]>();

  // ── officials (paginated; ~10k local, ~100k+ with FIX-246 candidates) ────
  {
    const PAGE = 1000;
    let page   = 0;
    while (true) {
      const { data } = await (db as unknown as {
        from: (t: string) => {
          select: (cols: string) => {
            range: (from: number, to: number) => Promise<{ data: unknown[] | null }>;
          };
        };
      })
        .from("officials")
        .select("id, full_name, first_name, last_name, metadata, role_title")
        .range(page * PAGE, (page + 1) * PAGE - 1);
      const rows = (data ?? []) as Array<{
        id: string; full_name: string;
        first_name: string | null; last_name: string | null;
        metadata: Record<string, unknown> | null; role_title: string | null;
      }>;
      if (rows.length === 0) break;
      for (const r of rows) {
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
      if (rows.length < PAGE) break;
      page++;
    }
  }

  // ── financial_entities, split persons vs orgs ────────────────────────────
  //
  // Individuals are ~600k rows on prod (FEC indiv donors); we load them but
  // only build the sort-key index, not a name-token-prefix index, to keep
  // memory bounded. Org count is ~30k.
  {
    const PAGE = 1000;
    let page   = 0;
    while (true) {
      const { data } = await (db as unknown as {
        from: (t: string) => {
          select: (cols: string) => {
            range: (from: number, to: number) => Promise<{ data: unknown[] | null }>;
          };
        };
      })
        .from("financial_entities")
        .select("id, canonical_name, entity_type")
        .range(page * PAGE, (page + 1) * PAGE - 1);
      const rows = (data ?? []) as FinancialEntityRow[];
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
      if (rows.length < PAGE) break;
      page++;
    }
  }

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
