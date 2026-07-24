"use client";

/**
 * packages/graph/src/components/ConnectionStyleRow.tsx
 *
 * One expandable row per connection type in ConnectionsTree.
 * Collapsed: checkbox + dot + label + expand arrow
 * Expanded:  color swatch, opacity slider, thickness slider, optional minAmount
 */

import { useState } from 'react';
import type { GraphView } from '../types';
import type { ConnectionTypeDefinition } from '../types';
import { TreeNode } from './TreeNode';
import { toHexColor } from '../tokens';
import { Icon, hasIcon } from '../icons';

export type ConnectionTypeSettings = GraphView['connections'][string];

export interface ConnectionStyleRowProps {
  type: string;
  def: ConnectionTypeDefinition;
  settings: ConnectionTypeSettings;
  onChange: (type: string, settings: ConnectionTypeSettings) => void;
  count?: number;
}

export function ConnectionStyleRow({ type, def, settings, onChange, count }: ConnectionStyleRowProps) {
  const [open, setOpen] = useState(false);

  function set<K extends keyof ConnectionTypeSettings>(key: K, value: ConnectionTypeSettings[K]) {
    onChange(type, { ...settings, [key]: value });
  }

  return (
    <div className="border-b border-rule/40 last:border-0">
      {/* Collapsed header */}
      <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-ink/5 cursor-pointer" onClick={() => setOpen(o => !o)}>
        {/* Enable/disable checkbox */}
        <button
          title={settings.enabled ? 'Disable' : 'Enable'}
          onClick={e => { e.stopPropagation(); set('enabled', !settings.enabled); }}
          className="w-4 h-4 shrink-0 flex items-center justify-center rounded border border-rule hover:border-accent transition-colors text-[10px]"
          style={{ backgroundColor: settings.enabled ? settings.color : 'transparent' }}
        >
          {settings.enabled && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {/* Color dot */}
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: settings.color }} />

        {/* Icon + label — pictographic types carry a registry key (lucide glyph);
            typographic keeps (✓ ✗ ○ ≈) render as text (FIX-730). */}
        {hasIcon(def.icon) ? (
          <Icon name={def.icon} className="w-3.5 h-3.5 shrink-0 text-ink-soft" strokeWidth={2} />
        ) : (
          <span className="text-xs shrink-0 w-3.5 text-center">{def.icon}</span>
        )}
        <span className="flex-1 text-xs text-ink truncate">{def.label}</span>

        {/* Count badge */}
        {count != null && count > 0 && (
          <span className="text-[9px] text-ink-soft/60 shrink-0">{count}</span>
        )}

        {/* Expand arrow */}
        <svg
          className={`w-3 h-3 text-ink-soft/60 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded controls */}
      {open && (
        <div className="px-3 pb-2.5 space-y-2 bg-ink/5">

          {/* Color */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-soft w-16 shrink-0">Color</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <div
                className="w-5 h-5 rounded border border-rule cursor-pointer"
                style={{ backgroundColor: settings.color }}
              />
              <input
                type="color"
                // color inputs reject rgb(var(--c-x)) token strings — resolve
                // to concrete hex (FIX-729). User picks write back plain hex.
                value={toHexColor(settings.color)}
                onChange={e => set('color', e.target.value)}
                className="sr-only"
              />
            </label>
          </div>

          {/* Opacity */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-soft w-16 shrink-0">Opacity</span>
            <input
              type="range"
              min={0} max={1} step={0.05}
              value={settings.opacity}
              onChange={e => set('opacity', parseFloat(e.target.value))}
              className="flex-1 h-1"
              style={{ accentColor: 'rgb(var(--c-accent))' }}
            />
            <span className="text-[10px] text-ink-soft/60 w-7 text-right">{Math.round(settings.opacity * 100)}%</span>
          </div>

          {/* Thickness */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-soft w-16 shrink-0">Thickness</span>
            <input
              type="range"
              min={0} max={1} step={0.05}
              value={settings.thickness}
              onChange={e => set('thickness', parseFloat(e.target.value))}
              className="flex-1 h-1"
              style={{ accentColor: 'rgb(var(--c-accent))' }}
            />
            <span className="text-[10px] text-ink-soft/60 w-7 text-right">{Math.round(settings.thickness * 100)}%</span>
          </div>

          {/* Min amount (donations only) */}
          {def.hasAmount && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-ink-soft w-16 shrink-0">Min $</span>
              <input
                type="number"
                min={0}
                step={1000}
                value={settings.minAmount ?? 0}
                onChange={e => set('minAmount', parseFloat(e.target.value) || 0)}
                className="flex-1 px-1.5 py-0.5 text-xs border border-rule rounded bg-card focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Server-side fetch cap (FIX-802) — registry-driven; donation renders
              "Top donors: 10/25/50/100". Changing it triggers a re-fetch. */}
          {def.fetchLimitControl && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-ink-soft w-16 shrink-0">{def.fetchLimitControl.label}</span>
              <select
                value={settings.fetchLimit ?? def.fetchLimitControl.defaultValue}
                onChange={e => set('fetchLimit', parseInt(e.target.value, 10))}
                className="flex-1 px-1.5 py-0.5 text-xs border border-rule rounded bg-card focus:outline-none focus:border-accent"
              >
                {def.fetchLimitControl.options.map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
