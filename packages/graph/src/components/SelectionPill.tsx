"use client";

/**
 * packages/graph/src/components/SelectionPill.tsx — FIX-826
 *
 * Floating bottom-center overlay shown when the shift-click selection holds ≥ 2
 * nodes. Actions: Create group (client-only "Selection (N)" group), Expand
 * (incremental expand of each selected node), Export CSV (selection-scoped),
 * Clear. Mounted by GraphPage over the force canvas.
 */

export interface SelectionPillProps {
  count: number;
  onCreateGroup: () => void;
  onExpand: () => void;
  onExportCsv: () => void;
  onClear: () => void;
  /** Transient notice, e.g. "Expanding 10 of 14". */
  notice?: string | null;
  /** Disables the Expand button while a batch expand is in flight. */
  expanding?: boolean;
}

export function SelectionPill({
  count,
  onCreateGroup,
  onExpand,
  onExportCsv,
  onClear,
  notice = null,
  expanding = false,
}: SelectionPillProps) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 pointer-events-none">
      {notice && (
        <div className="pointer-events-none rounded-[2px] border border-amber/50 bg-card px-2.5 py-1 font-mono text-[10px] text-amber shadow">
          {notice}
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-rule bg-card/95 px-1.5 py-1 shadow-lg backdrop-blur-sm"
      >
        <span className="px-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink">
          {count} selected
        </span>
        <span className="h-4 w-px bg-rule" aria-hidden="true" />
        <button
          type="button"
          onClick={onCreateGroup}
          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Create group
        </button>
        <button
          type="button"
          onClick={onExpand}
          disabled={expanding}
          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Expand
        </button>
        <button
          type="button"
          onClick={onExportCsv}
          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Export CSV
        </button>
        <span className="h-4 w-px bg-rule" aria-hidden="true" />
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-ink-soft transition-colors hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
