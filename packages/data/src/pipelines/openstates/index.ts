/**
 * OpenStates pipeline — post-cutover, batched writes to public.
 *
 * Phase A: state legislators → public.officials (+ external_source_refs)
 * Phase B: state bills       → public.proposals + public.bill_details
 *                              (+ external_source_refs)
 *
 * The OpenStates API rate limit (10 req/min on the bills endpoint) dominates
 * runtime; batching the DB side keeps the process idle-waiting on the API
 * rather than on round-trips. One page of legislators (up to 50 people) now
 * collapses to ~5 DB round-trips instead of ~150, and one page of bills
 * (up to 20) to ~5 instead of ~80.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:states
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { sleep, fetchJson, QuotaExhaustedError } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { STATE_DATA } from "../../jurisdictions/us-states";
import {
  resolveGoverningBodies,
  upsertLegislatorsBatch,
  upsertStateBillsBatch,
  type GovBodyKey,
  type LegislatorInput,
  type StateBillInput,
} from "./writer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PartyValue = Database["public"]["Tables"]["officials"]["Row"]["party"];
type GovBodyType = Database["public"]["Enums"]["governing_body_type"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

interface OSPerson {
  id:             string;
  name:           string;
  party:          string;
  openstates_url: string;
  current_role: {
    title:              string;
    org_classification: string;
    district:           string;
    division_id:        string;
    end_date:           string | null;
    start_date:         string | null;
  } | null;
}

interface OSPersonList {
  results:    OSPerson[];
  pagination: { max_page: number; page: number; per_page: number; total_items: number };
}

interface OSBillOrg {
  name:           string;
  classification: string;  // "upper" | "lower" | "legislature"
}

interface OSBillAbstract {
  abstract: string;
  note?:    string;
}

interface OSBill {
  id:                          string;   // "ocd-bill/..."
  identifier:                  string;   // "HB 1234"
  title:                       string;
  classification:              string[]; // ["bill"] | ["resolution"] | ...
  session:                     string;
  first_action_date:           string | null;
  latest_action_date:          string | null;
  latest_action_description:   string | null;
  from_organization:           OSBillOrg | null;
  // Only present when the /bills call passes include=abstracts. Real
  // plain-language prose for ~2/3 of states (CA/NY/FL/OH populate; TX/PA
  // don't). Non-AI source for proposals.summary_plain (FIX-435).
  abstracts?:                  OSBillAbstract[];
}

interface OSBillList {
  results:    OSBill[];
  pagination: { max_page: number; page: number; per_page: number; total_items: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OS_BASE = "https://v3.openstates.org";

// People endpoint: no documented rate per-minute limit but 429s observed at 100ms.
const PEOPLE_SLEEP_MS = 1000;

// Bills endpoint: 10 req/min → 7s between calls. Page size 20.
const BILLS_PER_PAGE = 20;
const BILLS_SLEEP_MS = 7000;
const MAX_BILL_PAGES = 3;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchLegislators(
  apiKey: string,
  jurisdictionId: string,
  orgClass: "upper" | "lower",
  page: number,
): Promise<OSPersonList> {
  await sleep(PEOPLE_SLEEP_MS);
  const url = new URL(`${OS_BASE}/people`);
  url.searchParams.set("jurisdiction",       jurisdictionId);
  url.searchParams.set("org_classification", orgClass);
  url.searchParams.set("per_page",           "50");
  url.searchParams.set("page",               String(page));
  return fetchJson<OSPersonList>(url.toString(), {
    headers: { "X-API-KEY": apiKey },
  });
}

async function fetchBills(
  apiKey: string,
  jurisdictionId: string,
  page: number,
): Promise<OSBillList> {
  await sleep(BILLS_SLEEP_MS);
  const url = new URL(`${OS_BASE}/bills`);
  url.searchParams.set("jurisdiction", jurisdictionId);
  url.searchParams.set("per_page",     String(BILLS_PER_PAGE));
  url.searchParams.set("page",         String(page));
  url.searchParams.set("sort",         "updated_desc");
  // include=abstracts rides this same request (no extra API call / quota cost)
  // and carries the plain-language summary text we land in summary_plain.
  url.searchParams.set("include",      "abstracts");
  return fetchJson<OSBillList>(url.toString(), {
    headers: { "X-API-KEY": apiKey },
  });
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

// Coerce empty / whitespace-only API date strings to null. `?? null` only
// catches null/undefined; an empty string slips through and Postgres rejects
// it with `invalid input syntax for type date: ""`, killing the whole chunked
// insert (good rows in the chunk die with the bad one). FIX-449.
const dateOrNull = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

function mapParty(party: string): PartyValue {
  const p = party.toLowerCase();
  if (p.includes("democrat"))    return "democrat";
  if (p.includes("republican"))  return "republican";
  if (p.includes("independent")) return "independent";
  if (p.includes("libertarian")) return "libertarian";
  if (p.includes("green"))       return "green";
  return "other";
}

function mapChamberType(orgClass: string): GovBodyType {
  if (orgClass === "upper") return "legislature_upper";
  if (orgClass === "lower") return "legislature_lower";
  return "legislature_unicameral";
}

function mapBillType(classification: string[]): ProposalType {
  const c = classification.map((s) => s.toLowerCase());
  if (c.some((s) => s === "bill"))                                    return "bill";
  if (c.some((s) => s.includes("resolution")))                        return "resolution";
  if (c.some((s) => s.includes("amendment")))                         return "amendment";
  if (c.some((s) => s.includes("budget") || s.includes("appropriat"))) return "budget";
  if (c.some((s) => s.includes("ordinance")))                         return "ordinance";
  return "other";
}

function mapBillStatus(latestAction: string | null): ProposalStatus {
  const a = (latestAction ?? "").toLowerCase();
  if (a.includes("signed") || a.includes("enacted") || a.includes("chaptered")) return "enacted";
  if (a.includes("vetoed"))                                 return "vetoed";
  if (a.includes("failed") || a.includes("defeated") || a.includes("died")) return "failed";
  if (a.includes("passed") && a.includes("house"))         return "passed_chamber";
  if (a.includes("passed") && a.includes("senate"))        return "passed_chamber";
  if (a.includes("passed both"))                           return "passed_both_chambers";
  if (a.includes("committee"))                             return "in_committee";
  return "introduced";
}

function mapBillChamber(orgClass: string): "house" | "senate" | null {
  if (orgClass === "upper") return "senate";
  if (orgClass === "lower") return "house";
  return null;
}

// Pick the longest non-empty abstract as the plain-language summary. Many bills
// carry a single abstract; multi-abstract bills (e.g. chamber-specific digests)
// are best served by the fullest one. Returns null when nothing usable. (FIX-435)
function pickAbstract(abstracts: OSBillAbstract[] | undefined): string | null {
  if (!abstracts || abstracts.length === 0) return null;
  let best = "";
  for (const a of abstracts) {
    const t = (a.abstract ?? "").trim();
    if (t.length > best.length) best = t;
  }
  return best.length > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runOpenStatesPipeline(
  apiKey: string,
  stateIds: Map<string, string>,   // state name → jurisdiction UUID
): Promise<PipelineResult> {
  console.log("\n=== OpenStates pipeline (public) ===");
  const logId = await startSync("openstates");
  const db = createAdminClient();

  let officialsInserted = 0, officialsUpdated = 0, officialsFailed = 0;
  let billsInserted = 0, billsUpdated = 0, billsFailed = 0;
  let quotaHit = false;

  try {
    // ── Phase 0: pre-resolve governing_bodies for every (state × chamber) ───
    const govBodyKeys: GovBodyKey[] = [];
    for (const state of STATE_DATA) {
      const jurisdictionId = stateIds.get(state.name);
      if (!jurisdictionId) continue;
      for (const orgClass of ["upper", "lower"] as const) {
        govBodyKeys.push({
          jurisdictionId,
          stateAbbr: state.abbr,
          stateName: state.name,
          type: mapChamberType(orgClass),
        });
      }
    }
    const govBodyMap = await resolveGoverningBodies(db, govBodyKeys);
    console.log(`  Resolved ${govBodyMap.size} state legislative bodies`);

    const govBodyFor = (jurisdictionId: string, orgClass: "upper" | "lower") =>
      govBodyMap.get(`${jurisdictionId}|${mapChamberType(orgClass)}`) ?? null;

    // ── Phase A: Legislators (per-state, page-by-page, batch per page) ──────
    for (const state of STATE_DATA) {
      if (quotaHit) break;
      const jurisdictionId = stateIds.get(state.name);
      if (!jurisdictionId) {
        console.warn(`  ${state.abbr}: no jurisdiction id, skipping`);
        continue;
      }

      const ocdId = `ocd-jurisdiction/country:us/state:${state.abbr.toLowerCase()}/government`;
      let totalLegislators = 0;

      for (const orgClass of ["upper", "lower"] as const) {
        const govBodyId = govBodyFor(jurisdictionId, orgClass);
        if (!govBodyId) {
          console.warn(`    ${state.abbr}: no governing_body for ${orgClass}, skipping`);
          continue;
        }

        let page = 1;
        while (true) {
          if (quotaHit) break;
          let list: OSPersonList;
          try {
            list = await fetchLegislators(apiKey, ocdId, orgClass, page);
          } catch (err) {
            if (err instanceof QuotaExhaustedError) {
              console.warn(`  OpenStates daily quota exhausted — pausing. Re-run tomorrow; upserts are idempotent.`);
              quotaHit = true;
              break;
            }
            console.error(`    ${state.abbr} ${orgClass} page ${page}: fetch error —`, err instanceof Error ? err.message : err);
            break;
          }

          const pageInputs: LegislatorInput[] = [];
          for (const person of list.results ?? []) {
            const role = person.current_role;
            if (!role) continue;
            pageInputs.push({
              openstatesId: person.id,
              fullName: person.name,
              roleTitle: role.title || (orgClass === "upper" ? "State Senator" : "State Representative"),
              governingBodyId: govBodyId,
              jurisdictionId,
              party: mapParty(person.party),
              districtName: role.district || null,
              termStart: dateOrNull(role.start_date),
              termEnd: dateOrNull(role.end_date),
              websiteUrl: person.openstates_url || null,
              metadata: { org_classification: orgClass, state: state.abbr },
            });
          }

          if (pageInputs.length > 0) {
            const res = await upsertLegislatorsBatch(db, pageInputs);
            officialsInserted += res.inserted;
            officialsUpdated += res.updated;
            officialsFailed += res.failed;
            totalLegislators += res.inserted + res.updated;
          }

          if (page >= list.pagination.max_page) break;
          page++;
        }
      }

      console.log(`  ${state.abbr} legislators: ${totalLegislators} upserted`);

      if (quotaHit) break;

      // ── Phase B: Bills (per-state, page-by-page, batch per page) ──────────
      let billPage = 1;
      let stateBillsFetched = 0;
      let stateBillsInserted = 0;
      let stateBillsUpdated = 0;
      while (billPage <= MAX_BILL_PAGES) {
        let list: OSBillList;
        try {
          list = await fetchBills(apiKey, ocdId, billPage);
        } catch (err) {
          if (err instanceof QuotaExhaustedError) {
            console.warn(`  OpenStates daily quota exhausted — pausing. Re-run tomorrow; upserts are idempotent.`);
            quotaHit = true;
            break;
          }
          console.error(`    ${state.abbr} bills page ${billPage}: fetch error —`, err instanceof Error ? err.message : err);
          break;
        }

        const pageInputs: StateBillInput[] = [];
        for (const bill of list.results ?? []) {
          const billNumber = bill.identifier.slice(0, 100);
          const title = (bill.title || billNumber).slice(0, 500);
          const session = bill.session || "current";
          const orgClass = bill.from_organization?.classification ?? "";
          pageInputs.push({
            openstatesId: bill.id,
            title,
            billNumber,
            session,
            chamber: mapBillChamber(orgClass),
            type: mapBillType(bill.classification ?? []),
            status: mapBillStatus(bill.latest_action_description),
            jurisdictionId,
            introducedAt: dateOrNull(bill.first_action_date),
            lastActionAt: dateOrNull(bill.latest_action_date),
            summaryPlain: pickAbstract(bill.abstracts),
            externalUrl: `https://openstates.org/bills/${bill.id.replace("ocd-bill/", "")}/`,
            metadata: {
              source: "openstates",
              openstates_id: bill.id,
              state: state.abbr,
              latest_action: (bill.latest_action_description ?? "").slice(0, 200),
            },
          });
        }

        if (pageInputs.length > 0) {
          const res = await upsertStateBillsBatch(db, pageInputs);
          billsInserted += res.inserted;
          billsUpdated += res.updated;
          billsFailed += res.failed;
          stateBillsInserted += res.inserted;
          stateBillsUpdated += res.updated;
        }

        stateBillsFetched += (list.results ?? []).length;
        if (billPage >= list.pagination.max_page || list.results.length < BILLS_PER_PAGE) break;
        billPage++;
      }

      console.log(`  ${state.abbr} bills: ${stateBillsFetched} fetched · ${stateBillsInserted} inserted · ${stateBillsUpdated} updated`);
    }

    const totalInserted = officialsInserted + billsInserted;
    const totalUpdated = officialsUpdated + billsUpdated;
    const totalFailed = officialsFailed + billsFailed;

    const estimatedMb = +(((totalInserted + totalUpdated) * 1000) / 1024 / 1024).toFixed(2);
    const result: PipelineResult = {
      inserted: totalInserted,
      updated: totalUpdated,
      failed: totalFailed,
      estimatedMb,
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  OpenStates pipeline report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Legislators inserted:".padEnd(32)} ${officialsInserted}`);
    console.log(`  ${"Legislators updated:".padEnd(32)} ${officialsUpdated}`);
    console.log(`  ${"Legislators failed:".padEnd(32)} ${officialsFailed}`);
    console.log(`  ${"Bills inserted:".padEnd(32)} ${billsInserted}`);
    console.log(`  ${"Bills updated:".padEnd(32)} ${billsUpdated}`);
    console.log(`  ${"Bills failed:".padEnd(32)} ${billsFailed}`);
    if (quotaHit) console.log(`  ${"Run ended with quota exhausted.".padEnd(32)}`);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  OpenStates pipeline fatal error:", msg);
    await failSync(logId, msg);
    return {
      inserted: officialsInserted + billsInserted,
      updated: officialsUpdated + billsUpdated,
      failed: officialsFailed + billsFailed,
      estimatedMb: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["OPENSTATES_API_KEY"];
  if (!apiKey) { console.error("OPENSTATES_API_KEY not set"); process.exit(1); }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seedJurisdictions } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    const { stateIds } = await seedJurisdictions(db);
    await runOpenStatesPipeline(apiKey, stateIds);
  })()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
