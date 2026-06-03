/**
 * Agency enrichment pipeline — FIX-208.
 *
 * Two passes:
 *   1. USA.gov Social Media Registry → metadata.{twitter_handle, youtube_handle,
 *      facebook_url, instagram_handle}
 *   2. Federal Register /api/v1/agencies.json → fill empty description/website_url
 *      + Wikidata SPARQL → founded_year, wikidata_id
 *
 * NOTE: personnel_fte (FTE headcount) was originally planned via USASpending
 * /api/v2/agency/{toptier_code}/employees/ but that endpoint was removed from
 * the USASpending API. FTE data requires OPM FedScope bulk download — deferred
 * to a future pipeline pass.
 *
 * Safe to re-run: all writes are upserts or conditional updates.
 *
 * Run:
 *   pnpm --filter @civitics/data data:agency-enrichment
 *   pnpm --filter @civitics/data data:agency-enrichment -- --pass=1  (single pass)
 */

import { createAdminClient } from "@civitics/db";
import { completeSync, failSync, startSync, type PipelineResult } from "../sync-log";
import { sleep } from "../utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgencyRow {
  id: string;
  name: string;
  acronym: string | null;
  short_name: string | null;
  agency_type: string;
  description: string | null;
  website_url: string | null;
  metadata: Record<string, unknown> | null;
  wikidata_id: string | null;
  founded_year: number | null;
  source_ids: Record<string, unknown> | null;
  primary_source: string | null;
}

// ---------------------------------------------------------------------------
// Pass 1: USA.gov Social Media Registry
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function enrichSocialMedia(_db: ReturnType<typeof createAdminClient>, _agencies: AgencyRow[], _result: PipelineResult): Promise<void> {
  // registry.usa.gov was decommissioned. No working archive source found.
  // Implement this pass when a replacement source is available.
  console.log("\n  Pass 1: Social media handles — DEFERRED (no source available)");
}

// ---------------------------------------------------------------------------
// Pass 2: Federal Register descriptions + Wikidata
// ---------------------------------------------------------------------------

interface FedRegAgency {
  name: string;
  short_name: string | null;
  display_name: string | null;
  description: string | null;
  url: string | null;
  slug: string | null;
}

interface WikidataBinding {
  agency: { value: string };
  agencyLabel: { value: string };
  founded?: { value: string };
}

// ── FIX-415: Federal Register slug matcher ──────────────────────────────────
//
// For agencies that carry no source signal at all (EOP offices, some DHS
// sub-orgs — they lack regulations_gov_agency_id / wikidata_id / metadata.source),
// the Federal Register agency registry is the attribution source. The loose
// name/acronym index used for description/website fill is unsafe for the slug
// because acronyms collide across FedReg records (e.g. short_name "DOL" maps to
// BOTH "Labor Department" and the historical "Employment Standards
// Administration"). This builds a stricter matcher:
//   • full-name index, including a "Department of X" ↔ "X Department" /
//     "Office of X" ↔ "X Office" word-order swap (our DB says "Department of
//     Labor"; FedReg says "Labor Department"). Ambiguous keys are dropped.
//   • short_name index restricted to short_names that are GLOBALLY UNIQUE across
//     the FedReg list — so an ambiguous acronym never resolves.
function fedRegNameVariants(name: string): string[] {
  const out = new Set<string>([name]);
  const lo = name.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  if ((m = lo.match(/^department of (.+)$/))) out.add(`${m[1]} department`);
  if ((m = lo.match(/^(.+) department$/))) out.add(`department of ${m[1]}`);
  if ((m = lo.match(/^office of (.+)$/))) out.add(`${m[1]} office`);
  return [...out];
}

function buildFedRegSlugMatcher(
  fedRegAgencies: FedRegAgency[],
): (agency: AgencyRow) => FedRegAgency | null {
  const nameIdx = new Map<string, FedRegAgency>();
  const nameAmbig = new Set<string>();
  for (const a of fedRegAgencies) {
    if (!a.slug) continue;
    for (const v of fedRegNameVariants(a.name)) {
      const k = normalizeName(v);
      if (!k) continue;
      const existing = nameIdx.get(k);
      if (existing && existing.slug !== a.slug) nameAmbig.add(k);
      else nameIdx.set(k, a);
    }
  }

  // short_names that occur exactly once across the whole registry
  const shortCount = new Map<string, number>();
  for (const a of fedRegAgencies) {
    const k = normalizeName(a.short_name ?? "");
    if (k) shortCount.set(k, (shortCount.get(k) ?? 0) + 1);
  }
  const shortIdx = new Map<string, FedRegAgency>();
  for (const a of fedRegAgencies) {
    if (!a.slug) continue;
    const k = normalizeName(a.short_name ?? "");
    if (k && shortCount.get(k) === 1) shortIdx.set(k, a);
  }

  return (agency: AgencyRow): FedRegAgency | null => {
    for (const v of fedRegNameVariants(agency.name)) {
      const k = normalizeName(v);
      if (k && nameIdx.has(k) && !nameAmbig.has(k)) return nameIdx.get(k)!;
    }
    for (const s of [agency.acronym, agency.short_name]) {
      const k = normalizeName(s ?? "");
      if (k && shortIdx.has(k)) return shortIdx.get(k)!;
    }
    return null;
  };
}

async function enrichFedRegAndWikidata(db: ReturnType<typeof createAdminClient>, agencies: AgencyRow[], result: PipelineResult): Promise<void> {
  console.log("\n  Pass 2: Federal Register + Wikidata");

  // ── Federal Register ────────────────────────────────────────────────────────
  let fedRegAgencies: FedRegAgency[] = [];
  try {
    const resp = await fetch("https://www.federalregister.gov/api/v1/agencies.json", {
      headers: { accept: "application/json" },
    });
    if (resp.ok) {
      fedRegAgencies = (await resp.json()) as FedRegAgency[];
      console.log(`    Federal Register: ${fedRegAgencies.length} agency records`);
    }
  } catch (err) {
    console.warn("    Federal Register unavailable:", err instanceof Error ? err.message : err);
  }

  const fedRegByName = new Map<string, FedRegAgency>();
  for (const fr of fedRegAgencies) {
    fedRegByName.set(normalizeName(fr.name), fr);
    if (fr.short_name) fedRegByName.set(normalizeName(fr.short_name), fr);
    if (fr.display_name) fedRegByName.set(normalizeName(fr.display_name), fr);
  }

  // ── Wikidata: bulk query for US federal agencies ─────────────────────────────
  // Q910252 = "United States federal executive department" (DOD, State, etc.)
  // Q1752939 = "independent agency of the United States government" (EPA, FCC, etc.)
  //   (constrained by P17=Q30 to exclude non-US agencies with same P31)
  // Q48525   = "Federal Government of the United States" parent org (P749)
  // P571 = inception date; label service returns English label
  const sparql = `
SELECT DISTINCT ?agency ?agencyLabel ?founded WHERE {
  {
    ?agency wdt:P31 wd:Q910252 .
  } UNION {
    ?agency wdt:P31 wd:Q1752939 .
    ?agency wdt:P17 wd:Q30 .
  } UNION {
    ?agency wdt:P749 wd:Q48525 .
  }
  OPTIONAL { ?agency wdt:P571 ?founded }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?agencyLabel
LIMIT 3000
`.trim();

  let wikidataRows: WikidataBinding[] = [];
  try {
    await sleep(1000);
    const qs = new URLSearchParams({ query: sparql, format: "json" });
    const resp = await fetch(`https://query.wikidata.org/sparql?${qs.toString()}`, {
      headers: {
        accept: "application/sparql-results+json",
        "User-Agent": "Civitics/1.0 (civic data platform; contact@civitics.com)",
      },
    });
    if (resp.ok) {
      const body = await resp.json() as { results?: { bindings?: WikidataBinding[] } };
      wikidataRows = body.results?.bindings ?? [];
      console.log(`    Wikidata: ${wikidataRows.length} US agency bindings`);
    } else {
      console.warn(`    Wikidata SPARQL returned ${resp.status}`);
    }
  } catch (err) {
    console.warn("    Wikidata unavailable:", err instanceof Error ? err.message : err);
  }

  // Index by label — store both the full label and a stripped version without
  // common "United States " / "U.S. " prefixes so we can match our DB names
  // like "Department of Defense" against Wikidata's "United States Department
  // of Defense".
  const US_PREFIXES = ["unitedstates", "us", "usfederal"];
  function stripUsPrefix(normalized: string): string {
    for (const p of US_PREFIXES) {
      if (normalized.startsWith(p)) return normalized.slice(p.length);
    }
    return normalized;
  }

  const wikidataByLabel = new Map<string, { qid: string; founded: number | null }>();
  for (const row of wikidataRows) {
    const rawLabel = row.agencyLabel?.value ?? "";
    const qid = row.agency?.value?.replace("http://www.wikidata.org/entity/", "") ?? null;
    if (!rawLabel || !qid) continue;
    const foundedRaw = row.founded?.value;
    const founded = foundedRaw ? new Date(foundedRaw).getFullYear() : null;
    const entry = { qid, founded: isNaN(founded as number) ? null : (founded ?? null) };
    const full = normalizeName(rawLabel);
    if (!wikidataByLabel.has(full)) wikidataByLabel.set(full, entry);
    const stripped = stripUsPrefix(full);
    if (stripped !== full && !wikidataByLabel.has(stripped)) wikidataByLabel.set(stripped, entry);
  }

  // FIX-415: stricter slug matcher for the federal_register attribution fallback
  const matchFedRegSlug = buildFedRegSlugMatcher(fedRegAgencies);
  // (agency.id, slug) pairs whose primary_source we'll seed from Federal Register
  const fedRegSeeds: Array<{ id: string; slug: string }> = [];

  // ── Apply to each agency ─────────────────────────────────────────────────────
  let wdMatched = 0;
  let frMatched = 0;
  for (const agency of agencies) {
    const update: Record<string, unknown> = {};

    // Federal Register: fill empty description / website
    const frMatch = fedRegByName.get(normalizeName(agency.name))
      ?? fedRegByName.get(normalizeName(agency.acronym ?? ""))
      ?? fedRegByName.get(normalizeName(agency.short_name ?? ""));
    if (frMatch) {
      frMatched++;
      if (!agency.description && frMatch.description?.trim()) {
        update["description"] = frMatch.description.trim();
      }
      if (!agency.website_url && frMatch.url?.trim()) {
        update["website_url"] = frMatch.url.trim();
      }
    }

    // FIX-415: federal_register fallback attribution. Only for agencies with no
    // existing source signal — those carrying regulations_gov_agency_id are
    // bound via regulations_gov (a higher-priority source), so we leave them be
    // and don't double-stamp a federal_register slug. Genuinely-unmatched EOP
    // offices stay NULL (the don't-guess rule).
    const hasRegSource =
      typeof (agency.source_ids as Record<string, unknown> | null)?.[
        "regulations_gov_agency_id"
      ] === "string";
    if (!hasRegSource) {
      const slugMatch = matchFedRegSlug(agency);
      if (slugMatch?.slug) {
        fedRegSeeds.push({ id: agency.id, slug: slugMatch.slug });
        const existingSlug = (agency.source_ids as Record<string, unknown> | null)?.[
          "federal_register_agency_slug"
        ];
        if (existingSlug !== slugMatch.slug) {
          update["source_ids"] = {
            ...(agency.source_ids ?? {}),
            federal_register_agency_slug: slugMatch.slug,
          };
        }
      }
    }

    // Wikidata: founded_year, wikidata_id
    const nameKey = normalizeName(agency.name);
    const wdMatch = wikidataByLabel.get(nameKey)
      ?? wikidataByLabel.get(stripUsPrefix(nameKey))
      ?? wikidataByLabel.get(normalizeName(agency.acronym ?? ""))
      ?? wikidataByLabel.get(normalizeName(agency.short_name ?? ""));
    if (wdMatch) {
      wdMatched++;
      if (!agency.wikidata_id && wdMatch.qid) update["wikidata_id"] = wdMatch.qid;
      if (!agency.founded_year && wdMatch.founded) update["founded_year"] = wdMatch.founded;
    }

    if (Object.keys(update).length === 0) continue;
    update["updated_at"] = new Date().toISOString();

    const { error } = await db.from("agencies").update(update).eq("id", agency.id);
    if (error) {
      result.failed++;
    } else {
      result.updated++;
    }
  }
  console.log(`    FedReg matches: ${frMatched}, Wikidata matches: ${wdMatched}, DB writes: ${result.updated}`);

  // ── FIX-415: seed external_source_refs + materialize primary_source ──────────
  // Mirrors the FIX-410 path (xsr row → rebuild picks the winner) but sourced
  // from Federal Register for agencies that had no other signal. Idempotent:
  // upsert ignores (source, external_id) dupes; the refresh RPC is a no-op when
  // nothing changed.
  if (fedRegSeeds.length > 0) {
    const nowIso = new Date().toISOString();
    const xsrRows = fedRegSeeds.map((s) => ({
      source: "federal_register",
      external_id: s.slug,
      entity_type: "agency",
      entity_id: s.id,
      source_url: `https://www.federalregister.gov/agencies/${s.slug}`,
      last_seen_at: nowIso,
      metadata: {},
    }));
    const { error: xsrErr } = await db
      .from("external_source_refs")
      .upsert(xsrRows, { onConflict: "source,external_id", ignoreDuplicates: true });
    if (xsrErr) {
      console.warn(`    FIX-415 xsr seed failed: ${xsrErr.message}`);
    } else {
      const { data: refreshed, error: rpcErr } = await db.rpc(
        "refresh_primary_source_for_entities",
        { p_entity_type: "agency", p_entity_ids: fedRegSeeds.map((s) => s.id) },
      );
      if (rpcErr) {
        console.warn(`    FIX-415 primary_source refresh failed: ${rpcErr.message}`);
      } else {
        console.log(
          `    FIX-415 federal_register attribution: ${fedRegSeeds.length} agencies seeded, ${refreshed ?? 0} primary_source rows materialized`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAgencyEnrichmentPipeline(): Promise<PipelineResult> {
  const pass = process.argv.find(a => a.startsWith("--pass="))?.split("=")[1] ?? null;
  console.log("\n=== Agency enrichment pipeline ===");

  const logId = await startSync("agency_enrichment");
  const db = createAdminClient();
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    const { data: agencies, error } = await db
      .from("agencies")
      .select("id, name, acronym, short_name, agency_type, description, website_url, metadata, wikidata_id, founded_year, source_ids, primary_source")
      .eq("agency_type", "federal");
    if (error) throw new Error(error.message);

    const rows = (agencies ?? []) as AgencyRow[];
    console.log(`  Loaded ${rows.length} federal agencies`);

    if (!pass || pass === "1") await enrichSocialMedia(db, rows, result);
    if (!pass || pass === "2") await enrichFedRegAndWikidata(db, rows, result);

    await completeSync(logId, result);
    console.log(`\n  ✓ Done. Updated: ${result.updated}, failed: ${result.failed}`);
    return result;
  } catch (err) {
    await failSync(logId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

if (require.main === module) {
  runAgencyEnrichmentPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
