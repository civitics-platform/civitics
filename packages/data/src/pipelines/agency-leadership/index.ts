/**
 * Agency leadership pipeline — FIX-209 (extended).
 *
 * Pass 1: Wikidata SPARQL — fetches agency heads (P488) plus sub-Cabinet
 *   positions: deputy heads (P457), administrators (P3764), director generals
 *   (P6774), executive directors (P7628).
 *   Determines correct current holder per position group by sorting start dates
 *   DESC and inferring end dates for past holders who lack explicit P582, fixing
 *   the stale is_current bug (e.g. FCC showing Ajit Pai after Brendan Carr's
 *   start).
 *
 * Pass 2: Congress.gov nominations (current Congress) — Senate-confirmed
 *   officials. Authoritative for current-holder status.
 *
 * Stale-fix sweep: after each agency, any entity_connections still flagged
 *   is_current=true for officials not in the current-holder set are closed.
 */

import { createAdminClient, rowsOrThrow, selectAllOrThrow } from "@civitics/db";
import { completeSync, failSync, startSync, type PipelineResult } from "../sync-log";
import { sleep } from "../utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgencyRow {
  id: string;
  name: string;
  acronym: string | null;
  short_name: string | null;
  wikidata_id: string | null;
}

interface LeaderBinding {
  person: { value: string };
  personLabel: { value: string };
  posProperty: { value: string };
  start?: { value: string };
  end?: { value: string };
  posLabel?: { value: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const CUTOFF_YEAR = new Date().getFullYear() - 15;

const POSITION_PROP_LABELS: Record<string, string> = {
  P488: "Head",
  P457: "Deputy Head",
  P3764: "Administrator",
  P6774: "Director General",
  P7628: "Executive Director",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wikidata SPARQL — extended to include sub-Cabinet position properties
// ---------------------------------------------------------------------------

async function fetchAgencyLeaders(wikidataId: string): Promise<LeaderBinding[]> {
  const props = Object.keys(POSITION_PROP_LABELS);
  const unionBlocks = props
    .map(
      (prop) => `
  {
    wd:${wikidataId} p:${prop} ?stmt .
    ?stmt ps:${prop} ?person .
    BIND("${prop}" AS ?posProperty)
  }`
    )
    .join(" UNION ");

  const sparql = `
SELECT DISTINCT ?person ?personLabel ?posProperty ?start ?end ?posLabel WHERE {
  ${unionBlocks}
  OPTIONAL { ?stmt pq:P580 ?start }
  OPTIONAL { ?stmt pq:P582 ?end }
  OPTIONAL {
    ?stmt pq:P794 ?pos .
    ?pos rdfs:label ?posLabel FILTER(LANG(?posLabel) = "en")
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?posProperty DESC(?start)
LIMIT 50`.trim();

  const qs = new URLSearchParams({ query: sparql, format: "json" });
  const resp = await fetch(`${SPARQL_ENDPOINT}?${qs.toString()}`, {
    headers: {
      accept: "application/sparql-results+json",
      "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)",
    },
  });
  if (!resp.ok) throw new Error(`Wikidata SPARQL ${resp.status}`);
  const body = (await resp.json()) as { results?: { bindings?: LeaderBinding[] } };
  return body.results?.bindings ?? [];
}

// ---------------------------------------------------------------------------
// Stale is_current cleanup
// ---------------------------------------------------------------------------

async function closeStaleConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  agencyId: string,
  currentOfficialIds: Set<string>,
  today: string
): Promise<number> {
  if (currentOfficialIds.size === 0) return 0;

  // FIX-545: silent-zero here made a gateway blip read as "no stale
  // connections", skipping the is_current cleanup while the run looked clean.
  // FIX-692 (two parts):
  //  (1) filter on the real current-ness column (ended_at IS NULL), not
  //      metadata->>is_current — ended_at is what both this pipeline and the
  //      rebuild's career_history derivation write; the metadata JSON was
  //      fragile (empty across rebuild-written rows).
  //  (2) exclude the current holders IN MEMORY. The old
  //      `.not("from_id","in",(<list>))` inlined every current official id into
  //      the request URI, which overflowed Kong's URI limit (`URI too long`)
  //      once an agency had a few hundred current holders. Per-agency open
  //      appointment edges are bounded, so an in-memory anti-join is cheap and
  //      URI-safe.
  //  (3) scope to THIS pipeline's own evidence sources (wikidata +
  //      congress_nominations). Its current-holder set is only the Wikidata
  //      heads + Senate-confirmed cabinet, so an unscoped close clobbered the
  //      plum-book roster (deputies / Schedule C / SES) that plum-book had
  //      correctly marked current — 4,272 plum_book edges wrongly closed in one
  //      local run. plum-book already scopes to its own source; this mirrors it.
  const openConns = rowsOrThrow(
    await db
      .from("entity_connections")
      .select("id, from_id, metadata")
      .eq("to_type", "agency")
      .eq("to_id", agencyId)
      .eq("from_type", "official")
      .eq("connection_type", "appointment")
      .in("evidence_source", ["wikidata", "congress_nominations"])
      .is("ended_at", null),
    "agency-leadership stale-connections",
  ) as Array<{ id: string; from_id: string; metadata: Record<string, unknown> | null }>;

  const staleConns = openConns.filter((c) => !currentOfficialIds.has(c.from_id));
  if (!staleConns.length) return 0;

  let closed = 0;
  for (const conn of staleConns) {
    const updatedMeta = { ...(conn.metadata ?? {}), is_current: false };
    const { error } = await db
      .from("entity_connections")
      .update({ metadata: updatedMeta, ended_at: today, derived_at: new Date().toISOString() })
      .eq("id", conn.id);
    if (!error) closed++;
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Congress.gov nominations pass
// ---------------------------------------------------------------------------

function parseNomineeDescription(description: string): { name: string; positionTitle: string } | null {
  // Format: "First Last, of State, to be Title [, vice Predecessor]"
  const nameMatch = description.match(/^([^,]+),\s+of\s+/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  const posMatch = description.match(/\bto be\s+(.+?)(?:,\s+vice\s+|$)/i);
  if (!posMatch) return null;
  const positionTitle = posMatch[1]
    .trim()
    .replace(/,$/, "")
    .replace(/\s+for\s+a\s+term.*$/i, "")
    .trim();

  return { name, positionTitle };
}

async function runCongressNominationsPass(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  agencies: AgencyRow[],
  federalJurisdictionId: string | null,
  result: PipelineResult,
  today: string
): Promise<void> {
  const apiKey = process.env["CONGRESS_API_KEY"];
  if (!apiKey) {
    console.log("\n  Pass 2: Congress.gov nominations — SKIPPED (CONGRESS_API_KEY not set)");
    return;
  }

  // 119th Congress started 2025-01-03. Only nominations received after this date
  // represent current-term appointments. Older nominations may still appear in
  // API results despite the congress= filter, so we use receivedDate as a hard
  // cutoff to avoid treating historical commissioners as currently serving.
  const CURRENT_CONGRESS = 119;
  const CONGRESS_START_DATE = "2025-01-03";
  console.log(`\n  Pass 2: Congress.gov nominations (${CURRENT_CONGRESS}th Congress, on/after ${CONGRESS_START_DATE})`);

  // Agency lookup by normalized name
  const agencyByNormName = new Map<string, AgencyRow>();
  for (const agency of agencies) {
    agencyByNormName.set(normalizeName(agency.name), agency);
    if (agency.acronym) agencyByNormName.set(normalizeName(agency.acronym), agency);
    if (agency.short_name) agencyByNormName.set(normalizeName(agency.short_name), agency);
  }

  // Paginate all civilian nominations
  let offset = 0;
  const pageSize = 250;
  let hasMore = true;
  let totalFetched = 0;

  // Collect confirmed nominations per agency
  const confirmedByAgency = new Map<
    string,
    Array<{ name: string; nominationId: string; confirmedDate: string; positionTitle: string }>
  >();

  while (hasMore) {
    let nominations: unknown[] = [];
    try {
      const url = `https://api.congress.gov/v3/nomination?congress=${CURRENT_CONGRESS}&format=json&limit=${pageSize}&offset=${offset}&api_key=${apiKey}`;
      const resp = await fetch(url, { headers: { accept: "application/json" } });
      if (!resp.ok) {
        console.warn(`  Congress.gov: HTTP ${resp.status} at offset ${offset} — stopping`);
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await resp.json()) as any;
      nominations = body.nominations ?? [];
    } catch (err) {
      console.warn("  Congress.gov fetch error:", err instanceof Error ? err.message : err);
      break;
    }

    let pageHadRecentNominations = false;

    for (const nom of nominations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = nom as any;

      // Skip nominations predating the 119th Congress — the congress= filter
      // is unreliable; use receivedDate as a hard client-side cutoff.
      const receivedDate = (n.receivedDate ?? "") as string;
      if (receivedDate && receivedDate < CONGRESS_START_DATE) continue;
      pageHadRecentNominations = true;

      // Only civilian, non-privileged nominations
      if (!n.nominationType?.isCivilian) continue;
      if (n.isPrivileged) continue;

      // Only confirmed (Senate confirmed text in latest action)
      const actionText = ((n.latestAction?.text ?? "") as string).toLowerCase();
      if (!actionText.includes("confirmed")) continue;

      // Match to one of our agencies
      const orgNorm = normalizeName(n.organization ?? "");
      const matchedAgency = agencyByNormName.get(orgNorm);
      if (!matchedAgency) continue;

      // Parse nominee name and position from description
      const parsed = parseNomineeDescription(n.description ?? "");
      if (!parsed) continue;

      const nominationId = `${CURRENT_CONGRESS}-${n.number}-${n.partNumber ?? "00"}`;
      const confirmedDate = (n.latestAction?.actionDate ?? n.receivedDate ?? today) as string;

      const arr = confirmedByAgency.get(matchedAgency.id) ?? [];
      arr.push({
        name: parsed.name,
        nominationId,
        confirmedDate,
        positionTitle: parsed.positionTitle.slice(0, 200),
      });
      confirmedByAgency.set(matchedAgency.id, arr);
    }

    totalFetched += nominations.length;
    // If the entire page predated CONGRESS_START_DATE, all further pages will too
    if (nominations.length > 0 && !pageHadRecentNominations) {
      console.log(`    Reached nominations older than ${CONGRESS_START_DATE} — stopping pagination`);
      hasMore = false;
    } else {
      hasMore = nominations.length === pageSize;
    }
    offset += pageSize;
    await sleep(300);
  }

  console.log(
    `  Congress.gov: ${totalFetched} nominations scanned → confirmed matches for ${confirmedByAgency.size} agencies`
  );

  // Upsert officials and connections, then close stale
  for (const [agencyId, nominees] of confirmedByAgency) {
    const currentOfficialIds = new Set<string>();

    for (const { name, nominationId, confirmedDate, positionTitle } of nominees) {
      let officialId: string | undefined;

      // Look up by congress_nomination_id first
      const { data: byNomId } = await db
        .from("officials")
        .select("id")
        .filter("source_ids->>congress_nomination_id", "eq", nominationId)
        .maybeSingle();
      if (byNomId?.id) {
        officialId = byNomId.id as string;
      }

      if (!officialId) {
        // Fall back to name match. ilike with no wildcards = case-insensitive
        // equality. Was .eq(), which let "ADAM SCHEINMAN" and "Adam Scheinman"
        // land as separate officials rows (FIX-325).
        const { data: byName } = await db
          .from("officials")
          .select("id, source_ids")
          .ilike("full_name", name)
          .maybeSingle();
        if (byName?.id) {
          officialId = byName.id as string;
          // Add nomination ID to source_ids
          const updatedSourceIds = { ...(byName.source_ids ?? {}), congress_nomination_id: nominationId };
          await db
            .from("officials")
            .update({ source_ids: updatedSourceIds, is_active: true, updated_at: new Date().toISOString() })
            .eq("id", officialId);
        }
      }

      if (!officialId && federalJurisdictionId) {
        const { data: inserted, error: insErr } = await db
          .from("officials")
          .insert({
            full_name: name,
            role_title: positionTitle,
            is_active: true,
            jurisdiction_id: federalJurisdictionId,
            source_ids: { congress_nomination_id: nominationId },
            metadata: { source: "congress_nominations" },
          })
          .select("id")
          .single();
        if (insErr || !inserted?.id) {
          result.failed++;
          continue;
        }
        officialId = inserted.id as string;
        result.inserted++;
      }

      if (!officialId) continue;
      currentOfficialIds.add(officialId);

      // Upsert connection (Congress confirmation is authoritative — is_current=true)
      await db.from("entity_connections").upsert(
        {
          from_type: "official",
          from_id: officialId,
          to_type: "agency",
          to_id: agencyId,
          connection_type: "appointment",
          strength: 1.0,
          occurred_at: confirmedDate,
          evidence_source: "congress_nominations",
          metadata: {
            start_date: confirmedDate,
            end_date: null,
            position_title: positionTitle,
            position_property: "congress_confirmed",
            is_current: true,
            congress_nomination_id: nominationId,
          },
        },
        { onConflict: "from_type,from_id,to_type,to_id,connection_type", ignoreDuplicates: false }
      );
      result.updated++;
    }

    // Congress confirmations are authoritative — close stale connections
    if (currentOfficialIds.size > 0) {
      await closeStaleConnections(db, agencyId, currentOfficialIds, today);
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runAgencyLeadershipPipeline(): Promise<PipelineResult> {
  console.log("\n=== Agency leadership pipeline ===");

  const logId = await startSync("agency_leadership");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Load all federal agencies that have a wikidata_id
    const { data: agencyData, error: agErr } = await db
      .from("agencies")
      .select("id, name, acronym, short_name, wikidata_id")
      .eq("agency_type", "federal")
      .not("wikidata_id", "is", null);
    if (agErr) throw new Error(agErr.message);

    const agencies = (agencyData ?? []) as AgencyRow[];
    console.log(`  ${agencies.length} federal agencies with wikidata_id`);

    // Federal jurisdiction (fips_code='00')
    const { data: jurData } = await db
      .from("jurisdictions")
      .select("id")
      .eq("fips_code", "00")
      .maybeSingle();
    const federalJurisdictionId = jurData?.id as string | null;
    if (!federalJurisdictionId) {
      console.warn("  WARNING: federal jurisdiction (fips_code=00) not found — official inserts will be skipped");
    }

    // Build wikidata_id → official UUID map. FIX-545: silent-zero here meant
    // a failed preload re-inserted every leader as a new official; paginate
    // too — the wikidata-bound set grows with each agency pass.
    const existingOfficials = await selectAllOrThrow(
      "agency-leadership wikidata officials preload",
      (from, to) => db
        .from("officials")
        .select("id, source_ids")
        .not("source_ids->>wikidata_id", "is", null)
        .order("id")
        .range(from, to),
    ) as Array<{ id: string; source_ids: Record<string, string> | null }>;
    const officialByWdId = new Map<string, string>();
    for (const o of existingOfficials) {
      const wdId = (o.source_ids as Record<string, string> | null)?.wikidata_id;
      if (wdId) officialByWdId.set(wdId, o.id as string);
    }
    console.log(`  ${officialByWdId.size} officials with wikidata_id already in DB`);

    let noLeadersCount = 0;
    let totalStaleClosed = 0;

    // ── Pass 1: Wikidata ────────────────────────────────────────────────────
    console.log("\n  Pass 1: Wikidata SPARQL (P488 head + sub-Cabinet positions)");

    for (const agency of agencies) {
      if (!agency.wikidata_id) continue;

      let leaders: LeaderBinding[] = [];
      try {
        leaders = await fetchAgencyLeaders(agency.wikidata_id);
        await sleep(1200); // Wikidata rate limit: ~1 req/sec
      } catch (err) {
        console.warn(
          `  ${agency.acronym ?? agency.name}: SPARQL error:`,
          err instanceof Error ? err.message : err
        );
        result.failed++;
        await sleep(2000);
        continue;
      }

      // Filter to last 15 years
      const recent = leaders.filter((l) => {
        const endDate = parseDate(l.end?.value);
        if (!endDate) return true;
        return new Date(endDate).getFullYear() >= CUTOFF_YEAR;
      });

      if (recent.length === 0) {
        noLeadersCount++;
        if (federalJurisdictionId) {
          await db.rpc("enqueue_enrichment", {
            p_entity_id: agency.id,
            p_entity_type: "agency",
            p_task_type: "summary",
            p_context: { name: agency.name, acronym: agency.acronym, wikidata_id: agency.wikidata_id },
          });
        }
        continue;
      }

      // Group by position property; determine current holder per group
      const byProp = new Map<string, LeaderBinding[]>();
      for (const l of recent) {
        const prop = l.posProperty?.value ?? "P488";
        const arr = byProp.get(prop) ?? [];
        arr.push(l);
        byProp.set(prop, arr);
      }

      const currentOfficialIds = new Set<string>();

      for (const [positionProp, groupLeaders] of byProp) {
        // Sort most-recent start first (undefined start → treated as oldest)
        const sorted = [...groupLeaders].sort((a, b) => {
          const aStart = parseDate(a.start?.value) ?? "1900-01-01";
          const bStart = parseDate(b.start?.value) ?? "1900-01-01";
          return bStart.localeCompare(aStart);
        });

        // Current holder: only sorted[0] (most-recent start) can be current.
        // If they already have an explicit past end date the position's current
        // holder is not in this dataset — mark nobody current rather than
        // falling back to an older no-end-date entry (the Ajit Pai bug).
        let currentIdx = -1;
        const end0 = parseDate(sorted[0].end?.value);
        if (!end0 || new Date(end0) >= new Date()) {
          currentIdx = 0;
        }

        for (let i = 0; i < sorted.length; i++) {
          const leader = sorted[i];
          const explicitEnd = parseDate(leader.end?.value);
          const isCurrent = i === currentIdx;

          // For past holders with no explicit end date, infer end from the
          // more-recent holder's start date (sorted[i-1] is more recent).
          let effectiveEnd = explicitEnd;
          if (!explicitEnd && !isCurrent) {
            effectiveEnd = i > 0 ? (parseDate(sorted[i - 1].start?.value) ?? today) : today;
          }

          const personQid = leader.person.value.replace("http://www.wikidata.org/entity/", "");
          const fullName = leader.personLabel?.value ?? "Unknown";
          const propLabel = POSITION_PROP_LABELS[positionProp] ?? "Leader";
          const posTitle =
            leader.posLabel?.value ?? `${propLabel} of ${agency.acronym ?? agency.name}`;

          // ── Upsert official ────────────────────────────────────────────────
          let officialId = officialByWdId.get(personQid);

          if (!officialId) {
            if (!federalJurisdictionId) continue;

            const { data: insertedOfficial, error: insErr } = await db
              .from("officials")
              .insert({
                full_name: fullName,
                role_title: posTitle,
                is_active: isCurrent,
                jurisdiction_id: federalJurisdictionId,
                source_ids: { wikidata_id: personQid },
                metadata: { source: "wikidata_agency_leadership" },
              })
              .select("id")
              .single();

            if (insErr) {
              // Case-insensitive recovery lookup — same FIX-325 hardening as
              // the Congress-nominations branch above.
              const { data: found } = await db
                .from("officials")
                .select("id")
                .ilike("full_name", fullName)
                .maybeSingle();
              if (found?.id) {
                officialId = found.id as string;
                officialByWdId.set(personQid, officialId);
              } else {
                console.warn(`  ${fullName}: insert failed: ${insErr.message}`);
                result.failed++;
                continue;
              }
            } else if (insertedOfficial?.id) {
              officialId = insertedOfficial.id as string;
              officialByWdId.set(personQid, officialId);
              result.inserted++;
            }
          } else {
            await db
              .from("officials")
              .update({ is_active: isCurrent, role_title: posTitle, updated_at: new Date().toISOString() })
              .eq("id", officialId);
            result.updated++;
          }

          if (!officialId) continue;
          if (isCurrent) currentOfficialIds.add(officialId);

          // ── Upsert entity_connection ──────────────────────────────────────
          const { error: connErr } = await db.from("entity_connections").upsert(
            {
              from_type: "official",
              from_id: officialId,
              to_type: "agency",
              to_id: agency.id,
              connection_type: "appointment",
              strength: isCurrent ? 1.0 : 0.5,
              occurred_at: parseDate(leader.start?.value),
              ended_at: effectiveEnd,
              evidence_source: "wikidata",
              metadata: {
                start_date: parseDate(leader.start?.value),
                end_date: effectiveEnd,
                position_title: posTitle,
                position_property: positionProp,
                is_current: isCurrent,
                wikidata_source: personQid,
              },
            },
            { onConflict: "from_type,from_id,to_type,to_id,connection_type", ignoreDuplicates: false }
          );
          if (connErr) {
            console.warn(
              `  Connection upsert failed (${fullName}→${agency.acronym ?? agency.name}): ${connErr.message}`
            );
          }
        }
      }

      // Close any stale is_current=true connections for officials no longer current
      const staleClosed = await closeStaleConnections(db, agency.id, currentOfficialIds, today);
      totalStaleClosed += staleClosed;

      const staleNote = staleClosed > 0 ? `, ${staleClosed} stale closed` : "";
      console.log(`  ${agency.acronym ?? agency.name}: ${recent.length} leader(s) processed${staleNote}`);
    }

    console.log(`\n  ${noLeadersCount} agencies with no Wikidata leaders → enqueued for AI enrichment`);
    if (totalStaleClosed > 0) {
      console.log(`  ${totalStaleClosed} stale is_current connections corrected`);
    }

    // ── Pass 2: Congress.gov nominations ───────────────────────────────────
    await runCongressNominationsPass(db, agencies, federalJurisdictionId, result, today);

    await completeSync(logId, result);
    console.log(`\n  ✓ Done. Inserted: ${result.inserted}, updated: ${result.updated}, failed: ${result.failed}`);
    return result;
  } catch (err) {
    await failSync(logId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

if (require.main === module) {
  runAgencyLeadershipPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
