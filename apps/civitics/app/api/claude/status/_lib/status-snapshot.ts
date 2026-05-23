/**
 * Status snapshot helpers — FIX-297.
 *
 * computeStatusPayload — runs the 11-section parallel block that
 *   /api/claude/status/core, /quality, and the dashboard SSR were each
 *   computing live on every request. Returns the assembled payload plus a
 *   query_time_ms scalar.
 *
 * writeStatusSnapshot — compute then INSERT one row into status_snapshot.
 *   Called by /api/cron/platform-snapshot every 10 min. Never throws;
 *   per-section failures produce a payload field with `{error, partial:true}`
 *   and an aggregate `error` field on the snapshot row.
 *
 * readStatusSnapshot — read most-recent row. Null if missing or empty.
 *
 * Mirrors the platform-snapshot.ts pattern from PR 1 (FIX-281), scaled to
 * status. Lives next to sections.ts (not in packages/db) because the section
 * helpers it composes live here; packages/db can't import from apps/civitics.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicUsage } from "@civitics/db";
import {
  type Db,
  section,
  getVersion,
  getDatabase,
  getConnectionTypes,
  getPipelines,
  getAiCosts,
  getActivity,
  getResourceWarnings,
  getOfficialsBreakdown,
  getQuality,
  getSelfTests,
  getChord,
} from "./sections";

// ── Shared staleness / timeout constants (FIX-327) ────────────────────────────
// Hoisted here so /dashboard SSR, /api/claude/status/{core,quality}, and
// /api/platform/usage all read the same numbers. Tuning history:
//   - FIX-297 set 30 min (three 10-min cron cycles).
//   - Prod observation 2026-05-22: GHA */10 cron drifts to 1h-3h35m gaps
//     under scheduler load — 30 min flipped most pageloads to a 30-s live
//     recompute path. Bumped to 4 h (covers 9 of last 10 observed gaps).
// The fallback cap was unbounded — any cold-cache stale-snapshot hit blocked
// SSR for whatever computeStatusPayload actually took (30+ s on prod).
export const SNAPSHOT_STALE_MS = 4 * 60 * 60 * 1000;
export const SNAPSHOT_FALLBACK_TIMEOUT_MS = 5000;

// ── Types ─────────────────────────────────────────────────────────────────────

type PartialError = { error: string; partial: true };
type Sectioned<T> = T | PartialError;

// Superset of all sections any consumer needs. The two routes + the dashboard
// each pluck the fields they care about; the snapshot stores everything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StatusPayload = {
  version: Sectioned<Awaited<ReturnType<typeof getVersion>>>;
  database: Sectioned<Awaited<ReturnType<typeof getDatabase>>>;
  connection_types: Sectioned<Awaited<ReturnType<typeof getConnectionTypes>>>;
  pipelines: Sectioned<Awaited<ReturnType<typeof getPipelines>>>;
  ai_costs: Sectioned<Awaited<ReturnType<typeof getAiCosts>>>;
  activity: Sectioned<Awaited<ReturnType<typeof getActivity>>>;
  resource_warnings: Sectioned<Awaited<ReturnType<typeof getResourceWarnings>>>;
  officials_breakdown: Sectioned<Awaited<ReturnType<typeof getOfficialsBreakdown>>>;
  quality: Sectioned<Awaited<ReturnType<typeof getQuality>>>;
  self_tests: Sectioned<Awaited<ReturnType<typeof getSelfTests>>>;
  chord: Sectioned<Awaited<ReturnType<typeof getChord>>>;
};

export type StatusComputeResult = {
  payload: StatusPayload;
  query_time_ms: number;
  // FIX-328: per-section wall-clock ms, keyed by the section identifier
  // (`version`, `database`, …). Captured by the inline timed() wrapper in
  // computeStatusPayload, persisted to status_snapshot.section_times.
  section_times: Record<string, number>;
  // Non-null when any section returned a {partial:true} result. Lists the
  // section keys that failed. Mirrors platform-snapshot's `error: string|null`
  // convention.
  error: string | null;
};

export type StatusSnapshotRow = {
  fetched_at: string;
  query_time_ms: number;
  payload: StatusPayload;
  section_times: Record<string, number> | null;
  error: string | null;
};

// ── Compute ───────────────────────────────────────────────────────────────────

export async function computeStatusPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<StatusComputeResult> {
  // ── Per-section parallel execution ──────────────────────────────────────────
  // Each section() wraps its function so failures become {error, partial:true}
  // values rather than throwing. The result tuple positions match the
  // assembly order below; do not reorder one without the other.
  const t0 = Date.now();
  const dbAsDb = db as unknown as Db;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // FIX-328: per-section wall-clock ms. Wraps each section() call so the
  // timing fires regardless of success/partial-failure — a section that
  // throws after 25 s matters just as much as one that returns slowly.
  // Lives here (not in section()) so the section helper's signature stays
  // the same across sections.ts's callers.
  //
  // FIX-332: same sectionTimes map is shared with the per-sub-op `collect`
  // callback passed into getSelfTests / checkDerivedDrift below — the
  // sub-op writes land under `self_tests:<op>` / `derived_drift:<rule>`
  // prefixes alongside the section-level keys, single source of truth.
  const sectionTimes: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const ts = Date.now();
    try {
      return await fn();
    } finally {
      sectionTimes[name] = Date.now() - ts;
    }
  };
  const collect = (key: string, ms: number) => {
    sectionTimes[key] = ms;
  };

  // FIX-332: hoist expensive calls that multiple sections were issuing
  // independently. Each runs once per payload; consumers `await` the
  // shared promise. `.then(r => r)` coerces the PostgrestBuilder to a
  // native Promise so multiple awaits resolve to the same value rather
  // than re-issuing the request — same pattern sections.ts already uses
  // for get_quality_counts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharedConnTypeCountsPromise = (dbAsDb as any)
    .rpc("get_connection_type_counts")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .then((r: any) => r);
  const sharedAnthropicUsagePromise = getAnthropicUsage();

  const [
    sectionVersion,
    sectionDatabase,
    sectionConnectionTypes,
    sectionPipelines,
    sectionAiCosts,
    sectionActivity,
    sectionResourceWarnings,
    sectionOfficialsBreakdown,
    sectionQuality,
    sectionSelfTests,
    sectionChord,
  ] = await Promise.all([
    section(() => timed("version", () => getVersion(dbAsDb))),
    section(() => timed("database", () => getDatabase(dbAsDb, yesterday))),
    section(() => timed("connection_types", () =>
      getConnectionTypes(dbAsDb, sharedConnTypeCountsPromise),
    )),
    section(() => timed("pipelines", () => getPipelines(dbAsDb))),
    section(() => timed("ai_costs", () =>
      getAiCosts(dbAsDb, monthStart, sharedAnthropicUsagePromise),
    )),
    section(() => timed("activity", () => getActivity(dbAsDb, yesterday))),
    section(() => timed("resource_warnings", () => getResourceWarnings(dbAsDb))),
    section(() => timed("officials_breakdown", () => getOfficialsBreakdown(dbAsDb))),
    section(() => timed("quality", () => getQuality(dbAsDb))),
    section(() => timed("self_tests", () =>
      getSelfTests(dbAsDb, {
        sharedConnTypeCountsPromise,
        sharedAnthropicUsagePromise,
        collect,
      }),
    )),
    section(() => timed("chord", () => getChord(dbAsDb))),
  ]);

  // ── Merged payload assembly ─────────────────────────────────────────────────
  // Different semantic contract from the per-section block: this region's
  // `payload` is the assembled JSONB written to the snapshot, and
  // `failedSections` is the list of *which* sections came back partial.
  // Distinct variable names (vs the sectionFoo above) keep the contracts
  // visibly separate — FIX-293 lesson about adjacent blocks sharing the
  // same `status` name with different meanings.
  const payload: StatusPayload = {
    version: sectionVersion as StatusPayload["version"],
    database: sectionDatabase as StatusPayload["database"],
    connection_types: sectionConnectionTypes as StatusPayload["connection_types"],
    pipelines: sectionPipelines as StatusPayload["pipelines"],
    ai_costs: sectionAiCosts as StatusPayload["ai_costs"],
    activity: sectionActivity as StatusPayload["activity"],
    resource_warnings: sectionResourceWarnings as StatusPayload["resource_warnings"],
    officials_breakdown: sectionOfficialsBreakdown as StatusPayload["officials_breakdown"],
    quality: sectionQuality as StatusPayload["quality"],
    self_tests: sectionSelfTests as StatusPayload["self_tests"],
    chord: sectionChord as StatusPayload["chord"],
  };

  const failedSections: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === "object" && "partial" in value) {
      failedSections.push(key);
    }
  }

  return {
    payload,
    query_time_ms: Date.now() - t0,
    section_times: sectionTimes,
    error: failedSections.length > 0 ? `partial: ${failedSections.join(", ")}` : null,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function writeStatusSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<StatusComputeResult> {
  const result = await computeStatusPayload(db);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  await anyDb.from("status_snapshot").insert({
    query_time_ms: result.query_time_ms,
    payload: result.payload,
    section_times: result.section_times,
    error: result.error,
  });

  return result;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function readStatusSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<StatusSnapshotRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  const { data } = await anyDb
    .from("status_snapshot")
    .select("fetched_at, query_time_ms, payload, section_times, error")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as StatusSnapshotRow | null;
}
