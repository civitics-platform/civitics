/**
 * US jurisdictions seed — 50 states, DC, and the federal level.
 *
 * Run standalone:  pnpm --filter @civitics/data data:jurisdictions
 */

import { createAdminClient } from "@civitics/db";

// ---------------------------------------------------------------------------
// State data
// ---------------------------------------------------------------------------

interface StateRecord {
  name: string;
  abbr: string;
  fips: string;
  timezone: string;
  type: "state" | "district";
}

// FIX-385: Congress.gov returns `member.state = "Virgin Islands"` for VI's
// delegate, which does not match STATE_DATA.name = "U.S. Virgin Islands" —
// the name-keyed lookup misses and the caller falls back to federalId. Other
// territories (AS/GU/MP/PR) and DC return strings that match STATE_DATA.name
// directly, so no aliases are needed for them today. Extend this map only
// when prod data confirms an additional Congress.gov string mismatches.
const CONGRESS_STATE_ALIASES: Record<string, string> = {
  "U.S. Virgin Islands": "Virgin Islands",
};

export const STATE_DATA: StateRecord[] = [
  { name: "Alabama",              abbr: "AL", fips: "01", timezone: "America/Chicago",      type: "state"    },
  { name: "Alaska",               abbr: "AK", fips: "02", timezone: "America/Anchorage",    type: "state"    },
  { name: "Arizona",              abbr: "AZ", fips: "04", timezone: "America/Phoenix",       type: "state"    },
  { name: "Arkansas",             abbr: "AR", fips: "05", timezone: "America/Chicago",       type: "state"    },
  { name: "California",           abbr: "CA", fips: "06", timezone: "America/Los_Angeles",   type: "state"    },
  { name: "Colorado",             abbr: "CO", fips: "08", timezone: "America/Denver",        type: "state"    },
  { name: "Connecticut",          abbr: "CT", fips: "09", timezone: "America/New_York",      type: "state"    },
  { name: "Delaware",             abbr: "DE", fips: "10", timezone: "America/New_York",      type: "state"    },
  { name: "District of Columbia", abbr: "DC", fips: "11", timezone: "America/New_York",      type: "district" },
  { name: "Florida",              abbr: "FL", fips: "12", timezone: "America/New_York",      type: "state"    },
  { name: "Georgia",              abbr: "GA", fips: "13", timezone: "America/New_York",      type: "state"    },
  { name: "Hawaii",               abbr: "HI", fips: "15", timezone: "Pacific/Honolulu",      type: "state"    },
  { name: "Idaho",                abbr: "ID", fips: "16", timezone: "America/Boise",         type: "state"    },
  { name: "Illinois",             abbr: "IL", fips: "17", timezone: "America/Chicago",       type: "state"    },
  { name: "Indiana",              abbr: "IN", fips: "18", timezone: "America/Indiana/Indianapolis", type: "state" },
  { name: "Iowa",                 abbr: "IA", fips: "19", timezone: "America/Chicago",       type: "state"    },
  { name: "Kansas",               abbr: "KS", fips: "20", timezone: "America/Chicago",       type: "state"    },
  { name: "Kentucky",             abbr: "KY", fips: "21", timezone: "America/New_York",      type: "state"    },
  { name: "Louisiana",            abbr: "LA", fips: "22", timezone: "America/Chicago",       type: "state"    },
  { name: "Maine",                abbr: "ME", fips: "23", timezone: "America/New_York",      type: "state"    },
  { name: "Maryland",             abbr: "MD", fips: "24", timezone: "America/New_York",      type: "state"    },
  { name: "Massachusetts",        abbr: "MA", fips: "25", timezone: "America/New_York",      type: "state"    },
  { name: "Michigan",             abbr: "MI", fips: "26", timezone: "America/Detroit",       type: "state"    },
  { name: "Minnesota",            abbr: "MN", fips: "27", timezone: "America/Chicago",       type: "state"    },
  { name: "Mississippi",          abbr: "MS", fips: "28", timezone: "America/Chicago",       type: "state"    },
  { name: "Missouri",             abbr: "MO", fips: "29", timezone: "America/Chicago",       type: "state"    },
  { name: "Montana",              abbr: "MT", fips: "30", timezone: "America/Denver",        type: "state"    },
  { name: "Nebraska",             abbr: "NE", fips: "31", timezone: "America/Chicago",       type: "state"    },
  { name: "Nevada",               abbr: "NV", fips: "32", timezone: "America/Los_Angeles",   type: "state"    },
  { name: "New Hampshire",        abbr: "NH", fips: "33", timezone: "America/New_York",      type: "state"    },
  { name: "New Jersey",           abbr: "NJ", fips: "34", timezone: "America/New_York",      type: "state"    },
  { name: "New Mexico",           abbr: "NM", fips: "35", timezone: "America/Denver",        type: "state"    },
  { name: "New York",             abbr: "NY", fips: "36", timezone: "America/New_York",      type: "state"    },
  { name: "North Carolina",       abbr: "NC", fips: "37", timezone: "America/New_York",      type: "state"    },
  { name: "North Dakota",         abbr: "ND", fips: "38", timezone: "America/Chicago",       type: "state"    },
  { name: "Ohio",                 abbr: "OH", fips: "39", timezone: "America/New_York",      type: "state"    },
  { name: "Oklahoma",             abbr: "OK", fips: "40", timezone: "America/Chicago",       type: "state"    },
  { name: "Oregon",               abbr: "OR", fips: "41", timezone: "America/Los_Angeles",   type: "state"    },
  { name: "Pennsylvania",         abbr: "PA", fips: "42", timezone: "America/New_York",      type: "state"    },
  { name: "Rhode Island",         abbr: "RI", fips: "44", timezone: "America/New_York",      type: "state"    },
  { name: "South Carolina",       abbr: "SC", fips: "45", timezone: "America/New_York",      type: "state"    },
  { name: "South Dakota",         abbr: "SD", fips: "46", timezone: "America/Chicago",       type: "state"    },
  { name: "Tennessee",            abbr: "TN", fips: "47", timezone: "America/Chicago",       type: "state"    },
  { name: "Texas",                abbr: "TX", fips: "48", timezone: "America/Chicago",       type: "state"    },
  { name: "Utah",                 abbr: "UT", fips: "49", timezone: "America/Denver",        type: "state"    },
  { name: "Vermont",              abbr: "VT", fips: "50", timezone: "America/New_York",      type: "state"    },
  { name: "Virginia",             abbr: "VA", fips: "51", timezone: "America/New_York",      type: "state"    },
  { name: "Washington",           abbr: "WA", fips: "53", timezone: "America/Los_Angeles",   type: "state"    },
  { name: "West Virginia",        abbr: "WV", fips: "54", timezone: "America/New_York",      type: "state"    },
  { name: "Wisconsin",            abbr: "WI", fips: "55", timezone: "America/Chicago",       type: "state"    },
  { name: "Wyoming",              abbr: "WY", fips: "56", timezone: "America/Denver",        type: "state"    },
  // FIX-321 / FIX-B (2026-05-24): five U.S. territories with non-voting House
  // delegates. Modeled as type='district' to mirror the existing DC convention
  // (no 'territory' value in the jurisdiction_type enum). Without these,
  // congress/officials.ts at stateIds.get(member.state) falls through to the
  // 'United States' umbrella for AS/GU/MP/PR/VI delegates, leaving
  // officials.rep_count at 437 instead of 441.
  { name: "American Samoa",            abbr: "AS", fips: "60", timezone: "Pacific/Pago_Pago", type: "district" },
  { name: "Guam",                      abbr: "GU", fips: "66", timezone: "Pacific/Guam",      type: "district" },
  { name: "Northern Mariana Islands",  abbr: "MP", fips: "69", timezone: "Pacific/Saipan",    type: "district" },
  { name: "Puerto Rico",               abbr: "PR", fips: "72", timezone: "America/Puerto_Rico", type: "district" },
  { name: "U.S. Virgin Islands",       abbr: "VI", fips: "78", timezone: "America/St_Thomas", type: "district" },
];

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

/**
 * Upsert the federal US jurisdiction and all 50 states + DC.
 *
 * Uses a select-then-insert pattern to avoid relying on a specific unique
 * constraint name — we check by fips_code + type, and only insert if missing.
 *
 * Returns a map of state abbreviation → UUID, plus the federal jurisdiction ID.
 */
export async function seedJurisdictions(
  db: ReturnType<typeof createAdminClient>
): Promise<{ federalId: string; stateIds: Map<string, string> }> {
  console.log("  Seeding jurisdictions...");

  // --- Federal (US country node) ---
  let federalId: string;

  try {
    const { data: existing, error: selectErr } = await db
      .from("jurisdictions")
      .select("id")
      .eq("fips_code", "00")
      .eq("type", "country")
      .maybeSingle();

    if (selectErr) throw selectErr;

    if (existing) {
      federalId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("jurisdictions")
        .insert({
          name: "United States",
          short_name: "US",
          type: "country",
          country_code: "US",
          fips_code: "00",
          is_active: true,
        })
        .select("id")
        .single();

      if (insertErr) throw insertErr;
      federalId = inserted.id;
    }
  } catch (err) {
    console.error("  Error upserting federal jurisdiction:", err);
    throw err;
  }

  // --- States + DC ---
  const stateIds = new Map<string, string>();
  let seededCount = 1; // counting federal

  for (const state of STATE_DATA) {
    try {
      // FIX-383: narrow to direct children of the federal jurisdiction. Without
      // parent_id, TIGER sub-districts that inherit a state-equivalent's
      // fips_code collide with (fips_code, type) for entries with
      // type='district' (DC + the 5 FIX-376 territories) — e.g. the DC-98
      // delegate-district row at fips='11', type='district' makes .maybeSingle()
      // throw PGRST116 against the canonical DC row.
      const { data: existing, error: selectErr } = await db
        .from("jurisdictions")
        .select("id")
        .eq("fips_code", state.fips)
        .eq("type", state.type)
        .eq("parent_id", federalId)
        .maybeSingle();

      if (selectErr) throw selectErr;

      if (existing) {
        stateIds.set(state.abbr, existing.id);   // "IN" → id
        stateIds.set(state.name, existing.id);   // "Indiana" → id (Congress.gov returns full names)
      } else {
        const { data: inserted, error: insertErr } = await db
          .from("jurisdictions")
          .insert({
            name: state.name,
            short_name: state.abbr,
            type: state.type,
            country_code: "US",
            fips_code: state.fips,
            timezone: state.timezone,
            parent_id: federalId,
            is_active: true,
          })
          .select("id")
          .single();

        if (insertErr) throw insertErr;
        stateIds.set(state.abbr, inserted.id);   // "IN" → id
        stateIds.set(state.name, inserted.id);   // "Indiana" → id
        seededCount++;
      }
      // FIX-385: alias Congress.gov's variant for any state whose canonical
      // name differs from the API's `member.state` string (currently only VI).
      const congressAlias = CONGRESS_STATE_ALIASES[state.name];
      const aliasTargetId = stateIds.get(state.abbr);
      if (congressAlias && aliasTargetId) {
        stateIds.set(congressAlias, aliasTargetId);
      }
    } catch (err) {
      console.error(`  Error upserting jurisdiction for ${state.name}:`, err);
      // Continue with remaining states
    }
  }

  console.log(`  Seeded ${seededCount} jurisdictions`);
  return { federalId, stateIds };
}

/**
 * Upsert the US Senate and House of Representatives governing bodies.
 *
 * Checks for existence by name + type to avoid duplicates.
 */
export async function seedGoverningBodies(
  db: ReturnType<typeof createAdminClient>,
  federalId: string
): Promise<{ senateId: string; houseId: string; presidencyId: string }> {
  console.log("  Seeding governing bodies...");

  let senateId: string;
  let houseId: string;
  let presidencyId: string;

  // --- US Senate ---
  try {
    const { data: existing, error: selectErr } = await db
      .from("governing_bodies")
      .select("id")
      .eq("name", "United States Senate")
      .eq("type", "legislature_upper")
      .maybeSingle();

    if (selectErr) throw selectErr;

    if (existing) {
      senateId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("governing_bodies")
        .insert({
          name: "United States Senate",
          short_name: "Senate",
          type: "legislature_upper",
          jurisdiction_id: federalId,
          seat_count: 100,
          term_length_years: 6,
          website_url: "https://www.senate.gov",
          is_active: true,
        })
        .select("id")
        .single();

      if (insertErr) throw insertErr;
      senateId = inserted.id;
    }
  } catch (err) {
    console.error("  Error upserting US Senate:", err);
    throw err;
  }

  // --- US House of Representatives ---
  try {
    const { data: existing, error: selectErr } = await db
      .from("governing_bodies")
      .select("id")
      .eq("name", "United States House of Representatives")
      .eq("type", "legislature_lower")
      .maybeSingle();

    if (selectErr) throw selectErr;

    if (existing) {
      houseId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("governing_bodies")
        .insert({
          name: "United States House of Representatives",
          short_name: "House",
          type: "legislature_lower",
          jurisdiction_id: federalId,
          seat_count: 435,
          term_length_years: 2,
          website_url: "https://www.house.gov",
          is_active: true,
        })
        .select("id")
        .single();

      if (insertErr) throw insertErr;
      houseId = inserted.id;
    }
  } catch (err) {
    console.error("  Error upserting US House:", err);
    throw err;
  }

  // --- Office of the President (executive — for presidential candidates, FIX-246) ---
  try {
    const { data: existing, error: selectErr } = await db
      .from("governing_bodies")
      .select("id")
      .eq("name", "Office of the President of the United States")
      .eq("type", "executive")
      .maybeSingle();

    if (selectErr) throw selectErr;

    if (existing) {
      presidencyId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("governing_bodies")
        .insert({
          name: "Office of the President of the United States",
          short_name: "Presidency",
          type: "executive",
          jurisdiction_id: federalId,
          seat_count: 1,
          term_length_years: 4,
          website_url: "https://www.whitehouse.gov",
          is_active: true,
        })
        .select("id")
        .single();

      if (insertErr) throw insertErr;
      presidencyId = inserted.id;
    }
  } catch (err) {
    console.error("  Error upserting US Presidency:", err);
    throw err;
  }

  return { senateId, houseId, presidencyId };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const db = createAdminClient();

  seedJurisdictions(db)
    .then(({ federalId, stateIds }) => {
      console.log("Federal jurisdiction ID:", federalId);
      console.log("State IDs seeded:", stateIds.size);
      return seedGoverningBodies(db, federalId);
    })
    .then(({ senateId, houseId, presidencyId }) => {
      console.log("US Senate ID:", senateId);
      console.log("US House ID:", houseId);
      console.log("US Presidency ID:", presidencyId);
      console.log("Done.");
    })
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
