/**
 * FIX-914 — regenerate `src/data/nh-house-districts-2022.json` from the
 * checked-in RSA 662:5 HTML.
 *
 *   pnpm --filter @civitics/data data:nh:parse            # write the JSON
 *   pnpm --filter @civitics/data data:nh:parse -- --check # diff only, exit 1
 *
 * The JSON is the checked-in transcription; this script is how it is produced,
 * and `nh-house-districts-2022.test.ts` re-runs the parse and asserts the two
 * agree, so the JSON cannot be hand-edited away from the statute.
 *
 * No DB, no network — the statute HTML is checked in beside the output.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseRsa662_5, deriveFloterials, type NhHouseDistricts,
} from "../data/nh-house-districts";

const DATA_DIR = path.join(__dirname, "..", "data");
export const HTML_PATH = path.join(DATA_DIR, "sources", "rsa-662-5-2026-09-10.html");
export const JSON_PATH = path.join(DATA_DIR, "nh-house-districts-2022.json");

/** The statute, parsed and floterial-classified. Pure; used by the test too. */
export function buildTranscription(): NhHouseDistricts {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  return {
    source: "RSA 662:5 (2022 New Hampshire House redistricting plan)",
    url: "https://gc.nh.gov/rsa/html/LXIII/662/662-5.htm",
    fetched_at: "2026-09-10",
    districts: deriveFloterials(parseRsa662_5(html)),
  };
}

export function serialise(t: NhHouseDistricts): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}

if (require.main === module) {
  const check = process.argv.includes("--check");
  const next = serialise(buildTranscription());

  if (check) {
    const cur = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, "utf8") : "";
    if (cur !== next) {
      console.error("nh-house-districts-2022.json is stale — re-run without --check");
      process.exit(1);
    }
    console.info("nh-house-districts-2022.json is current");
  } else {
    fs.writeFileSync(JSON_PATH, next);
    const t = JSON.parse(next) as NhHouseDistricts;
    const flot = t.districts.filter((d) => d.floterial);
    console.info(`wrote ${path.relative(process.cwd(), JSON_PATH)}`);
    console.info(`  districts ${t.districts.length} · floterial ${flot.length}` +
      ` · seats ${t.districts.reduce((n, d) => n + d.seats, 0)}` +
      ` (floterial ${flot.reduce((n, d) => n + d.seats, 0)})`);
  }
}
