/**
 * FIX-1189 O2 — the nightly FEC-id divergence REPORT (design D1).
 *
 * Fetches `unitedstates/congress-legislators`' two legislator files, reads the
 * federal elected population and every row claiming one of its listed ids,
 * classifies each row with `classifyBinding()` (./legislator-ids) and stamps
 * ONE `data_sync_log` row: `pipeline = 'congress_legislator_ids_report'`,
 * `rows_inserted = 0`, the counts and top-20s in `metadata`. The receipts file
 * renders it (receipts-format.ts §10).
 *
 * READ-ONLY. No write to `officials`, and no flag that enables one — O1, the
 * writer, is a separate prompt gated on a week of these reports (design D2).
 * The one row this writes is its own `data_sync_log` stamp.
 *
 * NO SILENT ZERO. A fetch failure, a short file, a short population or a
 * partition that does not reconcile stamps `failed` with the reason — never an
 * empty `complete` (check:reads; rule 116). The freshness census (FIX-1011)
 * counts only `complete` rows, so a failing report goes stale rather than
 * reading as a clean night.
 *
 * `--dry-run` (rule 141): this script has NO write mode to dry-run. The flag
 * suppresses the one `data_sync_log` stamp and prints the metadata it would
 * have carried — which is how a prod dry run stays read-only.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:legislator-ids-report             # local, stamps
 *   pnpm --filter @civitics/data data:legislator-ids-report -- --dry-run
 */

import { createAdminClient, selectAllKeyset, afterKey } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";
import { ROSTER_FLOOR } from "./reconcile-former-members";
import {
  bindingRowFromSourceIds,
  buildClaimsMap,
  buildReport,
  parseLegislators,
  reconcileReport,
  type BindingRow,
  type LegislatorIdReport,
  type Listing,
  type PopulationRow,
} from "./legislator-ids";

type Db = ReturnType<typeof createAdminClient>;

export const REPORT_PIPELINE = "congress_legislator_ids_report";

/**
 * The same host `committees.ts` reads `committees-current.json` from — GitHub
 * Pages for the `unitedstates/congress-legislators` repo. Its weekly runs in
 * the nightly are the evidence the runner reaches it (`congress_committees`
 * `complete` every Sunday, last 2026-09-26 22:12 UTC).
 */
const FEED_BASE = "https://unitedstates.github.io/congress-legislators";
export const LEGISLATORS_CURRENT_URL = `${FEED_BASE}/legislators-current.json`;
export const LEGISLATORS_HISTORICAL_URL = `${FEED_BASE}/legislators-historical.json`;

/**
 * THE POPULATION — rule 45: a script's population filter is part of its
 * contract, so it is one exported constant that O1 reuses unchanged.
 *
 * `tier = 'elected'` plus the two federal chambers, identified by the
 * `(name, type)` pair `seedGoverningBodies()` creates them under and
 * `congress/officials.ts` assigns every member to (`governing_body_id =
 * senateId | houseId`). Not a `role_title` test: 'Senator' is also every
 * OpenStates upper-chamber member (1,512 rows on prod). And not a bioguide
 * test, which would make `no_bioguide` zero by construction.
 *
 * Measured 2026-09-28: 539 prod / 537 local. The role-title predicate with the
 * openstates/courtlistener exclusions gives the same 539 on prod.
 */
export const FEDERAL_ELECTED_POPULATION = {
  tier: "elected",
  chambers: [
    { name: "United States Senate", type: "legislature_upper" },
    { name: "United States House of Representatives", type: "legislature_lower" },
  ],
  sql:
    "tier = 'elected' AND governing_body_id IN (SELECT id FROM governing_bodies WHERE (name, type) IN " +
    "(('United States Senate','legislature_upper'),('United States House of Representatives','legislature_lower')))",
} as const;

/** Floor on the current file: the roster floor reconcile-former-members uses. */
const CURRENT_FLOOR = ROSTER_FLOOR;
/** The historical file is ~12k members; anything near zero is a bad fetch. */
const HISTORICAL_FLOOR = 10_000;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface Feed {
  listings: Listing[];
  ref: { url: string; etag: string | null; last_modified: string | null };
}

/** One fetch, one retry — a flake on the only external read should not cost the night. */
async function fetchFeed(url: string, floor: number): Promise<Feed> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      const listings = parseLegislators(await res.json());
      if (listings.length < floor) {
        throw new Error(`${url} parsed to ${listings.length} members, expected at least ${floor}`);
      }
      return {
        listings,
        ref: { url, etag: res.headers.get("etag"), last_modified: res.headers.get("last-modified") },
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** The two chamber ids, resolved by the population's `(name, type)` pairs. */
async function resolveChamberIds(db: Db): Promise<string[]> {
  const names = FEDERAL_ELECTED_POPULATION.chambers.map((c) => c.name);
  const { data, error } = await db.from("governing_bodies").select("id, name, type").in("name", names);
  if (error) throw new Error(`governing_bodies read: ${error.message}`);
  const ids = FEDERAL_ELECTED_POPULATION.chambers.map((c) => {
    const hits = ((data ?? []) as Array<{ id: string; name: string; type: string }>).filter(
      (r) => r.name === c.name && r.type === c.type,
    );
    if (hits.length !== 1) throw new Error(`expected one governing body for ${c.name}/${c.type}, found ${hits.length}`);
    return hits[0]!.id;
  });
  return ids;
}

/** The federal elected rows. Fail-loud, keyset-paged, floor-checked. */
export async function loadFederalElectedRows(db: Db): Promise<PopulationRow[]> {
  const chamberIds = await resolveChamberIds(db);
  const rows = await selectAllKeyset<{ id: string; full_name: string | null; source_ids: unknown }, string>(
    "legislator-ids population (federal elected)",
    (after, limit) =>
      afterKey(
        db
          .from("officials")
          .select("id, full_name, source_ids")
          .eq("tier", FEDERAL_ELECTED_POPULATION.tier)
          .in("governing_body_id", chamberIds)
          .order("id")
          .limit(limit),
        "id",
        after,
      ),
    { key: (r) => r.id, minRows: CURRENT_FLOOR },
  );
  return rows.map((r) => ({ ...bindingRowFromSourceIds(r.id, r.source_ids as Record<string, unknown> | null), name: r.full_name ?? "" }));
}

/**
 * Every row that could claim a listed id: its `fec_candidate_id` is one of
 * them, or it carries a `prior_fec_candidate_ids` array at all (7 rows on prod,
 * 2026-09-28 — cheaper to take whole than to filter a jsonb array over
 * PostgREST). `authoritativeClaims()` then decides, per row, what it claims.
 */
async function loadClaimantRows(db: Db, ids: string[]): Promise<BindingRow[]> {
  type Raw = { id: string; source_ids: unknown };
  const out = new Map<string, BindingRow>();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await selectAllKeyset<Raw, string>(
      `legislator-ids claimants (fec_candidate_id) @${i}`,
      (after, limit) =>
        afterKey(
          db.from("officials").select("id, source_ids").in("source_ids->>fec_candidate_id", chunk).order("id").limit(limit),
          "id",
          after,
        ),
      { key: (r) => r.id },
    );
    for (const r of rows) out.set(r.id, bindingRowFromSourceIds(r.id, r.source_ids as Record<string, unknown> | null));
  }
  const priorRows = await selectAllKeyset<Raw, string>(
    "legislator-ids claimants (prior_fec_candidate_ids)",
    (after, limit) =>
      afterKey(
        db.from("officials").select("id, source_ids").not("source_ids->prior_fec_candidate_ids", "is", null).order("id").limit(limit),
        "id",
        after,
      ),
    { key: (r) => r.id },
  );
  for (const r of priorRows) out.set(r.id, bindingRowFromSourceIds(r.id, r.source_ids as Record<string, unknown> | null));
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface LegislatorIdReportResult {
  status: "complete" | "failed";
  report?: LegislatorIdReport;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Everything the stamp carries, beyond the classifier's own report. */
export function stampMetadata(
  report: LegislatorIdReport,
  current: Feed,
  historical: Feed,
  claimantRows: number,
  readAt: Date,
): Record<string, unknown> {
  return {
    ...report,
    population_predicate: FEDERAL_ELECTED_POPULATION.sql,
    historical_members_count: historical.listings.length,
    historical_members_with_fec: historical.listings.filter((l) => l.fec.length > 0).length,
    claimant_rows_read: claimantRows,
    dataset_ref: { current: current.ref, historical: historical.ref },
    read_at: readAt.toISOString(),
  };
}

/**
 * The nightly step. Never throws: every failure is a `failed` stamp and a
 * `failed` result, so the caller records it and moves on.
 */
export async function runLegislatorIdReport(opts: { dryRun?: boolean; db?: Db } = {}): Promise<LegislatorIdReportResult> {
  console.info("\n=== FIX-1189 O2 — congress-legislators FEC id divergence report (read-only) ===");
  const logId = opts.dryRun ? "" : await startSync(REPORT_PIPELINE);
  try {
    const db = opts.db ?? createAdminClient();
    const readAt = new Date();
    const [current, historical] = await Promise.all([
      fetchFeed(LEGISLATORS_CURRENT_URL, CURRENT_FLOOR),
      fetchFeed(LEGISLATORS_HISTORICAL_URL, HISTORICAL_FLOOR),
    ]);
    console.info(
      `  dataset: ${current.listings.length} current (etag ${current.ref.etag ?? "?"}), ` +
        `${historical.listings.length} historical`,
    );

    const population = await loadFederalElectedRows(db);
    console.info(`  population: ${population.length} federal elected rows`);

    // Only ids listed for a population row's member can decide a class.
    const byBioguide = new Map(current.listings.map((l) => [l.bioguide, l]));
    const histByBioguide = new Map(historical.listings.map((l) => [l.bioguide, l]));
    const ids = new Set<string>();
    for (const r of population) {
      if (!r.bioguide) continue;
      for (const id of (byBioguide.get(r.bioguide) ?? histByBioguide.get(r.bioguide))?.fec ?? []) ids.add(id);
    }
    const claimantRows = await loadClaimantRows(db, [...ids].sort());
    const seen = new Set(population.map((r) => r.official_id));
    const claims = buildClaimsMap([...population, ...claimantRows.filter((r) => !seen.has(r.official_id))]);
    console.info(`  claims: ${ids.size} listed ids, ${claimantRows.length} claimant rows read`);

    const report = buildReport(population, current.listings, historical.listings, claims);
    const violations = reconcileReport(report, current.listings.length);
    if (violations.length > 0) throw new Error(`report does not reconcile (rule 116): ${violations.join("; ")}`);

    const metadata = stampMetadata(report, current, historical, claimantRows.length, readAt);
    for (const [k, v] of Object.entries(report.counts)) console.info(`    ${k.padEnd(22)} ${v}`);
    console.info(
      `  unmatched dataset members: ${report.unmatched_dataset_members.count}; ` +
        `dataset ambiguous current: ${report.dataset_ambiguous_current}; via historical: ${report.matched_via_historical}`,
    );

    if (opts.dryRun) {
      console.info("  --dry-run: no data_sync_log stamp written. Metadata it would carry:");
      console.info(JSON.stringify(metadata, null, 2));
    } else {
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0, metadata });
    }
    return { status: "complete", report, metadata };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  legislator-ids report failed: ${msg}`);
    await failSync(logId, msg);
    return { status: "failed", error: msg };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runLegislatorIdReport({ dryRun: process.argv.includes("--dry-run") })
    .then((r) => process.exit(r.status === "complete" ? 0 : 1))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
