"use client";

import { useState } from "react";
import { SectionCard, SectionHeader, LoadingSkeleton } from "@civitics/ui";
import type { AiCosts } from "../useDashboardData";

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

// ── Source badge ────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  if (source === "api") return <span className="text-xs text-green-600">● Live</span>;
  if (source === "unavailable") return <span className="text-xs text-gray-400">○ No admin key</span>;
  return <span className="text-xs text-amber-600">⚠ Estimated</span>;
}

// ── Props ───────────────────────────────────────────────────────────────────

interface AnthropicCardProps {
  aiCosts: AiCosts | null;
}

// ── Main component ──────────────────────────────────────────────────────────

export function AnthropicCard({ aiCosts }: AnthropicCardProps) {
  const [showTokens, setShowTokens] = useState(false);
  const isLoading = aiCosts === null;
  const source = aiCosts?.source ?? "unavailable";
  const isLive = source === "api";

  return (
    <SectionCard>
      <div className="flex items-start justify-between">
        <SectionHeader
          icon="🤖"
          title="Anthropic AI"
          description={
            aiCosts
              ? `${fmtUsd(aiCosts.monthly_spent_usd)}/mo · ${aiCosts.budget_used_pct.toFixed(0)}% of ${fmtUsd(aiCosts.monthly_budget_usd)} budget`
              : undefined
          }
        />
        {!isLoading && <SourceBadge source={source} />}
      </div>

      {isLoading ? (
        <div className="mt-4">
          <LoadingSkeleton variant="card" />
        </div>
      ) : !isLive && source !== "api_usage_logs" ? (
        <div className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
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
            and set <span className="font-mono">ANTHROPIC_ADMIN_API_KEY</span> in .env.local.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          {/* Budget bar */}
          <div className="mb-4">
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  aiCosts!.budget_used_pct > 95
                    ? "bg-red-500"
                    : aiCosts!.budget_used_pct > 80
                      ? "bg-amber-500"
                      : "bg-green-500"
                }`}
                style={{ width: `${Math.min(aiCosts!.budget_used_pct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-400">
              <span>{fmtUsd(aiCosts!.monthly_spent_usd)} spent</span>
              <span>
                {fmtUsd(Math.max(0, aiCosts!.monthly_budget_usd - aiCosts!.monthly_spent_usd))}{" "}
                remaining
              </span>
            </div>
          </div>

          {/* Summary rows */}
          {(aiCosts!.last_hour_tokens != null || aiCosts!.last_24h_tokens != null) && (
            <div className="space-y-2">
              <div className="flex items-center pb-1.5 border-b border-gray-100 text-xs font-medium text-gray-500">
                <span className="flex-1" />
                <span className="w-24 text-right">Tokens</span>
                <span className="w-16 text-right">Cost</span>
              </div>
              {aiCosts!.last_hour_tokens != null && (
                <div className="flex items-center text-sm">
                  <span className="flex-1 text-gray-700">Last hour</span>
                  <span className="w-24 text-right tabular-nums text-gray-900">
                    {fmtTokens(aiCosts!.last_hour_tokens)}
                  </span>
                  <span className="w-16 text-right tabular-nums text-gray-400">—</span>
                </div>
              )}
              {aiCosts!.last_24h_tokens != null && (
                <div className="flex items-center text-sm">
                  <span className="flex-1 text-gray-700">Last 24h</span>
                  <span className="w-24 text-right tabular-nums text-gray-900">
                    {fmtTokens(aiCosts!.last_24h_tokens)}
                  </span>
                  <span className="w-16 text-right tabular-nums text-gray-900">
                    {aiCosts!.last_24h_cost_usd != null
                      ? fmtUsd(aiCosts!.last_24h_cost_usd)
                      : "—"}
                  </span>
                </div>
              )}
              <div className="flex items-center text-sm border-t border-gray-50 pt-2">
                <span className="flex-1 text-gray-700">This month</span>
                <span className="w-24 text-right tabular-nums text-gray-900">
                  {aiCosts!.this_month_total_tokens != null
                    ? fmtTokens(aiCosts!.this_month_total_tokens)
                    : "—"}
                </span>
                <span className="w-16 text-right tabular-nums text-gray-900">
                  {fmtUsd(aiCosts!.monthly_spent_usd)}
                </span>
              </div>
            </div>
          )}

          {/* Token detail toggle */}
          <button
            onClick={() => setShowTokens(!showTokens)}
            className="text-xs text-gray-400 hover:text-gray-600 mt-2"
          >
            {showTokens ? "▲ Show less" : "▾ Show token details"}
          </button>

          {showTokens && (
            <table className="w-full text-xs mt-2 text-gray-600">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-left py-1">Metric</th>
                  <th className="text-right py-1">1h</th>
                  <th className="text-right py-1">24h</th>
                  <th className="text-right py-1">Month</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Input tokens</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_hour?.input_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_24h?.input_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.this_month?.input_tokens ?? 0)}</td>
                </tr>
                <tr>
                  <td>Output tokens</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_hour?.output_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_24h?.output_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.this_month?.output_tokens ?? 0)}</td>
                </tr>
                <tr>
                  <td>Cache hits</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_hour?.cache_read_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.last_24h?.cache_read_tokens ?? 0)}</td>
                  <td className="text-right">{fmtTokens(aiCosts!.this_month?.cache_read_tokens ?? 0)}</td>
                </tr>
                <tr className="border-t border-gray-100 font-medium">
                  <td>Cost</td>
                  <td className="text-right">{fmtUsd(aiCosts!.last_hour?.cost_usd ?? 0)}</td>
                  <td className="text-right">{fmtUsd(aiCosts!.last_24h?.cost_usd ?? 0)}</td>
                  <td className="text-right">{fmtUsd(aiCosts!.this_month?.cost_usd ?? 0)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </SectionCard>
  );
}
