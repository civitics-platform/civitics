"use client";

/**
 * packages/graph/src/components/StyleSection.tsx
 *
 * Layer 3 settings: dynamic content based on the active viz type.
 * Controls GraphView.style.vizOptions[activeVizType].
 *
 * Never contains viz-specific if/else outside of the clearly delineated
 * per-viz blocks below. When a new viz is added, add one block here.
 */

import type { GraphView, VizType, ForceOptions, ChordOptions, TreemapOptions, SunburstOptions } from '../types';

export interface StyleSectionProps {
  view: GraphView;
  onVizOptionChange: (vizType: VizType, key: string, value: unknown) => void;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
      {children}
    </p>
  );
}

function RadioGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      {options.map(opt => (
        <label key={opt.value} className="flex items-center gap-2 cursor-pointer select-none">
          <button
            onClick={() => onChange(opt.value)}
            className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
              value === opt.value ? 'border-indigo-500' : 'border-gray-300'
            }`}
          >
            {value === opt.value && (
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            )}
          </button>
          <span className="text-[11px] text-gray-700">{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-20 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-indigo-500 cursor-pointer"
        style={{ height: '3px' }}
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="accent-indigo-500 w-3.5 h-3.5 cursor-pointer"
      />
      <span className="text-xs text-gray-700">{label}</span>
    </label>
  );
}

// ── Force options ──────────────────────────────────────────────────────────────

const FORCE_LAYOUTS = [
  { value: 'force_directed', label: 'Force directed' },
  { value: 'radial',         label: 'Radial' },
  { value: 'hierarchical',   label: 'Hierarchical' },
  { value: 'circular',       label: 'Circular' },
] as const;

const NODE_SIZE_OPTIONS = [
  { value: 'connection_count', label: 'Connection count' },
  { value: 'donation_total',   label: 'Donation total' },
  { value: 'votes_cast',       label: 'Votes cast' },
  { value: 'uniform',          label: 'Uniform' },
] as const;

const LABEL_OPTIONS = [
  { value: 'always', label: 'Always' },
  { value: 'hover',  label: 'On hover' },
  { value: 'never',  label: 'Never' },
] as const;

type LabelMode = 'always' | 'hover' | 'never';

function ForceStyleSection({
  opts,
  set,
}: {
  opts: Partial<ForceOptions> & Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <FieldLabel>Layout</FieldLabel>
        <RadioGroup
          options={FORCE_LAYOUTS}
          value={opts.layout}
          onChange={v => set('layout', v)}
        />
      </div>

      <div>
        <FieldLabel>Node Size By</FieldLabel>
        <RadioGroup
          options={NODE_SIZE_OPTIONS}
          value={opts.nodeSizeEncoding}
          onChange={v => set('nodeSizeEncoding', v)}
        />
      </div>

      <div>
        <FieldLabel>Labels</FieldLabel>
        <RadioGroup
          options={LABEL_OPTIONS}
          value={(opts.labels as LabelMode | undefined)}
          onChange={v => set('labels', v)}
        />
      </div>

      <div>
        <FieldLabel>Physics</FieldLabel>
        <div className="space-y-2">
          <Slider
            label="Charge"
            value={(opts.charge as number | undefined) ?? 0.5}
            onChange={v => set('charge', v)}
          />
          <Slider
            label="Link dist"
            value={(opts.linkDistance as number | undefined) ?? 0.5}
            onChange={v => set('linkDistance', v)}
          />
          <Slider
            label="Gravity"
            value={(opts.gravity as number | undefined) ?? 0.5}
            onChange={v => set('gravity', v)}
          />
        </div>
      </div>
    </div>
  );
}

// ── Chord options ──────────────────────────────────────────────────────────────

function ChordStyleSection({
  opts,
  set,
}: {
  opts: Partial<ChordOptions> & Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-3">
      <Toggle
        label="Show labels"
        checked={opts.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
      <Toggle
        label="Show % of total (normalize)"
        checked={opts.normalizeMode ?? false}
        onChange={v => set('normalizeMode', v)}
      />
      <div>
        <p className="text-[10px] text-gray-500 mb-1">Min flow $</p>
        <input
          type="number"
          min="0"
          step="1000"
          value={(opts.minFlow as number | undefined) ?? 0}
          onChange={e => set('minFlow', parseInt(e.target.value, 10) || 0)}
          className="w-full bg-white border border-gray-200 rounded px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:border-indigo-400"
        />
      </div>
    </div>
  );
}

// ── Treemap options ────────────────────────────────────────────────────────────

const TREEMAP_GROUP_BY = [
  { value: 'party',    label: 'Party → State → Official' },
  { value: 'state',    label: 'State → Official' },
  { value: 'industry', label: 'Flat' },
] as const;

const TREEMAP_COLOR_BY = [
  { value: 'party',  label: 'Party (default)' },
  { value: 'amount', label: 'Amount intensity' },
] as const;

type TreemapColorBy = 'party' | 'amount';

function TreemapStyleSection({
  opts,
  set,
}: {
  opts: Partial<TreemapOptions> & Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <FieldLabel>Group By</FieldLabel>
        <RadioGroup
          options={TREEMAP_GROUP_BY}
          value={opts.groupBy}
          onChange={v => set('groupBy', v)}
        />
      </div>
      <div>
        <FieldLabel>Color By</FieldLabel>
        <RadioGroup
          options={TREEMAP_COLOR_BY}
          value={(opts.colorBy as TreemapColorBy | undefined)}
          onChange={v => set('colorBy', v)}
        />
      </div>
    </div>
  );
}

// ── Sunburst options ───────────────────────────────────────────────────────────

function SunburstStyleSection({
  opts,
  set,
}: {
  opts: Partial<SunburstOptions> & Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-3">
      <Toggle
        label="Animate zoom"
        checked={(opts.animateZoom as boolean | undefined) ?? true}
        onChange={v => set('animateZoom', v)}
      />
      <Toggle
        label="Show breadcrumb"
        checked={opts.showLabels ?? true}
        onChange={v => set('showLabels', v)}
      />
    </div>
  );
}

// ── StyleSection ───────────────────────────────────────────────────────────────

export function StyleSection({ view, onVizOptionChange }: StyleSectionProps) {
  const vizType = view.style.vizType;

  if (vizType === 'force') {
    const opts = (view.style.vizOptions.force ?? {}) as Partial<ForceOptions> & Record<string, unknown>;
    return (
      <ForceStyleSection
        opts={opts}
        set={(key, value) => onVizOptionChange('force', key, value)}
      />
    );
  }

  if (vizType === 'chord') {
    const opts = (view.style.vizOptions.chord ?? {}) as Partial<ChordOptions> & Record<string, unknown>;
    return (
      <ChordStyleSection
        opts={opts}
        set={(key, value) => onVizOptionChange('chord', key, value)}
      />
    );
  }

  if (vizType === 'treemap') {
    const opts = (view.style.vizOptions.treemap ?? {}) as Partial<TreemapOptions> & Record<string, unknown>;
    return (
      <TreemapStyleSection
        opts={opts}
        set={(key, value) => onVizOptionChange('treemap', key, value)}
      />
    );
  }

  if (vizType === 'sunburst') {
    const opts = (view.style.vizOptions.sunburst ?? {}) as Partial<SunburstOptions> & Record<string, unknown>;
    return (
      <SunburstStyleSection
        opts={opts}
        set={(key, value) => onVizOptionChange('sunburst', key, value)}
      />
    );
  }

  return null;
}
