/**
 * Status snapshot helpers — FIX-297.
 *
 * computeStatusPayload — runs the 13-section block that
 *   /api/claude/status/core, /quality, and the dashboard SSR were each
 *   computing live on every request. Returns the assembled payload plus a
 *   query_time_ms scalar. Fan-out is bounded at SECTION_CONCURRENCY since
 *   FIX-1121 — running all 13 at once was starving the sections' own queries.
 *
 * writeStatusSnapshot — compute then INSERT one row into status_snapshot.
 *   Called by /api/cron/platform-snapshot every 30 min (Vercel cron since
 *   FIX-1127; a nominally ten-minute GHA schedule before that, which really
 *   fired about every 6 h). Never throws;
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
import { mapWithConcurrency } from "@/lib/concurrency";
import { metricValue } from "@/lib/section-failures";
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

/**
 * FIX-1120 — cap for the ONE remaining live recompute: a request that finds no
 * status_snapshot row at all. SNAPSHOT_FALLBACK_TIMEOUT_MS (5 s) cannot serve
 * that purpose, because computeStatusPayload measurably costs 8.9–18.8 s on
 * prod (query_time_ms across all ten retained ticks, 2026-08-29: 8863, 9260,
 * 10090, 10569, 10806, 11040, 12401, 12464, 17760, 18753). A 5 s cap in front
 * of that is not a timeout, it is an unconditional failure dressed as one.
 *
 * 30 s clears the worst measured tick by ~1.6x and sits under the routes'
 * `maxDuration = 60`, so the 503 written for this case is actually reachable
 * instead of the function being killed mid-flight.
 */
export const SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS = 30_000;

/**
 * FIX-1121 — how many sections may be in flight at once.
 *
 * The payload used to start all 13 sections simultaneously, and getDatabase's
 * eleven counts were only a fraction of the PostgREST requests racing each
 * other on a Small instance. The cost of that contention is measurable and it
 * is not the queries: `SELECT count(*) FROM votes` is 261 ms via psql and
 * 555 ms through PostgREST, and a faithful replay of getDatabase's whole
 * 11-way fan-out from outside the lambda finished in 559 ms. Inside
 * computeStatusPayload the same section took 8266–9165 ms on every failing
 * tick — i.e. it ran into the authenticator role's 8 s statement_timeout — and
 * 693 ms on the one tick that came back clean.
 *
 * 4 comes from the section_times evidence: five sections dominate (quality
 * 10.8–18.7 s, self_tests 9.9–10.8 s, database 8.5–9.2 s [contention-inflated],
 * pipelines 6.4–9.0 s, ai_costs 4.6–7.2 s) and the other eight are all under
 * 1 s. A bound of 4 keeps the heavy five from ever overlapping completely
 * while still packing the cheap eight into the gaps.
 *
 * This is a write-path change: computeStatusPayload runs from a scheduled cron
 * (30 min since FIX-1127), which is latency-tolerant. Since FIX-1120 the
 * request path recomputes only when there is no snapshot row at all.
 *
 * FIX-1126 added a second bound one level down — getDatabase's own eleven
 * counts, see DATABASE_COUNT_CONCURRENCY in sections.ts. The two compose: this
 * one caps how many sections overlap, that one caps what the heaviest section
 * does inside its slot. SECTION_CONCURRENCY deliberately did NOT move.
 */
const SECTION_CONCURRENCY = 4;

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
  // FIX-1121: both shared promises are started eagerly and deliberately stay
  // OUTSIDE the limiter — several sections await them, and gating them behind a
  // concurrency slot risks a section holding a slot while waiting on a promise
  // that cannot start. Because the sections that await them may now be queued
  // rather than running immediately, attach a no-op rejection handler so a
  // rejection while queued can't surface as an unhandledRejection. The original
  // promises still reject for whichever section awaits them, so a failure is
  // still reported through that section's own `partial` result.
  void sharedConnTypeCountsPromise.catch(() => {});
  void sharedAnthropicUsagePromise.catch(() => {});

  // FIX-1121: bounded fan-out. Ordered longest-pole-first (quality, self_tests,
  // database, pipelines, ai_costs — the only five over 1 s) so the heavy work
  // starts immediately and the sub-second sections fill the gaps as slots free
  // up; a naive declaration-order walk would leave quality to start last and
  // stretch the tail by its own full duration. Payload assembly is keyed by
  // name below, so this order is free to change with the evidence.
  const sectionTasks: Array<[keyof StatusPayload, () => Promise<unknown>]> = [
    ["quality", () => timed("quality", () => getQuality(dbAsDb))],
    ["self_tests", () => timed("self_tests", () =>
      getSelfTests(dbAsDb, {
        sharedConnTypeCountsPromise,
        sharedAnthropicUsagePromise,
        collect,
      }),
    )],
    ["database", () => timed("database", () => getDatabase(dbAsDb, yesterday))],
    ["pipelines", () => timed("pipelines", () => getPipelines(dbAsDb))],
    ["ai_costs", () => timed("ai_costs", () =>
      getAiCosts(dbAsDb, monthStart, sharedAnthropicUsagePromise),
    )],
    ["connection_types", () => timed("connection_types", () =>
      getConnectionTypes(dbAsDb, sharedConnTypeCountsPromise),
    )],
    ["chord", () => timed("chord", () => getChord(dbAsDb))],
    ["daily_counts", () => timed("daily_counts", () => getDailyCounts(dbAsDb))],
    ["activity", () => timed("activity", () => getActivity(dbAsDb, 7))],
    ["officials_breakdown", () => timed("officials_breakdown", () =>
      getOfficialsBreakdown(dbAsDb),
    )],
    ["resource_warnings", () => timed("resource_warnings", () =>
      getResourceWarnings(dbAsDb),
    )],
    ["ec_crawl_health", () => timed("ec_crawl_health", () => getEcCrawlHealth(dbAsDb))],
    ["version", () => timed("version", () => getVersion(dbAsDb))],
  ];

  const resolved = await mapWithConcurrency(sectionTasks, SECTION_CONCURRENCY, ([, run]) =>
    section(run),
  );
  const byKey = Object.fromEntries(
    sectionTasks.map(([key], i) => [key, resolved[i]]),
  ) as Record<keyof StatusPayload, unknown>;

  // ── Merged payload assembly ─────────────────────────────────────────────────
  // Different semantic contract from the per-section block: this region's
  // `payload` is the assembled JSONB written to the snapshot, and
  // `failedSections` is the list of *which* sections came back partial.
  // Distinct variable names (vs the sectionFoo above) keep the contracts
  // visibly separate — FIX-293 lesson about adjacent blocks sharing the
  // same `status` name with different meanings.
  const payload: StatusPayload = {
    version: byKey.version as StatusPayload["version"],
    database: byKey.database as StatusPayload["database"],
    connection_types: byKey.connection_types as StatusPayload["connection_types"],
    pipelines: byKey.pipelines as StatusPayload["pipelines"],
    ai_costs: byKey.ai_costs as StatusPayload["ai_costs"],
    activity: byKey.activity as StatusPayload["activity"],
    resource_warnings: byKey.resource_warnings as StatusPayload["resource_warnings"],
    officials_breakdown: byKey.officials_breakdown as StatusPayload["officials_breakdown"],
    quality: byKey.quality as StatusPayload["quality"],
    self_tests: byKey.self_tests as StatusPayload["self_tests"],
    chord: byKey.chord as StatusPayload["chord"],
    ec_crawl_health: byKey.ec_crawl_health as StatusPayload["ec_crawl_health"],
    daily_counts: byKey.daily_counts as StatusPayload["daily_counts"],
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
 * Runs from the same 30-min cron path that writes status_snapshot, and takes its
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
  const chordOk = chord && typeof chord === "object" && !("partial" in chord);

  // FIX-1121 — gate each metric on ITS OWN count, not on the whole section.
  // Before this, one failed count anywhere in getDatabase's eleven (in practice
  // always `votes`) withheld BOTH officials and votes, so the series stalled on
  // the ~90% of ticks that came back partial. `metricValue` returns null for a
  // count that failed — including on a pre-FIX-1121 payload, where the failed
  // list is unknown and every metric is therefore withheld exactly as before.
  const officials = metricValue(database, "officials");
  const votes = metricValue(database, "votes");

  const metrics: Record<string, number> = {};
  if (officials !== null) metrics["officials"] = officials;
  if (votes !== null) metrics["votes"] = votes;
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

  // FIX-1122 — `source` is sent only when the counts that define it were
  // actually observed on THIS tick. On a tick that withheld officials or votes
  // the row keeps its reconstructed backfill values for them, so stamping
  // 'observed' anyway would label reconstructed numbers as observed. Omitting
  // the key leaves the stored value standing, because PostgREST's ON CONFLICT
  // DO UPDATE only touches columns present in the payload.
  //
  // FIX-1121 refines the gate from section-level to metric-level but keeps
  // FIX-1122's rule intact: one row-level label can only honestly say
  // "observed" when BOTH of the metrics it describes were measured here.
  const row: Record<string, unknown> = {
    day,
    ...metrics,
    recorded_at: new Date().toISOString(),
  };
  if (officials !== null && votes !== null) row["source"] = "observed";

  const { error } = await anyDb
    .from("daily_platform_counts")
    .upsert(row, { onConflict: "day" });
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
