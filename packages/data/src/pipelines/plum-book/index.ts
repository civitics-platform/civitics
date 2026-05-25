/**
 * OPM PLUM Book pipeline — FIX-215.
 *
 * Source: OpenSanctions us_plum_book dataset (daily mirror of OPM PLUM data).
 * Covers ~9,000 Senate-confirmed, presidential, Schedule C, and senior SES
 * positions across all federal agencies — more complete than Congress.gov
 * nominations (which only covers Senate-confirmed) or Wikidata (sparse).
 *
 * FTM entity schema (NDJSON, one entity per line):
 *   Person     — the appointee (name, plum entity id)
 *   Position   — the position title, agency embedded as last comma-segment
 *   Occupancy  — links Person ↔ Position with status/startDate/endDate
 *
 * Version check: HEAD request on the daily file; if Last-Modified / ETag
 * is unchanged since last run (stored in pipeline_state), the pipeline is
 * a no-op. Pass --force to bypass.
 *
 * Run:
 *   pnpm --filter @civitics/data data:plum-book
 *   pnpm --filter @civitics/data data:plum-book -- --force
 */

import { createAdminClient } from "@civitics/db";
import { completeSync, failSync, startSync, type PipelineResult } from "../sync-log";

// ---------------------------------------------------------------------------
// FTM types
// ---------------------------------------------------------------------------

interface FtmEntity {
  id: string;
  schema: string;
  properties: Record<string, string[]>;
}

interface ParsedEntities {
  persons:     Map<string, FtmEntity>;
  positions:   Map<string, FtmEntity>;
  occupancies: FtmEntity[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FTM_URL =
  "https://data.opensanctions.org/datasets/latest/us_plum_book/entities.ftm.json";

// Only ingest occupancies that ended on or after this date (plus all current).
// Covers the full Biden + Trump-47 administrations.
const HISTORICAL_CUTOFF = "2021-01-20";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstProp(entity: FtmEntity, prop: string): string | null {
  return entity.properties[prop]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Version check — uses index.json last_change, not ETag.
// OpenSanctions re-exports daily but last_change only advances when OPM
// actually updates the underlying data (often weeks apart).
// ---------------------------------------------------------------------------

const INDEX_URL =
  "https://data.opensanctions.org/datasets/latest/us_plum_book/index.json";

interface DatasetIndex {
  last_change?: string;   // ISO datetime when OPM data last changed
  updated_at?:  string;   // ISO datetime of latest export (advances daily)
  version?:     string;   // opaque version string
}

async function fetchDatasetIndex(): Promise<DatasetIndex | null> {
  try {
    const resp = await fetch(INDEX_URL, {
      headers: { "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DatasetIndex;
  } catch {
    return null;
  }
}

interface StoredState {
  last_change: string | null;  // OPM data change date (version key)
  export_date: string | null;  // last export date (display only)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStoredState(db: any): Promise<StoredState> {
  try {
    const { data } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", "plum_book_state")
      .maybeSingle();
    const v = data?.value as Record<string, string> | null;
    return { last_change: v?.last_change ?? null, export_date: v?.export_date ?? null };
  } catch {
    return { last_change: null, export_date: null };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function storeState(db: any, idx: DatasetIndex): Promise<void> {
  try {
    await db
      .from("pipeline_state")
      .upsert(
        {
          key: "plum_book_state",
          value: {
            last_change: idx.last_change ?? null,
            export_date: idx.updated_at  ?? null,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Download + parse NDJSON
// ---------------------------------------------------------------------------

async function downloadAndParse(): Promise<ParsedEntities & { bytes: number }> {
  const resp = await fetch(FTM_URL, {
    headers: { "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)" },
  });
  if (!resp.ok) throw new Error(`OpenSanctions HTTP ${resp.status}`);

  const text = await resp.text();
  const bytes = Buffer.byteLength(text, "utf8");

  const persons     = new Map<string, FtmEntity>();
  const positions   = new Map<string, FtmEntity>();
  const occupancies: FtmEntity[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entity = JSON.parse(trimmed) as FtmEntity;
      if (entity.schema === "Person")     { persons.set(entity.id, entity);   continue; }
      if (entity.schema === "Position")   { positions.set(entity.id, entity); continue; }
      if (entity.schema === "Occupancy")  { occupancies.push(entity);         continue; }
    } catch {
      // skip malformed lines
    }
  }

  return { persons, positions, occupancies, bytes };
}

// ---------------------------------------------------------------------------
// Agency matching
// ---------------------------------------------------------------------------

interface AgencyRecord {
  id: string;
  name: string;
  acronym: string | null;
  short_name: string | null;
}

function buildAgencyLookup(agencies: AgencyRecord[]): Map<string, AgencyRecord> {
  const m = new Map<string, AgencyRecord>();
  for (const a of agencies) {
    m.set(normalizeName(a.name), a);
    if (a.short_name) m.set(normalizeName(a.short_name), a);
    if (a.acronym)    m.set(normalizeName(a.acronym), a);
  }
  return m;
}

/**
 * Agency name is always the last comma-delimited segment of the position name:
 *   "CHAIR, FEDERAL COMMUNICATIONS COMMISSION"
 *   → "FEDERAL COMMUNICATIONS COMMISSION"
 *
 * Falls back to combining 2 then 3 trailing segments for edge cases like
 * multi-part sub-components that span a comma.
 *
 * Also returns the position title with the agency suffix stripped.
 */
function matchPosition(
  positionName: string,
  agencyLookup: Map<string, AgencyRecord>
): { agency: AgencyRecord; posTitle: string } | null {
  const parts = positionName.split(", ");
  for (let take = 1; take <= Math.min(3, parts.length - 1); take++) {
    const suffix   = parts.slice(parts.length - take).join(", ");
    const match    = agencyLookup.get(normalizeName(suffix));
    if (match) {
      const posTitle = parts.slice(0, parts.length - take).join(", ") || positionName;
      return { agency: match, posTitle };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stale is_current cleanup (plum_book source only)
// ---------------------------------------------------------------------------

async function closeStaleConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  agencyId: string,
  currentOfficialIds: Set<string>,
  today: string
): Promise<number> {
  if (currentOfficialIds.size === 0) return 0;

  const inList = [...currentOfficialIds].join(",");
  const { data: staleConns } = await db
    .from("entity_connections")
    .select("id, metadata")
    .eq("to_type", "agency")
    .eq("to_id", agencyId)
    .eq("from_type", "official")
    .eq("connection_type", "appointment")
    .eq("evidence_source", "plum_book")
    .filter("metadata->>is_current", "eq", "true")
    .not("from_id", "in", `(${inList})`);

  if (!staleConns?.length) return 0;

  let closed = 0;
  for (const conn of staleConns) {
    const { error } = await db
      .from("entity_connections")
      .update({
        metadata:   { ...(conn.metadata ?? {}), is_current: false },
        ended_at:   today,
        derived_at: new Date().toISOString(),
      })
      .eq("id", conn.id);
    if (!error) closed++;
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runPlumBookPipeline(opts: { force?: boolean } = {}): Promise<PipelineResult> {
  console.log("\n=== OPM PLUM Book pipeline ===");

  const logId  = await startSync("plum_book");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db     = createAdminClient() as any;
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
  const today  = new Date().toISOString().slice(0, 10);
  const force  = opts.force ?? process.argv.includes("--force");

  try {
    // ── Version check (compare last_change, not ETag) ─────────────────────
    const datasetIdx = await fetchDatasetIndex();
    const lastChange = datasetIdx?.last_change ?? null;

    if (lastChange && !force) {
      const stored = await getStoredState(db);
      if (stored.last_change === lastChange) {
        console.log(`  No new OPM data since ${lastChange} — skipping`);
        await completeSync(logId, result);
        return result;
      }
      console.log(`  OPM data changed: ${lastChange} (was ${stored.last_change ?? "never run"})`);
    } else if (force) {
      console.log(`  --force: skipping version check${lastChange ? ` (OPM data: ${lastChange})` : ""}`);
    } else {
      console.log("  Could not fetch dataset index — proceeding anyway");
    }

    // Use the OPM last_change date as the authoritative source_date for all
    // connections written this run. Falls back to today if index unavailable.
    const sourceDate = lastChange?.slice(0, 10) ?? today;

    // ── Download + parse ───────────────────────────────────────────────────
    console.log("  Downloading entities.ftm.json...");
    const { persons, positions, occupancies, bytes } = await downloadAndParse();
    result.estimatedMb = +(bytes / 1024 / 1024).toFixed(2);
    console.log(
      `  Parsed: ${persons.size.toLocaleString()} persons, ` +
      `${positions.size.toLocaleString()} positions, ` +
      `${occupancies.length.toLocaleString()} occupancies ` +
      `(${result.estimatedMb} MB)`
    );

    // ── Load agencies ──────────────────────────────────────────────────────
    const { data: agencyData, error: agErr } = await db
      .from("agencies")
      .select("id, name, acronym, short_name")
      .eq("agency_type", "federal");
    if (agErr) throw new Error(agErr.message);

    const agencies     = (agencyData ?? []) as AgencyRecord[];
    const agencyLookup = buildAgencyLookup(agencies);
    console.log(`  ${agencies.length} federal agencies in lookup`);

    // ── Federal jurisdiction ───────────────────────────────────────────────
    const { data: jurData } = await db
      .from("jurisdictions")
      .select("id")
      .eq("fips_code", "00")
      .maybeSingle();
    const federalJurisdictionId = jurData?.id as string | null;
    if (!federalJurisdictionId) {
      console.warn("  WARNING: federal jurisdiction (fips_code=00) not found — inserts will be skipped");
    }

    // ── Build official lookup by plum_id (paginated) ──────────────────────
    // PostgREST db-max-rows=1000 cannot be overridden client-side. Paginate
    // explicitly to load all officials regardless of total count.
    const officialByPlumId = new Map<string, string>();
    {
      let page = 0;
      const PAGE = 1000;
      while (true) {
        const { data: batch } = await db
          .from("officials")
          .select("id, source_ids")
          .not("source_ids->>plum_id", "is", null)
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (!batch || batch.length === 0) break;
        for (const o of batch) {
          const plumId = (o.source_ids as Record<string, string> | null)?.plum_id;
          if (plumId) officialByPlumId.set(plumId, o.id as string);
        }
        if (batch.length < PAGE) break;
        page++;
      }
    }
    console.log(`  ${officialByPlumId.size} officials with plum_id already in DB`);

    // ── Filter occupancies ─────────────────────────────────────────────────
    const relevant = occupancies.filter((occ) => {
      if (firstProp(occ, "status") === "current") return true;
      const end = firstProp(occ, "endDate");
      return !!end && end >= HISTORICAL_CUTOFF;
    });
    console.log(`  ${relevant.length.toLocaleString()} relevant occupancies (current + ended ≥ ${HISTORICAL_CUTOFF})`);

    // ── Phase 1: Resolve occupancies in-memory (no DB) ────────────────────
    interface ResolvedOcc {
      personId:        string;
      positionId:      string;
      personName:      string;
      agencyId:        string;
      posTitle:        string;
      isCurrent:       boolean;
      startDate:       string | null;
      endDate:         string | null;
      appointmentType: string | null;
    }

    const resolved: ResolvedOcc[] = [];
    let matched = 0, unmatched = 0;

    for (const occ of relevant) {
      const personId   = firstProp(occ, "holder");
      const positionId = firstProp(occ, "post");
      if (!personId || !positionId) continue;
      const person   = persons.get(personId);
      const position = positions.get(positionId);
      if (!person || !position) continue;
      const positionName = firstProp(position, "name");
      if (!positionName) continue;
      const hit = matchPosition(positionName, agencyLookup);
      if (!hit) { unmatched++; continue; }
      matched++;
      resolved.push({
        personId, positionId,
        personName:      firstProp(person, "name") ?? "Unknown",
        agencyId:        hit.agency.id,
        posTitle:        hit.posTitle,
        isCurrent:       firstProp(occ, "status") === "current",
        startDate:       firstProp(occ, "startDate"),
        endDate:         firstProp(occ, "endDate"),
        appointmentType: firstProp(occ, "description"),
      });
    }

    console.log(`  Agency matches: ${matched.toLocaleString()}, unmatched: ${unmatched.toLocaleString()}`);

    // ── Phase 2: Name-lookup for unknown persons (targeted, paginated) ─────
    // PostgREST db-max-rows=1000 means fetching all officials is impossible
    // client-side. Instead: collect only the names we actually need, then
    // query in ilike batches (case-insensitive, PLUM names are ALL CAPS).
    //
    // FIX-325: normalize the lookup key with trim + collapsed-whitespace
    // alongside the existing case-fold so "Adam  Scheinman" (two spaces) and
    // "Adam Scheinman" (one) collapse to the same key. The DB column itself
    // stays as-source (display value preserved).
    const normNameKey = (s: string): string =>
      s.trim().toLowerCase().replace(/\s+/g, " ");
    const unknownNames = new Set<string>();
    for (const r of resolved) {
      if (!officialByPlumId.has(r.personId)) unknownNames.add(normNameKey(r.personName));
    }

    const officialByLowerName = new Map<
      string,
      { id: string; source_ids: Record<string, string> | null }
    >();
    // Batch ilike queries: PostgREST supports `.in()` on normal columns, but
    // for case-insensitive we need ilike. Use paginated OR queries in chunks.
    const nameArr = [...unknownNames];
    const NAME_BATCH = 50;
    for (let i = 0; i < nameArr.length; i += NAME_BATCH) {
      const chunk = nameArr.slice(i, i + NAME_BATCH);
      // Build OR filter: full_name.ilike.NAME1,full_name.ilike.NAME2,...
      const orFilter = chunk.map(n => `full_name.ilike.${n}`).join(",");
      const { data: batch } = await db
        .from("officials")
        .select("id, full_name, source_ids")
        .or(orFilter);
      for (const o of batch ?? []) {
        const key = normNameKey(o.full_name as string);
        if (!officialByLowerName.has(key)) {
          officialByLowerName.set(key, {
            id:         o.id as string,
            source_ids: o.source_ids as Record<string, string> | null,
          });
        }
      }
    }

    // ── Phase 3: Categorise unique persons ────────────────────────────────
    // known     — already in officialByPlumId (loaded at startup)
    // toLink    — found by name in allOfficials (from other pipelines)
    // toInsert  — not found anywhere, need batch insert
    interface NewOfficial {
      full_name:       string;
      role_title:      string;
      is_active:       boolean;
      jurisdiction_id: string;
      source_ids:      { plum_id: string };
      metadata:        { source: string; appointment_type: string | null };
      _plumId:         string; // stripped before DB call
    }
    interface LinkUpdate {
      id:                string;
      plumId:            string;
      existingSourceIds: Record<string, string> | null;
      isCurrent:         boolean;
      roleTitle:         string;
    }

    const toInsert: NewOfficial[] = [];
    const toLink:   LinkUpdate[]  = [];
    const seenPlumIds = new Set<string>();

    for (const r of resolved) {
      if (officialByPlumId.has(r.personId) || seenPlumIds.has(r.personId)) continue;
      seenPlumIds.add(r.personId);

      const byName = officialByLowerName.get(normNameKey(r.personName));
      if (byName) {
        officialByPlumId.set(r.personId, byName.id);
        toLink.push({
          id: byName.id, plumId: r.personId,
          existingSourceIds: byName.source_ids,
          isCurrent: r.isCurrent, roleTitle: r.posTitle.slice(0, 200),
        });
      } else {
        if (!federalJurisdictionId) continue;
        toInsert.push({
          full_name:       r.personName,
          role_title:      r.posTitle.slice(0, 200),
          is_active:       r.isCurrent,
          jurisdiction_id: federalJurisdictionId,
          source_ids:      { plum_id: r.personId },
          metadata:        { source: "plum_book", appointment_type: r.appointmentType },
          _plumId:         r.personId,
        });
      }
    }

    // Phase 3a: Batch insert new officials, get back IDs
    const OFFICIAL_BATCH = 500;
    for (let i = 0; i < toInsert.length; i += OFFICIAL_BATCH) {
      const batch = toInsert.slice(i, i + OFFICIAL_BATCH);
      const rows = batch.map(({ _plumId: _, ...row }) => row);
      const { data: ins, error } = await db
        .from("officials")
        .insert(rows)
        .select("id, source_ids");
      if (error) {
        result.failed += batch.length;
        console.warn(`  Official batch insert error: ${error.message}`);
        continue;
      }
      for (const o of ins ?? []) {
        const plumId = (o.source_ids as Record<string, string>).plum_id;
        if (plumId) { officialByPlumId.set(plumId, o.id as string); result.inserted++; }
      }
    }

    // Phase 3b: Update name-matched officials to add plum_id (individual —
    // these are few ~hundreds, from Wikidata/Congress pipelines)
    for (const u of toLink) {
      const { error } = await db
        .from("officials")
        .update({
          source_ids: { ...(u.existingSourceIds ?? {}), plum_id: u.plumId },
          is_active:  u.isCurrent,
          updated_at: new Date().toISOString(),
        })
        .eq("id", u.id);
      if (!error) result.updated++;
    }

    // ── Phase 4: Collect connections, then batch-upsert ───────────────────
    interface ConnectionRow {
      from_type: string; from_id: string;
      to_type: string;   to_id: string;
      connection_type: string;
      strength: number;
      occurred_at: string | null; ended_at: string | null;
      evidence_source: string;
      metadata: Record<string, unknown>;
    }

    // Deduplicate by unique key (from_type,from_id,to_type,to_id,connection_type).
    // A person can have multiple PLUM occupancies for the same agency — keep the
    // current one when present, otherwise the most recent by start date.
    const connMap = new Map<string, ConnectionRow>();
    const currentsByAgency = new Map<string, Set<string>>();

    for (const r of resolved) {
      const officialId = officialByPlumId.get(r.personId);
      if (!officialId) continue;

      if (r.isCurrent) {
        const s = currentsByAgency.get(r.agencyId) ?? new Set<string>();
        s.add(officialId);
        currentsByAgency.set(r.agencyId, s);
      }

      const row: ConnectionRow = {
        from_type: "official", from_id: officialId,
        to_type:   "agency",   to_id:   r.agencyId,
        connection_type: "appointment",
        strength:    r.isCurrent ? 1.0 : 0.5,
        occurred_at: r.startDate,
        ended_at:    r.endDate,
        evidence_source: "plum_book",
        metadata: {
          start_date:        r.startDate,
          end_date:          r.endDate,
          position_title:    r.posTitle.slice(0, 300),
          position_property: "plum_book",
          appointment_type:  r.appointmentType,
          is_current:        r.isCurrent,
          source_date:       sourceDate,
          plum_person_id:    r.personId,
          plum_position_id:  r.positionId,
        },
      };
      const key = `${officialId}|${r.agencyId}`;
      const existing = connMap.get(key);
      if (!existing || (!existing.metadata["is_current"] && r.isCurrent) ||
          (existing.metadata["is_current"] === r.isCurrent &&
           (r.startDate ?? "") > ((existing.metadata["start_date"] as string) ?? ""))) {
        connMap.set(key, row);
      }
    }
    const connections = [...connMap.values()];

    const CONNECTION_BATCH = 500;
    for (let i = 0; i < connections.length; i += CONNECTION_BATCH) {
      const batch = connections.slice(i, i + CONNECTION_BATCH);
      const { error } = await db
        .from("entity_connections")
        .upsert(batch, {
          onConflict:       "from_type,from_id,to_type,to_id,connection_type",
          ignoreDuplicates: false,
        });
      if (error) {
        console.warn(`  Connection batch upsert error: ${error.message}`);
        result.failed += batch.length;
      }
    }

    // ── Close stale is_current connections ────────────────────────────────
    let totalStaleClosed = 0;
    for (const [agencyId, currentIds] of currentsByAgency) {
      totalStaleClosed += await closeStaleConnections(db, agencyId, currentIds, today);
    }
    if (totalStaleClosed > 0) {
      console.log(`  Stale connections closed: ${totalStaleClosed}`);
    }

    // ── Persist version so next weekly run can skip if unchanged ──────────
    if (datasetIdx) await storeState(db, datasetIdx);

    await completeSync(logId, result);
    console.log(`\n  ✓ Done. Inserted: ${result.inserted}, updated: ${result.updated}, failed: ${result.failed}`);
    return result;
  } catch (err) {
    await failSync(logId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

if (require.main === module) {
  runPlumBookPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
