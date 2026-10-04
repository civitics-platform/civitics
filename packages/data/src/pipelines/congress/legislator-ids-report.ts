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
 * REPORT-ONLY BY DEFAULT. Without `--apply` nothing writes `officials`; the
 * one row the report writes is its own `data_sync_log` stamp, exactly as O2
 * shipped.
 *
 * O1, THE WRITER (FIX-1189, cc-193; design D3). `--apply` turns the three
 * actionable classes into `officials.source_ids` writes (`planBindings()` in
 * ./legislator-ids): bind, promote, append prior ids. One UPDATE statement for
 * the whole plan, each row keyed by UUID with its CURRENT live id asserted in
 * the WHERE (the FIX-1195 restore shape) — a row another writer moved after
 * the read is refused and counted, never overwritten. The stamp is then
 * `congress_legislator_ids_bind`, carrying `acted {bound, promoted,
 * prior_appended, refused_changed}` and the plan. Idempotent: the rows it
 * writes read `noop` on the next run, which plans nothing. In the nightly it is
 * its own step at the end of the fec phase's daily block, behind
 * CIVITICS_LEGISLATOR_IDS_BIND=1 (`runLegislatorIdBindStep`).
 *
 * NO SILENT ZERO. A fetch failure, a short file, a short population or a
 * partition that does not reconcile stamps `failed` with the reason — never an
 * empty `complete` (check:reads; rule 116). The freshness census (FIX-1011)
 * counts only `complete` rows, so a failing report goes stale rather than
 * reading as a clean night.
 *
 * `--dry-run` (rule 141): plan-only. Suppresses every write — the stamp and,
 * with `--apply`, the UPDATE — and prints the metadata it would have carried
 * plus O1's plan. That is how a prod dry run stays read-only.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:legislator-ids-report                      # local, stamps the report
 *   pnpm --filter @civitics/data data:legislator-ids-report -- --dry-run         # plan-only, writes nothing
 *   pnpm --filter @civitics/data data:legislator-ids-report -- --apply           # O1: writes, stamps the bind row
 *   pnpm --filter @civitics/data data:legislator-ids-report -- --apply --dry-run # O1's plan, writes nothing
 * `--apply` against prod also needs `--allow-prod`; report-only mode does not.
 */

import { createAdminClient, selectAllKeyset, afterKey } from "@civitics/db";
import { buildDbUrl } from "../../lib/heavy-rebuild";
import { startSync, completeSync, failSync, skipSync } from "../sync-log";
import { ROSTER_FLOOR } from "./reconcile-former-members";
import {
  bindingRowFromSourceIds,
  buildClaimsMap,
  buildReport,
  parseLegislators,
  planBindings,
  reconcileReport,
  type BindingRow,
  type BindingWrite,
  type BindingWriteKind,
  type LegislatorIdReport,
  type Listing,
  type PopulationRow,
} from "./legislator-ids";

type Db = ReturnType<typeof createAdminClient>;

export const REPORT_PIPELINE = "congress_legislator_ids_report";

/** FIX-1189 O1 — the writer's own stamp; receipts §10 reads its `acted`. */
export const BIND_PIPELINE = "congress_legislator_ids_bind";

/**
 * FIX-1189 O1 — the nightly's switch for the writer, from the workflow env.
 * Unset until cc-194's supervised dry run; the Tuesday 2026-10-06 nightly is
 * the first write.
 */
export const LEGISLATOR_IDS_BIND_ENV = "CIVITICS_LEGISLATOR_IDS_BIND";

export function isLegislatorIdsBindEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LEGISLATOR_IDS_BIND_ENV] === "1";
}

/**
 * The bound on O1's one UPDATE, SET as its own statement before it (FIX-1128:
 * a routine-level timeout bounds nothing). The plan is ~31 PK-keyed rows on
 * prod today; 30 s is three orders of magnitude of headroom and still ends a
 * statement stuck behind a lock long before the fec phase notices.
 */
export const BIND_STATEMENT_TIMEOUT = "30s";

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

export interface Feed {
  listings: Listing[];
  ref: { url: string; etag: string | null; last_modified: string | null };
}

/**
 * One fetch, one retry — a flake on the only external read should not cost the
 * night. Exported for the promotion's dataset key (FIX-1189), which fetches the
 * current file once more in the congress phase.
 */
export async function fetchFeed(url: string, floor: number): Promise<Feed> {
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
  /** O1's plan — computed on every run, written only with `apply`. */
  plans?: BindingWrite[];
  /** O1's outcome — only when the plan was applied. */
  acted?: BindActed;
  error?: string;
}

// ---------------------------------------------------------------------------
// O1 — the write
// ---------------------------------------------------------------------------

export interface BindActed {
  bound: number;
  promoted: number;
  prior_appended: number;
  /** Planned, but the row's live id had changed since the read — not written. */
  refused_changed: number;
}

/** `kind` → the `acted` key it counts under. */
const ACTED_KEY: Record<BindingWriteKind, keyof Omit<BindActed, "refused_changed">> = {
  bind: "bound",
  promote: "promoted",
  prior_append: "prior_appended",
};

/**
 * The whole plan as ONE statement. `||` merge on the live row (the FIX-1187
 * shape-B / persistNewFecIds shape) so a concurrent writer's other keys
 * survive, the SET reads `o.source_ids` so a row re-checked under READ
 * COMMITTED is rebuilt from its new version, and the prior array is
 * append-if-absent: existing order kept, the new live id dropped from it.
 * Not `jsonb_set`, which returns NULL — wiping `source_ids` — when handed a
 * NULL value.
 */
export const BIND_SQL = `
WITH plan AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(official_id uuid, expect_live text, set_live text, add_prior jsonb)
)
UPDATE officials o
   SET source_ids =
         COALESCE(o.source_ids, '{}'::jsonb)
         || CASE WHEN p.set_live IS NOT NULL
                 THEN jsonb_build_object('fec_candidate_id', p.set_live)
                 ELSE '{}'::jsonb END
         || CASE WHEN jsonb_array_length(p.add_prior) > 0
                 THEN jsonb_build_object('prior_fec_candidate_ids', (
                   SELECT COALESCE(jsonb_agg(s.v ORDER BY s.ord), '[]'::jsonb)
                     FROM (
                       SELECT e.v, e.ord
                         FROM jsonb_array_elements_text(
                                CASE WHEN jsonb_typeof(o.source_ids->'prior_fec_candidate_ids') = 'array'
                                     THEN o.source_ids->'prior_fec_candidate_ids' ELSE '[]'::jsonb END
                              ) WITH ORDINALITY AS e(v, ord)
                        WHERE e.v IS DISTINCT FROM p.set_live
                       UNION ALL
                       SELECT a.v, 1000000 + a.ord
                         FROM jsonb_array_elements_text(p.add_prior) WITH ORDINALITY AS a(v, ord)
                        WHERE a.v IS DISTINCT FROM p.set_live
                          AND NOT (CASE WHEN jsonb_typeof(o.source_ids->'prior_fec_candidate_ids') = 'array'
                                        THEN o.source_ids->'prior_fec_candidate_ids' ? a.v ELSE false END)
                     ) s))
                 ELSE '{}'::jsonb END,
       updated_at = now()
  FROM plan p
 WHERE o.id = p.official_id
   AND o.source_ids->>'fec_candidate_id' IS NOT DISTINCT FROM p.expect_live
RETURNING o.id::text AS id`;

/** Apply the plan; returns the ids actually written. */
async function applyBindings(plans: BindingWrite[]): Promise<Set<string>> {
  if (plans.length === 0) return new Set();
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    await client.query(`SET statement_timeout = '${BIND_STATEMENT_TIMEOUT}'`);
    const res = await client.query<{ id: string }>(BIND_SQL, [JSON.stringify(plans)]);
    return new Set(res.rows.map((r) => r.id));
  } finally {
    await client.end();
  }
}

/** Fold the per-row outcome into the stamp's `acted` counts. */
export function actedFrom(plans: BindingWrite[], written: Set<string>): BindActed {
  const acted: BindActed = { bound: 0, promoted: 0, prior_appended: 0, refused_changed: 0 };
  for (const p of plans) {
    if (written.has(p.official_id)) acted[ACTED_KEY[p.kind]]++;
    else acted.refused_changed++;
  }
  return acted;
}

/** One line per planned write, for the log and the dry run. */
function planLines(plans: BindingWrite[], names: Map<string, string>): string[] {
  const byKind = { bind: 0, promote: 0, prior_append: 0 };
  for (const p of plans) byKind[p.kind]++;
  return [
    `  O1 plan: ${plans.length} write(s) — bind ${byKind.bind}, promote ${byKind.promote}, prior_append ${byKind.prior_append}`,
    ...plans.map(
      (p) =>
        `    ${p.kind.padEnd(12)} ${(names.get(p.official_id) ?? "?").padEnd(30)} ${p.official_id}  ` +
        `live ${p.expect_live ?? "(none)"}${p.set_live ? ` → ${p.set_live}` : ""}` +
        (p.add_prior.length > 0 ? `  prior += ${p.add_prior.join(", ")}` : ""),
    ),
  ];
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
export async function runLegislatorIdReport(
  opts: { dryRun?: boolean; apply?: boolean; db?: Db } = {},
): Promise<LegislatorIdReportResult> {
  const apply = opts.apply === true;
  console.info(
    apply
      ? `\n=== FIX-1189 O1 — congress-legislators FEC id writer${opts.dryRun ? " (DRY RUN — plan only, writes nothing)" : ""} ===`
      : "\n=== FIX-1189 O2 — congress-legislators FEC id divergence report (read-only) ===",
  );
  const logId = opts.dryRun ? "" : await startSync(apply ? BIND_PIPELINE : REPORT_PIPELINE);
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

    // O1's plan, from the same reading the report classified. Printed for the
    // writer and for any dry run; the nightly report's own output is unchanged.
    const plans = planBindings(population, current.listings, claims);
    const names = new Map(population.map((r) => [r.official_id, r.name]));
    if (apply || opts.dryRun) for (const line of planLines(plans, names)) console.info(line);

    let acted: BindActed | undefined;
    if (apply) {
      if (opts.dryRun) {
        console.info("  --apply --dry-run: the plan above was NOT written (rule 141).");
      } else {
        const written = await applyBindings(plans);
        acted = actedFrom(plans, written);
        console.info(
          `  O1 acted: bound ${acted.bound}, promoted ${acted.promoted}, prior_appended ${acted.prior_appended}, ` +
            `refused_changed ${acted.refused_changed} (statement_timeout ${BIND_STATEMENT_TIMEOUT})`,
        );
        metadata["acted"] = acted;
        metadata["plan"] = plans.map((p) => ({
          ...p,
          name: names.get(p.official_id) ?? null,
          outcome: written.has(p.official_id) ? "written" : "refused_changed",
        }));
        metadata["bind_statement_timeout"] = BIND_STATEMENT_TIMEOUT;
      }
    }

    if (opts.dryRun) {
      console.info("  --dry-run: no data_sync_log stamp written. Metadata it would carry:");
      console.info(JSON.stringify(metadata, null, 2));
    } else {
      await completeSync(logId, {
        inserted: 0,
        updated: acted ? acted.bound + acted.promoted + acted.prior_appended : 0,
        failed: 0,
        estimatedMb: 0,
        metadata,
      });
    }
    return { status: "complete", report, metadata, plans, ...(acted ? { acted } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  legislator-ids report failed: ${msg}`);
    await failSync(logId, msg);
    return { status: "failed", error: msg };
  }
}

// ---------------------------------------------------------------------------
// The nightly step — O1 (FIX-1189)
// ---------------------------------------------------------------------------

export interface BindStepResult {
  status: "complete" | "failed" | "skipped";
  acted?: BindActed;
  /** Why it did not run, or why it failed. */
  reason?: string;
}

/**
 * The fec phase's `congress_legislator_ids_bind` step. Never throws.
 *
 *   flag unset  → logs `disabled`, writes NOTHING (no officials write, no stamp)
 *   held        → a `skipped` stamp whose skip_reason is the FIX-950
 *                 'prod session held: …' spelling, exactly like the fec chain
 *   otherwise   → `runLegislatorIdReport({ apply: true })`
 */
export async function runLegislatorIdBindStep(opts: {
  /** `writersRun(runFec, hold)` — false under a supervised prod session. */
  writersRun: boolean;
  /** `prodSessionHoldReason(...)`, used only when held. */
  holdReason: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BindStepResult> {
  if (!isLegislatorIdsBindEnabled(opts.env)) {
    console.info(`  [legislator-ids-bind] disabled — ${LEGISLATOR_IDS_BIND_ENV} unset; nothing read, nothing written`);
    return { status: "skipped", reason: `disabled — ${LEGISLATOR_IDS_BIND_ENV} unset` };
  }
  if (!opts.writersRun) {
    console.warn(`  [legislator-ids-bind] ⏸  ${opts.holdReason}`);
    const logId = await startSync(BIND_PIPELINE);
    await skipSync(logId, opts.holdReason);
    return { status: "skipped", reason: opts.holdReason };
  }
  const r = await runLegislatorIdReport({ apply: true });
  return r.status === "complete"
    ? { status: "complete", ...(r.acted ? { acted: r.acted } : {}) }
    : { status: "failed", reason: r.error };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv;
  // Report-only mode is unchanged (it never needed the flag); the writer does.
  const prod = /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
  if (prod && argv.includes("--apply") && !argv.includes("--allow-prod")) {
    console.error("✗ --apply against PROD needs --allow-prod. Refusing to write prod by accident.");
    process.exit(1);
  }
  runLegislatorIdReport({ dryRun: argv.includes("--dry-run"), apply: argv.includes("--apply") })
    .then((r) => process.exit(r.status === "complete" ? 0 : 1))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
