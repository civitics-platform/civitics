"use client";

/**
 * Admin-only banner above the Operations tab. Surfaces recent kill-switch
 * flips (last hour, OFF only — re-enables are non-events for alerting) so
 * an auto-trip from FIX-286's evaluator doesn't happen silently. Per-event
 * dismissal is stored in localStorage, keyed by event id; a new flip with
 * a new id reappears even if the user previously dismissed prior events.
 *
 * Why client-side: dismissal state lives in localStorage (per-browser),
 * which Server Components can't read. The events array is passed in as
 * props after being fetched server-side in dashboard/page.tsx with the
 * admin client, so the network shape stays one round trip.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertBanner, formatRelativeTime } from "@civitics/ui";

export type KillSwitchEvent = {
  id: number;
  switch_name: string;
  trigger_metric: string | null;
  trigger_value: number | null;
  threshold_pct: number | null;
  flipped_to: boolean;
  source: "auto" | "manual";
  flipped_at: string;
};

const DISMISSED_KEY = "civitics.killswitch.dismissed";

const SWITCH_LABELS: Record<string, string> = {
  ai_summaries: "AI Summaries",
  ai_narrative: "AI Narrative",
  ai_tagger: "AI Tagger",
  connection_graph_live: "Connection Graph Live",
  cron: "Nightly Cron",
};

function switchLabel(name: string): string {
  return SWITCH_LABELS[name] ?? name;
}

function formatTriggerValue(metric: string | null, value: number | null): string {
  if (value === null) return "—";
  if (metric === "anthropic.monthly_spend_usd") {
    return `$${value.toFixed(2)}`;
  }
  if (metric?.endsWith("_bytes")) {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    return `${value.toLocaleString()} bytes`;
  }
  return value.toLocaleString();
}

function loadDismissed(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((n): n is number => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* localStorage quota / disabled — banner just won't persist dismissal */
  }
}

export function KillSwitchBanner({ events }: { events: KillSwitchEvent[] }) {
  // Defer reading localStorage until after mount to avoid hydration mismatch
  // (server renders with the full event list; client trims it post-hydration).
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDismissed(loadDismissed());
    setHydrated(true);
  }, []);

  const visible = useMemo(
    () => (hydrated ? events.filter((e) => !dismissed.has(e.id)) : events),
    [events, dismissed, hydrated],
  );

  if (visible.length === 0) return null;

  const dismiss = (id: number) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <div className="mb-6 space-y-2">
      {visible.map((event) => {
        const label = switchLabel(event.switch_name);
        const when = formatRelativeTime(event.flipped_at);
        const sourceBadge =
          event.source === "auto" ? "AUTO" : "MANUAL";

        const detail =
          event.source === "auto" &&
          event.trigger_metric !== null &&
          event.threshold_pct !== null
            ? `${event.trigger_metric} — ${formatTriggerValue(event.trigger_metric, event.trigger_value)} ≥ ${event.threshold_pct}% threshold · ${when}`
            : `Flipped manually · ${when}`;

        return (
          <AlertBanner
            key={event.id}
            level="warning"
            message={`[${sourceBadge}] ${label} disabled`}
            detail={detail}
            dismissible
            onDismiss={() => dismiss(event.id)}
          />
        );
      })}
    </div>
  );
}
