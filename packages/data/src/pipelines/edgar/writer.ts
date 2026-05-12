/**
 * FIX-253 · Batched writes for EDGAR ingest.
 *
 *   upsertOfficers          → public.edgar_executive_officers
 *   upsertShareholders      → public.edgar_major_shareholders
 *   upsertEdgarEdges        → public.external_relationships (source='edgar')
 *   upsertEdgarReviewQueue  → public.external_relationships_review_queue
 *   setOfficerMatch         → links a single officer row to a donor
 *   setShareholderMatch     → links a single shareholder row to a donor/org
 *
 * Edges use existing public.connection_type values:
 *   'appointment' for exec-of relationships (same value LittleSis cat 1 uses)
 *   'owns'        for major-shareholder relationships (same value LittleSis cat 10 uses)
 *
 * Block 10 of public.rebuild_entity_connections() already materializes from
 * external_relationships — no enum extension, no RPC change.
 */

import { createAdminClient } from "@civitics/db";
import type { ParsedOfficer } from "./def14a";
import type { ShareholderFiling, ShareholderHolder } from "./shareholders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const CHUNK = 500;

export interface OfficerWriteInput {
  companyId:               string;
  officer:                 ParsedOfficer;
}

export interface OfficerWriteResult {
  upserted: number;
  failed:   number;
  /** Newly-inserted or matched officer ids keyed by (companyId|canonicalName|year|roleCategory). */
  idMap:    Map<string, string>;
}

function officerKey(companyId: string, canonical: string, year: number, role: string): string {
  return `${companyId}|${canonical}|${year}|${role}`;
}

export async function upsertOfficers(inputs: OfficerWriteInput[]): Promise<OfficerWriteResult> {
  const db = createAdminClient() as Db;
  const idMap = new Map<string, string>();
  let upserted = 0;
  let failed   = 0;
  if (inputs.length === 0) return { upserted, failed, idMap };

  const records = inputs.map(({ companyId, officer }) => ({
    company_id:                companyId,
    full_name:                 officer.fullName.slice(0, 255),
    canonical_name:            officer.canonicalName,
    title:                     (officer.title ?? "").slice(0, 255),
    role_category:             officer.roleCategory,
    source_filing_type:        officer.sourceFilingType,
    source_accession:          officer.sourceAccession,
    effective_year:            officer.effectiveYear,
    total_compensation_cents:  officer.totalCompensationCents,
    source_ids:                { accession: officer.sourceAccession },
    metadata:                  { title_raw: officer.title },
    updated_at:                new Date().toISOString(),
  }));

  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("edgar_executive_officers")
      .upsert(chunk, { onConflict: "company_id,canonical_name,effective_year,role_category" })
      .select("id, company_id, canonical_name, effective_year, role_category");
    if (error) {
      console.error(`  [edgar/writer] officers chunk ${i}-${i + chunk.length} failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    upserted += chunk.length;
    for (const row of (data ?? []) as Array<{ id: string; company_id: string; canonical_name: string; effective_year: number; role_category: string }>) {
      idMap.set(
        officerKey(row.company_id, row.canonical_name, row.effective_year, row.role_category),
        row.id,
      );
    }
  }
  return { upserted, failed, idMap };
}

export interface ShareholderWriteInput {
  companyId:           string;
  holder:              ShareholderHolder;
  filing:              ShareholderFiling;
}

export interface ShareholderWriteResult {
  upserted: number;
  failed:   number;
  /** Newly-inserted or matched shareholder ids keyed by (accession|canonical). */
  idMap:    Map<string, string>;
}

function shareholderKey(accession: string, canonical: string): string {
  return `${accession}|${canonical}`;
}

export async function upsertShareholders(inputs: ShareholderWriteInput[]): Promise<ShareholderWriteResult> {
  const db = createAdminClient() as Db;
  const idMap = new Map<string, string>();
  let upserted = 0;
  let failed = 0;
  if (inputs.length === 0) return { upserted, failed, idMap };

  const records = inputs.map(({ companyId, holder, filing }) => ({
    company_id:             companyId,
    holder_name:            holder.holderName.slice(0, 255),
    canonical_holder_name:  holder.canonicalHolderName,
    filing_type:            filing.filingType,
    accession:              filing.accession,
    filed_at:               filing.filedAt,
    event_date:             holder.eventDate,
    pct_of_class:           holder.pctOfClass,
    shares_held:            holder.sharesHeld,
    source_ids:             { accession: filing.accession },
    metadata:               { is_organization: holder.isOrganization },
    updated_at:             new Date().toISOString(),
  }));

  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("edgar_major_shareholders")
      .upsert(chunk, { onConflict: "accession,canonical_holder_name" })
      .select("id, accession, canonical_holder_name");
    if (error) {
      console.error(`  [edgar/writer] shareholders chunk ${i}-${i + chunk.length} failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    upserted += chunk.length;
    for (const row of (data ?? []) as Array<{ id: string; accession: string; canonical_holder_name: string }>) {
      idMap.set(shareholderKey(row.accession, row.canonical_holder_name), row.id);
    }
  }
  return { upserted, failed, idMap };
}

export interface EdgeInput {
  source_id:         string;          // e.g. "officer:{uuid}" or "shareholder:{uuid}"
  source_url:        string | null;
  from_entity_id:    string;          // financial_entities.id (donor or org)
  to_entity_id:      string;          // financial_entities.id (company)
  connection_type:   "appointment" | "owns";
  raw_category:      string;          // "def14a_officer" | "sc_13d_holder" | "sc_13g_holder"
  raw_category_name: string;          // e.g. role title or filing type
  description:       string | null;
  amount_cents:      number | null;
  occurred_at:       string | null;
  ended_at:          string | null;
  is_current:        boolean | null;
  match_confidence:  "high" | "medium";
  metadata:          Record<string, unknown>;
}

export async function upsertEdgarEdges(edges: EdgeInput[]): Promise<{ upserted: number; failed: number }> {
  const db = createAdminClient() as Db;
  let upserted = 0;
  let failed   = 0;
  if (edges.length === 0) return { upserted, failed };

  const records = edges.map((e) => ({
    source:            "edgar",
    source_id:         e.source_id,
    source_url:        e.source_url,
    source_updated_at: new Date().toISOString(),
    from_type:         "financial_entity",
    from_id:           e.from_entity_id,
    to_type:           "financial_entity",
    to_id:             e.to_entity_id,
    connection_type:   e.connection_type,
    raw_category:      e.raw_category,
    raw_category_name: e.raw_category_name,
    description:       e.description,
    amount_cents:      e.amount_cents,
    occurred_at:       e.occurred_at,
    ended_at:          e.ended_at,
    is_current:        e.is_current,
    match_confidence:  e.match_confidence,
    metadata:          e.metadata,
  }));

  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { error } = await db
      .from("external_relationships")
      .upsert(chunk, { onConflict: "source,source_id" });
    if (error) {
      console.error(`  [edgar/writer] edges chunk ${i}-${i + chunk.length} failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    upserted += chunk.length;
  }
  return { upserted, failed };
}

export interface ReviewQueueInput {
  source_entity_id:       string;     // e.g. "officer:{uuid}"
  source_payload:         Record<string, unknown>;
  candidate_matches:      Array<Record<string, unknown>>;
  reason:                 string;
}

export async function upsertEdgarReviewQueue(rows: ReviewQueueInput[]): Promise<{ upserted: number; failed: number }> {
  const db = createAdminClient() as Db;
  let upserted = 0;
  let failed   = 0;
  if (rows.length === 0) return { upserted, failed };

  // Set source_relationship_id = source_entity_id so re-runs collide on the
  // UNIQUE(source, source_entity_id, source_relationship_id) constraint.
  // The constraint treats NULLs as distinct under default Postgres semantics,
  // so a NULL relationship_id would let every re-run grow the queue.
  const records = rows.map((r) => ({
    source:                 "edgar",
    source_entity_id:       r.source_entity_id,
    source_relationship_id: r.source_entity_id,
    source_payload:         r.source_payload,
    candidate_matches:      r.candidate_matches,
    reason:                 r.reason,
    status:                 "pending",
  }));

  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { error } = await db
      .from("external_relationships_review_queue")
      .upsert(chunk, { onConflict: "source,source_entity_id,source_relationship_id" });
    if (error) {
      // NULL component in the conflict target — fall back to insert-if-not-exists.
      const { error: err2 } = await db
        .from("external_relationships_review_queue")
        .insert(chunk);
      if (err2 && !String(err2.message ?? "").includes("duplicate key")) {
        console.warn(`  [edgar/writer] review_queue chunk failed: ${err2.message}`);
        failed += chunk.length;
        continue;
      }
    }
    upserted += chunk.length;
  }
  return { upserted, failed };
}

export async function setOfficerMatch(
  officerId: string,
  financialEntityId: string,
  confidence: "high" | "medium",
): Promise<void> {
  const db = createAdminClient() as Db;
  await db
    .from("edgar_executive_officers")
    .update({
      financial_entity_id: financialEntityId,
      match_confidence:    confidence,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", officerId);
}

export async function setShareholderMatch(
  shareholderId: string,
  financialEntityId: string,
  confidence: "high" | "medium",
): Promise<void> {
  const db = createAdminClient() as Db;
  await db
    .from("edgar_major_shareholders")
    .update({
      financial_entity_id: financialEntityId,
      match_confidence:    confidence,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", shareholderId);
}
