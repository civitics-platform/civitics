/**
 * Regulations.gov pipeline.
 *
 * Fetches all open-for-comment documents plus those posted in the last 12
 * months and upserts them into the proposals table. Also upserts agency
 * records into the agencies table.
 *
 * Storage target: ~20 MB
 * Rate limit:     1,000 req/hour — 100ms delay between calls
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:regulations
 */

import { createAdminClient, agencyFullName, AGENCY_NAMES } from "@civitics/db";
import type { Database } from "@civitics/db";
import { sleep, fetchJson } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type AgencyInsert   = Database["public"]["Tables"]["agencies"]["Insert"];

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

function toDate(s: string | undefined): string | null {
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
  console.log("\n=== Regulations.gov pipeline ===");
  const logId = await startSync("regulations");
  const db = createAdminClient();
  let inserted = 0, updated = 0, failed = 0;

  try {
    // 1. Fetch open-for-comment documents (commentEndDate >= today)
    const today = new Date().toISOString().split("T")[0]!;
    console.log("  Fetching open-for-comment documents...");
    const openDocs = await fetchAllDocuments(
      apiKey,
      {
        "filter[documentType]": "Proposed Rule",
        "filter[commentEndDate][ge]": today,
        "sort": "-commentEndDate",
      },
      8  // up to 8 × 250 = 2,000 docs
    );
    console.log(`  Got ${openDocs.length} open-for-comment documents`);

    // 2. Fetch recent documents (last 12 months, not just open)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const since = twelveMonthsAgo.toISOString().split("T")[0]!;

    console.log(`  Fetching documents posted since ${since}...`);
    const recentDocs = await fetchAllDocuments(
      apiKey,
      {
        "filter[documentType]": "Proposed Rule",
        "filter[postedDate][ge]": since,
        "sort": "-postedDate",
      },
      4  // up to 4 × 250 = 1,000 more docs
    );
    console.log(`  Got ${recentDocs.length} recent documents`);

    // 3. Deduplicate by regulations.gov ID
    const allDocs = new Map<string, RegDoc>();
    for (const d of [...openDocs, ...recentDocs]) allDocs.set(d.id, d);
    console.log(`  Processing ${allDocs.size} unique documents...`);

    // 4. Collect unique agency acronyms for agency upsert
    const agencyAcronyms = new Set<string>();
    for (const doc of allDocs.values()) {
      if (doc.attributes.agencyId) agencyAcronyms.add(doc.attributes.agencyId);
    }

    // 5. Upsert agencies (by acronym — find or create)
    //    Use agencyFullName() to resolve acronym → full name from the shared static map.
    //    If the acronym isn't in the map yet, log it so it can be added.
    const agencyIdMap = new Map<string, string>(); // acronym → agencies.id
    const unmappedAcronyms: string[] = [];
    console.log(`  Upserting ${agencyAcronyms.size} agencies...`);
    for (const acronym of agencyAcronyms) {
      const fullName = agencyFullName(acronym);
      if (!(acronym.toUpperCase() in AGENCY_NAMES)) {
        unmappedAcronyms.push(acronym);
      }
      try {
        const { data: existing } = await db
          .from("agencies")
          .select("id, name")
          .eq("acronym", acronym)
          .maybeSingle();

        if (existing) {
          agencyIdMap.set(acronym, existing.id as string);
          // Backfill name if it's still stored as the acronym
          if (existing.name === acronym && fullName && fullName !== acronym) {
            await db
              .from("agencies")
              .update({ name: fullName })
              .eq("id", existing.id);
          }
        } else {
          const row: AgencyInsert = {
            name: fullName ?? acronym,  // full name from map, acronym as fallback
            acronym,
            jurisdiction_id: federalId,
            agency_type: "federal",
            is_active: true,
            source_ids: { regulations_gov_agency_id: acronym },
          };
          const { data: created, error } = await db
            .from("agencies")
            .insert(row)
            .select("id")
            .single();
          if (error) {
            console.error(`    Agency ${acronym}: insert error — ${error.message}`);
          } else if (created) {
            agencyIdMap.set(acronym, created.id as string);
          }
        }
      } catch (err) {
        console.error(`    Agency ${acronym}: unexpected error —`, err);
      }
    }
    if (unmappedAcronyms.length > 0) {
      console.warn(`  ⚠ Unmapped agency acronyms (add to packages/db/src/agency-names.ts):`);
      console.warn(`    ${unmappedAcronyms.join(", ")}`);
    }

    // 6. Upsert proposals
    for (const doc of allDocs.values()) {
      try {
        const a = doc.attributes;
        const fullTextUrl = a.fileFormats?.[0]?.fileUrl ?? null;
        const status = mapStatus(doc);

        const record: ProposalInsert = {
          title:                a.title?.slice(0, 500) ?? doc.id,
          type:                 "regulation",
          status,
          jurisdiction_id:      federalId,
          regulations_gov_id:   doc.id,
          introduced_at:        toDate(a.postedDate),
          comment_period_start: toDate(a.commentStartDate),
          comment_period_end:   toDate(a.commentEndDate),
          full_text_url:        fullTextUrl,
          source_ids:           { regulations_gov: doc.id, docket_id: a.docketId ?? "" },
          metadata: {
            agency_id:     a.agencyId,
            document_type: a.documentType,
            object_id:     a.objectId ?? "",
          },
        };

        // Upsert by regulations_gov_id
        const { data: existing } = await db
          .from("proposals")
          .select("id")
          .eq("regulations_gov_id", doc.id)
          .maybeSingle();

        if (existing) {
          const { error } = await db
            .from("proposals")
            .update({ ...record, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          if (error) { console.error(`    ${doc.id}: update error — ${error.message}`); failed++; }
          else updated++;
        } else {
          const { error } = await db.from("proposals").insert(record);
          if (error) { console.error(`    ${doc.id}: insert error — ${error.message}`); failed++; }
          else inserted++;
        }
      } catch (err) {
        console.error(`    ${doc.id}: unexpected error —`, err);
        failed++;
      }
    }

    const estimatedMb = +((inserted + updated) * 2365 / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.log(`  Done — inserted: ${inserted}, updated: ${updated}, failed: ${failed}`);
    console.log(`  Estimated storage: ~${estimatedMb} MB`);

    await completeSync(logId, result);
    return result;

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
