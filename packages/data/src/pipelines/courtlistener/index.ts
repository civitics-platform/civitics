/**
 * CourtListener pipeline.
 *
 * 1. Fetches active federal judges from the positions endpoint and upserts
 *    them into the officials table.
 * 2. Fetches recent opinions from SCOTUS + 13 circuit courts (URL + metadata
 *    only — no full text) and upserts them into the proposals table.
 *
 * Storage target: ~20 MB
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:courts
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { sleep, fetchJson } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"];
type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];

interface CLPosition {
  id:               number;
  court:            string;           // court slug e.g. "scotus"
  court_full_name:  string;
  position_type:    string;
  date_start:       string | null;
  date_termination: string | null;
  person:           {
    id:             number;
    name_full:      string;
    name_first:     string;
    name_last:      string;
    date_dob:       string | null;
  };
}

interface CLPositionList {
  count:    number;
  next:     string | null;
  results:  CLPosition[];
}

interface CLCluster {
  id:           number;
  case_name:    string;
  date_filed:   string | null;
  court_id:     string;
  absolute_url: string;
  syllabus:     string | null;
  scdb_id:      string | null;
}

interface CLClusterList {
  count:    number;
  next:     string | null;
  results:  CLCluster[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CL_BASE = "https://www.courtlistener.com/api/rest/v4";

// Federal circuit courts + SCOTUS
const FEDERAL_COURTS = [
  "scotus", "ca1", "ca2", "ca3", "ca4", "ca5",
  "ca6", "ca7", "ca8", "ca9", "ca10", "ca11", "cadc", "cafc",
];

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function clGet<T>(path: string, apiKey: string, params: Record<string, string> = {}): Promise<T> {
  await sleep(100);
  const url = new URL(`${CL_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetchJson<T>(url.toString(), {
    headers: { Authorization: `Token ${apiKey}` },
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runCourtListenerPipeline(
  apiKey: string,
  federalId: string,
  federalGovBodyId: string
): Promise<PipelineResult> {
  console.log("\n=== CourtListener pipeline ===");
  const logId = await startSync("courtlistener");
  const db = createAdminClient();
  let inserted = 0, updated = 0, failed = 0;

  try {
    // -----------------------------------------------------------------------
    // Part 1: Federal judges → officials table
    // -----------------------------------------------------------------------

    console.log("  Fetching active federal judges...");
    let nextUrl: string | null = null;
    let page = 1;
    const judgesProcessed = new Set<number>(); // CL person IDs

    do {
      let positions: CLPositionList;
      try {
        if (nextUrl) {
          // nextUrl is a full URL — strip the base and re-add auth
          await sleep(100);
          positions = await fetchJson<CLPositionList>(nextUrl, {
            headers: { Authorization: `Token ${apiKey}` },
          });
        } else {
          positions = await clGet<CLPositionList>("positions/", apiKey, {
            court__jurisdiction: "F",
            position_type:       "jud",
            page_size:           "100",
            page:                String(page),
          });
        }
      } catch (err) {
        console.error(`  Judges page ${page}: fetch error —`, err instanceof Error ? err.message : err);
        break;
      }

      for (const pos of positions.results ?? []) {
        const personId = pos.person?.id;
        if (!personId || judgesProcessed.has(personId)) continue;
        judgesProcessed.add(personId);

        const person = pos.person;
        const clId = String(personId);

        const record: OfficialInsert = {
          full_name:        person.name_full || `${person.name_first} ${person.name_last}`.trim(),
          first_name:       person.name_first || null,
          last_name:        person.name_last || null,
          role_title:       "Federal Judge",
          governing_body_id: federalGovBodyId,
          jurisdiction_id:  federalId,
          is_active:        !pos.date_termination,
          is_verified:      false,
          term_start:       pos.date_start ?? null,
          term_end:         pos.date_termination ?? null,
          source_ids:       { courtlistener_person_id: clId },
          metadata:         { court: pos.court, court_full_name: pos.court_full_name, position_type: pos.position_type },
        };

        try {
          const { data: existing } = await db
            .from("officials")
            .select("id")
            .filter("source_ids->>courtlistener_person_id", "eq", clId)
            .maybeSingle();

          if (existing) {
            const { error } = await db.from("officials")
              .update({ ...record, updated_at: new Date().toISOString() })
              .eq("id", existing.id);
            if (error) { failed++; } else { updated++; }
          } else {
            const { error } = await db.from("officials").insert(record);
            if (error) { failed++; } else { inserted++; }
          }
        } catch (err) {
          console.error(`    Judge ${person.name_full}: error —`, err);
          failed++;
        }
      }

      nextUrl = positions.next ?? null;
      page++;
      if (page > 20) break; // hard cap ~2,000 judges
    } while (nextUrl);

    console.log(`  Judges — inserted: ${inserted}, updated: ${updated}`);
    const judgesInserted = inserted, judgesUpdated = updated;
    inserted = 0; updated = 0;

    // -----------------------------------------------------------------------
    // Part 2: Recent opinions → proposals table
    // -----------------------------------------------------------------------

    console.log("  Fetching recent court opinions...");

    for (const courtId of FEDERAL_COURTS) {
      console.log(`    Court: ${courtId}`);
      let nextClusters: string | null = null;
      let clusterPage = 0;

      for (let p = 1; p <= 2; p++) {  // 2 pages × 100 = 200 opinions per court
        let clusters: CLClusterList;
        clusterPage++;
        try {
          if (nextClusters) {
            await sleep(100);
            clusters = await fetchJson<CLClusterList>(nextClusters, {
              headers: { Authorization: `Token ${apiKey}` },
            });
          } else {
            clusters = await clGet<CLClusterList>("clusters/", apiKey, {
              docket__court: courtId,
              page_size:     "100",
            });
          }
        } catch (err) {
          console.error(`    ${courtId} page ${p}: error —`, err instanceof Error ? err.message : err);
          break;
        }
        nextClusters = clusters.next ?? null;

        for (const cluster of clusters.results ?? []) {
          const clId = String(cluster.id);
          const opinionUrl = `https://www.courtlistener.com${cluster.absolute_url}`;

          const record: ProposalInsert = {
            title:          (cluster.case_name || `Opinion ${clId}`).slice(0, 500),
            type:           "other",
            status:         "enacted",
            jurisdiction_id: federalId,
            introduced_at:  cluster.date_filed ?? null,
            last_action_at: cluster.date_filed ?? null,
            full_text_url:  opinionUrl,
            source_ids:     {
              courtlistener_cluster_id: clId,
              court_id: courtId,
              scdb_id: cluster.scdb_id ?? "",
            },
            metadata:       {
              court:     courtId,
              source:    "courtlistener",
              syllabus:  (cluster.syllabus ?? "").slice(0, 300),
            },
          };

          try {
            const { data: existing } = await db
              .from("proposals")
              .select("id")
              .filter("source_ids->>courtlistener_cluster_id", "eq", clId)
              .maybeSingle();

            if (existing) {
              const { error } = await db.from("proposals")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", existing.id);
              if (error) { failed++; } else { updated++; }
            } else {
              const { error } = await db.from("proposals").insert(record);
              if (error) { failed++; } else { inserted++; }
            }
          } catch (err) {
            console.error(`    Cluster ${clId}: error —`, err);
            failed++;
          }
        }

        if ((clusters.results ?? []).length < 100 || !nextClusters) break;
      }
    }

    inserted += judgesInserted;
    updated  += judgesUpdated;

    const estimatedMb = +((inserted + updated) * 517 / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.log(`  Done — inserted: ${inserted}, updated: ${updated}, failed: ${failed}`);
    console.log(`  Estimated storage: ~${estimatedMb} MB`);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  CourtListener pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted, updated, failed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["COURTLISTENER_API_KEY"];
  if (!apiKey) { console.error("COURTLISTENER_API_KEY not set"); process.exit(1); }

  const { seedJurisdictions, seedGoverningBodies } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    const { federalId } = await seedJurisdictions(db);
    const { senateId }  = await seedGoverningBodies(db, federalId);
    // Use Senate governing body as proxy for federal judiciary — good enough for Phase 1
    await runCourtListenerPipeline(apiKey, federalId, senateId);
  })()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
