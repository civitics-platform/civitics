"use client";

/**
 * packages/graph/src/components/FocusTree.tsx
 *
 * Renders the FOCUS section of DataExplorerPanel.
 * Shows active focus entities with per-entity options,
 * search input, browse by category, and global options.
 *
 * FIX-762 — when the host app passes `browserSlot` (the unified browse
 * sidebar mount, app-side because it depends on app lib/route code this
 * package can't import), it replaces the legacy Find Entity + Browse Groups
 * sections. Without the slot the legacy stack still renders (embed and any
 * host that hasn't wired the browser yet).
 */

import type { ReactNode } from 'react';
import type { FocusEntity, GraphView } from '../types';
import { isFocusEntity, isFocusGroup, MAX_FOCUS_ENTITIES } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { TreeNode, TreeSection } from './TreeNode';
import { EntitySearchInput } from './EntitySearchInput';
import { GroupBrowser } from './GroupBrowser';
import { PathFinder } from '../PathFinder';

/**
 * USER node summary surfaced in the FocusTree "Active" section.
 * `null` / undefined when the viewer is unauthenticated or has no home
 * district configured — in that case the YOU row is hidden entirely.
 */
export interface UserNodeInfo {
  /** Whether the USER node is currently rendered on the canvas. */
  visible: boolean;
  /** Aggregate alignment ratio across the user's reps, or null if no overlap yet. */
  alignmentRatio: number | null;
  /** Number of representatives wired up to the USER node. */
  repCount: number;
}

export interface FocusTreeProps {
  focus: GraphView['focus'];
  hooks: UseGraphViewReturn;
  /** Optional: derived from loaded graph data. Used to gate vote-specific options. */
  graphMeta?: GraphMeta;
  /** USER node summary — shows the "👤 You" row when present (FIX-120). */
  userNode?: UserNodeInfo | null;
  /** Toggle USER node visibility independent of follows (FIX-120). */
  onToggleUserNode?: () => void;
  /** FIX-762 — unified browser sidebar mount; replaces Find Entity + Browse Groups. */
  browserSlot?: ReactNode;
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
              ? 'bg-accent border-accent text-paper'
              : 'bg-card border-rule text-ink-soft hover:border-accent'
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


export function FocusTree({
  focus,
  hooks,
  graphMeta: _graphMeta,
  userNode,
  onToggleUserNode,
  browserSlot,
}: FocusTreeProps) {
  const { entities, depth, scope } = focus;
  // Procedural-votes toggle now lives in ConnectionsTree (vote-level filter, not focus-level).
  const atMax = hooks.atMaxFocus;
  const showUserRow = !!userNode;
  const activeCount = entities.length + (showUserRow ? 1 : 0);

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
      {/* Empty state — only when nothing is focused AND the YOU row isn't surfaced */}
      {entities.length === 0 && !showUserRow && (
        <div className="px-4 py-5 text-center">
          <p className="text-xs font-medium text-ink-soft">Search to add entities</p>
          <p className="text-[10px] text-ink-soft/60 mt-1 leading-relaxed">
            Explore how officials, donors, and legislation connect
          </p>
        </div>
      )}

      {/* Active entities */}
      {activeCount > 0 && (
        <TreeSection
          label="Active"
          count={activeCount}
          defaultExpanded
          separator={false}
          depth={1}
        >
          {/* USER node toggle — top of Active section when authenticated (FIX-120) */}
          {showUserRow && (
            <UserNodeRow userNode={userNode} onToggle={onToggleUserNode} />
          )}
          {/* FocusGroup items */}
          {entities.filter(isFocusGroup).map(item => {
            const isPrimary = focus.primaryGroupId === item.id;
            return (
            <div
              key={item.id}
              className="flex items-center justify-between px-3 py-2 bg-accent/5 border-b border-rule/60"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-block h-2 w-2 shrink-0"
                  style={{ backgroundColor: item.color }}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink truncate flex items-center gap-1.5">
                    {item.name}
                    {isPrimary && (
                      <span className="text-[9px] uppercase tracking-wide bg-amber/20 text-ink px-1 rounded">
                        Primary
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-soft/60">
                    Group{item.count ? ` · ${item.count} members` : ''}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <button
                  onClick={() => hooks.togglePrimary(item.id)}
                  className={`text-sm transition-colors ${isPrimary ? 'text-amber hover:text-amber/80' : 'text-ink-soft/40 hover:text-amber'}`}
                  title={isPrimary ? 'Unset primary group' : 'Pin as primary group (drives treemap / sunburst / chord)'}
                >
                  {isPrimary ? '★' : '☆'}
                </button>
                <button
                  onClick={() => hooks.removeGroup(item.id)}
                  className="text-ink-soft/40 hover:text-accent text-xs transition-colors"
                  title="Remove group"
                >
                  ×
                </button>
              </div>
            </div>
            );
          })}

          {/* Tagged entity groups with Remove all header */}
          {taggedGroups.map(([tag, members]) => (
            <div key={tag}>
              <div className="px-3 py-1 flex items-center justify-between">
                <span className="text-[10px] text-ink-soft">
                  {tag} group ({members.length})
                </span>
                <button
                  onClick={() => hooks.removeGroup(tag)}
                  className="text-[10px] text-ink-soft/60 hover:text-accent"
                >
                  Remove all
                </button>
              </div>
              {members.map(entity => (
                <EntityRow key={entity.id} entity={entity} hooks={hooks} depth={depth} isPrimary={focus.primaryEntityId === entity.id} />
              ))}
            </div>
          ))}

          {/* Ungrouped entities */}
          {ungrouped.map(entity => (
            <EntityRow key={entity.id} entity={entity} hooks={hooks} depth={depth} isPrimary={focus.primaryEntityId === entity.id} />
          ))}
        </TreeSection>
      )}

      {/* Max entities warning */}
      {atMax && (
        <p className="px-3 py-1 text-[10px] text-amber">
          Maximum {MAX_FOCUS_ENTITIES} entities reached
        </p>
      )}

      {/* FIX-762 — unified browser sidebar mount (app-provided) replaces the
          legacy Find Entity + Browse Groups stack when the host wires it. */}
      {browserSlot ? (
        <TreeSection
          label="Browse & Add"
          defaultExpanded={entities.length === 0}
          separator={false}
          depth={1}
        >
          {browserSlot}
        </TreeSection>
      ) : (
        <>
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
              onAddEntity={entity => {
                if (hooks.atMaxFocus) return;
                hooks.addEntity(entity);
              }}
              activeGroupIds={
                focus.entities
                  .filter(isFocusGroup)
                  .map(g => g.id)
              }
              activeEntityIds={
                focus.entities
                  .filter(isFocusEntity)
                  .map(e => e.id)
              }
            />
          </TreeSection>
        </>
      )}

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
          <span className="text-[10px] text-ink-soft shrink-0 w-12">Depth</span>
          <DepthButtons value={depth} onChange={hooks.setDepth} />
        </div>

        {/* Scope dropdown */}
        <div
          className="flex items-center gap-2 px-2 py-1.5"
          style={{ paddingLeft: '32px' }}
        >
          <span className="text-[10px] text-ink-soft shrink-0 w-12">Scope</span>
          <select
            value={scope}
            onChange={e => hooks.setScope(e.target.value as GraphView['focus']['scope'])}
            className="flex-1 text-xs border border-rule rounded px-1.5 py-0.5 bg-card text-ink focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            {SCOPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

      </TreeSection>
    </TreeSection>
  );
}

// ── UserNodeRow ────────────────────────────────────────────────────────────────

function alignmentBadge(ratio: number | null): { label: string; color: string } {
  if (ratio == null)  return { label: 'No data', color: 'text-ink-soft/60' };
  if (ratio >= 0.6)   return { label: `${Math.round(ratio * 100)}% aligned`, color: 'text-green-ink' };
  if (ratio >= 0.4)   return { label: `${Math.round(ratio * 100)}% mixed`,   color: 'text-amber' };
  return                     { label: `${Math.round(ratio * 100)}% misaligned`, color: 'text-accent' };
}

function UserNodeRow({
  userNode,
  onToggle,
}: {
  userNode: UserNodeInfo;
  onToggle?: () => void;
}) {
  const badge = alignmentBadge(userNode.alignmentRatio);
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-accent/5 border-b border-rule/60">
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink truncate">You</div>
          <div className={`text-[10px] ${badge.color}`}>
            {userNode.repCount > 0 ? badge.label : 'Set home district to score alignment'}
          </div>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={userNode.visible}
        aria-label={userNode.visible ? 'Hide YOU node' : 'Show YOU node'}
        onClick={onToggle}
        disabled={!onToggle}
        className={`shrink-0 ml-2 w-7 h-4 rounded-full transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${userNode.visible ? 'bg-accent' : 'bg-ink/20'} ${onToggle ? '' : 'opacity-50 cursor-not-allowed'}`}
      >
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${userNode.visible ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

// ── EntityRow ──────────────────────────────────────────────────────────────────

function EntityRow({
  entity,
  hooks,
  depth,
  isPrimary,
}: {
  entity: FocusEntity;
  hooks: UseGraphViewReturn;
  depth: 1 | 2 | 3;
  isPrimary: boolean;
}) {
  const label = entity.groupTag ? (
    <span className="flex items-center gap-1">
      {entity.name}
      {isPrimary && (
        <span className="text-[9px] uppercase tracking-wide bg-amber/20 text-ink px-1 rounded">
          Primary
        </span>
      )}
      <span className="text-[9px] bg-ink/5 text-ink-soft px-1 rounded">
        {entity.groupTag}
      </span>
    </span>
  ) : (
    <span className="flex items-center gap-1">
      {entity.name}
      {isPrimary && (
        <span className="text-[9px] uppercase tracking-wide bg-amber/20 text-ink px-1 rounded">
          Primary
        </span>
      )}
    </span>
  );

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
          icon: isPrimary ? '★' : '☆',
          label: isPrimary
            ? 'Unset primary entity'
            : 'Pin as primary entity (drives treemap / sunburst / chord)',
          onClick: () => hooks.togglePrimary(entity.id),
        },
        {
          icon: entity.pinned ? '📌' : '📍',
          label: entity.pinned ? 'Unpin position' : 'Pin position',
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
        <span className="text-[10px] text-ink-soft shrink-0">Depth</span>
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
        <span className="text-[10px] text-ink-soft">Highlight</span>
        <button
          onClick={() => hooks.updateEntity(entity.id, { highlight: !entity.highlight })}
          className={`w-7 h-4 rounded-full transition-colors relative ${(entity.highlight ?? true) ? 'bg-accent' : 'bg-ink/20'}`}
        >
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${(entity.highlight ?? true) ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* Pin position toggle */}
      <div
        className="flex items-center justify-between px-2 py-1"
        style={{ paddingLeft: '32px' }}
      >
        <span className="text-[10px] text-ink-soft">Pin position</span>
        <button
          onClick={() => hooks.updateEntity(entity.id, { pinned: !entity.pinned })}
          className={`w-7 h-4 rounded-full transition-colors relative ${entity.pinned ? 'bg-accent' : 'bg-ink/20'}`}
        >
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${entity.pinned ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </button>
      </div>
    </TreeNode>
  );
}
