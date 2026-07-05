"use client";

import { useState, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Version = {
  id: string;
  version_number: number;
  title: string;
  body_md: string;
  edited_by: string | null;
  created_at: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface VersionHistoryProps {
  initiativeId: string;
}

export function VersionHistory({ initiativeId }: VersionHistoryProps) {
  const [open, setOpen]         = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState<Version | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/initiatives/${initiativeId}/versions`)
      .then((r) => r.json())
      .then((d) => setVersions(d.versions ?? []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [open, initiativeId]);

  return (
    <div className="mt-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-sm font-medium text-ink-soft/70 hover:text-ink transition-colors"
      >
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Version history
      </button>

      {open && (
        <div className="mt-3 rounded-lg border border-rule bg-card">
          {loading ? (
            <div className="px-5 py-8 text-center text-sm text-ink-soft/70">Loading…</div>
          ) : versions.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-ink-soft/70">
              No previous versions — this proposal has not been edited yet.
            </div>
          ) : (
            <div className="divide-y divide-rule">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <span className="text-xs font-semibold text-ink-soft mr-2">v{v.version_number}</span>
                    <span className="text-sm text-ink-soft line-clamp-1">{v.title}</span>
                    <span className="ml-2 text-xs text-ink-soft/70">{formatDateTime(v.created_at)}</span>
                  </div>
                  <button
                    onClick={() => setSelected(selected?.id === v.id ? null : v)}
                    className="ml-4 flex-shrink-0 text-xs text-accent hover:text-accent font-medium"
                  >
                    {selected?.id === v.id ? "Hide" : "View"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Expanded version viewer */}
          {selected && (
            <div className="border-t border-accent bg-accent/10 px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-accent">
                  Version {selected.version_number} — {formatDateTime(selected.created_at)}
                </span>
                <button
                  onClick={() => setSelected(null)}
                  className="text-xs text-accent hover:text-accent"
                >
                  Close ×
                </button>
              </div>
              <h3 className="mb-2 text-sm font-bold text-ink">{selected.title}</h3>
              <pre className="whitespace-pre-wrap text-xs text-ink-soft font-sans leading-relaxed max-h-60 overflow-y-auto">
                {selected.body_md}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
