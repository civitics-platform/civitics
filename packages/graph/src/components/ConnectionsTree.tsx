"use client";

/**
 * packages/graph/src/components/ConnectionsTree.tsx
 *
 * Renders the CONNECTIONS section of DataExplorerPanel.
 * Shows enabled types with full style controls and disabled types in an "Add" list.
 * FIX-128: types not applicable to the current focus fall under a collapsed
 * "Not applicable to current focus" sub-tree (still reachable).
 */

import type { GraphView, VizType } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import {
  CONNECTION_TYPE_REGISTRY,
  applicableConnectionTypes,
  inapplicableReason,
} from '../connections';
import { TreeNode, TreeSection } from './TreeNode';
import { ConnectionStyleRow } from './ConnectionStyleRow';

export interface ConnectionsTreeProps {
  connections: GraphView['connections'];
  vizType: VizType;
  hooks: UseGraphViewReturn;
  graphMeta?: GraphMeta;
  /** Current focus — used to gate connection types by applicability (FIX-128). */
  focus: GraphView['focus'];
  /** Whether the USER node is on the canvas — gates the alignment type (FIX-128). */
  userNodeVisible?: boolean;
  /** Current procedural-vote filter state — surfaced here as a vote-type filter. */
  includeProcedural?: boolean;
}

// Viz types that only support donations
const DONATION_ONLY_VIZ = new Set<VizType>(['chord', 'treemap']);

export function ConnectionsTree({
  connections,
  vizType,
  hooks,
  graphMeta,
  focus,
  userNodeVisible = false,
  includeProcedural,
}: ConnectionsTreeProps) {
  // All known types
  const allTypes = Object.keys(CONNECTION_TYPE_REGISTRY);

  // Procedural-vote filter is only meaningful when the loaded graph actually contains vote edges.
  // Default to showing the toggle when graphMeta isn't loaded yet — prevents it disappearing on first paint.
  const showProceduralToggle = graphMeta?.hasVotes !== false;

  // When graphMeta is available, only show a type if it has data OR is currently enabled.
  // When graphMeta is absent (data not yet loaded), show all types.
  const visibleTypes = graphMeta
    ? allTypes.filter(t =>
        (graphMeta.connectionTypes[t]?.count ?? 0) > 0 ||
        connections[t]?.enabled
      )
    : allTypes;

  // FIX-128: partition by applicability against the current focus.
  const applicable = applicableConnectionTypes(focus, userNodeVisible);
  const applicableTypes    = visibleTypes.filter(t =>  applicable.has(t));
  const inapplicableTypes  = visibleTypes.filter(t => !applicable.has(t));

  const enabledTypes  = applicableTypes.filter(t =>  connections[t]?.enabled);
  const disabledTypes = applicableTypes.filter(t => !connections[t]?.enabled);

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
              count={graphMeta?.connectionTypes[type]?.count}
            />
          );
        })}
        {enabledTypes.length === 0 && (
          <div className="px-3 py-2 text-xs text-ink-soft/60">No active connection types</div>
        )}
      </TreeSection>

      {/* Disabled but applicable types — can be added */}
      {disabledTypes.length > 0 && (
        <TreeSection
          label="Add Types"
          defaultExpanded={false}
          separator={false}
          depth={1}
        >
          {disabledTypes.map(type => {
            const def   = CONNECTION_TYPE_REGISTRY[type];
            const count = graphMeta?.connectionTypes[type]?.count;
            if (!def) return null;
            return (
              <TreeNode
                key={type}
                label={
                  <span className="flex items-center gap-1 flex-1 min-w-0">
                    <span className="truncate">{def.label}</span>
                    {count != null && count > 0 && (
                      <span className="text-[9px] text-ink-soft/60 ml-auto shrink-0">{count}</span>
                    )}
                  </span>
                }
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

      {/* FIX-128: types that don't apply to the current focus.
          Collapsed by default but still reachable; each row carries a one-line
          reason so the user knows what to add to focus to make it applicable. */}
      {inapplicableTypes.length > 0 && (
        <TreeSection
          label="Not applicable to current focus"
          count={inapplicableTypes.length}
          defaultExpanded={false}
          separator={false}
          depth={1}
        >
          {inapplicableTypes.map(type => {
            const def      = CONNECTION_TYPE_REGISTRY[type];
            const settings = connections[type];
            const count    = graphMeta?.connectionTypes[type]?.count;
            if (!def) return null;
            const reason  = inapplicableReason(type);
            const enabled = !!settings?.enabled;
            return (
              <TreeNode
                key={type}
                label={
                  <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="flex items-center gap-1 min-w-0">
                      <span className="truncate text-ink-soft">{def.label}</span>
                      {count != null && count > 0 && (
                        <span className="text-[9px] text-ink-soft/60 ml-auto shrink-0">{count}</span>
                      )}
                    </span>
                    <span className="text-[9px] text-ink-soft/60 leading-tight truncate">
                      {reason}
                    </span>
                  </span>
                }
                variant="connection"
                connectionColor={def.color}
                collapsible={false}
                depth={2}
                separator={false}
                actions={[{
                  icon: enabled ? '×' : '+',
                  label: enabled ? 'Disable' : 'Enable anyway',
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
        <div className="mx-3 my-1.5 px-2 py-1.5 bg-civic-blue/10 border border-civic-blue/20 rounded text-[10px] text-civic-blue leading-relaxed">
          Switch to Force Graph to configure vote connections
        </div>
      )}

      {/* Vote filter row — procedural votes toggle. Filters cloture, passage motions, etc. */}
      {showProceduralToggle && (
        <TreeSection
          label="Vote filters"
          defaultExpanded
          separator={false}
          depth={1}
        >
          <div
            className="flex items-center justify-between px-2 py-1.5"
            style={{ paddingLeft: '32px' }}
          >
            <div className="min-w-0 pr-2">
              <div className="text-[11px] text-ink">Include procedural votes</div>
              <div className="text-[9px] text-ink-soft/60 leading-tight">Cloture, passage motions, etc.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!includeProcedural}
              aria-label="Include procedural votes"
              onClick={hooks.toggleIncludeProcedural}
              className={`w-7 h-4 rounded-full transition-colors relative shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${includeProcedural ? 'bg-accent' : 'bg-ink/20'}`}
            >
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${includeProcedural ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </TreeSection>
      )}
    </TreeSection>
  );
}
