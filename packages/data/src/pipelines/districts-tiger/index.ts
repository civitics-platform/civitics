/**
 * Census TIGER state-legislative-district pipeline.
 *
 * Downloads SLD-U + SLD-L shapefile zips from www2.census.gov, parses each
 * with the `shapefile` package, and seeds public.jurisdictions rows with
 * boundary_geometry populated. The geometry assignment goes through the
 * upsert_district_jurisdiction(...) RPC defined in
 * supabase/migrations/20260428061525_district_boundaries.sql — PostgREST
 * can't speak PostGIS literals directly, so the RPC accepts the GeoJSON
 * string and casts via ST_GeomFromGeoJSON inside the DB.
 *
 * Run cadence: annual (TIGER refresh). Not in the nightly orchestrator.
 *
 * Run standalone:  pnpm --filter @civitics/data data:districts
 *
 * Source URL pattern:
 *   https://www2.census.gov/geo/tiger/TIGER2024/SLDU/tl_2024_{ss}_sldu.zip
 *   https://www2.census.gov/geo/tiger/TIGER2024/SLDL/tl_2024_{ss}_sldl.zip
 *
 * Notes:
 *   - Nebraska (NE) is unicameral — no SLDL file is published. Skipped.
 *   - DC has no state legislative districts — skipped.
 *   - "ZZZ" / "ZZZZZ" district numbers are TIGER placeholders for areas
 *     not assigned to any district. Skipped.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import * as unzipper from "unzipper";
import { open as openShapefile } from "shapefile";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { STATE_DATA, seedJurisdictions } from "../../jurisdictions/us-states";

const TIGER_YEAR = "2024";
const TIGER_BASE = `https://www2.census.gov/geo/tiger/TIGER${TIGER_YEAR}`;
const TMP_DIR = path.join(os.tmpdir(), "tiger-sld");

// States with no SLDL (unicameral) or no SLD at all (DC)
const NO_SLDL = new Set(["NE"]);
const NO_SLD = new Set(["DC"]);

type Chamber = "upper" | "lower";

interface SldFeatureProps {
  STATEFP?:   string;
  SLDUST?:    string;
  SLDLST?:    string;
  GEOID?:     string;
  GEOID20?:   string;
  NAMELSAD?:  string;
  NAMELSAD20?: string;
  LSY?:       string;
  // Congressional shapefile fields
  CD119FP?:   string;       // 119th Congress district number
  CDSESSN?:   string;       // session number
}

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function rmDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) safeUnlink(path.join(dir, f));
      fs.rmdirSync(dir);
    }
  } catch { /* ignore */ }
}

function downloadFile(url: string, destPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const follow = (target: string): void => {
      const file = fs.createWriteStream(destPath);
      https.get(target, (res) => {
        const { statusCode, headers } = res;
        if (statusCode === 301 || statusCode === 302) {
          res.resume();
          file.destroy();
          follow(headers.location ?? target);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          file.destroy();
          safeUnlink(destPath);
          reject(new Error(`HTTP ${statusCode} — ${target}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(file.bytesWritten)));
        file.on("error", (err) => { safeUnlink(destPath); reject(err); });
      }).on("error", (err) => { file.destroy(); reject(err); });
    };
    follow(url);
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<{ shp: string; dbf: string } | null> {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  let shp = "", dbf = "";
  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    const base = path.basename(entry.path);
    const out = path.join(destDir, base);
    fs.writeFileSync(out, await entry.buffer());
    const lower = base.toLowerCase();
    if (lower.endsWith(".shp")) shp = out;
    else if (lower.endsWith(".dbf")) dbf = out;
  }
  return shp && dbf ? { shp, dbf } : null;
}

function buildDistrictName(stateName: string, chamber: Chamber, namelsad: string): string {
  // NAMELSAD is e.g. "State Senate District 10" or "State House District 25"
  // Already human-readable; just prefix with state for global uniqueness.
  return `${stateName} ${namelsad}`;
}

function buildShortName(chamber: Chamber, districtNum: string): string {
  return chamber === "upper" ? `SD ${districtNum}` : `HD ${districtNum}`;
}

async function processShapefile(
  shpPath: string,
  dbfPath: string,
  chamber: Chamber,
  state: { abbr: string; name: string; fips: string },
  parentJurisdictionId: string,
  db: ReturnType<typeof createAdminClient>,
): Promise<{ inserted: number; failed: number; skipped: number }> {
  const out = { inserted: 0, failed: 0, skipped: 0 };
  const source = await openShapefile(shpPath, dbfPath);
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    const feature = value as Feature<Polygon | MultiPolygon, SldFeatureProps>;
    if (!feature.geometry) { out.skipped++; continue; }

    const props = feature.properties ?? {};
    const geoid = props.GEOID20 ?? props.GEOID ?? null;
    const districtNum = chamber === "upper" ? (props.SLDUST ?? "") : (props.SLDLST ?? "");
    const namelsad = props.NAMELSAD20 ?? props.NAMELSAD ?? `District ${districtNum}`;

    if (!geoid || !districtNum || districtNum.toUpperCase().startsWith("ZZ")) {
      out.skipped++;
      continue;
    }

    const name = buildDistrictName(state.name, chamber, namelsad);
    const shortName = buildShortName(chamber, districtNum);

    const metadata = {
      source:        "tiger",
      tiger_year:    TIGER_YEAR,
      state_fips:    state.fips,
      state_abbr:    state.abbr,
      chamber,
      district_id:   districtNum,
      legislative_session_year: props.LSY ?? null,
    };

    const { error } = await db.rpc("upsert_district_jurisdiction" as never, {
      p_parent_id:    parentJurisdictionId,
      p_name:         name,
      p_short_name:   shortName,
      p_fips_code:    state.fips,
      p_census_geoid: geoid,
      p_chamber:      chamber,
      p_metadata:     metadata,
      p_geojson:      JSON.stringify(feature.geometry),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (error) {
      console.warn(`    ${state.abbr} ${chamber} ${districtNum}: rpc error — ${error.message}`);
      out.failed++;
    } else {
      out.inserted++;
    }
  }
  return out;
}

// FIX-217: Congressional shapefiles are per-state, like SLDU/SLDL —
// www2.census.gov/geo/tiger/TIGER2024/CD/tl_2024_{state_fips}_cd119.zip.
// CD119FP is the district number ("00" for at-large, "01"–"53" for
// districted). The 119th Congress runs 2025-01-03 → 2027-01-03.
const CD_BASE = `${TIGER_BASE}/CD`;
const CD_SESSION = "119";

const FIPS_TO_STATE = new Map(
  STATE_DATA.map(s => [s.fips, s] as const),
);

async function processCongressionalShapefile(
  shpPath: string,
  dbfPath: string,
  stateIds: Map<string, string>,
  db: ReturnType<typeof createAdminClient>,
): Promise<{ inserted: number; failed: number; skipped: number }> {
  const out = { inserted: 0, failed: 0, skipped: 0 };
  const source = await openShapefile(shpPath, dbfPath);
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    const feature = value as Feature<Polygon | MultiPolygon, SldFeatureProps>;
    if (!feature.geometry) { out.skipped++; continue; }

    const props = feature.properties ?? {};
    const statefp = props.STATEFP;
    if (!statefp) { out.skipped++; continue; }
    const state = FIPS_TO_STATE.get(statefp);
    if (!state) { out.skipped++; continue; }  // territory not in our list

    const districtNum = props.CD119FP ?? "";
    if (!districtNum || districtNum.toUpperCase() === "ZZ") {
      out.skipped++;
      continue;
    }

    const geoid = props.GEOID20 ?? props.GEOID ?? `${statefp}${districtNum}`;
    const namelsad = props.NAMELSAD20 ?? props.NAMELSAD ?? `Congressional District ${districtNum}`;

    // At-large districts are CD119FP="00". Render the name as "At-Large"
    // for one-rep states (AK, DE, MT, ND, SD, VT, WY).
    const isAtLarge = districtNum === "00";
    const name = isAtLarge
      ? `${state.name} At-Large Congressional District`
      : `${state.name} ${namelsad}`;
    const shortName = isAtLarge
      ? `${state.abbr}-AL`
      : `${state.abbr}-${districtNum.replace(/^0+/, "") || districtNum}`;

    const parentId = stateIds.get(state.name);
    if (!parentId) { out.skipped++; continue; }

    const metadata = {
      source:        "tiger",
      tiger_year:    TIGER_YEAR,
      state_fips:    state.fips,
      state_abbr:    state.abbr,
      chamber:       "congressional",
      district_id:   districtNum,
      cd_session:    props.CDSESSN ?? "119",
    };

    const { error } = await db.rpc("upsert_district_jurisdiction" as never, {
      p_parent_id:    parentId,
      p_name:         name,
      p_short_name:   shortName,
      p_fips_code:    state.fips,
      p_census_geoid: geoid,
      p_chamber:      "congressional",
      p_metadata:     metadata,
      p_geojson:      JSON.stringify(feature.geometry),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (error) {
      console.warn(`    ${state.abbr} CD-${districtNum}: rpc error — ${error.message}`);
      out.failed++;
    } else {
      out.inserted++;
    }
  }
  return out;
}

export async function runTigerDistrictsPipeline(
  stateIds: Map<string, string>,
): Promise<PipelineResult> {
  console.log(`\n=== Census TIGER ${TIGER_YEAR} district boundaries pipeline ===`);
  const logId = await startSync("tiger_districts");
  const db = createAdminClient();

  let totalInserted = 0, totalFailed = 0, totalSkipped = 0, bytesDownloaded = 0;
  const results: Array<{ state: string; chamber: Chamber; n: number; failed: number }> = [];

  try {
    ensureTmpDir();

    for (const state of STATE_DATA) {
      if (NO_SLD.has(state.abbr)) {
        console.log(`  ${state.abbr}: no state legislative districts (skipped)`);
        continue;
      }
      const parentId = stateIds.get(state.name);
      if (!parentId) {
        console.warn(`  ${state.abbr}: no jurisdiction id, skipping`);
        continue;
      }

      const chambers: Chamber[] = NO_SLDL.has(state.abbr) ? ["upper"] : ["upper", "lower"];

      for (const chamber of chambers) {
        const suffix = chamber === "upper" ? "sldu" : "sldl";
        const url = `${TIGER_BASE}/${suffix.toUpperCase()}/tl_${TIGER_YEAR}_${state.fips}_${suffix}.zip`;
        const zipPath = path.join(TMP_DIR, `${state.abbr}_${suffix}.zip`);
        const extractDir = path.join(TMP_DIR, `${state.abbr}_${suffix}`);

        let bytes = 0;
        try {
          bytes = await downloadFile(url, zipPath);
        } catch (err) {
          console.warn(`  ${state.abbr} ${chamber}: download failed — ${err instanceof Error ? err.message : err}`);
          totalFailed++;
          continue;
        }
        bytesDownloaded += bytes;

        const paths = await extractZip(zipPath, extractDir).catch((err) => {
          console.warn(`  ${state.abbr} ${chamber}: unzip failed — ${err instanceof Error ? err.message : err}`);
          return null;
        });
        safeUnlink(zipPath);
        if (!paths) {
          rmDir(extractDir);
          totalFailed++;
          continue;
        }

        const { inserted, failed, skipped } = await processShapefile(
          paths.shp, paths.dbf, chamber, state, parentId, db,
        );
        totalInserted += inserted;
        totalFailed += failed;
        totalSkipped += skipped;
        results.push({ state: state.abbr, chamber, n: inserted, failed });
        console.log(`  ${state.abbr} ${chamber}: ${inserted} districts upserted${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""} · ${(bytes / 1024).toFixed(0)}KB`);

        rmDir(extractDir);
      }
    }

    // FIX-217: Pass 2 — Congressional districts (per-state, 119th Congress).
    // TIGER ships these as one shapefile per state at
    // tl_{year}_{state_fips}_cd119.zip — same shape as SLD files. DC, PR,
    // and territories aren't included; STATE_DATA lists US states only.
    console.log(`\n  --- Congressional districts (119th Congress) ---`);
    for (const state of STATE_DATA) {
      const fileName = `tl_${TIGER_YEAR}_${state.fips}_cd${CD_SESSION}.zip`;
      const url = `${CD_BASE}/${fileName}`;
      const zipPath = path.join(TMP_DIR, fileName);
      const extractDir = path.join(TMP_DIR, `${state.abbr}_cd${CD_SESSION}`);

      let bytes = 0;
      try {
        bytes = await downloadFile(url, zipPath);
      } catch (err) {
        // Some territories don't have a CD file — skip silently rather
        // than spam the log. State_data shouldn't include those, but
        // be defensive.
        console.warn(`  ${state.abbr} cd: download failed — ${err instanceof Error ? err.message : err}`);
        totalFailed++;
        continue;
      }
      bytesDownloaded += bytes;

      const paths = await extractZip(zipPath, extractDir).catch((err) => {
        console.warn(`  ${state.abbr} cd: unzip failed — ${err instanceof Error ? err.message : err}`);
        return null;
      });
      safeUnlink(zipPath);
      if (!paths) {
        rmDir(extractDir);
        totalFailed++;
        continue;
      }

      const { inserted, failed, skipped } = await processCongressionalShapefile(
        paths.shp, paths.dbf, stateIds, db,
      );
      totalInserted += inserted;
      totalFailed += failed;
      totalSkipped += skipped;
      console.log(`  ${state.abbr} cd: ${inserted} districts upserted${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""} · ${(bytes / 1024).toFixed(0)}KB`);

      rmDir(extractDir);
    }

    rmDir(TMP_DIR);

    // Cross-link officials to their district jurisdictions. Match on
    // state_abbr + chamber + district_id, normalising leading zeros (TIGER
    // pads "002", OpenStates says "2"). Done as a single SQL UPDATE via the
    // RPC link_officials_to_districts() defined in the same migration.
    const linkRes = await db.rpc("link_officials_to_districts" as never).single();
    const linked = (linkRes.data as unknown as number | null) ?? 0;
    if (linkRes.error) {
      console.warn(`  link_officials_to_districts error: ${linkRes.error.message}`);
    } else {
      console.log(`  Linked ${linked} officials to district jurisdictions (state legs)`);
    }

    // FIX-217: Federal House Reps don't have org_classification='lower'
    // (that's an OpenStates state-leg convention). Link them via a separate
    // RPC that matches role_title='Representative' to chamber='congressional'.
    const fedLinkRes = await db.rpc("link_federal_reps_to_districts" as never).single();
    const fedLinked = (fedLinkRes.data as unknown as number | null) ?? 0;
    if (fedLinkRes.error) {
      console.warn(`  link_federal_reps_to_districts error: ${fedLinkRes.error.message}`);
    } else {
      console.log(`  Linked ${fedLinked} House Reps to congressional districts`);
    }

    const estimatedMb = +(bytesDownloaded / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted: totalInserted, updated: linked, failed: totalFailed, estimatedMb };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log(`  TIGER ${TIGER_YEAR} districts report`);
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  Districts upserted:   ${totalInserted}`);
    console.log(`  Officials linked:     ${linked}`);
    console.log(`  Failed:               ${totalFailed}`);
    console.log(`  Skipped (ZZ/null):    ${totalSkipped}`);
    console.log(`  Downloaded:           ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`);

    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  TIGER districts pipeline fatal error:", msg);
    await failSync(logId, msg);
    rmDir(TMP_DIR);
    return { inserted: totalInserted, updated: 0, failed: totalFailed + 1, estimatedMb: +(bytesDownloaded / 1024 / 1024).toFixed(2) };
  }
}

if (require.main === module) {
  const db = createAdminClient();
  (async () => {
    const { stateIds } = await seedJurisdictions(db);
    await runTigerDistrictsPipeline(stateIds);
  })()
    .then(() => setTimeout(() => process.exit(0), 500))
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
