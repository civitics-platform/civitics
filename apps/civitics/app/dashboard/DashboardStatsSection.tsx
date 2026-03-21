"use client";

import { useEffect, useState } from "react";

type Stats = {
  counts: {
    officials: number;
    proposals: number;
    votes: number;
    financial: number;
    connections: number;
    comments: number;
    aiSummaries: number;
    tags: number;
  };
  officialsBreakdown: {
    federal: number;
    state: number;
    judges: number;
  };
  fetchedAt: string;
};

function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-2xl font-bold tabular-nums text-gray-900">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="mt-0.5 text-sm font-medium text-gray-700">{label}</p>
      {note && <p className="mt-1 text-xs text-gray-400">{note}</p>}
    </div>
  );
}

export function DashboardStatsSection() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [error, setError] = useState(false);

  async function fetchStats() {
    try {
      const res = await fetch("/api/dashboard/stats", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data: Stats = await res.json();
      setStats(data);
      setSecondsAgo(0);
      setError(false);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    fetchStats();
    const refresher = setInterval(fetchStats, 60_000);
    const counter = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(refresher);
      clearInterval(counter);
    };
  }, []);

  const counts = stats?.counts;
  const bd = stats?.officialsBreakdown;

  const freshnessLabel =
    secondsAgo === 0
      ? "just now"
      : secondsAgo < 60
      ? `${secondsAgo}s ago`
      : `${Math.floor(secondsAgo / 60)}m ago`;

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-8">
        {/* Officials card with inline breakdown */}
        <div className="rounded-lg border border-gray-200 bg-white p-5 col-span-2 sm:col-span-1">
          <p className="text-2xl font-bold tabular-nums text-gray-900">
            {counts ? counts.officials.toLocaleString() : "—"}
          </p>
          <p className="mt-0.5 text-sm font-medium text-gray-700">Officials</p>
          {bd && (
            <div className="mt-2 space-y-0.5">
              <p className="text-[11px] text-gray-400 tabular-nums">
                Federal: {bd.federal.toLocaleString()}
              </p>
              <p className="text-[11px] text-gray-400 tabular-nums">
                State: {bd.state.toLocaleString()}
              </p>
              <p className="text-[11px] text-gray-400 tabular-nums">
                Judges: {bd.judges.toLocaleString()}
              </p>
            </div>
          )}
        </div>

        <MetricCard label="Proposals" value={counts?.proposals ?? "—"} />
        <MetricCard label="Votes recorded" value={counts?.votes ?? "—"} />
        <MetricCard label="Financial records" value={counts?.financial ?? "—"} />
        <MetricCard label="Connections mapped" value={counts?.connections ?? "—"} />
        <MetricCard label="Comments submitted" value={counts?.comments ?? "—"} />
        <MetricCard label="AI summaries" value={counts?.aiSummaries ?? "—"} />
        <MetricCard label="Tags applied" value={counts?.tags ?? "—"} />
      </div>

      <p className="mt-2 text-xs text-gray-400">
        {error
          ? "Could not load live counts — retrying…"
          : `Live counts · updated ${freshnessLabel} · refreshes every 60s`}
      </p>
    </div>
  );
}
