/**
 * Anthropic Admin API — shared usage helper.
 *
 * Fetches three time windows (last hour, last 24h, this month) from the
 * Anthropic Organizations API, returning aggregated token counts and costs.
 *
 * Used by:
 *   /api/platform/anthropic  — dedicated dashboard card
 *   /api/claude/status       — health diagnostic endpoint
 *
 * Never throws — always returns a structured response with error field if
 * the key is missing or the API returns an error.
 */

// ── Response types ─────────────────────────────────────────────────────────────

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
  source: "api";
  fetched_at: string;
};

export type AnthropicUsageError = {
  error: string;
  source: "unavailable" | "api_error";
  fetched_at: string;
};

export type AnthropicUsageResponse = AnthropicUsageSuccess | AnthropicUsageError;

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

function buildUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.append(k, v);
  }
  return url.toString();
}

type UsageBucket = {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type CostBucket = {
  description?: string;
  cost?: number;
  total?: number;
  amount?: number;
};

function aggregateUsage(
  buckets: UsageBucket[],
  costBuckets: CostBucket[],
): AnthropicWindowUsage {
  const result = emptyWindow();

  // Aggregate tokens per model
  const byModel = new Map<string, AnthropicModelUsage>();
  for (const b of buckets) {
    const model = b.model ?? "unknown";
    const inp = b.input_tokens ?? 0;
    const out = b.output_tokens ?? 0;
    const cacheCreate = b.cache_creation_input_tokens ?? 0;
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

  // Aggregate cost from cost report, match to models by description
  let totalCost = 0;
  const costByModel = new Map<string, number>();
  for (const c of costBuckets) {
    const cost = c.cost ?? c.total ?? c.amount ?? 0;
    totalCost += cost;
    if (c.description) {
      // description may be a full model name or a display name
      const existing = costByModel.get(c.description) ?? 0;
      costByModel.set(c.description, existing + cost);
    }
  }
  result.cost_usd = totalCost;

  // Try to assign per-model costs; fall back to proportional distribution
  for (const [model, usage] of byModel) {
    let modelCost = costByModel.get(model) ?? 0;
    if (modelCost === 0 && costByModel.size > 0) {
      // Try partial match (model names sometimes differ between endpoints)
      for (const [desc, cost] of costByModel) {
        if (desc.includes(model) || model.includes(desc)) {
          modelCost = cost;
          break;
        }
      }
    }
    usage.cost_usd = modelCost;
    byModel.set(model, usage);
  }

  result.by_model = Array.from(byModel.values()).sort(
    (a, b) => b.cost_usd - a.cost_usd,
  );

  return result;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function getAnthropicUsage(): Promise<AnthropicUsageResponse> {
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  const orgId = process.env.ANTHROPIC_ORG_ID;
  const now = new Date();
  const fetched_at = now.toISOString();

  if (!adminKey) {
    return { error: "No admin key", source: "unavailable", fetched_at };
  }

  if (!orgId) {
    console.error("[Anthropic] Missing ANTHROPIC_ORG_ID env var");
    return { error: "Missing org ID", source: "unavailable", fetched_at };
  }

  const BASE = `https://api.anthropic.com/v1/organizations/${orgId}`;

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

  // 6 fetches: 3 windows × 2 endpoints (usage + cost)
  const tasks = (
    Object.entries(windows) as Array<
      [keyof typeof windows, (typeof windows)[keyof typeof windows]]
    >
  ).flatMap(([windowName, w]) => [
    {
      windowName,
      kind: "usage" as const,
      url: buildUrl("usage_report/messages", {
        starting_at: w.starting_at,
        ending_at: w.ending_at,
        bucket_width: w.bucket_width,
        "group_by[]": "model",
      }),
    },
    {
      windowName,
      kind: "cost" as const,
      url: buildUrl("cost_report", {
        starting_at: w.starting_at,
        ending_at: w.ending_at,
        bucket_width: w.bucket_width,
        "group_by[]": "description",
      }),
    },
  ]);

  const results = await Promise.allSettled(
    tasks.map(async (t) => {
      const res = await fetch(t.url, { headers, cache: "no-store" });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: unknown[] };
      return { ...t, data: json.data ?? [] };
    }),
  );

  // Check if all failed with the same error (likely bad key)
  const allFailed = results.every((r) => r.status === "rejected");
  if (allFailed) {
    const firstErr = results.find((r) => r.status === "rejected");
    const msg =
      firstErr?.status === "rejected"
        ? String(firstErr.reason)
        : "All requests failed";
    return { error: msg, source: "api_error", fetched_at };
  }

  // Organise results by window + kind
  const rawByWindow: Record<
    keyof typeof windows,
    { usage: UsageBucket[]; cost: CostBucket[] }
  > = {
    last_hour: { usage: [], cost: [] },
    last_24h: { usage: [], cost: [] },
    this_month: { usage: [], cost: [] },
  };

  results.forEach((result, i) => {
    const task = tasks[i]!;
    if (result.status === "fulfilled") {
      const data = result.value.data as UsageBucket[] | CostBucket[];
      if (task.kind === "usage") {
        rawByWindow[task.windowName].usage = data as UsageBucket[];
      } else {
        rawByWindow[task.windowName].cost = data as CostBucket[];
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

  const limitUsd =
    parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET ?? "") || 3.5;
  const spentUsd = this_month.cost_usd;
  const pctUsed = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;

  const budget: AnthropicBudget = {
    limit_usd: limitUsd,
    spent_usd: spentUsd,
    remaining_usd: Math.max(0, limitUsd - spentUsd),
    pct_used: Math.round(pctUsed * 10) / 10,
    warning: pctUsed > 80,
    critical: pctUsed > 95,
  };

  return { last_hour, last_24h, this_month, budget, source: "api", fetched_at };
}
