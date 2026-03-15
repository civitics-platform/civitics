/**
 * Congress bills/proposals + individual member vote records pipeline.
 *
 * Proposals are fetched from the Congress.gov v3 API (which has no /vote endpoint).
 * Individual member vote records are fetched from the official XML feeds:
 *   - House: https://clerk.house.gov/evs/{year}/roll{NNN}.xml
 *   - Senate: https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{NNNNN}.xml
 *
 * Run standalone:  pnpm --filter @civitics/data data:votes
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import {
  fetchCongressApi,
  fetchText,
  mapLegislationType,
  mapVote,
  mapVoteResult,
  sleep,
  CURRENT_CONGRESS,
} from "./members";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];
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

function mapBillStatus(latestActionText: string | undefined): ProposalStatus {
  if (!latestActionText) return "introduced";
  const t = latestActionText.toLowerCase();
  if (t.includes("became public law") || t.includes("signed by president")) return "enacted";
  if (t.includes("signed") && t.includes("president")) return "signed";
  if (t.includes("vetoed")) return "vetoed";
  if (t.includes("passed") && (t.includes("senate") || t.includes("house"))) {
    if (t.includes("both") || (t.includes("senate") && t.includes("house"))) {
      return "passed_both_chambers";
    }
    return "passed_chamber";
  }
  if (t.includes("reported") || t.includes("ordered to be reported")) return "passed_committee";
  if (t.includes("referred to")) return "in_committee";
  return "introduced";
}

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

  // Normalize: uppercase, collapse whitespace, remove dots
  // "H.J.RES. 2" → "H J RES 2",  "H R 29" stays "H R 29"
  const s = legisNum.trim().toUpperCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();

  // Order matters — check longer prefixes first
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
  // Bare "S NNN" — must be followed by a digit to avoid matching "S RES" already handled
  if (/^S \d/.test(s)) {
    const num = s.slice(2).trim();
    return num ? { type: "S", number: num } : null;
  }

  return null;
}

/**
 * Normalize Senate document_type strings to our bill type codes.
 */
function normalizeSenateDocType(docType: string): string {
  const t = docType.trim().toUpperCase();
  if (t === "S." || t === "S") return "S";
  if (t === "H.R." || t === "H.R") return "HR";
  if (t === "S.RES." || t === "S.RES" || t === "S. RES.") return "SRES";
  if (t === "H.RES." || t === "H.RES" || t === "H. RES.") return "HRES";
  if (t === "S.J.RES." || t === "S.J.RES" || t === "S.J. RES.") return "SJRES";
  if (t === "H.J.RES." || t === "H.J.RES" || t === "H.J. RES.") return "HJRES";
  if (t === "S.CON.RES." || t === "S.CON.RES" || t === "S. CON. RES.") return "SCONRES";
  if (t === "H.CON.RES." || t === "H.CON.RES" || t === "H. CON. RES.") return "HCONRES";
  return "S"; // fallback
}

/**
 * Parse House action-date like "03-Jan-2025" → "2025-01-03"
 */
function parseHouseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  // Format: "DD-Mon-YYYY"
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

  // "Month D, YYYY,  HH:MM AM/PM" — Senate LIS XML format
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

  // "MM-DD-YYYY" legacy format
  const shortMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (shortMatch) {
    const [, mm, dd, yyyy] = shortMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// findOrCreateProposal helper
// ---------------------------------------------------------------------------

interface FindOrCreateProposalArgs {
  billKey: string;
  title: string;
  type: ProposalType;
  status: ProposalStatus;
  govBodyId: string;
  federalId: string;
  congressGovUrl: string;
  introducedAt: string | null;
  lastActionAt: string | null;
  latestActionText?: string;
}

async function findOrCreateProposal(
  db: ReturnType<typeof createAdminClient>,
  args: FindOrCreateProposalArgs
): Promise<string | null> {
  const {
    billKey,
    title,
    type,
    status,
    govBodyId,
    federalId,
    congressGovUrl,
    introducedAt,
    lastActionAt,
    latestActionText,
  } = args;

  try {
    const { data: existing, error: selectErr } = await db
      .from("proposals")
      .select("id")
      .filter("source_ids->>congress_gov_bill", "eq", billKey)
      .maybeSingle();

    if (selectErr) {
      console.error(`    Error checking proposal ${billKey}:`, selectErr.message);
      return null;
    }

    if (existing) {
      return existing.id as string;
    }

    // Derive bill_number from the key, e.g. "119-HR-1" → "HR 1"
    const parts = billKey.split("-");
    const billNumber = parts.length >= 3 ? `${parts[1]} ${parts.slice(2).join("-")}` : billKey;

    const record: ProposalInsert = {
      title: title.slice(0, 500),
      bill_number: billNumber,
      type,
      jurisdiction_id: federalId,
      congress_number: CURRENT_CONGRESS,
      session: String(CURRENT_CONGRESS),
      status,
      governing_body_id: govBodyId,
      source_ids: { congress_gov_bill: billKey },
      congress_gov_url: congressGovUrl,
      introduced_at: introducedAt,
      last_action_at: lastActionAt,
      metadata: latestActionText ? { latest_action: latestActionText } : {},
    };

    const { data: inserted, error: insertErr } = await db
      .from("proposals")
      .insert(record)
      .select("id")
      .single();

    if (insertErr) {
      console.error(`    Error inserting proposal ${billKey}:`, insertErr.message);
      return null;
    }

    return inserted.id as string;
  } catch (err) {
    console.error(`    Unexpected error in findOrCreateProposal for ${billKey}:`, err);
    return null;
  }
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

async function buildOfficialMaps(
  db: ReturnType<typeof createAdminClient>,
  senateGovBodyId: string
): Promise<OfficialMaps> {
  const officialMap = new Map<string, string>();
  const senatorByNameState = new Map<string, string>();

  // ---- All officials: bioguide ID → UUID (for House lookups) ----
  const { data: allOfficials, error: officialsErr } = await db
    .from("officials")
    .select("id, source_ids");

  if (officialsErr) {
    console.error("  Error fetching officials for bioguide map:", officialsErr.message);
  } else if (allOfficials) {
    for (const o of allOfficials) {
      const src = o.source_ids as Record<string, string> | null;
      const bioguide = src?.["congress_gov"];
      if (bioguide) {
        officialMap.set(bioguide, o.id as string);
      }
    }
    console.log(`  Built bioguide map with ${officialMap.size} entries`);
  }

  // ---- Senators: "lastName:state" → UUID ----
  // We need last_name and state abbreviation. State abbr lives in jurisdictions.short_name.
  const { data: senators, error: senErr } = await db
    .from("officials")
    .select("id, last_name, jurisdiction_id")
    .eq("governing_body_id", senateGovBodyId);

  if (senErr) {
    console.error("  Error fetching senators:", senErr.message);
  } else if (senators && senators.length > 0) {
    // Collect distinct jurisdiction IDs
    const jidSet = new Set(senators.map((s) => s.jurisdiction_id).filter(Boolean));
    const jids = Array.from(jidSet) as string[];

    const { data: jurisdictions, error: jErr } = await db
      .from("jurisdictions")
      .select("id, short_name")
      .in("id", jids);

    if (jErr) {
      console.error("  Error fetching jurisdictions for senator map:", jErr.message);
    } else if (jurisdictions) {
      const jMap = new Map<string, string>(
        jurisdictions.map((j) => [j.id as string, (j.short_name as string | null) ?? ""])
      );

      for (const s of senators) {
        const lastName = (s.last_name as string | null) ?? "";
        const stateAbbr = s.jurisdiction_id ? (jMap.get(s.jurisdiction_id as string) ?? "") : "";
        if (lastName && stateAbbr) {
          const key = `${lastName.toLowerCase()}:${stateAbbr.toUpperCase()}`;
          senatorByNameState.set(key, s.id as string);
        }
      }
      console.log(`  Built senator name:state map with ${senatorByNameState.size} entries`);
    }
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

  console.log("Starting Congress bills + XML member votes pipeline...");

  const db = createAdminClient();

  let proposalsUpserted = 0;
  let votesInserted = 0;

  // -------------------------------------------------------------------------
  // Build official lookup maps
  // -------------------------------------------------------------------------

  const { officialMap, senatorByNameState } = await buildOfficialMaps(db, senateGovBodyId);

  // -------------------------------------------------------------------------
  // 119th Congress session → calendar year mapping
  // Session 1 = 2025, Session 2 = 2026
  // -------------------------------------------------------------------------

  const sessions: Array<{ session: number; year: number }> = [
    { session: 1, year: 2025 },
    { session: 2, year: 2026 },
  ];

  // -------------------------------------------------------------------------
  // House Clerk XML vote feeds
  // -------------------------------------------------------------------------

  console.log("\n--- Fetching House Clerk XML votes ---");

  let houseSenateUnmatched = 0;

  for (const { session, year } of sessions) {
    console.log(`\n  House session ${session} (${year}):`);

    for (let rollNum = 1; rollNum <= 500; rollNum++) {
      const paddedRoll = String(rollNum).padStart(3, "0");
      const url = `https://clerk.house.gov/evs/${year}/roll${paddedRoll}.xml`;

      try {
        // Skip guard: check if votes already exist for this roll call
        const { data: existing } = await db
          .from("votes")
          .select("id")
          .eq("roll_call_number", String(rollNum))
          .eq("chamber", "House")
          .eq("session", String(session))
          .limit(1)
          .maybeSingle();

        if (existing) {
          console.log(`    Roll ${rollNum}: already in DB, skipping`);
          continue;
        }

        console.log(`    Processing House session ${session} roll call ${rollNum}...`);

        let xmlText: string;
        try {
          xmlText = await fetchText(url);
        } catch (fetchErr: unknown) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (msg.includes("HTTP 404")) {
            console.log(`    Roll ${rollNum}: 404 — no more rolls for session ${session}`);
            break; // stop iterating this session
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

        // Parse bill reference (may be absent for procedural votes)
        const legisNum = meta["legis-num"] ?? "";
        const billRef = parseHouseLegisNum(String(legisNum));

        // Parse vote date
        const actionDateStr = meta["action-date"] ?? "";
        const votedAt = parseHouseDate(String(actionDateStr));

        // Parse result → status
        const resultStr = String(meta["vote-result"] ?? "");
        const proposalStatus = mapVoteResult(resultStr) as ProposalStatus;
        const voteQuestion = String(meta["vote-question"] ?? "");

        // Find or create proposal if we have a bill reference
        let proposalId: string | null = null;
        if (billRef) {
          const billKey = `${CURRENT_CONGRESS}-${billRef.type}-${billRef.number}`;
          const billTitle = voteQuestion || `${billRef.type} ${billRef.number}`;
          const proposalType = mapLegislationType(billRef.type) as ProposalType;
          const govBodyId = chamberGovBodyId(billRef.type, senateGovBodyId, houseGovBodyId);
          const congressGovUrl = congressGovBillUrl(CURRENT_CONGRESS, billRef.type, billRef.number);

          proposalId = await findOrCreateProposal(db, {
            billKey,
            title: billTitle,
            type: proposalType,
            status: proposalStatus,
            govBodyId,
            federalId,
            congressGovUrl,
            introducedAt: votedAt ? new Date(votedAt).toISOString() : null,
            lastActionAt: votedAt ? new Date(votedAt).toISOString() : null,
          });

          if (proposalId) proposalsUpserted++;
        }

        // Build vote records
        const recordedVotes: unknown[] = Array.isArray(voteData["recorded-vote"])
          ? voteData["recorded-vote"]
          : voteData["recorded-vote"]
            ? [voteData["recorded-vote"]]
            : [];

        const voteRecords: VoteInsert[] = [];

        // Only insert vote records when we can link them to a known proposal
        if (!proposalId) {
          console.log(`    Roll ${rollNum}: no proposal reference, skipping vote records`);
        } else {
          for (const rv of recordedVotes) {
            const rvObj = rv as Record<string, unknown>;
            const legislator = rvObj["legislator"] as Record<string, unknown> | null;
            const voteText = String(rvObj["vote"] ?? "");

            if (!legislator) continue;

            const bioguide = String(legislator["@_name-id"] ?? "");
            if (!bioguide) continue; // skip if attribute is missing

            const officialId = officialMap.get(bioguide);
            if (!officialId) {
              houseSenateUnmatched++;
              continue;
            }

            const voteRecord: VoteInsert = {
              official_id: officialId,
              proposal_id: proposalId,
              vote: mapVote(voteText),
              chamber: "House",
              roll_call_number: String(rollNum),
              session: String(session),
              voted_at: votedAt ? new Date(votedAt).toISOString() : null,
              source_ids: {
                house_clerk_url: url,
                roll_call: `${year}-house-${paddedRoll}`,
              },
              metadata: {
                vote_question: voteQuestion,
                vote_result: resultStr,
                legis_num: legisNum,
              },
            };

            voteRecords.push(voteRecord);
          }
        }

        if (voteRecords.length > 0) {
          const { error: insertErr } = await db
            .from("votes")
            .insert(voteRecords);
          // 23505 = unique_violation — expected when multiple roll calls reference
          // the same bill (recommit, amendment, passage). Safe to ignore until
          // migration 0002 is applied to widen the unique constraint.
          if (insertErr && insertErr.code !== "23505") {
            console.error(`    Roll ${rollNum}: insert error — ${insertErr.message}`);
          } else if (insertErr?.code === "23505") {
            console.log(`    Roll ${rollNum}: prior vote exists for this bill (apply migration 0002 to store all roll calls)`);
          } else {
            votesInserted += voteRecords.length;
            console.log(`    Roll ${rollNum}: inserted ${voteRecords.length} votes`);
          }
        } else {
          console.log(`    Roll ${rollNum}: no matchable vote records`);
        }
      } catch (err) {
        console.error(`    House roll ${rollNum} (session ${session}): unexpected error —`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Senate LIS XML vote feeds
  // -------------------------------------------------------------------------

  console.log("\n--- Fetching Senate LIS XML votes ---");

  let senateUnmatched = 0;

  for (const { session } of sessions) {
    console.log(`\n  Senate session ${session}:`);

    // Senate folder key: vote{congress}{session} e.g. "vote1191"
    const folderKey = `vote${CURRENT_CONGRESS}${session}`;

    for (let rollNum = 1; rollNum <= 500; rollNum++) {
      const paddedRoll = String(rollNum).padStart(5, "0");
      const url =
        `https://www.senate.gov/legislative/LIS/roll_call_votes/${folderKey}/` +
        `vote_${CURRENT_CONGRESS}_${session}_${paddedRoll}.xml`;

      try {
        // Skip guard
        const { data: existing } = await db
          .from("votes")
          .select("id")
          .eq("roll_call_number", String(rollNum))
          .eq("chamber", "Senate")
          .eq("session", String(session))
          .limit(1)
          .maybeSingle();

        if (existing) {
          console.log(`    Roll ${rollNum}: already in DB, skipping`);
          continue;
        }

        console.log(`    Processing Senate session ${session} roll call ${rollNum}...`);

        let xmlText: string;
        try {
          xmlText = await fetchText(url);
        } catch (fetchErr: unknown) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (msg.includes("HTTP 404")) {
            console.log(`    Roll ${rollNum}: 404 — no more rolls for session ${session}`);
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

        // Parse bill reference from document block
        const docBlock = root["document"] as Record<string, unknown> | null;
        let proposalId: string | null = null;

        if (docBlock) {
          const rawDocType = String(docBlock["document_type"] ?? "");
          const docNumber = String(docBlock["document_number"] ?? "");
          if (rawDocType && docNumber) {
            const billType = normalizeSenateDocType(rawDocType);
            const billKey = `${CURRENT_CONGRESS}-${billType}-${docNumber}`;
            const voteQuestion = String(root["question"] ?? "");
            const resultStr = String(root["result"] ?? "");
            const proposalStatus = mapVoteResult(resultStr) as ProposalStatus;
            const proposalType = mapLegislationType(billType) as ProposalType;
            const govBodyId = chamberGovBodyId(billType, senateGovBodyId, houseGovBodyId);
            const congressGovUrl = congressGovBillUrl(CURRENT_CONGRESS, billType, docNumber);

            const voteDateStr = String(root["vote_date"] ?? "");
            const votedAt = parseSenateDate(voteDateStr);

            proposalId = await findOrCreateProposal(db, {
              billKey,
              title: voteQuestion || `${billType} ${docNumber}`,
              type: proposalType,
              status: proposalStatus,
              govBodyId,
              federalId,
              congressGovUrl,
              introducedAt: votedAt ? new Date(votedAt).toISOString() : null,
              lastActionAt: votedAt ? new Date(votedAt).toISOString() : null,
            });

            if (proposalId) proposalsUpserted++;
          }
        }

        const voteDateStr = String(root["vote_date"] ?? "");
        const votedAt = parseSenateDate(voteDateStr);
        const voteQuestion = String(root["question"] ?? "");
        const resultStr = String(root["result"] ?? "");

        // Build vote records
        const membersContainer = root["members"] as Record<string, unknown> | null;
        const memberList: unknown[] = membersContainer
          ? (Array.isArray(membersContainer["member"])
              ? membersContainer["member"]
              : membersContainer["member"]
                ? [membersContainer["member"]]
                : [])
          : [];

        const voteRecords: VoteInsert[] = [];

        // Only insert vote records when we can link them to a known proposal
        if (!proposalId) {
          console.log(`    Roll ${rollNum}: no proposal reference, skipping vote records`);
        } else {
          for (const m of memberList) {
            const mObj = m as Record<string, unknown>;
            const lastName = String(mObj["last_name"] ?? "").trim();
            const state = String(mObj["state"] ?? "").trim().toUpperCase();
            const voteText = String(mObj["vote_cast"] ?? "");

            if (!lastName || !state) continue;

            const key = `${lastName.toLowerCase()}:${state}`;
            const officialId = senatorByNameState.get(key);

            if (!officialId) {
              senateUnmatched++;
              continue;
            }

            const voteRecord: VoteInsert = {
              official_id: officialId,
              proposal_id: proposalId,
              vote: mapVote(voteText),
              chamber: "Senate",
              roll_call_number: String(rollNum),
              session: String(session),
              voted_at: votedAt ? new Date(votedAt).toISOString() : null,
              source_ids: {
                senate_lis_url: url,
                roll_call: `senate-${CURRENT_CONGRESS}-${session}-${paddedRoll}`,
              },
              metadata: {
                vote_question: voteQuestion,
                vote_result: resultStr,
              },
            };

            voteRecords.push(voteRecord);
          }
        }

        if (voteRecords.length > 0) {
          const { error: insertErr } = await db
            .from("votes")
            .insert(voteRecords);
          // 23505 = unique_violation — expected when multiple roll calls reference
          // the same bill (recommit, amendment, passage). Safe to ignore until
          // migration 0002 is applied to widen the unique constraint.
          if (insertErr && insertErr.code !== "23505") {
            console.error(`    Roll ${rollNum}: insert error — ${insertErr.message}`);
          } else if (insertErr?.code === "23505") {
            console.log(`    Roll ${rollNum}: prior vote exists for this bill (apply migration 0002 to store all roll calls)`);
          } else {
            votesInserted += voteRecords.length;
            console.log(`    Roll ${rollNum}: inserted ${voteRecords.length} votes`);
          }
        } else {
          console.log(`    Roll ${rollNum}: no matchable vote records`);
        }
      } catch (err) {
        console.error(`    Senate roll ${rollNum} (session ${session}): unexpected error —`, err);
      }
    }
  }

  if (houseSenateUnmatched > 0) {
    console.log(`\n  House unmatched bioguide IDs (no official in DB): ${houseSenateUnmatched}`);
  }
  if (senateUnmatched > 0) {
    console.log(`  Senate unmatched name:state keys (no official in DB): ${senateUnmatched}`);
  }

  // -------------------------------------------------------------------------
  // Fetch recent bills from Congress.gov to populate proposals
  // -------------------------------------------------------------------------

  console.log("\n--- Fetching Congress.gov bills for proposal records ---");

  const billTypes = [
    { type: "hr",    label: "House bills" },
    { type: "s",     label: "Senate bills" },
    { type: "hjres", label: "House joint resolutions" },
    { type: "sjres", label: "Senate joint resolutions" },
  ] as const;

  for (const { type, label } of billTypes) {
    console.log(`\n  Fetching recent ${label}...`);

    let bills: BillSummary[] = [];

    try {
      const listData = await fetchCongressApi<BillListResponse>(
        `bill/${CURRENT_CONGRESS}/${type}?sort=updateDate+desc&limit=50`,
        apiKey
      );
      bills = listData.bills ?? [];
      console.log(`  Got ${bills.length} ${label}`);
    } catch (err) {
      console.error(`  Error fetching ${label}:`, err);
      continue;
    }

    for (const bill of bills) {
      const billKey = `${bill.congress}-${bill.type}-${bill.number}`;
      const billNumber = `${bill.type} ${bill.number}`;
      const title = (bill.title ?? billNumber).slice(0, 500);
      const proposalType = mapLegislationType(bill.type) as ProposalType;
      const status = mapBillStatus(bill.latestAction?.text) as ProposalStatus;
      const govBodyId = chamberGovBodyId(bill.type, senateGovBodyId, houseGovBodyId);
      const congressGovUrl = congressGovBillUrl(bill.congress, bill.type, bill.number);

      try {
        const { data: existing, error: selectErr } = await db
          .from("proposals")
          .select("id")
          .filter("source_ids->>congress_gov_bill", "eq", billKey)
          .maybeSingle();

        if (selectErr) {
          console.error(`  Error checking proposal ${billKey}:`, selectErr);
          continue;
        }

        if (existing) {
          // Update status (bill may have advanced since last run)
          await db
            .from("proposals")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          proposalsUpserted++;
        } else {
          const record: ProposalInsert = {
            title,
            bill_number: billNumber,
            type: proposalType,
            jurisdiction_id: federalId,
            congress_number: CURRENT_CONGRESS,
            session: String(CURRENT_CONGRESS),
            status,
            governing_body_id: govBodyId,
            source_ids: { congress_gov_bill: billKey },
            congress_gov_url: congressGovUrl,
            introduced_at: bill.introducedDate
              ? new Date(bill.introducedDate).toISOString()
              : null,
            last_action_at: bill.latestAction?.actionDate
              ? new Date(bill.latestAction.actionDate).toISOString()
              : null,
            metadata: bill.latestAction?.text
              ? { latest_action: bill.latestAction.text }
              : {},
          };

          const { error: insertErr } = await db.from("proposals").insert(record);

          if (insertErr) {
            console.error(`  Error inserting proposal ${billKey}:`, insertErr);
          } else {
            proposalsUpserted++;
          }
        }
      } catch (err) {
        console.error(`  Unexpected error processing bill ${billKey}:`, err);
      }

      // Small pause between records
      await sleep(50);
    }

    console.log(`  Proposals upserted so far: ${proposalsUpserted}`);
  }

  console.log(
    `\nVotes pipeline complete: ${proposalsUpserted} proposals upserted, ${votesInserted} votes inserted`
  );

  return { proposalsUpserted, votesInserted };
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

      console.log("Votes pipeline complete:", result);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
}
