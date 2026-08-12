/**
 * Master pipeline orchestrator.
 *
 * Runs all Phase 1 ingestion pipelines in sequence within the 270 MB
 * storage budget. After each pipeline logs inserted rows, estimated MB,
 * and any errors. Produces a final storage report.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:sync
 */

import { createAdminClient } from "@civitics/db";
import { getDbSizeMb, getLastSync, captureRssMb, githubRunIdentity } from "./sync-log";
import { runRegulationsPipeline } from "./regulations";
import { runFecBulkPipeline } from "./fec-bulk";
import {
  loadRunState as loadFecRunState,
  describeRunState as describeFecRunState,
  type FecBulkRunState,
} from "./fec-bulk/run-state";
import { currentFecCycle, resolveProbeCycle, indivDropPending } from "./fec-bulk/drop-check";
// FIX-904: runIrs990Pipeline is no longer imported here — IRS-990 runs from its
// own weekly workflow (.github/workflows/irs990.yml). See the note at its old
// call site in the Sunday block.
import { runLittleSisPipeline } from "./littlesis";
import { runEdgarPipeline, runEdgarDailyPipeline } from "./edgar";
import { runUsaSpendingBulkPipeline } from "./usaspending-bulk";
import { runCourtListenerPipeline } from "./courtlistener";
import { runOpenStatesPipeline } from "./openstates";
import { runBulkPeoplePipeline } from "./openstates-bulk/people";
import { runOfficialsPipeline, runVotesPipeline, runCommitteesPipeline } from "./congress";
import { runExecutiveSeed } from "./executive/seed";
import { runRuleBasedTagger } from "./tags/rules";
import { runAiTagger } from "./tags/ai-tagger";
import { runAiSummariesPipeline } from "./ai-summaries";
import { scoreComments } from "../scripts/score-comments";
import { runAgenciesHierarchyPipeline } from "./agencies-hierarchy";
import { runAgencyLeadershipPipeline } from "./agency-leadership";
import { runAgencyEnrichmentPipeline } from "./agency-enrichment";
import { runOpmFtePipeline } from "./opm-fte";
import { runPlumBookPipeline } from "./plum-book";
import { runElectionsPipeline } from "./elections";
import { runAiClassifier } from "./tags/ai-classifier";
import { seedJurisdictions, seedGoverningBodies } from "../jurisdictions/us-states";
import { computeRunWeekly } from "./weekly-gate";
import { FLAGS } from "../feature-flags";
import {
  shouldLoadResumeState,
  shouldProbeDrop,
  shouldRunFecBulk,
  fecBulkHeldThisPhase,
  FEC_HOLD_REASON,
  type FecBulkTriggerInputs,
} from "./fec-hold";

// errMsg moved to ./utils (FIX-756) so fec-bulk's catch sites can share it
// without importing this module (which imports fec-bulk — cycle).
import { errMsg } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_BUDGET_MB = 270;

// ---------------------------------------------------------------------------
// Status reporter
// ---------------------------------------------------------------------------

async function printStatus(): Promise<void> {
  const db = createAdminClient();

  const [officials, proposals, votes, financials, spending] = await Promise.all([
    db.from("officials").select("*", { count: "exact", head: true }),
    db.from("proposals").select("*", { count: "exact", head: true }),
    db.from("votes").select("*", { count: "exact", head: true }),
    db.from("financial_relationships")
      .select("*", { count: "exact", head: true })
      .not("relationship_type", "in", "(contract,grant)"),
    db.from("financial_relationships")
      .select("*", { count: "exact", head: true })
      .in("relationship_type", ["contract", "grant"]),
  ]);

  const pipelines = ["regulations", "fec_bulk", "irs990", "usaspending", "courtlistener", "openstates", "congress_officials", "congress_votes"] as const;
  const syncTimes = await Promise.all(pipelines.map((p) => getLastSync(p)));

  console.log("\n=== Civitics Data Status ===");
  console.log(`  Officials:              ${(officials.count ?? 0).toLocaleString()}`);
  console.log(`  Proposals:              ${(proposals.count ?? 0).toLocaleString()}`);
  console.log(`  Votes:                  ${(votes.count ?? 0).toLocaleString()}`);
  console.log(`  Financial relationships: ${(financials.count ?? 0).toLocaleString()} (donations, gifts, etc.)`);
  console.log(`  Spending records:       ${(spending.count ?? 0).toLocaleString()} (contracts + grants)`);

  console.log("\n  Last sync times:");
  for (let i = 0; i < pipelines.length; i++) {
    const last = syncTimes[i];
    const ts = last ? new Date(last).toLocaleString() : "never";
    console.log(`    ${pipelines[i].padEnd(16)} ${ts}`);
  }

  const dbMb = await getDbSizeMb();
  console.log(`\n  DB size: ${dbMb} MB / ${STORAGE_BUDGET_MB} MB budget (${Math.round((dbMb / STORAGE_BUDGET_MB) * 100)}% used)`);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runAllPipelines(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   Civitics Phase 1 Pipeline Orchestrator  ║");
  console.log("╚══════════════════════════════════════════╝");

  const startTime = Date.now();
  const db = createAdminClient();

  // Seed jurisdictions and governing bodies first (idempotent)
  console.log("\n[0/5] Seeding jurisdictions and governing bodies...");
  const { federalId, stateIds } = await seedJurisdictions(db);
  const { senateId: senateGovBodyId, houseId: houseGovBodyId } = await seedGoverningBodies(db, federalId);

  const initialMb = await getDbSizeMb();
  console.log(`      Starting DB size: ${initialMb} MB`);

  const results: Array<{
    name: string;
    inserted: number;
    updated: number;
    failed: number;
    estimatedMb: number;
    error?: string;
  }> = [];

  // -------------------------------------------------------------------------
  // 1. Regulations.gov
  // -------------------------------------------------------------------------
  {
    const apiKey = process.env["REGULATIONS_API_KEY"];
    if (!apiKey) {
      console.warn("\n[1/5] Regulations.gov — SKIPPED (REGULATIONS_API_KEY not set)");
      results.push({ name: "regulations", inserted: 0, updated: 0, failed: 0, estimatedMb: 0, error: "API key missing" });
    } else {
      try {
        const r = await runRegulationsPipeline(apiKey, federalId);
        results.push({ name: "regulations", ...r });
      } catch (err) {
        const msg = errMsg(err);
        console.error("\n  Regulations pipeline threw:", msg);
        results.push({ name: "regulations", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. FEC bulk (weball24 + cm24 + pas224 streaming — no API key needed)
  // -------------------------------------------------------------------------
  {
    try {
      const r = await runFecBulkPipeline();
      results.push({ name: "fec_bulk", ...r });
    } catch (err) {
      const msg = errMsg(err);
      console.error("\n  FEC bulk pipeline threw:", msg);
      results.push({ name: "fec_bulk", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
    }
  }

  // -------------------------------------------------------------------------
  // 2b. Congress.gov (officials + votes)
  // -------------------------------------------------------------------------
  {
    const apiKey = process.env["CONGRESS_API_KEY"];
    if (!apiKey) {
      console.warn("\n[2b] Congress.gov — SKIPPED (CONGRESS_API_KEY not set)");
      results.push({ name: "congress_officials", inserted: 0, updated: 0, failed: 0, estimatedMb: 0, error: "API key missing" });
      results.push({ name: "congress_votes", inserted: 0, updated: 0, failed: 0, estimatedMb: 0, error: "API key missing" });
    } else {
      try {
        const r = await runOfficialsPipeline({ apiKey, stateIds, senateId: senateGovBodyId, houseId: houseGovBodyId, federalId });
        results.push({ name: "congress_officials", inserted: r.inserted, updated: r.updated, failed: r.skipped, estimatedMb: 0 });
      } catch (err) {
        const msg = errMsg(err);
        console.error("\n  Congress officials pipeline threw:", msg);
        results.push({ name: "congress_officials", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
      }

      try {
        const r = await runVotesPipeline({ apiKey, federalId, senateGovBodyId, houseGovBodyId });
        results.push({ name: "congress_votes", inserted: r.votesInserted, updated: r.proposalsUpserted, failed: 0, estimatedMb: 0 });
      } catch (err) {
        const msg = errMsg(err);
        console.error("\n  Congress votes pipeline threw:", msg);
        results.push({ name: "congress_votes", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. USASpending bulk (contracts then assistance — sequential: each is 300MB–1GB)
  // -------------------------------------------------------------------------
  {
    try {
      const contracts  = await runUsaSpendingBulkPipeline({ category: "contracts" });
      const assistance = await runUsaSpendingBulkPipeline({ category: "assistance" });
      results.push({ name: "usaspending", inserted: contracts.inserted + assistance.inserted, updated: 0, failed: contracts.failed + assistance.failed, estimatedMb: 0 });
    } catch (err) {
      const msg = errMsg(err);
      console.error("\n  USASpending pipeline threw:", msg);
      results.push({ name: "usaspending", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
    }
  }

  // -------------------------------------------------------------------------
  // 4. CourtListener
  // -------------------------------------------------------------------------
  {
    const apiKey = process.env["COURTLISTENER_API_KEY"];
    if (!apiKey) {
      console.warn("\n[4/5] CourtListener — SKIPPED (COURTLISTENER_API_KEY not set)");
      results.push({ name: "courtlistener", inserted: 0, updated: 0, failed: 0, estimatedMb: 0, error: "API key missing" });
    } else {
      try {
        const r = await runCourtListenerPipeline(apiKey, federalId);
        results.push({ name: "courtlistener", ...r });
      } catch (err) {
        const msg = errMsg(err);
        console.error("\n  CourtListener pipeline threw:", msg);
        results.push({ name: "courtlistener", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. OpenStates — bulk people (no quota), then API for bills + term dates
  // -------------------------------------------------------------------------
  {
    try {
      const r = await runBulkPeoplePipeline(stateIds);
      results.push({ name: "openstates_bulk", ...r });
    } catch (err) {
      const msg = errMsg(err);
      console.error("\n  OpenStates bulk people pipeline threw:", msg);
      results.push({ name: "openstates_bulk", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
    }

    const apiKey = process.env["OPENSTATES_API_KEY"];
    if (!apiKey) {
      console.warn("\n  OpenStates API — SKIPPED (OPENSTATES_API_KEY not set)");
      results.push({ name: "openstates_api", inserted: 0, updated: 0, failed: 0, estimatedMb: 0, error: "API key missing" });
    } else {
      try {
        const r = await runOpenStatesPipeline(apiKey, stateIds);
        results.push({ name: "openstates_api", ...r });
      } catch (err) {
        const msg = errMsg(err);
        console.error("\n  OpenStates API pipeline threw:", msg);
        results.push({ name: "openstates_api", inserted: 0, updated: 0, failed: 1, estimatedMb: 0, error: msg });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Final report
  // -------------------------------------------------------------------------
  const finalMb = await getDbSizeMb();
  const elapsedMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║              Pipeline Report              ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`${"Pipeline".padEnd(16)} ${"Inserted".padStart(9)} ${"Updated".padStart(9)} ${"Failed".padStart(7)} ${"~MB".padStart(7)}`);
  console.log("─".repeat(52));

  let totalInserted = 0, totalUpdated = 0, totalFailed = 0, totalEstMb = 0;
  for (const r of results) {
    const flag = r.error ? " ⚠" : "";
    console.log(
      `${r.name.padEnd(16)} ${String(r.inserted).padStart(9)} ${String(r.updated).padStart(9)} ${String(r.failed).padStart(7)} ${r.estimatedMb.toFixed(1).padStart(7)}${flag}`
    );
    totalInserted += r.inserted;
    totalUpdated  += r.updated;
    totalFailed   += r.failed;
    totalEstMb    += r.estimatedMb;
  }

  console.log("─".repeat(52));
  console.log(
    `${"TOTAL".padEnd(16)} ${String(totalInserted).padStart(9)} ${String(totalUpdated).padStart(9)} ${String(totalFailed).padStart(7)} ${totalEstMb.toFixed(1).padStart(7)}`
  );

  const remaining = STORAGE_BUDGET_MB - finalMb;
  const pct = Math.round((finalMb / STORAGE_BUDGET_MB) * 100);

  console.log(`\n  DB size:  ${finalMb} MB → was ${initialMb} MB (+${(finalMb - initialMb).toFixed(1)} MB)`);
  console.log(`  Budget:   ${finalMb} / ${STORAGE_BUDGET_MB} MB (${pct}% used, ${remaining.toFixed(1)} MB remaining)`);
  console.log(`  Elapsed:  ${elapsedMin} minutes`);

  const failedPipelines = results.filter((r) => r.error);
  if (failedPipelines.length > 0) {
    console.log(`\n  ⚠ Failed/skipped: ${failedPipelines.map((r) => r.name).join(", ")}`);
  } else {
    console.log("\n  ✓ All pipelines completed successfully");
  }
}

// ---------------------------------------------------------------------------
// Nightly sync results type
// ---------------------------------------------------------------------------

export interface NightlyPipelineResult {
  status: "complete" | "failed" | "skipped" | "not_scheduled";
  rows_added?: number;
  duration_ms?: number;
  error?: string;
}

export interface NightlyAiResult {
  status: "complete" | "failed" | "skipped";
  entities?: number;
  cost_usd?: number;
  skip_reason?: string;
}

export interface NightlySyncResults {
  started_at: Date;
  completed_at?: Date;
  duration_ms?: number;
  is_weekly: boolean;
  pipelines: {
    regulations?: NightlyPipelineResult;
    congress_officials?: NightlyPipelineResult;
    congress_votes?: NightlyPipelineResult;
    fec_bulk?: NightlyPipelineResult;
    /** FIX-904: never populated by the nightly any more — IRS-990 runs from
     *  .github/workflows/irs990.yml and self-logs to data_sync_log. Kept so a
     *  historical nightly summary still type-checks. */
    irs990?: NightlyPipelineResult;
    littlesis?: NightlyPipelineResult;
    usaspending?: NightlyPipelineResult;
    courtlistener?: NightlyPipelineResult;
    openstates?: NightlyPipelineResult;
    openstates_bulk_people?: NightlyPipelineResult;
    edgar?: NightlyPipelineResult;
    edgar_daily?: NightlyPipelineResult;
    agencies_hierarchy?: NightlyPipelineResult;
    opm_fte?: NightlyPipelineResult;
    plum_book?: NightlyPipelineResult;
    elections?: NightlyPipelineResult;
    congress_committees?: NightlyPipelineResult;
    agency_leadership?: NightlyPipelineResult;
    agency_enrichment?: NightlyPipelineResult;
    entity_connections_rebuild?: NightlyPipelineResult;
  };
  ai: {
    tag_rules?: NightlyAiResult;
    tag_ai?: NightlyAiResult;
    tag_industry?: NightlyAiResult;
    ai_summaries?: NightlyAiResult;
  };
  total_ai_cost_usd: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Nightly sync — used by Vercel cron and standalone scheduler
// ---------------------------------------------------------------------------

// FIX-292: nightly is split across GHA jobs. Phase 1 ('fec') runs
// regulations → IRS 990 inside its own budget; Phase 2 ('enrichment') runs the
// enrichment ingest + derived-refresh tail under its own budget after Phase 1.
// 'all' preserves the pre-split behavior for manual / ad-hoc invocations and
// for the Vercel cron canary path.
//
// FIX-740: the enrichment phase itself is now split into sub-budgets after it
// hit its 120-min cutoff on cumulative ingest overrun (2026-07-05). LittleSis
// (~35 min) is the 'enrichment-heavy' sub-job; the weekly ingests (EDGAR +
// CourtListener + OpenStates + agencies/OPM/PLUM/elections/committees/agency-*
// + tag-industry) are 'enrichment-light'. USASpending's 2 GB first-run was
// PULLED OUT of the phase entirely into its own workflow_dispatch (see
// runUsaSpendingBulk + usaspending-bulk.yml; checkpoint/resume is the deferred
// FIX-739).
//
// FIX-746: the daily derivation tail (comment bridge scorer, rule + AI taggers,
// AI summaries, the two deferred MV refreshes) is now its own 'enrichment-tail'
// sub-job. FIX-743's forced-weekly run proved 'enrichment-light' was squeezed
// past its budget on Sunday by the weekly ingest block + this tail stacked
// together (SIGTERM'd mid-tag_rules → ai_summaries + the two MV refreshes never
// ran). The tail reads DB state written by the (prior job's) light phase, so it
// runs cleanly on its own budget. Plain 'enrichment' still runs all three
// sub-phases so 'all' and the canary path are unchanged.
export type NightlyPhase =
  | "fec"
  | "enrichment"
  | "enrichment-heavy"
  | "enrichment-light"
  | "enrichment-tail"
  | "all";

export interface RunNightlyOptions {
  phase?: NightlyPhase;
}

export async function runNightlySync(opts: RunNightlyOptions = {}): Promise<NightlySyncResults> {
  const phase: NightlyPhase = opts.phase ?? "all";
  const runFec = phase === "fec" || phase === "all";
  // FIX-740/746: 'enrichment' (unsplit) and 'all' run ALL sub-phases; the split
  // GHA jobs pass 'enrichment-heavy' / 'enrichment-light' / 'enrichment-tail' to
  // run exactly one.
  const runEnrichmentHeavy =
    phase === "enrichment" || phase === "enrichment-heavy" || phase === "all";
  const runEnrichmentLight =
    phase === "enrichment" || phase === "enrichment-light" || phase === "all";
  const runEnrichmentTail =
    phase === "enrichment" || phase === "enrichment-tail" || phase === "all";

  const startedAt = new Date();
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║          Nightly Sync Starting            ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Started: ${startedAt.toISOString()}  phase=${phase}`);

  // FIX-743: `runWeekly = isSunday || NIGHTLY_FORCE_WEEKLY==="true"`. Named
  // isWeekly downstream (results.is_weekly, the `if (isWeekly)` heavy block, the
  // merge logic) so a forced run correctly reports/executes the weekly stages.
  const { runWeekly: isWeekly, mode: weeklyMode } = computeRunWeekly(
    new Date(),
    process.env["NIGHTLY_FORCE_WEEKLY"],
  );
  console.log(
    `  [nightly] weekly stages: ${
      weeklyMode === "forced"
        ? "FORCED (NIGHTLY_FORCE_WEEKLY=true)"
        : weeklyMode === "sunday"
          ? "Sunday"
          : "skipped (weekday)"
    }`,
  );

  const results: NightlySyncResults = {
    started_at: startedAt,
    is_weekly: isWeekly,
    pipelines: {},
    ai: {},
    total_ai_cost_usd: 0,
    errors: [],
  };

  // Seed jurisdictions (idempotent)
  const db = createAdminClient();

  // FIX-255: reap any data_sync_log rows stranded in status='running' by a
  // prior uncatchable abort (V8 OOM, SIGKILL, hard crash). Belt-and-braces
  // alongside the in-process signal handler in sync-log.ts. Non-fatal.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: reaped, error } = await (db as any).rpc("reap_stale_sync_log", { stale_minutes: 60 });
    if (error) throw error;
    if (Array.isArray(reaped) && reaped.length > 0) {
      console.log(`[nightly] reap_stale_sync_log — reaped ${reaped.length} orphan row(s):`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of reaped as any[]) console.log(`  ${r.pipeline} (${r.id})`);
    }
  } catch (err) {
    console.warn("[nightly] reap_stale_sync_log failed (continuing):", errMsg(err));
  }

  // FIX-462: write a phase-tagged `running` start-row so a workflow-timeout
  // SIGTERM (every Sunday on fec-phase) registers as `killed`, not `missing`.
  // Pre-FIX-462 runNightlySync only ever wrote a terminal row, so a kill left
  // ZERO data_sync_log rows → mark-killed found no orphan → the canary
  // classified the date `missing`. This row is UPDATEd in place at the terminal
  // write below (one row per phase per night, not two). metadata.phase scopes
  // mark-killed so a fec-phase kill is still detected after the now-decoupled
  // enrichment-phase writes its own terminal row for the same date.
  //
  // FIX-971a: this row does NOT go through startSync(), so the run-identity
  // capture added there does not reach it — and `nightly_cron` is precisely
  // the pipeline mark-killed's phase-scoped guard operates on. Stamp it here
  // too, and again on the terminal write below (which REPLACES metadata
  // wholesale and would otherwise drop it).
  let runningRowId = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: runRow, error } = await (db as any)
      .from("data_sync_log")
      .insert({
        pipeline:   "nightly_cron",
        status:     "running",
        started_at: startedAt.toISOString(),
        metadata:   { phase, ...githubRunIdentity() },
      })
      .select("id")
      .single();
    if (error) throw error;
    runningRowId = (runRow?.id as string) ?? "";
  } catch (err) {
    console.warn("[nightly] could not write running start-row (continuing):", errMsg(err));
  }

  const { federalId, stateIds } = await seedJurisdictions(db);
  const { senateId: senateGovBodyId, houseId: houseGovBodyId } = await seedGoverningBodies(db, federalId);

  // FIX-292: Phase 1 ('fec') — daily ingest + weekly FEC bulk + IRS 990.
  if (runFec) {

  // 1. Daily data pipelines — Regulations.gov
  {
    const t0 = Date.now();
    const apiKey = process.env["REGULATIONS_API_KEY"];
    if (apiKey) {
      try {
        const r = await runRegulationsPipeline(apiKey, federalId);
        results.pipelines.regulations = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] regulations failed:", msg);
        results.pipelines.regulations = { status: "failed", error: msg };
        results.errors.push(`Regulations: ${msg}`);
      }
    } else {
      results.pipelines.regulations = { status: "skipped", error: "REGULATIONS_API_KEY not set" };
    }
  }

  // 1a-exec. Daily — executive-branch seed (FIX-321). Two hardcoded rows
  // (sitting POTUS + VPOTUS) so the FIX-318 audit checks flip from error→info.
  // Idempotent on source_ids->>'official_seed_id'; runs in ~50ms.
  {
    const t0 = Date.now();
    try {
      const r = await runExecutiveSeed({ db });
      console.log(`[nightly] executive seed — complete in ${Date.now() - t0}ms (inserted=${r.inserted} updated=${r.updated})`);
    } catch (err) {
      const msg = errMsg(err);
      console.error("[nightly] executive seed failed (non-fatal):", msg);
      results.errors.push(`Executive seed: ${msg}`);
    }
  }

  // 1b. Daily data pipelines — Congress.gov (officials + votes)
  // Votes pipeline has a per-roll skip-if-exists guard, so re-running daily is cheap.
  {
    const congressKey = process.env["CONGRESS_API_KEY"];
    if (congressKey) {
      const t0 = Date.now();
      try {
        const r = await runOfficialsPipeline({ apiKey: congressKey, stateIds, senateId: senateGovBodyId, houseId: houseGovBodyId, federalId });
        results.pipelines.congress_officials = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] congress officials failed:", msg);
        results.pipelines.congress_officials = { status: "failed", error: msg };
        results.errors.push(`Congress officials: ${msg}`);
      }

      const t1 = Date.now();
      try {
        const r = await runVotesPipeline({ apiKey: congressKey, federalId, senateGovBodyId, houseGovBodyId });
        results.pipelines.congress_votes = { status: "complete", rows_added: r.votesInserted, duration_ms: Date.now() - t1 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] congress votes failed:", msg);
        results.pipelines.congress_votes = { status: "failed", error: msg };
        results.errors.push(`Congress votes: ${msg}`);
      }
    } else {
      results.pipelines.congress_officials = { status: "skipped", error: "CONGRESS_API_KEY not set" };
      results.pipelines.congress_votes = { status: "skipped", error: "CONGRESS_API_KEY not set" };
    }
  }

  // 1c. Daily — OpenStates bulk people (no API quota; refreshes basic legislator
  //     fields). Term dates + bills are still pulled by the weekly API run below.
  {
    const t0 = Date.now();
    try {
      const r = await runBulkPeoplePipeline(stateIds);
      results.pipelines.openstates_bulk_people = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
    } catch (err) {
      const msg = errMsg(err);
      console.error("[nightly] openstates bulk people failed:", msg);
      results.pipelines.openstates_bulk_people = { status: "failed", error: msg };
      results.errors.push(`OpenStates bulk people: ${msg}`);
    }
  }

  // 1d. Daily — SEC EDGAR 13D/G poll (FIX-253). Scans the previous business
  //     day's full-index for new beneficial-ownership filings touching
  //     tracked S&P 500 CIKs. Cheap (~one HTTP call + per-hit retrieval);
  //     skipSync if the index is unpublished (weekends/holidays). The full
  //     DEF 14A reconciliation runs weekly in the Sunday block below.
  {
    const t0 = Date.now();
    try {
      const r = await runEdgarDailyPipeline();
      results.pipelines.edgar_daily = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
    } catch (err) {
      const msg = errMsg(err);
      console.error("[nightly] edgar daily failed:", msg);
      results.pipelines.edgar_daily = { status: "failed", error: msg };
      results.errors.push(`EDGAR daily: ${msg}`);
    }
  }

  } // end Phase 1 daily pipelines (FIX-292)

  // FIX-754: resume trigger. A killed Sunday fec_bulk leaves
  // pipeline_state.fec_bulk_run_state behind; the next (weekday) nightly picks
  // it up and finishes the pending cycle only, so Monday/Tuesday auto-complete
  // Sunday's work with monotonic progress. Cheap single-row read; Sundays
  // resume through the normal weekly invocation without this check.
  // FIX-998: TEMPORARY hold, read once and threaded through every fec_bulk
  // trigger predicate below. Ahead of the FIX-754 resume load, the FIX-903 drop
  // probe AND the weekly gate, because the two weekday triggers hand off to each
  // other — see pipelines/fec-hold.ts. Unset env ⇒ held === false ⇒ every branch
  // below is byte-identical to pre-FIX-998 behavior.
  const fecTrigger: FecBulkTriggerInputs = {
    runFec,
    isWeekly,
    held: !FLAGS.FEC_NIGHTLY_BULK_ENABLED,
  };
  if (fecBulkHeldThisPhase(fecTrigger)) {
    console.warn(`  [nightly] ⏸  ${FEC_HOLD_REASON}`);
  }

  let fecResumeState: FecBulkRunState | null = null;
  if (shouldLoadResumeState(fecTrigger)) {
    fecResumeState = await loadFecRunState(db);
    if (fecResumeState) {
      console.log(`[nightly] RESUMING fec_bulk (FIX-754): ${describeFecRunState(fecResumeState)}`);
    }
  }

  // FIX-903: new-drop trigger. FEC publishes indiv{yy}.zip on SUNDAYS ~15:20
  // UTC — hours after Sunday's heavy run (queued ~05:30 UTC) has finished — so
  // the Sunday run always probes LAST week's file and the FIX-193 watermark
  // skips the cycle. On those weeks no resume state is left behind either, so
  // the FIX-754 branch above never fires and Sunday's fresh file sat uningested
  // for a full week. HEAD the active cycle here and run fec_bulk when FEC is
  // ahead of our watermark. Fails closed: a failed probe returns false rather
  // than launching a ~2.5h writer run on an unreadable signal. See
  // ./fec-bulk/drop-check.ts.
  let fecDropPending = false;
  if (shouldProbeDrop(fecTrigger, fecResumeState !== null)) {
    const probeCycle = resolveProbeCycle(new Date(), process.env["FEC_INDIV_CYCLES"]);
    fecDropPending = await indivDropPending(db, probeCycle);
    if (fecDropPending) {
      console.log(
        `[nightly] NEW FEC DROP — triggering off-Sunday fec_bulk for cycle ${probeCycle} (FIX-903); ` +
          `see the [fec-drop-check] line above for the FEC Last-Modified vs stored watermark`,
      );
    }
  }

  // 2a. FEC bulk — weekly (Sunday block), any nightly with a pending FIX-754
  // resume state, or a weekday on which FEC published a newer indiv file than
  // our watermark (FIX-903). Everything else weekly (IRS-990 onward) stays
  // Sunday-gated below.
  if (fecBulkHeldThisPhase(fecTrigger)) {
    // FIX-998: record a state that is unmistakably NOT a healthy run. `skipped`
    // is the existing NightlyPipelineResult vocabulary for "deliberately not
    // run" (regulations/congress/courtlistener/openstates all use it with the
    // reason in `error`), so every consumer of the payload already understands
    // it and the union does not widen. Never `complete`, never absent.
    results.pipelines.fec_bulk = { status: "skipped", error: FEC_HOLD_REASON };
  } else if (shouldRunFecBulk(fecTrigger, fecResumeState !== null, fecDropPending)) {
    {
      const t0 = Date.now();
      // Weekly cron only refreshes the current + prior cycle for the PAC
      // stage (the only ones FEC actively updates on a weekly cadence). The
      // pipeline's 4-cycle default (2020,2022,2024,2026) is reserved for
      // manual backfill via `pnpm data:fec-bulk`. An explicit FEC_CYCLES env
      // var still wins, so a cron-time override remains possible without code
      // changes.
      //
      // FIX-193: separate knob for the giant indiv stage. By default, only
      // the active cycle's indiv file is reprocessed — closed cycles' indiv
      // files don't move week-to-week (last FEC quarterly drop for 2024 was
      // 2026-01-31), so re-streaming 80M+ rows weekly burned bandwidth and
      // Pro write IO for ~zero new data. The Last-Modified watermark in
      // fec-bulk/index.ts is a second, finer-grained guard inside the
      // pipeline, so closed cycles still skip even if a manual override
      // re-adds them here.
      const prevFecCycles      = process.env["FEC_CYCLES"];
      const prevFecIndivCycles = process.env["FEC_INDIV_CYCLES"];
      if (fecResumeState && !isWeekly) {
        // FIX-754 resume mode: touch ONLY the pending cycle. Explicit env
        // overrides still win, matching the weekly narrowing below.
        if (!prevFecCycles)      process.env["FEC_CYCLES"]       = fecResumeState.cycle;
        if (!prevFecIndivCycles) process.env["FEC_INDIV_CYCLES"] = fecResumeState.cycle;
        console.log(`[nightly] fec_bulk resume: cycles narrowed to pending cycle ${fecResumeState.cycle} (FIX-754)`);
      } else if (!prevFecCycles || !prevFecIndivCycles) {
        // FIX-903: currentFecCycle() is the SAME helper the drop probe above
        // used, so the probe and the run it triggers can never disagree about
        // which cycle is active. A FIX-903-triggered weekday run lands here
        // (fecResumeState is null by construction) and so takes the normal
        // 2-cycle / 1-indiv-cycle nightly defaults, not resume-mode narrowing.
        const currentCycle = parseInt(currentFecCycle(new Date()), 10);
        if (!prevFecCycles)      process.env["FEC_CYCLES"]       = `${currentCycle - 2},${currentCycle}`;
        if (!prevFecIndivCycles) process.env["FEC_INDIV_CYCLES"] = `${currentCycle}`;
      }
      try {
        const r = await runFecBulkPipeline();
        results.pipelines.fec_bulk = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] fec-bulk failed:", msg);
        results.pipelines.fec_bulk = { status: "failed", error: msg };
        results.errors.push(`FEC bulk: ${msg}`);
      } finally {
        if (!prevFecCycles)      delete process.env["FEC_CYCLES"];
        if (!prevFecIndivCycles) delete process.env["FEC_INDIV_CYCLES"];
      }
    }
  }

  // 2. Weekly pipelines (Sunday only) — IRS 990, USASpending, CourtListener, OpenStates
  if (isWeekly) {
    const clKey  = process.env["COURTLISTENER_API_KEY"];
    const osKey  = process.env["OPENSTATES_API_KEY"];

    // FIX-904: IRS-990 USED TO RUN HERE, and it is now .github/workflows/
    // irs990.yml (Mondays 15:00 UTC) instead. It sat downstream of fec_bulk
    // inside this Sunday-only block, so any week fec_bulk overran the fec-phase
    // budget and got SIGTERM'd, IRS-990 simply never ran — and no weekday path
    // reached it, because the only off-Sunday fec-phase triggers (FIX-754
    // resume, FIX-903 drop-check) invoke fec_bulk alone and stop before this
    // block. Silent, unbounded, and recurring for as long as fec_bulk overruns.
    //
    // The load-bearing ordering is preserved by the CALENDAR, not by the call
    // site: Monday follows Sunday, so `resolveGrantRecipient` still sees
    // fec-bulk's freshly-upserted PAC entities when a 990 grants to a PAC.
    // SINGLE OWNER — the invocation is deliberately NOT kept here as well; a
    // stage with two owners is how the FIX-740 phase split earned its rule.

    // FIX-292 / FIX-740: Phase 2 weekly stages, now split into two sub-budgets.
    // 'enrichment-heavy' = LittleSis (~35 min on its own); 'enrichment-light' =
    // EDGAR through tag-industry. Both depend on Phase 1's FEC + IRS-990 writes
    // having flushed (each GHA sub-job `needs:` the fec-phase; FIX-276 ordering
    // is an explicit job dependency). USASpending's 2 GB first-run was removed
    // from this block entirely — it runs via its own workflow_dispatch now
    // (runUsaSpendingBulk / usaspending-bulk.yml; FIX-740, deferred FIX-739).

    // FIX-251: LittleSis bulk (relationship graph, CC-BY-SA 4.0). Runs after
    // FEC + IRS-990 so the match index sees fresh PAC / nonprofit entities
    // in the same Sunday wave. Pipeline's internal SHA256 fingerprint gate
    // makes this a no-op (skipSync='dumps_unchanged') until LittleSis
    // publishes new dumps — typically every few months — so weekly cadence
    // is safe.
    if (runEnrichmentHeavy) {
      const t0 = Date.now();
      try {
        const r = await runLittleSisPipeline();
        results.pipelines.littlesis = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] littlesis failed:", msg);
        results.pipelines.littlesis = { status: "failed", error: msg };
        results.errors.push(`LittleSis: ${msg}`);
      }
    }

    if (runEnrichmentLight) {

    // FIX-253: SEC EDGAR weekly DEF 14A reconciliation (officer rosters +
    // donor matching). Runs after FEC so the matcher's donor lookup sees
    // freshly-upserted individual donor rows in the same Sunday wave.
    {
      const t0 = Date.now();
      try {
        const r = await runEdgarPipeline();
        results.pipelines.edgar = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] edgar weekly failed:", msg);
        results.pipelines.edgar = { status: "failed", error: msg };
        results.errors.push(`EDGAR: ${msg}`);
      }
    }

    // FIX-740: USASpending removed from the enrichment phase. The 2 GB "full"
    // first-run never checkpointed within the 120-min budget — it restarted as
    // a first-run every night and cumulatively pushed the phase past its wall
    // clock. It now runs via its own workflow_dispatch (usaspending-bulk.yml →
    // runUsaSpendingBulk). Checkpoint/resume is the deferred durable fix
    // (FIX-739).

    if (clKey) {
      const t0 = Date.now();
      try {
        const r = await runCourtListenerPipeline(clKey, federalId);
        results.pipelines.courtlistener = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] courtlistener failed:", msg);
        results.pipelines.courtlistener = { status: "failed", error: msg };
        results.errors.push(`CourtListener: ${msg}`);
      }
    } else {
      results.pipelines.courtlistener = { status: "skipped", error: "COURTLISTENER_API_KEY not set" };
    }

    if (osKey) {
      const t0 = Date.now();
      try {
        const r = await runOpenStatesPipeline(osKey, stateIds);
        results.pipelines.openstates = { status: "complete", rows_added: r.inserted, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] openstates failed:", msg);
        results.pipelines.openstates = { status: "failed", error: msg };
        results.errors.push(`OpenStates: ${msg}`);
      }
    } else {
      results.pipelines.openstates = { status: "skipped", error: "OPENSTATES_API_KEY not set" };
    }

    {
      const t0 = Date.now();
      try {
        const r = await runAgenciesHierarchyPipeline();
        results.pipelines.agencies_hierarchy = { status: "complete", rows_added: r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] agencies-hierarchy failed:", msg);
        results.pipelines.agencies_hierarchy = { status: "failed", error: msg };
        results.errors.push(`Agencies hierarchy: ${msg}`);
      }
    }

    {
      const t0 = Date.now();
      try {
        const r = await runOpmFtePipeline();
        results.pipelines.opm_fte = { status: "complete", rows_added: r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] opm-fte failed (non-fatal):", msg);
        results.pipelines.opm_fte = { status: "failed", error: msg };
        // Non-fatal: OPM ZIP URL may be unreachable; don't add to errors array
      }
    }

    {
      const t0 = Date.now();
      try {
        // Version-aware: pipeline skips automatically if OpenSanctions dataset
        // hasn't changed since last run (ETag stored in pipeline_state).
        const r = await runPlumBookPipeline();
        results.pipelines.plum_book = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] plum-book failed:", msg);
        results.pipelines.plum_book = { status: "failed", error: msg };
        results.errors.push(`PLUM Book: ${msg}`);
      }
    }

    {
      const t0 = Date.now();
      try {
        const r = await runElectionsPipeline();
        results.pipelines.elections = { status: "complete", rows_added: r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] elections failed:", msg);
        results.pipelines.elections = { status: "failed", error: msg };
        results.errors.push(`Elections: ${msg}`);
      }
    }

    // Committees (memberships shift on caucus reassignments — weekly is plenty)
    {
      const t0 = Date.now();
      try {
        const r = await runCommitteesPipeline({ federalId });
        results.pipelines.congress_committees = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] congress committees failed:", msg);
        results.pipelines.congress_committees = { status: "failed", error: msg };
        results.errors.push(`Congress committees: ${msg}`);
      }
    }

    // FIX-227: Agency leadership (Wikidata SPARQL + Congress.gov nominations)
    // Writes to entity_connections; must run before the connections rebuild + MV refreshes below.
    {
      const t0 = Date.now();
      try {
        const r = await runAgencyLeadershipPipeline();
        results.pipelines.agency_leadership = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] agency-leadership failed:", msg);
        results.pipelines.agency_leadership = { status: "failed", error: msg };
        results.errors.push(`Agency leadership: ${msg}`);
      }
    }

    // FIX-228: Agency enrichment (Federal Register descriptions + Wikidata founding dates).
    // Monthly cadence — Federal Register + Wikidata data shifts slowly and the
    // SPARQL query pulls 3000 rows per run.
    {
      const isFirstSundayOfMonth = new Date(Date.now()).getUTCDate() <= 7;
      if (isFirstSundayOfMonth) {
        const t0 = Date.now();
        try {
          const r = await runAgencyEnrichmentPipeline();
          results.pipelines.agency_enrichment = { status: "complete", rows_added: r.inserted + r.updated, duration_ms: Date.now() - t0 };
        } catch (err) {
          const msg = errMsg(err);
          console.error("[nightly] agency-enrichment failed:", msg);
          results.pipelines.agency_enrichment = { status: "failed", error: msg };
          results.errors.push(`Agency enrichment: ${msg}`);
        }
      } else {
        results.pipelines.agency_enrichment = { status: "not_scheduled" };
      }
    }

    // FIX-232: AI industry classifier for PACs > $100k that the rule-based
    // tagger missed. Runs after FEC bulk so newly-arrived PACs get classified
    // in the same Sunday wave. Cost-gate auto-skips in autonomous mode if
    // entity count or projected cost exceeds the configured caps.
    {
      const t0 = Date.now();
      try {
        const r = await runAiClassifier({ confirmed: true });
        const costUsd = r.tagged * 0.0002;
        results.ai.tag_industry = { status: "complete", entities: r.tagged, cost_usd: costUsd };
        results.total_ai_cost_usd += costUsd;
        // Surface duration through the pipeline tag-industry slot via console only —
        // tag_industry lives under results.ai (no duration_ms field).
        console.log(`[nightly] tag-industry — complete in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.tagged} tagged`);
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] tag-industry failed:", msg);
        results.ai.tag_industry = { status: "failed" };
        results.errors.push(`Tag industry: ${msg}`);
      }
    }

    } // end Phase 2 weekly light stages (FIX-292 / FIX-740)
  }

  // FIX-292 / FIX-740 / FIX-746: Phase 2 daily stages — comment bridge scorer,
  // rule + AI taggers, AI summaries, and the two deferred MV refreshes. These
  // are the 'enrichment-tail' sub-phase (FIX-746): split out of enrichment-light
  // so the daily derivation tail no longer competes with the weekly ingest block
  // for the same budget (FIX-743 proved light was SIGTERM'd mid-tag_rules on
  // Sunday). The tail reads DB state (tag-industry writes etc.) landed by the
  // prior enrichment-light job, so cross-phase ordering holds via the DB, not
  // in-process. On the unsplit 'enrichment'/'all' path this still runs in-process
  // right after the light block, so ordering holds there too.
  if (runEnrichmentTail) {

  // 3b. [FIX-715] proposal_trending_24h + proposal_popularity_24h refreshes moved
  //     to the pg_cron procedure refresh_derived_mvs('daily') — off the 120-min
  //     enrichment budget (2026-06-29: this tail SIGTERMd and went dark). See
  //     supabase/migrations/20260703000000_fix715_refresh_derived_mvs_pgcron.sql.

  // 3b-iii. Comment bridge scorer (FIX-527). Runs immediately after the
  //   comment-activity MV refresh (proposal_trending_24h) so trending and bridge
  //   scores are computed against the same comment state. Set-based UPDATE over
  //   entity_comments via the direct-pg heavy-rebuild path; writes only
  //   bridge_score/map_x/map_y + the comment_scorer watermark. Cheap full sweep
  //   at current scale; non-fatal — a scorer failure must not abort the nightly.
  try {
    const { scored } = await scoreComments();
    console.log(`[nightly] comment bridge scorer — ${scored} comment(s) scored`);
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] comment bridge scorer failed:", msg);
    results.errors.push(`Comment bridge scorer: ${msg}`);
  }

  // 3b-ii. [FIX-715] refresh_spending_totals (total_contract_cents /
  //     total_grant_cents on financial_entities) moved to the pg_cron procedure
  //     refresh_derived_mvs('weekly') — its source (USASpending) is a weekly
  //     Sunday ingest, so weekly cadence matches. Was a direct-pg heavy rebuild
  //     here (FIX-651, to clear the 8s role cap); now a committed unit under the
  //     pg_cron 6h role-default budget.

  // 3c. rebuild_entity_connections now runs IN-DB on pg_cron (FIX-687/703/704,
  //     jobs rebuild-ec-full Mon + rebuild-ec-incremental Wed 08:00 UTC) — it is
  //     no longer a GHA workflow. The umbrella rebuild_entity_connections() RPC
  //     is preserved for local dev callers; the standalone pipeline lives at
  //     packages/data/src/scripts/rebuild-entity-connections.ts.
  //     Most MVs derived from entity_connections moved to refresh_derived_mvs on
  //     pg_cron (FIX-715). The two large ones — entity_connection_stats_mv and
  //     donor_party_rollup_mv — were DEFERRED here until FIX-717/718 converted
  //     them to incrementally-maintained TABLEs on their own pg_cron jobs
  //     (entity-connection-stats-rebuild Mon+Wed 11:00 UTC,
  //     donor-party-rollup-refresh Tue 08:45 UTC). Nothing derived from
  //     entity_connections runs in the nightly anymore.

  // 4. Rule-based tags — the Node-side taggers only: proposal urgency/scope,
  //    official tenure/voting/donor patterns, financial-entity industry keywords.
  //    [FIX-716] the two heavy SQL rebuilds it used to run (size-tags + pre-vote
  //    timing) moved to the pg_cron procedure run_rule_taggers; runRuleBasedTagger
  //    no longer calls them.
  try {
    await runRuleBasedTagger();
    results.ai.tag_rules = { status: "complete" };
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] tag-rules failed:", msg);
    results.ai.tag_rules = { status: "failed" };
    results.errors.push(`Tag rules: ${msg}`);
  }

  // 5. AI tags (new entities only, $0.10 max per nightly run)
  try {
    const r = await runAiTagger({ maxCostCents: 10, onlyNew: true });
    const costUsd = (r.costCents ?? 0) / 100;
    results.ai.tag_ai = { status: "complete", entities: r.tagsCreated, cost_usd: costUsd };
    results.total_ai_cost_usd += costUsd;
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] tag-ai failed:", msg);
    results.ai.tag_ai = { status: "failed" };
    results.errors.push(`AI tagger: ${msg}`);
  }

  // 6. AI summaries (incremental — only proposals/officials without cached summaries)
  try {
    await runAiSummariesPipeline(true);
    results.ai.ai_summaries = { status: "complete" };
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] ai-summaries failed:", msg);
    results.ai.ai_summaries = { status: "failed" };
    results.errors.push(`AI summaries: ${msg}`);
  }

  // 7. [FIX-715] The MV-refresh tail that used to live here — the 4 chord MVs,
  //    refresh_official_sector_dollars_mv, homepage/official-homepage stats,
  //    entity_engagement_rollup, homepage_agency_counts, commons_active_threads,
  //    pipeline_runtime_stats — plus rebuild_all_primary_sources and the three
  //    retention prunes all moved to the pg_cron procedure refresh_derived_mvs
  //    (daily + weekly, cadence-matched to source). See
  //    supabase/migrations/20260703000000_fix715_refresh_derived_mvs_pgcron.sql.
  //
  //    [FIX-717/718] The two DEFERRED MVs that used to remain here —
  //    entity_connection_stats_mv + donor_party_rollup_mv — are now
  //    incrementally-maintained TABLEs (same names) on their own pg_cron jobs
  //    (entity-connection-stats-rebuild Mon+Wed 11:00 UTC after the EC rebuild
  //    jobs; donor-party-rollup-refresh Tue 08:45 UTC on the
  //    donor_party_rollup_watermark). The capped admin.rpc() refreshes that ran
  //    here never actually completed on prod (the ~8s service_role
  //    statement_timeout cancelled a minutes-long REFRESH every night), so this
  //    also un-stales both. The enrichment-tail (FIX-746) keeps its other work
  //    (comment bridge scorer, taggers, AI summaries) — only the MV loop left.

  } // end Phase 2 daily stages (FIX-292 / FIX-740 / FIX-746 — enrichment-tail)

  results.completed_at = new Date();
  results.duration_ms = results.completed_at.getTime() - startedAt.getTime();

  console.log(`\n  Nightly sync complete: ${results.completed_at.toISOString()}`);
  console.log(`  Duration: ${(results.duration_ms / 1000).toFixed(1)}s`);
  if (results.errors.length > 0) {
    console.log(`  Errors (${results.errors.length}): ${results.errors.join("; ")}`);
  }

  // Record results to pipeline_state for dashboard. FIX-293: merge with any
  // existing same-UTC-day row so the two-phase nightly (FIX-292) preserves
  // both phases' results.pipelines.* keys instead of clobbering them.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = db as any;

    const { data: existing } = await adminDb
      .from("pipeline_state")
      .select("value")
      .eq("key", "cron_last_run")
      .maybeSingle();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingValue = (existing?.value ?? null) as any;
    const existingDate = typeof existingValue?.started_at === "string"
      ? existingValue.started_at.slice(0, 10)
      : null;
    const thisDate = startedAt.toISOString().slice(0, 10);
    const sameDay = existingDate === thisDate;

    const mergedPipelines = sameDay
      ? { ...(existingValue?.results?.pipelines ?? {}), ...results.pipelines }
      : results.pipelines;

    const mergedErrors = sameDay
      ? [...(existingValue?.results?.errors ?? []), ...results.errors]
      : results.errors;

    const mergedAi = sameDay
      ? { ...(existingValue?.results?.ai ?? {}), ...results.ai }
      : results.ai;

    const mergedTotalAiCost = sameDay
      ? (existingValue?.results?.total_ai_cost_usd ?? 0) + results.total_ai_cost_usd
      : results.total_ai_cost_usd;

    const mergedResults = {
      ...results,
      pipelines: mergedPipelines,
      errors: mergedErrors,
      ai: mergedAi,
      total_ai_cost_usd: mergedTotalAiCost,
    };

    const mergedStatus = mergedErrors.length === 0 ? "complete" : "partial";
    const phaseStatus = results.errors.length === 0 ? "complete" : "partial";

    await adminDb.from("pipeline_state").upsert(
      {
        key: "cron_last_run",
        value: {
          started_at:   startedAt.toISOString(),
          completed_at: results.completed_at.toISOString(),
          status: mergedStatus,
          phase,
          results: mergedResults,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    // Also write to data_sync_log. FIX-292: each phase writes its own row,
    // tagged metadata.phase so two rows-per-night-on-Sunday is the new
    // normal. Canary semantics are unchanged — it dedups by UTC date.
    //
    // Shape contract (FIX-307 closeout, 2026-05-23): `metadata.pipelines` is
    // populated only by stages that write to `results.pipelines.*`. On a
    // weekday Phase 2 run that map is genuinely `{}` — all daily Phase 2
    // work lives under `results.ai.*` (tag_rules, tag_ai, ai_summaries) or
    // in MV-refresh side effects that only surface via `results.errors`.
    // Phase 2 only writes pipeline rows on Sunday's `isWeekly` block
    // (LittleSis, EDGAR, USASpending, etc.). The original FIX-307 report
    // misattributed Phase 1's edgar_daily / openstates_bulk_people work to
    // Phase 2; closed as no-op against prod inspection of 5/18-5/23 rows.
    // FIX-462: resolve the `running` start-row in place rather than inserting a
    // second row. Keeps one nightly_cron row per phase per night and leaves no
    // orphan for mark-killed/reap to chase on a clean run. Falls back to INSERT
    // if the start-row write failed (runningRowId empty) so a terminal row is
    // always recorded.
    const terminalRow = {
      status:        phaseStatus,
      completed_at:  results.completed_at.toISOString(),
      rows_inserted: Object.values(results.pipelines).reduce(
        (sum, p) => sum + (p?.rows_added ?? 0), 0
      ),
      // FIX-971a: this UPDATE replaces `metadata` wholesale, so the run
      // identity written on the start-row has to be re-applied here or the
      // terminal row loses its only join key back to the GHA record.
      metadata: { ...results, peak_rss_mb: captureRssMb(), phase, ...githubRunIdentity() },
    };
    if (runningRowId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from("data_sync_log").update(terminalRow).eq("id", runningRowId);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from("data_sync_log").insert({
        pipeline:   "nightly_cron",
        started_at: startedAt.toISOString(),
        ...terminalRow,
      });
    }
  } catch (err) {
    console.error("[nightly] failed to record results:", errMsg(err));
  }

  return results;
}

// ---------------------------------------------------------------------------
// USASpending bulk — standalone runner (FIX-740)
//
// Pulled out of the nightly enrichment phase (the 2 GB first-run never
// checkpointed within the phase budget, restarting from zero every night and
// starving the rest of enrichment). Now invoked only via its own
// workflow_dispatch (usaspending-bulk.yml → `pnpm data:usaspending-bulk:ci`),
// mirroring the `data:fec-bulk:ci` shape. Runs both categories sequentially —
// each archive is 300 MB–1 GB, so parallel would double peak disk. Each
// category self-logs to data_sync_log via its own startSync/completeSync, so
// no nightly results object is threaded through here. Checkpoint/resume for the
// full first-run is the deferred durable fix (FIX-739).
// ---------------------------------------------------------------------------

export async function runUsaSpendingBulk(): Promise<void> {
  const startTime = Date.now();
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   USASpending bulk (contracts + assistance) ║");
  console.log("╚══════════════════════════════════════════╝");

  const contracts  = await runUsaSpendingBulkPipeline({ category: "contracts" });
  const assistance = await runUsaSpendingBulkPipeline({ category: "assistance" });

  const mins = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(
    `\n  USASpending done in ${mins} min — ` +
    `contracts: inserted=${contracts.inserted} failed=${contracts.failed}; ` +
    `assistance: inserted=${assistance.inserted} failed=${assistance.failed}`,
  );
}

// ---------------------------------------------------------------------------
// Standalone entry points
// ---------------------------------------------------------------------------

if (require.main === module) {
  const command = process.argv[2];

  if (command === "status") {
    printStatus()
      .then(() => { setTimeout(() => process.exit(0), 500); })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  } else if (command === "usaspending") {
    // FIX-740: standalone USASpending bulk entry (usaspending-bulk.yml →
    // data:usaspending-bulk:ci). Mirrors the `data:fec-bulk:ci` shape — the
    // --allow-prod flag on the :ci script satisfies createAdminClient's
    // prod-write guard.
    runUsaSpendingBulk()
      .then(() => { setTimeout(() => process.exit(0), 500); })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  } else if (command === "nightly") {
    // FIX-292 / FIX-740 / FIX-746: optional --phase. Default 'all' preserves
    // pre-split behavior for `pnpm data:nightly` (local) and the Vercel cron
    // canary. GHA invokes each phase explicitly via :ci scripts (fec /
    // enrichment-heavy / enrichment-light / enrichment-tail).
    const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
    const phase: NightlyPhase = phaseArg
      ? (phaseArg.slice("--phase=".length) as NightlyPhase)
      : "all";
    const VALID_PHASES = ["fec", "enrichment", "enrichment-heavy", "enrichment-light", "enrichment-tail", "all"];
    if (!VALID_PHASES.includes(phase)) {
      console.error(`Invalid --phase value: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}.`);
      process.exit(2);
    }
    runNightlySync({ phase })
      .then((results) => {
        // FIX-757: a phase with any failed pipeline (phaseStatus 'partial')
        // must not exit 0 — the GHA job would show a failed ingest green
        // (the 2026-07-05 fec_bulk fatal). Same rule as the phaseStatus
        // derivation above: red iff results.errors is non-empty. FIX-727
        // covers the standalone fec-bulk entrypoint the same way.
        if (results.errors.length > 0) {
          console.error(
            `Nightly phase '${phase}' completed with ${results.errors.length} error(s) — exiting 1 (FIX-757)`,
          );
          setTimeout(() => process.exit(1), 500);
        } else {
          setTimeout(() => process.exit(0), 500);
        }
      })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  } else {
    runAllPipelines()
      .then(() => { setTimeout(() => process.exit(0), 500); })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  }
}
