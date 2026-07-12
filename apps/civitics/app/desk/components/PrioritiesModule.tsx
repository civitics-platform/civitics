"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { AlignmentPanel } from "@civitics/graph";

/**
 * My Priorities — FIX-812. AlignmentPanel ("set how much each issue matters
 * to you") moved here from the /graph left panel: it configures the viewer's
 * civic-alignment profile, which is Desk identity, not graph state. The
 * `civic-alignment` localStorage contract is unchanged — the officials
 * VotesTab and future alignment scoring keep reading the same key/shape.
 *
 * Rendered as an embedded terminal instrument like WatchingModule: the
 * data-theme="terminal" wrapper re-binds the semantic tokens AlignmentPanel
 * already uses, so it reads dark inside the paper desk without changes.
 *
 * AlignmentPanel captures initialIssues in useState on first render, so the
 * localStorage read must complete BEFORE it mounts (the old graph-panel host
 * passed the value a render too late and saved priorities never restored).
 */

const STORAGE_KEY = "civic-alignment";

// Matches AlignmentPanel's IssueAlignment — the shape persisted under civic-alignment.
type SavedIssues = Parameters<NonNullable<ComponentProps<typeof AlignmentPanel>["onAlignmentChange"]>>[0];

export function PrioritiesModule() {
  const [saved, setSaved] = useState<SavedIssues | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch { /* corrupt or unavailable — fall back to defaults */ }
    setLoaded(true);
  }, []);

  return (
    <section
      data-theme="terminal"
      className="overflow-hidden rounded-[10px] border border-term-line bg-term-bg text-term-txt shadow-[0_14px_34px_rgba(28,26,22,0.18)]"
    >
      <div className="flex items-center justify-between gap-4 border-b border-term-line bg-term-panel px-4 py-3">
        <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.16em]">
          <span className="mr-2 text-amber">●</span>My Priorities
        </span>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-term-dim">
          Civic alignment profile
        </span>
      </div>

      <div className="px-2 pb-2">
        {loaded && (
          <AlignmentPanel
            initialIssues={saved}
            onAlignmentChange={(issues) => {
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(issues));
              } catch { /* localStorage unavailable */ }
            }}
          />
        )}
      </div>
    </section>
  );
}
