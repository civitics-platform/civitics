/**
 * data_sync_log helpers.
 * Tracks every pipeline run — powers the dashboard's Data Freshness section.
 * Uses `as any` because data_sync_log is a new table not yet in TS types.
 */

import { createAdminClient } from "@civitics/db";

export interface PipelineResult {
  inserted: number;
  updated: number;
  failed: number;
  estimatedMb: number;
  // FIX-386: optional. When the pipeline called seedJurisdictions() internally
  // and the seed had non-fatal per-state failures, the caller can pass the
  // returned warnings here. completeSync folds them into metadata.seed_warnings
  // so the Data Health dashboard can surface them as a yellow sub-status.
  // Pipelines that don't seed (or whose seed was clean) just omit this field.
  seed_warnings?: string[];
  // FIX-727: set when the pipeline caught a fatal error and failSync fired.
  // Standalone entrypoints inspect it to exit nonzero so CI status is
  // trustworthy; the nightly orchestrator keeps its own try/catch semantics.
  fatal_error?: string;
  // FIX-911: free-form per-run facts a pipeline wants to keep, merged into
  // data_sync_log.metadata. Distinct from seed_warnings, which is specifically
  // the FIX-386 jurisdiction-seed channel the Data Health dashboard reads.
  // Use for counts a future audit will want to grep — the AI classifier's
  // vocabulary abstains are the first case: preferring an abstain to a junk tag
  // is only auditable if the abstain leaves a durable trace, not a CI log line.
  // Merged UNDER the reserved keys below, so a caller cannot clobber
  // peak_rss_mb or seed_warnings by accident.
  metadata?: Record<string, unknown>;
}

// FIX-255: best-effort failSync on abnormal exit so data_sync_log rows don't
// strand in status='running'. V8 OOM lands as SIGABRT and is NOT catchable
// from JS; SIGKILL likewise. For those cases the reap_stale_sync_log() RPC
// (see migration 20260512000000) is the only recovery path.
const inFlightLogIds = new Set<string>();
let exitHandlersInstalled = false;
let exitHandlerFired = false;

function handleExit(reason: string, finalize: () => void): void {
  if (exitHandlerFired) return;
  exitHandlerFired = true;
  const ids = [...inFlightLogIds];
  inFlightLogIds.clear();
  if (ids.length === 0) {
    finalize();
    return;
  }
  console.warn(`  [sync-log] ${reason} — flushing ${ids.length} in-flight log row(s)`);
  Promise.race([
    Promise.allSettled(ids.map((id) => failSync(id, reason))),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]).finally(finalize);
}

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const onSignal = (signal: NodeJS.Signals) => () =>
    handleExit(`node-aborted-${signal}`, () => {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  process.on("SIGTERM", onSignal("SIGTERM"));
  process.on("SIGINT",  onSignal("SIGINT"));
  process.on("SIGHUP",  onSignal("SIGHUP"));
  process.on("uncaughtException", (err) =>
    handleExit(
      `node-aborted-uncaughtException:${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      () => process.exit(1),
    ),
  );
  process.on("unhandledRejection", (reason) =>
    handleExit(
      `node-aborted-unhandledRejection:${String(reason).slice(0, 200)}`,
      () => process.exit(1),
    ),
  );
}

/**
 * FIX-971a — launcher-side run identity.
 *
 * For pg_cron work `cron.job_run_details` records start/end/status from the
 * LAUNCHER's side, independently of anything the job wrote about itself, so a
 * job that died without closing its own row can still be timed exactly. For
 * GitHub-Actions work there is no equivalent: `data_sync_log` is the only
 * record and it is self-reported. The truth does exist externally — the GHA API
 * returns `run_started_at` / `updated_at` / `conclusion` per run — but it could
 * never be joined after the fact because no run identifier was recorded
 * anywhere. That is how FIX-944's four failing runs came to be reported as
 * ~20h when they were 6h `statement_timeout` deaths; the 14h difference was
 * reaper latency and there was no second source to correct it with.
 *
 * Stamping these three at row-creation time makes every future row joinable to
 * the authoritative external record forever:
 *
 *   gh api /repos/{owner}/{repo}/actions/runs/{github_run_id}
 *   gh api /repos/{owner}/{repo}/actions/runs/{github_run_id}/jobs
 *
 * Empty off CI (nothing is written), so local runs are unchanged.
 */
export function githubRunIdentity(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const identity: Record<string, string> = {};
  const runId = env["GITHUB_RUN_ID"];
  const runAttempt = env["GITHUB_RUN_ATTEMPT"];
  const workflow = env["GITHUB_WORKFLOW"];
  if (runId) identity["github_run_id"] = runId;
  if (runAttempt) identity["github_run_attempt"] = runAttempt;
  if (workflow) identity["github_workflow"] = workflow;
  return identity;
}

// RSS at completion time, not peak across the run. Acceptable proxy for
// bulk-streaming pipelines whose RSS doesn't shrink during the process
// lifetime. True-peak instrumentation (setInterval sampler) is deferred.
export function captureRssMb(): number {
  const mu = process.memoryUsage as typeof process.memoryUsage & { rss?: () => number };
  const rssBytes = typeof mu.rss === "function" ? mu.rss() : process.memoryUsage().rss;
  return Math.round(rssBytes / 1024 / 1024);
}

export async function startSync(pipeline: string): Promise<string> {
  installExitHandlers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    // FIX-971a: the run identity goes on at INSERT, not at completion — a run
    // that never reaches completeSync/failSync is exactly the one whose true
    // stop time has to be recovered from the GHA API later.
    const identity = githubRunIdentity();
    const row: Record<string, unknown> = {
      pipeline,
      status: "running",
      started_at: new Date().toISOString(),
    };
    if (Object.keys(identity).length > 0) row["metadata"] = identity;
    const { data, error } = await db
      .from("data_sync_log")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    inFlightLogIds.add(id);
    return id;
  } catch (err) {
    // Non-fatal: log but don't crash the pipeline
    console.warn("  [sync-log] Could not create log entry:", err instanceof Error ? err.message : err);
    return "";
  }
}

export async function completeSync(id: string, result: PipelineResult): Promise<void> {
  if (!id) return;
  inFlightLogIds.delete(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data: existing } = await db
      .from("data_sync_log")
      .select("metadata")
      .eq("id", id)
      .maybeSingle();
    const merged: Record<string, unknown> = {
      ...(existing?.metadata ?? {}),
      // FIX-911: caller metadata goes ABOVE the reserved keys so peak_rss_mb and
      // seed_warnings below always win.
      ...(result.metadata ?? {}),
      peak_rss_mb: captureRssMb(),
    };
    if (result.seed_warnings && result.seed_warnings.length > 0) {
      merged.seed_warnings = result.seed_warnings;
      merged.seed_warning_count = result.seed_warnings.length;
    }
    await db.from("data_sync_log").update({
      status: "complete",
      completed_at: new Date().toISOString(),
      rows_inserted: result.inserted,
      rows_updated:  result.updated,
      rows_failed:   result.failed,
      estimated_mb:  result.estimatedMb,
      metadata: merged,
    }).eq("id", id);
  } catch (err) {
    console.warn("  [sync-log] Could not update log entry:", err instanceof Error ? err.message : err);
  }
}

export async function failSync(id: string, errorMessage: string): Promise<void> {
  if (!id) return;
  inFlightLogIds.delete(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data: existing } = await db
      .from("data_sync_log")
      .select("metadata")
      .eq("id", id)
      .maybeSingle();
    const merged = { ...(existing?.metadata ?? {}), peak_rss_mb: captureRssMb() };
    await db.from("data_sync_log").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage.slice(0, 1000),
      metadata: merged,
    }).eq("id", id);
  } catch (err) {
    console.warn("  [sync-log] Could not fail log entry:", err instanceof Error ? err.message : err);
  }
}

// Mark a run as a deliberate no-op (Phase 2 skeleton, version-unchanged short-
// circuit, etc.). Distinct from `complete` so the dashboard can render skipped
// runs differently from real zero-row days.
export async function skipSync(id: string, reason: string): Promise<void> {
  if (!id) return;
  inFlightLogIds.delete(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data: existing } = await db
      .from("data_sync_log")
      .select("metadata")
      .eq("id", id)
      .maybeSingle();
    const merged = {
      ...(existing?.metadata ?? {}),
      skip_reason: reason,
      peak_rss_mb: captureRssMb(),
    };
    await db.from("data_sync_log").update({
      status: "skipped",
      completed_at: new Date().toISOString(),
      metadata: merged,
    }).eq("id", id);
  } catch (err) {
    console.warn("  [sync-log] Could not skip log entry:", err instanceof Error ? err.message : err);
  }
}

export async function getDbSizeMb(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data } = await db.rpc("get_database_size_bytes");
    return typeof data === "number" ? +(data / 1024 / 1024).toFixed(2) : 0;
  } catch {
    return 0;
  }
}

export async function getLastSync(pipeline: string): Promise<Date | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data } = await db
      .from("data_sync_log")
      .select("completed_at")
      .eq("pipeline", pipeline)
      .eq("status", "complete")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.completed_at ? new Date(data.completed_at) : null;
  } catch {
    return null;
  }
}
