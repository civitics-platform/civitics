/**
 * FIX-253 · Stage 1 · Company metadata + financial_entities binding.
 *
 * Per S&P 500 entry:
 *   1. Fetch submissions JSON to refresh metadata (name, SIC, state of inc).
 *   2. Look up existing CIK binding in external_source_refs(source='sec_edgar').
 *   3. If unbound, search financial_entities by canonical_name for an existing
 *      corporation row (FEC committee parents often share the canonical name);
 *      else INSERT a new corporation row.
 *   4. Upsert external_source_refs binding so re-runs reuse the same FK.
 *   5. Upsert edgar_companies with the bound financial_entity_id.
 */

import { createAdminClient } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import { edgarFetch } from "./client";
import { padCik } from "./util";
import type { UniverseEntry } from "./universe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface CompanyRecord {
  /** S&P 500 universe entry. */
  universe: UniverseEntry;
  /** edgar_companies.id once upserted. */
  edgarCompanyId: string;
  /** financial_entities.id used as the edge endpoint. */
  financialEntityId: string;
  /** Filings list from submissions JSON, most-recent first. */
  recentFilings: SubmissionFiling[];
}

export interface SubmissionFiling {
  accessionNumber: string;     // hyphenated form: 0000320193-24-000123
  filingDate:      string;     // YYYY-MM-DD
  form:            string;     // "DEF 14A", "10-K", "SC 13G", ...
  primaryDocument: string;     // e.g. "ddef14a.htm"
}

interface CompanyMeta {
  name:        string;
  sic:         string | null;
  stateOfInc:  string | null;
  formerNames: string[];
  recent:      SubmissionFiling[];
}

const SUBMISSIONS_URL = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;

async function fetchSubmissions(cik: string): Promise<CompanyMeta | null> {
  const res = await edgarFetch(SUBMISSIONS_URL(cik), { accept: "application/json" });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`submissions ${cik} returned ${res.status}`);
  }
  // SEC payload shape is loose; minimal typing keeps the parse resilient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = JSON.parse(res.body);
  const recent = json?.filings?.recent ?? {};
  const accs:   string[] = recent.accessionNumber ?? [];
  const dates:  string[] = recent.filingDate      ?? [];
  const forms:  string[] = recent.form            ?? [];
  const docs:   string[] = recent.primaryDocument ?? [];

  const filings: SubmissionFiling[] = [];
  for (let i = 0; i < accs.length; i++) {
    filings.push({
      accessionNumber: accs[i] ?? "",
      filingDate:      dates[i] ?? "",
      form:            forms[i] ?? "",
      primaryDocument: docs[i] ?? "",
    });
  }

  return {
    name:        String(json?.name ?? ""),
    sic:         json?.sic ? String(json.sic) : null,
    stateOfInc:  json?.stateOfIncorporation ?? null,
    formerNames: Array.isArray(json?.formerNames)
      ? (json.formerNames as Array<{ name: string }>).map((f) => f.name).filter(Boolean)
      : [],
    recent: filings,
  };
}

/**
 * Pre-load existing CIK → financial_entity_id bindings so re-runs don't
 * INSERT duplicate corporation rows.
 */
async function preloadCikBindings(db: Db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let page = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await db
      .from("external_source_refs")
      .select("external_id, entity_id")
      .eq("source", "sec_edgar")
      .eq("entity_type", "financial_entity")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw new Error(`preloadCikBindings: ${error.message}`);
    const rows = (data ?? []) as Array<{ external_id: string; entity_id: string }>;
    for (const r of rows) out.set(r.external_id, r.entity_id);
    if (rows.length < PAGE) break;
    page++;
  }
  return out;
}

/**
 * FIX-278 — Find an existing public.financial_entities row whose canonical_name
 * matches and whose entity_type is 'corporation' OR 'other'. Uses
 * resolve_entity_by_canonical (FIX-271) as the single source of truth for
 * cross-source matching; returns NULL on miss or ambiguity.
 *
 * Loosened from 'corporation' only to also include 'other' because LittleSis
 * writes corporations under either type depending on the source `types[]`
 * shape (littleSisOrgEntityType fallback), and USAspending recipient
 * ingestion can land under 'other' too. Pre-FIX-278 the EDGAR sync would
 * INSERT a duplicate corporation row whenever the existing row sat under
 * 'other' — investigation §3.4 + §5.3.
 *
 * Sequential rather than a single multi-type lookup: if both a 'corporation'
 * and an 'other' row exist for the same canonical, treat each type window
 * independently — the helper returns NULL within each window on multi-match,
 * which is the safe (FP-resistant) outcome.
 */
async function resolveCorporationEntityByCanonical(
  db: Db,
  canonical: string,
): Promise<string | null> {
  for (const entityType of ["corporation", "other"] as const) {
    const { data, error } = await db.rpc("resolve_entity_by_canonical", {
      p_canonical_name: canonical,
      p_entity_type:    entityType,
      p_state:          null,
    });
    if (error) {
      console.warn(`  [edgar/companies] resolve_entity_by_canonical(${canonical}, ${entityType}): ${error.message}`);
      continue;
    }
    if (data) return data as string;
  }
  return null;
}

async function insertCorporationEntity(
  db: Db,
  meta: CompanyMeta,
  canonical: string,
  cik: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("financial_entities")
    .insert({
      canonical_name:      canonical,
      display_name:        meta.name.slice(0, 255),
      entity_type:         "corporation",
      total_donated_cents: 0,
      total_received_cents: 0,
      metadata: {
        source:        "sec_edgar",
        sec_cik:       cik,
        sic:           meta.sic,
        state_of_inc:  meta.stateOfInc,
        former_names:  meta.formerNames,
      },
    })
    .select("id")
    .single();
  if (error) {
    console.warn(`  [edgar/companies] insertCorporationEntity(${canonical}): ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

async function upsertSourceRef(
  db: Db,
  cik: string,
  entityId: string,
): Promise<void> {
  const { error } = await db
    .from("external_source_refs")
    .upsert({
      source:       "sec_edgar",
      external_id:  cik,
      entity_type:  "financial_entity",
      entity_id:    entityId,
      source_url:   `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
      last_seen_at: new Date().toISOString(),
      metadata:     { kind: "company" },
    }, { onConflict: "source,external_id" });
  if (error) {
    console.warn(`  [edgar/companies] upsertSourceRef(${cik}): ${error.message}`);
  }
}

async function upsertEdgarCompany(
  db: Db,
  args: {
    cik: string;
    universe: UniverseEntry;
    meta: CompanyMeta;
    financialEntityId: string;
  },
): Promise<string | null> {
  const { cik, universe, meta, financialEntityId } = args;
  const canonical = canonicalizeEntityName(meta.name || universe.name);
  const { data, error } = await db
    .from("edgar_companies")
    .upsert({
      cik,
      ticker:              universe.ticker || null,
      name:                meta.name || universe.name,
      canonical_name:      canonical,
      sic_code:            meta.sic,
      state_of_inc:        meta.stateOfInc,
      sector:              universe.sector || null,
      financial_entity_id: financialEntityId,
      source_ids:          { sec_cik: cik },
      metadata: {
        former_names: meta.formerNames,
        ticker:       universe.ticker,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "cik" })
    .select("id")
    .single();
  if (error) {
    console.warn(`  [edgar/companies] upsertEdgarCompany(${cik}): ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

export async function syncCompanies(
  universe: UniverseEntry[],
  cikLimit?: Set<string>,
): Promise<CompanyRecord[]> {
  const db = createAdminClient() as Db;
  const bindings = await preloadCikBindings(db);
  const records: CompanyRecord[] = [];

  const scope = cikLimit
    ? universe.filter((u) => cikLimit.has(u.cik))
    : universe;

  let processed = 0;
  for (const entry of scope) {
    processed++;
    if (processed % 25 === 0) {
      console.log(`  [edgar/companies] ${processed}/${scope.length} processed`);
    }

    const cik = padCik(entry.cik);
    let meta: CompanyMeta | null;
    try {
      meta = await fetchSubmissions(cik);
    } catch (err) {
      console.warn(`  [edgar/companies] ${entry.ticker} (${cik}) submissions fetch failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (!meta) {
      console.warn(`  [edgar/companies] ${entry.ticker} (${cik}): no submissions JSON (404)`);
      continue;
    }

    const canonical = canonicalizeEntityName(meta.name || entry.name);

    let financialEntityId = bindings.get(cik) ?? null;
    if (!financialEntityId) {
      financialEntityId = await resolveCorporationEntityByCanonical(db, canonical);
      if (financialEntityId) {
        console.log(`  [edgar/companies] CIK ${cik} canonical-bound to existing entity ${financialEntityId} (canonical="${canonical}")`);
      } else {
        financialEntityId = await insertCorporationEntity(db, meta, canonical, cik);
      }
      if (financialEntityId) {
        await upsertSourceRef(db, cik, financialEntityId);
        bindings.set(cik, financialEntityId);
      }
    }

    if (!financialEntityId) {
      console.warn(`  [edgar/companies] ${entry.ticker} (${cik}): no financial_entity_id — skipping`);
      continue;
    }

    const edgarCompanyId = await upsertEdgarCompany(db, {
      cik,
      universe: entry,
      meta,
      financialEntityId,
    });
    if (!edgarCompanyId) continue;

    records.push({
      universe: entry,
      edgarCompanyId,
      financialEntityId,
      recentFilings: meta.recent,
    });
  }

  console.log(`  [edgar/companies] ${records.length}/${scope.length} companies synced`);
  return records;
}
