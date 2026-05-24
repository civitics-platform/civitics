"use client";

/**
 * Admin-only banner above the Operations tab. Surfaces recent kill-switch
 * flips (last hour, OFF only — re-enables are non-events for alerting) so
 * an auto-trip from FIX-286's evaluator doesn't happen silently. Per-event
 * dismissal is stored in localStorage, keyed by event id; a new flip with
 * a new id reappears even if the user previously dismissed prior events.
 *
 * FIX-347: this component now fetches its own data on mount instead of
 * trusting a prop baked in by the SSR path. The dashboard page is edge-
 * cached (30 min s-maxage), so any admin-rendered HTML it embeds leaks to
 * anonymous visitors for the cache lifetime. Moving the fetch client-side
 * means the SSR HTML is identical for everyone (safe to cache) and the
 * admin payload only reaches authed admin browsers via /api/admin/me +
 * /api/admin/kill-switches/recent (both 404 for non-admins).
 */

import { useEffect, useMemo, useState } from "react";
import { AlertBanner, formatRelativeTime } from "@civitics/ui";
import { useIsAdmin } from "@/lib/use-is-admin";

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

export function KillSwitchBanner() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [events, setEvents] = useState<KillSwitchEvent[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDismissed(loadDismissed());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/admin/kill-switches/recent", {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { events?: KillSwitchEvent[] };
        if (active && Array.isArray(body.events)) {
          setEvents(body.events);
        }
      } catch {
        /* network errors leave events empty — banner stays hidden */
      }
    })();
    return () => {
      active = false;
    };
  }, [isAdmin]);

  const visible = useMemo(
    () => (hydrated ? events.filter((e) => !dismissed.has(e.id)) : []),
    [events, dismissed, hydrated],
  );

  if (adminLoading || !isAdmin) return null;
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
