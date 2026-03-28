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

import { createAdminClient } from "./client";

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
    const res = await fetch(url, { headers, cache: "no-store" });
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

/** Returns true when the error looks like an individual-account 403/404. */
function isIndividualAccountError(msg: string): boolean {
  return (msg.includes("HTTP 403") || msg.includes("HTTP 404")) &&
    msg.toLowerCase().includes("individual");
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
  const { data } = await supabase
    .from("api_usage_logs")
    .select("input_tokens, output_tokens, cost_cents")
    .eq("service", "anthropic")
    .gte("created_at", startingAt)
    .lte("created_at", endingAt);

  const window = emptyWindow();
  for (const row of (data ?? []) as UsageLogRow[]) {
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
