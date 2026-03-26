"use client";

import { useState, useEffect } from "react";
import { SectionCard, SectionHeader, LoadingSkeleton } from "@civitics/ui";
import type {
  AnthropicUsageResponse,
  AnthropicWindowUsage,
} from "@civitics/db";

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

// ── Source indicator ───────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  if (source === "api") {
    return (
      <span className="text-xs text-green-600 whitespace-nowrap">● Live</span>
    );
  }
  if (source === "unavailable") {
    return (
      <span className="text-xs text-gray-400 whitespace-nowrap">
        ○ No admin key
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 whitespace-nowrap">⚠ API error</span>
  );
}

// ── Token row in the 3-column table ───────────────────────────────────────────

function TokenRow({
  label,
  hour,
  day,
  month,
}: {
  label: string;
  hour: string;
  day: string;
  month: string;
}) {
  return (
    <tr className="border-b border-gray-50 last:border-0">
      <td className="py-1.5 text-sm text-gray-700 pr-4">{label}</td>
      <td className="py-1.5 text-sm tabular-nums text-right text-gray-900 w-16">
        {hour}
      </td>
      <td className="py-1.5 text-sm tabular-nums text-right text-gray-900 w-16">
        {day}
      </td>
      <td className="py-1.5 text-sm tabular-nums text-right text-gray-900 w-16">
        {month}
      </td>
    </tr>
  );
}

// ── By-model breakdown ────────────────────────────────────────────────────────

function ModelBreakdown({ window }: { window: AnthropicWindowUsage }) {
  const [open, setOpen] = useState(false);
  if (window.by_model.length === 0) return null;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
      >
        <span>{open ? "▲" : "▾"}</span>
        <span>
          {open ? "Hide" : "By model (this month)"}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-1">
          {window.by_model.map((m) => (
            <div
              key={m.model}
              className="flex items-center justify-between text-xs text-gray-700"
            >
              <span className="font-mono truncate max-w-[180px]" title={m.model}>
                {m.model}
              </span>
              <div className="flex gap-3 tabular-nums text-right shrink-0 ml-2">
                <span className="text-gray-500">
                  {fmtTokens(m.input_tokens + m.output_tokens)} tok
                </span>
                <span className="font-medium">{fmtUsd(m.cost_usd)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AnthropicCard() {
  const [data, setData] = useState<AnthropicUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/platform/anthropic")
      .then((r) => r.json())
      .then((json: AnthropicUsageResponse) => {
        setData(json);
      })
      .catch(() => {
        setData({
          error: "Failed to fetch",
          source: "api_error",
          fetched_at: new Date().toISOString(),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <SectionCard>
        <SectionHeader icon="🤖" title="Anthropic AI" />
        <div className="mt-4">
          <LoadingSkeleton variant="card" />
        </div>
      </SectionCard>
    );
  }

  const source = data?.source ?? "unavailable";

  // ── Error / no-key state ──────────────────────────────────────────────────
  if (!data || data.source !== "api") {
    return (
      <SectionCard>
        <div className="flex items-start justify-between">
          <SectionHeader icon="🤖" title="Anthropic AI" />
          <SourceBadge source={source} />
        </div>
        <div className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
          {source === "unavailable" ? (
            <>
              <p className="font-medium text-gray-900 mb-1">
                Add ANTHROPIC_ADMIN_API_KEY to see live usage data
              </p>
              <p className="text-xs text-gray-500">
                Generate one at{" "}
                <a
                  href="https://console.anthropic.com/settings/admin-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  console.anthropic.com
                </a>{" "}
                and add to .env.local as{" "}
                <span className="font-mono">ANTHROPIC_ADMIN_API_KEY</span>.
              </p>
            </>
          ) : (
            <p className="text-amber-700">
              {data && "error" in data ? data.error : "API error — check admin key"}
            </p>
          )}
        </div>
      </SectionCard>
    );
  }

  // ── Happy path ────────────────────────────────────────────────────────────
  const { last_hour, last_24h, this_month, budget } = data;
  const barColor = budget.critical
    ? "bg-red-500"
    : budget.warning
      ? "bg-amber-500"
      : "bg-green-500";

  return (
    <SectionCard>
      {/* Header row */}
      <div className="flex items-start justify-between">
        <SectionHeader
          icon="🤖"
          title="Anthropic AI"
          description={`${fmtUsd(budget.spent_usd)}/mo · ${budget.pct_used.toFixed(0)}% of ${fmtUsd(budget.limit_usd)} budget`}
        />
        <SourceBadge source={source} />
      </div>

      {/* Budget bar */}
      <div className="mt-3 mb-4">
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-200 ${barColor}`}
            style={{ width: `${Math.min(budget.pct_used, 100)}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-xs text-gray-400">
          <span>{fmtUsd(budget.spent_usd)} spent</span>
          <span>{fmtUsd(budget.remaining_usd)} remaining</span>
        </div>
      </div>

      {/* Token / cost table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="pb-1.5 text-left text-xs font-medium text-gray-500 pr-4">
                &nbsp;
              </th>
              <th className="pb-1.5 text-right text-xs font-medium text-gray-500 w-16">
                1h
              </th>
              <th className="pb-1.5 text-right text-xs font-medium text-gray-500 w-16">
                24h
              </th>
              <th className="pb-1.5 text-right text-xs font-medium text-gray-500 w-16">
                Month
              </th>
            </tr>
          </thead>
          <tbody>
            <TokenRow
              label="Input tokens"
              hour={fmtTokens(last_hour.input_tokens)}
              day={fmtTokens(last_24h.input_tokens)}
              month={fmtTokens(this_month.input_tokens)}
            />
            <TokenRow
              label="Output tokens"
              hour={fmtTokens(last_hour.output_tokens)}
              day={fmtTokens(last_24h.output_tokens)}
              month={fmtTokens(this_month.output_tokens)}
            />
            <TokenRow
              label="Cache hits"
              hour={fmtTokens(last_hour.cache_read_tokens)}
              day={fmtTokens(last_24h.cache_read_tokens)}
              month={fmtTokens(this_month.cache_read_tokens)}
            />
            <TokenRow
              label="Cost"
              hour={fmtUsd(last_hour.cost_usd)}
              day={fmtUsd(last_24h.cost_usd)}
              month={fmtUsd(this_month.cost_usd)}
            />
          </tbody>
        </table>
      </div>

      {/* Per-model breakdown (this month, collapsible) */}
      <ModelBreakdown window={this_month} />
    </SectionCard>
  );
}
