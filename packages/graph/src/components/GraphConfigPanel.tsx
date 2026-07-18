"use client";

/**
 * packages/graph/src/components/GraphConfigPanel.tsx
 *
 * Right panel — FIX-812: HOW the graph renders. Two tabs:
 *   View        — visualization picker, presets, per-viz settings (+ the
 *                 viz-agnostic Default depth select), Physics (collapsed).
 *   Connections — the ConnectionsTree per-type styling rows (moved here from
 *                 the left panel) plus the edge-filter group (donation floor,
 *                 min strength, individual donors mode — they filter edges,
 *                 so they live with edges).
 * Tab choice persists per session (localStorage), defaults to View.
 * Width driven by the host (drag-resize, FIX-813); collapsed = 40px strip.
 *
 * Keyboard shortcut: ] toggles right panel (managed by GraphPage)
 */

import { useEffect, useRef, useState } from 'react';
import type { GraphView, VizType, IndividualDisplayMode } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import type { GraphMeta } from '../hooks/useGraphData';
import { VIZ_REGISTRY, getVizApplicability } from '../visualizations/registry';
import { BUILT_IN_PRESETS, isPresetApplicableToView } from '../presets';
import {
  listSavedViews,
  deleteSavedView,
  SAVED_VIEWS_CHANGE_EVENT,
  type SavedView,
} from '../saved-views';
import { TreeNode, TreeSection } from './TreeNode';
import { ConnectionsTree } from './ConnectionsTree';
import { isFocusEntity } from '../types';

/** FIX-813 — default width; host may override via the width prop. */
export const RIGHT_PANEL_DEFAULT_WIDTH = 260;

// FIX-134: section-jump targets the right-panel collapsed icons can scroll to.
type ConfigSection = 'viz' | 'presets' | 'settings';

type ConfigTab = 'view' | 'connections';

/** FIX-812 — tab persistence key (per-session UX nicety, additive state). */
const TAB_STORAGE_KEY = 'civitics-graph-config-tab';

export interface GraphConfigPanelProps {
  view: GraphView;
  hooks: UseGraphViewReturn;
  collapsed: boolean;
  onCollapse: () => void;
  onSavePreset: () => void;
  /** Optional: derived from loaded graph data. Used to self-configure visible options. */
  graphMeta?: GraphMeta;
  /** FIX-812 — gates the alignment type in the Connections tab (FIX-128). */
  userNodeVisible?: boolean;
  /** FIX-813 — panel width in px (180–400). Defaults to 260. */
  width?: number;
  /** FIX-814 — drawer mode: fills its container, host owns the overlay chrome. */
  asDrawer?: boolean;
}

// Emoji for each preset
const PRESET_EMOJI: Record<string, string> = {
  'follow-the-money':       '💰',
  'votes-and-bills':        '🗳',
  'nominations':            '⭐',
  'committee-power':        '👁',
  'full-record':            '📋',
  'clean-view':             '✨',
  'chord-sector-vote':      '⚖️',
  'chord-subject-party':    '🏷️',
  'chord-donor-type-party': '🏛️',
  'chord-state-party':      '📍',
};

// Standard viz types from registry
const STD_VIZ   = VIZ_REGISTRY.filter(v => v.group === 'standard');
const COMING_VIZ = VIZ_REGISTRY.filter(v => v.group === 'coming_soon');

// ── Sliders ────────────────────────────────────────────────────────────────────
//
// FIX-130: each labeled control accepts a `disabledReason` prop. When set the
// control is greyed and shows a `Not available — {reason}` tooltip. Selects
// also accept per-option `disabled` + `disabledReason` so non-applicable
// options stay visible (instead of being filtered out) but cannot be picked.

interface LabeledOption {
  value: string;
  label: string;
  /** When true the option is rendered but cannot be selected. */
  disabled?: boolean;
  /** Hover tooltip — appended to the label so its reason is also visible inline. */
  disabledReason?: string;
}

function tooltipFor(disabledReason: string | undefined): string | undefined {
  return disabledReason ? `Not available — ${disabledReason}` : undefined;
}

function LabeledSlider({
  label, min, max, step, value, onChange, disabledReason,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabledReason?: string;
}) {
  const disabled = !!disabledReason;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 ${disabled ? 'opacity-50' : ''}`}
      title={tooltipFor(disabledReason)}
    >
      <span aria-hidden="true" className="text-[10px] text-ink-soft w-20 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        aria-label={label}
        disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 rounded disabled:cursor-not-allowed"
      />
    </div>
  );
}

// FIX-220 — Donation floor control. Six log-scale stops mapped to a single
// minAmount value on view.connections.donation. FIX-812 — lives in the
// Connections tab filter group (it filters donation edges), no longer
// duplicated inside the Force/Treemap View settings.
//
// Stop-index → dollar floor:
//   0: $0      (show all)
//   1: $200    (hide below the FEC itemization threshold)
//   2: $1,000
//   3: $10,000 (mid)
//   4: $100,000 (major)
//   5: $1,000,000 (mega)
const DONATION_FLOOR_STOPS = [0, 200, 1_000, 10_000, 100_000, 1_000_000] as const;

function dollarsToStop(dollars: number): number {
  // Find the index of the closest stop ≤ dollars
  let idx = 0;
  for (let i = 0; i < DONATION_FLOOR_STOPS.length; i++) {
    if (dollars >= DONATION_FLOOR_STOPS[i]!) idx = i;
  }
  return idx;
}

function formatDollars(d: number): string {
  if (d === 0)        return '$0';
  if (d < 1_000)      return `$${d}`;
  if (d < 1_000_000)  return `$${(d / 1_000).toFixed(0)}K`;
  return `$${(d / 1_000_000).toFixed(0)}M`;
}

function DonationFloorControl({ view, hooks, label = 'Donation floor' }: {
  view: GraphView;
  hooks: UseGraphViewReturn;
  label?: string;
}) {
  const current = view.connections?.donation?.minAmount ?? 0;
  const stop = dollarsToStop(current);
  const dollars = DONATION_FLOOR_STOPS[stop]!;
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] text-ink-soft w-20 shrink-0">{label}</span>
        <input
          type="range"
          min={0}
          max={DONATION_FLOOR_STOPS.length - 1}
          step={1}
          value={stop}
          aria-label={label}
          onChange={e => {
            const next = parseInt(e.target.value, 10);
            const safe = Math.max(0, Math.min(DONATION_FLOOR_STOPS.length - 1, next));
            const value = DONATION_FLOOR_STOPS[safe]!;
            hooks.setConnectionMinAmount('donation', value);
          }}
          className="flex-1 h-1 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 rounded"
        />
        <span className="text-[10px] text-ink-soft w-10 text-right tabular-nums">
          {formatDollars(dollars)}
        </span>
      </div>
      <div className="px-3 pb-1 text-[9px] text-ink-soft italic leading-tight">
        {dollars === 0
          ? 'Showing all donations'
          : `Hiding donations below ${formatDollars(dollars)}`}
      </div>
    </>
  );
}

function LabeledSelect({
  label, value, options, onChange, disabledReason,
}: {
  label: string;
  value: string;
  options: LabeledOption[];
  onChange: (v: string) => void;
  disabledReason?: string;
}) {
  const disabled = !!disabledReason;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 ${disabled ? 'opacity-50' : ''}`}
      title={tooltipFor(disabledReason)}
    >
      <span aria-hidden="true" className="text-[10px] text-ink-soft w-20 shrink-0">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="flex-1 text-xs text-ink border border-rule rounded px-1.5 py-0.5 bg-card focus:outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:bg-paper-2"
      >
        {options.map(o => (
          <option
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            title={tooltipFor(o.disabledReason)}
          >
            {o.label}{o.disabled ? ' (no data)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function LabeledToggle({
  label, value, onChange, disabledReason,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabledReason?: string;
}) {
  const disabled = !!disabledReason;
  return (
    <div
      className={`flex items-center justify-between px-3 py-1 ${disabled ? 'opacity-50' : ''}`}
      title={tooltipFor(disabledReason)}
    >
      <span aria-hidden="true" className="text-[10px] text-ink-soft">{label}</span>
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-[9px] text-ink-soft">{value ? 'On' : 'Off'}</span>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(!value)}
          className={`w-7 h-4 rounded-full transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:cursor-not-allowed ${value ? 'bg-accent' : 'bg-ink/20'}`}
        >
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${value ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </button>
      </div>
    </div>
  );
}

// ── Vote/donation count helpers (shared across settings panels) ────────────────

const VOTE_EDGE_TYPES = ['vote_yes', 'vote_no', 'vote_abstain', 'nomination_vote_yes', 'nomination_vote_no'];

function voteCountFrom(graphMeta?: GraphMeta): number {
  if (!graphMeta) return 0;
  return VOTE_EDGE_TYPES.reduce((s, t) => s + (graphMeta.connectionTypes[t]?.count ?? 0), 0);
}

function donationCountFrom(graphMeta?: GraphMeta): number {
  return graphMeta?.connectionTypes['donation']?.count ?? 0;
}

// ── Force settings ─────────────────────────────────────────────────────────────
//
// FIX-812 — the Filters group (donation floor, min strength) and the
// Individual Donors mode moved to the Connections tab: they filter edges, so
// they live with edges. Physics collapses into its own sub-section.

function ForceSettings({ view, hooks, graphMeta }: { view: GraphView; hooks: UseGraphViewReturn; graphMeta?: GraphMeta }) {
  const opts = view.style.vizOptions.force;
  function set(key: string, value: unknown) { hooks.setVizOption('force', key, value); }

  const voteCount     = voteCountFrom(graphMeta);
  const donationCount = donationCountFrom(graphMeta);

  // FIX-130: don't filter — disable. Each option that doesn't have backing data
  // stays in the list (so users can see the full option set) but is marked
  // disabled with a one-line reason.
  const hasDonations = graphMeta?.hasDonations ?? true;
  const hasVotes     = graphMeta?.hasVotes     ?? true;

  const nodeSizeOptions: LabeledOption[] = [
    { value: 'connection_count', label: 'Connections' },
    {
      value: 'donation_total',
      label: donationCount > 0 ? `Donations (${donationCount})` : 'Donations',
      disabled: !hasDonations,
      disabledReason: 'No donation data in graph',
    },
    {
      value: 'bills_sponsored',
      label: voteCount > 0 ? `Bills (${voteCount})` : 'Bills',
      disabled: !hasVotes,
      disabledReason: 'No vote data in graph',
    },
    { value: 'years_in_office', label: 'Seniority' },
    { value: 'uniform',         label: 'Uniform' },
  ];

  // If the current encoding lands on a now-disabled option, fall back to the default.
  const sizeEncoding = opts?.nodeSizeEncoding ?? 'connection_count';
  const currentDisabled = nodeSizeOptions.find(o => o.value === sizeEncoding)?.disabled ?? false;
  const validSizeEncoding = currentDisabled ? 'connection_count' : sizeEncoding;

  return (
    <>
      <LabeledSelect
        label="Layout"
        value={opts?.layout ?? 'force_directed'}
        options={[
          { value: 'force_directed', label: 'Force directed' },
          { value: 'radial',         label: 'Radial'         },
          { value: 'hierarchical',   label: 'Hierarchical'   },
          { value: 'circular',       label: 'Circular'       },
        ]}
        onChange={v => set('layout', v)}
      />
      <LabeledSelect
        label="Node size"
        value={validSizeEncoding}
        options={nodeSizeOptions}
        onChange={v => set('nodeSizeEncoding', v)}
      />
      {/* FIX-847 — how the size magnitude maps to radius. Mirrors the treemap
          "Size scale" control; force adds 'sqrt' (the historical default). */}
      <LabeledSelect
        label="Size scale"
        value={opts?.sizeScale ?? 'sqrt'}
        options={[
          { value: 'sqrt',   label: 'Square root (default)' },
          { value: 'log',    label: 'Log (tame outliers)'   },
          { value: 'linear', label: 'Linear (true ratios)'  },
        ]}
        onChange={v => set('sizeScale', v)}
      />
      <LabeledSelect
        label="Color by"
        value={opts?.nodeColorEncoding ?? 'entity_type'}
        options={[
          { value: 'entity_type',      label: 'Entity type' },
          { value: 'party_affiliation', label: 'Party'      },
          { value: 'industry_sector',  label: 'Industry'    },
          { value: 'state_region',     label: 'State'       },
        ]}
        onChange={v => set('nodeColorEncoding', v)}
      />
      {/* FIX-804 — global "Edge opacity" slider deleted: it was a placebo (read
          only by the removed legacy ForceGraph) and redundant with the per-type
          opacity control in ConnectionStyleRow. */}
      <LabeledSelect
        label="Labels"
        value={opts?.labels ?? 'hover'}
        options={[
          { value: 'always', label: 'Always' },
          { value: 'hover',  label: 'Hover'  },
          { value: 'never',  label: 'Never'  },
        ]}
        onChange={v => set('labels', v)}
      />
      {/* Physics — collapsed group (FIX-812) */}
      <TreeSection label="Physics" defaultExpanded={false} separator={false} depth={1}>
        <LabeledSlider label="Charge" min={-1000} max={-50} step={50} value={opts?.charge ?? -300} onChange={v => set('charge', v)} />
        <LabeledSlider label="Link dist" min={50} max={500} step={10} value={opts?.linkDistance ?? 150} onChange={v => set('linkDistance', v)} />
        <LabeledSlider label="Gravity" min={0} max={1} step={0.05} value={opts?.gravity ?? 0.1} onChange={v => set('gravity', v)} />
        <LabeledToggle
          label="Type clusters"
          value={opts?.typeClusterEnabled ?? false}
          onChange={v => set('typeClusterEnabled', v)}
        />
        {(opts?.typeClusterEnabled ?? false) && (
          <LabeledSlider
            label="Cluster pull"
            min={0} max={0.3} step={0.01}
            value={opts?.typeClusterStrength ?? 0.08}
            onChange={v => set('typeClusterStrength', v)}
          />
        )}
      </TreeSection>
    </>
  );
}

// ── Chord settings ─────────────────────────────────────────────────────────────

function ChordSettings({ view, hooks, graphMeta }: { view: GraphView; hooks: UseGraphViewReturn; graphMeta?: GraphMeta }) {
  const opts = view.style.vizOptions.chord;
  function set(key: string, value: unknown) { hooks.setVizOption('chord', key, value); }

  // Per-mode data + focus requirements. Modes lacking backing data or focus
  // stay visible in the picker but are disabled with a one-line reason — same
  // pattern as TreemapSettings, so users always see the full option set.
  const focusOfficialCount = view.focus.entities.filter(
    (e) => e.type === 'official',
  ).length;
  const focusGroupCount = view.focus.entities.filter(
    (e) => e.type === 'group',
  ).length;
  // graphMeta is undefined until first graph data load; default to permissive.
  const hasDonations = graphMeta?.hasDonations ?? true;
  const hasVotes     = graphMeta?.hasVotes     ?? true;

  const dataModeOptions: LabeledOption[] = [
    {
      value: 'industry-party',
      label: 'Industry → Party (global)',
      disabled: !hasDonations,
      disabledReason: 'No donation data in graph',
    },
    {
      value: 'industry-official',
      label: 'Industries → Official',
      disabled: focusOfficialCount === 0 || !hasDonations,
      disabledReason: focusOfficialCount === 0 ? 'Focus an official' : 'No donation data in graph',
    },
    {
      value: 'sector-group',
      label: 'Sectors → Group',
      disabled: focusGroupCount < 1 || !hasDonations,
      disabledReason: focusGroupCount < 1 ? 'Focus a group' : 'No donation data in graph',
    },
    {
      value: 'sector-group-pair',
      label: 'Sectors ↔ Two Groups',
      disabled: focusGroupCount < 2 || !hasDonations,
      disabledReason: focusGroupCount < 2 ? 'Focus 2 groups' : 'No donation data in graph',
    },
    {
      value: 'sector-vote',
      label: 'Sectors ↔ Vote Outcome',
      disabled: focusOfficialCount === 0,
      disabledReason: 'Focus an official',
    },
    {
      value: 'subject-party',
      label: 'Bill Subjects → Party',
      disabled: !hasVotes,
      disabledReason: 'No vote data in graph',
    },
    {
      value: 'donor-type-party',
      label: 'Donor Type → Party',
    },
    {
      value: 'state-party',
      label: 'Donor State → Party',
    },
  ];

  // Default mode mirrors registry — fall back to industry-party. If the
  // current pick is now disabled (focus changed), drop back to the default.
  const dataMode = opts?.dataMode ?? 'industry-party';
  const dataModeDisabled = dataModeOptions.find(o => o.value === dataMode)?.disabled ?? false;
  const validDataMode = dataModeDisabled ? 'industry-party' : dataMode;

  // Granularity picker — controls how donor arcs are bucketed. Only meaningful
  // for donor-side modes (industry-party, industry-official). For other modes
  // (subject-party / donor-type-party / state-party) the arc dimension is
  // already fixed; granularity is disabled with a tooltip.
  const granularitySupported = validDataMode === 'industry-party'
    || validDataMode === 'industry-official';
  const granularity = opts?.granularity ?? 'aggregate';

  // Top-pacs and by-bracket only work with an official focus today (server
  // RPCs are scoped per-official). For the global industry-party view we
  // keep granularity as 'aggregate'.
  const granularityNeedsOfficial = granularity === 'top-pacs' || granularity === 'by-bracket';
  const granularityDisabled = !granularitySupported
    || (granularityNeedsOfficial && focusOfficialCount === 0);

  return (
    <>
      <LabeledSelect
        label="Data"
        value={validDataMode}
        options={dataModeOptions}
        onChange={v => set('dataMode', v)}
      />
      <LabeledSelect
        label="Group by"
        value={granularity}
        options={[
          { value: 'aggregate',  label: 'Aggregate (sectors)' },
          {
            value: 'top-pacs',
            label: 'Top PACs (by sector)',
            disabled: !granularitySupported || focusOfficialCount === 0,
            disabledReason: !granularitySupported
              ? 'Only for industry data modes'
              : 'Focus an official',
          },
          {
            value: 'by-bracket',
            label: 'By donor size',
            disabled: !granularitySupported || focusOfficialCount === 0,
            disabledReason: !granularitySupported
              ? 'Only for industry data modes'
              : 'Focus an official',
          },
        ]}
        onChange={v => set('granularity', v)}
        disabledReason={granularityDisabled && !granularitySupported ? 'Not applicable to this data mode' : undefined}
      />
      {granularity === 'top-pacs' && granularitySupported && (
        <>
          <div className="flex items-center gap-2 px-3 py-1">
            <span className="text-[10px] text-ink-soft w-20 shrink-0">Top N</span>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={opts?.topPacsLimit ?? 12}
              aria-label="Top N PACs"
              onChange={e => set('topPacsLimit', parseInt(e.target.value, 10))}
              className="flex-1 h-1 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            />
            <span className="text-[10px] text-ink-soft w-10 text-right tabular-nums">
              {opts?.topPacsLimit ?? 12}
            </span>
          </div>
          <div className="px-3 pb-1 text-[9px] text-ink-soft italic leading-tight">
            Total PAC arcs (combined across focused officials)
          </div>
        </>
      )}
      <LabeledToggle
        label="Normalize"
        value={opts?.normalizeMode ?? false}
        onChange={v => set('normalizeMode', v)}
      />
      <LabeledToggle
        label="Show labels"
        value={opts?.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
      <ChordMinFlowControl
        value={opts?.minFlowUsd ?? 0}
        onChange={v => set('minFlowUsd', v)}
      />
    </>
  );
}

// ── Chord min-flow log-scale control ──────────────────────────────────────────
//
// Twelve discrete stops covering the donation range users care about — from
// FEC itemization threshold ($200) through mega-donor territory ($10M).
// Mirrors the DonationFloorControl pattern but with finer mid-band steps so
// users can suppress noise at any of: small, mid, major, mega.
const CHORD_MIN_FLOW_STOPS = [
  0, 200, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
] as const;

function chordFlowToStop(dollars: number): number {
  let idx = 0;
  for (let i = 0; i < CHORD_MIN_FLOW_STOPS.length; i++) {
    if (dollars >= CHORD_MIN_FLOW_STOPS[i]!) idx = i;
  }
  return idx;
}

function chordFormatDollars(d: number): string {
  if (d === 0)        return '$0';
  if (d < 1_000)      return `$${d}`;
  if (d < 1_000_000)  return `$${(d / 1_000).toFixed(d % 1_000 === 0 ? 0 : 1)}K`;
  return `$${(d / 1_000_000).toFixed(d % 1_000_000 === 0 ? 0 : 1)}M`;
}

function ChordMinFlowControl({ value, onChange }: {
  value: number;
  onChange: (v: number) => void;
}) {
  const stop = chordFlowToStop(value);
  const dollars = CHORD_MIN_FLOW_STOPS[stop]!;
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] text-ink-soft w-20 shrink-0">Min flow</span>
        <input
          type="range"
          min={0}
          max={CHORD_MIN_FLOW_STOPS.length - 1}
          step={1}
          value={stop}
          aria-label="Minimum flow"
          onChange={e => {
            const next = parseInt(e.target.value, 10);
            const safe = Math.max(0, Math.min(CHORD_MIN_FLOW_STOPS.length - 1, next));
            onChange(CHORD_MIN_FLOW_STOPS[safe]!);
          }}
          className="flex-1 h-1 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        />
        <span className="text-[10px] text-ink-soft w-12 text-right tabular-nums">
          {chordFormatDollars(dollars)}
        </span>
      </div>
      <div className="px-3 pb-1 text-[9px] text-ink-soft italic leading-tight">
        {dollars === 0
          ? 'Showing all flows'
          : `Hiding flows below ${chordFormatDollars(dollars)}`}
      </div>
    </>
  );
}

// ── Treemap settings ───────────────────────────────────────────────────────────

function TreemapSettings({ view, hooks, graphMeta }: { view: GraphView; hooks: UseGraphViewReturn; graphMeta?: GraphMeta }) {
  const opts = view.style.vizOptions.treemap;
  function set(key: string, value: unknown) { hooks.setVizOption('treemap', key, value); }

  // Auto-default to PAC sector view when a PAC group is focused
  const defaultDataMode = (graphMeta?.isPacFocus ?? false) ? 'pac_sector' : 'officials';
  const dataMode = opts?.dataMode ?? defaultDataMode;
  const isPacMode = dataMode === 'pac_sector' || dataMode === 'pac_party';

  // FIX-186: Compare mode is only meaningful when 2+ official entities are
  // focused. Count them off view.focus.entities so the toggle disables
  // gracefully when the user has fewer entities focused.
  const officialEntityCount = view.focus.entities.filter(
    (e) => e.type === 'official',
  ).length;
  const compareModeEligible = officialEntityCount >= 2;

  // FIX-130: don't filter — disable. Show every size encoding; mark the ones
  // that lack backing data as disabled with a per-option reason.
  const voteCount     = voteCountFrom(graphMeta);
  const donationCount = donationCountFrom(graphMeta);
  const hasDonations  = graphMeta?.hasDonations ?? true;
  const hasVotes      = graphMeta?.hasVotes     ?? true;

  const sizeByOptions: LabeledOption[] = [
    {
      value: 'donation_total',
      label: donationCount > 0 ? `Donations (${donationCount})` : 'Donations',
      disabled: !hasDonations,
      disabledReason: 'No donation data in graph',
    },
    { value: 'connection_count', label: 'Connections' },
    {
      value: 'vote_count',
      label: voteCount > 0 ? `Votes cast (${voteCount})` : 'Votes cast',
      disabled: !hasVotes,
      disabledReason: 'No vote data in graph',
    },
  ];

  const sizeBy = opts?.sizeBy ?? 'donation_total';
  const sizeByDisabled = sizeByOptions.find(o => o.value === sizeBy)?.disabled ?? false;
  const validSizeBy = sizeByDisabled
    ? (sizeByOptions.find(o => !o.disabled)?.value ?? 'connection_count')
    : sizeBy;

  return (
    <>
      <LabeledSelect
        label="Data"
        value={dataMode}
        options={[
          { value: 'officials',  label: 'Officials'      },
          { value: 'pac_sector', label: 'PACs by Sector' },
          { value: 'pac_party',  label: 'PACs by Party'  },
        ]}
        onChange={v => set('dataMode', v)}
      />
      {/* FIX-812 — donation floor moved to the Connections tab filter group;
          the treemap still reads view.connections.donation.minAmount. */}
      {!isPacMode && (
        <>
          <LabeledSelect
            label="Group by"
            value={opts?.groupBy ?? 'party'}
            options={[
              { value: 'party',   label: 'Party'   },
              { value: 'state',   label: 'State'   },
              { value: 'chamber', label: 'Chamber' },
            ]}
            onChange={v => set('groupBy', v)}
          />
          <LabeledSelect
            label="Size by"
            value={validSizeBy}
            options={sizeByOptions}
            onChange={v => set('sizeBy', v)}
          />
          <LabeledSelect
            label="Size scale"
            value={opts?.sizeScale ?? 'log'}
            options={[
              { value: 'log',    label: 'Log (all visible)' },
              { value: 'linear', label: 'Linear (true ratios)' },
            ]}
            onChange={v => set('sizeScale', v)}
          />
          <LabeledToggle
            label="Compare mode"
            value={!!opts?.compareMode}
            onChange={v => set('compareMode', v)}
            disabledReason={
              compareModeEligible
                ? undefined
                : 'Focus 2+ officials to compare donor bases'
            }
          />
          <LabeledSelect
            label="Color by"
            value={opts?.colorBy ?? 'party'}
            options={[
              { value: 'party',   label: 'Party'   },
              { value: 'chamber', label: 'Chamber' },
            ]}
            onChange={v => set('colorBy', v)}
          />
        </>
      )}
    </>
  );
}

// ── Sunburst settings ──────────────────────────────────────────────────────────

function SunburstSettings({
  view, hooks, graphMeta,
}: {
  view: GraphView;
  hooks: UseGraphViewReturn;
  graphMeta?: GraphMeta;
}) {
  const opts = view.style.vizOptions.sunburst;
  function set(key: string, value: unknown) { hooks.setVizOption('sunburst', key, value); }

  // FIX-130: don't filter — disable. Build the full ring1 option list and
  // mark each entry that lacks backing data as disabled with a per-option
  // reason; defaults stay valid by falling back when the current pick gets
  // disabled mid-session.
  const voteCount     = voteCountFrom(graphMeta);
  const donationCount = donationCountFrom(graphMeta);
  const hasDonations  = graphMeta?.hasDonations ?? true;
  const hasVotes      = graphMeta?.hasVotes     ?? true;
  const isPacFocus    = graphMeta?.isPacFocus   ?? false;

  const ring1Options: LabeledOption[] = [
    { value: 'connection_types', label: 'All connections' },
    {
      value: 'donation_industries',
      label: donationCount > 0 ? `Donor industries (${donationCount})` : 'Donor industries',
      disabled: !hasDonations,
      disabledReason: 'No donation data in graph',
    },
    {
      value: 'vote_categories',
      label: voteCount > 0 ? `Vote record (${voteCount})` : 'Vote record',
      // PAC groups don't vote — disable rather than hide so the option stays discoverable.
      disabled: isPacFocus || !hasVotes,
      disabledReason: isPacFocus ? 'PACs do not vote' : 'No vote data in graph',
    },
  ];

  const ring1 = opts?.ring1 ?? 'connection_types';
  const ring1Disabled = ring1Options.find(o => o.value === ring1)?.disabled ?? false;
  const validRing1 = ring1Disabled
    ? (ring1Options.find(o => !o.disabled)?.value ?? 'connection_types')
    : ring1;

  return (
    <>
      <LabeledSelect
        label="Ring 1"
        value={validRing1}
        options={ring1Options}
        onChange={v => set('ring1', v)}
      />
      <LabeledSelect
        label="Ring 2"
        value={opts?.ring2 ?? 'top_entities'}
        options={[
          { value: 'top_entities', label: 'Top entities' },
          { value: 'by_amount',    label: 'By $ amount'  },
          { value: 'by_count',     label: 'By count'     },
        ]}
        onChange={v => set('ring2', v)}
      />
      <LabeledSelect
        label="Max items"
        value={String(opts?.maxRing1 ?? 8)}
        options={[
          { value: '5',  label: '5'  },
          { value: '8',  label: '8'  },
          { value: '12', label: '12' },
        ]}
        onChange={v => set('maxRing1', parseInt(v))}
      />
      <LabeledToggle
        label="Labels"
        value={(opts?.showLabels ?? 'auto') !== 'never'}
        onChange={v => set('showLabels', v ? 'auto' : 'never')}
      />
      <LabeledSelect
        label="Shape"
        value={opts?.shape ?? 'circle'}
        options={[
          { value: 'circle',  label: '○ Circle'  },
          { value: 'octagon', label: '⬡ Octagon' },
        ]}
        onChange={v => set('shape', v)}
      />
    </>
  );
}

// ── Hierarchy settings ─────────────────────────────────────────────────────────

function HierarchySettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.hierarchy;
  function set(key: string, value: unknown) { hooks.setVizOption('hierarchy', key, value); }

  return (
    <>
      <LabeledSelect
        label="Orientation"
        value={opts?.orientation ?? 'horizontal'}
        options={[
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical',   label: 'Vertical'   },
        ]}
        onChange={v => set('orientation', v)}
      />
      <LabeledSelect
        label="Node size"
        value={opts?.nodeSizeBy ?? 'budget'}
        options={[
          { value: 'budget',    label: 'Budget' },
          { value: 'employees', label: 'Awards' },
          { value: 'uniform',   label: 'Uniform' },
        ]}
        onChange={v => set('nodeSizeBy', v)}
      />
      <LabeledSelect
        label="Collapse at"
        value={String(opts?.collapseDepth ?? 2)}
        options={[
          { value: '1', label: 'Depth 1' },
          { value: '2', label: 'Depth 2' },
          { value: '3', label: 'Depth 3' },
          { value: '4', label: 'Depth 4' },
          { value: '99', label: 'Show all' },
        ]}
        onChange={v => set('collapseDepth', parseInt(v))}
      />
      <LabeledToggle
        label="Labels"
        value={opts?.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
    </>
  );
}

// ── Choropleth settings (FIX-855) ───────────────────────────────────────────────
// choropleth/scatter/gantt previously had NO settings entry. The band control is
// meaningful (congressional / SLD / state geography); the measure is honest about
// what the route actually computes — party CONTROL (Dem↔Rep lean), the only
// measure the voting-divergence route currently produces.

function ChoroplethSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.choropleth;
  function set(key: string, value: unknown) { hooks.setVizOption('choropleth', key, value); }

  return (
    <>
      <LabeledSelect
        label="District band"
        value={opts?.bandLevel ?? 'congressional'}
        options={[
          { value: 'congressional', label: 'U.S. House districts' },
          { value: 'sld_u',         label: 'State upper chamber' },
          { value: 'sld_l',         label: 'State lower chamber' },
          { value: 'state',         label: 'States' },
        ]}
        onChange={v => set('bandLevel', v)}
      />
      <LabeledSelect
        label="Measure"
        value={opts?.measure ?? 'party_cohesion'}
        options={[
          { value: 'party_cohesion', label: 'Party control (Dem ↔ Rep)' },
        ]}
        onChange={v => set('measure', v)}
      />
    </>
  );
}

// ── Matrix settings ────────────────────────────────────────────────────────────

function MatrixSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.matrix;
  function set(key: string, value: unknown) { hooks.setVizOption('matrix', key, value); }

  return (
    <>
      <LabeledSelect
        label="Sort"
        value={opts?.sortBy ?? 'party'}
        options={[
          { value: 'party',        label: 'By party'     },
          { value: 'alphabetical', label: 'Alphabetical' },
          { value: 'cluster',      label: 'By cluster'   },
        ]}
        onChange={v => set('sortBy', v)}
      />
      <LabeledSelect
        label="Metric"
        value={opts?.metric ?? 'agreement'}
        options={[
          { value: 'agreement', label: 'Agreement %'   },
          { value: 'kappa',     label: "Cohen's kappa" },
        ]}
        onChange={v => set('metric', v)}
      />
    </>
  );
}

// ── Alignment settings ─────────────────────────────────────────────────────────

function AlignmentSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.alignment;
  function set(key: string, value: unknown) { hooks.setVizOption('alignment', key, value); }

  return (
    <>
      <LabeledSelect
        label="Sort"
        value={opts?.sortBy ?? 'alignment'}
        options={[
          { value: 'alignment', label: 'By alignment %' },
          { value: 'party',     label: 'By party'       },
          { value: 'role',      label: 'By role'        },
          { value: 'name',      label: 'Alphabetical'   },
        ]}
        onChange={v => set('sortBy', v)}
      />
      <LabeledSelect
        label="Bar fill"
        value={opts?.fillMode ?? 'ratio'}
        options={[
          { value: 'ratio',    label: 'Party color' },
          { value: 'gradient', label: 'Heat gradient' },
        ]}
        onChange={v => set('fillMode', v)}
      />
      <LabeledToggle
        label="Labels"
        value={opts?.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
    </>
  );
}

// ── Spending settings ──────────────────────────────────────────────────────────

function SpendingSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.spending;
  function set(key: string, value: unknown) { hooks.setVizOption('spending', key, value); }

  return (
    <>
      <LabeledSelect
        label="Top agencies"
        value={String(opts?.topAgencies ?? 8)}
        options={[
          { value: '5',  label: 'Top 5'  },
          { value: '8',  label: 'Top 8'  },
          { value: '12', label: 'Top 12' },
          { value: '20', label: 'Top 20' },
        ]}
        onChange={v => set('topAgencies', parseInt(v))}
      />
      <LabeledSelect
        label="Top recipients"
        value={String(opts?.topRecipients ?? 20)}
        options={[
          { value: '10', label: 'Top 10' },
          { value: '20', label: 'Top 20' },
          { value: '50', label: 'Top 50' },
          { value: '100', label: 'Top 100' },
        ]}
        onChange={v => set('topRecipients', parseInt(v))}
      />
      <LabeledSelect
        label="Min flow"
        value={String(opts?.minFlowUsd ?? 0)}
        options={[
          { value: '0',         label: 'No min'  },
          { value: '1000000',   label: '$1M+'    },
          { value: '10000000',  label: '$10M+'   },
          { value: '100000000', label: '$100M+'  },
          { value: '1000000000', label: '$1B+'   },
        ]}
        onChange={v => set('minFlowUsd', parseInt(v))}
      />
      <LabeledToggle
        label="Sector breakdown"
        value={opts?.showSectors ?? true}
        onChange={v => set('showSectors', v)}
      />
    </>
  );
}

// ── Sankey settings ────────────────────────────────────────────────────────────

function SankeySettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.sankey;
  function set(key: string, value: unknown) { hooks.setVizOption('sankey', key, value); }

  return (
    <>
      <LabeledSelect
        label="Tiers"
        value={String(opts?.levels ?? 4)}
        options={[
          { value: '2', label: 'Treasury → Agency' },
          { value: '3', label: '+ Sector' },
          { value: '4', label: '+ Vendor' },
        ]}
        onChange={v => set('levels', parseInt(v))}
      />
      <LabeledSelect
        label="Top per tier"
        value={String(opts?.topN ?? 12)}
        options={[
          { value: '6',  label: 'Top 6'  },
          { value: '12', label: 'Top 12' },
          { value: '20', label: 'Top 20' },
          { value: '50', label: 'Top 50' },
          { value: '0',  label: 'No cap' },
        ]}
        onChange={v => set('topN', parseInt(v))}
      />
      <LabeledSelect
        label="Min flow"
        value={String(opts?.minFlowUsd ?? 0)}
        options={[
          { value: '0',          label: 'No min'      },
          { value: '100000',     label: '$100K+'      },
          { value: '1000000',    label: '$1M+'        },
          { value: '10000000',   label: '$10M+'       },
          { value: '100000000',  label: '$100M+'      },
        ]}
        onChange={v => set('minFlowUsd', parseInt(v))}
      />
      <LabeledToggle
        label="Labels"
        value={opts?.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
    </>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function GraphConfigPanel({
  view,
  hooks,
  collapsed,
  onCollapse,
  onSavePreset,
  graphMeta,
  userNodeVisible = false,
  width = RIGHT_PANEL_DEFAULT_WIDTH,
  asDrawer = false,
}: GraphConfigPanelProps) {
  const vizType       = view.style.vizType;
  const activePreset  = view.meta?.presetId ?? null;

  // FIX-812 — View | Connections tab. Persists per session; read after mount
  // (localStorage during render would mismatch the SSR'd markup).
  const [tab, setTab] = useState<ConfigTab>('view');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      if (saved === 'connections') setTab('connections');
    } catch { /* localStorage unavailable */ }
  }, []);
  function switchTab(next: ConfigTab) {
    setTab(next);
    try { localStorage.setItem(TAB_STORAGE_KEY, next); } catch { /* ignore */ }
  }

  // FIX-817 — user-saved views (localStorage civitics_presets). Read after
  // mount (SSR has no localStorage) and re-read on the change event fired by
  // saveView/deleteSavedView so the list stays in sync with the header's
  // Save-view action and this panel's own deletes.
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  useEffect(() => {
    const refresh = () => setSavedViews(listSavedViews());
    refresh();
    window.addEventListener(SAVED_VIEWS_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SAVED_VIEWS_CHANGE_EVENT, refresh);
  }, []);

  // FIX-134: each collapsed-strip icon sets a pending scroll target before
  // calling onCollapse. When the panel becomes expanded the effect below
  // scrolls the matching section into view, then clears the target.
  const [targetSection, setTargetSection] = useState<ConfigSection | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (collapsed || !targetSection || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(`[data-section="${targetSection}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setTargetSection(null);
  }, [collapsed, targetSection, tab]);

  function jumpTo(section: ConfigSection) {
    switchTab('view');
    setTargetSection(section);
    if (collapsed) onCollapse();
  }

  function jumpToConnections() {
    switchTab('connections');
    if (collapsed) onCollapse();
  }

  // FIX-216 — Two-bucket preset filtering. Keep the hard data-availability
  // hides (no point showing "Follow the Money" when there are zero donations)
  // and layer entity-type applicability on top:
  //   - Native    : preset matches the focused entity type natively
  //   - Adapted   : preset has a dataModeByEntity override for this focus
  //   - Hidden    : viz mismatch or unsuitable for this focus
  // The two visible buckets are rendered as separate sections so the user
  // can see when a preset has been auto-rewritten for their focus.
  const dataApplicable = (p: typeof BUILT_IN_PRESETS[number]): boolean => {
    if (p.meta.presetId === 'follow-the-money' && graphMeta && !graphMeta.hasDonations) return false;
    if (p.meta.presetId === 'votes-and-bills'   && graphMeta && !graphMeta.hasVotes) return false;
    if (p.meta.presetId === 'industry-capture'  && graphMeta && !graphMeta.hasDonations) return false;
    if (p.meta.presetId === 'co-sponsor-network' && graphMeta && !('co_sponsorship' in graphMeta.connectionTypes)) return false;
    return true;
  };
  const partitionedPresets = BUILT_IN_PRESETS.reduce(
    (acc, p) => {
      if (p.style.vizType !== vizType && (p.style.vizType as string) !== 'any') return acc;
      if (!dataApplicable(p)) return acc;
      const app = isPresetApplicableToView(p, view);
      if (app === 'native')   acc.native.push(p);
      else if (app === 'adapted') acc.adapted.push(p);
      // 'inapplicable' / 'hidden' — drop
      return acc;
    },
    { native: [] as typeof BUILT_IN_PRESETS, adapted: [] as typeof BUILT_IN_PRESETS },
  );

  // Label the Adapted bucket with the focused entity name, when present.
  const focusHead = view.focus.entities[0];
  const adaptedFocusName = focusHead && isFocusEntity(focusHead) ? focusHead.name : focusHead?.name;
  const adaptedLabel = adaptedFocusName ? `Adapted for ${adaptedFocusName}` : 'Adapted';

  // FIX-812 — global default depth (was the left panel OPTIONS section).
  // UI offers 1|2 only — the server clamps at 2; legacy depth-3 saves read as 2.
  const globalDepth = view.focus.depth >= 2 ? 2 : 1;

  // Collapsed: 40px icon strip — FIX-134: each icon expands and scrolls to its
  // section (View tab); the 🔗 icon opens the Connections tab (FIX-812).
  if (collapsed && !asDrawer) {
    return (
      <div className="h-full w-10 flex flex-col items-center py-2 gap-3 border-l border-rule bg-card shrink-0">
        <button
          type="button"
          title="Open Visualization section"
          aria-label="Open graph config — visualization"
          onClick={() => jumpTo('viz')}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true">⬡</span>
        </button>
        <button
          type="button"
          title="Open Presets section"
          aria-label="Open graph config — presets"
          onClick={() => jumpTo('presets')}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true">📋</span>
        </button>
        <button
          type="button"
          title="Open Settings section"
          aria-label="Open graph config — settings"
          onClick={() => jumpTo('settings')}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true">⚙</span>
        </button>
        <button
          type="button"
          title="Open Connections tab"
          aria-label="Open graph config — connections"
          onClick={jumpToConnections}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true">🔗</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={
        asDrawer
          ? 'h-full w-full flex flex-col bg-card overflow-hidden min-w-0'
          : 'h-full flex flex-col border-l border-rule bg-card overflow-hidden shrink-0 min-w-0'
      }
      style={asDrawer ? undefined : { width }}
    >

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-rule/60 shrink-0">
        <span className="text-[10px] font-semibold text-ink-soft uppercase tracking-wide">
          View
        </span>
        <button
          type="button"
          onClick={onCollapse}
          title={asDrawer ? 'Close panel' : 'Collapse panel  (] shortcut)'}
          aria-label={asDrawer ? 'Close view panel' : 'Collapse view panel'}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-ink/10 transition-colors text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Tab bar (FIX-812) */}
      <div role="tablist" aria-label="Graph view configuration" className="flex shrink-0 border-b border-rule/60">
        {([['view', 'View'], ['connections', 'Connections']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => switchTab(id)}
            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              tab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Scrollable body */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain">

        {tab === 'view' && (
          <>
            {/* Visualization picker — FIX-129: split by applicability against current focus + data. */}
            <div data-section="viz">
            <TreeSection label="Visualization" separator={false} defaultExpanded>
              {(() => {
                const partitioned = STD_VIZ.map(v => ({
                  v,
                  app: getVizApplicability(v, view.focus, view.connections, graphMeta),
                }));
                const available    = partitioned.filter(p =>  p.app.applicable);
                const inapplicable = partitioned.filter(p => !p.app.applicable);
                // FIX-856 — split applicable viz by scope so Focus and Platform
                // views are visibly separated (mirrors the header dropdown).
                const focusAvail    = available.filter(p => p.v.scope !== 'platform');
                const platformAvail = available.filter(p => p.v.scope === 'platform');
                return (
                  <>
                    {focusAvail.length > 0 && (
                      <TreeSection label="Focus views" separator={false} defaultExpanded depth={1}>
                        {focusAvail.map(({ v }) => (
                          <TreeNode
                            key={v.id}
                            label={v.label}
                            variant="item"
                            collapsible={false}
                            active={vizType === v.id}
                            separator={false}
                            depth={2}
                            icon={undefined}
                            onClick={() => hooks.setVizType(v.id as VizType)}
                          >
                            {null}
                          </TreeNode>
                        ))}
                      </TreeSection>
                    )}
                    {platformAvail.length > 0 && (
                      <TreeSection label="Platform views" separator={false} defaultExpanded depth={1}>
                        {platformAvail.map(({ v }) => (
                          <TreeNode
                            key={v.id}
                            label={v.label}
                            variant="item"
                            collapsible={false}
                            active={vizType === v.id}
                            separator={false}
                            depth={2}
                            icon={undefined}
                            onClick={() => hooks.setVizType(v.id as VizType)}
                          >
                            {null}
                          </TreeNode>
                        ))}
                      </TreeSection>
                    )}
                    {inapplicable.length > 0 && (
                      <TreeSection
                        label="Not yet applicable"
                        count={inapplicable.length}
                        defaultExpanded={false}
                        separator={false}
                        depth={1}
                      >
                        {inapplicable.map(({ v, app }) => {
                          const reason = app.applicable ? '' : app.reason;
                          return (
                            <div
                              key={v.id}
                              title={reason}
                              className="flex flex-col px-3 py-2 text-xs text-ink-soft/60 cursor-not-allowed"
                              style={{ paddingLeft: '32px' }}
                            >
                              <span>{v.label}</span>
                              <span className="text-[10px] text-ink-soft/60 leading-tight truncate">
                                {reason}
                              </span>
                            </div>
                          );
                        })}
                      </TreeSection>
                    )}
                  </>
                );
              })()}
              {COMING_VIZ.length > 0 && (
                <TreeSection label="Coming Soon" defaultExpanded={false} separator={false} depth={1}>
                  {COMING_VIZ.map(v => (
                    <TreeNode
                      key={v.id}
                      label={v.label}
                      variant="item"
                      collapsible={false}
                      separator={false}
                      depth={2}
                      onClick={() => {}}
                    >
                      {null}
                    </TreeNode>
                  ))}
                </TreeSection>
              )}
            </TreeSection>
            </div>

            {/* Presets — Native + Adapted buckets (FIX-216) */}
            <div data-section="presets">
            <TreeSection label="Presets" defaultExpanded separator>
              {partitionedPresets.native.length === 0 && partitionedPresets.adapted.length === 0 && (
                <div className="px-3 py-2 text-xs text-ink-soft">
                  No presets for this visualization
                </div>
              )}

              {partitionedPresets.native.map(preset => (
                <TreeNode
                  key={preset.meta.presetId}
                  label={preset.meta.name}
                  variant="item"
                  collapsible={false}
                  active={activePreset === preset.meta.presetId}
                  separator={false}
                  depth={1}
                  icon={PRESET_EMOJI[preset.meta.presetId] ?? '📋'}
                  onClick={() => hooks.applyPreset(preset)}
                >
                  {null}
                </TreeNode>
              ))}

              {partitionedPresets.adapted.length > 0 && (
                <TreeSection
                  label={adaptedLabel}
                  count={partitionedPresets.adapted.length}
                  defaultExpanded
                  separator={partitionedPresets.native.length > 0}
                  depth={1}
                >
                  {partitionedPresets.adapted.map(preset => (
                    <TreeNode
                      key={preset.meta.presetId}
                      label={preset.meta.name}
                      variant="item"
                      collapsible={false}
                      active={activePreset === preset.meta.presetId}
                      separator={false}
                      depth={2}
                      icon={PRESET_EMOJI[preset.meta.presetId] ?? '📋'}
                      onClick={() => hooks.applyPreset(preset)}
                    >
                      {null}
                    </TreeNode>
                  ))}
                </TreeSection>
              )}

              {/* FIX-817 — user-saved views, restorable + deletable. Not
                  viz-filtered: restoring a saved view switches to its own viz.
                  A saved view is a full snapshot, so restoreSavedView replaces
                  the entire state (its focus entities included), unlike the
                  built-in applyPreset which preserves the current focus. */}
              {savedViews.length > 0 && (
                <TreeSection
                  label="Saved views"
                  count={savedViews.length}
                  defaultExpanded
                  separator={partitionedPresets.native.length > 0 || partitionedPresets.adapted.length > 0}
                  depth={1}
                >
                  {savedViews.map(sv => (
                    <TreeNode
                      key={sv.meta.presetId}
                      label={sv.meta.name}
                      variant="item"
                      collapsible={false}
                      active={activePreset === sv.meta.presetId}
                      separator={false}
                      depth={2}
                      icon="🔖"
                      onClick={() => hooks.restoreSavedView(sv)}
                      actions={[{
                        icon: '🗑',
                        label: `Delete "${sv.meta.name}"`,
                        onClick: () => setSavedViews(deleteSavedView(sv.meta.presetId)),
                      }]}
                    >
                      {null}
                    </TreeNode>
                  ))}
                </TreeSection>
              )}

              <div className="h-px bg-rule mx-2 my-1" />

              <TreeNode
                label="Save view…"
                variant="item"
                collapsible={false}
                separator={false}
                depth={1}
                icon="💾"
                onClick={onSavePreset}
              >
                {null}
              </TreeNode>
            </TreeSection>
            </div>

            {/* Type-specific settings */}
            <div data-section="settings">
            <TreeSection
              label={
                <span className="flex items-center gap-2">
                  <span>Settings</span>
                  <span className="text-[10px] text-accent font-medium capitalize">{vizType}</span>
                </span>
              }
              separator
            >
              {/* FIX-812 — global default depth (viz-agnostic; from the dissolved
                  left-panel OPTIONS section). Per-entity chips override it. */}
              <LabeledSelect
                label="Default depth"
                value={String(globalDepth)}
                options={[
                  { value: '1', label: '1 — direct connections' },
                  { value: '2', label: '2 — two hops' },
                ]}
                onChange={v => hooks.setDepth(parseInt(v, 10) as 1 | 2)}
              />
              {vizType === 'force'     && <ForceSettings     view={view} hooks={hooks} graphMeta={graphMeta} />}
              {vizType === 'chord'     && <ChordSettings     view={view} hooks={hooks} graphMeta={graphMeta} />}
              {vizType === 'treemap'   && <TreemapSettings   view={view} hooks={hooks} graphMeta={graphMeta} />}
              {vizType === 'sunburst'  && <SunburstSettings  view={view} hooks={hooks} graphMeta={graphMeta} />}
              {vizType === 'hierarchy' && <HierarchySettings view={view} hooks={hooks} />}
              {vizType === 'matrix'    && <MatrixSettings    view={view} hooks={hooks} />}
              {vizType === 'alignment' && <AlignmentSettings view={view} hooks={hooks} />}
              {vizType === 'sankey'    && <SankeySettings    view={view} hooks={hooks} />}
              {vizType === 'spending'  && <SpendingSettings  view={view} hooks={hooks} />}
              {vizType === 'choropleth' && <ChoroplethSettings view={view} hooks={hooks} />}
            </TreeSection>
            </div>
          </>
        )}

        {tab === 'connections' && (
          <>
            {/* Per-type styling rows — moved from the left panel (FIX-812) */}
            <ConnectionsTree
              connections={view.connections}
              vizType={vizType}
              hooks={hooks}
              graphMeta={graphMeta}
              focus={view.focus}
              userNodeVisible={userNodeVisible}
              includeProcedural={view.focus.includeProcedural}
            />

            {/* Edge filters — these three moved out of the View settings
                because they filter edges, so they live with edges (FIX-812). */}
            <TreeSection label="Filters" defaultExpanded separator>
              <DonationFloorControl view={view} hooks={hooks} />
              <LabeledSlider
                label="Min strength"
                min={0} max={0.9} step={0.1}
                value={view.style.vizOptions.force?.strengthFilter ?? 0}
                onChange={v => hooks.setVizOption('force', 'strengthFilter', v)}
              />
              <div className="px-3 pb-0.5 text-[9px] text-ink-soft italic leading-tight">
                {(() => {
                  const v = view.style.vizOptions.force?.strengthFilter ?? 0;
                  if (v === 0)       return 'Showing all connections';
                  if (v < 0.3)       return 'Hiding connections under ~$10K';
                  if (v < 0.5)       return 'Showing $10K+ connections';
                  if (v < 0.7)       return 'Showing $100K+ connections';
                  return 'Showing $500K+ connections';
                })()}
              </div>
              <div className="px-3 pt-2 pb-0.5 text-[9px] font-semibold text-ink-soft uppercase tracking-wide">Individual Donors</div>
              <div className="px-3 pb-1 space-y-1">
                {(['bracket', 'connector', 'employer', 'off'] as IndividualDisplayMode[]).map(mode => (
                  <label key={mode} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="indivDisplayMode"
                      value={mode}
                      checked={(view.style.vizOptions.force?.individualDisplayMode ?? 'bracket') === mode}
                      onChange={() => hooks.setVizOption('force', 'individualDisplayMode', mode)}
                      className="accent-accent cursor-pointer"
                    />
                    <span className="text-[10px] text-ink">
                      {mode === 'bracket'   && 'Bracket (default)'}
                      {mode === 'connector' && 'Connector (2+ officials)'}
                      {mode === 'employer'  && 'By Employer'}
                      {mode === 'off'       && 'All (raw)'}
                    </span>
                  </label>
                ))}
              </div>
              {(view.style.vizOptions.force?.individualDisplayMode ?? 'bracket') === 'connector' && (
                <div className="flex items-center gap-2 px-3 py-1">
                  <span className="text-[10px] text-ink-soft w-20 shrink-0">Min officials</span>
                  <input
                    type="number"
                    min={2}
                    max={10}
                    value={view.style.vizOptions.force?.connectorMinRecipients ?? 2}
                    onChange={e => hooks.setVizOption('force', 'connectorMinRecipients', Math.max(2, Math.min(10, parseInt(e.target.value) || 2)))}
                    className="w-14 text-xs text-ink border border-rule rounded px-1.5 py-0.5 bg-card focus:outline-none focus:border-accent"
                  />
                </div>
              )}
            </TreeSection>
          </>
        )}

      </div>

      {/* Footer — available from both tabs (FIX-812: "Save view…") */}
      <div className="border-t border-rule/60 px-3 py-2 shrink-0">
        <button
          onClick={onSavePreset}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-lg bg-accent/10 hover:bg-accent/20 text-accent transition-colors border border-accent/30"
        >
          <span>💾</span>
          <span>Save view…</span>
        </button>
      </div>
    </div>
  );
}
