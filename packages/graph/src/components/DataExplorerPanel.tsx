"use client";

/**
 * packages/graph/src/components/DataExplorerPanel.tsx
 *
 * Left panel — 260px wide, full height, collapsible to a 40px icon strip.
 * Hosts FocusTree (🎯) and ConnectionsTree (🔗).
 *
 * Keyboard shortcut: [ toggles left panel (managed by GraphPage)
 */

import { useState, useEffect, useRef } from 'react';
import type { GraphView } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { FocusTree, type UserNodeInfo } from './FocusTree';
import { ConnectionsTree } from './ConnectionsTree';
import { AlignmentPanel } from './AlignmentPanel';

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
  browserSlot?: React.ReactNode;
}

const userNodeIsVisible = (info?: UserNodeInfo | null): boolean =>
  !!info && info.visible;

type Section = 'focus' | 'connections';

const SECTION_ICONS: Record<Section, string> = {
  focus:       '🎯',
  connections: '🔗',
};

export function DataExplorerPanel({ view, hooks, collapsed, onCollapse, graphMeta, userNode, onToggleUserNode, browserSlot }: DataExplorerPanelProps) {
  const [savedAlignment, setSavedAlignment] = useState(null);

  // FIX-134: section-jump — collapsed strip icons set a target before expanding,
  // and an effect scrolls the matching section into view once the panel is open.
  const [targetSection, setTargetSection] = useState<Section | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('civic-alignment');
      if (saved) setSavedAlignment(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    if (collapsed || !targetSection || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(`[data-section="${targetSection}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setTargetSection(null);
  }, [collapsed, targetSection]);

  function jumpTo(section: Section) {
    setTargetSection(section);
    if (collapsed) onCollapse();
  }

  // Collapsed: 40px icon strip — FIX-134: each icon expands and scrolls to its section.
  if (collapsed) {
    return (
      <div className="h-full w-10 flex flex-col items-center py-2 gap-3 border-r border-rule bg-card shrink-0">
        {(['focus', 'connections'] as Section[]).map(section => (
          <button
            key={section}
            title={section === 'focus' ? 'Open Focus section' : 'Open Connections section'}
            onClick={() => jumpTo(section)}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-base"
          >
            {SECTION_ICONS[section]}
          </button>
        ))}
      </div>
    );
  }

  // Expanded: 260px panel
  return (
    <div className="h-full w-[260px] flex flex-col border-r border-rule bg-card overflow-hidden shrink-0 min-w-0">

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-rule/60 shrink-0">
        <span className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
          Data Explorer
        </span>
        <button
          onClick={onCollapse}
          title="Collapse panel  ([ shortcut)"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-ink-soft hover:text-ink"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div data-section="focus">
        <FocusTree
          focus={view.focus}
          hooks={hooks}
          graphMeta={graphMeta}
          userNode={userNode}
          onToggleUserNode={onToggleUserNode}
          browserSlot={browserSlot}
        />
        </div>
        <div data-section="connections">
        <ConnectionsTree
          connections={view.connections}
          vizType={view.style.vizType}
          hooks={hooks}
          graphMeta={graphMeta}
          focus={view.focus}
          userNodeVisible={userNodeIsVisible(userNode)}
          includeProcedural={view.focus.includeProcedural}
        />
        </div>
        <AlignmentPanel
          initialIssues={savedAlignment}
          onAlignmentChange={(issues) => {
            try {
              localStorage.setItem('civic-alignment', JSON.stringify(issues));
            } catch {}
          }}
        />
      </div>
    </div>
  );
}
