"use client";

/**
 * packages/graph/src/components/SettingsPanel.tsx
 *
 * Collapsed pill (bottom-left of canvas) → expanded 280px panel.
 * Hosts: preset pills row + 3 collapsible sections (Focus, Connections, Style).
 *
 * COLLAPSED: small pill "[⚙ Settings]" — click to expand
 * EXPANDED:  280px wide, max 80vh tall, scrollable, floating
 *
 * Stage 1: fixed position. Draggable in Stage 2.
 */

import { useState } from 'react';
import type { GraphViewPreset } from '../types';
import { BUILT_IN_PRESETS } from '../presets';
import type { UseGraphViewReturn } from '../hooks/useGraphView';
import { FocusSection } from './FocusSection';
import { ConnectionsSection } from './ConnectionsSection';
import { StyleSection } from './StyleSection';

export interface SettingsPanelProps {
  hooks: UseGraphViewReturn;
  onSavePreset?: () => void;
  onShare: () => void;
  /** Compare mode — lifted state from GraphPage */
  compareMode?: boolean;
  onCompareModeChange?: (v: boolean) => void;
  compareEntityName?: string | null;
}

// Display config for the built-in preset pills
const PRESET_DISPLAY: Record<string, { emoji: string; label: string }> = {
  'follow-the-money': { emoji: '💰', label: 'Follow the Money' },
  'votes-and-bills':  { emoji: '🗳',  label: 'Votes & Bills'   },
  'nominations':      { emoji: '⭐', label: 'Nominations'      },
  'committee-power':  { emoji: '👁',  label: 'Committee Power' },
  'full-record':      { emoji: '📋', label: 'Full Record'      },
  'clean-view':       { emoji: '✨', label: 'Clean View'       },
};

const GEAR_ICON = (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

function SectionHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-2.5 px-1 text-left hover:bg-gray-50 rounded-md transition-colors"
    >
      <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">{label}</span>
      <svg
        className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

export function SettingsPanel({ hooks, onSavePreset, onShare, compareMode, onCompareModeChange, compareEntityName }: SettingsPanelProps) {
  const { view } = hooks;

  const [expanded,         setExpanded]         = useState(false);
  const [focusOpen,        setFocusOpen]        = useState(true);
  const [connectionsOpen,  setConnectionsOpen]  = useState(false);
  const [styleOpen,        setStyleOpen]        = useState(false);

  const activePresetId = view.meta?.presetId ?? null;
  const isDirty        = view.meta?.isDirty   ?? false;

  // Save current view as a new local preset
  function handleSaveAsPreset() {
    if (typeof window === 'undefined') return;
    const name = window.prompt('Name this preset:');
    if (!name?.trim()) return;
    try {
      const existing = JSON.parse(
        localStorage.getItem('civitics_presets') ?? '[]'
      ) as GraphViewPreset[];
      const newPreset: GraphViewPreset = {
        ...view,
        meta: {
          name:     name.trim(),
          isPreset: true,
          presetId: `user-${Date.now()}`,
          isDirty:  false,
        },
      };
      localStorage.setItem('civitics_presets', JSON.stringify([...existing, newPreset]));
      onSavePreset?.();
    } catch {
      // localStorage unavailable — silently ignore
    }
  }

  const saveLabel  = isDirty && view.meta?.isPreset ? 'Save changes' : 'Save as preset';
  const saveAction = isDirty && view.meta?.isPreset
    ? (onSavePreset ?? handleSaveAsPreset)
    : handleSaveAsPreset;

  return (
    <div className="absolute bottom-4 left-4 z-40">

      {/* ── Collapsed pill ─────────────────────────────────────────────────── */}
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 pl-2.5 pr-3 py-2 bg-white border border-gray-200 rounded-full shadow-md text-xs font-medium text-gray-700 hover:bg-gray-50 hover:shadow-lg transition-all"
        >
          {GEAR_ICON}
          <span>Settings</span>
          {isDirty && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-0.5" title="Unsaved changes" />
          )}
        </button>

      ) : (

        /* ── Expanded panel ──────────────────────────────────────────────── */
        <div
          className="w-[280px] bg-white border border-gray-200 rounded-xl shadow-xl flex flex-col overflow-hidden"
          style={{ maxHeight: '80vh' }}
        >

          {/* Panel header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-1.5">
              {GEAR_ICON}
              <span className="text-xs font-semibold text-gray-700">Settings</span>
              {isDirty && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
              )}
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 text-base leading-none"
              aria-label="Minimize settings"
            >
              −
            </button>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 overscroll-contain">

            {/* Preset pills */}
            <div className="px-3 pt-3 pb-2.5 border-b border-gray-100">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Presets
              </p>
              <div className="flex flex-wrap gap-1.5">
                {BUILT_IN_PRESETS.map(preset => {
                  const display  = PRESET_DISPLAY[preset.meta.presetId];
                  if (!display) return null;
                  const isActive = activePresetId === preset.meta.presetId;
                  return (
                    <button
                      key={preset.meta.presetId}
                      onClick={() => hooks.applyPreset(preset)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium transition-colors border ${
                        isActive
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'
                      }`}
                    >
                      <span>{display.emoji}</span>
                      <span>{display.label}</span>
                      {isActive && isDirty && (
                        <span className="w-1 h-1 rounded-full bg-white/80 ml-0.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── FOCUS section ── */}
            <div className="px-3 border-b border-gray-100">
              <SectionHeader
                label="Focus"
                open={focusOpen}
                onToggle={() => setFocusOpen(v => !v)}
              />
              {focusOpen && (
                <div className="pb-3">
                  <FocusSection
                    focus={view.focus}
                    onDepthChange={hooks.setDepth}
                    onScopeChange={hooks.setScope}
                    onProceduralToggle={hooks.toggleIncludeProcedural}
                    compareMode={compareMode}
                    onCompareModeChange={onCompareModeChange}
                    compareEntityName={compareEntityName}
                  />
                </div>
              )}
            </div>

            {/* ── CONNECTIONS section ── */}
            <div className="px-3 border-b border-gray-100">
              <SectionHeader
                label="Connections"
                open={connectionsOpen}
                onToggle={() => setConnectionsOpen(v => !v)}
              />
              {connectionsOpen && (
                <div className="pb-3">
                  <ConnectionsSection
                    vizType={view.style.vizType}
                    connections={view.connections}
                    onToggle={hooks.toggleConnection}
                    onColorChange={hooks.setConnectionColor}
                    onOpacityChange={hooks.setConnectionOpacity}
                    onThicknessChange={hooks.setConnectionThickness}
                    onMinAmountChange={hooks.setConnectionMinAmount}
                  />
                </div>
              )}
            </div>

            {/* ── STYLE section ── */}
            <div className="px-3">
              <SectionHeader
                label="Style"
                open={styleOpen}
                onToggle={() => setStyleOpen(v => !v)}
              />
              {styleOpen && (
                <div className="pb-3">
                  <StyleSection
                    view={view}
                    onVizOptionChange={hooks.setVizOption}
                  />
                </div>
              )}
            </div>

          </div>

          {/* Footer */}
          <div className="px-3 py-2.5 border-t border-gray-100 flex gap-2 shrink-0">
            <button
              onClick={saveAction}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition-colors border border-indigo-100"
            >
              <span>💾</span>
              <span>{saveLabel}</span>
            </button>
            <button
              onClick={onShare}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-gray-50 hover:bg-gray-100 text-gray-700 transition-colors border border-gray-200"
            >
              <span>↗</span>
              <span>Share</span>
            </button>
          </div>

        </div>
      )}
    </div>
  );
}
