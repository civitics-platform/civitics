/**
 * OPM FedScope → agencies.personnel_fte — FIX-214.
 *
 * Source: HuggingFace mirror of OPM EHRI Federal Workforce Data (FWD).
 *   Dataset: https://huggingface.co/datasets/impactproject/opm-ehri-data
 *   Files:   employment/employment_YYYYMM_vN.parquet  (~50–65 MB per month)
 *
 * Why HuggingFace instead of data.opm.gov directly:
 *   data.opm.gov (new FWD site, replaces fedscope.opm.gov) uses Blazor with
 *   session-scoped signed download URLs — not directly accessible via HTTP GET.
 *   The impactproject mirror on HuggingFace publishes the same files with
 *   static, stable URLs, updated monthly.
 *
 * Agency code mapping:
 *   OPM FWD uses 2-letter toptier agency codes (e.g. "AG", "DD", "HE").
 *   These differ from USASpending 3-digit numeric toptier codes.
 *   Primary: OPM_TO_USAS_CODE static table.
 *   Fallback: normalised-name match against agencies.name / acronym.
 *
 * Run:
 *   pnpm --filter @civitics/data data:opm-fte
 *   OPM_FEDSCOPE_URL=https://huggingface.co/.../employment_202603_v1.parquet \
 *     pnpm --filter @civitics/data data:opm-fte
 */

import { createAdminClient } from "@civitics/db";
import { completeSync, failSync, startSync, type PipelineResult } from "../sync-log";

// ---------------------------------------------------------------------------
// OPM 2-letter toptier code → USASpending toptier code
// ---------------------------------------------------------------------------

const OPM_TO_USAS_CODE: Record<string, string> = {
  AG: "12",   // Agriculture
  CM: "13",   // Commerce
  DD: "97",   // Defense
  ED: "91",   // Education
  DN: "89",   // Energy
  HE: "75",   // Health and Human Services
  HS: "70",   // Homeland Security
  HU: "86",   // Housing and Urban Development
  IN: "14",   // Interior
  JU: "15",   // Justice
  LB: "16",   // Labor
  ST: "19",   // State
  TD: "69",   // Transportation
  TR: "20",   // Treasury
  VA: "36",   // Veterans Affairs
  EP: "68",   // EPA
  NN: "80",   // NASA
  NS: "49",   // National Science Foundation
  SB: "73",   // Small Business Administration
  SS: "28",   // Social Security Administration
  PM: "27",   // Office of Personnel Management
  GS: "47",   // General Services Administration
  FT: "29",   // Federal Trade Commission
  CC: "422",  // Federal Communications Commission
  SE: "438",  // Securities and Exchange Commission
  RC: "443",  // Nuclear Regulatory Commission
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** HuggingFace API: list files under employment/ and return the URL for the
 *  most recent monthly parquet (latest YYYYMM, highest vN). */
async function resolveLatestHfUrl(): Promise<string | null> {
  try {
    const resp = await fetch(
      "https://huggingface.co/api/datasets/impactproject/opm-ehri-data/tree/main/employment",
      { headers: { "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)" } }
    );
    if (!resp.ok) return null;
    const files = await resp.json() as Array<{ path: string; type: string }>;
    const parquetPaths = files
      .filter((f) => f.type === "file" && /employment_\d{6}_v\d+\.parquet$/.test(f.path))
      .map((f) => f.path)
      .sort(); // lexicographic sort puts latest YYYYMM and highest vN last
    const latest = parquetPaths[parquetPaths.length - 1];
    if (!latest) return null;
    return `https://huggingface.co/datasets/impactproject/opm-ehri-data/resolve/main/${latest}`;
  } catch {
    return null;
  }
}

async function fetchParquet(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)" },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    return resp.arrayBuffer();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parquet parsing — returns agency_code → total FTE and agency_code → name
// ---------------------------------------------------------------------------

interface ParsedEmployment {
  fteByOpmCode: Map<string, number>;
  opmCodeToName: Map<string, string>;
}

async function parseEmploymentParquet(buf: ArrayBuffer): Promise<ParsedEmployment> {
  const fteByOpmCode = new Map<string, number>();
  const opmCodeToName = new Map<string, string>();

  // Dynamic imports — hyparquet is ESM-only; dynamic import works from CJS contexts.
  const { parquetRead } = await import("hyparquet");
  const { compressors } = await import("hyparquet-compressors");

  let rowCount = 0;

  await parquetRead({
    file: buf,
    compressors,
    columns: ["agency_code", "agency", "count"],
    onComplete: (rows: unknown[][]) => {
      for (const row of rows) {
        const agencyCode = (row[0] as string | null)?.trim().toUpperCase();
        const agencyName = (row[1] as string | null)?.trim() ?? "";
        const countRaw = row[2] as string | number | null;
        const count = typeof countRaw === "number" ? countRaw : parseInt(String(countRaw ?? "0"), 10);

        if (!agencyCode || isNaN(count) || count <= 0) continue;

        fteByOpmCode.set(agencyCode, (fteByOpmCode.get(agencyCode) ?? 0) + count);
        if (agencyName && !opmCodeToName.has(agencyCode)) {
          opmCodeToName.set(agencyCode, agencyName);
        }
        rowCount++;
      }
    },
  });

  console.log(`    Parsed ${rowCount.toLocaleString()} rows, ${fteByOpmCode.size} unique agency codes`);
  return { fteByOpmCode, opmCodeToName };
}

// ---------------------------------------------------------------------------
// Match OPM codes to DB agencies and write personnel_fte
// ---------------------------------------------------------------------------

async function applyFteToAgencies(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  fteByOpmCode: Map<string, number>,
  opmCodeToName: Map<string, string>,
  result: PipelineResult
): Promise<void> {
  const { data: agencies, error } = await db
    .from("agencies")
    .select("id, name, acronym, short_name, usaspending_agency_id")
    .eq("agency_type", "federal");
  if (error) throw new Error(error.message);

  const agencyByUsasCode = new Map<string, { id: string; name: string }>();
  const agencyByNormName = new Map<string, { id: string; name: string }>();
  for (const a of agencies ?? []) {
    if (a.usaspending_agency_id) agencyByUsasCode.set(String(a.usaspending_agency_id), a);
    agencyByNormName.set(normalizeName(a.name), a);
    if (a.acronym) agencyByNormName.set(normalizeName(a.acronym), a);
    if (a.short_name) agencyByNormName.set(normalizeName(a.short_name), a);
  }

  let matched = 0;
  let unmatched = 0;

  for (const [opmCode, fte] of fteByOpmCode) {
    let agency: { id: string; name: string } | undefined;

    // 1. Static code mapping
    const usasCode = OPM_TO_USAS_CODE[opmCode];
    if (usasCode) agency = agencyByUsasCode.get(usasCode);

    // 2. Normalised-name match using OPM agency name from the parquet file
    if (!agency) {
      const opmName = opmCodeToName.get(opmCode) ?? "";
      if (opmName) agency = agencyByNormName.get(normalizeName(opmName));
    }

    if (!agency) { unmatched++; continue; }

    const { error: updErr } = await db
      .from("agencies")
      .update({ personnel_fte: fte, updated_at: new Date().toISOString() })
      .eq("id", agency.id);
    if (updErr) {
      result.failed++;
    } else {
      result.updated++;
      matched++;
    }
  }

  console.log(`    Matched: ${matched} agencies updated, ${unmatched} OPM codes unmatched`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runOpmFtePipeline(): Promise<PipelineResult> {
  console.log("\n=== OPM FedScope FTE pipeline (FIX-214) ===");

  const logId = await startSync("opm_fte");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    const envUrl = process.env["OPM_FEDSCOPE_URL"];
    let sourceUrl: string | null = envUrl ?? null;

    if (!sourceUrl) {
      console.log("  Resolving latest HuggingFace employment parquet...");
      sourceUrl = await resolveLatestHfUrl();
    }

    if (!sourceUrl) {
      await failSync(logId, "Could not resolve OPM employment parquet URL");
      return result;
    }

    console.log(`  Fetching: ${sourceUrl}`);
    const buf = await fetchParquet(sourceUrl);
    if (!buf) {
      await failSync(logId, `Failed to fetch parquet from: ${sourceUrl}`);
      return result;
    }

    result.estimatedMb = buf.byteLength / 1024 / 1024;
    console.log(`  Downloaded ${result.estimatedMb.toFixed(1)} MB`);

    const { fteByOpmCode, opmCodeToName } = await parseEmploymentParquet(buf);
    await applyFteToAgencies(db, fteByOpmCode, opmCodeToName, result);

    await completeSync(logId, result);
    console.log(`\n  ✓ Done. Updated: ${result.updated}, failed: ${result.failed}`);
    return result;
  } catch (err) {
    await failSync(logId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

if (require.main === module) {
  runOpmFtePipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
