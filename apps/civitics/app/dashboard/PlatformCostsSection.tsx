"use client";

/**
 * Platform Costs — the R4b presentation rebuild (FIX-1091 / FIX-1092).
 *
 * ── WHAT CHANGED AND WHY ─────────────────────────────────────────────────────
 *
 * The headline is the only number this section exists to produce, and it used
 * to be assembled here out of three unrelated fields: Anthropic's actual spend,
 * a sum of non-Vercel metric overages, and Vercel's projected bill. Supabase
 * Pro's $25/month was in none of them. FIX-1089 built a true-cost data plane
 * (itemized subscriptions + billable usage, selected BY BASIS so a
 * credit-absorbed dollar can never be added to an owed one), so this file now
 * RENDERS a total rather than inventing one — $47.70 against the old $22.71.
 *
 * The anonymous "N metrics over limit" banners are gone. Every alert line names
 * its metric, states the magnitude and states the dollars, across three fixed
 * severities. `over` deliberately includes "is generating real money" as well
 * as "is band-critical", because those are different questions and
 * supabase.db_size_bytes is the case that proves it: $2.70/month owed, bands
 * (500/750, re-based by FIX-1089) correctly asleep.
 *
 * ── THE SNAPSHOT TRAP ────────────────────────────────────────────────────────
 *
 * This component renders a PERSISTED payload — `platform_usage_snapshot`, whose
 * GHA-driven cron drifts hours. So a freshly-deployed card reads OLD payloads
 * for a while, and every R4a field is optional here. The fallbacks are not
 * defensive noise; they are the only thing standing between a deploy and a
 * blank card. Old shape → old headline arithmetic, no cycles, no rates, no
 * per-provider itemization. Verified in both states.
 */

import { useState, useEffect, useMemo, type ReactNode } from "react";
import { SectionCard, SectionHeader, LoadingSkeleton, formatMetricValue } from "@civitics/ui";
import { Icon } from "@civitics/graph";
import type { PlatformMetric } from "@civitics/db";
import type { PlatformUsageResponse, AnthropicDetail, AiCosts } from "./useDashboardData";
import { useIsAdmin } from "@/lib/use-is-admin";
import {
  deriveAlerts,
  isDisplayedMetric,
  metricLabel,
  planLabelFor,
  serviceCosts,
  type AlertSeverity,
  type CostAlert,
  type CostsPayloadView,
  type Formatters,
  type ServiceCost,
} from "@/lib/platform-costs-view";
import { MeterKey } from "./components/CostMeter";
import { ProviderCostCard } from "./components/ProviderCostCard";
import { ThresholdsEditor } from "./components/ThresholdsEditor";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n === 0 ? "—" : String(n);
}

/**
 * `formatMetricValue` handles the units it was written for and falls through to
 * `String(value)` for the rest — which is how 498964 commands rendered as a
 * bare, unreadable digit run. The units FIX-1090 added (commands, emails,
 * users, connections) are grouped here rather than in @civitics/ui because they
 * are cost-card vocabulary, not general formatting.
 */
const LOCALE_UNITS = new Set(["commands", "emails", "users", "connections", "state"]);

function fmtValue(value: number, unit: string): string {
  // Bare locale number, no unit word: every one of these rows already names its
  // unit in `display_label` ("Monthly Commands", "DB connections (active)"), and
  // repeating it produced "25 connections / 60 connections".
  if (LOCALE_UNITS.has(unit)) return Math.round(value).toLocaleString();
  return formatMetricValue(value, unit);
}

const FORMATTERS: Formatters = { value: fmtValue, usd: fmtUsd };

// ── Providers ─────────────────────────────────────────────────────────────────

/**
 * FIX-1091 extended this from 5 entries to 8. GitHub, Upstash and Resend have
 * been COLLECTED since FIX-1090 and rendered nowhere — a provider missing from
 * this map is silently dropped from the section, which is exactly how $30.87 of
 * GitHub Actions runner time stayed invisible.
 *
 * Google Cloud is deliberately absent: FIX-1090's inventory found zero billable
 * GCP surface (the only Google integration is Sign-in-with-Google behind
 * Supabase Auth, which is free), so there is no collector and no card.
 */
const SERVICE_META: Record<string, { label: string; icon: string }> = {
  anthropic: { label: "Anthropic", icon: "anthropic" },
  supabase: { label: "Supabase", icon: "supabase" },
  vercel: { label: "Vercel", icon: "vercel" },
  cloudflare: { label: "Cloudflare R2", icon: "cloudflare" },
  github: { label: "GitHub", icon: "github" },
  upstash: { label: "Upstash", icon: "upstash" },
  resend: { label: "Resend", icon: "resend" },
  mapbox: { label: "Mapbox", icon: "mapbox" },
};

const SERVICE_ORDER = [
  "anthropic",
  "supabase",
  "vercel",
  "cloudflare",
  "github",
  "upstash",
  "resend",
  "mapbox",
];

// ── Alerts strip ──────────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<AlertSeverity, { dot: string; text: string; label: string }> = {
  over: { dot: "bg-accent", text: "text-ink", label: "over" },
  watch: { dot: "bg-amber", text: "text-ink", label: "watch" },
  steady: { dot: "bg-green-ink", text: "text-ink-soft", label: "steady" },
};

function AlertsStrip({ alerts }: { alerts: CostAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="mb-4 space-y-1 rounded-lg border border-rule/60 bg-paper-2/40 p-3">
      {alerts.map((a) => {
        const style = SEVERITY_STYLE[a.severity];
        return (
          <div key={a.key} className="flex items-start gap-2 text-xs" title={a.detail}>
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
            <span className="w-12 shrink-0 pt-px text-[10px] uppercase tracking-wide text-ink-soft/60">
              {style.label}
            </span>
            <span className={`min-w-0 ${style.text}`}>
              {a.tag && (
                <span className="mr-1.5 font-mono text-[10px] text-ink-soft/70">{a.tag}</span>
              )}
              {a.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Headline ──────────────────────────────────────────────────────────────────

function Headline({
  payload,
  legacyTotal,
  chordTotalFlowUsd,
}: {
  payload: PlatformUsageResponse;
  legacyTotal: number;
  chordTotalFlowUsd: number;
}) {
  const subs = payload.subscriptions_usd;
  const usage = payload.billable_usage_usd;
  const total = payload.total_monthly_usd ?? legacyTotal;
  const billing = payload.vercel_billing;
  const omissions = payload.cost_omissions ?? [];

  const items = [
    ...(subs?.items ?? []).map((s) => ({
      key: `sub:${s.service}:${s.name}`,
      text: `${SERVICE_META[s.service]?.label ?? s.service} ${s.name} ${fmtUsd(s.monthly_usd)}`,
      note: s.note,
      // "(stated)" belongs only on a SUBSCRIPTION we could not source from an
      // API — Supabase Pro's $25 is Craig-stated because every Supabase billing
      // endpoint 404s. On a usage line, `source: configured` means the RATE came
      // from platform_limits, which is not the same claim at all.
      stated: s.source === "configured",
    })),
    ...(usage?.items ?? []).map((u) => ({
      key: `usage:${u.service}:${u.metric ?? u.label}`,
      text: `${SERVICE_META[u.service]?.label ?? u.service} ${u.label} ${fmtUsd(u.usd)}`,
      note: u.note,
      stated: false,
    })),
  ];

  return (
    <div className="mt-4">
      <div className="px-1 text-3xl font-bold tabular-nums text-ink">
        {fmtUsd(total)}
        <span className="ml-1 text-sm font-normal text-ink-soft">/month</span>
      </div>

      {/* The decomposition. A scalar cannot be audited; this line is what makes
          the headline checkable against a vendor invoice, and what makes a
          MISSING line visible. */}
      <div className="mt-1 px-1 text-xs text-ink-soft">
        {subs && usage ? (
          <>
            <span className="text-ink">{fmtUsd(subs.total)}</span> subscriptions +{" "}
            <span className="text-ink">{fmtUsd(usage.total)}</span> billable usage
            {billing && (
              <>
                {" · "}
                <span className={billing.credit_remaining_usd <= 0 ? "font-medium text-accent" : ""}>
                  {fmtUsd(billing.credit_remaining_usd)} of Vercel&rsquo;s{" "}
                  {fmtUsd(billing.included_credit_usd)} usage credit unspent
                </span>
              </>
            )}
          </>
        ) : (
          <>
            Pre-R4a snapshot — subscriptions are not itemized in this payload yet, so this total is
            usage only. It self-corrects at the next snapshot tick.
          </>
        )}
      </div>

      {items.length > 0 && (
        <div className="mt-1 px-1 text-[11px] text-ink-soft/70">
          {items.map((i, idx) => (
            <span key={i.key} title={i.note ?? undefined}>
              {idx > 0 && " · "}
              {i.text}
              {i.stated && <span className="text-ink-soft/50"> (stated)</span>}
            </span>
          ))}
        </div>
      )}

      {omissions.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 px-1 text-[11px] text-amber">
          {omissions.map((o) => (
            <li key={o}>⚠ not priced: {o}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 px-1">
        <MeterKey />
      </div>

      {chordTotalFlowUsd > 0 && (
        <p className="mt-2 px-1 text-[11px] text-ink-soft/70">
          Tracking{" "}
          {chordTotalFlowUsd >= 1_000_000_000
            ? `$${(chordTotalFlowUsd / 1_000_000_000).toFixed(2)}B`
            : `$${(chordTotalFlowUsd / 1_000_000).toFixed(0)}M`}{" "}
          in political money for {fmtUsd(total)} a month — every line of it above, and every line
          auditable against a vendor invoice.
        </p>
      )}
    </div>
  );
}

// ── Anthropic detail (token table preserved verbatim) ─────────────────────────

function AnthropicDetailPanel({
  aiCosts,
  anthropicDetail,
}: {
  aiCosts?: AiCosts | null;
  anthropicDetail?: AnthropicDetail | null;
}) {
  const appOnlyCost = aiCosts?.monthly_spent_usd ?? 0;
  const totalCost = anthropicDetail?.this_month?.cost_usd;
  const showSplit = totalCost != null && Math.abs(totalCost - appOnlyCost) > 0.01;

  return (
    <div className="space-y-3">
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[320px] text-xs text-ink-soft">
          <thead>
            <tr className="border-b border-rule/60 text-right text-ink-soft/80">
              <th className="pb-1.5 text-left font-medium">Tokens</th>
              <th className="pb-1.5 font-medium">1h</th>
              <th className="pb-1.5 font-medium">24h</th>
              <th className="pb-1.5 font-medium">Month</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/40">
            <tr className="text-right">
              <td className="py-1.5 text-left">Input</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums">
                {fmtTokens(anthropicDetail?.this_month?.input_tokens ?? 0)}
              </td>
            </tr>
            <tr className="text-right">
              <td className="py-1.5 text-left">Output</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums">
                {fmtTokens(anthropicDetail?.this_month?.output_tokens ?? 0)}
              </td>
            </tr>
            <tr className="text-right">
              <td className="py-1.5 text-left">Cache hits</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums">
                {fmtTokens(anthropicDetail?.this_month?.cache_read_tokens ?? 0)}
              </td>
            </tr>
            <tr className="border-t border-rule/60 text-right font-medium">
              <td className="py-1.5 text-left">Total</td>
              <td className="tabular-nums">{fmtTokens(aiCosts?.last_hour_tokens ?? 0)}</td>
              <td className="tabular-nums">{fmtTokens(aiCosts?.last_24h_tokens ?? 0)}</td>
              <td className="tabular-nums">
                {fmtTokens(anthropicDetail?.this_month?.total_tokens ?? 0)}
              </td>
            </tr>
            <tr className="text-right">
              <td className="py-1.5 text-left text-ink-soft">Cost</td>
              <td className="tabular-nums text-ink-soft/70">—</td>
              <td className="tabular-nums">{fmtUsd(aiCosts?.last_24h_cost_usd ?? 0)}</td>
              <td className="tabular-nums font-medium">
                {fmtUsd(anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {showSplit && (
        <div className="flex justify-between text-xs text-ink-soft/80">
          <span>{fmtUsd(appOnlyCost)} from the Civitics app</span>
          <span>{fmtUsd((totalCost ?? 0) - appOnlyCost)} other tools on this account</span>
        </div>
      )}

      {anthropicDetail?.this_month?.by_model && anthropicDetail.this_month.by_model.length > 0 && (
        <div className="text-xs text-ink-soft">
          <div className="mb-1 font-medium text-ink-soft/80">By model</div>
          {anthropicDetail.this_month.by_model.map((m) => (
            <div key={m.model} className="flex justify-between py-0.5">
              <span className="max-w-[180px] truncate font-mono text-ink-soft/80">
                {m.model.replace("claude-", "")}
              </span>
              <span className="tabular-nums">
                {fmtTokens(m.input_tokens + m.output_tokens)} · {fmtUsd(m.cost_usd)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Provider-specific detail panels ───────────────────────────────────────────

function GithubDetailPanel({ github }: { github: NonNullable<PlatformUsageResponse["github"]> }) {
  const entries = Object.entries(github.minutes_breakdown ?? {});
  return (
    <div className="space-y-1 text-xs text-ink-soft">
      <div>
        {fmtUsd(github.gross_usd)} at list · <span className="text-ink">{fmtUsd(github.billed_usd)}</span>{" "}
        billed — GitHub bills Actions minutes at $0 on a public repository.
      </div>
      {entries.length > 0 && (
        <div>
          <div className="mb-0.5 font-medium text-ink-soft/80">Runner minutes</div>
          {entries.map(([runner, minutes]) => (
            <div key={runner} className="flex justify-between py-0.5">
              <span className="truncate">{runner}</span>
              <span className="tabular-nums">{Math.round(minutes).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UpstashDetailPanel({
  upstash,
}: {
  upstash: NonNullable<PlatformUsageResponse["upstash"]>;
}) {
  return (
    <div className="space-y-1 text-xs text-ink-soft">
      {upstash.state && (
        <div>
          Limiter state: <span className="text-ink">{upstash.state.replace(/_/g, " ")}</span>
          {upstash.last_transition_at && ` since ${upstash.last_transition_at.slice(11, 16)} UTC`}
        </div>
      )}
      {upstash.usage?.auto_upgrade === false && (
        <div>
          auto-upgrade is OFF — exhausting the allotment throttles the database rather than billing.
          A hard $0 ceiling, paid in rate limiting.
        </div>
      )}
      {upstash.detail && <div className="text-ink-soft/70">{upstash.detail}</div>}
    </div>
  );
}

// ── Manual usage entry (admin) ────────────────────────────────────────────────

/**
 * Kept from the pre-R4b card, but no longer rendered on every row.
 *
 * FIX-1090 retired the Mapbox manual-entry flow (a publishable token cannot
 * read Mapbox analytics, so the number is self-counted now), and every row in
 * the current payload reports `has_public_api = true` with nothing awaiting
 * verification — so these controls render for zero rows today. The CAPABILITY
 * survives for the next metric that genuinely has no API, rather than being
 * deleted along with the flow that no longer needs it.
 */
function manualEntryEligible(m: PlatformMetric): boolean {
  return m.has_public_api === false || m.source === "manual" || m.source_display.needsVerification;
}

function UpdateModal({
  metric,
  onClose,
  onSave,
}: {
  metric: PlatformMetric;
  onClose: () => void;
  onSave: (value: number) => Promise<void>;
}) {
  const [inputValue, setInputValue] = useState(metric.value !== null ? String(metric.value) : "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const num = parseFloat(inputValue);
    if (Number.isNaN(num)) return;
    setSaving(true);
    try {
      await onSave(num);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-rule bg-card p-6 shadow-xl">
        <h2 className="mb-1 text-base font-semibold text-ink">Update {metricLabel(metric)}</h2>
        <p className="mb-4 text-xs text-ink-soft">
          Source will be set to <span className="font-medium">manual</span>. Enter the value in{" "}
          {metric.unit}.
        </p>
        <input
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="w-full rounded-lg border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-ink-soft hover:text-ink">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper hover:bg-accent disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PlatformCostsSectionProps {
  platformUsage: PlatformUsageResponse | null;
  onRefresh: () => void;
  anthropicDetail?: AnthropicDetail | null;
  aiCosts?: AiCosts | null;
  chordTotalFlowUsd?: number;
}

export function PlatformCostsSection({
  platformUsage,
  onRefresh,
  anthropicDetail,
  aiCosts,
  chordTotalFlowUsd = 0,
}: PlatformCostsSectionProps) {
  const [mounted, setMounted] = useState(false);
  const [editingService, setEditingService] = useState<string | null>(null);
  const [updatingMetric, setUpdatingMetric] = useState<PlatformMetric | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const { isAdmin } = useIsAdmin();

  useEffect(() => setMounted(true), []);

  // Read the legacy admin key after mount only — never during SSR.
  useEffect(() => {
    try {
      setAdminKey(localStorage.getItem("civitics_admin_key") ?? "");
    } catch {
      // Blocked storage (private mode, etc.) — stay empty.
    }
  }, []);

  const payloadView: CostsPayloadView | null = platformUsage;

  const alerts = useMemo(
    () => (payloadView ? deriveAlerts(payloadView, FORMATTERS) : []),
    [payloadView],
  );
  const costsByService = useMemo(
    () => (payloadView ? serviceCosts(payloadView) : null),
    [payloadView],
  );

  async function adminPost(body: Record<string, unknown>) {
    const res = await fetch("/api/platform/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Admin action failed: HTTP ${res.status}`);
    onRefresh();
  }

  function metricControls(m: PlatformMetric): ReactNode {
    if (!isAdmin || !manualEntryEligible(m)) return null;
    return (
      <span className="flex gap-2">
        {m.source_display.needsVerification && (
          <button
            onClick={() =>
              void adminPost({ action: "verify_usage", service: m.service, metric: m.metric })
            }
            className="font-medium text-amber hover:text-amber/80"
          >
            verify
          </button>
        )}
        <button
          onClick={() => setUpdatingMetric(m)}
          className="text-ink-soft/80 hover:text-ink"
        >
          update
        </button>
      </span>
    );
  }

  if (!platformUsage) {
    return (
      <SectionCard>
        <SectionHeader icon={<Icon name="money" className="h-4 w-4" />} title="Platform Costs" />
        <div className="mt-4">
          {!mounted ? (
            <div className="h-48 animate-pulse rounded-xl border border-rule bg-card shadow-sm" />
          ) : (
            <LoadingSkeleton variant="card" />
          )}
        </div>
      </SectionCard>
    );
  }

  const { by_service } = platformUsage;
  const view = payloadView!;

  // ── Legacy (pre-FIX-1089) fallbacks ─────────────────────────────────────────
  // Only reachable while a snapshot written before the R4a data plane is still
  // the newest row. Same arithmetic the card used before this rebuild.
  const anthropicCost = anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0;
  const legacyServiceCost = (service: string, metrics: PlatformMetric[]): number => {
    if (service === "anthropic") return anthropicCost;
    if (service === "vercel") {
      return (
        platformUsage.vercel_billing?.projected_total_bill_usd ??
        metrics.find((m) => m.metric === "monthly_spend_usd")?.value ??
        0
      );
    }
    return metrics.reduce((sum, m) => sum + (m.overage_cost ?? 0), 0);
  };
  const legacyTotal = SERVICE_ORDER.reduce(
    (sum, service) => sum + legacyServiceCost(service, by_service[service] ?? []),
    0,
  );

  const editingMetrics = editingService
    ? (by_service[editingService] ?? []).filter(isDisplayedMetric)
    : [];

  return (
    <>
      <SectionCard>
        <SectionHeader
          icon={<Icon name="money" className="h-4 w-4" />}
          title="Platform Costs"
          description="Every cost is public record"
        />

        <Headline
          payload={platformUsage}
          legacyTotal={legacyTotal}
          chordTotalFlowUsd={chordTotalFlowUsd}
        />

        <div className="mt-4">
          <AlertsStrip alerts={alerts} />
        </div>

        <div className="space-y-3">
          {SERVICE_ORDER.map((service) => {
            const metrics = by_service[service] ?? [];
            // On an R4a payload a provider MISSING from the itemization costs
            // $0.00 — that is the roll-up's answer, not an absence of one. Only
            // a pre-R4a payload (no map at all) falls back to the old per-card
            // arithmetic. Getting this backwards is how Anthropic would show a
            // sub-cent legacy figure while the headline counted it as nothing.
            const cost: ServiceCost | null = costsByService
              ? (costsByService.get(service) ?? {
                  service,
                  subscriptions: 0,
                  usage: 0,
                  total: 0,
                  subItems: [],
                  usageItems: [],
                })
              : null;
            // A provider with neither metrics nor money has nothing to say.
            if (metrics.length === 0 && !cost) return null;
            const meta = SERVICE_META[service];
            if (!meta) return null;

            const selfCount =
              service === "mapbox" || service === "resend"
                ? view.self_counted?.[service as "mapbox" | "resend"]
                : undefined;

            return (
              <ProviderCostCard
                key={service}
                service={service}
                label={meta.label}
                icon={meta.icon}
                metrics={metrics}
                payload={view}
                cost={cost}
                legacyCost={legacyServiceCost(service, metrics)}
                planLabel={planLabelFor(view, service)}
                fmt={FORMATTERS}
                isAdmin={isAdmin}
                onEditThresholds={() => setEditingService(service)}
                metricControls={metricControls}
                footnote={
                  selfCount ? (
                    <>
                      Self-counted at our own send/call sites
                      {view.self_counted?.period ? ` for ${view.self_counted.period}` : ""} —{" "}
                      {selfCount.total.toLocaleString()} recorded.
                      {service === "mapbox" &&
                        " A LOWER BOUND: a publishable token cannot read Mapbox analytics, so browser-side map loads are not counted here."}
                      {service === "resend" &&
                        " Resend exposes no usable usage API (/emails lists only recently-retained rows), so this counts every call through sendEmail()."}
                    </>
                  ) : undefined
                }
                extra={
                  service === "anthropic" ? (
                    <AnthropicDetailPanel aiCosts={aiCosts} anthropicDetail={anthropicDetail} />
                  ) : service === "github" && platformUsage.github ? (
                    <GithubDetailPanel github={platformUsage.github} />
                  ) : service === "upstash" && platformUsage.upstash ? (
                    <UpstashDetailPanel upstash={platformUsage.upstash} />
                  ) : service === "vercel" && platformUsage.vercel_billing ? (
                    <VercelBillingPanel billing={platformUsage.vercel_billing} />
                  ) : service === "supabase" && view.supabase_account?.compute_addon ? (
                    <SupabaseAddonPanel addon={view.supabase_account.compute_addon} />
                  ) : undefined
                }
              />
            );
          })}
        </div>
      </SectionCard>

      {editingService && (
        <ThresholdsEditor
          serviceLabel={SERVICE_META[editingService]?.label ?? editingService}
          metrics={editingMetrics}
          onClose={() => setEditingService(null)}
          onSaved={onRefresh}
        />
      )}

      {updatingMetric && (
        <UpdateModal
          metric={updatingMetric}
          onClose={() => setUpdatingMetric(null)}
          onSave={(value) =>
            adminPost({
              action: "update_usage",
              service: updatingMetric.service,
              metric: updatingMetric.metric,
              value,
            })
          }
        />
      )}
    </>
  );
}

// ── Small provider panels ─────────────────────────────────────────────────────

function VercelBillingPanel({
  billing,
}: {
  billing: NonNullable<PlatformUsageResponse["vercel_billing"]>;
}) {
  return (
    <div className="space-y-1 text-xs text-ink-soft">
      <div>
        Projected bill <span className="text-ink">{fmtUsd(billing.projected_total_bill_usd)}</span> ={" "}
        {fmtUsd(billing.projected_total_bill_usd - billing.projected_billable_overage_usd)}{" "}
        subscription + {fmtUsd(billing.projected_billable_overage_usd)} billable overage. Gross list
        value of all consumption: {fmtUsd(billing.projected_gross_usd)}.
      </div>
      <div>
        {fmtUsd(billing.credit_remaining_usd)} of the {fmtUsd(billing.included_credit_usd)} usage
        credit unspent ({Math.round(billing.credit_used_pct)}% used).
        {!billing.projectable && " No daily granularity this tick — not projected."}
      </div>
      <div className="text-ink-soft/70">
        Vercel row quantities are projected from a calendar-month window while the billing cycle runs
        mid-month, so those meters carry a projection marker and no pace tick. Re-basing the
        projection would move the tuned alert bands and is deliberately a separate change
        (FIX-1089).
      </div>
    </div>
  );
}

function SupabaseAddonPanel({
  addon,
}: {
  addon: NonNullable<NonNullable<CostsPayloadView["supabase_account"]>["compute_addon"]>;
}) {
  return (
    <div className="text-xs text-ink-soft">
      Compute add-on: <span className="text-ink">{addon.name}</span>
      {addon.monthly_usd != null && ` at ${fmtUsd(addon.monthly_usd)}/mo list`} — Pro includes a $10
      monthly compute credit, so a Micro instance nets to $0. It stays on the books as a live row so
      an instance resize shows up as money the moment it happens.
    </div>
  );
}
