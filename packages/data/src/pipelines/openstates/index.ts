/**
 * OpenStates pipeline.
 *
 * Fetches current-term legislators for all 50 states + DC and upserts
 * them into the officials table. Creates governing_body records for each
 * state chamber (upper/lower) as needed.
 *
 * Storage target: ~30 MB
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:states
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { sleep, fetchJson } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { STATE_DATA } from "../../jurisdictions/us-states";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"];
type GovBodyInsert  = Database["public"]["Tables"]["governing_bodies"]["Insert"];
type GovBodyType    = Database["public"]["Enums"]["governing_body_type"];

interface OSPerson {
  id:           string;
  name:         string;
  party:        string;
  openstates_url: string;
  current_role: {
    title:                string;
    org_classification:   string;   // "upper" | "lower" | "legislature"
    district:             string;
    division_id:          string;
    end_date:             string | null;
    start_date:           string | null;
  } | null;
}

interface OSPersonList {
  results:  OSPerson[];
  pagination: { max_page: number; page: number; per_page: number; total_items: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OS_BASE = "https://v3.openstates.org";

async function fetchLegislators(
  apiKey: string,
  jurisdictionId: string,
  orgClass: "upper" | "lower",
  page: number
): Promise<OSPersonList> {
  await sleep(100);
  const url = new URL(`${OS_BASE}/people`);
  url.searchParams.set("jurisdiction",      jurisdictionId);
  url.searchParams.set("org_classification", orgClass);
  url.searchParams.set("per_page",           "50");
  url.searchParams.set("page",               String(page));
  return fetchJson<OSPersonList>(url.toString(), {
    headers: { "X-API-KEY": apiKey },
  });
}

function mapParty(party: string): OfficialInsert["party"] {
  const p = party.toLowerCase();
  if (p.includes("democrat")) return "democrat";
  if (p.includes("republican")) return "republican";
  if (p.includes("independent")) return "independent";
  if (p.includes("libertarian")) return "libertarian";
  if (p.includes("green")) return "green";
  return "other";
}

function mapChamberType(orgClass: string): GovBodyType {
  if (orgClass === "upper") return "legislature_upper";
  if (orgClass === "lower") return "legislature_lower";
  return "legislature_unicameral";
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runOpenStatesPipeline(
  apiKey: string,
  stateIds: Map<string, string>   // state name → jurisdiction UUID
): Promise<PipelineResult> {
  console.log("\n=== OpenStates pipeline ===");
  const logId = await startSync("openstates");
  const db = createAdminClient();
  let inserted = 0, updated = 0, failed = 0;

  // Cache: "stateAbbr:chamberType" → governing_body UUID
  const govBodyCache = new Map<string, string>();

  async function findOrCreateGovBody(
    stateAbbr: string,
    stateName: string,
    jurisdictionId: string,
    orgClass: string
  ): Promise<string | null> {
    const cacheKey = `${stateAbbr}:${orgClass}`;
    if (govBodyCache.has(cacheKey)) return govBodyCache.get(cacheKey)!;

    const bodyType  = mapChamberType(orgClass);
    const chamberLabel = orgClass === "upper" ? "Senate" : orgClass === "lower" ? "House" : "Legislature";
    const bodyName  = `${stateName} State ${chamberLabel}`;

    try {
      const { data: existing } = await db
        .from("governing_bodies")
        .select("id")
        .eq("jurisdiction_id", jurisdictionId)
        .eq("type", bodyType)
        .maybeSingle();

      if (existing) {
        govBodyCache.set(cacheKey, existing.id as string);
        return existing.id as string;
      }

      const row: GovBodyInsert = {
        jurisdiction_id: jurisdictionId,
        type:            bodyType,
        name:            bodyName,
        short_name:      `${stateAbbr} ${chamberLabel}`,
        is_active:       true,
      };
      const { data: created, error } = await db
        .from("governing_bodies").insert(row).select("id").single();
      if (error) {
        console.error(`    GovBody ${bodyName}: insert error — ${error.message}`);
        return null;
      }
      govBodyCache.set(cacheKey, created.id as string);
      return created.id as string;
    } catch (err) {
      console.error(`    GovBody ${bodyName}: unexpected error —`, err);
      return null;
    }
  }

  try {
    // Iterate over all states
    for (const state of STATE_DATA) {
      const jurisdictionId = stateIds.get(state.name);
      if (!jurisdictionId) {
        console.warn(`    No jurisdiction ID for ${state.name}, skipping`);
        continue;
      }

      // OpenStates OCD jurisdiction ID
      const ocdId = `ocd-jurisdiction/country:us/state:${state.abbr.toLowerCase()}/government`;
      console.log(`  ${state.abbr} — fetching legislators...`);

      let totalFetched = 0;

      // Fetch upper (senate) and lower (house) chambers separately
      for (const chamberClass of ["upper", "lower"] as const) {
        let page = 1;

      while (true) {
        let list: OSPersonList;
        try {
          list = await fetchLegislators(apiKey, ocdId, chamberClass, page);
        } catch (err) {
          console.error(`    ${state.abbr} ${chamberClass} page ${page}: fetch error —`, err instanceof Error ? err.message : err);
          break;
        }

        for (const person of list.results ?? []) {
          const role = person.current_role;
          if (!role) continue;

          const orgClass     = chamberClass;
          const govBodyId    = await findOrCreateGovBody(state.abbr, state.name, jurisdictionId, orgClass);
          const osId         = person.id;

          // Skip if gov body creation failed — record would be useless without it
          if (!govBodyId) { failed++; continue; }

          const record: OfficialInsert = {
            full_name:        person.name,
            role_title:       role.title || (orgClass === "upper" ? "State Senator" : "State Representative"),
            governing_body_id: govBodyId,
            jurisdiction_id:  jurisdictionId,
            party:            mapParty(person.party),
            district_name:    role.district || null,
            term_start:       role.start_date ?? null,
            term_end:         role.end_date   ?? null,
            is_active:        true,
            is_verified:      false,
            website_url:      person.openstates_url || null,
            source_ids:       { openstates_id: osId },
            metadata:         { state_abbr: state.abbr, org_classification: orgClass },
          };

          try {
            const { data: existing } = await db
              .from("officials")
              .select("id")
              .filter("source_ids->>openstates_id", "eq", osId)
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
            console.error(`    ${person.name}: error —`, err);
            failed++;
          }
        }

        totalFetched += (list.results ?? []).length;
        if (page >= list.pagination.max_page) break;
        page++;
      }
      } // end chamberClass loop

      console.log(`    ${state.abbr}: ${totalFetched} legislators`);
    }

    const estimatedMb = +((inserted + updated) * 1247 / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.log(`  Done — inserted: ${inserted}, updated: ${updated}, failed: ${failed}`);
    console.log(`  Estimated storage: ~${estimatedMb} MB`);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  OpenStates pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted, updated, failed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["OPENSTATES_API_KEY"];
  if (!apiKey) { console.error("OPENSTATES_API_KEY not set"); process.exit(1); }

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
