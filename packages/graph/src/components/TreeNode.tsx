"use client";

/**
 * packages/graph/src/components/TreeNode.tsx
 *
 * The ONLY layout primitive for both DataExplorerPanel and GraphConfigPanel.
 * Every row in both panels is a TreeNode.
 *
 * Variants:
 *   section    — semibold uppercase label, thin separator above
 *   item       — normal weight row, optional expand
 *   entity     — circular avatar with party color ring
 *   connection — colored dot using CONNECTION_TYPE_REGISTRY color
 */

import { useState, type ReactNode } from 'react';
import React from 'react';

// ── Action ─────────────────────────────────────────────────────────────────────

export interface TreeNodeAction {
  icon: string;
  label: string;
  onClick: () => void;
}

// ── Variant ────────────────────────────────────────────────────────────────────

export type TreeNodeVariant = 'section' | 'item' | 'entity' | 'connection';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface TreeNodeProps {
  label: string | React.ReactNode;
  variant?: TreeNodeVariant;
  /** Depth for indentation: depth * 12px */
  depth?: number;
  /** Gray pill badge shown to the right of the label */
  count?: number;
  /** Replaces expand arrow with spinner when true */
  loading?: boolean;
  /** Shows orange dot on label when true */
  dirty?: boolean;
  /** Highlights label in indigo */
  active?: boolean;
  /** Whether this node can be expanded/collapsed */
  collapsible?: boolean;
  defaultExpanded?: boolean;
  children?: ReactNode;
  /** Up to 3 icon-button actions shown on row hover */
  actions?: TreeNodeAction[];
  /** Emoji or short text icon (shown for section/item when no avatar/dot) */
  icon?: string;
  /** entity variant: photo URL for avatar */
  photoUrl?: string;
  /** entity variant: party string for ring color */
  party?: string;
  /** connection variant: hex color for dot */
  connectionColor?: string;
  /** Whether to show separator line above (sections only, default true) */
  separator?: boolean;
  onClick?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const PARTY_RING: Record<string, string> = {
  democrat:    'ring-blue-500',
  republican:  'ring-red-500',
  independent: 'ring-purple-500',
};

function partyRingClass(party?: string): string {
  if (!party) return 'ring-gray-300';
  return PARTY_RING[party.toLowerCase()] ?? 'ring-gray-300';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return ((parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '')).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// ── TreeNode ───────────────────────────────────────────────────────────────────

export function TreeNode({
  label,
  variant = 'item',
  depth = 0,
  count,
  loading,
  dirty,
  active,
  collapsible = true,
  defaultExpanded = false,
  children,
  actions,
  icon,
  photoUrl,
  party,
  connectionColor,
  separator = true,
  onClick,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasChildren = collapsible && children != null;
  const isSection   = variant === 'section';

  function handleRowClick() {
    if (hasChildren) setExpanded(e => !e);
    onClick?.();
  }

  return (
    <div>
      {/* Separator above sections */}
      {isSection && separator && (
        <div className="h-px bg-gray-100 mx-2 mt-1" />
      )}

      {/* Row */}
      <div
        className="group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-gray-50 transition-colors select-none"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={handleRowClick}
      >
        {/* Expand arrow / spinner / spacer */}
        <div className="w-3 h-3 shrink-0 flex items-center justify-center">
          {hasChildren ? (
            loading ? (
              <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg
                className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )
          ) : null}
        </div>

        {/* Entity avatar */}
        {variant === 'entity' && (
          <div className={`w-6 h-6 shrink-0 rounded-full ring-2 ${partyRingClass(party)} overflow-hidden flex items-center justify-center bg-gray-100`}>
            {photoUrl ? (
              <img src={photoUrl} alt={typeof label === 'string' ? label : ''} className="w-full h-full object-cover" />
            ) : (
              <span className="text-[9px] font-semibold text-gray-600">{typeof label === 'string' ? initials(label) : '?'}</span>
            )}
          </div>
        )}

        {/* Connection dot */}
        {variant === 'connection' && connectionColor && (
          <div
            className="w-3 h-3 shrink-0 rounded-full"
            style={{ backgroundColor: connectionColor }}
          />
        )}

        {/* Icon (section/item, not entity/connection) */}
        {variant !== 'entity' && variant !== 'connection' && icon && (
          <span className="text-sm shrink-0 leading-none">{icon}</span>
        )}

        {/* Label */}
        <span
          className={[
            'flex-1 min-w-0 truncate text-xs leading-tight',
            isSection
              ? 'font-semibold text-gray-900 uppercase tracking-wide'
              : 'font-normal text-gray-700',
            active ? 'text-indigo-700 font-medium' : '',
          ].join(' ')}
        >
          {label}
          {dirty && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 ml-1 mb-0.5 align-middle" />
          )}
        </span>

        {/* Count badge */}
        {count != null && (
          <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] leading-none">
            {count}
          </span>
        )}

        {/* Actions — hidden until row hover */}
        {actions && actions.length > 0 && (
          <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {actions.slice(0, 3).map((action, i) => (
              <button
                key={i}
                title={action.label}
                onClick={e => { e.stopPropagation(); action.onClick(); }}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors text-xs leading-none"
              >
                {action.icon}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {children}
        </div>
      )}
    </div>
  );
}

// ── TreeSection ────────────────────────────────────────────────────────────────

export interface TreeSectionProps {
  label: string | React.ReactNode;
  icon?: string;
  count?: number;
  action?: {
    icon: string;
    label: string;
    onClick: () => void;
  };
  defaultExpanded?: boolean;
  children: ReactNode;
  depth?: number;
  separator?: boolean;
}

export function TreeSection({
  label,
  icon,
  count,
  action,
  defaultExpanded = true,
  children,
  depth = 0,
  separator = true,
}: TreeSectionProps) {
  return (
    <TreeNode
      label={label}
      variant="section"
      icon={icon}
      count={count}
      collapsible
      defaultExpanded={defaultExpanded}
      depth={depth}
      actions={action ? [action] : undefined}
      separator={separator}
    >
      {children}
    </TreeNode>
  );
}
