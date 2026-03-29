"use client";

/**
 * packages/graph/src/components/GraphConfigPanel.tsx
 *
 * Right panel — 220px wide, full height, collapsed by default to 40px icon strip.
 * Hosts: viz type picker, presets, type-specific settings, display options.
 *
 * Keyboard shortcut: ] toggles right panel (managed by GraphPage)
 */

import type { GraphView, VizType } from '../types';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import { VIZ_REGISTRY } from '../visualizations/registry';
import { BUILT_IN_PRESETS } from '../presets';
import { TreeNode, TreeSection } from './TreeNode';

export interface GraphConfigPanelProps {
  view: GraphView;
  hooks: UseGraphViewReturn;
  collapsed: boolean;
  onCollapse: () => void;
  onSavePreset: () => void;
}

// Emoji for each preset
const PRESET_EMOJI: Record<string, string> = {
  'follow-the-money': '💰',
  'votes-and-bills':  '🗳',
  'nominations':      '⭐',
  'committee-power':  '👁',
  'full-record':      '📋',
  'clean-view':       '✨',
};

// Standard viz types from registry
const STD_VIZ   = VIZ_REGISTRY.filter(v => v.group === 'standard');
const COMING_VIZ = VIZ_REGISTRY.filter(v => v.group === 'coming_soon');

// ── Sliders ────────────────────────────────────────────────────────────────────

function LabeledSlider({
  label, min, max, step, value, onChange,
}: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className="text-[10px] text-gray-500 w-20 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 accent-indigo-500"
      />
    </div>
  );
}

function LabeledSelect({
  label, value, options, onChange,
}: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className="text-[10px] text-gray-500 w-20 shrink-0">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-indigo-400"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function LabeledToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-[10px] text-gray-500">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`w-7 h-4 rounded-full transition-colors relative ${value ? 'bg-indigo-500' : 'bg-gray-200'}`}
      >
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

// ── Force settings ─────────────────────────────────────────────────────────────

function ForceSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.force;
  function set(key: string, value: unknown) { hooks.setVizOption('force', key, value); }

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
        value={opts?.nodeSizeEncoding ?? 'connection_count'}
        options={[
          { value: 'connection_count', label: 'Connections'   },
          { value: 'donation_total',   label: 'Donations'     },
          { value: 'bills_sponsored',  label: 'Bills'         },
          { value: 'years_in_office',  label: 'Seniority'     },
          { value: 'uniform',          label: 'Uniform'       },
        ]}
        onChange={v => set('nodeSizeEncoding', v)}
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
      <LabeledSlider label="Edge opacity" min={0} max={1} step={0.05} value={opts?.edgeOpacity ?? 0.7} onChange={v => set('edgeOpacity', v)} />
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
      <div className="px-3 pt-1 pb-0.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Physics</div>
      <LabeledSlider label="Charge" min={-1000} max={-50} step={50} value={opts?.charge ?? -300} onChange={v => set('charge', v)} />
      <LabeledSlider label="Link dist" min={50} max={500} step={10} value={opts?.linkDistance ?? 150} onChange={v => set('linkDistance', v)} />
      <LabeledSlider label="Gravity" min={0} max={1} step={0.05} value={opts?.gravity ?? 0.1} onChange={v => set('gravity', v)} />
    </>
  );
}

// ── Chord settings ─────────────────────────────────────────────────────────────

function ChordSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.chord;
  function set(key: string, value: unknown) { hooks.setVizOption('chord', key, value); }

  return (
    <>
      <LabeledToggle label="Normalize" value={opts?.normalizeMode ?? false} onChange={v => set('normalizeMode', v)} />
      <LabeledToggle label="Show labels" value={opts?.showLabels ?? true} onChange={v => set('showLabels', v)} />
      <LabeledSelect
        label="Min flow"
        value={String(opts?.minFlowUsd ?? 0)}
        options={[
          { value: '0',        label: 'Show all' },
          { value: '100000',   label: '$100K+'   },
          { value: '1000000',  label: '$1M+'     },
          { value: '10000000', label: '$10M+'    },
        ]}
        onChange={v => set('minFlowUsd', parseInt(v))}
      />
    </>
  );
}

// ── Treemap settings ───────────────────────────────────────────────────────────

function TreemapSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.treemap;
  function set(key: string, value: unknown) { hooks.setVizOption('treemap', key, value); }

  return (
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
        value={opts?.sizeBy ?? 'donation_total'}
        options={[
          { value: 'donation_total',   label: 'Donations'   },
          { value: 'connection_count', label: 'Connections' },
          { value: 'vote_count',       label: 'Votes cast'  },
        ]}
        onChange={v => set('sizeBy', v)}
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
  );
}

// ── Sunburst settings ──────────────────────────────────────────────────────────

function SunburstSettings({ view, hooks }: { view: GraphView; hooks: UseGraphViewReturn }) {
  const opts = view.style.vizOptions.sunburst;
  function set(key: string, value: unknown) { hooks.setVizOption('sunburst', key, value); }

  return (
    <>
      <LabeledToggle label="Animate" value={true} onChange={_v => set('animate', _v)} />
      <LabeledToggle label="Breadcrumb" value={opts?.showLabels ?? true} onChange={v => set('showLabels', v)} />
    </>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function GraphConfigPanel({ view, hooks, collapsed, onCollapse, onSavePreset }: GraphConfigPanelProps) {
  const vizType       = view.style.vizType;
  const activePreset  = view.meta?.presetId ?? null;
  const isDirty       = view.meta?.isDirty  ?? false;

  // Only show presets that match the active viz type (or 'any' which works everywhere)
  const relevantPresets = BUILT_IN_PRESETS.filter(
    p => p.style.vizType === vizType || (p.style.vizType as string) === 'any'
  );

  // Collapsed: 40px icon strip
  if (collapsed) {
    return (
      <div className="h-full w-10 flex flex-col items-center py-2 gap-3 border-l border-gray-200 bg-white shrink-0">
        <button
          title="Graph Config — Visualization"
          onClick={onCollapse}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-sm"
        >
          ⬡
        </button>
        <button
          title="Graph Config — Settings"
          onClick={onCollapse}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-sm"
        >
          ⚙
        </button>
      </div>
    );
  }

  // Expanded: 220px panel
  return (
    <div className="h-full w-[220px] flex flex-col border-l border-gray-200 bg-white overflow-hidden shrink-0">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
          Graph Config
        </span>
        <button
          onClick={onCollapse}
          title="Collapse panel  (] shortcut)"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-contain">

        {/* Visualization picker */}
        <TreeSection label="Visualization" separator={false} defaultExpanded>
          {STD_VIZ.map(v => (
            <TreeNode
              key={v.id}
              label={v.label}
              variant="item"
              collapsible={false}
              active={vizType === v.id}
              separator={false}
              depth={1}
              icon={vizType === v.id ? '✓' : undefined}
              onClick={() => hooks.setVizType(v.id as VizType)}
            >
              {null}
            </TreeNode>
          ))}
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

        {/* Presets — filtered to active viz type */}
        <TreeSection label="Presets" defaultExpanded separator>
          {relevantPresets.length > 0
            ? relevantPresets.map(preset => (
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
              ))
            : (
                <div className="px-3 py-2 text-xs text-gray-400">
                  No presets for this visualization
                </div>
              )
          }

          <div className="h-px bg-gray-100 mx-2 my-1" />

          <TreeNode
            label="Save current…"
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

        {/* Type-specific settings */}
        <TreeSection label="Settings" separator>
          {vizType === 'force'   && <ForceSettings   view={view} hooks={hooks} />}
          {vizType === 'chord'   && <ChordSettings   view={view} hooks={hooks} />}
          {vizType === 'treemap' && <TreemapSettings  view={view} hooks={hooks} />}
          {vizType === 'sunburst'&& <SunburstSettings view={view} hooks={hooks} />}
        </TreeSection>

        {/* Display section removed — per-viz settings now live inside each viz's Settings section */}

      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-3 py-2 shrink-0">
        <button
          onClick={onSavePreset}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition-colors border border-indigo-100"
        >
          <span>💾</span>
          <span>{isDirty ? 'Save changes' : 'Save preset'}</span>
        </button>
      </div>
    </div>
  );
}
