/**
 * Anthropic Admin API — shared usage helper.
 *
 * Fetches three time windows (last hour, last 24h, this month) from the
 * Anthropic Organizations API, returning aggregated token counts and costs.
 *
 * Confirmed API behaviour (tested 2026-03-26):
 *   Base:    https://api.anthropic.com/v1/organizations
 *   Paths:   usage_report/messages  |  cost_report
 *   Auth:    x-api-key: <admin key>  (sk-ant-admin01-...)
 *   Paging:  ?page=<token> until has_more: false  (≈7 buckets/page)
 *
 *   NOTE: The org ID must NOT appear in the URL path — the admin key already
 *   identifies the org. Correct URL: /v1/organizations/usage_report/messages
 *
 *   usage_report results fields:
 *     uncached_input_tokens, cache_read_input_tokens, output_tokens, model
 *     cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens }
 *
 *   cost_report results fields:
 *     amount (string, in USD CENTS), model, token_type, currency: "USD"
 *
 * Individual accounts: if the API returns 404/403 with "individual account"
 * in the error body (org-level reporting not available), falls back to
 * querying api_usage_logs in Supabase (source: "api_usage_logs").
 *
 * Used by:
 *   /api/platform/anthropic  — dedicated dashboard card
 *   /api/claude/status       — health diagnostic endpoint
 *
 * Never throws — always returns a structured response with error field set.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "./client";
import { selectAllOrThrow } from "./read-helpers";
import { calculateLoggedCostUsd } from "./ai-pricing";

// Base URL — no org ID in path; admin key determines the org
const BASE = "https://api.anthropic.com/v1/organizations";
const MAX_PAGES = 20; // safety cap

// ── Public types ───────────────────────────────────────────────────────────────

export type AnthropicModelUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type AnthropicWindowUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  by_model: AnthropicModelUsage[];
  /** True when data came from api_usage_logs fallback rather than the Anthropic Admin API.
   *  Cache/model breakdown fields will be zero/empty in this case. */
  from_logs?: boolean;
};

export type AnthropicBudget = {
  limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  pct_used: number;
  warning: boolean;
  critical: boolean;
};

export type AnthropicUsageSuccess = {
  last_hour: AnthropicWindowUsage;
  last_24h: AnthropicWindowUsage;
  this_month: AnthropicWindowUsage;
  budget: AnthropicBudget;
  source: "api" | "api_usage_logs";
  fetched_at: string;
};

export type AnthropicUsageError = {
  error: string;
  source: "unavailable" | "api_error";
  fetched_at: string;
};

export type AnthropicUsageResponse = AnthropicUsageSuccess | AnthropicUsageError;

// ── Internal API shapes ────────────────────────────────────────────────────────

type CacheCreation = {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
};

type UsageResult = {
  model?: string;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: CacheCreation;
};

type CostResult = {
  model?: string;
  amount?: string;        // USD cents as decimal string
  currency?: string;
  token_type?: string;
};

type TimeBucket<T> = {
  starting_at: string;
  ending_at: string;
  results: T[];
};

type PagedResponse<T> = {
  data: TimeBucket<T>[];
  has_more: boolean;
  next_page: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function emptyWindow(): AnthropicWindowUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    by_model: [],
  };
}

function buildUrl(
  path: string,
  params: Record<string, string>,
  pageToken?: string,
): string {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.append(k, v);
  }
  if (pageToken) url.searchParams.set("page", pageToken);
  return url.toString();
}

/**
 * Fetch all pages for an endpoint, accumulating every result entry.
 * Returns a flat array of all results across all time buckets and pages.
 */
async function fetchAllPages<T>(
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    const url = buildUrl(path, params, pageToken);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as PagedResponse<T>;

    // Flatten all results from all buckets on this page
    for (const bucket of json.data ?? []) {
      for (const r of bucket.results ?? []) {
        all.push(r);
      }
    }

    if (!json.has_more || !json.next_page) break;
    pageToken = json.next_page;
    page++;
  }

  return all;
}

/**
 * Returns true when the org-level endpoint is unavailable for this account.
 * We're always hitting /v1/organizations/... so any 403 or 404 means
 * org-level reporting isn't accessible — fall back to local usage logs.
 */
function isIndividualAccountError(msg: string): boolean {
  return msg.includes("HTTP 403") || msg.includes("HTTP 404");
}

type UsageLogRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
};

/** Fallback: build a window from api_usage_logs when org API is unavailable. */
async function fetchWindowFromLogs(
  startingAt: string,
  endingAt: string,
): Promise<AnthropicWindowUsage> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;
  // FIX-545: was silent-zero (an error rendered as $0 usage) and unpaginated
  // (a >1k-row month undercounted spend). Throws — the caller's try/catch
  // converts to the error-shape response.
  const rows = await selectAllOrThrow<UsageLogRow>(
    "anthropic usage-log window",
    (from, to) => supabase
      .from("api_usage_logs")
      .select("input_tokens, output_tokens, cost_cents")
      .eq("service", "anthropic")
      .gte("created_at", startingAt)
      .lte("created_at", endingAt)
      .order("created_at")
      .range(from, to),
  );

  const window = emptyWindow();
  for (const row of rows) {
    const inp = row.input_tokens ?? 0;
    const out = row.output_tokens ?? 0;
    window.input_tokens += inp;
    window.output_tokens += out;
    window.total_tokens += inp + out;
    window.cost_usd += (row.cost_cents ?? 0) / 100;
  }
  window.from_logs = true;
  return window;
}

function aggregateUsage(
  usageResults: UsageResult[],
  costResults: CostResult[],
): AnthropicWindowUsage {
  const result = emptyWindow();
  const byModel = new Map<string, AnthropicModelUsage>();

  for (const b of usageResults) {
    const model = b.model ?? "unknown";
    const inp = b.uncached_input_tokens ?? 0;
    const out = b.output_tokens ?? 0;
    const cacheCreate =
      (b.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
      (b.cache_creation?.ephemeral_5m_input_tokens ?? 0);
    const cacheRead = b.cache_read_input_tokens ?? 0;

    result.input_tokens += inp;
    result.output_tokens += out;
    result.cache_creation_tokens += cacheCreate;
    result.cache_read_tokens += cacheRead;

    const existing = byModel.get(model) ?? {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    existing.input_tokens += inp;
    existing.output_tokens += out;
    byModel.set(model, existing);
  }

  result.total_tokens =
    result.input_tokens +
    result.output_tokens +
    result.cache_creation_tokens +
    result.cache_read_tokens;

  // Aggregate cost per model (amount is a decimal string in USD cents)
  let totalCostCents = 0;
  const costCentsByModel = new Map<string, number>();
  for (const c of costResults) {
    const cents = parseFloat(c.amount ?? "0");
    if (isNaN(cents)) continue;
    totalCostCents += cents;
    if (c.model) {
      costCentsByModel.set(c.model, (costCentsByModel.get(c.model) ?? 0) + cents);
    }
  }
  result.cost_usd = totalCostCents / 100;

  // Assign per-model costs
  for (const [model, usage] of byModel) {
    const cents = costCentsByModel.get(model) ?? 0;
    usage.cost_usd = cents / 100;
    byModel.set(model, usage);
  }

  result.by_model = Array.from(byModel.values()).sort(
    (a, b) => b.cost_usd - a.cost_usd,
  );

  return result;
}

// ── In-memory cache (prevents rate-limiting on repeated calls) ─────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedResult: AnthropicUsageResponse | null = null;
let cacheExpiresAt = 0;

// ── Main export ────────────────────────────────────────────────────────────────

export async function getAnthropicUsage(): Promise<AnthropicUsageResponse> {
  const now = new Date();
  const fetched_at = now.toISOString();

  // Serve from cache if still fresh
  if (cachedResult && Date.now() < cacheExpiresAt) {
    return cachedResult;
  }

  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;

  if (!adminKey) {
    return { error: "No admin key", source: "unavailable", fetched_at };
  }

  const headers = {
    "anthropic-version": "2023-06-01",
    "x-api-key": adminKey,
  };

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const windows = {
    last_hour: {
      starting_at: new Date(now.getTime() - 3_600_000).toISOString(),
      ending_at: now.toISOString(),
      bucket_width: "1h",
    },
    last_24h: {
      starting_at: new Date(now.getTime() - 86_400_000).toISOString(),
      ending_at: now.toISOString(),
      bucket_width: "1h",
    },
    this_month: {
      starting_at: monthStart,
      ending_at: now.toISOString(),
      bucket_width: "1d",
    },
  };

  // 6 paginated fetches: 3 windows × 2 endpoints
  const windowNames = Object.keys(windows) as Array<keyof typeof windows>;

  const tasks = windowNames.flatMap((windowName) => {
    const w = windows[windowName];
    const timeParams = {
      starting_at: w.starting_at,
      ending_at: w.ending_at,
      bucket_width: w.bucket_width,
    };
    return [
      {
        windowName,
        kind: "usage" as const,
        promise: fetchAllPages<UsageResult>(
          "usage_report/messages",
          { ...timeParams, "group_by[]": "model" },
          headers,
        ),
      },
      {
        windowName,
        kind: "cost" as const,
        promise: fetchAllPages<CostResult>(
          "cost_report",
          { ...timeParams, "group_by[]": "description" },
          headers,
        ),
      },
    ];
  });

  const settled = await Promise.allSettled(tasks.map((t) => t.promise));

  // If all 6 failed, check for individual-account error → fall back to DB logs
  if (settled.every((r) => r.status === "rejected")) {
    const firstRejected = settled.find((r) => r.status === "rejected");
    const msg =
      firstRejected?.status === "rejected"
        ? String(firstRejected.reason)
        : "All requests failed";

    if (isIndividualAccountError(msg)) {
      try {
        const [last_hour, last_24h, this_month] = await Promise.all([
          fetchWindowFromLogs(
            new Date(now.getTime() - 3_600_000).toISOString(),
            now.toISOString(),
          ),
          fetchWindowFromLogs(
            new Date(now.getTime() - 86_400_000).toISOString(),
            now.toISOString(),
          ),
          fetchWindowFromLogs(monthStart, now.toISOString()),
        ]);

        const limitUsd = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET ?? "") || 3.5;
        const spentUsd = this_month.cost_usd;
        const pctUsed = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;

        const fallbackResult: AnthropicUsageResponse = {
          last_hour,
          last_24h,
          this_month,
          budget: {
            limit_usd: limitUsd,
            spent_usd: spentUsd,
            remaining_usd: Math.max(0, limitUsd - spentUsd),
            pct_used: Math.round(pctUsed * 10) / 10,
            warning: pctUsed > 80,
            critical: pctUsed > 95,
          },
          source: "api_usage_logs",
          fetched_at,
        };

        cachedResult = fallbackResult;
        cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        return fallbackResult;
      } catch {
        // DB fallback also failed — fall through to api_error
      }
    }

    return { error: msg, source: "api_error", fetched_at };
  }

  // Organise results by window
  const rawByWindow: Record<
    keyof typeof windows,
    { usage: UsageResult[]; cost: CostResult[] }
  > = {
    last_hour: { usage: [], cost: [] },
    last_24h: { usage: [], cost: [] },
    this_month: { usage: [], cost: [] },
  };

  settled.forEach((result, i) => {
    const task = tasks[i]!;
    if (result.status === "fulfilled") {
      if (task.kind === "usage") {
        rawByWindow[task.windowName].usage = result.value as UsageResult[];
      } else {
        rawByWindow[task.windowName].cost = result.value as CostResult[];
      }
    }
  });

  const last_hour = aggregateUsage(
    rawByWindow.last_hour.usage,
    rawByWindow.last_hour.cost,
  );
  const last_24h = aggregateUsage(
    rawByWindow.last_24h.usage,
    rawByWindow.last_24h.cost,
  );
  const this_month = aggregateUsage(
    rawByWindow.this_month.usage,
    rawByWindow.this_month.cost,
  );

  const limitUsd = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET ?? "") || 3.5;
  const spentUsd = this_month.cost_usd;
  const pctUsed = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;

  const result: AnthropicUsageResponse = {
    last_hour,
    last_24h,
    this_month,
    budget: {
      limit_usd: limitUsd,
      spent_usd: spentUsd,
      remaining_usd: Math.max(0, limitUsd - spentUsd),
      pct_used: Math.round(pctUsed * 10) / 10,
      warning: pctUsed > 80,
      critical: pctUsed > 95,
    },
    source: "api",
    fetched_at,
  };

  cachedResult = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return result;
}

// ── Per-request spend helper ──────────────────────────────────────────────────
//
// Cheap SUM of api_usage_logs for the current month, used by the AI client
// per-request kill gate. Cached for 60s so a burst of AI calls hits the
// cached value rather than the table. Returns USD (decimal), null on error.
//
// Distinct from getAnthropicUsage() — which talks to the Anthropic Admin API
// and is the dashboard's source of truth — and from the snapshot helper in
// platform-snapshot.ts, which intentionally bypasses this cache because it
// runs every 10 min and wants fresh numbers.

type UsageLogSumRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  // FIX-893: needed so spend is priced by the model that actually ran.
  model: string | null;
};

const PER_REQUEST_CACHE_TTL_MS = 60_000;
let cachedSpendUsd: number | null = null;
let cachedSpendExpiresAt = 0;

export function clearMonthlyAnthropicSpendCache(): void {
  cachedSpendUsd = null;
  cachedSpendExpiresAt = 0;
}

export async function getMonthlyAnthropicSpend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<number | null> {
  if (cachedSpendUsd !== null && Date.now() < cachedSpendExpiresAt) {
    return cachedSpendUsd;
  }

  try {
    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    ).toISOString();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;
    // FIX-545: paginate + throw; the surrounding catch keeps the null
    // ("unknown spend") contract for the AI gate, and a >1k-row month no
    // longer silently undercounts spend.
    const rows = await selectAllOrThrow<UsageLogSumRow>(
      "anthropic monthly-spend logs",
      (from, to) => anyDb
        .from("api_usage_logs")
        .select("input_tokens, output_tokens, cost_cents, model")
        .eq("service", "anthropic")
        .gte("created_at", monthStart)
        .order("created_at")
        .range(from, to),
    );

    // FIX-893: was an inline (in*0.25 + out*1.25) that both used Haiku-3-era
    // prices AND ignored the model column, so every row priced as Haiku no
    // matter what actually ran. calculateLoggedCostUsd reads the row's model
    // and prices an unknown one at the highest known rate — erring high is the
    // safe direction for a spend guard.
    const total = rows.reduce((sum, r) => {
      if (r.input_tokens != null && r.output_tokens != null) {
        return sum + calculateLoggedCostUsd(r.input_tokens, r.output_tokens, r.model);
      }
      return sum + (r.cost_cents ?? 0) / 100;
    }, 0);

    const spend = Math.round(total * 10000) / 10000;
    cachedSpendUsd = spend;
    cachedSpendExpiresAt = Date.now() + PER_REQUEST_CACHE_TTL_MS;
    return spend;
  } catch {
    return null;
  }
}

// Anthropic monthly limit (USD) from platform_limits, cached alongside the
// spend so the AI gate makes one read per minute instead of two per request.
let cachedLimitUsd: number | null = null;
let cachedLimitExpiresAt = 0;

export async function getMonthlyAnthropicLimitUsd(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  plan: string = "free",
): Promise<number | null> {
  if (cachedLimitUsd !== null && Date.now() < cachedLimitExpiresAt) {
    return cachedLimitUsd;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;
    const { data } = await anyDb
      .from("platform_limits")
      .select("included_limit")
      .eq("service", "anthropic")
      .eq("metric", "monthly_spend_usd")
      .eq("plan", plan)
      .maybeSingle();

    const limit =
      typeof data?.included_limit === "number"
        ? data.included_limit
        : data?.included_limit != null
          ? Number(data.included_limit)
          : null;

    cachedLimitUsd = limit;
    cachedLimitExpiresAt = Date.now() + PER_REQUEST_CACHE_TTL_MS;
    return limit;
  } catch {
    return null;
  }
}
