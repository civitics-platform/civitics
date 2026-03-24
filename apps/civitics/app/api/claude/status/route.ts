/**
 * GET /api/claude/status
 *
 * Platform health diagnostic endpoint. No auth required — all civic data is public.
 * Runs all queries in parallel for speed. Target: under 2 seconds.
 *
 * Rate limit: 60 requests/hour/IP (in-memory, resets on cold start).
 * Never returns 500 — always 200 with whatever data is available.
 * Sections that error are marked { error: string; partial: true }.
 */

export const revalidate = 300; // Cache at edge 5 minutes — reduces DB egress significantly

import { createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";

// ── Rate limiter: 60 req/hour/IP ─────────────────────────────────────────────
const RL = new Map<string, { n: number; t: number }>();
const RL_MAX = 60;
const RL_WIN_MS = 60 * 60 * 1000; // 1 hour

function getIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function rateOk(ip: string): boolean {
  const now = Date.now();
  const s = RL.get(ip);
  if (!s || now - s.t > RL_WIN_MS) {
    RL.set(ip, { n: 1, t: now });
    return true;
  }
  if (s.n >= RL_MAX) return false;
  s.n++;
  return true;
}

// ── Known connection types (from database enum) ───────────────────────────────
const CONNECTION_TYPES = [
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

// ── Vote categories ───────────────────────────────────────────────────────────
const VOTE_CATEGORIES = [
  "substantive",
  "procedural",
  "nomination",
  "treaty",
  "amendment",
] as const;

// ── Section wrapper: returns partial result on error, never throws ────────────
async function section<T>(
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

// ── eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createAdminClient>;

export async function GET(request: Request) {
  const ip = getIp(request);
  if (!rateOk(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — 60 requests per hour per IP" },
      { status: 429 },
    );
  }

  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as Db & Record<string, any>;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // ── All 10 sections run in parallel ──────────────────────────────────────
  const [version, database, connectionTypes, pipelines, aiCosts, quality, selfTests, chordSection, activitySection, resourceWarnings] =
    await Promise.all([
      // ── 1. Platform version ──────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const latestSync = await (db as any)
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
      }),

      // ── 2. Row counts ────────────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const [
          officials,
          proposals,
          votes,
          connections,
          finRel,
          finEnt,
          tags,
          cache,
          views,
        ] = await Promise.all([
          anyDb.from("officials").select("*", { count: "exact", head: true }),
          anyDb.from("proposals").select("*", { count: "exact", head: true }),
          anyDb.from("votes").select("*", { count: "exact", head: true }),
          anyDb
            .from("entity_connections")
            .select("*", { count: "exact", head: true }),
          anyDb
            .from("financial_relationships")
            .select("*", { count: "exact", head: true }),
          anyDb
            .from("financial_entities")
            .select("*", { count: "exact", head: true }),
          anyDb.from("entity_tags").select("*", { count: "exact", head: true }),
          anyDb
            .from("ai_summary_cache")
            .select("*", { count: "exact", head: true }),
          anyDb
            .from("page_views")
            .select("*", { count: "exact", head: true })
            .gt("viewed_at", yesterday)
            .eq("is_bot", false),
        ]);
        return {
          officials: officials.count ?? 0,
          proposals: proposals.count ?? 0,
          votes: votes.count ?? 0,
          entity_connections: connections.count ?? 0,
          financial_relationships: finRel.count ?? 0,
          financial_entities: finEnt.count ?? 0,
          entity_tags: tags.count ?? 0,
          ai_summary_cache: cache.count ?? 0,
          page_views_24h: views.count ?? 0,
        };
      }),

      // ── 3. Connection type breakdown ─────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const results = await Promise.all(
          CONNECTION_TYPES.map((ct) =>
            anyDb
              .from("entity_connections")
              .select("*", { count: "exact", head: true })
              .eq("connection_type", ct)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .then((r: any) => ({ connection_type: ct, count: r.count ?? 0 })),
          ),
        );
        return results.sort(
          (
            a: { count: number },
            b: { count: number },
          ) => b.count - a.count,
        );
      }),

      // ── 4. Pipeline status ───────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const [recentRuns, cronState] = await Promise.all([
          anyDb
            .from("data_sync_log")
            .select("pipeline, status, completed_at, rows_inserted")
            .order("completed_at", { ascending: false })
            .limit(10),
          anyDb
            .from("pipeline_state")
            .select("value")
            .eq("key", "cron_last_run")
            .maybeSingle(),
        ]);
        return {
          recent_runs: recentRuns.data ?? [],
          cron_last_run: cronState.data?.value ?? null,
        };
      }),

      // ── 5. AI costs ──────────────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const { data: rows } = await anyDb
          .from("api_usage_logs")
          .select("input_tokens, output_tokens, cost_cents")
          .eq("service", "anthropic")
          .gte("created_at", monthStart);

        type UsageRow = {
          input_tokens: number | null;
          output_tokens: number | null;
          cost_cents: number | null;
        };
        const monthly_spent = ((rows ?? []) as UsageRow[]).reduce(
          (sum, r) => {
            if (r.input_tokens != null && r.output_tokens != null) {
              return (
                sum +
                (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000
              );
            }
            return sum + (r.cost_cents ?? 0) / 100;
          },
          0,
        );

        return {
          monthly_spent_usd: Math.round(monthly_spent * 10000) / 10000,
          monthly_budget_usd: 3.5,
          budget_used_pct: Math.round((monthly_spent / 3.5) * 1000) / 10,
          month_start: monthStart,
          source: "api_usage_logs",
        };
      }),

      // ── 6. Data quality checks ───────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;

        // Wave 1: fetch data needed for all quality checks in parallel
        const [congressMembers, voteCategoryCounts, totalPacsRes, voteConnTotal] =
          await Promise.all([
            // Congress members — only ~535 rows, so fetching for JS-side filter is fine
            anyDb
              .from("officials")
              .select("source_ids, metadata")
              .in("role_title", ["Senator", "Representative"]),

            // Vote category breakdown — parallel per-category counts
            Promise.all(
              VOTE_CATEGORIES.map((cat) =>
                anyDb
                  .from("proposals")
                  .select("*", { count: "exact", head: true })
                  .eq("vote_category", cat)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .then((r: any) => ({ vote_category: cat, count: r.count ?? 0 })),
              ),
            ),

            // Total PAC count
            anyDb
              .from("financial_entities")
              .select("*", { count: "exact", head: true })
              .eq("entity_type", "pac"),

            // Total vote connections (all vote types)
            anyDb
              .from("entity_connections")
              .select("*", { count: "exact", head: true })
              .in("connection_type", ["vote_yes", "vote_no", "vote_abstain", "nomination_vote_yes", "nomination_vote_no"]),
          ]);

        // Wave 2: PAC IDs needed for industry tag coverage join
        const pacIdRows = await anyDb
          .from("financial_entities")
          .select("id")
          .eq("entity_type", "pac")
          .limit(2000);
        const pacIds: string[] = (pacIdRows.data ?? []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => r.id as string,
        );
        const { count: taggedPacs } = await anyDb
          .from("entity_tags")
          .select("entity_id", { count: "exact", head: true })
          .in("entity_id", pacIds)
          .eq("tag_category", "industry");

        // Compute FEC coverage and missing state from congress members
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
        const totalPacs = totalPacsRes.count ?? 0;

        return {
          fec_coverage: {
            total,
            has_fec,
            pct: total ? Math.round((has_fec / total) * 1000) / 10 : 0,
          },
          missing_state,
          vote_categories: (voteCategoryCounts as { vote_category: string; count: number }[]).filter(
            (r) => r.count > 0,
          ),
          industry_tags: {
            total: totalPacs,
            tagged: taggedPacs ?? 0,
            pct: totalPacs
              ? Math.round(((taggedPacs ?? 0) / totalPacs) * 1000) / 10
              : 0,
            note: pacIds.length >= 2000 ? "tagged count capped at first 2000 PACs" : undefined,
          },
          vote_connections: voteConnTotal.count ?? 0,
        };
      }),

      // ── 7. Self-tests ────────────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;

        // Step 1: resolve Warren (needed for two checks)
        const warrenSearch = await anyDb.rpc("search_graph_entities", {
          q: "warren",
          lim: 5,
        });
        type SearchRow = { id: string; label: string; entity_type: string };
        const warrenRows = (warrenSearch.data ?? []) as SearchRow[];
        const warrenEntity = warrenRows.find(
          (r) =>
            r.label.toLowerCase().includes("elizabeth warren") ||
            (r.label.toLowerCase().endsWith("warren") &&
              r.entity_type === "official"),
        );
        const warrenId = warrenEntity?.id ?? null;

        // Step 2: parallel remaining checks
        const [
          chordData,
          warrenVotesRes,
          usageRows,
          cronState,
          connPipelineRes,
          voteYesTotal,
        ] = await Promise.all([
          anyDb.rpc("chord_industry_flows"),

          warrenId
            ? anyDb
                .from("entity_connections")
                .select("*", { count: "exact", head: true })
                .eq("from_id", warrenId)
                .eq("connection_type", "vote_yes")
            : Promise.resolve({ count: null }),

          anyDb
            .from("api_usage_logs")
            .select("input_tokens, output_tokens, cost_cents")
            .eq("service", "anthropic")
            .gte("created_at", monthStart),

          anyDb
            .from("pipeline_state")
            .select("value")
            .eq("key", "cron_last_run")
            .maybeSingle(),

          anyDb
            .from("data_sync_log")
            .select("status, rows_inserted, completed_at")
            .eq("pipeline", "connections")
            .order("completed_at", { ascending: false })
            .limit(1)
            .maybeSingle(),

          anyDb
            .from("entity_connections")
            .select("*", { count: "exact", head: true })
            .eq("connection_type", "vote_yes"),
        ]);

        // Compute monthly spend for budget check
        type UsageRow = {
          input_tokens: number | null;
          output_tokens: number | null;
          cost_cents: number | null;
        };
        const monthlySpent = ((usageRows.data ?? []) as UsageRow[]).reduce(
          (sum, r) => {
            if (r.input_tokens != null && r.output_tokens != null) {
              return (
                sum +
                (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000
              );
            }
            return sum + (r.cost_cents ?? 0) / 100;
          },
          0,
        );

        // chord: count distinct industries (excluding untagged)
        type ChordRow = { industry: string };
        const chordGroups = chordData.error
          ? 0
          : ((chordData.data ?? []) as ChordRow[]).filter(
              (r) => r.industry !== "untagged",
            ).length;

        const cronLastRun =
          cronState.data?.value?.completed_at ??
          cronState.data?.value?.started_at ??
          null;

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
            passed: (warrenVotesRes.count ?? 0) > 10,
            detail: warrenId
              ? `${warrenVotesRes.count ?? 0} vote_yes connections (expected ~23 per-proposal deduplicated)`
              : "Warren not found — skipped",
          },
          {
            name: "ai_budget_ok",
            passed: monthlySpent < 3.5 * 0.9,
            detail: `$${monthlySpent.toFixed(4)} of $3.50 budget (${Math.round((monthlySpent / 3.5) * 100)}% used)`,
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
              connPipelineRes.data?.status === "complete" &&
              (voteYesTotal.count ?? 0) > 50000,
            detail: connPipelineRes.data
              ? `Status: ${connPipelineRes.data.status}, vote_yes total: ${voteYesTotal.count ?? 0}`
              : "No connections pipeline run found in data_sync_log",
          },
        ];
      }),
      // ── 8. Chord top flows ───────────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const { data, error } = await anyDb.rpc("chord_industry_flows");
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
      }),

      // ── 9. Activity: top pages last 24 h ────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const [countRes, pathRes] = await Promise.all([
          anyDb
            .from("page_views")
            .select("*", { count: "exact", head: true })
            .gt("viewed_at", yesterday)
            .eq("is_bot", false),
          anyDb
            .from("page_views")
            .select("path")
            .gt("viewed_at", yesterday)
            .eq("is_bot", false)
            .not("path", "in", `("/","/dashboard")`)
            .limit(500),
        ]);

        const counts: Record<string, number> = {};
        for (const r of (pathRes.data ?? []) as { path: string }[]) {
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
      }),

      // ── 10. Resource warnings ────────────────────────────────────────
      section(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const { data: egressRow } = await anyDb
          .from("pipeline_state")
          .select("value")
          .eq("key", "monthly_egress_estimate")
          .maybeSingle();
        const egressMb = (egressRow?.value as Record<string, unknown> | null)?.egress_mb as number ?? 0;
        const EGRESS_LIMIT_MB = 5000;
        return {
          egress_estimate_mb: egressMb,
          egress_limit_mb: EGRESS_LIMIT_MB,
          egress_pct: Math.round(egressMb / EGRESS_LIMIT_MB * 100),
          egress_warning: egressMb > 4000,
          egress_critical: egressMb > 4750,
        };
      }),
    ]);

  const query_time_ms = Date.now() - t0;

  return NextResponse.json(
    {
      meta: {
        query_time_ms,
        timestamp: now.toISOString(),
      },
      version,
      database,
      connection_types: connectionTypes,
      pipelines,
      ai_costs: aiCosts,
      quality,
      self_tests: selfTests,
      chord: chordSection,
      activity: activitySection,
      resource_warnings: resourceWarnings,
    },
    {},
  );
}
