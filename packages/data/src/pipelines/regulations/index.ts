/**
 * Regulations.gov pipeline — post-cutover, batched writes to public.
 *
 * Fetches Proposed Rule documents (open-for-comment + last 12 months of
 * posted rules) and upserts into `public.proposals` (type='regulation') via
 * the batched writer. Agency resolution is also batched; new acronyms land
 * in `public.agencies` automatically.
 *
 * Proposals dedup via `external_source_refs` (source='regulations_gov').
 * All regulations-specific fields live in `proposals.metadata` — the pre-
 * cutover `regulations_gov_id` / `comment_period_{start,end}` / `source_ids`
 * columns were dropped at promotion.
 *
 * Storage target: ~20 MB
 * Rate limit:     1,000 req/hour — 100ms delay between calls
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:regulations
 */

import { createAdminClient } from "@civitics/db";
import { sleep, fetchJson } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import {
  resolveAgencies,
  upsertRegulationProposalsBatch,
  type RegulationProposalInput,
} from "./writer";
import type { Database } from "@civitics/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegDoc {
  id: string;
  attributes: {
    title:              string;
    documentType:       string;
    agencyId:           string;
    docketId?:          string;
    postedDate?:        string;
    commentStartDate?:  string;
    commentEndDate?:    string;
    openForComment:     boolean;
    fileFormats?:       Array<{ fileUrl?: string; format?: string }>;
    objectId?:          string;
  };
}

interface RegListResponse {
  data: RegDoc[];
  meta: { totalElements: number; pageNumber: number; pageSize: number };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const REG_BASE = "https://api.regulations.gov/v4";
const PAGE_SIZE = 250;

async function fetchRegulationsPage(
  apiKey: string,
  params: Record<string, string>,
  page: number
): Promise<RegListResponse> {
  await sleep(100);
  const url = new URL(`${REG_BASE}/documents`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("page[size]", String(PAGE_SIZE));
  url.searchParams.set("page[number]", String(page));
  return fetchJson<RegListResponse>(url.toString(), {
    headers: { "X-Api-Key": apiKey },
  });
}

/** Fetch up to maxPages pages for a given filter. */
async function fetchAllDocuments(
  apiKey: string,
  params: Record<string, string>,
  maxPages = 8
): Promise<RegDoc[]> {
  const docs: RegDoc[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchRegulationsPage(apiKey, params, page);
    docs.push(...(data.data ?? []));
    const total = data.meta?.totalElements ?? 0;
    if (docs.length >= total || (data.data ?? []).length < PAGE_SIZE) break;
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStatus(doc: RegDoc): Database["public"]["Enums"]["proposal_status"] {
  if (doc.attributes.openForComment) return "open_comment";
  if (doc.attributes.commentEndDate) return "comment_closed";
  return "introduced";
}

function toIsoOrNull(s: string | undefined): string | null {
  if (!s) return null;
  try { return new Date(s).toISOString(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runRegulationsPipeline(
  apiKey: string,
  federalId: string
): Promise<PipelineResult> {
  console.info("\n=== Regulations.gov pipeline (public) ===");
  const logId = await startSync("regulations");
  const db = createAdminClient();
  let inserted = 0, updated = 0, failed = 0;

  try {
    // ── 1. Fetch open-for-comment documents (commentEndDate >= today) ──────
    const today = new Date().toISOString().split("T")[0]!;
    console.info("  Fetching open-for-comment documents...");
    const openDocs = await fetchAllDocuments(
      apiKey,
      {
        "filter[documentType]": "Proposed Rule",
        "filter[commentEndDate][ge]": today,
        "sort": "-commentEndDate",
      },
      8 // up to 8 × 250 = 2,000 docs
    );
    console.info(`  Got ${openDocs.length} open-for-comment documents`);

    // ── 2. Fetch recent documents (last 12 months, not just open) ──────────
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const since = twelveMonthsAgo.toISOString().split("T")[0]!;

    console.info(`  Fetching documents posted since ${since}...`);
    const recentDocs = await fetchAllDocuments(
      apiKey,
      {
        "filter[documentType]": "Proposed Rule",
        "filter[postedDate][ge]": since,
        "sort": "-postedDate",
      },
      4 // up to 4 × 250 = 1,000 more docs
    );
    console.info(`  Got ${recentDocs.length} recent documents`);

    // ── 3. Deduplicate by regulations.gov ID ───────────────────────────────
    const allDocs = new Map<string, RegDoc>();
    for (const d of [...openDocs, ...recentDocs]) allDocs.set(d.id, d);
    console.info(`  Processing ${allDocs.size} unique documents...`);

    if (allDocs.size === 0) {
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
    }

    // ── 4. Resolve agencies in one batched pass ────────────────────────────
    const acronyms = [...new Set(
      [...allDocs.values()]
        .map((d) => d.attributes.agencyId)
        .filter((a): a is string => typeof a === "string" && a.length > 0),
    )];
    console.info(`  Resolving ${acronyms.length} unique agency acronyms...`);
    const { byAcronym, inserted: newAgencies, unmappedAcronyms } =
      await resolveAgencies(db, acronyms, federalId);
    console.info(`    ${byAcronym.size} agencies resolved (${newAgencies} newly inserted)`);
    if (unmappedAcronyms.length > 0) {
      console.warn(`  ⚠ Unmapped agency acronyms (add to packages/db/src/agency-names.ts):`);
      console.warn(`    ${unmappedAcronyms.join(", ")}`);
    }

    // ── 5. Build batched proposal inputs ───────────────────────────────────
    const proposalInputs: RegulationProposalInput[] = [...allDocs.values()].map((doc) => {
      const a = doc.attributes;
      const fullTextUrl = a.fileFormats?.[0]?.fileUrl ?? null;
      return {
        regulationsGovId: doc.id,
        title: a.title ?? doc.id,
        status: mapStatus(doc),
        introducedAt: toIsoOrNull(a.postedDate),
        externalUrl: `https://www.regulations.gov/document/${doc.id}`,
        fullTextUrl,
        metadata: {
          regulations_gov_id: doc.id,
          agency_id: a.agencyId,
          docket_id: a.docketId ?? "",
          document_type: a.documentType,
          object_id: a.objectId ?? "",
          comment_period_start: toIsoOrNull(a.commentStartDate),
          comment_period_end: toIsoOrNull(a.commentEndDate),
        },
        jurisdictionId: federalId,
      };
    });

    // ── 6. Batched proposal upsert ─────────────────────────────────────────
    const result = await upsertRegulationProposalsBatch(db, proposalInputs);
    inserted = result.inserted;
    updated = result.updated;
    failed = result.failed;

    const estimatedMb = +(((inserted + updated) * 2365) / 1024 / 1024).toFixed(2);
    const syncResult: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.info("\n  ──────────────────────────────────────────────────");
    console.info("  Regulations.gov pipeline report");
    console.info("  ──────────────────────────────────────────────────");
    console.info(`  ${"Documents fetched:".padEnd(32)} ${allDocs.size}`);
    console.info(`  ${"Agencies resolved:".padEnd(32)} ${byAcronym.size} (${newAgencies} new)`);
    console.info(`  ${"Proposals inserted:".padEnd(32)} ${inserted}`);
    console.info(`  ${"Proposals updated:".padEnd(32)} ${updated}`);
    console.info(`  ${"Proposals failed:".padEnd(32)} ${failed}`);
    console.info(`  ${"Estimated storage:".padEnd(32)} ~${estimatedMb} MB`);

    await completeSync(logId, syncResult);
    return syncResult;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Regulations pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted, updated, failed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["REGULATIONS_API_KEY"];
  if (!apiKey) { console.error("REGULATIONS_API_KEY not set"); process.exit(1); }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seedJurisdictions } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    const { federalId } = await seedJurisdictions(db);
    await runRegulationsPipeline(apiKey, federalId);
  })()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
