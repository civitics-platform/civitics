/**
 * OpenStates bulk people pipeline (FIX-160).
 *
 * Replaces the per-state /people API loop in ../openstates with a single bulk
 * CSV download per state from data.openstates.org/people/current/{abbr}.csv.
 * No API key, no rate limit, no daily quota. Each CSV is ~50–500 KB; total
 * download for all 50 states + DC is well under 20 MB.
 *
 * The CSV does NOT include term_start / term_end. Those are still pulled by
 * the legacy API pipeline (run weekly) which is now wired to data:states-api.
 * The writer's buildOfficialInsert was updated to omit term fields when
 * undefined, so this pipeline never clobbers existing dates with null.
 *
 * Run standalone:  pnpm --filter @civitics/data data:states
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import { parse } from "csv-parse/sync";
import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { slugifyGoverningBodies } from "../../lib/slugify-governing-bodies";
import { STATE_DATA, seedJurisdictions } from "../../jurisdictions/us-states";
import {
  resolveGoverningBodies,
  upsertLegislatorsBatch,
  type GovBodyKey,
  type LegislatorInput,
} from "../openstates/writer";

type PartyValue = Database["public"]["Tables"]["officials"]["Row"]["party"];
type GovBodyType = Database["public"]["Enums"]["governing_body_type"];

const TMP_DIR = path.join(os.tmpdir(), "openstates-bulk");
const CSV_BASE = "https://data.openstates.org/people/current";

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function deleteTmpDir(): void {
  try {
    if (fs.existsSync(TMP_DIR)) {
      for (const f of fs.readdirSync(TMP_DIR)) safeUnlink(path.join(TMP_DIR, f));
    }
  } catch { /* ignore */ }
}

class NotFoundError extends Error {
  constructor() { super("404"); }
}

function downloadFile(url: string, destPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl: string): void => {
      const file = fs.createWriteStream(destPath);
      https.get(targetUrl, (res) => {
        const { statusCode, headers } = res;
        if (statusCode === 301 || statusCode === 302) {
          res.resume();
          file.destroy();
          follow(headers.location ?? targetUrl);
          return;
        }
        if (statusCode === 404) {
          res.resume();
          file.destroy();
          safeUnlink(destPath);
          reject(new NotFoundError());
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          file.destroy();
          safeUnlink(destPath);
          reject(new Error(`HTTP ${statusCode} — ${targetUrl}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(file.bytesWritten)));
        file.on("error", (err) => {
          safeUnlink(destPath);
          reject(err);
        });
      }).on("error", (err) => {
        file.destroy();
        reject(err);
      });
    };
    follow(url);
  });
}

interface PersonRow {
  id: string;
  name: string;
  current_party: string;
  current_district: string;
  current_chamber: string;
  links?: string;
  // remaining columns (given_name, family_name, gender, email, biography,
  // birth_date, death_date, image, sources, capitol_*, district_*, twitter,
  // youtube, instagram, facebook, wikidata) parsed but unused for now
}

function mapParty(party: string): PartyValue {
  const p = (party || "").toLowerCase();
  if (p.includes("democrat"))    return "democrat";
  if (p.includes("republican"))  return "republican";
  if (p.includes("independent")) return "independent";
  if (p.includes("libertarian")) return "libertarian";
  if (p.includes("green"))       return "green";
  return "other";
}

function chamberKey(chamber: string): "upper" | "lower" {
  const c = (chamber || "").toLowerCase();
  if (c === "lower") return "lower";
  // "upper" or "legislature" (Nebraska unicameral) → bucket as upper. NE's
  // unicameral seats are senators ("Senator John Smith"), and Census TIGER
  // only publishes SLDU (not SLDL) for NE — so the upper bucket matches both
  // the role title and the district boundary set.
  return "upper";
}

function chamberType(chamber: string): GovBodyType {
  return chamberKey(chamber) === "upper" ? "legislature_upper" : "legislature_lower";
}

function pickWebsiteUrl(links: string | undefined, openstatesId: string): string {
  if (links && links.trim()) {
    const first = links.split(";")[0]?.trim();
    if (first) return first;
  }
  return `https://openstates.org/person/${openstatesId.replace("ocd-person/", "")}/`;
}

export async function runBulkPeoplePipeline(
  stateIds: Map<string, string>,
): Promise<PipelineResult> {
  console.log("\n=== OpenStates bulk people pipeline ===");
  const logId = await startSync("openstates_bulk_people");
  const db = createAdminClient();

  let inserted = 0, updated = 0, failed = 0;
  let bytesDownloaded = 0;
  let statesProcessed = 0;
  let statesSkipped = 0;

  try {
    ensureTmpDir();

    // Pre-resolve governing_bodies for every (state × chamber)
    const govBodyKeys: GovBodyKey[] = [];
    for (const state of STATE_DATA) {
      const jurisdictionId = stateIds.get(state.name);
      if (!jurisdictionId) continue;
      for (const orgClass of ["upper", "lower"] as const) {
        govBodyKeys.push({
          jurisdictionId,
          stateAbbr: state.abbr,
          stateName: state.name,
          type: orgClass === "upper" ? "legislature_upper" : "legislature_lower",
        });
      }
    }
    const govBodyMap = await resolveGoverningBodies(db, govBodyKeys);
    console.log(`  Resolved ${govBodyMap.size} governing bodies`);

    for (const state of STATE_DATA) {
      const jurisdictionId = stateIds.get(state.name);
      if (!jurisdictionId) {
        console.warn(`  ${state.abbr}: no jurisdiction id, skipping`);
        statesSkipped++;
        continue;
      }

      const lower = state.abbr.toLowerCase();
      const url = `${CSV_BASE}/${lower}.csv`;
      const dest = path.join(TMP_DIR, `${lower}.csv`);

      let bytes: number;
      try {
        bytes = await downloadFile(url, dest);
      } catch (err) {
        if (err instanceof NotFoundError) {
          console.log(`  ${state.abbr}: no CSV available`);
        } else {
          console.warn(`  ${state.abbr}: download failed — ${err instanceof Error ? err.message : err}`);
          failed++;
        }
        statesSkipped++;
        continue;
      }
      bytesDownloaded += bytes;

      const csvText = fs.readFileSync(dest, "utf8");
      let records: PersonRow[];
      try {
        records = parse(csvText, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        }) as PersonRow[];
      } catch (err) {
        console.warn(`  ${state.abbr}: CSV parse failed — ${(err as Error).message}`);
        failed++;
        safeUnlink(dest);
        statesSkipped++;
        continue;
      }

      const inputs: LegislatorInput[] = [];
      let chamberMisses = 0;
      for (const r of records) {
        if (!r.id || !r.name) continue;
        const orgClass = chamberKey(r.current_chamber);
        const govBodyId = govBodyMap.get(`${jurisdictionId}|${chamberType(r.current_chamber)}`);
        if (!govBodyId) { chamberMisses++; continue; }

        inputs.push({
          openstatesId: r.id,
          fullName: r.name,
          roleTitle: orgClass === "upper" ? "State Senator" : "State Representative",
          governingBodyId: govBodyId,
          jurisdictionId,
          party: mapParty(r.current_party),
          districtName: r.current_district || null,
          // term dates intentionally omitted (preserve API-set values)
          websiteUrl: pickWebsiteUrl(r.links, r.id),
          metadata: { org_classification: orgClass, state: state.abbr },
        });
      }

      if (inputs.length > 0) {
        const res = await upsertLegislatorsBatch(db, inputs);
        inserted += res.inserted;
        updated += res.updated;
        failed += res.failed;
      }

      const summary = `${records.length} rows · +${inputs.length} valid${chamberMisses ? ` · ${chamberMisses} chamber-miss` : ""}`;
      console.log(`  ${state.abbr}: ${summary}`);
      statesProcessed++;
      safeUnlink(dest);
    }

    deleteTmpDir();

    // Refresh district cross-links. The writer overwrites metadata wholesale
    // each upsert, so any prior `district_jurisdiction_id` would be lost.
    // The linker RPC (added in 20260428061525) re-derives the link from
    // (state, chamber, district_name) → (state_abbr, chamber, district_id).
    // Cheap (single SQL UPDATE) and idempotent. No-op if the TIGER districts
    // pipeline hasn't been run yet — the JOIN simply matches nothing.
    let linked = 0;
    try {
      const linkRes = await db.rpc("link_officials_to_districts" as never).single();
      if (linkRes.error) {
        console.warn(`  link_officials_to_districts: ${linkRes.error.message}`);
      } else {
        linked = (linkRes.data as unknown as number | null) ?? 0;
      }
    } catch (err) {
      console.warn(`  link_officials_to_districts threw: ${err instanceof Error ? err.message : err}`);
    }

    const estimatedMb = +(bytesDownloaded / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  OpenStates bulk people report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  States processed: ${statesProcessed} · skipped: ${statesSkipped}`);
    console.log(`  Inserted:         ${inserted}`);
    console.log(`  Updated:          ${updated}`);
    console.log(`  Failed:           ${failed}`);
    console.log(`  District-linked:  ${linked}`);
    console.log(`  Downloaded:       ${(bytesDownloaded / 1024 / 1024).toFixed(2)} MB`);

    // FIX-492 — slugify ingest invariant: state-chamber gbs resolved/inserted by
    // resolveGoverningBodies this run get their slug filled. Idempotent.
    await slugifyGoverningBodies(db);

    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Bulk people pipeline fatal error:", msg);
    await failSync(logId, msg);
    deleteTmpDir();
    return { inserted, updated, failed, estimatedMb: +(bytesDownloaded / 1024 / 1024).toFixed(2) };
  }
}

if (require.main === module) {
  const db = createAdminClient();
  (async () => {
    const { stateIds } = await seedJurisdictions(db);
    await runBulkPeoplePipeline(stateIds);
  })()
    .then(() => setTimeout(() => process.exit(0), 500))
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
