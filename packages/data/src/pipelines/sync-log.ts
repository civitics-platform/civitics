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

export async function startSync(pipeline: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data, error } = await db
      .from("data_sync_log")
      .insert({ pipeline, status: "running", started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  } catch (err) {
    // Non-fatal: log but don't crash the pipeline
    console.warn("  [sync-log] Could not create log entry:", err instanceof Error ? err.message : err);
    return "";
  }
}

export async function completeSync(id: string, result: PipelineResult): Promise<void> {
  if (!id) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    await db.from("data_sync_log").update({
      status: "complete",
      completed_at: new Date().toISOString(),
      rows_inserted: result.inserted,
      rows_updated:  result.updated,
      rows_failed:   result.failed,
      estimated_mb:  result.estimatedMb,
    }).eq("id", id);
  } catch (err) {
    console.warn("  [sync-log] Could not update log entry:", err instanceof Error ? err.message : err);
  }
}

export async function failSync(id: string, errorMessage: string): Promise<void> {
  if (!id) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    await db.from("data_sync_log").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage.slice(0, 1000),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const { data: existing } = await db
      .from("data_sync_log")
      .select("metadata")
      .eq("id", id)
      .maybeSingle();
    const merged = { ...(existing?.metadata ?? {}), skip_reason: reason };
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
