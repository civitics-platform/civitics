"use client";

/**
 * packages/graph/src/components/FocusTree.tsx
 *
 * Renders the FOCUS section of DataExplorerPanel.
 * Shows active focus entities with per-entity options,
 * search input, browse by category, and global options.
 */

import { useState, useEffect } from 'react';
import type { FocusEntity, FocusGroup, GraphView, GroupFilter } from '../types';
import { isFocusEntity, isFocusGroup, MAX_FOCUS_ENTITIES } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import { TreeNode, TreeSection } from './TreeNode';
import { EntitySearchInput } from './EntitySearchInput';
import { GroupBrowser } from './GroupBrowser';
import { createCustomGroup } from '../groups';
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

const GROUP_OPTIONS = {
  state: [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
  ],
  party: ['democrat', 'republican', 'independent'],
  chamber: ['senator', 'representative'],
} as const;

function GroupSelector({
  onAdd,
  onClose,
}: {
  onAdd: (filter: GroupFilter) => void;
  onClose: () => void;
}) {
  const [filterType, setFilterType] = useState<'state' | 'party' | 'chamber'>('state');
  const [filterValue, setFilterValue] = useState<string>(GROUP_OPTIONS.state[0]);

  useEffect(() => {
    setFilterValue(GROUP_OPTIONS[filterType][0]);
  }, [filterType]);

  const options = GROUP_OPTIONS[filterType] as readonly string[];

  const displayValue = (opt: string) =>
    filterType === 'state' ? opt : opt.charAt(0).toUpperCase() + opt.slice(1);

  return (
    <div className="mx-2 mb-2 border border-indigo-200 rounded-lg bg-indigo-50/50 p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700">Add Group</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-xs leading-none"
        >
          ×
        </button>
      </div>

      {/* Filter type tabs */}
      <div className="flex gap-1 mb-2">
        {(['state', 'party', 'chamber'] as const).map(t => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            className={`px-2 py-0.5 text-[10px] rounded capitalize transition-colors ${
              filterType === t
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Value selector */}
      <select
        value={filterValue}
        onChange={e => setFilterValue(e.target.value)}
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:border-indigo-400 mb-2"
      >
        {options.map(opt => (
          <option key={opt} value={opt}>
            {displayValue(opt)}
          </option>
        ))}
      </select>

      {/* Add button */}
      <button
        onClick={() => {
          if (filterValue) {
            const filter: GroupFilter = filterType === 'state'
              ? { entity_type: 'official', state: filterValue }
              : filterType === 'party'
              ? { entity_type: 'official', party: filterValue }
              : { entity_type: 'official', chamber: filterValue === 'senator' ? 'senate' : 'house' };
            onAdd(filter);
            onClose();
          }
        }}
        className="w-full py-1 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors"
      >
        Add {displayValue(filterValue)} officials
      </button>
    </div>
  );
}

export function FocusTree({ focus, hooks }: FocusTreeProps) {
  const { entities, depth, scope, includeProcedural } = focus;
  const atMax = hooks.atMaxFocus;
  const [showGroupSelector, setShowGroupSelector] = useState(false);

  // Group entities by groupTag ('' = ungrouped). FocusGroups are handled separately.
  const grouped = entities.filter(isFocusEntity).reduce<Record<string, FocusEntity[]>>((acc, e) => {
    const tag = e.groupTag ?? '';
    if (!acc[tag]) acc[tag] = [];
    acc[tag].push(e);
    return acc;
  }, {});

  // Ungrouped entities (no groupTag)
  const ungrouped = grouped[''] ?? [];
  // Groups with a tag, sorted alphabetically
  const taggedGroups = Object.entries(grouped)
    .filter(([tag]) => tag !== '')
    .sort(([a], [b]) => a.localeCompare(b));

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
          {/* Tagged groups with Remove all header */}
          {taggedGroups.map(([tag, members]) => (
            <div key={tag}>
              <div className="px-3 py-1 flex items-center justify-between">
                <span className="text-[10px] text-gray-500">
                  {tag} group ({members.length})
                </span>
                <button
                  onClick={() => hooks.removeGroup(tag)}
                  className="text-[10px] text-gray-400 hover:text-red-500"
                >
                  Remove all
                </button>
              </div>
              {members.map(entity => (
                <EntityRow key={entity.id} entity={entity} hooks={hooks} depth={depth} />
              ))}
            </div>
          ))}

          {/* Ungrouped entities */}
          {ungrouped.map(entity => (
            <EntityRow key={entity.id} entity={entity} hooks={hooks} depth={depth} />
          ))}
        </TreeSection>
      )}

      {/* Max entities warning */}
      {atMax && (
        <p className="px-3 py-1 text-[10px] text-amber-600">
          Maximum {MAX_FOCUS_ENTITIES} entities reached
        </p>
      )}

      {/* Add group button */}
      <div className="px-2 pb-1">
        <button
          onClick={() => setShowGroupSelector(s => !s)}
          className="w-full text-xs text-gray-500 hover:text-gray-700 border border-dashed border-gray-200 hover:border-gray-300 rounded px-2 py-1 transition-colors flex items-center justify-center gap-1"
        >
          <span>⊞</span>
          Add group
        </button>
      </div>

      {/* Group selector panel */}
      {showGroupSelector && (
        <GroupSelector
          onAdd={filter => {
            hooks.addGroup(createCustomGroup(filter));
          }}
          onClose={() => setShowGroupSelector(false)}
        />
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

      {/* Browse groups */}
      <TreeSection
        label="Browse Groups"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        <GroupBrowser
          onAddGroup={group => hooks.addGroup(group)}
          activeGroupIds={
            focus.entities
              .filter(isFocusGroup)
              .map(g => g.id)
          }
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

// ── EntityRow ──────────────────────────────────────────────────────────────────

function EntityRow({
  entity,
  hooks,
  depth,
}: {
  entity: FocusEntity;
  hooks: UseGraphViewReturn;
  depth: 1 | 2 | 3;
}) {
  const label = entity.groupTag ? (
    <span className="flex items-center gap-1">
      {entity.name}
      <span className="text-[9px] bg-gray-100 text-gray-500 px-1 rounded">
        {entity.groupTag}
      </span>
    </span>
  ) : entity.name;

  return (
    <TreeNode
      label={label}
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
  );
}
