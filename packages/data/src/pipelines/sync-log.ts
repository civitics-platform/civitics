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
    const { data, error } = await db
      .from("data_sync_log")
      .insert({ pipeline, status: "running", started_at: new Date().toISOString() })
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
    const merged = { ...(existing?.metadata ?? {}), peak_rss_mb: captureRssMb() };
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
