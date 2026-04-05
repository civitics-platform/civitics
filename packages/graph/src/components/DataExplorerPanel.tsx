"use client";

/**
 * packages/graph/src/components/DataExplorerPanel.tsx
 *
 * Left panel — 260px wide, full height, collapsible to a 40px icon strip.
 * Hosts FocusTree (🎯) and ConnectionsTree (🔗).
 *
 * Keyboard shortcut: [ toggles left panel (managed by GraphPage)
 */

import { useState } from 'react';
import type { GraphView } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { FocusTree } from './FocusTree';
import { ConnectionsTree } from './ConnectionsTree';
import { AlignmentPanel } from './AlignmentPanel';

export interface DataExplorerPanelProps {
  view: GraphView;
  hooks: UseGraphViewReturn;
  collapsed: boolean;
  onCollapse: () => void;
  graphMeta?: GraphMeta;
}

type Section = 'focus' | 'connections';

const SECTION_ICONS: Record<Section, string> = {
  focus:       '🎯',
  connections: '🔗',
};

export function DataExplorerPanel({ view, hooks, collapsed, onCollapse, graphMeta }: DataExplorerPanelProps) {
  const [savedAlignment] = useState(() => {
    try {
      const saved = localStorage.getItem('civic-alignment');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Collapsed: 40px icon strip
  if (collapsed) {
    return (
      <div className="h-full w-10 flex flex-col items-center py-2 gap-3 border-r border-gray-200 bg-white shrink-0">
        {(['focus', 'connections'] as Section[]).map(section => (
          <button
            key={section}
            title={section === 'focus' ? 'Data Explorer — Focus' : 'Data Explorer — Connections'}
            onClick={onCollapse}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-base"
          >
            {SECTION_ICONS[section]}
          </button>
        ))}
      </div>
    );
  }

  // Expanded: 260px panel
  return (
    <div className="h-full w-[260px] flex flex-col border-r border-gray-200 bg-white overflow-hidden shrink-0 min-w-0">

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
          Data Explorer
        </span>
        <button
          onClick={onCollapse}
          title="Collapse panel  ([ shortcut)"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <FocusTree
          focus={view.focus}
          hooks={hooks}
        />
        <ConnectionsTree
          connections={view.connections}
          vizType={view.style.vizType}
          hooks={hooks}
          graphMeta={graphMeta}
        />
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
