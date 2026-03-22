"use client";

/**
 * packages/graph/src/components/FocusSection.tsx
 *
 * Layer 1 settings: entity display, depth (1/2/3), scope filter,
 * procedural votes toggle, compare mode toggle, path finder.
 */

import { useState } from 'react';
import type { GraphView } from '../types';
import { PathFinder } from '../PathFinder';

export interface FocusSectionProps {
  focus: GraphView['focus'];
  onDepthChange: (depth: 1 | 2 | 3) => void;
  onScopeChange: (scope: GraphView['focus']['scope']) => void;
  onProceduralToggle: () => void;
  /** Compare mode state (lifted to GraphPage) */
  compareMode?: boolean;
  onCompareModeChange?: (v: boolean) => void;
  compareEntityName?: string | null;
}

const SCOPE_OPTIONS: { value: GraphView['focus']['scope']; label: string }[] = [
  { value: 'all',     label: 'All levels'   },
  { value: 'federal', label: 'Federal only' },
  { value: 'senate',  label: 'Senate only'  },
  { value: 'house',   label: 'House only'   },
  { value: 'state',   label: 'State only'   },
];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
      {children}
    </p>
  );
}

export function FocusSection({
  focus,
  onDepthChange,
  onScopeChange,
  onProceduralToggle,
  compareMode   = false,
  onCompareModeChange,
  compareEntityName,
}: FocusSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">

      {/* Entity display */}
      <div>
        <FieldLabel>Entity</FieldLabel>
        {focus.entities[0] ? (
          <div className="flex items-center gap-2 px-2.5 py-2 bg-indigo-50 rounded-lg border border-indigo-100">
            <div className="w-7 h-7 rounded-full bg-indigo-200 flex items-center justify-center text-[10px] font-bold text-indigo-700 shrink-0">
              {(focus.entities[0].name ?? '?').charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-medium text-indigo-800 truncate flex-1">
              {focus.entities[0].name}
            </span>
          </div>
        ) : (
          <div className="px-2.5 py-2 rounded-lg bg-gray-50 border border-gray-200">
            <p className="text-xs text-gray-500">No entity selected</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Use search above to focus</p>
          </div>
        )}
      </div>

      {/* Depth selector */}
      <div>
        <FieldLabel>Connection Depth</FieldLabel>
        <div className="flex rounded-md overflow-hidden border border-gray-200">
          {([1, 2, 3] as const).map(d => (
            <button
              key={d}
              onClick={() => onDepthChange(d)}
              title={d === 1 ? 'Direct connections only' : 'May load slowly for highly connected entities'}
              className={`flex-1 py-1.5 text-xs font-medium transition-colors border-r border-gray-200 last:border-r-0 ${
                focus.depth === d
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {focus.depth >= 2 && (
          <p className="text-[10px] text-amber-600 mt-1">
            May load slowly for highly connected entities
          </p>
        )}
      </div>

      {/* Scope filter */}
      <div>
        <FieldLabel>Show Officials From</FieldLabel>
        <select
          value={focus.scope}
          onChange={e => onScopeChange(e.target.value as GraphView['focus']['scope'])}
          className="w-full bg-white border border-gray-200 rounded-md text-xs text-gray-700 px-2.5 py-1.5 focus:outline-none focus:border-indigo-400 transition-colors"
        >
          {SCOPE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Procedural votes toggle */}
      <div>
        <button
          onClick={onProceduralToggle}
          className="flex items-center gap-2.5 w-full text-left cursor-pointer"
        >
          <div
            className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
              focus.includeProcedural ? 'bg-indigo-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform duration-200 ${
                focus.includeProcedural ? 'translate-x-4' : ''
              }`}
            />
          </div>
          <span className="text-xs text-gray-700">Include procedural votes</span>
        </button>
        <p className="text-[10px] text-gray-400 mt-1 pl-[42px]">
          Cloture motions, passage votes — hidden by default
        </p>
      </div>

      {/* Compare mode toggle */}
      {onCompareModeChange && (
        <div>
          <button
            onClick={() => onCompareModeChange(!compareMode)}
            className="flex items-center gap-2.5 w-full text-left cursor-pointer"
          >
            <div
              className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                compareMode ? 'bg-indigo-500' : 'bg-gray-300'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform duration-200 ${
                  compareMode ? 'translate-x-4' : ''
                }`}
              />
            </div>
            <span className="text-xs text-gray-700">Compare mode</span>
          </button>
          {compareMode && (
            <p className="text-[10px] text-gray-400 mt-1 pl-[42px]">
              {compareEntityName
                ? `Comparing with ${compareEntityName}`
                : 'Search above to select a second entity'}
            </p>
          )}
        </div>
      )}

      {/* Advanced — Path Finder */}
      <div className="border-t border-gray-100 pt-3">
        <button
          onClick={() => setAdvancedOpen(v => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            Advanced
          </span>
          <svg
            className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${advancedOpen ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {advancedOpen && (
          <div className="mt-2">
            <PathFinder />
          </div>
        )}
      </div>

    </div>
  );
}
