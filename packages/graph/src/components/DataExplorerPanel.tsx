"use client";

/**
 * packages/graph/src/components/DataExplorerPanel.tsx
 *
 * Left panel — FIX-812: WHAT is on the graph. Full height, collapsible to a
 * 40px icon strip, width driven by the host (drag-resize, FIX-813).
 * Contents top to bottom: Active entities, Add entities (browserSlot),
 * Path finder, YOU-node affordance card (youCardSlot).
 *
 * ConnectionsTree moved to the right panel's Connections tab (FIX-812);
 * AlignmentPanel (My Priorities) moved to /desk — the civic-alignment
 * localStorage contract is owned by the desk module now.
 *
 * Keyboard shortcut: [ toggles left panel (managed by GraphPage)
 */

import type { ReactNode } from 'react';
import type { GraphView } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { FocusTree, type UserNodeInfo } from './FocusTree';

/** FIX-813 — default width; host may override via the width prop. */
export const LEFT_PANEL_DEFAULT_WIDTH = 230;

export interface DataExplorerPanelProps {
  view: GraphView;
  hooks: UseGraphViewReturn;
  collapsed: boolean;
  onCollapse: () => void;
  graphMeta?: GraphMeta;
  /** USER node summary — surfaces the YOU row in FocusTree (FIX-120). */
  userNode?: UserNodeInfo | null;
  /** Toggle USER node visibility (FIX-120). */
  onToggleUserNode?: () => void;
  /** FIX-762 — unified browser sidebar mount, forwarded to FocusTree. */
  browserSlot?: ReactNode;
  /**
   * FIX-812 — YOU-node affordance card (app-provided; shown when the viewer
   * is signed out or has no home_state). Rendered at the bottom of the panel.
   */
  youCardSlot?: ReactNode;
  /** FIX-812 — entity-row hover spotlight, forwarded to FocusTree. */
  onEntityHover?: (entityId: string | null) => void;
  /** FIX-813 — panel width in px (180–400). Defaults to 230. */
  width?: number;
  /**
   * FIX-814 — drawer mode: the host renders this panel as an off-canvas
   * overlay; the panel drops its own border/shrink chrome and fills its
   * container instead.
   */
  asDrawer?: boolean;
}

export function DataExplorerPanel({
  view,
  hooks,
  collapsed,
  onCollapse,
  graphMeta,
  userNode,
  onToggleUserNode,
  browserSlot,
  youCardSlot,
  onEntityHover,
  width = LEFT_PANEL_DEFAULT_WIDTH,
  asDrawer = false,
}: DataExplorerPanelProps) {
  // Collapsed: 40px icon strip (not used in drawer mode — the drawer just closes).
  if (collapsed && !asDrawer) {
    return (
      <div className="h-full w-10 flex flex-col items-center py-2 gap-3 border-r border-rule bg-card shrink-0">
        <button
          title="Open Focus panel  ([ shortcut)"
          aria-label="Open Focus panel"
          onClick={onCollapse}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true">🎯</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={
        asDrawer
          ? 'h-full w-full flex flex-col bg-card overflow-hidden min-w-0'
          : 'h-full flex flex-col border-r border-rule bg-card overflow-hidden shrink-0 min-w-0'
      }
      style={asDrawer ? undefined : { width }}
    >

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-rule/60 shrink-0">
        <span className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
          Focus
        </span>
        <button
          onClick={onCollapse}
          title={asDrawer ? 'Close panel' : 'Collapse panel  ([ shortcut)'}
          aria-label={asDrawer ? 'Close Focus panel' : 'Collapse Focus panel'}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <FocusTree
          focus={view.focus}
          hooks={hooks}
          graphMeta={graphMeta}
          userNode={userNode}
          onToggleUserNode={onToggleUserNode}
          browserSlot={browserSlot}
          onEntityHover={onEntityHover}
        />
        {youCardSlot}
      </div>
    </div>
  );
}
