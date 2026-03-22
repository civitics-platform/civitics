"use client";

/**
 * packages/graph/src/components/FocusTree.tsx
 *
 * Renders the FOCUS section of DataExplorerPanel.
 * Shows active focus entities with per-entity options,
 * search input, browse by category, and global options.
 */

import type { GraphView } from '../types';
import { MAX_FOCUS_ENTITIES } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import { TreeNode, TreeSection } from './TreeNode';
import { EntitySearchInput } from './EntitySearchInput';
import { EntityBrowse } from './EntityBrowse';
import { PathFinder } from '../PathFinder';

export interface FocusTreeProps {
  focus: GraphView['focus'];
  hooks: UseGraphViewReturn;
}

const DEPTH_LABELS: Record<number, string> = { 1: '1', 2: '2', 3: '3' };

function DepthButtons({
  value,
  onChange,
}: {
  value: 1 | 2 | 3;
  onChange: (d: 1 | 2 | 3) => void;
}) {
  return (
    <div className="flex gap-1 ml-2">
      {([1, 2, 3] as const).map(d => (
        <button
          key={d}
          onClick={e => { e.stopPropagation(); onChange(d); }}
          className={`w-6 h-5 text-[10px] font-medium rounded border transition-colors ${
            value === d
              ? 'bg-indigo-600 border-indigo-600 text-white'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          {DEPTH_LABELS[d]}
        </button>
      ))}
    </div>
  );
}

const SCOPE_OPTIONS = [
  { value: 'all',     label: 'All' },
  { value: 'federal', label: 'Federal' },
  { value: 'senate',  label: 'Senate' },
  { value: 'house',   label: 'House' },
  { value: 'state',   label: 'State' },
] as const;

export function FocusTree({ focus, hooks }: FocusTreeProps) {
  const { entities, depth, scope, includeProcedural } = focus;
  const atMax = hooks.atMaxFocus;

  return (
    <TreeSection
      label="Focus"
      separator={false}
      defaultExpanded
      action={{
        icon: '+',
        label: 'Add entity',
        onClick: () => { /* Search section auto-expands on empty */ },
      }}
    >
      {/* Empty state */}
      {entities.length === 0 && (
        <div className="px-4 py-5 text-center">
          <div className="text-2xl mb-2">🔍</div>
          <p className="text-xs font-medium text-gray-600">Search to add entities</p>
          <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
            Explore how officials, donors, and legislation connect
          </p>
        </div>
      )}

      {/* Active entities */}
      {entities.length > 0 && (
        <TreeSection
          label="Active"
          count={entities.length}
          defaultExpanded
          separator={false}
          depth={1}
        >
          {entities.map(entity => (
            <TreeNode
              key={entity.id}
              label={entity.name}
              variant="entity"
              party={entity.party}
              photoUrl={entity.photoUrl}
              active
              collapsible
              defaultExpanded={false}
              depth={1}
              separator={false}
              actions={[
                {
                  icon: entity.pinned ? '📌' : '📍',
                  label: entity.pinned ? 'Unpin' : 'Pin',
                  onClick: () => hooks.updateEntity(entity.id, { pinned: !entity.pinned }),
                },
                {
                  icon: '×',
                  label: 'Remove',
                  onClick: () => hooks.removeEntity(entity.id),
                },
              ]}
            >
              {/* Per-entity depth */}
              <div
                className="flex items-center gap-2 px-2 py-1"
                style={{ paddingLeft: '32px' }}
              >
                <span className="text-[10px] text-gray-500 shrink-0">Depth</span>
                <DepthButtons
                  value={(entity.depth ?? depth) as 1 | 2 | 3}
                  onChange={d => hooks.updateEntity(entity.id, { depth: d })}
                />
              </div>

              {/* Highlight toggle */}
              <div
                className="flex items-center justify-between px-2 py-1"
                style={{ paddingLeft: '32px' }}
              >
                <span className="text-[10px] text-gray-500">Highlight</span>
                <button
                  onClick={() => hooks.updateEntity(entity.id, { highlight: !entity.highlight })}
                  className={`w-7 h-4 rounded-full transition-colors relative ${(entity.highlight ?? true) ? 'bg-indigo-500' : 'bg-gray-200'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${(entity.highlight ?? true) ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Pin position toggle */}
              <div
                className="flex items-center justify-between px-2 py-1"
                style={{ paddingLeft: '32px' }}
              >
                <span className="text-[10px] text-gray-500">Pin position</span>
                <button
                  onClick={() => hooks.updateEntity(entity.id, { pinned: !entity.pinned })}
                  className={`w-7 h-4 rounded-full transition-colors relative ${entity.pinned ? 'bg-indigo-500' : 'bg-gray-200'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${entity.pinned ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </TreeNode>
          ))}
        </TreeSection>
      )}

      {/* Max entities warning */}
      {atMax && (
        <p className="px-3 py-1 text-[10px] text-amber-600">
          Maximum {MAX_FOCUS_ENTITIES} entities reached
        </p>
      )}

      {/* Find entity search */}
      <TreeSection
        label="Find Entity"
        defaultExpanded={entities.length === 0}
        separator={false}
        depth={1}
      >
        <EntitySearchInput
          onSelect={entity => {
            if (hooks.atMaxFocus) return;
            hooks.addEntity(entity);
          }}
          disabled={atMax}
        />
      </TreeSection>

      {/* Browse by category */}
      <TreeSection
        label="Browse"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        <EntityBrowse
          onSelect={entity => {
            if (hooks.atMaxFocus) return;
            hooks.addEntity(entity);
          }}
        />
      </TreeSection>

      {/* Path Finder */}
      <TreeSection
        label="Path Finder"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        <div className="px-2 pb-2">
          <PathFinder />
        </div>
      </TreeSection>

      {/* Global options */}
      <TreeSection
        label="Options"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        {/* Global depth */}
        <div
          className="flex items-center gap-2 px-2 py-1.5"
          style={{ paddingLeft: '32px' }}
        >
          <span className="text-[10px] text-gray-500 shrink-0 w-12">Depth</span>
          <DepthButtons value={depth} onChange={hooks.setDepth} />
        </div>

        {/* Scope dropdown */}
        <div
          className="flex items-center gap-2 px-2 py-1.5"
          style={{ paddingLeft: '32px' }}
        >
          <span className="text-[10px] text-gray-500 shrink-0 w-12">Scope</span>
          <select
            value={scope}
            onChange={e => hooks.setScope(e.target.value as GraphView['focus']['scope'])}
            className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-indigo-400"
          >
            {SCOPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Procedural toggle */}
        <div
          className="flex items-center justify-between px-2 py-1.5"
          style={{ paddingLeft: '32px' }}
        >
          <span className="text-[10px] text-gray-500">Procedural votes</span>
          <button
            onClick={hooks.toggleIncludeProcedural}
            className={`w-7 h-4 rounded-full transition-colors relative ${includeProcedural ? 'bg-indigo-500' : 'bg-gray-200'}`}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${includeProcedural ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </TreeSection>
    </TreeSection>
  );
}
