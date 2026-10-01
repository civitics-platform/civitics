/**
 * Pilot metro jurisdiction seeder.
 *
 * Inserts city-level jurisdiction rows for the 5 deep-pilot metros
 * (Seattle, SF, NYC, DC, Austin) and sets coverage_status='claimed' on each.
 *
 * DC is special: the district-level entry (fips='11', type='district') already
 * exists from the state seeder and doubles as the city level.
 *
 * Returns a map of legistarClient → jurisdictionId for use by the Legistar
 * pipeline. DC uses key 'dc_lims' (its own adapter, not Legistar).
 *
 * Safe to re-run: all upserts are idempotent.
 *
 * Run:
 *   pnpm --filter @civitics/data data:pilot-metros
 */

import { createAdminClient } from "@civitics/db";

// ---------------------------------------------------------------------------
// Metro config
// ---------------------------------------------------------------------------

const CITY_METROS = [
  { name: "Seattle",       shortName: "SEA", parentAbbr: "WA", fipsCode: "5363000", legistarClient: "seattle"      },
  { name: "San Francisco", shortName: "SF",  parentAbbr: "CA", fipsCode: "0667000", legistarClient: "sfgov"        },
  { name: "New York City", shortName: "NYC", parentAbbr: "NY", fipsCode: "3651000", legistarClient: "newyork"      },
  { name: "Austin",        shortName: "AUS", parentAbbr: "TX", fipsCode: "4805000", legistarClient: "austintexas"  },
] as const;

// ---------------------------------------------------------------------------
// Main seeder
// ---------------------------------------------------------------------------

export async function seedPilotMetros(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<Map<string, string>> {
  console.info("\n  Seeding pilot metro jurisdictions...");
  const result = new Map<string, string>(); // legistarClient → jurisdictionId
  const now = new Date().toISOString();

  // ── 1. City metros (Seattle, SF, NYC, Austin) ─────────────────────────────

  for (const metro of CITY_METROS) {
    // Resolve parent state ID by short_name
    const { data: parent, error: parentErr } = await db
      .from("jurisdictions")
      .select("id")
      .eq("short_name", metro.parentAbbr)
      .in("type", ["state", "district"])
      .maybeSingle();

    if (parentErr || !parent) {
      console.warn(`    ⚠  Could not find parent state for ${metro.name} (abbr=${metro.parentAbbr}) — run data:jurisdictions first`);
      continue;
    }

    // Check if city jurisdiction already exists
    const { data: existing } = await db
      .from("jurisdictions")
      .select("id, coverage_status")
      .eq("fips_code", metro.fipsCode)
      .eq("type", "city")
      .maybeSingle();

    if (existing) {
      // Update coverage_status if not already claimed
      if (existing.coverage_status === "none") {
        await db
          .from("jurisdictions")
          .update({ coverage_status: "claimed", coverage_started_at: now })
          .eq("id", existing.id);
        console.info(`    ✓  ${metro.name}: coverage_status → claimed (existing row)`);
      } else {
        console.info(`    –  ${metro.name}: already ${existing.coverage_status}`);
      }
      result.set(metro.legistarClient, existing.id);
    } else {
      // Insert new city jurisdiction
      const { data: inserted, error: insertErr } = await db
        .from("jurisdictions")
        .insert({
          parent_id:          parent.id,
          type:               "city",
          name:               metro.name,
          short_name:         metro.shortName,
          country_code:       "US",
          fips_code:          metro.fipsCode,
          coverage_status:    "claimed",
          coverage_started_at: now,
          is_active:          true,
        })
        .select("id")
        .single();

      if (insertErr || !inserted) {
        console.error(`    ✗  ${metro.name}: insert failed —`, insertErr?.message);
        continue;
      }
      console.info(`    ✓  ${metro.name}: inserted (id=${inserted.id})`);
      result.set(metro.legistarClient, inserted.id);
    }
  }

  // ── 2. DC — reuse existing district-level entry (fips='11') ──────────────

  const { data: dc, error: dcErr } = await db
    .from("jurisdictions")
    .select("id, coverage_status")
    .eq("fips_code", "11")
    .eq("type", "district")
    .maybeSingle();

  if (dcErr || !dc) {
    console.warn("    ⚠  DC district jurisdiction not found — run data:jurisdictions first");
  } else {
    if (dc.coverage_status === "none") {
      await db
        .from("jurisdictions")
        .update({ coverage_status: "claimed", coverage_started_at: now })
        .eq("id", dc.id);
      console.info(`    ✓  Washington DC: coverage_status → claimed`);
    } else {
      console.info(`    –  Washington DC: already ${dc.coverage_status}`);
    }
    result.set("dc_lims", dc.id);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.info(`\n  Pilot metro jurisdictions ready: ${result.size} / 5`);
  for (const [client, id] of result) {
    console.info(`    ${client.padEnd(16)} → ${id}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const db = createAdminClient();
  seedPilotMetros(db)
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pilot metro seed failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
