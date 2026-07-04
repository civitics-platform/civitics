"use client";

/**
 * apps/civitics/app/graph/EmptyStatePresets.tsx
 *
 * Three preset cards rendered alongside the "Search to start exploring" copy
 * when the force graph has no nodes. Per FIX-131 / GRAPH_PLAN §3.4: a one-click
 * path into a populated graph for new users. Each card has a static inline SVG
 * thumbnail (no live render — keep the empty state cheap) and applies a
 * matching preset on click.
 */

import {
  BUILT_IN_PRESETS,
  getGroupById,
  type UseGraphViewReturn,
  type FocusGroup,
} from "@civitics/graph";

interface PresetCardSpec {
  presetId: string;
  vizLabel: string;
  title: string;
  /** Optional group id from BUILT_IN_GROUPS — added after applyPreset for force presets. */
  groupId?: string;
  /** Inline SVG thumbnail. Keep dimensions ~64×40 to fit the card. */
  thumbnail: JSX.Element;
}

const PRESET_CARDS: PresetCardSpec[] = [
  {
    presetId: 'follow-the-money',
    vizLabel: 'Force',
    title: 'U.S. Senate + their donors',
    groupId: 'group-full-senate',
    thumbnail: <ForceThumbnail />,
  },
  {
    presetId: 'treemap-pac-sector',
    vizLabel: 'Treemap',
    title: 'PACs by industry sector',
    thumbnail: <TreemapThumbnail />,
  },
  {
    presetId: 'chord-donor-industries',
    vizLabel: 'Chord',
    title: 'Industries → parties',
    thumbnail: <ChordThumbnail />,
  },
];

export interface EmptyStatePresetsProps {
  hooks: UseGraphViewReturn;
}

export function EmptyStatePresets({ hooks }: EmptyStatePresetsProps) {
  function applyCard(card: PresetCardSpec) {
    const preset = BUILT_IN_PRESETS.find(p => p.meta.presetId === card.presetId);
    if (!preset) return;
    hooks.applyPreset(preset);
    if (card.groupId) {
      const group = getGroupById(card.groupId) as FocusGroup | undefined;
      if (group) hooks.addGroup(group);
    }
  }

  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      {PRESET_CARDS.map(card => (
        <button
          key={card.presetId}
          onClick={() => applyCard(card)}
          className="group flex flex-col items-stretch p-2 rounded-lg border border-rule bg-card/60 hover:bg-ink/10 hover:border-accent transition-colors text-left"
        >
          <div className="h-12 w-full rounded bg-paper-2 border border-rule flex items-center justify-center overflow-hidden">
            {card.thumbnail}
          </div>
          <span className="mt-2 text-[10px] uppercase tracking-wider text-amber font-semibold">
            {card.vizLabel}
          </span>
          <span className="text-[11px] text-ink leading-tight mt-0.5">
            {card.title}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Static thumbnails ─────────────────────────────────────────────────────────
//
// Tiny inline SVGs that *suggest* each viz layout. Not live renders — the
// whole point of the empty state is to stay cheap. Keep them readable at
// ~64×40 and don't try to encode real data.

function ForceThumbnail() {
  return (
    <svg viewBox="0 0 64 40" className="w-full h-full">
      <line x1="20" y1="14" x2="32" y2="20" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.7" opacity="0.6" />
      <line x1="32" y1="20" x2="46" y2="14" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.7" opacity="0.6" />
      <line x1="32" y1="20" x2="44" y2="28" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.7" opacity="0.6" />
      <line x1="32" y1="20" x2="20" y2="28" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.7" opacity="0.6" />
      <line x1="20" y1="28" x2="44" y2="28" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.7" opacity="0.4" />
      <circle cx="32" cy="20" r="3.5" style={{ fill: "rgb(var(--c-blue))" }} />
      <circle cx="20" cy="14" r="2.2" style={{ fill: "rgb(var(--c-blue))" }} />
      <circle cx="46" cy="14" r="2.2" style={{ fill: "rgb(var(--c-accent))" }} />
      <circle cx="20" cy="28" r="2.2" style={{ fill: "rgb(var(--c-green-ink))" }} />
      <circle cx="44" cy="28" r="2.2" style={{ fill: "rgb(var(--c-amber))" }} />
    </svg>
  );
}

function TreemapThumbnail() {
  return (
    <svg viewBox="0 0 64 40" className="w-full h-full">
      <rect x="2"  y="2"  width="28" height="22" style={{ fill: "rgb(var(--c-blue))" }} opacity="0.8" />
      <rect x="32" y="2"  width="14" height="14" style={{ fill: "rgb(var(--c-accent))" }} opacity="0.8" />
      <rect x="48" y="2"  width="14" height="14" style={{ fill: "rgb(var(--c-viz-7))" }} opacity="0.8" />
      <rect x="32" y="18" width="30" height="6"  style={{ fill: "rgb(var(--c-green-ink))" }} opacity="0.8" />
      <rect x="2"  y="26" width="18" height="12" style={{ fill: "rgb(var(--c-amber))" }} opacity="0.8" />
      <rect x="22" y="26" width="20" height="12" style={{ fill: "rgb(var(--c-viz-2))" }} opacity="0.8" />
      <rect x="44" y="26" width="18" height="12" style={{ fill: "rgb(var(--c-viz-1))" }} opacity="0.8" />
    </svg>
  );
}

function ChordThumbnail() {
  return (
    <svg viewBox="0 0 64 40" className="w-full h-full">
      <g transform="translate(32 20)">
        {/* Outer ring sectors */}
        <path d="M -16 0 A 16 16 0 0 1 -5 -15" style={{ stroke: "rgb(var(--c-blue))" }} strokeWidth="3" fill="none" />
        <path d="M -5 -15 A 16 16 0 0 1 12 -10" style={{ stroke: "rgb(var(--c-accent))" }} strokeWidth="3" fill="none" />
        <path d="M 12 -10 A 16 16 0 0 1 16 0" style={{ stroke: "rgb(var(--c-viz-7))" }} strokeWidth="3" fill="none" />
        <path d="M 16 0 A 16 16 0 0 1 5 15" style={{ stroke: "rgb(var(--c-amber))" }} strokeWidth="3" fill="none" />
        <path d="M 5 15 A 16 16 0 0 1 -12 10" style={{ stroke: "rgb(var(--c-green-ink))" }} strokeWidth="3" fill="none" />
        <path d="M -12 10 A 16 16 0 0 1 -16 0" style={{ stroke: "rgb(var(--c-viz-2))" }} strokeWidth="3" fill="none" />
        {/* Chord ribbons */}
        <path d="M -14 -5 Q 0 0 10 -10" style={{ stroke: "rgb(var(--c-term-blue))" }} strokeWidth="0.8" fill="none" opacity="0.7" />
        <path d="M -3 -14 Q 0 0 14 4" style={{ stroke: "rgb(var(--c-accent))" }} strokeWidth="0.8" fill="none" opacity="0.7" />
        <path d="M 14 4 Q 0 0 -8 12" style={{ stroke: "rgb(var(--c-amber))" }} strokeWidth="0.8" fill="none" opacity="0.7" />
      </g>
    </svg>
  );
}
