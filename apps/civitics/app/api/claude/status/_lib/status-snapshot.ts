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
  getEcCrawlHealth,
  getDailyCounts,
} from "./sections";

// ── Shared staleness / timeout constants (FIX-327) ────────────────────────────
// Hoisted here so /dashboard SSR, /api/claude/status/{core,quality}, and
// /api/platform/usage all read the same numbers.
//
// FIX-1094 moved SNAPSHOT_STALE_MS itself (and its tuning history) to
// @/lib/snapshot-freshness, which has no imports and is therefore safe for the
// client bundle — DashboardClient's staleness cue needs the same number. This
// re-export keeps every existing server-side importer unchanged.
//
// The fallback cap was unbounded — any cold-cache stale-snapshot hit blocked
// SSR for whatever computeStatusPayload actually took (30+ s on prod).
export { SNAPSHOT_STALE_MS } from "@/lib/snapshot-freshness";
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
  // FIX-1114 — EC crawl lag/health. Optional so a snapshot written before this
  // shipped still type-checks when read back.
  ec_crawl_health?: Sectioned<Awaited<ReturnType<typeof getEcCrawlHealth>>>;
  // FIX-090 — 30-day daily series behind the stat-card sparklines. Optional for
  // the same reason: the one-tick-old payload predates this field and must still
  // render (the cards simply draw no sparkline).
  daily_counts?: Sectioned<Awaited<ReturnType<typeof getDailyCounts>>>;
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
    sectionEcCrawlHealth,
    sectionDailyCounts,
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
    section(() => timed("activity", () => getActivity(dbAsDb, 7))),
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
    section(() => timed("ec_crawl_health", () => getEcCrawlHealth(dbAsDb))),
    section(() => timed("daily_counts", () => getDailyCounts(dbAsDb))),
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
    ec_crawl_health: sectionEcCrawlHealth as StatusPayload["ec_crawl_health"],
    daily_counts: sectionDailyCounts as StatusPayload["daily_counts"],
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

/**
 * FIX-090 — persist today's point of the stat-card daily series.
 *
 * Runs from the same 10-min cron path that writes status_snapshot, and takes its
 * numbers from the payload that was JUST computed rather than re-querying: three
 * of the four metrics are already in hand, so the daily series costs one upsert
 * plus one small count, not a second pass over the database.
 *
 * The exception is `open_proposals`, which is genuinely not in the payload — the
 * Open Proposals card's headline is computed in dashboard/page.tsx
 * (getOpenProposalCount, FIX-1077: exact, measured 32 ms on prod). The series has
 * to agree with the number printed above it, so the recorder issues that one
 * count itself rather than substituting total proposals, which is a different
 * quantity and would make the trend contradict the card.
 *
 * ONLY MEASURED METRICS ARE WRITTEN. A section that came back partial is omitted
 * from the upsert payload entirely, so PostgREST's ON CONFLICT DO UPDATE touches
 * only the columns present and a bad tick leaves yesterday's good value alone
 * instead of overwriting it with a null or a zero.
 *
 * Best-effort: a failure here must never lose the status snapshot, which is the
 * more important write and is what the whole dashboard reads.
 */
async function recordDailyCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  payload: StatusPayload,
): Promise<Record<string, number> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  // UTC — matches the DATE column and the CURRENT_DATE the backfill used.
  const day = new Date().toISOString().slice(0, 10);

  const database = payload.database;
  const chord = payload.chord;
  const dbOk = database && typeof database === "object" && !("partial" in database);
  const chordOk = chord && typeof chord === "object" && !("partial" in chord);

  const metrics: Record<string, number> = {};
  if (dbOk) {
    metrics["officials"] = (database as { officials: number }).officials;
    metrics["votes"] = (database as { votes: number }).votes;
  }
  if (chordOk) {
    metrics["donation_flow_usd"] = (chord as { total_flow_usd: number }).total_flow_usd;
  }

  // The one metric the payload does not carry. Mirrors getOpenProposalCount()
  // in dashboard/page.tsx exactly — same predicate, same exact count.
  try {
    const { count, error } = await anyDb
      .from("proposals")
      .select("*", { count: "exact", head: true })
      .eq("status", "open_comment")
      .gt("metadata->>comment_period_end", new Date().toISOString());
    if (!error && typeof count === "number") metrics["open_proposals"] = count;
  } catch {
    // Leave the column untouched for today rather than recording a wrong value.
  }

  if (Object.keys(metrics).length === 0) return null;

  const { error } = await anyDb
    .from("daily_platform_counts")
    .upsert({ day, ...metrics, source: "observed", recorded_at: new Date().toISOString() }, {
      onConflict: "day",
    });
  if (error) {
    console.warn(`[daily counts] upsert failed for ${day}: ${error.message}`);
    return null;
  }
  return metrics;
}

export async function writeStatusSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<StatusComputeResult> {
  const result = await computeStatusPayload(db);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  // FIX-090 — record today's point, then fold it into the series this snapshot
  // is about to persist. Order matters: getDailyCounts ran during compute, i.e.
  // BEFORE today's row existed, so without this patch the persisted series would
  // always trail the headline numbers sitting beside it in the same payload. The
  // patch makes each snapshot internally consistent — the sparkline's right-hand
  // endpoint is by construction the number the card prints.
  let recorded: Record<string, number> | null = null;
  try {
    recorded = await recordDailyCounts(db, result.payload);
  } catch (err) {
    console.warn(`[daily counts] recorder threw: ${err instanceof Error ? err.message : err}`);
  }
  if (recorded) {
    const series = result.payload.daily_counts;
    if (series && typeof series === "object" && !("partial" in series)) {
      const today = new Date().toISOString().slice(0, 10);
      for (const [metric, value] of Object.entries(recorded)) {
        const s = (series as Record<string, { days: string[]; values: number[] }>)[metric];
        if (!s) continue;
        const at = s.days.indexOf(today);
        if (at >= 0) s.values[at] = value;
        else {
          s.days.push(today);
          s.values.push(value);
        }
      }
    }
  }

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
