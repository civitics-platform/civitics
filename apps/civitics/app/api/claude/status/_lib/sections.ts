// Section helpers shared by /api/claude/status, /core, /quality.
// Each helper does one logical section of the platform health response.
// Errors are wrapped with `section()` at the call site, never thrown out.

import {
  calculateLoggedCostUsd,
  createAdminClient,
  getAnthropicUsage,
  type AnthropicUsageResponse,
} from "@civitics/db";
import { concurrencyGate } from "@/lib/concurrency";
import { fetchAllRows } from "@/lib/paginate";
import { countFailureFields } from "@/lib/section-failures";
import {
  fetchPipelineRuntimeStats,
  toPublicRuntimeStats,
  type PublicPipelineRuntimeStat,
} from "@/lib/pipeline-runtime-stats";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = ReturnType<typeof createAdminClient> & Record<string, any>;

// FIX-332: Shared resolved RPC / API call shapes hoisted out of section scope
// in computeStatusPayload so multiple sections can await one promise instead
// of each re-issuing the same call. The {data,error} shape mirrors the raw
// Supabase RPC return; callers fall back to issuing the call themselves when
// the optional promise is undefined (matters for tests + future surfaces).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SharedConnTypeCountsPromise = Promise<{ data: any; error: any }>;
export type SharedAnthropicUsagePromise = Promise<AnthropicUsageResponse>;

// FIX-332: per-op timing collector. Same shape as the sectionTimes record
// computeStatusPayload threads through `timed()` at section level — the
// helpers below write under prefixed keys (e.g. `self_tests:warren_search`,
// `derived_drift:donation`) into the same map.
export type TimingCollect = (key: string, ms: number) => void;

export const CONNECTION_TYPES = [
  "donation",
  "vote_yes",
  "vote_no",
  "vote_abstain",
  "nomination_vote_yes",
  "nomination_vote_no",
  "appointment",
  "revolving_door",
  "oversight",
  "lobbying",
  "co_sponsorship",
  "family",
  "business_partner",
  "legal_representation",
  "endorsement",
  "contract_award",
] as const;

// ── Self-test thresholds (FIX-1093 / FIX-1094) ───────────────────────────────
//
// Every number here is a floor with measured headroom, not a target. Each one
// records what it was measured against so the next person can tell a genuine
// regression from a threshold that drifted out from under the data.

// Per-senator vote_yes edge floor. A sample of 15 sitting senators (2026-05-23)
// ranged 38–785 edges with a median around 640, so 10 clears even the newest
// junior senator by ~4x. The failure it exists to catch is the opposite shape
// entirely: a resolver bug that lands votes on FEC candidate stubs instead of
// the elected row leaves ≤6 edges, which trips this immediately.
const SENATE_MIN_VOTE_EDGES = 10;
// Cohort floor. Measured 99 of 100 clearing the edge floor on BOTH local and
// prod (2026-08-22) — one senator legitimately sits below it. 50 is half the
// chamber: survivable roster churn and a seated-mid-term senator or two, but a
// resolver-class regression that strands votes on stubs collapses the count far
// past it in one rebuild.
const SENATE_COVERAGE_FLOOR = 50;
// How many comment-period cards /dashboard renders. The count must never come
// back below the number of cards actually shown — see open_comment_count_sane.
const OPEN_COMMENT_CARD_LIMIT = 3;
// entity_search_index is rebuilt nightly; 26 h is the standard one-cycle + 2 h
// slack window used throughout this codebase for daily work.
const SEARCH_INDEX_STALE_MS = 26 * 60 * 60 * 1000;
// 14 days, because a `0 16 * * 1,3` job fires twice a week — a 26 h window can
// only ever contain one of its firings, so "consecutive" is unanswerable there.
// Prod pg_cron history retains ~55 days, so this sits well inside retention.
const CRON_STREAK_LOOKBACK_HOURS = 336;
// Two consecutive failed firings. One is noise (the every-2-minute watchdogs
// logged 169 startup timeouts on 2026-08-19 and recovered fully); two in a row
// is a job that is stuck.
const CRON_MIN_FAIL_STREAK = 2;

export const VOTE_CATEGORIES = [
  "substantive",
  "procedural",
  "nomination",
  "treaty",
  "amendment",
] as const;

export async function section<T>(
  fn: () => Promise<T>,
): Promise<T | { error: string; partial: true }> {
  try {
    return await fn();
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      partial: true as const,
    };
  }
}

// ── 1. Platform version ──────────────────────────────────────────────────────
export async function getVersion(db: Db) {
  // FIX-833: NULLS LAST — an in-flight or stranded status='running' row has a
  // NULL completed_at, which under `.order(completed_at desc)` sorts FIRST in
  // Postgres (NULLS FIRST default) and would blank out latest_sync_at. Prefer
  // the newest row that actually completed.
  const latestSync = await db
    .from("data_sync_log")
    .select("pipeline, completed_at, status")
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return {
    commit_sha: process.env["VERCEL_GIT_COMMIT_SHA"] ?? "local",
    env: process.env["VERCEL_ENV"] ?? "development",
    latest_sync_at: latestSync.data?.completed_at ?? null,
    latest_pipeline: latestSync.data?.pipeline ?? null,
  };
}

// ── 2. Row counts ────────────────────────────────────────────────────────────
//
/**
 * FIX-1126 — how many of getDatabase's own counts may be in flight at once.
 *
 * FIX-1121 bounded computeStatusPayload's SECTION fan-out to 4 and that did cut
 * total compute (8.9–18.8 s → 8638 ms), but on the very next prod tick
 * (2026-08-29 20:13:58) the database section still measured 8304 ms and still
 * came back `failed: ['votes']` — i.e. still starved against the authenticator
 * role's 8 s statement_timeout. So the section-level bound bought latency, not
 * reliability, and the remaining contention is one level down: these eleven
 * counts were themselves an unbounded Promise.all.
 *
 * That the queries are not the problem is measured, not assumed: the votes count
 * is 261 ms via psql, 555 ms through PostgREST, and a faithful replay of this
 * entire 11-way fan-out from outside the lambda finished in 559 ms.
 *
 * 3 is sized off the section's own budget rather than off throughput. The counts
 * do not need to race each other — worst case is ceil(11/3) = 4 waves × ~555 ms
 * ≈ 2.2 s, which is far inside the section budget and leaves the slowest single
 * count nowhere near an 8 s timeout even if it runs alongside the other three
 * sections SECTION_CONCURRENCY permits.
 *
 * This is a write-path constant. It is not a fix that can be declared working
 * from one tick — FIX-1126 stays open until the post-FIX-1127 tick stream
 * (~48/day) shows whether `database.failed` actually goes to zero.
 */
const DATABASE_COUNT_CONCURRENCY = 3;

// ── FIX-1146: the count cache ────────────────────────────────────────────────
//
// `platform_counts` holds one EXACT count per metric, refreshed once a day by
// refresh_platform_counts() on the platform-counts-daily pg_cron job. Reading it
// is a primary-key scan of ~14 rows.
//
// Scalars are stored under their own metric name; the one map-valued metric,
// `vote_category_counts`, is stored one row per category under a
// `vote_category:` prefix so the table can stay (metric, bigint). This helper
// reassembles it.
const VOTE_CATEGORY_PREFIX = "vote_category:";

type PlatformCounts = {
  values: Map<string, number>;
  voteCategories: Record<string, number>;
  /** When the cached numbers were taken; null if the cache is unreadable or unfilled. */
  countedAt: string | null;
};

async function readPlatformCounts(db: Db): Promise<PlatformCounts> {
  const empty: PlatformCounts = { values: new Map(), voteCategories: {}, countedAt: null };
  const { data, error } = await db
    .from("platform_counts")
    .select("metric, value, counted_at");
  // No throw: an unreadable cache degrades to "not yet counted" on the cards
  // that depend on it, exactly as a failed count did before, and must not take
  // the whole database/quality section down with it.
  if (error || !data) return empty;

  const values = new Map<string, number>();
  const voteCategories: Record<string, number> = {};
  let countedAt: string | null = null;

  for (const row of data as Array<{ metric: string; value: number | string; counted_at: string }>) {
    const n = Number(row.value);
    if (row.metric.startsWith(VOTE_CATEGORY_PREFIX)) {
      voteCategories[row.metric.slice(VOTE_CATEGORY_PREFIX.length)] = n;
    } else {
      values.set(row.metric, n);
    }
    // Every row of a given pass shares one counted_at; take the newest so a
    // partially-rewritten cache reports the age of its freshest number rather
    // than silently claiming the older one.
    if (countedAt === null || row.counted_at > countedAt) countedAt = row.counted_at;
  }

  return { values, voteCategories, countedAt };
}

// Mode rationale (FIX-206): unfiltered count(*) on proposals / votes /
// financial_relationships saturates the PostgREST request budget on Vercel
// when fired alongside 9 other parallel queries — locally the same queries
// return in <1 s, on prod they returned 0 with a swallowed error. Switching
// big-table unfiltered counts to "estimated" reads pg_class.reltuples (no
// scan, sub-200 ms) and gives accurate-enough numbers for hero stats.
//   • estimated  → unfiltered counts on tables ≥100 k rows
//   • planned    → filtered counts that timeout (proposals_bills)
//   • exact      → filtered counts cheap enough not to time out
//                  (proposals_regulations, page_views_24h)
//
// FIX-1095 — the three HEADLINE counts are now exact, and FIX-206's reasoning is
// why they had to change rather than why they shouldn't.
//
// "estimated" reads pg_class.reltuples, which is not a count: it is whatever the
// last vacuum/analyze wrote, and it goes stale in exactly one direction after a
// bulk DELETE. Measured on prod 2026-08-22, after the vote-stub retirement
// deletions:
//
//     votes      reltuples 1,270,118   count(*) 969,302   (+31.0% overstated)
//     proposals  reltuples    89,899   count(*)  90,201   (-0.3%)
//     officials  reltuples    37,234   count(*)  37,234   (exact)
//
// The Votes stat card and the "What Civitics Tracks" line had been quoting
// 1.27 M against a true 969 k. A transparency dashboard that overstates its own
// corpus by a third is worse than one that takes an extra three seconds to
// build, and the constraint FIX-206 was written under no longer applies: since
// FIX-297 this runs inside /api/cron/platform-snapshot on a scheduled tick
// (30 min on Vercel cron since FIX-1127), not on the request path, where the
// whole payload already takes 30+ s. Exact costs (prod, same session): votes
// 3.38 s, proposals 2.35 s, officials 0.18 s.
//
// The remaining "estimated" counts stay estimated: they are append-mostly, so
// reltuples does not drift the way a bulk-deleted table does, and
// entity_connections / financial_relationships are 5 M+ rows where an exact
// count is genuinely expensive. Revisit any of them individually if a large
// delete ever lands on one — the tell is this same reltuples-vs-count gap.
//
// FIX-1146 SUPERSEDES BOTH PARAGRAPHS ABOVE, and Craig's 2026-09-04 decision is
// why. Eight of these eleven counts no longer run here at all: they are read
// from `platform_counts`, which refresh_platform_counts() fills with EXACT
// counts once a day. What that costs is freshness — the numbers are up to a day
// old, and the page says so via `counts_as_of`. What it buys, measured on prod
// over 2026-08-29..09-04: 5,806 s of execution in 7 days becomes one 14-row
// primary-key read per tick.
//
// FIX-1095's finding is not reversed, only its remedy. reltuples is still not a
// count and still overstated votes by 31%; the difference is that the exact
// count is now taken daily instead of 48 times a day. And the "revisit if a
// large delete lands" tell above is retired rather than ignored — every cached
// metric IS a count, so there is no reltuples gap left to watch.
//
// Still computed live here, deliberately: the two `planned` proposals counts
// (planner estimates, no scan, FIX-503) and `page_views_24h` (a rolling 24-hour
// filtered count, so a daily snapshot would answer a different question).
//
// NOTE: the per-request SSR fallback path (dashboard/page.tsx, the two status
// routes) calls the same helper. It used to pay the full exact-count cost on a
// cold snapshot; it now pays the cache read. That path is capped by
// SNAPSHOT_FALLBACK_TIMEOUT_MS and degrades to the last-known-good snapshot
// either way, so the change only removes seconds it never needed to spend.
export async function getDatabase(db: Db, yesterday: string) {
  const gate = concurrencyGate(DATABASE_COUNT_CONCURRENCY);
  const [counts, proposalsBills, proposalsRegs, views] = await Promise.all([
    // FIX-1146: eight of the eleven counts are now one primary-key read.
    readPlatformCounts(db),
    gate(() =>
      db
        .from("proposals")
        .select("*", { count: "planned", head: true })
        .in("type", ["bill", "resolution", "amendment"]),
    ),
    gate(() =>
      db
        // FIX-503: status-page tile — 'planned' (planner estimate) is plenty
        // accurate and avoids an exact count over all regulation rows.
        .from("proposals")
        .select("*", { count: "planned", head: true })
        .eq("type", "regulation"),
    ),
    gate(() =>
      db
        .from("page_views")
        .select("*", { count: "exact", head: true })
        .gt("viewed_at", yesterday)
        .eq("is_bot", false),
    ),
  ]);

  // A metric absent from the cache — the read failed, or the first
  // platform-counts-daily firing has not happened yet — is reported through the
  // EXISTING failure vocabulary (FIX-1121 `failed`), not as a 0. A consumer
  // already knows to blank the one card that failed, and blanking is what "not
  // yet counted" should look like; a 0 would assert the platform tracks
  // nothing, the same lie FIX-090's NULL-vs-0 rule exists to prevent.
  const cached = (metric: string) => ({ count: counts.values.get(metric) ?? null });
  const officials  = cached("officials");
  const proposals  = cached("proposals");
  const votes      = cached("votes");
  const connections = cached("entity_connections");
  const finRel     = cached("financial_relationships");
  const finEnt     = cached("financial_entities");
  const tags       = cached("entity_tags");
  const cache      = cached("ai_summary_cache");

  // Surface partial state if any count failed (don't silently show 0).
  //
  // FIX-1121 — `errored` is now also published as `failed` (see
  // countFailureFields). `partial` and `error` keep their exact prior meaning:
  // computeStatusPayload's failedSections list and the status_snapshot.error
  // column both key off `partial`, and a snapshot written before this shipped
  // must keep rendering the way it always did. The addition is what lets a
  // consumer blank the ONE card whose count failed instead of all four.
  const errored = [
    officials.count === null && "officials",
    proposals.count === null && "proposals",
    proposalsBills.error && "proposals_bills",
    proposalsRegs.error && "proposals_regulations",
    votes.count === null && "votes",
    connections.count === null && "entity_connections",
    finRel.count === null && "financial_relationships",
    finEnt.count === null && "financial_entities",
    tags.count === null && "entity_tags",
    cache.count === null && "ai_summary_cache",
    views.error && "page_views_24h",
  ].filter(Boolean) as string[];

  return {
    officials: officials.count ?? 0,
    proposals: proposals.count ?? 0,
    proposals_bills: proposalsBills.count ?? 0,
    proposals_regulations: proposalsRegs.count ?? 0,
    votes: votes.count ?? 0,
    entity_connections: connections.count ?? 0,
    financial_relationships: finRel.count ?? 0,
    financial_entities: finEnt.count ?? 0,
    entity_tags: tags.count ?? 0,
    ai_summary_cache: cache.count ?? 0,
    page_views_24h: views.count ?? 0,
    // FIX-1146 — when the cached counts were taken, ISO-8601, or null before
    // the first refresh. The page renders "as of HH:MM UTC" from it: a cached
    // number whose age is invisible is worse than a slow one. Flows into
    // status_snapshot automatically, since StatusPayload.database is inferred
    // from this return type.
    counts_as_of: counts.countedAt,
    ...countFailureFields(errored),
  };
}

// ── 3. Connection type breakdown ─────────────────────────────────────────────
//
// FIX-298: single GROUP BY scan via get_connection_type_counts() RPC,
// replacing a 16-iteration count:'exact' fan-out that was the 9.5 s long
// pole of /api/claude/status/core on 5.1 M rows. The RPC sorts DESC by
// total; we still emit every CONNECTION_TYPES entry (zero-filled if the
// RPC didn't return a row for it) so the dashboard's per-type bars don't
// disappear when a type has no edges yet.
export async function getConnectionTypes(
  db: Db,
  sharedConnTypeCountsPromise?: SharedConnTypeCountsPromise,
) {
  const { data, error } = sharedConnTypeCountsPromise
    ? await sharedConnTypeCountsPromise
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : await (db as any).rpc("get_connection_type_counts");
  if (error) throw new Error(error.message ?? "get_connection_type_counts RPC error");

  type Row = { connection_type: string; total: number | string };
  const byType = new Map<string, number>();
  for (const r of (data ?? []) as Row[]) {
    byType.set(r.connection_type, Number(r.total));
  }
  return CONNECTION_TYPES
    .map((ct) => ({ connection_type: ct, count: byType.get(ct) ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

// ── 4. Pipeline status ───────────────────────────────────────────────────────
//
// Returns enough state for the unified Data Health card on /dashboard:
//   - recent_runs: latest 10 (kept for back-compat / quick "last sync" reads)
//   - cron_last_run: nightly cron summary blob
//   - history: per-pipeline last 7 runs (newest first), bucketed per pipeline
//     so every registered pipeline that ran in the lookback window appears
//     reliably — not just whichever ones happened to land in a global LIMIT
//   - enrichment_backlog: enrichment_queue depth split by pending tag /
//     pending summary / processing / stale processing (fall back to zeros if
//     unavailable so a missing/renamed table doesn't black out the whole
//     pipelines card)
//
// FIX-924 — the status vocabulary here was wrong, and the comment that used to
// sit on this line is why. It said the table was "from FIX-101 stage 1 schema".
// It is not. `.from("enrichment_queue")` resolves to public.enrichment_queue
// (migration 20260420030000_enrichment_queue.sql, FIX-064), whose vocabulary is
// pending | processing | done | failed, plus skipped_no_source_text and
// skipped_feature_retired (FIX-895/896). `in_progress` belongs to
// shadow.enrichment_queue from the stage-1 schema (20260421000006) — a table
// that DOES NOT EXIST in the database: exactly one relation named
// enrichment_queue exists across every schema, in public, and the `shadow`
// schema itself is gone (promoted to public at the 2026-04-22 cutover).
// So the third count matched a value no row can hold, the tile read
// "queue idle" from day one, and 44 abandoned `processing` claims sat invisible
// on it for three months — invisible to pending_tag/pending_summary (they are
// not pending) and to in_progress (it never existed).
//
// Window + bucketing rationale (FIX-381): the pre-fix shape used a global
// `ORDER BY completed_at DESC LIMIT 100` which the high-frequency writers
// (regulations, congress_officials, openstates_bulk_people, fec_bulk, …)
// monopolized — sparser pipelines like tiger_districts (annual) fell out of
// the window even when their last run was healthy and visible in
// pipeline_runtime_stats_mv. The new shape:
//   • 14-month time bound covers annual cadence + 2-month grace
//   • multi-column ORDER lets us scan (pipeline ASC, completed_at DESC) so
//     bucketing keeps the right 7 rows per pipeline as we walk
//   • 3000-row safety limit: prod audit (2026-05-25) showed ~322 rows in
//     90 days across ~30 pipelines → ~1500 in 14 months, well under 3000
//
// The per-group LIMIT could move into a Postgres RPC (PARTITION BY +
// ROW_NUMBER) if the row count keeps growing — current shape stays cheap
// enough that an RPC isn't warranted.
export type PipelineHistoryRun = {
  pipeline: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  estimated_mb: number;
  error_message: string | null;
  // FIX-386 writes seed warnings (non-fatal) into metadata.seed_warnings; the
  // Data Health card renders them as a yellow sub-status (FIX-390). Kept loose
  // because data_sync_log.metadata is a free-form JSONB blob across pipelines.
  metadata?: Record<string, unknown> | null;
};

// Wrapper-bookkeeping rows that write to data_sync_log but aren't operator-
// facing pipelines. Filtered out server-side here (rather than client-side in
// DashboardClient.tsx) so any other consumer of getPipelines() inherits the
// same exclusion. Add new entries only for wrappers — never for real
// pipelines that happen to be misnamed; fix those at the writer instead.
//   • nightly_cron  — runNightlySync() completion row
//   • canary_check  — daily canary that verifies nightly_cron rows exist
const HIDDEN_PIPELINES = new Set<string>([
  "canary_check",
  "nightly_cron",
]);

/**
 * FIX-924 — how old a `processing` claim has to be before the dashboard calls it
 * abandoned. Minutes.
 *
 * The semantic is "long enough that a live drain wave never trips it", NOT
 * "the operator's reclaim threshold". Deliberately looser than
 * `data:drain:status`'s 10-minute default: that script answers "what can I
 * reclaim right now", this number answers "does this look abandoned". A wave of
 * 12 subagents chewing 60-item batches finishes well inside an hour, so 60
 * minutes never fires on healthy work while still catching the orphan class
 * that motivated this fix (44 claims stranded since April).
 *
 * It governs only the WARN. `processing` is reported unconditionally — hiding a
 * stale claim behind a threshold would reproduce the invisibility this fix
 * exists to remove.
 */
export const ENRICHMENT_STALE_CLAIM_MINUTES = 60;

export async function getPipelines(db: Db) {
  // ISO timestamp 14 months ago. Calculated as 14 × 30 days to avoid
  // month-boundary off-by-ones; close enough — the bound is a safety net,
  // not the source of truth for cadence freshness (that lives client-side
  // per-pipeline; see apps/civitics/app/dashboard/DashboardClient.tsx).
  const fourteenMonthsAgo = new Date(
    Date.now() - 14 * 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const staleClaimCutoff = new Date(
    Date.now() - ENRICHMENT_STALE_CLAIM_MINUTES * 60 * 1000,
  ).toISOString();

  const [recentRunsRes, cronState, queueResults, runtimeStatRows] = await Promise.all([
    // FIX-476 — 14 months of run history across ~30 pipelines exceeds PostgREST
    // max_rows (1000), and the prior `.limit(3000)` never raised that ceiling, so
    // pipelines late in the (pipeline ASC) ordering lost all run history once the
    // 1000-row cap was consumed. Page the full set with a unique tiebreaker (id)
    // appended to the existing sort so `.range()` paging is stable.
    (async () => {
      const { rows } = await fetchAllRows<Record<string, unknown>>((f, t) =>
        db
          .from("data_sync_log")
          .select(
            "pipeline, status, started_at, completed_at, rows_inserted, rows_updated, rows_failed, estimated_mb, error_message, metadata",
          )
          .gt("completed_at", fourteenMonthsAgo)
          // OFFSET (FIX-984 exception): grouped by pipeline then newest-first
          // within it, with `id` as the tiebreak -- a three-column composite the
          // consumer depends on, so there is no single column to seek on. The
          // window is 14 months of data_sync_log (2,488 rows total on prod), so
          // the walk is a couple of pages. Order is total.
          .order("pipeline", { ascending: true })
          .order("completed_at", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(f, t),
        { maxRows: 50000 },
      );
      return { data: rows };
    })(),
    db
      .from("pipeline_state")
      .select("value")
      .eq("key", "cron_last_run")
      .maybeSingle(),
    Promise.allSettled([
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending")
        .eq("task_type", "tag"),
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending")
        .eq("task_type", "summary"),
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "processing"),
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "processing")
        .lt("claimed_at", staleClaimCutoff),
    ]),
    // FIX-1083 — 30-day aggregates for the "30d: N runs · X% ok" line under
    // each Data Health row. Same MV and same reader the admin page uses.
    // Returns [] on any error (the shared helper swallows it), so a missing or
    // unrefreshed MV degrades the sub-line rather than the whole section.
    fetchPipelineRuntimeStats(db),
  ]);

  const allRuns = (recentRunsRes.data ?? []) as PipelineHistoryRun[];

  // Per-pipeline bucket, capped at 7. Rows arrive grouped by pipeline with
  // each group already DESC by completed_at, so we just walk and trim.
  // HIDDEN_PIPELINES rows are skipped here so neither the bucketed history
  // nor the back-compat recent_runs derived below surface them.
  const history: Record<string, PipelineHistoryRun[]> = {};
  for (const run of allRuns) {
    if (HIDDEN_PIPELINES.has(run.pipeline)) continue;
    const bucket = (history[run.pipeline] ??= []);
    if (bucket.length < 7) bucket.push(run);
  }

  // Back-compat shape: global newest-first across all pipelines, top 10.
  // Used by callers that only need the slim PipelineRun fields. Sorting
  // ~210 trimmed rows is cheaper than the prior over-fetch.
  const recent_runs = Object.values(history)
    .flat()
    .sort((a, b) => {
      const at = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bt - at;
    })
    .slice(0, 10)
    .map((r) => ({
      pipeline: r.pipeline,
      status: r.status,
      completed_at: r.completed_at ?? "",
      rows_inserted: r.rows_inserted ?? 0,
    }));

  const safeCount = (
    r: PromiseSettledResult<{ count: number | null }>,
  ): number => (r.status === "fulfilled" ? (r.value.count ?? 0) : 0);

  // FIX-1083: additive field. The dashboard renders from a PERSISTED
  // status_snapshot, so a snapshot written before this deploy simply has no
  // `runtime_stats` key — every consumer treats it as optional and falls back
  // to showing no 30-day line, never to a crash.
  const runtime_stats: Record<string, PublicPipelineRuntimeStat> =
    toPublicRuntimeStats(runtimeStatRows);

  return {
    recent_runs,
    cron_last_run: cronState.data?.value ?? null,
    history,
    runtime_stats,
    enrichment_backlog: {
      pending_tag: safeCount(queueResults[0]),
      pending_summary: safeCount(queueResults[1]),
      // Total claims currently held, and the subset old enough to be abandoned.
      // stale_processing ⊆ processing — the dashboard renders both.
      processing: safeCount(queueResults[2]),
      stale_processing: safeCount(queueResults[3]),
    },
  };
}

// ── 5. AI costs ──────────────────────────────────────────────────────────────
export async function getAiCosts(
  db: Db,
  monthStart: string,
  sharedAnthropicUsagePromise?: SharedAnthropicUsagePromise,
) {
  const adminResult = sharedAnthropicUsagePromise
    ? await sharedAnthropicUsagePromise
    : await getAnthropicUsage();

  if (adminResult.source === "api") {
    const { this_month, budget } = adminResult;
    return {
      monthly_spent_usd: Math.round(budget.spent_usd * 10000) / 10000,
      monthly_budget_usd: budget.limit_usd,
      budget_used_pct: Math.round(budget.pct_used * 10) / 10,
      month_start: monthStart,
      last_hour_tokens: adminResult.last_hour.total_tokens,
      last_24h_tokens: adminResult.last_24h.total_tokens,
      last_24h_cost_usd: adminResult.last_24h.cost_usd,
      source: "api" as const,
      this_month_total_tokens: this_month.total_tokens,
    };
  }

  const { data: rows } = await db
    .from("api_usage_logs")
    .select("input_tokens, output_tokens, cost_cents, model")
    .eq("service", "anthropic")
    .gte("created_at", monthStart);

  // FIX-893: was an inline (in*0.25 + out*1.25) using Haiku-3-era prices and
  // ignoring the model column. Priced by model now, erring high on unknowns.
  type UsageRow = {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_cents: number | null;
    model: string | null;
  };
  const monthly_spent = ((rows ?? []) as UsageRow[]).reduce((sum, r) => {
    if (r.input_tokens != null && r.output_tokens != null) {
      return sum + calculateLoggedCostUsd(r.input_tokens, r.output_tokens, r.model);
    }
    return sum + (r.cost_cents ?? 0) / 100;
  }, 0);
  const budget_usd = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET ?? "") || 3.5;

  return {
    monthly_spent_usd: Math.round(monthly_spent * 10000) / 10000,
    monthly_budget_usd: budget_usd,
    budget_used_pct: Math.round((monthly_spent / budget_usd) * 1000) / 10,
    month_start: monthStart,
    source: "api_usage_logs" as const,
  };
}

// ── 6. Data quality checks ───────────────────────────────────────────────────
// FIX-333: 8-roundtrip fan-out collapsed into one get_quality_counts() RPC +
// the unchanged Congress-members SELECT (~535 rows, JSONB only). The RPC
// returns vote_category_counts as a JSONB map plus three BIGINT scalars; the
// tagged_pacs count is now computed over the full PAC population (the prior
// LIMIT-2000 sampling bias is gone).
//
// FIX-1146: that one RPC is now read from platform_counts instead of executed.
// The four numbers are identical — refresh_platform_counts() runs
// get_quality_counts()'s query bodies verbatim — they are just a day old rather
// than 30 minutes old, which is what makes them affordable. The Congress-members
// SELECT is unchanged and still live: it is a 535-row JSONB read, not a count.
export async function getQuality(db: Db) {
  const [congressMembers, counts] = await Promise.all([
    db
      .from("officials")
      .select("source_ids, metadata")
      .in("role_title", ["Senator", "Representative"]),

    // FIX-1146: was `rpc("get_quality_counts")`, the single most expensive
    // statement on the snapshot path — 240 calls x 15.1 s = 3,636 s of prod
    // execution in 7 days. The RPC still exists and still computes exactly
    // these four numbers; refresh_platform_counts() runs its bodies verbatim,
    // once a day, and nothing on the 30-minute path calls it any more.
    readPlatformCounts(db),
  ]);

  const voteCategoryCountsMap = counts.voteCategories;
  const totalPacs = counts.values.get("total_pacs") ?? 0;
  const taggedPacs = counts.values.get("tagged_pacs") ?? 0;
  const voteConnTotal = counts.values.get("vote_connection_total") ?? 0;

  type CongressRow = {
    source_ids: Record<string, string> | null;
    metadata: Record<string, string> | null;
  };
  const allCongress = ((congressMembers.data ?? []) as CongressRow[]).filter(
    (r) => r.source_ids?.["congress_gov"],
  );
  const total = allCongress.length;
  const has_fec = allCongress.filter((r) => r.source_ids?.["fec_id"]).length;
  const missing_state = allCongress.filter(
    (r) => !r.metadata?.["state"] && !r.metadata?.["state_abbr"],
  ).length;

  return {
    fec_coverage: {
      total,
      has_fec,
      pct: total ? Math.round((has_fec / total) * 1000) / 10 : 0,
    },
    missing_state,
    vote_categories: VOTE_CATEGORIES.map((cat) => ({
      vote_category: cat,
      count: voteCategoryCountsMap[cat] ?? 0,
    })).filter((r) => r.count > 0),
    industry_tags: {
      total: totalPacs,
      tagged: taggedPacs,
      pct: totalPacs ? Math.round((taggedPacs / totalPacs) * 1000) / 10 : 0,
    },
    vote_connections: voteConnTotal,
  };
}

// ── Derived-edge drift detection (FIX-157) ───────────────────────────────────
// One row per derivation rule in supabase/migrations/20260422000002_implement_rebuild_entity_connections.sql.
// "drifted" = source has rows but no derived edges exist — the failure mode
// behind FIX-156, where prod had 22,715 donations in financial_relationships
// but 0 edges in entity_connections for five days because the rebuild RPC
// hadn't been re-invoked after the FEC bulk pipeline ran.
const DRIFT_RULES = [
  {
    type: "donation",
    source: (db: Db) =>
      db
        .from("financial_relationships")
        .select("*", { count: "planned", head: true })
        .eq("relationship_type", "donation"),
  },
  {
    type: "vote_yes",
    source: (db: Db) =>
      db
        .from("votes")
        .select("*", { count: "planned", head: true })
        .eq("vote", "yes"),
  },
  {
    type: "vote_no",
    source: (db: Db) =>
      db
        .from("votes")
        .select("*", { count: "planned", head: true })
        .eq("vote", "no"),
  },
  {
    type: "vote_abstain",
    source: (db: Db) =>
      db
        .from("votes")
        .select("*", { count: "planned", head: true })
        .eq("vote", "abstain"),
  },
  {
    type: "co_sponsorship",
    source: (db: Db) =>
      db
        .from("proposal_cosponsors")
        .select("*", { count: "planned", head: true })
        .is("date_withdrawn", null),
  },
  {
    type: "appointment",
    source: (db: Db) =>
      db
        .from("career_history")
        .select("*", { count: "planned", head: true })
        .eq("is_government", true)
        .not("governing_body_id", "is", null),
  },
  {
    type: "oversight",
    source: (db: Db) =>
      db
        .from("agencies")
        .select("*", { count: "planned", head: true })
        .not("governing_body_id", "is", null),
  },
  {
    type: "holds_position",
    source: (db: Db) =>
      db
        .from("financial_relationships")
        .select("*", { count: "planned", head: true })
        .in("relationship_type", ["owns_stock", "owns_bond", "property"])
        .is("ended_at", null),
  },
  {
    type: "gift_received",
    source: (db: Db) =>
      db
        .from("financial_relationships")
        .select("*", { count: "planned", head: true })
        .in("relationship_type", ["gift", "honorarium"]),
  },
  {
    type: "contract_award",
    source: (db: Db) =>
      db
        .from("financial_relationships")
        .select("*", { count: "planned", head: true })
        .in("relationship_type", ["contract", "grant"]),
  },
  {
    type: "lobbying",
    source: (db: Db) =>
      db
        .from("financial_relationships")
        .select("*", { count: "planned", head: true })
        .eq("relationship_type", "lobbying_spend"),
  },
] as const;

// FIX-301: derived counts come from a single GROUP BY via the
// get_connection_type_counts() RPC (FIX-298), not 11 sequential count:'exact'
// scans of entity_connections. Same shape as getConnectionTypes above —
// one round-trip instead of N, on a 5.1M-row table.
//
// FIX-332: accepts the shared get_connection_type_counts() promise so
// computeStatusPayload can dedupe with getConnectionTypes; accepts an
// optional timing collector for status_snapshot.section_times.
//
// FIX-345: source side now uses a single get_drift_source_presence() RPC
// (UNION ALL of 11 EXISTS) instead of 11 parallel count:'planned' HEADs
// over DRIFT_RULES.source. The COUNT(*) shape was forcing Seq Scan for
// the common values (donation = ~5M rows, contract/grant = ~1.4M),
// dominating derived_drift wall-clock at 8-12s per rule. EXISTS stops at
// the first matching row regardless of cardinality. Drift detection only
// cares about presence (`source > 0`), not magnitude — the count value
// was never used outside the diagnostic display string.
async function checkDerivedDrift(
  db: Db,
  opts?: {
    sharedConnTypeCountsPromise?: SharedConnTypeCountsPromise;
    collect?: TimingCollect;
  },
) {
  const collect = opts?.collect;
  const timed = async <T>(
    key: string,
    fn: () => PromiseLike<T>,
  ): Promise<T> => {
    if (!collect) return await fn();
    const ts = Date.now();
    try {
      return await fn();
    } finally {
      collect(key, Date.now() - ts);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const derivedPromise: Promise<{ data: any; error: any }> =
    opts?.sharedConnTypeCountsPromise ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc("get_connection_type_counts");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourcePresencePromise: Promise<{ data: any; error: any }> =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc("get_drift_source_presence");

  const [sourceRes, derivedRes] = await Promise.all([
    timed("derived_drift:source_presence", () => sourcePresencePromise),
    timed("derived_drift:get_connection_type_counts", () => derivedPromise),
  ]);
  if (sourceRes.error)
    throw new Error(sourceRes.error.message ?? "get_drift_source_presence RPC error");
  if (derivedRes.error)
    throw new Error(derivedRes.error.message ?? "get_connection_type_counts RPC error");

  type DerivedRow = { connection_type: string; total: number | string };
  const byType = new Map<string, number>();
  for (const r of (derivedRes.data ?? []) as DerivedRow[]) {
    byType.set(r.connection_type, Number(r.total));
  }

  type PresenceRow = { rule_type: string; has_rows: boolean };
  const sourcePresent = new Map<string, boolean>();
  for (const r of (sourceRes.data ?? []) as PresenceRow[]) {
    sourcePresent.set(r.rule_type, Boolean(r.has_rows));
  }

  const drifted = DRIFT_RULES.flatMap((r) => {
    const hasSource = sourcePresent.get(r.type) ?? false;
    const derived = byType.get(r.type) ?? 0;
    return hasSource && derived === 0 ? [{ type: r.type, derived }] : [];
  });
  return { drifted, total_rules: DRIFT_RULES.length };
}

// ── 7. Self-tests ────────────────────────────────────────────────────────────
//
// FIX-332: accepts shared promises so the dashboard cron's two duplicate
// callers (`get_connection_type_counts` via checkDerivedDrift, and
// `getAnthropicUsage` via the parallel block) award one network round-trip
// each instead of two. The `collect` callback writes per-sub-op timings
// under `self_tests:<op>` and `derived_drift:<rule>` keys into the same
// section_times JSONB the section-level timed() wrapper uses — diagnostic
// drilldown without a schema change.
export async function getSelfTests(
  db: Db,
  opts?: {
    sharedConnTypeCountsPromise?: SharedConnTypeCountsPromise;
    sharedAnthropicUsagePromise?: SharedAnthropicUsagePromise;
    collect?: TimingCollect;
  },
) {
  const collect = opts?.collect;
  const timed = async <T>(
    key: string,
    fn: () => PromiseLike<T>,
  ): Promise<T> => {
    if (!collect) return await fn();
    const ts = Date.now();
    try {
      return await fn();
    } finally {
      collect(key, Date.now() - ts);
    }
  };

  // Step 1: sample a reference official from live data. Sequential — the search
  // fixture below waits on it, so it floors the section wall-clock (57 ms prod /
  // 36 ms local, measured 2026-08-22).
  //
  // FIX-1093: this replaces a hardcoded `q: "warren"` search plus a three-tier
  // disambiguation ladder for the three "Elizabeth Warren" official rows on
  // prod. FIX-1076 had already neutralised the rendered strings; the fixture
  // itself stayed keyed to one named sitting politician, which is not something
  // a public transparency dashboard should be asserting about anybody in
  // particular. check_senate_reference_cohort() samples the lowest-id member of
  // the active federal senator cohort instead, so the subject rotates on its own
  // as the roster changes, and returns the cohort aggregate from the same
  // cohort definition so the two fixtures are provably about the same set.
  //
  // The candidate-stub problem the old ladder worked around is now handled by
  // construction rather than by disambiguation: the cohort predicate excludes
  // `tier = 'candidate'` outright, so there is no wrong row to resolve to.
  const cohortRes = await timed("self_tests:senate_cohort", () =>
    db.rpc("check_senate_reference_cohort", { p_min_edges: SENATE_MIN_VOTE_EDGES }),
  );
  type SenateCohort = {
    cohort_size: number;
    with_edges: number;
    min_edges: number;
    sample_id: string | null;
    sample_name: string | null;
  };
  const cohort = (cohortRes.error ? null : cohortRes.data) as SenateCohort | null;

  // `sample_name` is a query string, never a rendered one — every `detail`
  // below says "sampled reference official". Searching by full name and
  // asserting the sampled UUID comes back is the strong form of the check: a
  // resolver-class bug that points search at the wrong row fails it even when
  // a same-named row is returned.
  type SearchRow = { id: string; label: string; entity_type: string };
  const sampleName = cohort?.sample_name ?? null;
  const sampleId = cohort?.sample_id ?? null;
  const referenceSearch = sampleName
    ? await timed("self_tests:reference_search", () =>
        db.rpc("search_graph_entities", { q: sampleName, lim: 10 }),
      )
    : { data: null, error: null };
  const referenceResolved =
    sampleId != null &&
    ((referenceSearch.data ?? []) as SearchRow[]).some(
      (r) => r.id === sampleId && r.entity_type === "official",
    );

  // FIX-337 follow-up (2026-05-23): when no shared promise is provided (the
  // /api/claude/status live route is one such caller), synthesize one here
  // so checkDerivedDrift AND the voteYesTotalCount derivation below share a
  // single get_connection_type_counts() round-trip. Without this, the live
  // route's connections_pipeline_healthy test always saw vote_yes total: 0
  // and failed even when the rebuild was healthy.
  const localConnTypeCountsPromise: SharedConnTypeCountsPromise =
    opts?.sharedConnTypeCountsPromise ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc("get_connection_type_counts");

  const openCommentCutoff = new Date().toISOString();

  const [
    chordData,
    cronEscalationsRes,
    openCommentCountRes,
    openCommentCardsRes,
    searchIndexRes,
    anthropicUsageResult,
    cronState,
    rebuildLastRunRes,
    ecDonationsStateRes,
    drift,
  ] = await Promise.all([
    timed("self_tests:chord_industry_flows", () => db.rpc("chord_industry_flows")),

    // FIX-1094: pg_cron escalations. See the migration header for why this is a
    // function and not a PostgREST read (the `cron` schema is not exposed, and
    // check_cron_job_health()'s 222 kB response on every tick would be ~320 MB
    // of egress per month at the current */30 cadence — and was ~960 MB when
    // this comment was written against a nominal 10-min tick — against the 5 GB
    // budget this same payload reports on. Cadence moved (FIX-1127); the reason
    // to keep this a narrow escalations function did not.
    timed("self_tests:cron_escalations", () =>
      db.rpc("check_cron_job_escalations", {
        p_lookback_hours: CRON_STREAK_LOOKBACK_HOURS,
        p_min_streak: CRON_MIN_FAIL_STREAK,
      }),
    ),

    // FIX-1094: the two halves of the open-comment invariant, issued with the
    // same filter and the same cutoff so they cannot disagree for any reason
    // except a broken count. See the test body for what this catches.
    timed("self_tests:open_comment_count", () =>
      db
        .from("proposals")
        .select("*", { count: "exact", head: true })
        .eq("status", "open_comment")
        .gt("metadata->>comment_period_end", openCommentCutoff),
    ),
    timed("self_tests:open_comment_cards", () =>
      db
        .from("proposals")
        .select("id")
        .eq("status", "open_comment")
        .gt("metadata->>comment_period_end", openCommentCutoff)
        .limit(OPEN_COMMENT_CARD_LIMIT),
    ),

    // FIX-1094: same read /search's own header displays (app/api/browse/
    // execute.ts) — newest refreshed_at on the search substrate itself, not on
    // the browse_facet_counts rollup that is stamped alongside it.
    timed("self_tests:search_index_freshness", () =>
      db
        .from("entity_search_index")
        .select("refreshed_at")
        .order("refreshed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),

    timed("self_tests:anthropic_usage", () =>
      opts?.sharedAnthropicUsagePromise ?? getAnthropicUsage(),
    ),

    timed("self_tests:cron_state", () =>
      db
        .from("pipeline_state")
        .select("value")
        .eq("key", "cron_last_run")
        .maybeSingle(),
    ),

    // FIX-340: connections_pipeline_healthy used to read the rebuild result
    // out of pipeline_state.cron_last_run.results.pipelines.entity_connections_rebuild,
    // but FIX-291 extracted the rebuild into its own GHA workflow that writes
    // ONLY to data_sync_log under pipeline='entity_connections_rebuild'.
    // Reader updated to follow the data; writer stays as the single source of
    // truth per its file-header comment in scripts/rebuild-entity-connections.ts.
    //
    // FIX-833: gate on a TERMINAL run, not the latest row. A rebuild that dies
    // strands a status='running' row with a NULL completed_at; under
    // `.order(completed_at desc)` that NULL sorts FIRST in Postgres (NULLS
    // FIRST default) and dominated the read forever → permanent false-fail even
    // though the incremental was keeping edges fresh. Filtering to terminal
    // statuses + NULLS LAST keeps that immunity: a stranded 'running' and a
    // reaped row both carry a NULL completed_at (the reaper deliberately does
    // not stamp one — FIX-944/979), and 'failed' is excluded so a single bad
    // firing does not flip the banner.
    //
    // FIX-1084: 'partial' joins 'complete' as terminal-and-alive, because the
    // EC machinery legitimately stopped emitting 'complete' every firing. Under
    // FIX-1056 (per-arm resume) + FIX-1063/1071 (external per-job budgets, 5h
    // for both rebuild-ec-incremental jobs) + FIX-1028 (the query_canceled
    // handlers the cancel lands in), an incremental firing is DESIGNED to do as
    // much as its budget allows, close the row 'partial' carrying `next_arm`
    // and `arm_timings`, and resume from that checkpoint on the next firing.
    // Only a firing that drains an entire cycle reports 'complete'.
    //
    // Measured on prod 2026-08-22: newest 'complete' was 2026-07-29 08:00 (24
    // days old, so the old predicate had held the public dashboard's red
    // "System issue detected" banner up for over three weeks) while the newest
    // row was 2026-08-19 08:00 'partial' — and cron.job_run_details records
    // BOTH recent firings, rebuild-ec-incremental 08-19 and
    // rebuild-ec-incremental-mon 08-17, as `succeeded`. The pipeline was fine;
    // the predicate was asking for a status the design no longer produces.
    timed("self_tests:rebuild_last_run", () =>
      db
        .from("data_sync_log")
        .select("status, completed_at, rows_inserted")
        .eq("pipeline", "entity_connections_rebuild")
        .in("status", ["complete", "partial"])
        .order("completed_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
    ),

    // FIX-1084: the donations cycle watermark. This is the only place a
    // *cycle completion* is recorded — scripts/drain-ec-donations.mjs writes NO
    // data_sync_log row at all, so the healthy 2026-08-21 close (16/16 window
    // watermarks level, `cycle` key dropped, last_indexed_at advanced) was
    // invisible to every sync-log-based check. Reported in the detail string
    // rather than gated on: `last_indexed_at` only advances when a whole cycle
    // closes, and how often that happens is a function of dirty-set size, not
    // of schedule — turning it into a threshold would trade one false-red for
    // another. A cycle that genuinely stops progressing still surfaces here as
    // a visibly old watermark, and via derived_edges_match_source.
    timed("self_tests:ec_donations_watermark", () =>
      db
        .from("pipeline_state")
        .select("value, updated_at")
        .eq("key", "entity_connections_donations")
        .maybeSingle(),
    ),

    timed("self_tests:derived_drift", () =>
      checkDerivedDrift(db, {
        sharedConnTypeCountsPromise: localConnTypeCountsPromise,
        collect,
      }),
    ),
  ]);

  // FIX-337: vote_yes total was a separate count:'exact' (~6s) on
  // entity_connections. The shared get_connection_type_counts() promise
  // (FIX-332) is already awaited inside checkDerivedDrift above and returns
  // the vote_yes total as part of its 16-row output — read it from there.
  // Emit a 0 timing under the historical key so snapshot queries continue
  // to surface it as "explicitly free" rather than disappear.
  const sharedConnTypeCountsResult = await localConnTypeCountsPromise;
  const voteYesTotalCount = sharedConnTypeCountsResult?.data
    ? Number(
        (
          sharedConnTypeCountsResult.data as Array<{
            connection_type: string;
            total: number | string;
          }>
        ).find((r) => r.connection_type === "vote_yes")?.total ?? 0,
      )
    : 0;
  collect?.("self_tests:vote_yes_count", 0);

  const monthlySpent =
    anthropicUsageResult.source === "api"
      ? anthropicUsageResult.this_month.cost_usd
      : 0;

  type ChordRow = { industry: string };
  const chordGroups = chordData.error
    ? 0
    : ((chordData.data ?? []) as ChordRow[]).filter(
        (r) => r.industry !== "untagged",
      ).length;

  const cronVal = (cronState.data?.value ?? null) as
    | { completed_at?: string; started_at?: string }
    | null;
  const cronLastRun = cronVal?.completed_at ?? cronVal?.started_at ?? null;

  // FIX-340/1084: shape of the newest TERMINAL entity_connections_rebuild row
  // (the query above filters to complete|partial, so this is never a stranded
  // 'running' or a reaped one — both carry a NULL completed_at).
  const rebuildLastRun = (rebuildLastRunRes.data ?? null) as
    | { status: string; completed_at: string | null; rows_inserted: number | null }
    | null;

  // FIX-1084: donations cycle watermark, for the detail string only. A closed
  // cycle has all 16 window watermarks present and level, no `cycle` key, and
  // last_indexed_at advanced to the cycle's target.
  const ecDonationsState = (ecDonationsStateRes.data ?? null) as
    | { value: Record<string, unknown> | null; updated_at: string | null }
    | null;
  const ecDonationsSummary = (() => {
    const v = ecDonationsState?.value;
    if (!v) return "donations watermark: absent";
    const windows = v["windows"];
    const windowCount =
      windows && typeof windows === "object" ? Object.keys(windows).length : 0;
    const lastIndexed = typeof v["last_indexed_at"] === "string" ? v["last_indexed_at"] : null;
    const cycleOpen = Object.prototype.hasOwnProperty.call(v, "cycle");
    return (
      `donations cycle: ${cycleOpen ? "in progress" : "closed"}` +
      `, ${windowCount}/16 windows` +
      (lastIndexed ? `, indexed through ${lastIndexed}` : "")
    );
  })();
  // Rebuild cadence is pg_cron: rebuild-ec-incremental-mon Mon 08:00 UTC +
  // rebuild-ec-incremental Wed 08:00 UTC (FIX-833 converted the Monday job from
  // 'full' to 'incremental' — the 6h full was retired). The largest gap between
  // two scheduled firings is Wed→Mon = 5 days. 6d clears that with cushion
  // without false-passing a genuinely missed schedule. (Was Mon-full/Wed-
  // incremental where Monday's 6h CALL budget pushed the newest completed row
  // to ~5.25d; before that 4.5d for the retired Sun+Wed GHA cadence — FIX-H.)
  //
  // FIX-1084 re-checked this against the real cadence rather than the old
  // "~42min incremental" assumption, which no longer holds: a firing now runs
  // to its 5h cron_job_budget and closes 'partial'. That does not move the
  // bound — the row still lands within minutes of the firing either way, and
  // 5d + 1d cushion is still the right window. It DOES mean a firing that
  // never starts is the failure mode to worry about, and that is exactly what
  // this ages out on: prod has two "job startup timeout" firings on record
  // (rebuild-ec-incremental 08-05, rebuild-ec-incremental-mon 07-27) which
  // wrote no row at all.
  const REBUILD_STALE_MS = 6 * 24 * 60 * 60 * 1000;
  const rebuildAgeMs = rebuildLastRun?.completed_at
    ? Date.now() - new Date(rebuildLastRun.completed_at).getTime()
    : null;

  // ── FIX-1094 derivations ────────────────────────────────────────────────────

  type CronEscalations = {
    available: boolean;
    lookback_hours: number;
    min_streak: number;
    jobs_active: number;
    failing: Array<{
      jobname: string | null;
      schedule: string | null;
      fail_streak: number;
      runs_in_window: number;
      last_failed_at: string | null;
      last_message: string | null;
    }>;
    missing_daily: Array<{ jobname: string | null }>;
    canary_liveness: { silent: boolean; hours_since: number | null } | null;
  };
  const cronEscalations = (
    cronEscalationsRes.error ? null : cronEscalationsRes.data
  ) as CronEscalations | null;
  const cronFailing = cronEscalations?.failing ?? [];
  // Name jobs, never jobids — a jobid is a local handle that changes when a job
  // is rescheduled and means nothing to whoever reads this on the dashboard.
  // An unnamed row is a deleted job still holding history; say that rather than
  // rendering "null".
  const jobLabel = (name: string | null) => name ?? "(unnamed job)";

  const openCommentCount = openCommentCountRes.count ?? 0;
  const openCommentCards = (openCommentCardsRes.data ?? []).length;

  const searchIndexRefreshedAt =
    (searchIndexRes.data as { refreshed_at: string | null } | null)?.refreshed_at ?? null;
  const searchIndexAgeMs = searchIndexRefreshedAt
    ? Date.now() - new Date(searchIndexRefreshedAt).getTime()
    : null;

  return [
    {
      // FIX-1093: replaces the retired `entity_search_finds_warren`. NEW name,
      // not a rename — persisted status_snapshot payloads and DashboardClient's
      // SELF_TEST_LABELS both key on `name`, so renaming in place would
      // retro-relabel every historical payload. The retired name simply stops
      // appearing once the next snapshot rolls.
      name: "entity_search_resolves_sampled_official",
      passed: referenceResolved,
      detail: sampleId
        ? referenceResolved
          ? "sampled reference official resolved by entity search"
          : "sampled reference official NOT resolved in the top 10 search results"
        : cohortRes.error
          ? `cohort RPC error: ${cohortRes.error.message}`
          : "no sampled reference official available — cohort empty",
    },
    {
      name: "chord_has_industry_data",
      passed: !chordData.error && chordGroups >= 5,
      detail: chordData.error
        ? `RPC error: ${chordData.error.message}`
        : `${chordGroups} industry groups returned`,
    },
    {
      // FIX-1093: replaces the retired `warren_has_vote_connections`, which
      // asserted one named senator's edge count. The aggregate form is neutral
      // AND strictly more sensitive: the single-senator check could only fail if
      // that one person's edges broke, whereas a resolver-class bug that strands
      // votes on candidate stubs moves the whole cohort at once.
      name: "senate_vote_edges_present",
      passed: (cohort?.with_edges ?? 0) >= SENATE_COVERAGE_FLOOR,
      detail: cohort
        ? `${cohort.with_edges} of ${cohort.cohort_size} active federal senators have >${cohort.min_edges} vote_yes edges (floor ${SENATE_COVERAGE_FLOOR})`
        : `cohort RPC unavailable${cohortRes.error ? `: ${cohortRes.error.message}` : ""}`,
    },
    {
      name: "ai_budget_ok",
      passed:
        anthropicUsageResult.source === "api"
          ? monthlySpent < anthropicUsageResult.budget.limit_usd * 0.9
          : monthlySpent < 3.5 * 0.9,
      detail:
        anthropicUsageResult.source === "api"
          ? `$${monthlySpent.toFixed(4)} of $${anthropicUsageResult.budget.limit_usd.toFixed(2)} budget (${Math.round((monthlySpent / anthropicUsageResult.budget.limit_usd) * 100)}% used) [admin api]`
          : `$${monthlySpent.toFixed(4)} — admin key unavailable`,
    },
    {
      name: "nightly_ran_today",
      passed:
        cronLastRun != null &&
        Date.now() - new Date(cronLastRun).getTime() < 26 * 60 * 60 * 1000,
      detail: cronLastRun
        ? `Last run: ${cronLastRun}`
        : "No cron_last_run in pipeline_state",
    },
    {
      name: "connections_pipeline_healthy",
      // FIX-1084: "a terminal run inside the cadence window, and the edges it
      // maintains are actually there". The status set is complete|partial
      // because a budget-bounded resume closes 'partial' by design (see the
      // query comment above); the vote_yes floor is unchanged and is what stops
      // a row that closes terminally every firing while writing nothing from
      // reading as healthy.
      passed:
        (rebuildLastRun?.status === "complete" ||
          rebuildLastRun?.status === "partial") &&
        voteYesTotalCount > 50000 &&
        rebuildAgeMs != null &&
        rebuildAgeMs < REBUILD_STALE_MS,
      detail: rebuildLastRun
        ? `entity_connections_rebuild: last ${rebuildLastRun.status} at ${rebuildLastRun.completed_at ?? "?"}${
            rebuildLastRun.rows_inserted != null
              ? ` (${rebuildLastRun.rows_inserted} rows)`
              : ""
          }, vote_yes total: ${voteYesTotalCount}${
            rebuildAgeMs != null
              ? `, age ${(rebuildAgeMs / (60 * 60 * 1000)).toFixed(1)}h`
              : ""
          } · ${ecDonationsSummary}`
        : `No complete or partial entity_connections_rebuild row in data_sync_log — has the pg_cron rebuild (Mon + Wed incremental) run since cutover? · ${ecDonationsSummary}`,
    },
    {
      name: "derived_edges_match_source",
      passed: drift.drifted.length === 0,
      detail:
        drift.drifted.length === 0
          ? `all ${drift.total_rules} derivation rules have non-zero derived edges`
          : `drift detected: ${drift.drifted.map((d) => `${d.type} has source rows but 0 derived edges`).join("; ")}`,
    },
    {
      // FIX-1094. The gap this closes: on 2026-08-17 and again on 2026-08-19 the
      // `entity-connection-stats-rebuild` pg_cron job died with "job startup
      // timeout" before its body ran, and nothing on the dashboard said so. Its
      // last three firings had all failed (08-10 statement timeout, then the two
      // startup timeouts) and the only visible symptom was rollups quietly
      // ageing — which cc-79 made public, but as a consequence, not a cause.
      //
      // Gated on the failure-streak arm only. missing_daily and canary silence
      // ride in the detail but do not fail the test: both already escalate in
      // the daily canary, and both are permanently true on any database without
      // a live pg_cron (every local Docker), which would pin this red forever.
      // See the migration header for the full argument.
      name: "cron_jobs_healthy",
      passed: cronFailing.length === 0,
      detail: !cronEscalations
        ? `cron escalation RPC unavailable${cronEscalationsRes.error ? `: ${cronEscalationsRes.error.message}` : ""}`
        : !cronEscalations.available
          ? "pg_cron not present on this database — check skipped"
          : cronFailing.length > 0
            ? `${cronFailing.length} job${cronFailing.length === 1 ? "" : "s"} stuck failing: ${cronFailing
                .map(
                  (j) =>
                    `${jobLabel(j.jobname)} (${j.fail_streak} consecutive, last ${j.last_failed_at ?? "?"}${
                      j.last_message ? `: ${j.last_message}` : ""
                    })`,
                )
                .join("; ")}`
            : `${cronEscalations.jobs_active} active jobs, none failing ${cronEscalations.min_streak}+ firings in a row over ${Math.round(cronEscalations.lookback_hours / 24)}d` +
              (cronEscalations.missing_daily.length > 0
                ? ` · ${cronEscalations.missing_daily.length} daily job(s) with no run in 26h: ${cronEscalations.missing_daily
                    .map((j) => jobLabel(j.jobname))
                    .join(", ")}`
                : "") +
              (cronEscalations.canary_liveness?.silent
                ? ` · canary silent ${cronEscalations.canary_liveness.hours_since ?? "?"}h`
                : ""),
    },
    {
      // FIX-1094. The gap this closes: FIX-1077 found the /dashboard
      // comment-period card rendering a literal "1" against a true 220 local /
      // 314 prod, because `count: "planned"` multiplies two independent
      // selectivity guesses over `status` and a JSONB-path date comparison and
      // bottoms out at Plan Rows: 1. It shipped that way for weeks, and no
      // self-test could see it because nothing compared the count to anything.
      //
      // The assertion is the invariant, not a magic number: the count and the
      // card list run the same filter with the same cutoff, so the count can
      // never legitimately be below the number of cards rendered. A count of 1
      // against 3 rendered cards fails. A genuinely empty comment-period window
      // (0 and 0) passes, which is what stops this becoming a seasonal false red
      // every time the federal register goes quiet.
      name: "open_comment_count_sane",
      passed:
        !openCommentCountRes.error &&
        !openCommentCardsRes.error &&
        openCommentCount >= openCommentCards,
      detail: openCommentCountRes.error
        ? `count failed: ${openCommentCountRes.error.message}`
        : openCommentCardsRes.error
          ? `card sample failed: ${openCommentCardsRes.error.message}`
          : `${openCommentCount} proposals in an open comment window, ${openCommentCards} card${openCommentCards === 1 ? "" : "s"} rendered`,
    },
    {
      // FIX-1094. /search already shows this stamp in its own header, so the
      // dashboard reading the same value keeps the two surfaces from disagreeing
      // about how fresh search is. entity_search_index is the substrate itself —
      // deliberately not the browse_facet_counts rollup, which is stamped in the
      // same refresh and would therefore look fresh even if the index write half
      // of that job failed.
      name: "search_index_fresh",
      passed: searchIndexAgeMs != null && searchIndexAgeMs < SEARCH_INDEX_STALE_MS,
      detail: searchIndexRes.error
        ? `entity_search_index read failed: ${searchIndexRes.error.message}`
        : searchIndexRefreshedAt
          ? `entity_search_index refreshed ${searchIndexRefreshedAt} (${((searchIndexAgeMs ?? 0) / (60 * 60 * 1000)).toFixed(1)}h ago, stale after ${SEARCH_INDEX_STALE_MS / (60 * 60 * 1000)}h)`
          : "entity_search_index has no refreshed_at stamp",
    },
  ];
}

// ── 8. Chord top flows ───────────────────────────────────────────────────────
export async function getChord(db: Db) {
  const { data, error } = await db.rpc("chord_industry_flows");
  if (error) throw new Error(error.message ?? "chord RPC error");

  type FlowRow = {
    industry: string;
    party_chamber: string;
    total_cents: number;
  };
  const rows = (data ?? []) as FlowRow[];
  const lbl = (s: string) =>
    s.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

  const flowMatrix = new Map<string, Map<string, number>>();
  let totalFlow = 0;
  for (const row of rows) {
    const usd = Number(row.total_cents) / 100;
    totalFlow += usd;
    if (row.industry === "untagged") continue;
    if (!flowMatrix.has(row.industry)) flowMatrix.set(row.industry, new Map());
    const pm = flowMatrix.get(row.industry)!;
    pm.set(row.party_chamber, (pm.get(row.party_chamber) ?? 0) + usd);
  }

  // FIX-1081 — carry the RAW industry key alongside the prettified label.
  // `from` is display-only (lbl() title-cases and de-underscores it), so a
  // consumer that needs to address the industry — the dashboard's per-row
  // graph deep link — had nothing to send: ChordFlow.from_id was declared
  // optional and never populated, and every row fell back to the un-emphasized
  // link. The key matches the arc ids /api/graph/chord builds from the same
  // chord_industry_flows RPC, so it addresses the arc directly.
  const topFlows: Array<{ from: string; from_id: string; to: string; amount_usd: number }> = [];
  for (const [ind, pm] of flowMatrix)
    for (const [party, usd] of pm)
      topFlows.push({ from: lbl(ind), from_id: ind, to: party, amount_usd: Math.round(usd) });
  topFlows.sort((a, b) => b.amount_usd - a.amount_usd);

  return {
    top_flows: topFlows.slice(0, 10),
    total_flow_usd: Math.round(totalFlow),
  };
}

// ── 9. Activity: top pages over rolling window ───────────────────────────────
// FIX-395: was 24h + .not('page','in','("/","/dashboard")'). At current
// traffic almost all human hits are / and /dashboard, so the filtered 24h
// query returned 0 rows and the card rendered empty. Widened to a 7d window
// and dropped the filter — home/dashboard hits in the list is more useful
// than an empty card. Payload field renamed page_views_24h → page_views
// and lookback_days added so the description text stays honest if the
// window changes again.
export async function getActivity(db: Db, lookbackDays: number) {
  const cutoff = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const [countRes, pathRes] = await Promise.all([
    db
      .from("page_views")
      .select("*", { count: "exact", head: true })
      .gt("viewed_at", cutoff)
      .eq("is_bot", false),
    db
      .from("page_views")
      .select("page")
      .gt("viewed_at", cutoff)
      .eq("is_bot", false)
      .limit(500),
  ]);

  if (countRes.error) throw new Error(countRes.error.message);
  if (pathRes.error) throw new Error(pathRes.error.message);

  const counts: Record<string, number> = {};
  for (const r of (pathRes.data ?? []) as unknown as { page: string }[]) {
    counts[r.page] = (counts[r.page] ?? 0) + 1;
  }
  const topPages = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([page, views]) => ({ path: page, views }));

  return {
    page_views: countRes.count ?? 0,
    lookback_days: lookbackDays,
    top_pages: topPages,
  };
}

// ── 10. Resource warnings ────────────────────────────────────────────────────
export async function getResourceWarnings(db: Db) {
  const { data: egressRow } = await db
    .from("pipeline_state")
    .select("value")
    .eq("key", "monthly_egress_estimate")
    .maybeSingle();
  const egressMb =
    ((egressRow?.value as Record<string, unknown> | null)?.egress_mb as number) ??
    0;
  const EGRESS_LIMIT_MB = 5000;
  return {
    egress_estimate_mb: egressMb,
    egress_limit_mb: EGRESS_LIMIT_MB,
    egress_pct: Math.round((egressMb / EGRESS_LIMIT_MB) * 100),
    egress_warning: egressMb > 4000,
    egress_critical: egressMb > 4750,
  };
}

// ── 11b. EC crawl health (FIX-1114) ──────────────────────────────────────────
//
// The FIX-1111 crawl cannot starve the box, so what is worth watching about it
// is not availability but LAG: how far behind ingest the entity-connections
// watermark has fallen, and whether the crawl is being throttled (backoffs) or
// simply out-run (units per cycle growing). Those two readings point at
// different conversations — compute tier vs ingest shape — and the RPC carries
// the rule that separates them in its own `decision_rule` key.
//
// One RPC, one jsonb. Returns null on error so a cron-catalog hiccup degrades
// the tile rather than the whole snapshot.
export async function getEcCrawlHealth(db: Db) {
  const { data, error } = await db.rpc("get_ec_crawl_health");
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

// ── 11c. Daily counts — the 30-day stat-card series (FIX-090) ────────────────
//
// Reads public.daily_platform_counts, the day-keyed table the recorder below
// (recordDailyCounts, status-snapshot.ts) upserts from this very payload. It is
// a separate table and not a slice of status_snapshot because status_snapshot's
// retention is 24 HOURS — it holds hours of ticks, never 30 days.
//
// Every metric is independently nullable: a day where a metric was not measured
// is a HOLE, not a zero, and the read path drops those points rather than
// drawing the series through the floor. That is why each series is filtered on
// its own value being non-null instead of the row being complete — the
// reconstructed backfill has officials/votes but no open_proposals or
// donation_flow_usd, so a row-level filter would throw away 30 real points.
//
// Cheap by construction: 30 rows of five integers, one indexed range scan.
export const DAILY_COUNTS_WINDOW_DAYS = 30;

export type DailyCountsSeries = {
  // ISO dates (YYYY-MM-DD) paired 1:1 with `values`, oldest first.
  days: string[];
  values: number[];
};

export type DailyCounts = {
  officials: DailyCountsSeries;
  open_proposals: DailyCountsSeries;
  votes: DailyCountsSeries;
  donation_flow_usd: DailyCountsSeries;
};

type DailyCountsRow = {
  day: string;
  officials: number | null;
  open_proposals: number | null;
  votes: number | null;
  donation_flow_usd: number | null;
};

const DAILY_METRICS = [
  "officials",
  "open_proposals",
  "votes",
  "donation_flow_usd",
] as const;

/** Build one metric's series, dropping days where that metric was not measured. */
function seriesFor(rows: DailyCountsRow[], key: (typeof DAILY_METRICS)[number]): DailyCountsSeries {
  const days: string[] = [];
  const values: number[] = [];
  for (const row of rows) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    days.push(row.day);
    values.push(Number(v));
  }
  return { days, values };
}

export async function getDailyCounts(db: Db): Promise<DailyCounts> {
  const cutoff = new Date(Date.now() - DAILY_COUNTS_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // `as any` on the table name, matching this file's existing idiom for reads
  // the generated types lag (lines 262/567/751 do the same for RPCs). The
  // packages/db `db:types` script generates from the PROD project id, so
  // daily_platform_counts cannot appear in database.ts until this migration has
  // been applied to prod — regenerating is a follow-up, not a prerequisite.
  // Row shape is asserted explicitly below via DailyCountsRow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("daily_platform_counts")
    .select("day, officials, open_proposals, votes, donation_flow_usd")
    .gte("day", cutoff)
    .order("day", { ascending: true });

  if (error) throw new Error(error.message ?? "daily_platform_counts read failed");

  const rows = (data ?? []) as DailyCountsRow[];
  return {
    officials: seriesFor(rows, "officials"),
    open_proposals: seriesFor(rows, "open_proposals"),
    votes: seriesFor(rows, "votes"),
    donation_flow_usd: seriesFor(rows, "donation_flow_usd"),
  };
}

// ── 11. Officials breakdown ──────────────────────────────────────────────────
export async function getOfficialsBreakdown(db: Db) {
  const { data, error } = await db.rpc("get_officials_breakdown");
  if (error || !data) return null;
  type Row = { category: string; count: number };
  const rows = data as Row[];
  const get = (cat: string) => rows.find((r) => r.category === cat)?.count ?? 0;
  return { federal: get("federal"), state: get("state"), judges: get("judges") };
}
