/**
 * CourtListener pipeline — post-cutover, batched writes to public.
 *
 * Part 1: Federal judges → public.officials
 *   Dedup via external_source_refs (source='courtlistener', entity_type='official').
 *   Existing judges from the pre-cutover run are backfilled into source_refs
 *   by migration 20260425000200.
 *
 * Part 2: Court opinions → public.proposals + public.case_details
 *   Dedup via external_source_refs (source='courtlistener', entity_type='proposal').
 *   Fetches top ~200 recent clusters per federal court (14 courts).
 *
 * Pre-cutover this wrote through shadowClient to shadow.*, which was dropped
 * at promotion. All writes are now direct to public via chunked upsert.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:courts
 */

import { createAdminClient } from "@civitics/db";
import { sleep, fetchJson, QuotaExhaustedError } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { slugifyGoverningBodies } from "../../lib/slugify-governing-bodies";
import {
  resolveJudicialGovBodies,
  upsertJudgesBatch,
  upsertOpinionsBatch,
  type JudgeInput,
  type OpinionInput,
} from "./writer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CLPosition {
  id:               number;
  court:            string;
  court_full_name:  string;
  position_type:    string;
  date_start:       string | null;
  date_termination: string | null;
  person: {
    id:         number;
    name_full:  string;
    name_first: string;
    name_last:  string;
    date_dob:   string | null;
  };
}

interface CLPositionList {
  count:   number;
  next:    string | null;
  results: CLPosition[];
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
  count:   number;
  next:    string | null;
  results: CLCluster[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CL_BASE = "https://www.courtlistener.com/api/rest/v4";

const FEDERAL_COURTS = [
  "scotus", "ca1", "ca2", "ca3", "ca4", "ca5",
  "ca6", "ca7", "ca8", "ca9", "ca10", "ca11", "cadc", "cafc",
];

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function clGet<T>(path: string, apiKey: string, params: Record<string, string> = {}): Promise<T> {
  await sleep(250);
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
): Promise<PipelineResult> {
  console.log("\n=== CourtListener pipeline (public) ===");
  const logId = await startSync("courtlistener");
  const db = createAdminClient();

  try {
    const courtGovBodyMap = await resolveJudicialGovBodies(db, federalId, FEDERAL_COURTS);
    console.log(`  Seeded/resolved ${courtGovBodyMap.size} judicial governing bodies`);

    // ── Part 1: Judges ───────────────────────────────────────────────────────
    console.log("\n  Fetching active federal judges...");
    const judgeInputs: JudgeInput[] = [];
    const judgesSeen = new Set<number>();
    let judgesQuotaHit = false;

    let nextUrl: string | null = null;
    let page = 1;
    do {
      let positions: CLPositionList;
      try {
        if (nextUrl) {
          await sleep(250);
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
        if (err instanceof QuotaExhaustedError) {
          console.warn(`  CourtListener daily quota exhausted on judges — stopping. Re-run tomorrow.`);
          judgesQuotaHit = true;
          break;
        }
        console.error(`  Judges page ${page}: fetch error —`, err instanceof Error ? err.message : err);
        break;
      }

      for (const pos of positions.results ?? []) {
        const personId = pos.person?.id;
        if (!personId || judgesSeen.has(personId)) continue;
        judgesSeen.add(personId);

        const person = pos.person;

        // CL v4 returns pos.court sometimes as a URL, sometimes as a nested
        // object — normalise to the final slug.
        const courtStr = String(typeof pos.court === "object" && pos.court !== null
          ? (pos.court as Record<string, unknown>)["id"] ?? ""
          : pos.court ?? "");
        const courtSlug = courtStr.split("/").filter(Boolean).pop() ?? courtStr;
        const governingBodyId = courtGovBodyMap.get(courtSlug)
          ?? [...courtGovBodyMap.values()][0]!;

        judgeInputs.push({
          courtlistenerPersonId: String(personId),
          fullName: person.name_full || `${person.name_first} ${person.name_last}`.trim(),
          firstName: person.name_first || null,
          lastName: person.name_last || null,
          governingBodyId,
          jurisdictionId: federalId,
          isActive: !pos.date_termination,
          termStart: pos.date_start ?? null,
          termEnd: pos.date_termination ?? null,
          metadata: {
            court: pos.court,
            court_full_name: pos.court_full_name,
            position_type: pos.position_type,
          },
        });
      }

      nextUrl = positions.next ?? null;
      page++;
      if (page > 20) break;
    } while (nextUrl);

    console.log(`  Judges: ${judgeInputs.length} fetched, batched upsert...`);
    const judgeRes = await upsertJudgesBatch(db, judgeInputs);
    console.log(`  Judges — inserted: ${judgeRes.inserted}, updated: ${judgeRes.updated}, failed: ${judgeRes.failed}`);

    // ── Part 2: Opinions (per-court, collected into one batch) ───────────────
    console.log("\n  Fetching recent court opinions...");
    const opinionInputs: OpinionInput[] = [];
    let opinionsQuotaHit = judgesQuotaHit;

    for (const courtId of FEDERAL_COURTS) {
      if (opinionsQuotaHit) break;
      console.log(`    Court: ${courtId}`);
      let nextClusters: string | null = null;

      for (let p = 1; p <= 2; p++) {
        let clusters: CLClusterList;
        try {
          if (nextClusters) {
            await sleep(250);
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
          if (err instanceof QuotaExhaustedError) {
            console.warn(`    CourtListener quota exhausted on clusters — stopping opinions phase.`);
            opinionsQuotaHit = true;
            break;
          }
          console.error(`    ${courtId} page ${p}: error —`, err instanceof Error ? err.message : err);
          break;
        }
        nextClusters = clusters.next ?? null;

        for (const cluster of clusters.results ?? []) {
          opinionInputs.push({
            clusterId: String(cluster.id),
            caseName: cluster.case_name,
            dateFiled: cluster.date_filed,
            courtId,
            opinionUrl: `https://www.courtlistener.com${cluster.absolute_url}`,
            syllabus: cluster.syllabus ?? "",
            scdbId: cluster.scdb_id ?? null,
            jurisdictionId: federalId,
          });
        }

        if ((clusters.results ?? []).length < 100 || !nextClusters) break;
      }
    }

    console.log(`\n  Opinions: ${opinionInputs.length} fetched, batched upsert...`);
    const opinionRes = await upsertOpinionsBatch(db, opinionInputs);
    console.log(`  Opinions — inserted: ${opinionRes.inserted}, updated: ${opinionRes.updated}, failed: ${opinionRes.failed}`);

    const totalInserted = judgeRes.inserted + opinionRes.inserted;
    const totalUpdated = judgeRes.updated + opinionRes.updated;
    const totalFailed = judgeRes.failed + opinionRes.failed;
    const estimatedMb = +(((totalInserted + totalUpdated) * 517) / 1024 / 1024).toFixed(2);
    const result: PipelineResult = {
      inserted: totalInserted,
      updated: totalUpdated,
      failed: totalFailed,
      estimatedMb,
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  CourtListener pipeline report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Judges inserted:".padEnd(32)} ${judgeRes.inserted}`);
    console.log(`  ${"Judges updated:".padEnd(32)} ${judgeRes.updated}`);
    console.log(`  ${"Judges failed:".padEnd(32)} ${judgeRes.failed}`);
    console.log(`  ${"Opinions inserted:".padEnd(32)} ${opinionRes.inserted}`);
    console.log(`  ${"Opinions updated:".padEnd(32)} ${opinionRes.updated}`);
    console.log(`  ${"Opinions failed:".padEnd(32)} ${opinionRes.failed}`);
    console.log(`  ${"Estimated storage:".padEnd(32)} ~${estimatedMb} MB`);
    if (opinionsQuotaHit) console.log(`  ${"Run ended on quota.".padEnd(32)}`);

    // FIX-492 — slugify ingest invariant: judicial gbs (resolveJudicialGovBodies)
    // inserted this run get their slug filled. Idempotent.
    await slugifyGoverningBodies(db);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  CourtListener pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["COURTLISTENER_API_KEY"];
  if (!apiKey) { console.error("COURTLISTENER_API_KEY not set"); process.exit(1); }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seedJurisdictions } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    const { federalId } = await seedJurisdictions(db);
    await runCourtListenerPipeline(apiKey, federalId);
  })()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
