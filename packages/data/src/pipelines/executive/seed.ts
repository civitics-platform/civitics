/**
 * Executive-branch seed (FIX-321).
 *
 * Hardcodes the sitting U.S. President + Vice President as `officials` rows
 * with `tier='elected'` so the FIX-318 audit checks
 * (`officials.president_count`, `officials.vp_count`) flip from error → info.
 *
 * Wikidata/Federal Register integrations were considered and rejected — these
 * are two rows that change every 4-8 years and editing this file at
 * inauguration is cheaper than building (and operating) a generalized
 * executive-branch ingest.
 *
 * Idempotent on `source_ids->>'official_seed_id'`. Run nightly inside the
 * daily officials block of `runNightlySync`. Pre-fetch + INSERT-or-UPDATE
 * pattern mirrors `congress/officials.ts`.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:executive-seed
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";

type Db = ReturnType<typeof createAdminClient>;
type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"] & {
  tier?: string;
};

export interface ExecutiveSeedResult {
  inserted: number;
  updated: number;
  failed: number;
}

interface ExecRecord {
  seedId:    string;
  fullName:  string;
  firstName: string;
  lastName:  string;
  roleTitle: string;
  party:     "republican" | "democrat" | "independent";
  termStart: string;
  termEnd:   string;
  websiteUrl: string;
}

/**
 * Current sitting officeholders as of 2025-01-20 inauguration.
 * Update this list at each transition; no automated source.
 */
const CURRENT_EXECUTIVES: ExecRecord[] = [
  {
    seedId:     "potus_current",
    fullName:   "Donald J. Trump",
    firstName:  "Donald",
    lastName:   "Trump",
    roleTitle:  "President of the United States",
    party:      "republican",
    termStart:  "2025-01-20",
    termEnd:    "2029-01-20",
    websiteUrl: "https://www.whitehouse.gov/administration/donald-j-trump/",
  },
  {
    seedId:     "vpotus_current",
    fullName:   "J.D. Vance",
    firstName:  "J.D.",
    lastName:   "Vance",
    roleTitle:  "Vice President of the United States",
    party:      "republican",
    termStart:  "2025-01-20",
    termEnd:    "2029-01-20",
    websiteUrl: "https://www.whitehouse.gov/administration/jd-vance/",
  },
];

export async function runExecutiveSeed(opts: { db?: Db } = {}): Promise<ExecutiveSeedResult> {
  const db = opts.db ?? createAdminClient();
  const out: ExecutiveSeedResult = { inserted: 0, updated: 0, failed: 0 };

  // Federal jurisdiction (United States, fips_code=00)
  const { data: federal, error: jurErr } = await db
    .from("jurisdictions")
    .select("id")
    .eq("fips_code", "00")
    .eq("type", "country")
    .maybeSingle();
  if (jurErr || !federal) {
    throw new Error(`runExecutiveSeed: federal jurisdiction not found (${jurErr?.message ?? "no row"})`);
  }

  // Office of the President governing body (seeded by seedGoverningBodies)
  const { data: presidency, error: gbErr } = await db
    .from("governing_bodies")
    .select("id")
    .eq("name", "Office of the President of the United States")
    .eq("type", "executive")
    .maybeSingle();
  if (gbErr || !presidency) {
    throw new Error(`runExecutiveSeed: Office of the President governing body not found (${gbErr?.message ?? "no row"})`);
  }

  // Pre-fetch any existing rows keyed by official_seed_id
  const existingMap = new Map<string, string>();
  for (const exec of CURRENT_EXECUTIVES) {
    const { data: row, error } = await db
      .from("officials")
      .select("id")
      .filter("source_ids->>official_seed_id", "eq", exec.seedId)
      .maybeSingle();
    if (error) {
      console.warn(`  executive seed: lookup ${exec.seedId} failed: ${error.message}`);
      continue;
    }
    if (row) existingMap.set(exec.seedId, row.id as string);
  }

  for (const exec of CURRENT_EXECUTIVES) {
    const data: OfficialInsert = {
      full_name:         exec.fullName,
      first_name:        exec.firstName,
      last_name:         exec.lastName,
      role_title:        exec.roleTitle,
      governing_body_id: presidency.id as string,
      jurisdiction_id:   federal.id as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      party:             exec.party as any,
      term_start:        exec.termStart,
      term_end:          exec.termEnd,
      is_active:         true,
      is_verified:       true,
      website_url:       exec.websiteUrl,
      tier:              "elected",
      source_ids:        { official_seed_id: exec.seedId },
      metadata:          { source: "executive_seed" },
    };

    const existingId = existingMap.get(exec.seedId);
    if (existingId) {
      const { error } = await db.from("officials").update(data).eq("id", existingId);
      if (error) {
        console.error(`  executive seed: update ${exec.seedId} failed: ${error.message}`);
        out.failed++;
      } else {
        out.updated++;
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await db.from("officials").insert(data as any);
      if (error) {
        console.error(`  executive seed: insert ${exec.seedId} failed: ${error.message}`);
        out.failed++;
      } else {
        out.inserted++;
      }
    }
  }

  console.log(`  executive seed: inserted=${out.inserted} updated=${out.updated} failed=${out.failed}`);
  return out;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const db = createAdminClient();
  runExecutiveSeed({ db })
    .then((r) => {
      console.log("Executive seed complete:", r);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Fatal:", e);
      process.exit(1);
    });
}
