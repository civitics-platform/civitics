"use client";

/**
 * Admin threshold editor for one provider's platform_limits rows (FIX-1051).
 *
 * Craig's intent, filed 2026-08-17: included_limit / warning_pct / critical_pct
 * should be tunable from the dashboard, not by writing a migration. FIX-1051
 * gated that on the card rework (FIX-1091, which this lives inside) and on a
 * real admin-auth boundary for the write — POST /api/admin/platform-limits,
 * cookie session + ADMIN_EMAIL, the same gate `useIsAdmin()` uses to decide
 * whether this affordance is rendered at all. The affordance is client-gated on
 * purpose: it must never appear in the edge-cached SSR HTML (FIX-347 pattern).
 *
 * Byte limits are edited in GiB. Typing 8589934592 by hand is not an editor,
 * it is a trap — and the conversion is shown so the stored value is verifiable.
 */

import { useState } from "react";
import type { PlatformMetric } from "@civitics/db";
import { metricLabel, metricTag } from "@/lib/platform-costs-view";

const BYTES_PER_GIB = 1024 ** 3;

type Draft = { included_limit: string; warning_pct: string; critical_pct: string };

type AppliedRow = {
  service: string;
  metric: string;
  before: { included_limit: number; warning_pct: number; critical_pct: number };
  after: { included_limit: number; warning_pct: number; critical_pct: number };
};

/** Native units in, editor units out. Bytes are edited as GiB. */
function toEditor(metric: PlatformMetric, value: number): string {
  if (value === -1) return "-1";
  if (metric.unit === "bytes") {
    const gib = value / BYTES_PER_GIB;
    return String(Number(gib.toFixed(4)));
  }
  return String(value);
}

function fromEditor(metric: PlatformMetric, raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === -1) return -1;
  if (metric.unit === "bytes") return Math.round(n * BYTES_PER_GIB);
  return n;
}

function initialDraft(m: PlatformMetric): Draft {
  return {
    included_limit: toEditor(m, m.included_limit),
    warning_pct: String(m.warning_pct),
    critical_pct: String(m.critical_pct),
  };
}

export function ThresholdsEditor({
  serviceLabel,
  metrics,
  onClose,
  onSaved,
}: {
  serviceLabel: string;
  /** Already filtered to displayed rows — companions are not editable. */
  metrics: PlatformMetric[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(metrics.map((m) => [m.id, initialDraft(m)])),
  );
  /**
   * The strings the form opened with. Dirtiness is decided by comparing STRINGS
   * against these, never by comparing the converted number back to the stored
   * one: `disk_used_bytes` is 56,950,861,824 B = 53.0417 GiB, and 53.0417 GiB
   * converted back is 3,824 bytes short of where it started. A numeric
   * comparison therefore marks an untouched row as edited and silently writes a
   * rounded value over a limit nobody asked to change. Caught driving this
   * editor on local — it wrote 2 rows when one field had been typed in.
   */
  const [initial, setInitial] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(metrics.map((m) => [m.id, initialDraft(m)])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedRow[] | null>(null);

  function setField(id: string, field: keyof Draft, value: string) {
    setDrafts((d) => {
      const current = d[id];
      if (!current) return d;
      return { ...d, [id]: { ...current, [field]: value } };
    });
  }

  function buildUpdates(): { updates: Array<Record<string, number | string>>; error: string | null } {
    const updates: Array<Record<string, number | string>> = [];
    for (const m of metrics) {
      const draft = drafts[m.id];
      const start = initial[m.id];
      if (!draft || !start) continue;
      const patch: Record<string, number | string> = { id: m.id };

      if (draft.included_limit !== start.included_limit) {
        const included = fromEditor(m, draft.included_limit);
        if (included === null) {
          return { updates: [], error: `${metricTag(m)}: included limit is not a number` };
        }
        patch["included_limit"] = included;
      }
      if (draft.warning_pct !== start.warning_pct) {
        const warning = Number(draft.warning_pct);
        if (!Number.isFinite(warning)) {
          return { updates: [], error: `${metricTag(m)}: warning % is not a number` };
        }
        patch["warning_pct"] = warning;
      }
      if (draft.critical_pct !== start.critical_pct) {
        const critical = Number(draft.critical_pct);
        if (!Number.isFinite(critical)) {
          return { updates: [], error: `${metricTag(m)}: critical % is not a number` };
        }
        patch["critical_pct"] = critical;
      }

      if (Object.keys(patch).length > 1) updates.push(patch);
    }
    return { updates, error: null };
  }

  async function handleSave() {
    const { updates, error: buildError } = buildUpdates();
    if (buildError) {
      setError(buildError);
      return;
    }
    if (updates.length === 0) {
      setError("Nothing changed.");
      return;
    }
    setSaving(true);
    setError(null);
    // Clear the previous result too — leaving a stale "Saved 2 rows" panel
    // under a fresh validation error reads as a partial success that did not
    // happen (the server validates the whole batch before writing any of it).
    setApplied(null);
    try {
      const res = await fetch("/api/admin/platform-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ updates }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        applied?: AppliedRow[];
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setApplied(json.applied ?? []);
      // The saved values are the new baseline, so a second edit in the same
      // session (including typing the original number back) is dirty again.
      // The `metrics` prop cannot serve as that baseline: it comes from the
      // snapshot payload, which will not reflect this write until the next
      // cron tick.
      setInitial(drafts);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-8 w-full max-w-2xl rounded-xl border border-rule bg-card p-5 shadow-xl">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">{serviceLabel} — alert thresholds</h2>
          <button onClick={onClose} className="text-sm text-ink-soft hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-soft">
          Writes <span className="font-mono">platform_limits</span> directly. The card renders a
          persisted snapshot, so a saved value appears here at the next platform-snapshot tick, not
          immediately. Warning % must sit at or below critical % — the ladder checks critical first,
          so an inverted pair deletes the warning band.
        </p>

        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[520px] text-xs">
            <thead>
              <tr className="border-b border-rule/60 text-left text-ink-soft/80">
                <th className="pb-1.5 font-medium">Metric</th>
                <th className="pb-1.5 text-right font-medium">
                  Included limit
                </th>
                <th className="w-20 pb-1.5 text-right font-medium">Warn %</th>
                <th className="w-20 pb-1.5 text-right font-medium">Crit %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule/40">
              {metrics.map((m) => {
                const draft = drafts[m.id];
                if (!draft) return null;
                return (
                  <tr key={m.id} className="align-top">
                    <td className="py-2 pr-2">
                      <div className="font-medium text-ink">{metricLabel(m)}</div>
                      <div className="font-mono text-[10px] text-ink-soft/70">{metricTag(m)}</div>
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <input
                        value={draft.included_limit}
                        onChange={(e) => setField(m.id, "included_limit", e.target.value)}
                        inputMode="decimal"
                        className="w-28 rounded border border-rule bg-paper-2 px-2 py-1 text-right tabular-nums text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <div className="mt-0.5 text-[10px] text-ink-soft/70">
                        {m.unit === "bytes" ? "GiB" : m.unit}
                        {m.included_limit === -1 ? " · −1 = unlimited" : ""}
                      </div>
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <input
                        value={draft.warning_pct}
                        onChange={(e) => setField(m.id, "warning_pct", e.target.value)}
                        inputMode="decimal"
                        className="w-16 rounded border border-rule bg-paper-2 px-2 py-1 text-right tabular-nums text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <input
                        value={draft.critical_pct}
                        onChange={(e) => setField(m.id, "critical_pct", e.target.value)}
                        inputMode="decimal"
                        className="w-16 rounded border border-rule bg-paper-2 px-2 py-1 text-right tabular-nums text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
            {error}
          </p>
        )}

        {applied && (
          <div className="mt-3 rounded-lg border border-green-ink/40 bg-green-ink/10 p-2 text-xs text-ink-soft">
            {applied.length === 0 ? (
              "Saved — nothing changed."
            ) : (
              <>
                <div className="mb-1 font-medium text-ink">Saved {applied.length} row(s):</div>
                {applied.map((row) => (
                  <div key={`${row.service}.${row.metric}`} className="font-mono text-[10px]">
                    {row.service}.{row.metric}: {row.before.included_limit}/{row.before.warning_pct}/
                    {row.before.critical_pct} → {row.after.included_limit}/{row.after.warning_pct}/
                    {row.after.critical_pct}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-ink-soft hover:text-ink">
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper hover:bg-accent disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save thresholds"}
          </button>
        </div>
      </div>
    </div>
  );
}
