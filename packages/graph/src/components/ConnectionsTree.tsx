"use client";

/**
 * packages/graph/src/components/ConnectionsTree.tsx
 *
 * Renders the CONNECTIONS section of DataExplorerPanel.
 * Shows enabled types with full style controls and disabled types in an "Add" list.
 */

import type { GraphView, VizType } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import { CONNECTION_TYPE_REGISTRY } from '../connections';
import { TreeNode, TreeSection } from './TreeNode';
import { ConnectionStyleRow } from './ConnectionStyleRow';

export interface ConnectionsTreeProps {
  connections: GraphView['connections'];
  vizType: VizType;
  hooks: UseGraphViewReturn;
}

// Viz types that only support donations
const DONATION_ONLY_VIZ = new Set<VizType>(['chord', 'treemap']);

export function ConnectionsTree({ connections, vizType, hooks }: ConnectionsTreeProps) {
  const enabledTypes  = Object.keys(CONNECTION_TYPE_REGISTRY).filter(t => connections[t]?.enabled);
  const disabledTypes = Object.keys(CONNECTION_TYPE_REGISTRY).filter(t => !connections[t]?.enabled);

  const donationOnlyViz = DONATION_ONLY_VIZ.has(vizType);

  return (
    <TreeSection
      label="Connections"
      defaultExpanded
      separator
    >
      {/* Active connection types */}
      <TreeSection
        label="Active Types"
        count={enabledTypes.length}
        defaultExpanded
        separator={false}
        depth={1}
      >
        {enabledTypes.map(type => {
          const def      = CONNECTION_TYPE_REGISTRY[type];
          const settings = connections[type];
          if (!def || !settings) return null;
          return (
            <ConnectionStyleRow
              key={type}
              type={type}
              def={def}
              settings={settings}
              onChange={(t, s) => hooks.setConnection(t, s)}
            />
          );
        })}
        {enabledTypes.length === 0 && (
          <div className="px-3 py-2 text-xs text-gray-400">No active connection types</div>
        )}

        {/* Procedural vote filter — groundwork for Phase 2 edge filtering */}
        <div className="px-3 py-1.5 flex items-center justify-between">
          <span className="text-[10px] text-gray-400 pl-2">Hide procedural</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={(connections as Record<string, unknown>).filterProcedural as boolean ?? false}
              onChange={e => hooks.setConnectionOption('filterProcedural', e.target.checked)}
            />
            <div className="w-7 h-3.5 bg-gray-200 rounded-full peer peer-checked:bg-indigo-500 after:content-[''] after:absolute after:top-0 after:left-0 after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-all after:border after:border-gray-200 peer-checked:after:translate-x-3.5" />
          </label>
        </div>
      </TreeSection>

      {/* Disabled types — can be added */}
      {disabledTypes.length > 0 && (
        <TreeSection
          label="Add Types"
          defaultExpanded={false}
          separator={false}
          depth={1}
        >
          {disabledTypes.map(type => {
            const def = CONNECTION_TYPE_REGISTRY[type];
            if (!def) return null;
            return (
              <TreeNode
                key={type}
                label={def.label}
                variant="connection"
                connectionColor={def.color}
                collapsible={false}
                depth={2}
                separator={false}
                actions={[{
                  icon: '+',
                  label: 'Enable',
                  onClick: () => hooks.toggleConnection(type),
                }]}
              >
                {null}
              </TreeNode>
            );
          })}
        </TreeSection>
      )}

      {/* Info banner for chord/treemap */}
      {donationOnlyViz && (
        <div className="mx-3 my-1.5 px-2 py-1.5 bg-blue-50 border border-blue-100 rounded text-[10px] text-blue-600 leading-relaxed">
          Switch to Force Graph to configure vote connections
        </div>
      )}
    </TreeSection>
  );
}
