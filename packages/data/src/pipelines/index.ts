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
import { getDbSizeMb, getLastSync, startSync, completeSync, failSync } from "./sync-log";
import { runRegulationsPipeline } from "./regulations";
import { runFecBulkPipeline } from "./fec-bulk";
import { runUsaSpendingBulkPipeline } from "./usaspending-bulk";
import { runCourtListenerPipeline } from "./courtlistener";
import { runOpenStatesPipeline } from "./openstates";
import { runBulkPeoplePipeline } from "./openstates-bulk/people";
import { runOfficialsPipeline, runVotesPipeline, runCommitteesPipeline } from "./congress";
import { runRuleBasedTagger } from "./tags/rules";
import { runAiTagger } from "./tags/ai-tagger";
import { runAiSummariesPipeline } from "./ai-summaries";
import { runAgenciesHierarchyPipeline } from "./agencies-hierarchy";
import { runAgencyLeadershipPipeline } from "./agency-leadership";
import { runAgencyEnrichmentPipeline } from "./agency-enrichment";
import { runOpmFtePipeline } from "./opm-fte";
import { runPlumBookPipeline } from "./plum-book";
import { runElectionsPipeline } from "./elections";
import { runAiClassifier } from "./tags/ai-classifier";
import { seedJurisdictions, seedGoverningBodies } from "../jurisdictions/us-states";

// Build a session-pooler connection string for direct pg.Client access (used
// when an RPC's runtime would exceed PostgREST's gateway timeout). Prefers an
// explicit SUPABASE_DB_URL when set; otherwise constructs one from the
// project ref (derived from NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_DB_PASSWORD.
// Region defaults to us-west-2; override with SUPABASE_DB_REGION if needed.
// Returns null when neither input is available.
function buildDbUrl(): string | null {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!password || !supabaseUrl) return null;
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return null;
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

// Supabase RPC errors come back as plain objects ({ code, message, details, hint })
// — not Error instances — so String(err) → "[object Object]". Unwrap them so
// catch sites get a useful message.
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const parts: string[] = [obj.message];
      if (obj.code)    parts.push(`(${String(obj.code)})`);
      if (obj.details) parts.push(`details=${String(obj.details)}`);
      if (obj.hint)    parts.push(`hint=${String(obj.hint)}`);
      return parts.join(" ");
    }
    try { return JSON.stringify(err); } catch { return "<unserializable error>"; }
  }
  return String(err);
}

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

  const pipelines = ["regulations", "fec_bulk", "usaspending", "courtlistener", "openstates", "congress_officials", "congress_votes"] as const;
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
    usaspending?: NightlyPipelineResult;
    courtlistener?: NightlyPipelineResult;
    openstates?: NightlyPipelineResult;
    openstates_bulk_people?: NightlyPipelineResult;
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

export async function runNightlySync(): Promise<NightlySyncResults> {
  const startedAt = new Date();
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║          Nightly Sync Starting            ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Started: ${startedAt.toISOString()}`);

  const apiKey = process.env["REGULATIONS_API_KEY"];
  const isWeekly = new Date().getDay() === 0; // Sunday

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
  const { federalId, stateIds } = await seedJurisdictions(db);
  const { senateId: senateGovBodyId, houseId: houseGovBodyId } = await seedGoverningBodies(db, federalId);

  // 1. Daily data pipelines — Regulations.gov
  {
    const t0 = Date.now();
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

  // 2. Weekly pipelines (Sunday only) — FEC bulk, USASpending, CourtListener, OpenStates
  if (isWeekly) {
    const clKey  = process.env["COURTLISTENER_API_KEY"];
    const osKey  = process.env["OPENSTATES_API_KEY"];

    {
      const t0 = Date.now();
      // Weekly cron only refreshes the current + prior cycle (the only ones
      // FEC actively updates on a weekly cadence). The pipeline's 4-cycle
      // default (2020,2022,2024,2026) is reserved for manual backfill via
      // `pnpm data:fec-bulk`. An explicit FEC_CYCLES env var still wins, so
      // a cron-time override remains possible without code changes.
      const prevFecCycles = process.env["FEC_CYCLES"];
      if (!prevFecCycles) {
        const yr = new Date().getFullYear();
        const currentCycle = yr % 2 === 0 ? yr : yr + 1;
        process.env["FEC_CYCLES"] = `${currentCycle - 2},${currentCycle}`;
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
        if (!prevFecCycles) delete process.env["FEC_CYCLES"];
      }
    }

    {
      const t0 = Date.now();
      try {
        // Sequential — each archive file is 300 MB–1 GB; parallel would double peak disk usage.
        const contracts  = await runUsaSpendingBulkPipeline({ category: "contracts" });
        const assistance = await runUsaSpendingBulkPipeline({ category: "assistance" });
        results.pipelines.usaspending = {
          status: "complete",
          rows_added: contracts.inserted + assistance.inserted,
          duration_ms: Date.now() - t0,
        };
      } catch (err) {
        const msg = errMsg(err);
        console.error("[nightly] usaspending failed:", msg);
        results.pipelines.usaspending = { status: "failed", error: msg };
        results.errors.push(`USASpending: ${msg}`);
      }
    }

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
  }

  // 3b. Refresh derived MVs that back the proposals list page.
  //  - proposal_trending_24h (FIX-029): comment-activity scoring for the
  //    Trending tab.
  //  - proposal_popularity_24h (FIX-200): page-view counts for the
  //    Most-Viewed tab. Replaces a hot-path JS aggregation that scanned
  //    page_views on every page load.
  try {
    const { createAdminClient } = await import("@civitics/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;
    await admin.rpc("refresh_proposal_trending");
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] refresh_proposal_trending failed:", msg);
    results.errors.push(`Trending refresh: ${msg}`);
  }
  try {
    const { createAdminClient } = await import("@civitics/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;
    await admin.rpc("refresh_proposal_popularity");
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] refresh_proposal_popularity failed:", msg);
    results.errors.push(`Popularity refresh: ${msg}`);
  }

  // 3b-ii. Refresh spending totals (total_contract_cents / total_grant_cents on financial_entities)
  // Cheap single-query aggregate update; runs nightly so any weekly USASpending ingestion
  // is reflected immediately rather than waiting for the next weekly run.
  {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (db as any).rpc("refresh_spending_totals");
      if (error) console.warn("[nightly] refresh_spending_totals warning:", error.message);
      else console.log("[nightly] refresh_spending_totals — complete");
    } catch (err) {
      console.warn("[nightly] refresh_spending_totals failed (non-fatal):", errMsg(err));
    }
  }

  // 3c. Rebuild entity_connections via SQL derivation (FIX-100)
  // Full rebuild from financial_relationships, votes, proposal_cosponsors,
  // career_history, agencies. Function-level statement_timeout is 15min
  // (migration 20260430000000); the call site needs to bypass PostgREST's
  // ~60s gateway timeout, which it does when SUPABASE_DB_URL is set by
  // talking to the session pooler directly via pg.Client. Falls back to
  // PostgREST RPC for local dev where the rebuild completes in <1s.
  {
    const t0 = Date.now();
    const logId = await startSync("entity_connections_rebuild");
    try {
      const dbUrl = buildDbUrl();
      console.log(`[nightly] rebuild_entity_connections — starting (${dbUrl ? "direct pg" : "PostgREST RPC"})`);
      let total = 0;
      let breakdown: { connection_type: string; edges_upserted: string | number }[] = [];
      if (dbUrl) {
        const { Client } = await import("pg");
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
          // Raise the session-level statement_timeout above the role default
          // (120s on Pro). The function's own proconfig sets 15min internally,
          // but the OUTER SELECT inherits the session/role default, which is
          // what was firing the timeout. 20min gives the outer call a small
          // margin over the function-level 15min cap.
          await client.query("SET statement_timeout = '20min'");
          const res = await client.query<{ connection_type: string; edges_upserted: string | number }>(
            "SELECT * FROM rebuild_entity_connections()"
          );
          breakdown = res.rows;
          total = res.rows.reduce((a, r) => a + Number(r.edges_upserted ?? 0), 0);
        } finally {
          await client.end();
        }
      } else {
        const { createAdminClient } = await import("@civitics/db");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const admin = createAdminClient() as any;
        const { data, error } = await admin.rpc("rebuild_entity_connections");
        if (error) throw error;
        breakdown = data ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        total = (data ?? []).reduce((a: number, r: any) => a + Number(r.edges_upserted ?? 0), 0);
      }
      const dur = Date.now() - t0;
      console.log(`[nightly] rebuild_entity_connections — complete in ${(dur / 1000).toFixed(1)}s, ${total} edges`);
      for (const r of breakdown) console.log(`  ${r.connection_type}: ${r.edges_upserted}`);
      results.pipelines.entity_connections_rebuild = {
        status: "complete",
        rows_added: total,
        duration_ms: dur,
      };
      await completeSync(logId, { inserted: total, updated: 0, failed: 0, estimatedMb: 0 });
    } catch (err) {
      const msg = errMsg(err);
      console.error("[nightly] rebuild_entity_connections failed:", msg);
      results.pipelines.entity_connections_rebuild = { status: "failed", error: msg };
      results.errors.push(`Rebuild entity_connections: ${msg}`);
      await failSync(logId, msg);
    }
  }

  // 4. Rule-based tags (all new/updated entities)
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

  // 7. Refresh chord MVs. Runs last so industry tags from steps 4 + 5 are
  //    current. Each base query is a multi-second full-table scan that
  //    used to time out the live RPC at the 5s ceiling; here they run
  //    once nightly against the session timeout, then the RPCs serve
  //    cached rows the rest of the day.
  //    - chord_industry_flows_mv (FIX-207): industry × party
  //    - chord_donor_type_party_flows_mv (FIX-222): donor entity_type × party
  //    - chord_donor_state_party_flows_mv (FIX-222): donor state × party
  //    - chord_subject_party_flows_mv (FIX-222): bill topic × party (yes votes)
  try {
    const { createAdminClient } = await import("@civitics/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;
    await admin.rpc("refresh_chord_industry_flows_mv");
  } catch (err) {
    const msg = errMsg(err);
    console.error("[nightly] refresh_chord_industry_flows_mv failed:", msg);
    results.errors.push(`Chord industry MV refresh: ${msg}`);
  }
  for (const fn of [
    "refresh_chord_donor_type_party_flows_mv",
    "refresh_chord_donor_state_party_flows_mv",
    "refresh_chord_subject_party_flows_mv",
    // FIX-223: homepage hero stats + per-official Wave 3 stats
    "refresh_homepage_stats_mv",
    "refresh_official_homepage_stats_mv",
    // FIX-233 (part 1): p50/p95/max duration per pipeline over last 30 days
    "refresh_pipeline_runtime_stats_mv",
  ]) {
    try {
      const { createAdminClient } = await import("@civitics/db");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const admin = createAdminClient() as any;
      await admin.rpc(fn);
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[nightly] ${fn} failed:`, msg);
      results.errors.push(`${fn}: ${msg}`);
    }
  }

  results.completed_at = new Date();
  results.duration_ms = results.completed_at.getTime() - startedAt.getTime();

  console.log(`\n  Nightly sync complete: ${results.completed_at.toISOString()}`);
  console.log(`  Duration: ${(results.duration_ms / 1000).toFixed(1)}s`);
  if (results.errors.length > 0) {
    console.log(`  Errors (${results.errors.length}): ${results.errors.join("; ")}`);
  }

  // Record results to pipeline_state for dashboard
  try {
    const status = results.errors.length === 0 ? "complete" : "partial";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).from("pipeline_state").upsert(
      {
        key: "cron_last_run",
        value: {
          started_at:   startedAt.toISOString(),
          completed_at: results.completed_at.toISOString(),
          status,
          results,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    // Also write to data_sync_log
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).from("data_sync_log").insert({
      pipeline:      "nightly_cron",
      status,
      started_at:    startedAt.toISOString(),
      completed_at:  results.completed_at.toISOString(),
      rows_inserted: Object.values(results.pipelines).reduce(
        (sum, p) => sum + (p?.rows_added ?? 0), 0
      ),
      metadata: results,
    });
  } catch (err) {
    console.error("[nightly] failed to record results:", errMsg(err));
  }

  return results;
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
  } else if (command === "nightly") {
    runNightlySync()
      .then(() => { setTimeout(() => process.exit(0), 500); })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  } else {
    runAllPipelines()
      .then(() => { setTimeout(() => process.exit(0), 500); })
      .catch((e) => { console.error("Pipeline failed:", e); setTimeout(() => process.exit(1), 500); });
  }
}
