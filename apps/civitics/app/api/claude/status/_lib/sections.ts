// Section helpers shared by /api/claude/status, /core, /quality.
// Each helper does one logical section of the platform health response.
// Errors are wrapped with `section()` at the call site, never thrown out.

import {
  createAdminClient,
  getAnthropicUsage,
  type AnthropicUsageResponse,
} from "@civitics/db";

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
  const latestSync = await db
    .from("data_sync_log")
    .select("pipeline, completed_at, status")
    .order("completed_at", { ascending: false })
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
export async function getDatabase(db: Db, yesterday: string) {
  const [
    officials,
    proposals,
    proposalsBills,
    proposalsRegs,
    votes,
    connections,
    finRel,
    finEnt,
    tags,
    cache,
    views,
  ] = await Promise.all([
    db.from("officials").select("*", { count: "estimated", head: true }),
    db.from("proposals").select("*", { count: "estimated", head: true }),
    db
      .from("proposals")
      .select("*", { count: "planned", head: true })
      .in("type", ["bill", "resolution", "amendment"]),
    db
      .from("proposals")
      .select("*", { count: "exact", head: true })
      .eq("type", "regulation"),
    db.from("votes").select("*", { count: "estimated", head: true }),
    db.from("entity_connections").select("*", { count: "estimated", head: true }),
    db.from("financial_relationships").select("*", { count: "estimated", head: true }),
    db.from("financial_entities").select("*", { count: "estimated", head: true }),
    db.from("entity_tags").select("*", { count: "estimated", head: true }),
    db.from("ai_summary_cache").select("*", { count: "estimated", head: true }),
    db
      .from("page_views")
      .select("*", { count: "exact", head: true })
      .gt("viewed_at", yesterday)
      .eq("is_bot", false),
  ]);

  // Surface partial state if any count failed (don't silently show 0).
  const errored = [
    officials.error && "officials",
    proposals.error && "proposals",
    proposalsBills.error && "proposals_bills",
    proposalsRegs.error && "proposals_regulations",
    votes.error && "votes",
    connections.error && "entity_connections",
    finRel.error && "financial_relationships",
    finEnt.error && "financial_entities",
    tags.error && "entity_tags",
    cache.error && "ai_summary_cache",
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
    ...(errored.length > 0 && {
      error: `count failed for: ${errored.join(", ")}`,
      partial: true,
    }),
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
//   - history: per-pipeline last 7 runs (newest first), grouped from a 100-row
//     fetch so the dashboard can render sparklines + a "last 5 runs" mini-table
//     without a per-pipeline round-trip
//   - enrichment_backlog: enrichment_queue depth split by tag/summary/in_progress
//     (table is from FIX-101 stage 1 schema; fall back to zeros if unavailable
//     so a missing/renamed table doesn't black out the whole pipelines card)
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
};

export async function getPipelines(db: Db) {
  const [recentRunsRes, cronState, queueResults] = await Promise.all([
    db
      .from("data_sync_log")
      .select(
        "pipeline, status, started_at, completed_at, rows_inserted, rows_updated, rows_failed, estimated_mb, error_message",
      )
      .order("completed_at", { ascending: false })
      .limit(100),
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
        .eq("enrichment_type", "tag"),
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending")
        .eq("enrichment_type", "summarize"),
      db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "in_progress"),
    ]),
  ]);

  const allRuns = (recentRunsRes.data ?? []) as PipelineHistoryRun[];

  const history: Record<string, PipelineHistoryRun[]> = {};
  for (const run of allRuns) {
    const bucket = (history[run.pipeline] ??= []);
    if (bucket.length < 7) bucket.push(run);
  }

  // First 10 runs in (pipeline, completed_at desc) order — back-compat shape
  // expected by callers that only want the slim PipelineRun fields.
  const recent_runs = allRuns.slice(0, 10).map((r) => ({
    pipeline: r.pipeline,
    status: r.status,
    completed_at: r.completed_at ?? "",
    rows_inserted: r.rows_inserted ?? 0,
  }));

  const safeCount = (
    r: PromiseSettledResult<{ count: number | null }>,
  ): number => (r.status === "fulfilled" ? (r.value.count ?? 0) : 0);

  return {
    recent_runs,
    cron_last_run: cronState.data?.value ?? null,
    history,
    enrichment_backlog: {
      pending_tag: safeCount(queueResults[0]),
      pending_summary: safeCount(queueResults[1]),
      in_progress: safeCount(queueResults[2]),
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
    .select("input_tokens, output_tokens, cost_cents")
    .eq("service", "anthropic")
    .gte("created_at", monthStart);

  type UsageRow = {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_cents: number | null;
  };
  const monthly_spent = ((rows ?? []) as UsageRow[]).reduce((sum, r) => {
    if (r.input_tokens != null && r.output_tokens != null) {
      return sum + (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000;
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
export async function getQuality(db: Db) {
  type QualityCountsRow = {
    vote_category_counts: Record<string, number> | null;
    total_pacs: number | string | null;
    tagged_pacs: number | string | null;
    vote_connection_total: number | string | null;
  };

  const [congressMembers, qualityCountsRes] = await Promise.all([
    db
      .from("officials")
      .select("source_ids, metadata")
      .in("role_title", ["Senator", "Representative"]),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc("get_quality_counts").then((r: any) => r),
  ]);

  const counts: QualityCountsRow = (qualityCountsRes.data?.[0] ??
    {}) as QualityCountsRow;
  const voteCategoryCountsMap = counts.vote_category_counts ?? {};
  const totalPacs = Number(counts.total_pacs ?? 0);
  const taggedPacs = Number(counts.tagged_pacs ?? 0);
  const voteConnTotal = Number(counts.vote_connection_total ?? 0);

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

  // Step 1: resolve Warren (needed for two checks). Sequential — every
  // downstream check waits on this, so it floors the section wall-clock.
  const warrenSearch = await timed("self_tests:warren_search", () =>
    db.rpc("search_graph_entities", { q: "warren", lim: 5 }),
  );
  type SearchRow = {
    id: string;
    label: string;
    entity_type: string;
    subtitle?: string | null;
  };
  const warrenRows = (warrenSearch.data ?? []) as SearchRow[];
  // FIX-339 + Warren resolver fix (2026-05-23): prod has three "Elizabeth
  // Warren" officials — one elected Senator (~606 vote_yes edges) plus two
  // FEC candidate slots ("Candidate for President", "Candidate for Senator",
  // both with ≤6 edges because rebuild_entity_connections joins votes to the
  // elected row, not candidate duplicates). The search RPC returns all three
  // with identical trigram sim, so `.find()` was picking the first candidate
  // slot. Prefer the row whose subtitle does NOT mark it as a candidate.
  const isElizabethWarrenOfficial = (r: SearchRow) =>
    r.label.toLowerCase().includes("elizabeth warren") &&
    r.entity_type === "official";
  const isCandidateSubtitle = (s?: string | null) =>
    (s ?? "").toLowerCase().includes("candidate for");
  const warrenEntity =
    warrenRows.find(
      (r) => isElizabethWarrenOfficial(r) && !isCandidateSubtitle(r.subtitle),
    ) ??
    warrenRows.find(isElizabethWarrenOfficial) ??
    warrenRows.find(
      (r) =>
        r.label.toLowerCase().endsWith("warren") && r.entity_type === "official",
    );
  const warrenId = warrenEntity?.id ?? null;

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

  const [
    chordData,
    warrenVotesRes,
    anthropicUsageResult,
    cronState,
    rebuildLastRunRes,
    drift,
  ] = await Promise.all([
    timed("self_tests:chord_industry_flows", () => db.rpc("chord_industry_flows")),

    // FIX-337: was count:'exact' (~8.3s). FIX-336 diagnostic showed
    // count:'planned' was no faster for this two-column indexed predicate.
    // Boolean check is `> 10`; .limit(11) is the minimum sufficient — no
    // COUNT co-query issued, index seek stops at 11 hits.
    // FIX-343: from_type leads the entity_connections_from composite index;
    // without this predicate the planner falls back to a vote_yes-edge scan
    // (~6s on prod).
    warrenId
      ? timed("self_tests:warren_votes_count", () =>
          db
            .from("entity_connections")
            .select("id")
            .eq("from_type", "official")
            .eq("from_id", warrenId)
            .eq("connection_type", "vote_yes")
            .limit(11),
        )
      : Promise.resolve({ data: null }),

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
    timed("self_tests:rebuild_last_run", () =>
      db
        .from("data_sync_log")
        .select("status, completed_at, rows_inserted")
        .eq("pipeline", "entity_connections_rebuild")
        .order("completed_at", { ascending: false })
        .limit(1)
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

  // FIX-340: shape of one data_sync_log row from the standalone rebuild script.
  const rebuildLastRun = (rebuildLastRunRes.data ?? null) as
    | { status: string; completed_at: string | null; rows_inserted: number | null }
    | null;
  // GHA workflow rebuild-entity-connections.yml runs Sun + Wed 08:00 UTC, so
  // the natural max-stale window is ~3.5 days; 4.5d gives a small cushion for
  // long-running rebuilds without false-passing a genuinely missed schedule.
  const REBUILD_STALE_MS = 4.5 * 24 * 60 * 60 * 1000;
  const rebuildAgeMs = rebuildLastRun?.completed_at
    ? Date.now() - new Date(rebuildLastRun.completed_at).getTime()
    : null;

  return [
    {
      name: "entity_search_finds_warren",
      passed: warrenEntity != null,
      detail: warrenEntity
        ? `Found ${warrenEntity.label} (${warrenEntity.id})`
        : "Elizabeth Warren not found in search results",
    },
    {
      name: "chord_has_industry_data",
      passed: !chordData.error && chordGroups >= 5,
      detail: chordData.error
        ? `RPC error: ${chordData.error.message}`
        : `${chordGroups} industry groups returned`,
    },
    {
      name: "warren_has_vote_connections",
      passed: (warrenVotesRes.data?.length ?? 0) > 10,
      // Senator Warren has ~600 vote_yes edges on prod; sample of 15 sitting
      // senators (2026-05-23) ranged 38–785 with median ~640. `> 10` stays
      // the floor — junior senators (Alsobrooks: 38) still clear it, but a
      // resolved-to-wrong-record bug like the pre-fix one (≤6 edges on a
      // candidate slot) trips it immediately.
      detail: warrenId
        ? `${warrenVotesRes.data?.length ?? 0}+ vote_yes connections (capped at 11)`
        : "Warren not found — skipped",
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
      passed:
        rebuildLastRun?.status === "complete" &&
        voteYesTotalCount > 50000 &&
        rebuildAgeMs != null &&
        rebuildAgeMs < REBUILD_STALE_MS,
      detail: rebuildLastRun
        ? `entity_connections_rebuild: ${rebuildLastRun.status} at ${rebuildLastRun.completed_at ?? "?"}${
            rebuildLastRun.rows_inserted != null
              ? ` (${rebuildLastRun.rows_inserted} rows)`
              : ""
          }, vote_yes total: ${voteYesTotalCount}${
            rebuildAgeMs != null
              ? `, age ${(rebuildAgeMs / (60 * 60 * 1000)).toFixed(1)}h`
              : ""
          }`
        : "No entity_connections_rebuild row in data_sync_log — has the Sun+Wed GHA workflow run since cutover?",
    },
    {
      name: "derived_edges_match_source",
      passed: drift.drifted.length === 0,
      detail:
        drift.drifted.length === 0
          ? `all ${drift.total_rules} derivation rules have non-zero derived edges`
          : `drift detected: ${drift.drifted.map((d) => `${d.type} has source rows but 0 derived edges`).join("; ")}`,
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

  const topFlows: Array<{ from: string; to: string; amount_usd: number }> = [];
  for (const [ind, pm] of flowMatrix)
    for (const [party, usd] of pm)
      topFlows.push({ from: lbl(ind), to: party, amount_usd: Math.round(usd) });
  topFlows.sort((a, b) => b.amount_usd - a.amount_usd);

  return {
    top_flows: topFlows.slice(0, 10),
    total_flow_usd: Math.round(totalFlow),
  };
}

// ── 9. Activity: top pages last 24 h ─────────────────────────────────────────
export async function getActivity(db: Db, yesterday: string) {
  const [countRes, pathRes] = await Promise.all([
    db
      .from("page_views")
      .select("*", { count: "exact", head: true })
      .gt("viewed_at", yesterday)
      .eq("is_bot", false),
    db
      .from("page_views")
      .select("path")
      .gt("viewed_at", yesterday)
      .eq("is_bot", false)
      .not("path", "in", `("/","/dashboard")`)
      .limit(500),
  ]);

  const counts: Record<string, number> = {};
  for (const r of (pathRes.data ?? []) as unknown as { path: string }[]) {
    counts[r.path] = (counts[r.path] ?? 0) + 1;
  }
  const topPages = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, views]) => ({ path, views }));

  return {
    page_views_24h: countRes.count ?? 0,
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

// ── 11. Officials breakdown ──────────────────────────────────────────────────
export async function getOfficialsBreakdown(db: Db) {
  const { data, error } = await db.rpc("get_officials_breakdown");
  if (error || !data) return null;
  type Row = { category: string; count: number };
  const rows = data as Row[];
  const get = (cat: string) => rows.find((r) => r.category === cat)?.count ?? 0;
  return { federal: get("federal"), state: get("state"), judges: get("judges") };
}
