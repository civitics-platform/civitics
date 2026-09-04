/**
 * Census TIGER 2024 jurisdiction-boundary backfill (FIX-D).
 *
 * Populates public.jurisdictions.boundary_geometry (+ centroid) for state,
 * county, and city/place rows that currently have a NULL boundary. District
 * rows already carry boundaries from the districts-tiger pipeline (FIX-160 /
 * FIX-217); this fills the levels that block FIX-420 constituent verification
 * from granting at state / county / city.
 *
 * Pattern mirrors packages/data/src/pipelines/districts-tiger/index.ts:
 *   download zip from www2.census.gov → unzip → stream-parse with `shapefile`
 *   → per-feature match against existing jurisdictions → UPDATE via RPC.
 *
 * The write goes through backfill_jurisdiction_boundary(p_id, p_geojson)
 * (supabase/migrations/20260528170000_jurisdiction_boundary_backfill_rpc.sql) —
 * PostgREST can't set a GEOMETRY column from GeoJSON directly, and the
 * district RPC can't be reused (it's INSERT-or-update and hardcodes
 * type='district', which would create forbidden new rows).
 *
 * Idempotent: the RPC only ever writes a NULL boundary, never overwrites. The
 * pipeline also pre-checks the in-memory snapshot and skips the RPC entirely
 * for already-populated rows. Re-running is a no-op.
 *
 * State / place levels only ever backfill EXISTING rows; they never create
 * jurisdictions.
 *
 * COUNTY level is different (FIX-E): there are 0 county rows, so --levels county
 * both CREATES county rows and populates their boundary in one pass, via the
 * upsert_county_jurisdiction RPC (insert-or-update; never overwrites an existing
 * boundary). Parent state/state-equivalent is resolved by STATEFP. DC
 * (federal_district) and PR/VI/GU/AS/MP (unincorporated_territory) are valid
 * county parents — their county-equivalents (e.g. PR municipios) land too.
 * As of 2026-05-28 the table holds 50 states, 6 state-equivalents (DC +
 * 5 territories), and 4 pilot cities; a place run backfills the 4 pilot metros.
 *
 * CLI (run via the data:boundaries script so .env.local is loaded):
 *   pnpm --filter @civitics/data data:boundaries -- --levels state --dry-run
 *   pnpm --filter @civitics/data data:boundaries -- --levels state
 *   pnpm --filter @civitics/data data:boundaries -- --levels place --state-fips=53,06,36,48
 *   pnpm --filter @civitics/data data:boundaries -- --levels state,county,place
 *
 * Flags:
 *   --levels state,county,place   subset to process (default: all three)
 *   --state-fips 53,06,36         restrict county/place to these state FIPS
 *   --from-file path/to/dir       read pre-downloaded TIGER zips instead of HTTP
 *   --dry-run                     parse + match, print would-update counts, no writes
 *
 * Source URLs (all public, no auth):
 *   States:   {BASE}/STATE/tl_2024_us_state.zip          (one national file)
 *   Counties: {BASE}/COUNTY/tl_2024_us_county.zip        (one national file, ~100 MB)
 *   Places:   {BASE}/PLACE/tl_2024_{STATEFP}_place.zip   (one file per state)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import * as unzipper from "unzipper";
import { open as openShapefile } from "shapefile";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { createAdminClient, afterKey } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { STATE_DATA } from "../../jurisdictions/us-states";

const TIGER_YEAR = "2024";
const TIGER_BASE = `https://www2.census.gov/geo/tiger/TIGER${TIGER_YEAR}`;
const TMP_DIR = path.join(os.tmpdir(), "tiger-boundary-backfill");

type Level = "state" | "county" | "place";
const ALL_LEVELS: Level[] = ["state", "county", "place"];

interface Options {
  levels: Level[];
  stateFips: Set<string> | null; // null = all
  fromFile: string | null;
  dryRun: boolean;
}

interface Counters {
  updated: number;             // rows whose NULL boundary was (or would be) filled
  alreadyPopulated: number;    // matched but boundary already set → skipped
  noMatch: number;            // TIGER feature with no corresponding jurisdiction row
  ambiguous: number;          // >1 candidate row for the match key → skipped, logged
  parseError: number;         // geometry-less feature or RPC error
}

function emptyCounters(): Counters {
  return { updated: 0, alreadyPopulated: 0, noMatch: 0, ambiguous: 0, parseError: 0 };
}

// County level CREATES rows (insert-or-backfill), so it carries its own
// counters distinct from the backfill Counters above.
interface CountyCounters {
  inserted: number;          // new county row created (or would be, in dry-run)
  updatedBoundary: number;   // existing county row whose NULL boundary was filled
  alreadyComplete: number;   // existing county row already had a boundary → skipped
  skippedNoParent: number;   // STATEFP didn't resolve to a state/equivalent parent
  errors: number;            // RPC error
}

function emptyCountyCounters(): CountyCounters {
  return { inserted: 0, updatedBoundary: 0, alreadyComplete: 0, skippedNoParent: 0, errors: 0 };
}

// TIGER attribute fields we read across STATE / COUNTY / PLACE shapefiles.
interface TigerProps {
  STATEFP?: string;  // 2-digit state FIPS
  COUNTYFP?: string; // 3-digit county FIPS (county file)
  PLACEFP?: string;  // 5-digit place FIPS (place file)
  STUSPS?: string;   // postal abbreviation (state file)
  GEOID?: string;    // state=STATEFP, county=STATEFP+COUNTYFP, place=STATEFP+PLACEFP
  NAME?: string;     // bare name ("King", "Seattle", "Washington")
  NAMELSAD?: string; // legal/statistical name ("King County")
  LSAD?: string;     // legal/statistical area description code
}

// ── A matched target row, or a reason it was skipped ─────────────────────────
const AMBIGUOUS = Symbol("ambiguous");
interface Target { id: string; populated: boolean; }
type Match = Target | { skip: "noMatch" | "ambiguous" };

// ── fs / download helpers (mirrors districts-tiger) ──────────────────────────

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}
function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}
function rmDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) rmDir(fp);
        else safeUnlink(fp);
      }
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

// ── Match-table snapshot (preloaded once; ~60 rows total today) ──────────────
//
// All target rows fit trivially in memory, so per-feature matching is a pure
// Map lookup — zero DB round-trips while streaming thousands of TIGER features.
// RPC writes happen only on actual matches. A duplicate key (which would mean a
// data-integrity problem, e.g. two state rows sharing a FIPS) is recorded as
// AMBIGUOUS so the feature is skipped + logged rather than silently mis-written.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function addUnique(map: Map<string, Target | typeof AMBIGUOUS>, key: string | null | undefined, val: Target): void {
  if (!key) return;
  map.set(key, map.has(key) ? AMBIGUOUS : val);
}

function resolve(map: Map<string, Target | typeof AMBIGUOUS>, key: string | null | undefined): Match | null {
  if (!key) return null;
  const v = map.get(key);
  if (v === undefined) return null;
  if (v === AMBIGUOUS) return { skip: "ambiguous" };
  return v;
}

interface Snapshot {
  statesByFips: Map<string, Target | typeof AMBIGUOUS>;        // type='state'
  stateEquivByAbbr: Map<string, Target | typeof AMBIGUOUS>;    // DC + territories (type='district', census_geoid NULL)
  stateEquivByFips: Map<string, Target | typeof AMBIGUOUS>;
  countiesByGeoid: Map<string, Target | typeof AMBIGUOUS>; // existing county rows by 5-digit GEOID
  citiesByGeoid: Map<string, Target | typeof AMBIGUOUS>;
  citiesByFips: Map<string, Target | typeof AMBIGUOUS>;
  citiesByParentName: Map<string, Target | typeof AMBIGUOUS>;
}

function tgt(row: { id: string; boundary_geometry: unknown }): Target {
  return { id: row.id, populated: row.boundary_geometry != null };
}

// Throw on query error rather than silently treating it as "0 rows". A
// swallowed snapshot error (e.g. a transient `fetch failed` against local
// PostgREST) leaves a key map empty, which then surfaces as mass no-parent
// skips that masquerade as a clean run. Fail loud so the caller re-runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOrThrow(res: { data: any[] | null; error: { message: string } | null }, label: string): any[] {
  if (res.error) throw new Error(`snapshot ${label} query failed: ${res.error.message}`);
  return res.data ?? [];
}

async function loadSnapshot(db: Db): Promise<Snapshot> {
  const snap: Snapshot = {
    statesByFips: new Map(), stateEquivByAbbr: new Map(), stateEquivByFips: new Map(),
    countiesByGeoid: new Map(),
    citiesByGeoid: new Map(), citiesByFips: new Map(), citiesByParentName: new Map(),
  };

  // States (50). FIPS is unique within type='state'; census_geoid is NULL on
  // these rows so it can't be the match key — FIPS / postal abbr only.
  const states = rowsOrThrow(await db.from("jurisdictions")
    .select("id, fips_code, boundary_geometry").eq("type", "state"), "states");
  for (const r of states) addUnique(snap.statesByFips, r.fips_code, tgt(r));

  // State-equivalents: DC (federal_district) + 5 territories
  // (unincorporated_territory). Pre-FIX-E these lived as type='district' with a
  // bare 2-letter short_name and NULL census_geoid; FIX-E re-typed them off the
  // catch-all. Query BOTH shapes so the snapshot resolves them whether or not
  // the re-type migration has run yet — the migration always precedes the
  // pipeline in the loop, but the dual query keeps the snapshot robust either
  // way. The NULL-geoid filter on the legacy shape excludes the ~6,775 real
  // legislative/congressional districts (which all carry a census_geoid).
  const equivByType = rowsOrThrow(await db.from("jurisdictions")
    .select("id, short_name, fips_code, boundary_geometry")
    .in("type", ["federal_district", "unincorporated_territory"]), "state-equiv (by type)");
  const equivLegacy = rowsOrThrow(await db.from("jurisdictions")
    .select("id, short_name, fips_code, boundary_geometry")
    .eq("type", "district").is("census_geoid", null), "state-equiv (legacy)");
  for (const r of [...equivByType, ...equivLegacy]) {
    addUnique(snap.stateEquivByAbbr, r.short_name, tgt(r));
    addUnique(snap.stateEquivByFips, r.fips_code, tgt(r));
  }

  // Existing counties, keyed by 5-digit GEOID. Used by the county-create path
  // to decide insert-vs-update without a per-feature DB round-trip (mirrors the
  // backfill pre-check). 0 on first run; ~3,235 on re-runs — past PostgREST's
  // 1,000-row default cap, so this must paginate or it would under-report
  // existing counties and needlessly re-call the (idempotent) RPC.
  // FIX-984: keyset on the `id` pkey. Ordering by census_geoid gave the OFFSET
  // walk its page stability but is not a key we can seek on -- nothing declares
  // census_geoid unique, and a repeated cursor value drops rows silently.
  // Iteration order does not matter here; the loop only fills a Map.
  let afterCountyId: string | null = null;
  for (;;) {
    const page = rowsOrThrow(await afterKey(db.from("jurisdictions")
      .select("id, census_geoid, boundary_geometry").eq("type", "county")
      .order("id", { ascending: true }).limit(1000), "id", afterCountyId), "counties");
    for (const r of page) addUnique(snap.countiesByGeoid, r.census_geoid, tgt(r));
    if (page.length < 1000) break;
    afterCountyId = page[page.length - 1]!.id;
  }

  // Cities (4 pilot metros). fips_code holds the 7-digit place GEOID;
  // census_geoid is NULL. Match census_geoid → fips_code → (parent, name).
  const cities = rowsOrThrow(await db.from("jurisdictions")
    .select("id, census_geoid, fips_code, parent_id, name, boundary_geometry").eq("type", "city"), "cities");
  for (const r of cities) {
    addUnique(snap.citiesByGeoid, r.census_geoid, tgt(r));
    addUnique(snap.citiesByFips, r.fips_code, tgt(r));
    if (r.parent_id && r.name) addUnique(snap.citiesByParentName, `${r.parent_id}|${r.name.toLowerCase()}`, tgt(r));
  }

  return snap;
}

function parentStateId(snap: Snapshot, fips?: string): string | undefined {
  if (!fips) return undefined;
  const s = snap.statesByFips.get(fips);
  if (s && s !== AMBIGUOUS) return s.id;
  const e = snap.stateEquivByFips.get(fips);
  if (e && e !== AMBIGUOUS) return e.id;
  return undefined;
}

function matchState(snap: Snapshot, p: TigerProps): Match {
  return resolve(snap.statesByFips, p.STATEFP)
      ?? resolve(snap.stateEquivByAbbr, p.STUSPS)
      ?? { skip: "noMatch" };
}

function matchPlace(snap: Snapshot, p: TigerProps): Match {
  const byGeoid = resolve(snap.citiesByGeoid, p.GEOID) ?? resolve(snap.citiesByFips, p.GEOID);
  if (byGeoid) return byGeoid;
  const stateId = parentStateId(snap, p.STATEFP);
  if (stateId && p.NAME) {
    const byName = resolve(snap.citiesByParentName, `${stateId}|${p.NAME.toLowerCase()}`);
    if (byName) return byName;
  }
  return { skip: "noMatch" };
}

// ── Apply one matched feature ────────────────────────────────────────────────

async function applyMatch(
  db: Db, match: Match, feature: Feature<Polygon | MultiPolygon, TigerProps>,
  level: Level, opts: Options, counters: Counters,
): Promise<void> {
  if ("skip" in match) {
    if (match.skip === "noMatch") counters.noMatch++;
    else {
      counters.ambiguous++;
      const p = feature.properties ?? {};
      console.warn(`    ${level} ambiguous match — GEOID=${p.GEOID ?? "?"} NAME=${p.NAME ?? "?"} (skipped)`);
    }
    return;
  }
  if (match.populated) { counters.alreadyPopulated++; return; }
  if (opts.dryRun) { counters.updated++; return; } // would update

  const geojson = JSON.stringify(feature.geometry);
  const { data, error } = await db.rpc("backfill_jurisdiction_boundary" as never, {
    p_id: match.id, p_geojson: geojson,
  } as never);
  if (error) {
    counters.parseError++;
    console.warn(`    ${level} rpc error id=${match.id}: ${error.message}`);
    return;
  }
  // false here means the row was populated between snapshot load and write
  // (the RPC's WHERE boundary_geometry IS NULL guard is the race backstop).
  if (data === true) counters.updated++;
  else counters.alreadyPopulated++;
}

// ── Per-level drivers ────────────────────────────────────────────────────────

/** Resolve a level's zip path: from --from-file dir, or download to TMP_DIR. */
async function getZip(opts: Options, subdir: string, fileName: string): Promise<{ zipPath: string; downloaded: boolean; bytes: number }> {
  if (opts.fromFile) {
    const zipPath = path.join(opts.fromFile, fileName);
    if (!fs.existsSync(zipPath)) throw new Error(`--from-file: ${zipPath} not found`);
    return { zipPath, downloaded: false, bytes: 0 };
  }
  const zipPath = path.join(TMP_DIR, fileName);
  const bytes = await downloadFile(`${TIGER_BASE}/${subdir}/${fileName}`, zipPath);
  return { zipPath, downloaded: true, bytes };
}

async function streamFeatures(
  shp: string, dbf: string,
  onFeature: (f: Feature<Polygon | MultiPolygon, TigerProps>) => Promise<void>,
  counters: Counters,
): Promise<void> {
  const source = await openShapefile(shp, dbf);
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    const feature = value as Feature<Polygon | MultiPolygon, TigerProps>;
    if (!feature.geometry) { counters.parseError++; continue; }
    await onFeature(feature);
  }
}

async function runLevelState(db: Db, snap: Snapshot, opts: Options, counters: Counters): Promise<number> {
  const fileName = `tl_${TIGER_YEAR}_us_state.zip`;
  const { zipPath, downloaded, bytes } = await getZip(opts, "STATE", fileName);
  const extractDir = path.join(TMP_DIR, "state");
  const paths = await extractZip(zipPath, extractDir);
  if (downloaded) safeUnlink(zipPath);
  if (!paths) { rmDir(extractDir); throw new Error("state: unzip produced no .shp/.dbf"); }
  await streamFeatures(paths.shp, paths.dbf,
    (f) => applyMatch(db, matchState(snap, f.properties ?? {}), f, "state", opts, counters),
    counters);
  rmDir(extractDir);
  return bytes;
}

// County level CREATES rows (the table has 0 today) and backfills their
// boundary in the same pass, via upsert_county_jurisdiction. Parent
// state/state-equivalent resolves by STATEFP; a county whose STATEFP doesn't
// resolve is skipped + logged (never inserted parentless). The RPC inserts on
// no-match and otherwise fills boundary/centroid only if NULL — never
// overwrites. Insert-vs-update is decided from the in-memory snapshot so we can
// skip the RPC entirely for counties already complete.
async function runLevelCountyCreate(
  db: Db, snap: Snapshot, opts: Options, counters: Counters, cc: CountyCounters,
): Promise<number> {
  const fileName = `tl_${TIGER_YEAR}_us_county.zip`;
  console.log(`    downloading national county file (~100 MB)…`);
  const { zipPath, downloaded, bytes } = await getZip(opts, "COUNTY", fileName);
  const extractDir = path.join(TMP_DIR, "county");
  const paths = await extractZip(zipPath, extractDir);
  if (downloaded) safeUnlink(zipPath);
  if (!paths) { rmDir(extractDir); throw new Error("county: unzip produced no .shp/.dbf"); }

  await streamFeatures(paths.shp, paths.dbf, async (f) => {
    const p = f.properties ?? {};
    if (opts.stateFips && p.STATEFP && !opts.stateFips.has(p.STATEFP)) return; // out of requested scope

    const geoid = p.GEOID;
    if (!geoid) { cc.errors++; return; }

    const parentId = parentStateId(snap, p.STATEFP);
    if (!parentId) {
      cc.skippedNoParent++;
      console.warn(`    county skipped (no parent) — STATEFP=${p.STATEFP ?? "?"} GEOID=${geoid} NAME=${p.NAMELSAD ?? p.NAME ?? "?"}`);
      return;
    }

    // Insert-vs-update from the snapshot; skip the RPC for already-complete rows.
    const existing = resolve(snap.countiesByGeoid, geoid);
    const isExisting = existing !== null && !("skip" in existing);
    if (isExisting && (existing as Target).populated) { cc.alreadyComplete++; return; }

    if (opts.dryRun) {
      if (isExisting) cc.updatedBoundary++; else cc.inserted++;
      return;
    }

    // NAMELSAD is the conventional civic name ("King County", "Adjuntas
    // Municipio"); NAME is the bare name. Keep TIGER's NAMELSAD authoritative.
    const name = p.NAMELSAD ?? p.NAME ?? geoid;
    const shortName = p.NAME ?? name;
    const args = {
      p_parent_id: parentId,
      p_census_geoid: geoid,
      p_fips_code: geoid,
      p_name: name,
      p_short_name: shortName,
      p_boundary_geojson: JSON.stringify(f.geometry),
    };
    // The RPC is idempotent (insert-by-GEOID, COALESCE-fill), so retrying a
    // transient `fetch failed` is safe. Local PostgREST intermittently resets
    // sockets under rapid sequential calls — a couple of retries reclaim
    // counties that would otherwise be orphaned for the next run to mop up.
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await db.rpc("upsert_county_jurisdiction" as never, args as never);
      if (!error) { lastErr = null; break; }
      lastErr = error.message;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    if (lastErr) {
      cc.errors++;
      console.warn(`    county rpc error GEOID=${geoid}: ${lastErr}`);
      return;
    }
    if (isExisting) cc.updatedBoundary++; else cc.inserted++;
  }, counters);

  rmDir(extractDir);
  return bytes;
}

async function runLevelPlace(db: Db, snap: Snapshot, opts: Options, counters: Counters, fipsList: string[]): Promise<number> {
  let bytes = 0;
  for (const fips of fipsList) {
    const fileName = `tl_${TIGER_YEAR}_${fips}_place.zip`;
    let zip: { zipPath: string; downloaded: boolean; bytes: number };
    try {
      zip = await getZip(opts, "PLACE", fileName);
    } catch (err) {
      // Not every STATEFP has a place file (some territories). Skip, don't abort.
      console.warn(`    place ${fips}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    bytes += zip.bytes;
    const extractDir = path.join(TMP_DIR, `place_${fips}`);
    const paths = await extractZip(zip.zipPath, extractDir).catch(() => null);
    if (zip.downloaded) safeUnlink(zip.zipPath);
    if (!paths) { rmDir(extractDir); counters.parseError++; continue; }
    const before = counters.updated;
    await streamFeatures(paths.shp, paths.dbf,
      (f) => applyMatch(db, matchPlace(snap, f.properties ?? {}), f, "place", opts, counters),
      counters);
    rmDir(extractDir);
    const delta = counters.updated - before;
    if (delta > 0) console.log(`    place ${fips}: ${delta} ${opts.dryRun ? "would-update" : "updated"} · ${(zip.bytes / 1024).toFixed(0)}KB`);
  }
  return bytes;
}

// ── Main runner ──────────────────────────────────────────────────────────────

function logLevel(level: Level, c: Counters, before: Counters): void {
  console.log(
    `  ${level}: ${c.updated - before.updated} updated · ` +
    `${c.alreadyPopulated - before.alreadyPopulated} already · ` +
    `${c.noMatch - before.noMatch} no-match · ` +
    `${c.ambiguous - before.ambiguous} ambiguous · ` +
    `${c.parseError - before.parseError} errors`,
  );
}

export async function runJurisdictionBoundaryBackfill(opts: Options): Promise<PipelineResult> {
  console.log(`\n=== Jurisdiction boundary backfill (TIGER ${TIGER_YEAR}) ===`);
  console.log(`  levels=${opts.levels.join(",")} · stateFips=${opts.stateFips ? [...opts.stateFips].join(",") : "all"} · dryRun=${opts.dryRun}${opts.fromFile ? ` · fromFile=${opts.fromFile}` : ""}`);
  const logId = await startSync("jurisdictions_boundary_backfill");
  const db = createAdminClient();
  const counters = emptyCounters();
  const countyCounters = emptyCountyCounters();
  let bytes = 0;

  try {
    ensureTmpDir();
    const snap = await loadSnapshot(db);
    console.log(`  snapshot: ${snap.statesByFips.size} states · ${snap.stateEquivByAbbr.size} state-equiv · ${snap.countiesByGeoid.size} counties · ${snap.citiesByFips.size} cities`);

    const placeFips = opts.stateFips ? [...opts.stateFips] : STATE_DATA.map((s) => s.fips);

    if (opts.levels.includes("state")) {
      console.log("\n  --- States ---");
      const before = { ...counters };
      bytes += await runLevelState(db, snap, opts, counters);
      logLevel("state", counters, before);
    }
    if (opts.levels.includes("county")) {
      console.log("\n  --- Counties (create + backfill) ---");
      bytes += await runLevelCountyCreate(db, snap, opts, counters, countyCounters);
      console.log(
        `  county: ${countyCounters.inserted} ${opts.dryRun ? "would-insert" : "inserted"} · ` +
        `${countyCounters.updatedBoundary} boundary-filled · ` +
        `${countyCounters.alreadyComplete} already-complete · ` +
        `${countyCounters.skippedNoParent} no-parent · ` +
        `${countyCounters.errors} errors`,
      );
    }
    if (opts.levels.includes("place")) {
      console.log("\n  --- Places ---");
      const before = { ...counters };
      bytes += await runLevelPlace(db, snap, opts, counters, placeFips);
      logLevel("place", counters, before);
    }

    rmDir(TMP_DIR);

    const result: PipelineResult = {
      inserted: countyCounters.inserted, // county-create path; backfill levels never insert
      updated: counters.updated + countyCounters.updatedBoundary,
      failed: counters.parseError + countyCounters.errors,
      estimatedMb: +(bytes / 1024 / 1024).toFixed(2),
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log(`  Boundary backfill report${opts.dryRun ? " (DRY RUN)" : ""}`);
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${opts.dryRun ? "Would update" : "Updated"}:        ${counters.updated}`);
    console.log(`  Already populated:   ${counters.alreadyPopulated}`);
    console.log(`  No match:            ${counters.noMatch}`);
    console.log(`  Ambiguous (skipped): ${counters.ambiguous}`);
    console.log(`  Errors:              ${counters.parseError}`);
    if (opts.levels.includes("county")) {
      console.log(`  County ${opts.dryRun ? "would-insert" : "inserted"}: ${countyCounters.inserted}`);
      console.log(`  County boundary-filled: ${countyCounters.updatedBoundary}`);
      console.log(`  County already-complete: ${countyCounters.alreadyComplete}`);
      console.log(`  County no-parent (skipped): ${countyCounters.skippedNoParent}`);
      console.log(`  County errors:          ${countyCounters.errors}`);
    }
    console.log(`  Downloaded:          ${(bytes / 1024 / 1024).toFixed(1)} MB`);

    if (opts.dryRun) {
      // A dry run wrote nothing — mark the sync row skipped, not complete.
      const { skipSync } = await import("../sync-log");
      await skipSync(logId, `dry-run: would update ${counters.updated}, insert ${countyCounters.inserted} counties`);
    } else {
      await completeSync(logId, result);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Boundary backfill fatal error:", msg);
    await failSync(logId, msg);
    rmDir(TMP_DIR);
    return { inserted: countyCounters.inserted, updated: counters.updated + countyCounters.updatedBoundary, failed: counters.parseError + countyCounters.errors + 1, estimatedMb: +(bytes / 1024 / 1024).toFixed(2) };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const valueOf = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    return undefined;
  };

  const levelsRaw = valueOf("levels");
  const levels = levelsRaw
    ? (levelsRaw.split(",").map((s) => s.trim()).filter(Boolean) as Level[])
    : ALL_LEVELS;
  const bad = levels.filter((l) => !ALL_LEVELS.includes(l));
  if (bad.length) throw new Error(`invalid --levels value(s): ${bad.join(",")} (allowed: ${ALL_LEVELS.join(",")})`);

  const fipsRaw = valueOf("state-fips");
  const stateFips = fipsRaw
    ? new Set(fipsRaw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.padStart(2, "0")))
    : null;

  return {
    levels,
    stateFips,
    fromFile: valueOf("from-file") ?? null,
    dryRun: argv.includes("--dry-run"),
  };
}

if (require.main === module) {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  runJurisdictionBoundaryBackfill(opts)
    .then(() => setTimeout(() => process.exit(0), 500))
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
