"use client";

/**
 * packages/graph/src/components/ConnectionsSection.tsx
 *
 * Layer 2 settings: one row per connection type from CONNECTION_TYPE_REGISTRY.
 * Never hardcodes type strings — always reads from the registry.
 *
 * Grouped into:
 *   Votes:  vote_yes, vote_no, vote_abstain, nomination_vote_yes, nomination_vote_no
 *   Other:  donation, oversight, co_sponsorship
 *
 * Only shows types supported by the active viz's supportedConnectionTypes.
 */

import { useState } from 'react';
import type { GraphView, VizType } from '../types';
import { CONNECTION_TYPE_REGISTRY } from '../connections';
import { VIZ_REGISTRY } from '../visualizations/registry';

export interface ConnectionsSectionProps {
  vizType: VizType;
  connections: GraphView['connections'];
  onToggle: (type: string) => void;
  onColorChange: (type: string, color: string) => void;
  onOpacityChange: (type: string, opacity: number) => void;
  onThicknessChange: (type: string, thickness: number) => void;
  onMinAmountChange: (type: string, min: number) => void;
}

// Order within each group matters — reflects display order.
const VOTE_GROUP = ['vote_yes', 'vote_no', 'vote_abstain', 'nomination_vote_yes', 'nomination_vote_no'];

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-0.5 mt-2 first:mt-0">
      {children}
    </p>
  );
}

export function ConnectionsSection({
  vizType,
  connections,
  onToggle,
  onColorChange,
  onOpacityChange,
  onThicknessChange,
  onMinAmountChange,
}: ConnectionsSectionProps) {
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Resolve which types this viz supports
  const vizDef   = VIZ_REGISTRY.find(v => v.id === vizType);
  const supported = new Set(vizDef?.supportedConnectionTypes ?? Object.keys(CONNECTION_TYPE_REGISTRY));

  const voteTypes  = VOTE_GROUP.filter(k => supported.has(k) && k in CONNECTION_TYPE_REGISTRY);
  const otherTypes = Object.keys(CONNECTION_TYPE_REGISTRY).filter(
    k => !VOTE_GROUP.includes(k) && supported.has(k)
  );

  // If only donation is supported, show a hint about the limitation
  const donationOnly = supported.size === 1 && supported.has('donation');

  function renderRow(typeKey: string) {
    const def   = CONNECTION_TYPE_REGISTRY[typeKey];
    if (!def) return null;

    const state    = connections[typeKey];
    const isExpanded = expandedType === typeKey;

    return (
      <div key={typeKey}>
        {/* Main row */}
        <div className="flex items-center gap-1.5 py-1.5 px-1 rounded-md hover:bg-gray-50 group">

          {/* Checkbox */}
          <button
            onClick={() => onToggle(typeKey)}
            className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              state?.enabled
                ? 'border-indigo-500 bg-indigo-500'
                : 'border-gray-300 bg-white hover:border-gray-400'
            }`}
            aria-label={`Toggle ${def.label}`}
          >
            {state?.enabled && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>

          {/* Color dot (reflects current color setting) */}
          <span
            className="w-2 h-2 rounded-full shrink-0 border border-white shadow-sm"
            style={{ backgroundColor: state?.color ?? def.color }}
          />

          {/* Icon + label — click to expand */}
          <button
            onClick={() => setExpandedType(isExpanded ? null : typeKey)}
            className="text-[11px] text-gray-700 flex-1 text-left truncate"
          >
            {def.icon} {def.label}
          </button>

          {/* Expand chevron */}
          <button
            onClick={() => setExpandedType(isExpanded ? null : typeKey)}
            className="shrink-0 p-0.5"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <svg
              className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Expanded controls */}
        {isExpanded && (
          <div className="ml-6 mr-1 mb-2 mt-0.5 space-y-2 bg-gray-50 rounded-lg px-2.5 py-2.5 border border-gray-100">

            {/* Color picker */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-14 shrink-0">Color</span>
              <input
                type="color"
                value={state?.color ?? def.color}
                onChange={e => onColorChange(typeKey, e.target.value)}
                className="w-6 h-6 rounded border border-gray-200 cursor-pointer bg-transparent p-0"
              />
              <span className="text-[10px] text-gray-400 font-mono">{state?.color ?? def.color}</span>
            </div>

            {/* Opacity slider */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-14 shrink-0">Opacity</span>
              <input
                type="range" min="0" max="1" step="0.05"
                value={state?.opacity ?? 0.7}
                onChange={e => onOpacityChange(typeKey, parseFloat(e.target.value))}
                className="flex-1 accent-indigo-500 cursor-pointer"
                style={{ height: '3px' }}
              />
              <span className="text-[10px] text-gray-400 w-7 text-right font-mono">
                {Math.round((state?.opacity ?? 0.7) * 100)}%
              </span>
            </div>

            {/* Thickness slider */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-14 shrink-0">Thickness</span>
              <input
                type="range" min="0" max="1" step="0.05"
                value={state?.thickness ?? 0.5}
                onChange={e => onThicknessChange(typeKey, parseFloat(e.target.value))}
                className="flex-1 accent-indigo-500 cursor-pointer"
                style={{ height: '3px' }}
              />
              <span className="text-[10px] text-gray-400 w-7 text-right font-mono">
                {Math.round((state?.thickness ?? 0.5) * 100)}%
              </span>
            </div>

            {/* Min amount (donation types only) */}
            {def.hasAmount && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-14 shrink-0">Min $</span>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={state?.minAmount ?? 0}
                  onChange={e => onMinAmountChange(typeKey, parseInt(e.target.value, 10) || 0)}
                  className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-[11px] text-gray-700 focus:outline-none focus:border-indigo-400"
                />
              </div>
            )}

          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {donationOnly && (
        <p className="text-[10px] text-gray-500 mb-2 px-1 leading-relaxed">
          Switch to Force Graph to filter vote connections
        </p>
      )}

      {voteTypes.length > 0 && (
        <div>
          <GroupLabel>Votes</GroupLabel>
          {voteTypes.map(renderRow)}
        </div>
      )}

      {otherTypes.length > 0 && (
        <div>
          <GroupLabel>Other</GroupLabel>
          {otherTypes.map(renderRow)}
        </div>
      )}
    </div>
  );
}
