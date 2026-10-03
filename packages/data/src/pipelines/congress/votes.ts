/**
 * Congress bills/proposals + individual member vote records pipeline.
 *
 * Proposals are fetched from the Congress.gov v3 API (which has no /vote endpoint).
 * Individual member vote records are fetched from the official XML feeds:
 *   - House: https://clerk.house.gov/evs/{year}/roll{NNN}.xml
 *   - Senate: https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{NNNNN}.xml
 *
 * Post-cutover, single-write against public. The shadow schema is gone; votes
 * land directly in public.votes which now keys on (roll_call_id, official_id)
 * and FKs through bill_details.proposal_id.
 *
 * Run standalone:  pnpm --filter @civitics/data data:votes
 */

import {
  createAdminClient,
  currentGoverningBodyMembers,
  rowsOrThrow,
  selectAllKeyset,
  afterKey,
} from "@civitics/db";
import type { Database } from "@civitics/db";
import {
  buildBioguideMap,
  buildSenatorNameStateMap,
  senateNameKey,
  type MapCollision,
} from "./votes-maps";
import {
  fetchCongressApi,
  fetchText,
  mapLegislationType,
  mapVote,
  CURRENT_CONGRESS,
} from "./members";
import {
  resolveBillsBatch,
  upsertBillProposalsBatch,
  chamberForBillType,
  presentBillDetailIds,
  landBillDetails,
  advanceProposalStatuses,
  emptyAdvance,
  mergeAdvance,
  type BillKeyConflict,
  type BillProposalArgs,
} from "./bills";
import {
  mapBillStatus,
  rollPassageAdvances,
  stampMintStatuses,
  MINT_FLOOR,
} from "./bill-status";
import {
  guardBillDetails,
  writeRollVotes,
  type BillDetailsGuardDeps,
  type InsertFailure,
  type SkippedRoll,
} from "./vote-bill-guard";
import { XMLParser } from "fast-xml-parser";
import { startSync, completeSync, failSync } from "../sync-log";
import { selectDirect } from "../../lib/heavy-rebuild";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type ProposalType = Database["public"]["Enums"]["proposal_type"];
type VoteInsert = Database["public"]["Tables"]["votes"]["Insert"];

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface VotesPipelineOptions {
  apiKey: string;
  federalId: string;
  senateGovBodyId: string;
  houseGovBodyId: string;
}

export interface VotesPipelineResult {
  proposalsUpserted: number;
  votesInserted: number;
}

// ---------------------------------------------------------------------------
// Internal types (Congress.gov bill list)
// ---------------------------------------------------------------------------

interface BillListResponse {
  bills: BillSummary[];
  pagination: { count: number; next?: string };
}

interface BillSummary {
  congress: number;
  number: string;
  type: string; // "HR", "S", "HJRES", etc.
  title: string;
  originChamber?: string;
  latestAction?: {
    actionDate?: string;
    text?: string;
  };
  updateDate?: string;
  introducedDate?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function chamberGovBodyId(
  billType: string,
  senateId: string,
  houseId: string
): string {
  const t = billType.toUpperCase();
  if (t === "S" || t === "SJRES" || t === "SRES" || t === "SCONRES" || t === "SAMDT") {
    return senateId;
  }
  return houseId;
}

function congressGovBillUrl(congress: number, type: string, number: string): string {
  const typeMap: Record<string, string> = {
    HR: "house-bill",
    S: "senate-bill",
    HJRES: "house-joint-resolution",
    SJRES: "senate-joint-resolution",
    HRES: "house-resolution",
    SRES: "senate-resolution",
    HCONRES: "house-concurrent-resolution",
    SCONRES: "senate-concurrent-resolution",
    HAMDT: "house-amendment",
    SAMDT: "senate-amendment",
  };
  const path = typeMap[type.toUpperCase()] ?? "other";
  return `https://congress.gov/bill/${congress}th-congress/${path}/${number}`;
}

/**
 * Parse House Clerk legis-num strings.
 *
 * The Clerk uses space-separated format without dots: "H R 29", "H RES 5",
 * "H J RES 2", "H CON RES 5". Older documents may use dotted format:
 * "H.R. 1", "H.RES. 5". We normalize to handle both.
 *
 * Returns null for procedural strings like "QUORUM" or "ELECTION OF SPEAKER"
 * where no bill number is present.
 */
function parseHouseLegisNum(legisNum: string): { type: string; number: string } | null {
  if (!legisNum || !legisNum.trim()) return null;

  const s = legisNum.trim().toUpperCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();

  if (s.startsWith("H J RES ")) {
    const num = s.slice("H J RES ".length).trim();
    return num ? { type: "HJRES", number: num } : null;
  }
  if (s.startsWith("H CON RES ")) {
    const num = s.slice("H CON RES ".length).trim();
    return num ? { type: "HCONRES", number: num } : null;
  }
  if (s.startsWith("H RES ")) {
    const num = s.slice("H RES ".length).trim();
    return num ? { type: "HRES", number: num } : null;
  }
  if (s.startsWith("H R ")) {
    const num = s.slice("H R ".length).trim();
    return num ? { type: "HR", number: num } : null;
  }
  if (s.startsWith("S J RES ")) {
    const num = s.slice("S J RES ".length).trim();
    return num ? { type: "SJRES", number: num } : null;
  }
  if (s.startsWith("S CON RES ")) {
    const num = s.slice("S CON RES ".length).trim();
    return num ? { type: "SCONRES", number: num } : null;
  }
  if (s.startsWith("S RES ")) {
    const num = s.slice("S RES ".length).trim();
    return num ? { type: "SRES", number: num } : null;
  }
  if (/^S \d/.test(s)) {
    const num = s.slice(2).trim();
    return num ? { type: "S", number: num } : null;
  }

  return null;
}

/**
 * Normalize Senate document_type strings to our bill type codes. Returns
 * null for any type the caller should handle separately (e.g. PN for
 * Presidential Nominations) or for genuinely unrecognized strings.
 *
 * The previous fallthrough `return "S"` silently mapped PN votes (and any
 * other novel doc type) into fake "S {N}" bill rows — see FIX-162/164/165.
 */
function normalizeSenateDocType(docType: string): string | null {
  const t = docType.trim().toUpperCase();
  if (t === "S." || t === "S") return "S";
  if (t === "H.R." || t === "H.R") return "HR";
  if (t === "S.RES." || t === "S.RES" || t === "S. RES.") return "SRES";
  if (t === "H.RES." || t === "H.RES" || t === "H. RES.") return "HRES";
  if (t === "S.J.RES." || t === "S.J.RES" || t === "S.J. RES.") return "SJRES";
  if (t === "H.J.RES." || t === "H.J.RES" || t === "H.J. RES.") return "HJRES";
  if (t === "S.CON.RES." || t === "S.CON.RES" || t === "S. CON. RES.") return "SCONRES";
  if (t === "H.CON.RES." || t === "H.CON.RES" || t === "H. CON. RES.") return "HCONRES";
  return null;
}

/** FIX-1261's receipt: what this run minted, by status. */
function countMinted(minted: readonly BillProposalArgs[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of minted) {
    const s = a.status ?? "introduced";
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/**
 * Parse House action-date like "03-Jan-2025" → "2025-01-03"
 */
function parseHouseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
  if (!match) return null;

  const [, day, mon, year] = match;
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04",
    may: "05", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const mm = months[mon.toLowerCase()];
  if (!mm) return null;
  return `${year}-${mm}-${day.padStart(2, "0")}`;
}

/**
 * Parse Senate vote_date — two formats observed:
 *   "January 9, 2025,  02:54 PM"  (Senate LIS XML)
 *   "01-03-2025"                  (older MM-DD-YYYY format)
 */
function parseSenateDate(dateStr: string): string | null {
  if (!dateStr) return null;

  const longMatch = dateStr.match(/^(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (longMatch) {
    const months: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
    };
    const mm = months[longMatch[1].toLowerCase()];
    if (mm) return `${longMatch[3]}-${mm}-${longMatch[2].padStart(2, "0")}`;
  }

  const shortMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (shortMatch) {
    const [, mm, dd, yyyy] = shortMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// buildOfficialMaps helper
// ---------------------------------------------------------------------------

interface OfficialMaps {
  /** bioguideId → official UUID (for House members) */
  officialMap: Map<string, string>;
  /** "lastName:stateAbbr" → official UUID (for Senate members) */
  senatorByNameState: Map<string, string>;
}

// .in() lists above ~200 ids overflow the Kong/PostgREST URL budget and 400
// out — which supabase-js surfaces as an error the old code logged and
// skipped past, leaving the senator map empty (FIX-545).
const IN_CHUNK = 200;

/** Print a refused map overwrite loudly — see votes-maps.ts for the rationale. */
function reportCollisions(mapLabel: string, collisions: readonly MapCollision[]): void {
  if (collisions.length === 0) return;
  console.warn(
    `  ⚠ FIX-940: ${collisions.length} collision(s) refused on the ${mapLabel} map — ` +
      `two officials rows claim one key. The FIRST id keeps the slot; the second is ` +
      `left unresolved (its votes will surface as unmatched, which is recoverable — ` +
      `a silent overwrite is not).`,
  );
  for (const c of collisions) {
    console.warn(`      key='${c.key}'  kept=${c.kept}  refused=${c.refused}`);
  }
}

async function buildOfficialMaps(
  db: ReturnType<typeof createAdminClient>,
  senateGovBodyId: string
): Promise<OfficialMaps> {
  // FIX-545: this read was both log-and-continue (a transient error left the
  // bioguide map empty and every House vote unmatched) and unpaginated —
  // officials holds ~28.6k rows (2026-06-09), so the old single .select()
  // silently truncated at PostgREST's 1,000-row cap.
  const allOfficials = await selectAllKeyset<{ id: string; source_ids: unknown }, string>(
    "votes bioguide-map officials preload",
    (after, limit) => afterKey(
      db.from("officials").select("id, source_ids").order("id").limit(limit), "id", after),
    { key: (r) => r.id },
  );
  const bioguide = buildBioguideMap(
    allOfficials.map((o) => ({
      id:         o.id as string,
      source_ids: o.source_ids as Record<string, string> | null,
    })),
  );
  const officialMap = bioguide.map;
  console.info(`  Built bioguide map with ${officialMap.size} entries`);
  reportCollisions("bioguide", bioguide.collisions);

  // FIX-940: the Senate governing body carries ~1.95k `tier='candidate'` rows
  // minted by the FEC cn{yy} stage (FIX-246) alongside the 100 sitting Senators,
  // and the map used to be built from ALL of them. `currentGoverningBodyMembers`
  // applies the is_active + tier='elected' predicate the rest of the platform
  // already agreed for exactly this pollution (see packages/db governing-bodies).
  // The unfiltered count is read first purely so the drop is visible in the run
  // output — a pool that does NOT shrink on a polluted DB means the predicate
  // did not apply, and is worth stopping to look at.
  const { count: rawPoolCount, error: rawPoolErr } = await db
    .from("officials")
    .select("id", { count: "exact", head: true })
    .eq("governing_body_id", senateGovBodyId);
  if (rawPoolErr) {
    console.warn(`  Senate pool pre-count unavailable: ${rawPoolErr.message}`);
  }

  // Still past the 1,000-row cap even after filtering is applied server-side,
  // so the paginated read stays.
  const senators = await selectAllKeyset<
    { id: string; last_name: string | null; jurisdiction_id: string | null }, string
  >(
    "votes senator preload",
    (after, limit) => afterKey(currentGoverningBodyMembers(
      db
        .from("officials")
        .select("id, last_name, jurisdiction_id")
        .eq("governing_body_id", senateGovBodyId),
    )
      .order("id")
      .limit(limit), "id", after),
    { key: (r) => r.id },
  );
  console.info(
    `  Senate pool: ${rawPoolCount ?? "?"} rows in the governing body → ` +
      `${senators.length} current members after the is_active + tier='elected' filter`,
  );
  if (rawPoolCount != null && senators.length >= rawPoolCount && rawPoolCount > 200) {
    console.warn(
      `  ⚠ FIX-940: the current-member filter removed nothing from a ${rawPoolCount}-row ` +
        `Senate pool. Expected ~100 sitting Senators — check that officials.tier is populated.`,
    );
  }

  let senatorByNameState = new Map<string, string>();
  if (senators.length > 0) {
    const jidSet = new Set(senators.map((s) => s.jurisdiction_id).filter(Boolean));
    const jids = Array.from(jidSet) as string[];

    const jMap = new Map<string, string>();
    for (let i = 0; i < jids.length; i += IN_CHUNK) {
      const page = rowsOrThrow(
        await db
          .from("jurisdictions")
          .select("id, short_name")
          .in("id", jids.slice(i, i + IN_CHUNK)),
        "votes senator-jurisdictions preload",
      );
      for (const j of page) jMap.set(j.id as string, (j.short_name as string | null) ?? "");
    }

    const built = buildSenatorNameStateMap(
      senators.map((s) => ({
        id:        s.id as string,
        last_name: (s.last_name as string | null) ?? null,
        state:     s.jurisdiction_id ? (jMap.get(s.jurisdiction_id as string) ?? null) : null,
      })),
    );
    senatorByNameState = built.map;
    console.info(`  Built senator name:state map with ${senatorByNameState.size} entries`);
    reportCollisions("senator name:state", built.collisions);
  }

  return { officialMap, senatorByNameState };
}

// ---------------------------------------------------------------------------
// XML parser instance (shared)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["recorded-vote", "member"].includes(name),
});

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runVotesPipeline(
  options: VotesPipelineOptions
): Promise<VotesPipelineResult> {
  const { apiKey, federalId, senateGovBodyId, houseGovBodyId } = options;

  console.info("Starting Congress bills + XML member votes pipeline...");
  const logId = await startSync("congress_votes");

  const db = createAdminClient();

  let proposalsUpserted = 0;
  let votesInserted = 0;
  // FIX-1238 — rolls not written because their bill has no bill_details row,
  // and rolls whose insert failed for any other reason. Both are rows_failed.
  const skippedRolls: SkippedRoll[] = [];
  const insertFailures: InsertFailure[] = [];
  // FIX-1256 — bill keys not bound to exactly one proposal (a key-holder that
  // carries a different ref, or a key taken mid-write). Also rows_failed.
  const billKeyConflicts: BillKeyConflict[] = [];
  // FIX-1257 — every status this run moved (Step 1's sync evidence and the
  // vote path's passage rolls) and every pair the rule held.
  const statusResult = emptyAdvance();
  // FIX-1261 — every bill the vote path minted this run (both chambers).
  const mintedArgs: BillProposalArgs[] = [];

  const billDetailsDeps: BillDetailsGuardDeps = {
    presentIds: (ids) => presentBillDetailIds(db, ids),
    land: (id, args) => landBillDetails(db, id, args),
    log: (line) => console.info(line),
  };

  try {

  // -------------------------------------------------------------------------
  // Step 1: Sync bills from Congress.gov API
  //
  // Must run BEFORE XML vote feeds so bill_details rows with proper titles
  // exist when votes are inserted (votes.bill_proposal_id FKs to
  // bill_details.proposal_id).
  // -------------------------------------------------------------------------

  console.info("\n--- Step 1: Syncing bills from Congress.gov API ---");

  const billTypes = [
    { type: "hr",    label: "House bills" },
    { type: "s",     label: "Senate bills" },
    { type: "hjres", label: "House joint resolutions" },
    { type: "sjres", label: "Senate joint resolutions" },
  ] as const;

  for (const { type, label } of billTypes) {
    console.info(`\n  Fetching recent ${label}...`);

    let bills: BillSummary[] = [];

    try {
      const listData = await fetchCongressApi<BillListResponse>(
        `bill/${CURRENT_CONGRESS}/${type}?sort=updateDate+desc&limit=50`,
        apiKey
      );
      bills = listData.bills ?? [];
      console.info(`  Got ${bills.length} ${label}`);
    } catch (err) {
      console.error(`  Error fetching ${label}:`, err);
      continue;
    }

    const batchArgs = bills.map((bill) => {
      const billKey = `${bill.congress}-${bill.type}-${bill.number}`;
      const billNumber = `${bill.type} ${bill.number}`;
      const title = (bill.title ?? billNumber).slice(0, 500);
      return {
        billKey,
        title,
        billNumber,
        billType: bill.type,
        chamber: chamberForBillType(bill.type),
        type: mapLegislationType(bill.type) as ProposalType,
        // FIX-1257: null for a stage-less action — Step 3 then leaves the
        // stored status alone, and only ever advances it.
        status: mapBillStatus(bill.latestAction?.text),
        jurisdictionId: federalId,
        governingBodyId: chamberGovBodyId(bill.type, senateGovBodyId, houseGovBodyId),
        congressGovUrl: congressGovBillUrl(bill.congress, bill.type, bill.number),
        introducedAt: bill.introducedDate
          ? new Date(bill.introducedDate).toISOString()
          : null,
        lastActionAt: bill.latestAction?.actionDate
          ? new Date(bill.latestAction.actionDate).toISOString()
          : null,
        latestActionText: bill.latestAction?.text,
        congressNumber: CURRENT_CONGRESS,
        session: String(CURRENT_CONGRESS),
      };
    });

    try {
      const batchResult = await upsertBillProposalsBatch(db, batchArgs);
      proposalsUpserted += batchResult.upserted;
      billKeyConflicts.push(...batchResult.keyConflicts);
      mergeAdvance(statusResult, batchResult.status);
      if (batchResult.failed > 0) {
        console.warn(`  ${batchResult.failed} ${label} failed in batch`);
      }
    } catch (err) {
      console.error(`  Unexpected error processing ${label} batch:`, err);
    }

    console.info(`  Proposals upserted so far: ${proposalsUpserted}`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Build official lookup maps (needed for XML vote feeds)
  // -------------------------------------------------------------------------

  const { officialMap, senatorByNameState } = await buildOfficialMaps(db, senateGovBodyId);

  // -------------------------------------------------------------------------
  // Congress → session → calendar year mapping. Each Congress runs two
  // sessions: session 1 in the odd year, session 2 in the even year. The
  // 117th started in 2021, so year = 2021 + (congress - 117) * 2 + (session - 1).
  // House Clerk XML feeds are addressed by year, Senate LIS feeds by
  // {congress}{session} — both shapes are derivable from this mapping.
  // -------------------------------------------------------------------------

  const sessionYearOffset = (CURRENT_CONGRESS - 117) * 2;
  const sessions: Array<{ session: number; year: number }> = [
    { session: 1, year: 2021 + sessionYearOffset },
    { session: 2, year: 2022 + sessionYearOffset },
  ];

  // -------------------------------------------------------------------------
  // Step 3: House Clerk XML vote feeds — two-pass to batch bill resolution
  // -------------------------------------------------------------------------

  console.info("\n--- Step 3: Fetching House Clerk XML votes ---");

  let houseUnmatched = 0;

  interface HouseRollItem {
    rollCallId:    string;
    url:           string;
    session:       number;
    billKey:       string | null;
    votedAt:       string | null;
    voteQuestion:  string;
    resultStr:     string;
    legisNum:      string;
    recordedVotes: unknown[];
  }
  const houseRollBuffer: HouseRollItem[] = [];
  const houseBillArgs = new Map<string, BillProposalArgs>();

  // Bulk-load every distinct House roll_call_id we already have for this
  // Congress so the skip-check is a Set lookup instead of one round trip per
  // roll. FIX-463: a single `SELECT DISTINCT roll_call_id … LIKE $1` over a
  // direct pg.Client (selectDirect) — votes has one row per (roll × official),
  // so the old per-pattern OFFSET pagination over the full ~150k-row match set
  // (1000-row pages) re-scanned from the start each page (O(n²)) and tripped
  // the prod ~8s role statement_timeout. DISTINCT returns ~1-2k rows in one
  // ~200ms pass with no 1000-row cap and no OFFSET re-scan.
  const houseExistingIds = new Set<string>();
  {
    const houseYears = sessions.map((s) => `${s.year}-house-%`);
    for (const pattern of houseYears) {
      try {
        const rows = await selectDirect<{ roll_call_id: string | null }>(
          "SELECT DISTINCT roll_call_id FROM votes WHERE roll_call_id LIKE $1",
          [pattern],
        );
        for (const row of rows) {
          if (row.roll_call_id) houseExistingIds.add(row.roll_call_id);
        }
      } catch (err) {
        console.warn(`  House skip-check load error (${pattern}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.info(`  Pre-loaded ${houseExistingIds.size} existing House roll IDs`);
  }

  // Pass 1: fetch + parse XML for all novel rolls; buffer bill args + vote data
  for (const { session, year } of sessions) {
    console.info(`\n  House session ${session} (${year}) — collecting rolls...`);

    for (let rollNum = 1; rollNum <= 500; rollNum++) {
      const paddedRoll = String(rollNum).padStart(3, "0");
      const url = `https://clerk.house.gov/evs/${year}/roll${paddedRoll}.xml`;
      const rollCallId = `${year}-house-${paddedRoll}`;

      try {
        if (houseExistingIds.has(rollCallId)) {
          continue;
        }

        console.info(`    Roll ${rollNum}: fetching...`);

        let xmlText: string;
        try {
          xmlText = await fetchText(url);
        } catch (fetchErr: unknown) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (msg.includes("HTTP 404")) {
            console.info(`    Roll ${rollNum}: 404 — no more rolls for session ${session}`);
            break;
          }
          console.error(`    Roll ${rollNum}: fetch error — ${msg}`);
          continue;
        }

        const parsed = xmlParser.parse(xmlText);
        const meta = parsed["rollcall-vote"]?.["vote-metadata"];
        const voteData = parsed["rollcall-vote"]?.["vote-data"];

        if (!meta || !voteData) {
          console.error(`    Roll ${rollNum}: unexpected XML structure, skipping`);
          continue;
        }

        const legisNum     = meta["legis-num"] ?? "";
        const billRef      = parseHouseLegisNum(String(legisNum));
        const actionDateStr = meta["action-date"] ?? "";
        const votedAt      = parseHouseDate(String(actionDateStr));
        const resultStr    = String(meta["vote-result"] ?? "");
        const voteQuestion = String(meta["vote-question"] ?? "");

        const recordedVotes: unknown[] = Array.isArray(voteData["recorded-vote"])
          ? voteData["recorded-vote"]
          : voteData["recorded-vote"]
            ? [voteData["recorded-vote"]]
            : [];

        let billKey: string | null = null;
        if (billRef) {
          billKey = `${CURRENT_CONGRESS}-${billRef.type}-${billRef.number}`;
          if (!houseBillArgs.has(billKey)) {
            const govBodyId      = chamberGovBodyId(billRef.type, senateGovBodyId, houseGovBodyId);
            const congressGovUrl = congressGovBillUrl(CURRENT_CONGRESS, billRef.type, billRef.number);
            const introducedIso  = votedAt ? new Date(votedAt).toISOString() : null;
            houseBillArgs.set(billKey, {
              billKey,
              title:           `${billRef.type} ${billRef.number}`,
              billNumber:      `${billRef.type} ${billRef.number}`,
              billType:        billRef.type,
              chamber:         chamberForBillType(billRef.type),
              type:            mapLegislationType(billRef.type) as ProposalType,
              // FIX-1261: a placeholder — stampMintStatuses() decides it at
              // flush, over every roll this run buffered for the bill.
              status:          MINT_FLOOR,
              jurisdictionId:  federalId,
              governingBodyId: govBodyId,
              congressGovUrl,
              introducedAt:    introducedIso,
              lastActionAt:    introducedIso,
              congressNumber:  CURRENT_CONGRESS,
              session:         String(CURRENT_CONGRESS),
            });
          }
        }

        houseRollBuffer.push({ rollCallId, url, session, billKey, votedAt, voteQuestion, resultStr, legisNum, recordedVotes });
      } catch (err) {
        console.error(`    House roll ${rollNum} (session ${session}): unexpected error —`, err);
      }
    }
  }

  stampMintStatuses(houseBillArgs, houseRollBuffer);

  // Batch resolve: one bulk lookup + one bulk insert for novel bills
  console.info(`\n  Resolving ${houseBillArgs.size} unique House bills in batch...`);
  const houseBillKeyToId = await resolveBillsBatch(db, houseBillArgs, billKeyConflicts, mintedArgs);
  proposalsUpserted += [...houseBillKeyToId.values()].filter((v) => v !== null).length;

  // FIX-1238: every roll about to be written must reference a proposal that
  // HAS a bill_details row (the FK target). One batched read; one targeted
  // landing per absent bill; whatever is still absent is skipped below.
  const houseAbsent = await guardBillDetails(
    houseRollBuffer.filter((r) => r.votedAt).map((r) => r.billKey),
    houseBillKeyToId,
    houseBillArgs,
    billDetailsDeps,
  );

  // Pass 2: write vote records using the resolved proposalId map
  console.info("  Writing House vote records...");
  const houseWrite = await writeRollVotes<HouseRollItem, VoteInsert>(houseRollBuffer, {
    proposalIdFor: (billKey) => (billKey ? (houseBillKeyToId.get(billKey) ?? null) : null),
    absent: houseAbsent,
    build: (roll, proposalId, votedAtIso) => {
      const voteRecords: VoteInsert[] = [];
      for (const rv of roll.recordedVotes) {
        const rvObj      = rv as Record<string, unknown>;
        const legislator = rvObj["legislator"] as Record<string, unknown> | null;
        const voteText   = String(rvObj["vote"] ?? "");
        if (!legislator) continue;
        const bioguide   = String(legislator["@_name-id"] ?? "");
        if (!bioguide) continue;
        const officialId = officialMap.get(bioguide);
        if (!officialId) { houseUnmatched++; continue; }
        voteRecords.push({
          official_id:      officialId,
          bill_proposal_id: proposalId,
          vote:             mapVote(voteText),
          chamber:          "House",
          roll_call_id:     roll.rollCallId,
          session:          String(roll.session),
          voted_at:         votedAtIso,
          vote_question:    roll.voteQuestion,
          source_url:       roll.url,
          metadata:         { vote_result: roll.resultStr, legis_num: roll.legisNum },
        });
      }
      return voteRecords;
    },
    insert: async (records) => await db.from("votes").insert(records),
    log: (line) => console.info(line),
  });
  votesInserted += houseWrite.inserted;
  skippedRolls.push(...houseWrite.skipped);
  insertFailures.push(...houseWrite.insertFailures);

  // FIX-1257: a passage roll that passed is primary evidence the bill passed
  // this chamber — advance the bill (holder or novel) to passed_chamber. The
  // mint (FIX-1261) already read the question for a novel bill; this pass is
  // what moves an EXISTING one. A FAILED roll writes nothing onto an existing
  // bill: a failed procedural vote is not a failed bill.
  {
    const landed = new Set(houseWrite.landed);
    mergeAdvance(statusResult, await advanceProposalStatuses(db, rollPassageAdvances(
      houseRollBuffer.filter((r) => landed.has(r.rollCallId)),
      (billKey) => (billKey ? (houseBillKeyToId.get(billKey) ?? null) : null),
    )));
  }

  // -------------------------------------------------------------------------
  // Step 4: Senate LIS XML vote feeds — two-pass to batch bill resolution
  // -------------------------------------------------------------------------

  console.info("\n--- Step 4: Fetching Senate LIS XML votes ---");

  let senateUnmatched = 0;
  /** FIX-940: which keys missed, not just how many — names the member to chase. */
  const senateUnmatchedKeys = new Map<string, number>();

  interface SenateRollItem {
    rollCallId:   string;
    url:          string;
    session:      number;
    billKey:      string | null;
    votedAt:      string | null;
    voteQuestion: string;
    resultStr:    string;
    memberList:   unknown[];
  }
  const senateRollBuffer: SenateRollItem[] = [];
  const senateBillArgs = new Map<string, BillProposalArgs>();

  // Bulk-load every distinct Senate roll_call_id we already have for this
  // Congress. FIX-463: single-pass `SELECT DISTINCT … LIKE $1` over a direct
  // pg.Client — same fix as the House loader above (was OFFSET-paginating the
  // full ~45k-row match set into a Set, tripping the prod 8s role timeout).
  const senateExistingIds = new Set<string>();
  {
    const senatePattern = `senate-${CURRENT_CONGRESS}-%`;
    try {
      const rows = await selectDirect<{ roll_call_id: string | null }>(
        "SELECT DISTINCT roll_call_id FROM votes WHERE roll_call_id LIKE $1",
        [senatePattern],
      );
      for (const row of rows) {
        if (row.roll_call_id) senateExistingIds.add(row.roll_call_id);
      }
    } catch (err) {
      console.warn(`  Senate skip-check load error: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.info(`  Pre-loaded ${senateExistingIds.size} existing Senate roll IDs`);
  }

  // Pass 1: fetch + parse XML for all novel rolls; buffer bill args + vote data
  for (const { session } of sessions) {
    console.info(`\n  Senate session ${session} — collecting rolls...`);

    const folderKey = `vote${CURRENT_CONGRESS}${session}`;

    for (let rollNum = 1; rollNum <= 500; rollNum++) {
      const paddedRoll = String(rollNum).padStart(5, "0");
      const url =
        `https://www.senate.gov/legislative/LIS/roll_call_votes/${folderKey}/` +
        `vote_${CURRENT_CONGRESS}_${session}_${paddedRoll}.xml`;
      const rollCallId = `senate-${CURRENT_CONGRESS}-${session}-${paddedRoll}`;

      try {
        if (senateExistingIds.has(rollCallId)) {
          continue;
        }

        console.info(`    Roll ${rollNum}: fetching...`);

        let xmlText: string;
        try {
          xmlText = await fetchText(url);
        } catch (fetchErr: unknown) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (msg.includes("HTTP 404")) {
            console.info(`    Roll ${rollNum}: 404 — no more rolls for session ${session}`);
            break;
          }
          console.error(`    Roll ${rollNum}: fetch error — ${msg}`);
          continue;
        }

        const parsed = xmlParser.parse(xmlText);
        const root = parsed["roll_call_vote"];

        if (!root) {
          console.error(`    Roll ${rollNum}: unexpected XML structure, skipping`);
          continue;
        }

        const voteDateStr  = String(root["vote_date"] ?? "");
        const votedAt      = parseSenateDate(voteDateStr);
        const voteQuestion = String(root["question"] ?? "");
        const resultStr    = String(root["result"] ?? "");

        const membersContainer = root["members"] as Record<string, unknown> | null;
        const memberList: unknown[] = membersContainer
          ? (Array.isArray(membersContainer["member"])
              ? membersContainer["member"]
              : membersContainer["member"]
                ? [membersContainer["member"]]
                : [])
          : [];

        const docBlock = root["document"] as Record<string, unknown> | null;
        let billKey: string | null = null;
        if (docBlock) {
          const rawDocType = String(docBlock["document_type"] ?? "");
          const docNumber  = String(docBlock["document_number"] ?? "");
          if (rawDocType && docNumber) {
            const upperDocType = rawDocType.trim().toUpperCase();
            // Presidential Nominations (cabinet, judicial, ambassador
            // confirmations) — the XML's <document_title> is the nominee
            // string; route them as type='appointment' with a PN identifier
            // so they don't end up as fake "S {N}" bills.
            if (upperDocType === "PN") {
              const documentTitle = String(docBlock["document_title"] ?? "").trim();
              const title = (documentTitle || `Presidential Nomination ${docNumber}`).slice(0, 500);
              const introducedIso = votedAt ? new Date(votedAt).toISOString() : null;
              billKey = `${CURRENT_CONGRESS}-PN-${docNumber}`;
              if (!senateBillArgs.has(billKey)) {
                senateBillArgs.set(billKey, {
                  billKey,
                  title,
                  billNumber:      `PN ${docNumber}`,
                  billType:        "PN",
                  chamber:         "senate",
                  type:            "appointment" as ProposalType,
                  status:          MINT_FLOOR, // FIX-1261: stamped at flush
                  jurisdictionId:  federalId,
                  governingBodyId: senateGovBodyId,
                  congressGovUrl:  `https://www.congress.gov/nomination/${CURRENT_CONGRESS}th-congress/${docNumber}`,
                  introducedAt:    introducedIso,
                  lastActionAt:    introducedIso,
                  congressNumber:  CURRENT_CONGRESS,
                  session:         String(CURRENT_CONGRESS),
                });
              }
            } else {
              const billType = normalizeSenateDocType(rawDocType);
              if (billType) {
                billKey = `${CURRENT_CONGRESS}-${billType}-${docNumber}`;
                if (!senateBillArgs.has(billKey)) {
                  const govBodyId      = chamberGovBodyId(billType, senateGovBodyId, houseGovBodyId);
                  const congressGovUrl = congressGovBillUrl(CURRENT_CONGRESS, billType, docNumber);
                  const introducedIso  = votedAt ? new Date(votedAt).toISOString() : null;
                  senateBillArgs.set(billKey, {
                    billKey,
                    title:           `${billType} ${docNumber}`,
                    billNumber:      `${billType} ${docNumber}`,
                    billType,
                    chamber:         chamberForBillType(billType),
                    type:            mapLegislationType(billType) as ProposalType,
                    status:          MINT_FLOOR, // FIX-1261: stamped at flush
                    jurisdictionId:  federalId,
                    governingBodyId: govBodyId,
                    congressGovUrl,
                    introducedAt:    introducedIso,
                    lastActionAt:    introducedIso,
                    congressNumber:  CURRENT_CONGRESS,
                    session:         String(CURRENT_CONGRESS),
                  });
                }
              } else {
                console.warn(
                  `    ${rollCallId}: unrecognized Senate document_type '${rawDocType}', skipping bill ref`
                );
              }
            }
          }
        }

        senateRollBuffer.push({ rollCallId, url, session, billKey, votedAt, voteQuestion, resultStr, memberList });
      } catch (err) {
        console.error(`    Senate roll ${rollNum} (session ${session}): unexpected error —`, err);
      }
    }
  }

  stampMintStatuses(senateBillArgs, senateRollBuffer);

  // Batch resolve: one bulk lookup + one bulk insert for novel bills
  console.info(`\n  Resolving ${senateBillArgs.size} unique Senate bills in batch...`);
  const senateBillKeyToId = await resolveBillsBatch(db, senateBillArgs, billKeyConflicts, mintedArgs);
  proposalsUpserted += [...senateBillKeyToId.values()].filter((v) => v !== null).length;

  // FIX-1238 — the same guard as the House side.
  const senateAbsent = await guardBillDetails(
    senateRollBuffer.filter((r) => r.votedAt).map((r) => r.billKey),
    senateBillKeyToId,
    senateBillArgs,
    billDetailsDeps,
  );

  // Pass 2: write vote records using the resolved proposalId map
  console.info("  Writing Senate vote records...");
  const senateWrite = await writeRollVotes<SenateRollItem, VoteInsert>(senateRollBuffer, {
    proposalIdFor: (billKey) => (billKey ? (senateBillKeyToId.get(billKey) ?? null) : null),
    absent: senateAbsent,
    build: (roll, proposalId, votedAtIso) => {
      const voteRecords: VoteInsert[] = [];
      for (const m of roll.memberList) {
        const mObj     = m as Record<string, unknown>;
        const lastName = String(mObj["last_name"] ?? "").trim();
        const state    = String(mObj["state"] ?? "").trim().toUpperCase();
        const voteText = String(mObj["vote_cast"] ?? "");
        if (!lastName || !state) continue;
        // Same key function the map was built with — normalization MUST be
        // symmetric or the lookup silently misses (FIX-940).
        const key        = senateNameKey(lastName, state);
        const officialId = key ? senatorByNameState.get(key) : undefined;
        if (!officialId) {
          senateUnmatched++;
          senateUnmatchedKeys.set(key || `${lastName}:${state}`, (senateUnmatchedKeys.get(key || `${lastName}:${state}`) ?? 0) + 1);
          continue;
        }
        voteRecords.push({
          official_id:      officialId,
          bill_proposal_id: proposalId,
          vote:             mapVote(voteText),
          chamber:          "Senate",
          roll_call_id:     roll.rollCallId,
          session:          String(roll.session),
          voted_at:         votedAtIso,
          vote_question:    roll.voteQuestion,
          source_url:       roll.url,
          metadata:         { vote_result: roll.resultStr },
        });
      }
      return voteRecords;
    },
    insert: async (records) => await db.from("votes").insert(records),
    log: (line) => console.info(line),
  });
  votesInserted += senateWrite.inserted;
  skippedRolls.push(...senateWrite.skipped);
  insertFailures.push(...senateWrite.insertFailures);

  // FIX-1257: the House pass, for the Senate. Inert today: `root["result"]`
  // above reads an element the LIS XML does not have, so every Senate roll's
  // resultStr is "" (prod 2026-10-03: 1,893 of 1,893 Senate rolls store
  // vote_result "") and mapVoteResult("") is floor_vote — FIX-1260.
  {
    const landed = new Set(senateWrite.landed);
    mergeAdvance(statusResult, await advanceProposalStatuses(db, rollPassageAdvances(
      senateRollBuffer.filter((r) => landed.has(r.rollCallId)),
      (billKey) => (billKey ? (senateBillKeyToId.get(billKey) ?? null) : null),
    )));
  }

  if (houseUnmatched > 0) {
    console.info(`\n  House unmatched bioguide IDs (no official in DB): ${houseUnmatched}`);
  }
  if (senateUnmatched > 0) {
    // FIX-940: an unmatched Senator is now the DESIGNED failure mode — the map
    // refuses ambiguous slots rather than guessing — so this has to be visible
    // rather than a quiet tail line. Each key here is a sitting member whose
    // roll-calls were dropped, not misfiled; every one is worth chasing.
    console.warn(
      `\n  ⚠ FIX-940: ${senateUnmatched} Senate vote record(s) matched no current ` +
        `member across ${senateUnmatchedKeys.size} distinct name:state key(s). ` +
        `These votes were NOT written.`,
    );
    for (const [key, n] of [...senateUnmatchedKeys].sort((a, b) => b[1] - a[1])) {
      console.warn(`      ${key.padEnd(28)} ${n} record(s)`);
    }
  }

  if (skippedRolls.length > 0) {
    console.warn(
      `\n  ⚠ FIX-1238: ${skippedRolls.length} roll(s) skipped — their bill has no bill_details row ` +
        `(votes.bill_proposal_id's FK target): ${skippedRolls.map((s) => `${s.roll} (${s.bill_key})`).join(", ")}`,
    );
  }

  if (billKeyConflicts.length > 0) {
    console.warn(
      `\n  ⚠ FIX-1256: ${billKeyConflicts.length} bill key(s) not bound to one proposal: ` +
        billKeyConflicts
          .map((c) => `${c.bill_key} (${c.reason}; holder ${c.holder_proposal_id ?? "?"})`)
          .join(", "),
    );
  }

  if (statusResult.moved.length > 0 || statusResult.held > 0 || statusResult.failed > 0) {
    console.info(
      `\n  FIX-1257: status advanced on ${statusResult.moved.length} proposal(s), held on ${statusResult.held}` +
        (statusResult.failed > 0 ? `, ${statusResult.failed} pair(s) not sent (RPC error)` : "") +
        (statusResult.moved.length > 0
          ? ": " + statusResult.moved.slice(0, 20).map((m) => `${m.id} ${m.from}→${m.to} (${m.via})`).join(", ")
          : ""),
    );
  }

  console.info(
    `\nVotes pipeline complete: ${proposalsUpserted} proposals upserted, ${votesInserted} votes inserted, ` +
      `${skippedRolls.length} roll(s) skipped, ${insertFailures.length} roll insert(s) failed, ` +
      `${billKeyConflicts.length} bill key conflict(s)`
  );

    const estimatedMb = +(((proposalsUpserted + votesInserted) * 200) / 1024 / 1024).toFixed(2);
    // FIX-1238: rows_failed counts ROLLS not written — skipped for a missing
    // bill_details row, or whose insert failed for any other reason. It used
    // to be a hard-coded 0 while a 433-row roll failed every night.
    // FIX-1256: plus every bill key not bound to exactly one proposal.
    await completeSync(logId, {
      inserted: votesInserted,
      updated: proposalsUpserted,
      failed: skippedRolls.length + insertFailures.length + billKeyConflicts.length,
      estimatedMb,
      metadata: {
        skipped_rolls: skippedRolls,
        insert_failures: insertFailures,
        bill_key_conflicts: billKeyConflicts,
        // FIX-1257: status moves are not failures — a held pair is the rule
        // working (evidence older than the stored stage). An RPC error is
        // logged and counted here, not in rows_failed: the votes still landed.
        status_advanced: statusResult.moved.length,
        status_held: statusResult.held,
        status_advance_failed: statusResult.failed,
        status_moves: statusResult.moved.slice(0, 100),
        // FIX-1261: novel bills minted by the vote path, by status. `failed`
        // never appears: the mint reads the question (bill-status.ts).
        minted: countMinted(mintedArgs),
      },
    });

    return { proposalsUpserted, votesInserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failSync(logId, msg);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["CONGRESS_API_KEY"];
  if (!apiKey) {
    console.error(
      "Error: CONGRESS_API_KEY environment variable is not set.\n" +
        "Add it to .env.local and re-run."
    );
    process.exit(1);
  }

  const { seedJurisdictions, seedGoverningBodies } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    try {
      const { federalId } = await seedJurisdictions(db);
      const { senateId, houseId } = await seedGoverningBodies(db, federalId);

      const result = await runVotesPipeline({
        apiKey,
        federalId,
        senateGovBodyId: senateId,
        houseGovBodyId: houseId,
      });

      console.info("Votes pipeline complete:", result);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
}
