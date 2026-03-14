/**
 * Congress.gov bills + proposals pipeline.
 *
 * NOTE: The Congress.gov v3 API has no /vote endpoint (returns "Unknown resource").
 * Individual member vote records require the ProPublica Congress API (free, separate
 * key — sign up at propublica.org/datastore/api/propublica-congress-api).
 *
 * This pipeline instead fetches recent bills and creates proposal records, which
 * is the primary Phase 1 goal. The `votesInserted` count will be 0 until the
 * ProPublica integration is added.
 *
 * Run standalone:  pnpm --filter @civitics/data data:votes
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import {
  fetchCongressApi,
  mapLegislationType,
  sleep,
  CURRENT_CONGRESS,
} from "./members";

type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

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
// Congress.gov bill list response types
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
// Helpers
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

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runVotesPipeline(
  options: VotesPipelineOptions
): Promise<VotesPipelineResult> {
  const { apiKey, federalId, senateGovBodyId, houseGovBodyId } = options;

  console.log("Starting Congress.gov bills/proposals pipeline...");
  console.log(
    "  Note: The Congress.gov v3 API has no /vote endpoint.\n" +
    "  Fetching bills to create proposal records.\n" +
    "  Member-level vote records will be added via ProPublica API."
  );

  const db = createAdminClient();

  let proposalsUpserted = 0;
  const votesInserted = 0; // requires ProPublica API — not implemented here

  // Fetch recent bills for each major bill type
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
        // Check if proposal already exists
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

      // Small pause between records (fetchCongressApi already handles the list call delay)
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

      console.log("Proposals pipeline complete:", result);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
}
