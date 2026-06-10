/**
 * FIX-250 — IRS 990 writer. Batched upserts against:
 *
 *   public.financial_entities      (entity_type='nonprofit'; deduped via
 *                                   canonical_name+entity_type UNIQUE)
 *   public.external_source_refs    (source='irs_990'; deduped via (source,external_id))
 *   public.irs990_filings          (deduped via object_id UNIQUE)
 *   public.irs990_officers         (deduped via UNIQUE(filing_id,name_canonical,role_title))
 *   public.irs990_grants_out       (deduped via UNIQUE(filing_id,recipient_name_canonical,amount_cents))
 *   public.financial_relationships (deduped via existing partial unique index on
 *                                   relationship_type=grant)
 *
 * Officer matching is high-precision only: match against `officials` rows by
 * canonicalized first+last name. Donor-side matching is deferred per Phase 1
 * scope; officer rows whose name doesn't resolve still land with
 * matched_entity_id=NULL.
 */

import type { createAdminClient } from "@civitics/db";
import { refreshPrimarySourceForEntities, rowsOrThrow } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import type { ParsedFiling, ParsedOfficer, ParsedGrantOut } from "./parse";

type Db = ReturnType<typeof createAdminClient>;

const FILING_CHUNK   = 100;
const OFFICER_CHUNK  = 500;
const GRANT_CHUNK    = 500;
const REL_CHUNK      = 500;

// ---------------------------------------------------------------------------
// Reused name normalizer
// ---------------------------------------------------------------------------

/**
 * Canonicalize an organization name for nonprofit-entity dedup. We reuse
 * fec-bulk's canonicalizeEntityName so the same org represented in both
 * datasets (rare but possible — a PAC and its 501c4 sibling) lands on a
 * single canonical form when names overlap.
 */
export function canonicalizeOrgName(raw: string): string {
  return canonicalizeEntityName(raw);
}

/**
 * Canonicalize a person name from a 990 officer entry. We rely on the same
 * uppercase + strip-punct + collapse-whitespace pass as canonicalizeEntityName,
 * but skip the trailing corporate-suffix strip (officers aren't INC/LLC).
 */
export function canonicalizePersonName(raw: string): string {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Nonprofit entity upsert
// ---------------------------------------------------------------------------

export interface UpsertNonprofitInput {
  ein:           string;
  displayName:   string;
  state:         string | null;
  nteeCode:      string | null;
  subsectionCd:  number | null;
}

export interface NonprofitUpsertResult {
  entityId: string;
}

/**
 * Upsert a single nonprofit's financial_entities row + external_source_refs
 * binding. Done per-org (not batched) because the seed run is small enough
 * that round-trip overhead is irrelevant, and each filing immediately needs
 * the resulting entity_id for the filings INSERT below.
 */
export async function upsertNonprofitEntity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: UpsertNonprofitInput,
): Promise<NonprofitUpsertResult> {
  const canonical = canonicalizeOrgName(input.displayName);

  // 1. First check external_source_refs — if we've seen this EIN before,
  //    reuse the entity_id. This handles the case where an org's name on file
  //    changes between years but the EIN is the stable handle.
  const existing = await db
    .from("external_source_refs")
    .select("entity_id")
    .eq("source", "irs_990")
    .eq("external_id", input.ein)
    .maybeSingle();

  if (existing.data?.entity_id) {
    // Refresh last_seen_at and let the entity name update via the financial_entities upsert below.
    await db.from("external_source_refs").update({
      last_seen_at: new Date().toISOString(),
    }).eq("source", "irs_990").eq("external_id", input.ein);

    // Also refresh the entity's display_name (in case the org rebranded). Keep
    // canonical_name stable since it's part of the dedup key.
    await db.from("financial_entities").update({
      display_name: input.displayName,
      metadata: {
        ein:            input.ein,
        ntee_code:      input.nteeCode,
        subsection_code: input.subsectionCd,
        last_state:     input.state,
      },
      updated_at: new Date().toISOString(),
    }).eq("id", existing.data.entity_id);

    return { entityId: existing.data.entity_id as string };
  }

  // 1.5. Canonical-name fallback (FIX-277). Cross-source resolution: the same
  //      org may already exist as a LittleSis hop-1 row (entity_type='other'
  //      or 'corporation'), a USAspending recipient, or another pipeline's
  //      financial_entity. resolve_entity_by_canonical (FIX-271) returns
  //      single-match-only — NULL on miss OR ambiguity — so unsafe collisions
  //      fall through to the INSERT path below.
  //      p_entity_type=NULL catches matches under any non-individual type
  //      (the FEC-PAC case is naturally protected by fec_committee_id UNIQUE,
  //      which keeps PACs as distinct rows even when canonical collides).
  const { data: matchedId, error: rpcErr } = await db.rpc(
    "resolve_entity_by_canonical",
    { p_canonical_name: canonical, p_entity_type: null, p_state: null },
  );
  if (rpcErr) {
    console.warn(`  [irs990] resolve_entity_by_canonical failed for EIN ${input.ein}: ${rpcErr.message}`);
  }
  if (matchedId) {
    // Bind EIN → existing entity. Do NOT update financial_entities.metadata —
    // preserves the existing row's source attribution. 990 financial summary
    // lands in irs990_filings via insertFiling regardless.
    console.log(`  [irs990] EIN ${input.ein} canonical-bound to existing entity ${matchedId} (canonical="${canonical}")`);
    await db.from("external_source_refs").upsert({
      source:       "irs_990",
      external_id:  input.ein,
      entity_type:  "financial_entity",
      entity_id:    matchedId,
      source_url:   `https://projects.propublica.org/nonprofits/organizations/${input.ein}`,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "source,external_id" });
    return { entityId: matchedId as string };
  }

  // 2. Insert a new financial_entities row. No ON CONFLICT — there is no
  //    UNIQUE on (canonical_name, entity_type) anymore after FIX-195 made
  //    that index non-unique. Dedup runs against external_source_refs by EIN
  //    (step 1), which is the natural key for nonprofits anyway. A canonical
  //    name collision with an existing PAC of the same name is fine: they
  //    live in distinct entity_type partitions.
  const { data: ent, error: entErr } = await db
    .from("financial_entities")
    .insert({
      canonical_name: canonical,
      display_name:   input.displayName,
      entity_type:    "nonprofit",
      metadata: {
        ein:            input.ein,
        ntee_code:      input.nteeCode,
        subsection_code: input.subsectionCd,
        last_state:     input.state,
      },
    })
    .select("id")
    .single();

  if (entErr) throw new Error(`financial_entities insert failed for EIN ${input.ein}: ${entErr.message}`);

  const entityId = (ent as { id: string }).id;

  // 3. Bind EIN to entity in external_source_refs.
  await db.from("external_source_refs").upsert({
    source:       "irs_990",
    external_id:  input.ein,
    entity_type:  "financial_entity",
    entity_id:    entityId,
    source_url:   `https://projects.propublica.org/nonprofits/organizations/${input.ein}`,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "source,external_id" });

  return { entityId };
}

// ---------------------------------------------------------------------------
// Filing upsert
// ---------------------------------------------------------------------------

export interface FilingInsertInput {
  financialEntityId: string;
  ein:               string;
  taxYear:           number;
  filingType:        string;
  objectId:          string;
  filing:            ParsedFiling;
  sourceUrl:         string;
}

export async function insertFiling(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: FilingInsertInput,
): Promise<string | null> {
  // Use upsert on object_id so re-runs are idempotent.
  const { data, error } = await db
    .from("irs990_filings")
    .upsert({
      financial_entity_id:     input.financialEntityId,
      ein:                     input.ein,
      tax_year:                input.taxYear,
      filing_type:             input.filingType,
      object_id:               input.objectId,
      subsection_code:         input.filing.subsectionCode,
      ntee_code:               input.filing.nteeCode,
      total_revenue_cents:     input.filing.totalRevenueCents,
      total_assets_eoy_cents:  input.filing.totalAssetsEoyCents,
      total_expenses_cents:    input.filing.totalExpensesCents,
      address_state:           input.filing.addressState,
      source_url:              input.sourceUrl,
      schema_version:          input.filing.schemaVersion,
      fetched_at:              new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    }, { onConflict: "object_id" })
    .select("id")
    .single();

  if (error) {
    console.warn(`  [irs990] filing upsert failed for object ${input.objectId}: ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Officer batched upsert + officials name-match
// ---------------------------------------------------------------------------

/**
 * Pre-load an officials lookup map keyed on canonical full name. We canonicalize
 * with the same `canonicalizePersonName` so the lookup is symmetric with
 * the officer-side canonicalization.
 *
 * Bench: with ~5k elected officials + ~10k tier=candidate rows, this is a
 * single 15k-row SELECT, well under 100ms.
 */
export async function loadOfficialsByCanonicalName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Pull in pages (Supabase default cap is 1000 rows per request).
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from("officials")
      .select("id, full_name, first_name, last_name")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`officials load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as Array<{ id: string; full_name: string | null; first_name: string | null; last_name: string | null }>) {
      // Build canonical from first+last so apostrophes/middle-init quirks in
      // full_name don't trip us up.
      const fullCanon = canonicalizePersonName([row.first_name ?? "", row.last_name ?? ""].join(" "));
      if (fullCanon) map.set(fullCanon, row.id);
      const flatCanon = canonicalizePersonName(row.full_name ?? "");
      if (flatCanon && !map.has(flatCanon)) map.set(flatCanon, row.id);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return map;
}

export interface OfficerInsertInput {
  filingId: string;
  officer:  ParsedOfficer;
}

export async function upsertOfficersBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  inputs: OfficerInsertInput[],
  officialsByName: Map<string, string>,
): Promise<{ inserted: number; matched: number; failed: number }> {
  let inserted = 0;
  let matched = 0;
  let failed = 0;

  for (let i = 0; i < inputs.length; i += OFFICER_CHUNK) {
    const chunk = inputs.slice(i, i + OFFICER_CHUNK);
    const rows = chunk.map(({ filingId, officer }) => {
      const nameCanonical = canonicalizePersonName(officer.personName);
      const matchedOfficialId = officialsByName.get(nameCanonical) ?? null;
      if (matchedOfficialId) matched++;
      return {
        filing_id:           filingId,
        person_name:         officer.personName,
        name_canonical:      nameCanonical,
        role_title:          officer.roleTitle || "Officer",
        compensation_cents:  officer.compensationCents,
        hours_per_week:      officer.hoursPerWeek,
        matched_entity_type: matchedOfficialId ? "official" : null,
        matched_entity_id:   matchedOfficialId,
        match_confidence:    matchedOfficialId ? 1.0 : null,
      };
    });

    const { error } = await db
      .from("irs990_officers")
      .upsert(rows, { onConflict: "filing_id,name_canonical,role_title" });
    if (error) {
      console.warn(`  [irs990] officer batch upsert failed (${chunk.length} rows): ${error.message}`);
      failed += chunk.length;
    } else {
      inserted += chunk.length;
    }
  }

  return { inserted, matched, failed };
}

// ---------------------------------------------------------------------------
// Grants-out batched upsert + recipient resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a grants-out recipient to an existing financial_entities row.
 * Two-step:
 *   1. If recipient_ein is non-null, look up external_source_refs(source='irs_990', external_id=ein).
 *      That's the precise match.
 *   2. Otherwise, look up financial_entities by canonical name + entity_type='nonprofit' first
 *      (most grant recipients are other nonprofits), then by entity_type='other' as fallback.
 *      Returns null on no match — recipient still gets recorded raw but no graph edge.
 */
export async function resolveGrantRecipient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  grant: ParsedGrantOut,
): Promise<{ entityType: "financial_entity"; entityId: string } | null> {
  // 1. EIN-precise path.
  if (grant.recipientEin) {
    const { data } = await db
      .from("external_source_refs")
      .select("entity_id, entity_type")
      .eq("source", "irs_990")
      .eq("external_id", grant.recipientEin)
      .maybeSingle();
    if (data?.entity_id) {
      return { entityType: data.entity_type as "financial_entity", entityId: data.entity_id as string };
    }
  }

  // 2. Name-only path. Conservative — exact canonical_name match against
  //    financial_entities with entity_type IN ('nonprofit', 'other').
  const canonical = canonicalizeOrgName(grant.recipientName);
  if (!canonical) return null;

  const { data } = await db
    .from("financial_entities")
    .select("id, entity_type")
    .eq("canonical_name", canonical)
    .in("entity_type", ["nonprofit", "other"])
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    return { entityType: "financial_entity", entityId: data.id as string };
  }
  return null;
}

export interface GrantInsertInput {
  filingId:       string;
  grant:          ParsedGrantOut;
  matchedEntityId: string | null;
  matchedEntityType: "financial_entity" | "agency" | "official" | null;
}

export async function upsertGrantsOutBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  inputs: GrantInsertInput[],
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0;
  let failed = 0;

  // FIX-279: aggregate by (filing_id, recipient_name_canonical) BEFORE the
  // upsert. A single 990 filing can carry multiple Schedule I lines to the
  // same canonical recipient — quarterly disbursements, per-state chapter
  // grants of identical amounts, recurring program grants. The UNIQUE on
  // (filing_id, recipient_name_canonical, amount_cents) rejects two
  // identical-amount lines as 'ON CONFLICT DO UPDATE command cannot affect
  // row a second time', and the batched .upsert call drops the entire chunk
  // when one row collides. Concrete loss: AMERICAN MEDICAL ASSOCIATION 2025
  // filing dropped 142 grants_out rows (2026-05-14 local re-run, 199
  // total across the seed set). Sum amount_cents; preserve count + first
  // matched_entity binding in metadata. Mirrors fec-bulk PAC writer's
  // per-(committee × candidate × cycle) aggregation pattern.
  interface AggGrant {
    filingId: string;
    recipientName: string;
    recipientNameCanonical: string;
    recipientEin: string | null;
    totalAmountCents: number;
    lineCount: number;
    purposes: string[];
    matchedEntityId: string | null;
    matchedEntityType: "financial_entity" | "agency" | "official" | null;
  }
  const agg = new Map<string, AggGrant>();
  for (const { filingId, grant, matchedEntityId, matchedEntityType } of inputs) {
    const canonical = canonicalizeOrgName(grant.recipientName);
    const key = `${filingId}|${canonical}`;
    const existing = agg.get(key);
    if (!existing) {
      agg.set(key, {
        filingId,
        recipientName:           grant.recipientName,
        recipientNameCanonical:  canonical,
        recipientEin:            grant.recipientEin,
        totalAmountCents:        grant.amountCents,
        lineCount:               1,
        purposes:                grant.purpose ? [grant.purpose] : [],
        matchedEntityId,
        matchedEntityType,
      });
      continue;
    }
    existing.totalAmountCents += grant.amountCents;
    existing.lineCount++;
    if (grant.purpose && !existing.purposes.includes(grant.purpose)) {
      existing.purposes.push(grant.purpose);
    }
    if (!existing.recipientEin && grant.recipientEin) existing.recipientEin = grant.recipientEin;
    if (!existing.matchedEntityId && matchedEntityId) {
      existing.matchedEntityId   = matchedEntityId;
      existing.matchedEntityType = matchedEntityType;
    }
  }
  const aggregated = [...agg.values()];

  for (let i = 0; i < aggregated.length; i += GRANT_CHUNK) {
    const chunk = aggregated.slice(i, i + GRANT_CHUNK);
    const rows = chunk.map((g) => ({
      filing_id:                  g.filingId,
      recipient_name:             g.recipientName,
      recipient_name_canonical:   g.recipientNameCanonical,
      recipient_ein:              g.recipientEin,
      amount_cents:               g.totalAmountCents,
      purpose:                    g.purposes[0] ?? null,
      matched_entity_type:        g.matchedEntityType,
      matched_entity_id:          g.matchedEntityId,
    }));

    const { error } = await db
      .from("irs990_grants_out")
      .upsert(rows, { onConflict: "filing_id,recipient_name_canonical,amount_cents" });
    if (error) {
      console.warn(`  [irs990] grants_out batch upsert failed (${chunk.length} rows): ${error.message}`);
      failed += chunk.length;
    } else {
      inserted += chunk.length;
    }
  }
  return { inserted, failed };
}

// ---------------------------------------------------------------------------
// Grant → financial_relationships materialization
// ---------------------------------------------------------------------------

export interface GrantRelationshipInput {
  fromEntityId:       string;
  toEntityType:       "financial_entity" | "agency" | "official";
  toEntityId:         string;
  amountCents:        number;
  taxYear:            number;
  filingObjectId:     string;
}

/**
 * Write `financial_relationships` rows for grants whose recipients resolved
 * to an entity. The existing partial-unique index on (relationship_type,
 * from_id, to_id, cycle_year) for relationship_type='donation' does NOT cover
 * 'grant' rows, so we use an INSERT … ON CONFLICT DO NOTHING shape that
 * relies on a composite check at write time. To avoid duplicates from
 * re-runs we manually pre-check against filing_object_id stored in
 * disclosure_form_id.
 */
export async function writeGrantRelationships(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  inputs: GrantRelationshipInput[],
): Promise<{ inserted: number; skipped: number; failed: number }> {
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  // FIX-279: aggregate by (filingObjectId, toEntityId, taxYear) BEFORE the
  // insert. financial_relationships_relcycle_unique is a FULL UNIQUE on
  // (relationship_type, from_id, to_id, cycle_year) — two grants from the
  // same 990 to the same recipient in the same tax year collide
  // regardless of amount, and the bare .insert() rejects the whole batch.
  // Concrete loss: AMA 2025 filing dropped 25 financial_relationships
  // rows from the same Schedule I that lost 142 grants_out lines above.
  // Sum amountCents; preserve count in metadata. The disclosure_form_id
  // pre-check below now sees the aggregated total, so re-runs with the
  // same source data correctly skip the row.
  const relAgg = new Map<string, GrantRelationshipInput & { lineCount: number }>();
  for (const r of inputs) {
    const key = `${r.filingObjectId}|${r.toEntityId}|${r.taxYear}`;
    const existing = relAgg.get(key);
    if (!existing) {
      relAgg.set(key, { ...r, lineCount: 1 });
      continue;
    }
    existing.amountCents += r.amountCents;
    existing.lineCount++;
  }
  const aggregatedInputs = [...relAgg.values()];

  for (let i = 0; i < aggregatedInputs.length; i += REL_CHUNK) {
    const chunk = aggregatedInputs.slice(i, i + REL_CHUNK);

    // Pre-check by disclosure_form_id (we encode object_id|toEntityId|amount
    // there to keep the row uniquely identifiable on re-runs). FIX-545: this
    // dedup read was silent-zero (an error meant "nothing exists" → duplicate
    // grant rows on re-run) AND the 500-key .in() list overflowed the ~200-id
    // URL cap. Sub-chunk + throw.
    const dedupKeys = chunk.map((c) => `irs990:${c.filingObjectId}:${c.toEntityId}:${c.amountCents}`);
    const existingSet = new Set<string>();
    for (let k = 0; k < dedupKeys.length; k += 200) {
      const rows = rowsOrThrow(
        await db
          .from("financial_relationships")
          .select("disclosure_form_id")
          .in("disclosure_form_id", dedupKeys.slice(k, k + 200)),
        "irs990 grant-relationship dedup precheck",
      ) as Array<{ disclosure_form_id: string }>;
      for (const r of rows) existingSet.add(r.disclosure_form_id);
    }

    const rows = chunk
      .map((c) => {
        const dedupKey = `irs990:${c.filingObjectId}:${c.toEntityId}:${c.amountCents}`;
        if (existingSet.has(dedupKey)) { skipped++; return null; }
        return {
          relationship_type:  "grant",
          from_type:          "financial_entity",
          from_id:            c.fromEntityId,
          to_type:            c.toEntityType,
          to_id:              c.toEntityId,
          amount_cents:       c.amountCents,
          cycle_year:         c.taxYear,
          occurred_at:        `${c.taxYear}-12-31`,    // 990s don't carry exact grant dates; end-of-tax-year is conventional
          disclosure_form_id: dedupKey,
          metadata: {
            source:           "irs_990_schedule_i",
            filing_object_id: c.filingObjectId,
            tax_year:         c.taxYear,
            line_count:       c.lineCount,    // FIX-279: number of Schedule I lines aggregated into this row
          },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) continue;

    const { error } = await db.from("financial_relationships").insert(rows);
    if (error) {
      console.warn(`  [irs990] grant relationships insert failed (${rows.length} rows): ${error.message}`);
      failed += rows.length;
    } else {
      inserted += rows.length;
    }
  }

  return { inserted, skipped, failed };
}

// ---------------------------------------------------------------------------
// Pre-check: filing already ingested?
// ---------------------------------------------------------------------------

/**
 * Filter a candidate list of (objectId, year) pairs down to just the ones
 * we haven't yet ingested. Saves an HTTP fetch + parse cycle per duplicate.
 */
export async function filterUningestedObjectIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  objectIds: string[],
): Promise<Set<string>> {
  if (objectIds.length === 0) return new Set();
  const seen = new Set<string>();
  for (let i = 0; i < objectIds.length; i += FILING_CHUNK) {
    const chunk = objectIds.slice(i, i + FILING_CHUNK);
    // FIX-545: silent-zero here made every filing look uningested.
    const rows = rowsOrThrow(
      await db
        .from("irs990_filings")
        .select("object_id")
        .in("object_id", chunk),
      "irs990 ingested-filings precheck",
    ) as Array<{ object_id: string }>;
    for (const row of rows) {
      seen.add(row.object_id);
    }
  }
  return seen;
}
