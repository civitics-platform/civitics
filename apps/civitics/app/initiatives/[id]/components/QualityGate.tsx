"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

// ─── Threshold explainer ──────────────────────────────────────────────────────

const TIER_TABLE = [
  { range: "< 100K",  upvotes: 10,  example: "Small town / rural district" },
  { range: "< 500K",  upvotes: 25,  example: "Mid-sized city"               },
  { range: "< 2M",    upvotes: 50,  example: "Large city or county"         },
  { range: "< 10M",   upvotes: 100, example: "Small state"                  },
  { range: "< 50M",   upvotes: 200, example: "Large state"                  },
  { range: "50M+",    upvotes: 500, example: "Federal"                      },
];

function ThresholdExplainer({ currentTierLabel }: { currentTierLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-rule pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] text-ink-soft/70 hover:text-ink-soft transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
        </svg>
        How thresholds are set
        <span className="ml-0.5 text-ink-soft/70">{open ? "↑" : "↓"}</span>
      </button>

      {open && (
        <div className="mt-2.5 rounded-lg border border-rule bg-paper-2 p-3">
          <p className="mb-2 text-[11px] text-ink-soft/70 leading-relaxed">
            The upvote threshold scales with your district&apos;s population so a small
            town initiative isn&apos;t held to the same bar as a federal one. When no
            jurisdiction is linked, a scope-level default is used (local ≈ 75K,
            state ≈ 6.5M, federal ≈ 335M).
          </p>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-rule">
                <th className="pb-1 text-left font-semibold text-ink-soft/70">Population</th>
                <th className="pb-1 text-left font-semibold text-ink-soft/70">Upvotes needed</th>
                <th className="hidden pb-1 text-left font-semibold text-ink-soft/70 sm:table-cell">Example</th>
              </tr>
            </thead>
            <tbody>
              {TIER_TABLE.map((row) => {
                const isCurrent = currentTierLabel?.startsWith(row.range.replace("< ", "").replace("+", ""));
                return (
                  <tr
                    key={row.range}
                    className={`border-b border-rule last:border-0 ${isCurrent ? "bg-accent/10" : ""}`}
                  >
                    <td className={`py-1 tabular-nums ${isCurrent ? "font-semibold text-accent" : "text-ink-soft"}`}>{row.range}</td>
                    <td className={`py-1 tabular-nums ${isCurrent ? "font-semibold text-accent" : "text-ink-soft"}`}>{row.upvotes}</td>
                    <td className="hidden py-1 text-ink-soft/70 sm:table-cell">{row.example}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SignalStatus = "pass" | "fail" | "pending";

type GateSignal = {
  key:         string;
  label:       string;
  description: string;
  status:      SignalStatus;
  value:       number | null;
  required:    number;
};

type PopulationContext = {
  source:     "jurisdiction" | "scope_default";
  population: number | null;
  tier_label: string;
};

type GateResult = {
  can_advance:         boolean;
  signals:             GateSignal[];
  checked_at:          string;
  population_context?: PopulationContext;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: GateSignal }) {
  const isPass = signal.status === "pass";
  const progressPct = signal.value !== null
    ? Math.min(100, Math.round((signal.value / signal.required) * 100))
    : 0;

  // Human-readable value label
  let valueLabel = "";
  if (signal.key === "time_minimum") {
    const h = signal.value ?? 0;
    valueLabel = h < 1 ? "< 1h" : h < 24 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`;
  } else {
    valueLabel = signal.value !== null ? String(signal.value) : "0";
  }

  return (
    <div className={`rounded-lg border p-3 ${isPass ? "border-green-ink/25 bg-green-ink/10" : "border-rule bg-card"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {/* Pass/fail icon */}
          <span
            className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              isPass
                ? "bg-green-ink text-white"
                : "border-2 border-rule text-ink-soft/70"
            }`}
          >
            {isPass ? "✓" : ""}
          </span>
          <div>
            <p className={`text-xs font-semibold ${isPass ? "text-green-ink" : "text-ink-soft"}`}>
              {signal.label}
            </p>
            <p className="text-xs text-ink-soft/70 mt-0.5">{signal.description}</p>
          </div>
        </div>
        {/* Current value */}
        <div className="flex-shrink-0 text-right">
          <span className={`text-sm font-bold tabular-nums ${isPass ? "text-green-ink" : "text-ink-soft"}`}>
            {valueLabel}
          </span>
          <span className="text-xs text-ink-soft/70"> / {signal.required}</span>
        </div>
      </div>

      {/* Progress bar */}
      {!isPass && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-paper-2">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface QualityGateProps {
  initiativeId: string;
  currentStage: string;
}

export function QualityGate({ initiativeId, currentStage }: QualityGateProps) {
  const router = useRouter();
  const [gate, setGate]         = useState<GateResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [advanceSuccess, setAdvanceSuccess] = useState<string | null>(null);

  // For draft stage: just show the "open for deliberation" button — no gate check needed
  const isDraft      = currentStage === "draft";
  const isDeliberate = currentStage === "deliberate";

  const fetchGate = useCallback(async () => {
    if (!isDeliberate) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/gate`);
      const data = await res.json();
      if (res.ok) setGate(data);
    } finally {
      setLoading(false);
    }
  }, [initiativeId, isDeliberate]);

  useEffect(() => {
    fetchGate();
  }, [fetchGate]);

  async function handleAdvance() {
    setAdvanceError(null);
    setAdvanceSuccess(null);
    setAdvancing(true);

    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/advance`, {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok) {
        setAdvanceError(data.error ?? "Failed to advance initiative.");
        // Refresh gate state so signals reflect the check that just ran
        if (data.gate) setGate(data.gate);
        return;
      }

      setAdvanceSuccess(data.message);
      // Reload page to show new stage
      setTimeout(() => router.refresh(), 1200);
    } catch {
      setAdvanceError("Network error. Please try again.");
    } finally {
      setAdvancing(false);
    }
  }

  // ── Draft: simple open-for-deliberation panel ────────────────────────────
  if (isDraft) {
    return (
      <div className="mt-6 rounded-xl border border-accent bg-accent/10 p-5">
        <h3 className="mb-1 text-sm font-bold text-accent">Ready to open for deliberation?</h3>
        <p className="mb-4 text-xs text-accent">
          Opening your initiative lets the community read, discuss, and argue for or against it.
          The proposal text can still be edited while deliberating. You can&apos;t go back to draft.
        </p>
        {advanceSuccess ? (
          <p className="rounded-lg bg-green-ink/10 px-3 py-2 text-xs font-semibold text-green-ink">
            ✓ {advanceSuccess}
          </p>
        ) : (
          <>
            {advanceError && (
              <p className="mb-3 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent">
                {advanceError}
              </p>
            )}
            <button
              onClick={handleAdvance}
              disabled={advancing}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {advancing ? "Opening…" : "Open for deliberation →"}
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Deliberate: quality gate panel ────────────────────────────────────────
  if (isDeliberate) {
    const passCount = gate?.signals.filter((s) => s.status === "pass").length ?? 0;
    const totalCount = gate?.signals.length ?? 4;
    const allPass = gate?.can_advance ?? false;

    return (
      <div className="mt-6 border border-rule bg-card p-5 shadow-sm">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Quality gate</h3>
            <p className="text-xs text-ink-soft/70 mt-0.5">
              Pass all four signals to begin mobilising signatures.
            </p>
            {/* Population tier badge (v2) */}
            {gate?.population_context && (
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-paper-2 px-2 py-0.5 text-[10px] text-ink-soft/70">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v1h8v-1zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-1a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v1h-3zM4.75 14.094A5.973 5.973 0 004 17v1H1v-1a3 3 0 013.75-2.906z" />
                </svg>
                {gate.population_context.tier_label}
                {gate.population_context.source === "scope_default" && (
                  <span className="text-ink-soft/70"> · estimated</span>
                )}
              </span>
            )}
          </div>
          <div className="flex flex-shrink-0 flex-col items-end">
            <span className={`text-lg font-bold tabular-nums ${allPass ? "text-green-ink" : "text-ink-soft"}`}>
              {passCount}/{totalCount}
            </span>
            <span className="text-xs text-ink-soft/70">signals passing</span>
          </div>
        </div>

        {/* Signal list */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-paper-2" />
            ))}
          </div>
        ) : gate ? (
          <div className="space-y-2">
            {gate.signals.map((signal) => (
              <SignalRow key={signal.key} signal={signal} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-soft/70">Loading gate status…</p>
        )}

        {/* Threshold explainer */}
        <ThresholdExplainer currentTierLabel={gate?.population_context?.tier_label} />

        {/* Refresh + advance */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={fetchGate}
            disabled={loading}
            className="rounded-lg border border-rule px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50"
          >
            {loading ? "Checking…" : "↻ Refresh"}
          </button>

          {allPass && (
            <button
              onClick={handleAdvance}
              disabled={advancing}
              className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {advancing ? "Advancing…" : "Advance to mobilise →"}
            </button>
          )}
        </div>

        {/* Feedback */}
        {advanceSuccess && (
          <p className="mt-3 rounded-lg bg-green-ink/10 px-3 py-2 text-xs font-semibold text-green-ink">
            ✓ {advanceSuccess}
          </p>
        )}
        {advanceError && (
          <p className="mt-3 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent">
            {advanceError}
          </p>
        )}

        {/* Checked-at timestamp */}
        {gate?.checked_at && (
          <p className="mt-3 text-xs text-ink-soft/70">
            Last checked {new Date(gate.checked_at).toLocaleTimeString()}
          </p>
        )}
      </div>
    );
  }

  // Not shown for mobilise/resolved stages
  return null;
}
