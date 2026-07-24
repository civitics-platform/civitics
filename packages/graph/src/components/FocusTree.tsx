"use client";

/**
 * packages/graph/src/components/FocusTree.tsx
 *
 * Renders the FOCUS section of DataExplorerPanel (the left "what is on the
 * graph" panel — FIX-812). Shows active focus entities with slim per-entity
 * controls, the browse/add slot, and the path finder.
 *
 * FIX-812 — entity rows slimmed to depth chips [1|2] · primary · pin · remove.
 * The depth-3 chip is gone (the server clamps depth at 2, so "3" was a lie)
 * and the expanded-row Highlight toggle is deleted (ForceGraph never read
 * entity.highlight — it was a placebo). Hovering a row transiently spotlights
 * that entity's neighborhood on the canvas through the FIX-807 opacity
 * resolver (onEntityHover). The legacy global OPTIONS section is dissolved:
 * Default depth lives in the right panel's View tab; the Scope select gated
 * nothing (focus.scope had zero readers) and was not re-mounted — the field
 * itself is now retired (FIX-816).
 *
 * FIX-762 — the host app passes `browserSlot` (the unified browse sidebar
 * mount, app-side because it depends on app lib/route code this package can't
 * import) into the "Browse & Add" section. FIX-773 removed the legacy
 * Find Entity + Browse Groups fallback, so `browserSlot` is now required.
 */

import React, { type ReactNode } from 'react';
import type { FocusEntity, GraphView } from '../types';
import { isFocusEntity, isFocusGroup, MAX_FOCUS_ENTITIES } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { TreeSection } from './TreeNode';
import { PathFinder } from '../PathFinder';
import { Icon } from '../icons';

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
  /** FIX-762/773 — unified browser sidebar mount (required; the legacy
   *  Find Entity + Browse Groups fallback was removed in FIX-773). */
  browserSlot: ReactNode;
  /**
   * FIX-812 — row hover spotlight. Fired with the entity id on row
   * mouseenter and null on mouseleave; GraphPage routes it into the
   * ForceGraph opacity resolver (FIX-807).
   */
  onEntityHover?: (entityId: string | null) => void;
}

/** FIX-812 — the server clamps fetch depth at 2; show legacy depth-3 saves as 2. */
const clampDepth = (d: number): 1 | 2 => (d >= 2 ? 2 : 1);

function DepthChips({
  value,
  onChange,
}: {
  value: 1 | 2;
  onChange: (d: 1 | 2) => void;
}) {
  return (
    <div className="flex gap-0.5">
      {([1, 2] as const).map(d => (
        <button
          key={d}
          onClick={e => { e.stopPropagation(); onChange(d); }}
          title={`Connection depth ${d}`}
          aria-label={`Connection depth ${d}`}
          aria-pressed={value === d}
          className={`w-5 h-5 text-[10px] font-medium rounded border transition-colors ${
            value === d
              ? 'bg-accent border-accent text-paper'
              : 'bg-card border-rule text-ink-soft hover:border-accent'
          }`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

export function FocusTree({
  focus,
  hooks,
  graphMeta: _graphMeta,
  userNode,
  onToggleUserNode,
  browserSlot,
  onEntityHover,
}: FocusTreeProps) {
  const { entities, depth } = focus;
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
                <EntityRow
                  key={entity.id}
                  entity={entity}
                  hooks={hooks}
                  depth={depth}
                  isPrimary={focus.primaryEntityId === entity.id}
                  onHover={onEntityHover}
                />
              ))}
            </div>
          ))}

          {/* Ungrouped entities */}
          {ungrouped.map(entity => (
            <EntityRow
              key={entity.id}
              entity={entity}
              hooks={hooks}
              depth={depth}
              isPrimary={focus.primaryEntityId === entity.id}
              onHover={onEntityHover}
            />
          ))}
        </TreeSection>
      )}

      {/* Max entities warning */}
      {atMax && (
        <p className="px-3 py-1 text-[10px] text-amber">
          Maximum {MAX_FOCUS_ENTITIES} entities reached
        </p>
      )}

      {/* FIX-762/773 — unified browser sidebar mount (app-provided). The legacy
          Find Entity + Browse Groups fallback was removed in FIX-773. */}
      <TreeSection
        label="Browse & Add"
        defaultExpanded={entities.length === 0}
        separator={false}
        depth={1}
      >
        {browserSlot}
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

      {/* FIX-812 — the legacy OPTIONS section is dissolved. Default depth now
          lives in the right panel's View tab; the Scope select gated nothing
          (focus.scope had zero readers) and was not re-mounted — the field is
          now retired (FIX-816). */}
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
//
// FIX-812 — slim single row, no expansion body:
//   [avatar] name · Primary/tag badges   [1|2] ★ 📌 ×
// The primary star and position pin are state-visible (rendered solid when
// set) and always reachable; remove shows on hover. Hovering the row
// spotlights the entity's neighborhood on the canvas via onHover.

const PARTY_RING: Record<string, string> = {
  democrat:    'rgb(var(--c-blue))',
  republican:  'rgb(var(--c-accent))',
  independent: 'rgb(var(--c-viz-7))',
};

function partyRingColor(party?: string): string {
  if (!party) return 'rgb(var(--c-ink-soft))';
  return PARTY_RING[party.toLowerCase()] ?? 'rgb(var(--c-ink-soft))';
}

function rowInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return ((parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '')).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function EntityRow({
  entity,
  hooks,
  depth,
  isPrimary,
  onHover,
}: {
  entity: FocusEntity;
  hooks: UseGraphViewReturn;
  depth: 1 | 2 | 3;
  isPrimary: boolean;
  onHover?: (entityId: string | null) => void;
}) {
  const effectiveDepth = clampDepth(entity.depth ?? depth);
  const pinned = !!entity.pinned;

  return (
    <div
      className="group flex items-center gap-1.5 py-1.5 pr-2 hover:bg-ink/5 border-l-2 border-transparent transition-colors"
      style={{ paddingLeft: '20px' }}
      onMouseEnter={() => onHover?.(entity.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      {/* Avatar with party ring */}
      <div
        className="w-6 h-6 shrink-0 rounded-full ring-2 overflow-hidden flex items-center justify-center bg-ink/10"
        style={{ '--tw-ring-color': partyRingColor(entity.party) } as React.CSSProperties}
      >
        {entity.photoUrl ? (
          <img src={entity.photoUrl} alt={entity.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-[9px] font-semibold text-ink-soft">{rowInitials(entity.name)}</span>
        )}
      </div>

      {/* Name + badges */}
      <span className="flex-1 min-w-0 flex items-center gap-1 text-xs text-ink">
        <span className="truncate">{entity.name}</span>
        {isPrimary && (
          <span className="text-[9px] uppercase tracking-wide bg-amber/20 text-ink px-1 rounded shrink-0">
            Primary
          </span>
        )}
        {entity.groupTag && (
          <span className="text-[9px] bg-ink/5 text-ink-soft px-1 rounded shrink-0">
            {entity.groupTag}
          </span>
        )}
      </span>

      {/* Depth chips — per-entity override, 1|2 only (server clamps at 2) */}
      <DepthChips
        value={effectiveDepth}
        onChange={d => hooks.updateEntity(entity.id, { depth: d })}
      />

      {/* Primary star — solid when set, hover-reveal otherwise */}
      <button
        onClick={() => hooks.togglePrimary(entity.id)}
        title={isPrimary
          ? 'Unset primary entity'
          : 'Pin as primary entity (drives treemap / sunburst / chord)'}
        aria-label={isPrimary ? `Unset ${entity.name} as primary` : `Set ${entity.name} as primary`}
        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-xs leading-none transition-all ${
          isPrimary
            ? 'text-amber hover:text-amber/80'
            : 'text-ink-soft/40 hover:text-amber opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        {isPrimary ? '★' : '☆'}
      </button>

      {/* Position pin — solid when pinned, hover-reveal otherwise */}
      <button
        onClick={() => hooks.updateEntity(entity.id, { pinned: !pinned })}
        title={pinned ? 'Unpin position' : 'Pin position in the layout'}
        aria-label={pinned ? `Unpin ${entity.name} position` : `Pin ${entity.name} position`}
        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-xs leading-none transition-all ${
          pinned
            ? 'text-accent'
            : 'text-ink-soft/40 hover:text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        <Icon name="pin" className="w-3.5 h-3.5" />
      </button>

      {/* Remove */}
      <button
        onClick={() => hooks.removeEntity(entity.id)}
        title="Remove from graph"
        aria-label={`Remove ${entity.name} from graph`}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-xs leading-none text-ink-soft/40 hover:text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
      >
        ×
      </button>
    </div>
  );
}
