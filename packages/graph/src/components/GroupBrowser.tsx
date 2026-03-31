"use client";

/**
 * GroupBrowser
 *
 * Replaces EntityBrowse.
 * Shows premade groups by category
 * and a custom filter builder.
 * Groups are queries not lists —
 * adding a group stores a filter,
 * not individual entity IDs.
 */

import { useState } from 'react';
import {
  BUILT_IN_GROUPS,
  GROUP_CATEGORIES,
  createCustomGroup,
} from '../groups';
import type { FocusGroup, GroupFilter } from '../types';
import { TreeSection } from './TreeNode';

export interface GroupBrowserProps {
  onAddGroup: (group: FocusGroup) => void;
  /** IDs of groups already in focus so we can show them as active */
  activeGroupIds?: string[];
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO',
  'CT','DE','FL','GA','HI','ID',
  'IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS',
  'MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN',
  'TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
];

export function GroupBrowser({
  onAddGroup,
  activeGroupIds = [],
}: GroupBrowserProps) {

  // Build lookup map for quick access by ID
  const groupMap = new Map(BUILT_IN_GROUPS.map(g => [g.id, g]));

  // Custom filter state
  const [customType, setCustomType] = useState<'official' | 'pac'>('official');
  const [customChamber, setCustomChamber] = useState<string>('');
  const [customParty, setCustomParty] = useState<string>('');
  const [customState, setCustomState] = useState<string>('');
  const [customIndustry, setCustomIndustry] = useState<string>('');

  // Build the custom filter from current state
  function buildCustomFilter(): GroupFilter {
    const filter: GroupFilter = { entity_type: customType };
    if (customChamber) filter.chamber = customChamber as 'senate' | 'house';
    if (customParty) filter.party = customParty;
    if (customState) filter.state = customState;
    if (customType === 'pac' && customIndustry) filter.industry = customIndustry;
    return filter;
  }

  // Generate preview name for custom group button
  function customGroupName(): string {
    const parts: string[] = [];
    if (customState) parts.push(customState);
    if (customParty) parts.push(customParty.charAt(0).toUpperCase() + customParty.slice(1));
    if (customChamber) parts.push(customChamber.charAt(0).toUpperCase() + customChamber.slice(1));
    if (customType === 'pac' && customIndustry) parts.push(customIndustry + ' PACs');
    else parts.push('Officials');
    return parts.join(' ') || 'All Officials';
  }

  return (
    <div className="pb-2">

      {/* ── Premade groups by category ───────────── */}
      {Object.entries(GROUP_CATEGORIES).map(([category, ids]) => (
        <TreeSection
          key={category}
          label={category}
          defaultExpanded={true}
          separator={false}
          depth={1}
        >
          {ids.map(id => {
            const group = groupMap.get(id);
            if (!group) return null;
            const isActive = activeGroupIds.includes(id);

            return (
              <div
                key={id}
                className="flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 group/row"
              >
                {/* Icon + name */}
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm shrink-0">{group.icon}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate">
                      {group.name}
                    </div>
                    {group.description && (
                      <div className="text-[10px] text-gray-400 truncate">
                        {group.description}
                      </div>
                    )}
                  </div>
                </div>

                {/* Add button */}
                <button
                  onClick={() => onAddGroup(group)}
                  disabled={isActive}
                  title={isActive ? 'Already in focus' : `Add ${group.name} to focus`}
                  className={`shrink-0 ml-2 w-5 h-5 rounded text-xs font-bold transition-colors flex items-center justify-center ${
                    isActive
                      ? 'bg-indigo-100 text-indigo-400 cursor-default'
                      : 'bg-gray-100 text-gray-500 hover:bg-indigo-600 hover:text-white group-hover/row:bg-indigo-50 group-hover/row:text-indigo-600'
                  }`}
                >
                  {isActive ? '✓' : '+'}
                </button>
              </div>
            );
          })}
        </TreeSection>
      ))}

      {/* ── By State section ───────────── */}
      <TreeSection
        label="By State"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        <div className="px-3 py-2">
          <select
            className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 focus:outline-none focus:border-indigo-400"
            defaultValue=""
            onChange={e => {
              const state = e.target.value;
              if (!state) return;
              const group = createCustomGroup(
                { entity_type: 'official', state },
                `${state} Delegation`
              );
              onAddGroup(group);
              e.target.value = '';
            }}
          >
            <option value="" disabled>Select a state...</option>
            {US_STATES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-400 mt-1">
            Adds all officials from that state to focus
          </p>
        </div>
      </TreeSection>

      {/* ── Custom filter ────── */}
      <TreeSection
        label="Custom Filter"
        defaultExpanded={false}
        separator={false}
        depth={1}
      >
        <div className="px-3 py-2 space-y-2">

          {/* Type toggle */}
          <div className="flex gap-1">
            {(['official', 'pac'] as const).map(t => (
              <button
                key={t}
                onClick={() => {
                  setCustomType(t);
                  setCustomIndustry('');
                  setCustomChamber('');
                  setCustomParty('');
                }}
                className={`flex-1 py-0.5 text-[10px] rounded capitalize transition-colors ${
                  customType === t
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {t === 'official' ? '👤 Officials' : '💼 PACs'}
              </button>
            ))}
          </div>

          {/* Official filters */}
          {customType === 'official' && (
            <>
              <select
                value={customChamber}
                onChange={e => setCustomChamber(e.target.value)}
                className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-600 focus:outline-none focus:border-indigo-400"
              >
                <option value="">Any chamber</option>
                <option value="senate">Senate</option>
                <option value="house">House</option>
              </select>

              <select
                value={customParty}
                onChange={e => setCustomParty(e.target.value)}
                className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-600 focus:outline-none focus:border-indigo-400"
              >
                <option value="">Any party</option>
                <option value="democrat">Democrat</option>
                <option value="republican">Republican</option>
                <option value="independent">Independent</option>
              </select>

              <select
                value={customState}
                onChange={e => setCustomState(e.target.value)}
                className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-600 focus:outline-none focus:border-indigo-400"
              >
                <option value="">Any state</option>
                {US_STATES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </>
          )}

          {/* PAC filters */}
          {customType === 'pac' && (
            <select
              value={customIndustry}
              onChange={e => setCustomIndustry(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-600 focus:outline-none focus:border-indigo-400"
            >
              <option value="">Any industry</option>
              {[
                'Finance', 'Energy', 'Healthcare', 'Defense',
                'Labor', 'Tech', 'Agriculture', 'Real Estate',
                'Transportation', 'Construction', 'Retail & Food',
                'Education', 'Legal',
              ].map(ind => (
                <option key={ind} value={ind}>{ind}</option>
              ))}
            </select>
          )}

          {/* Create button */}
          <button
            onClick={() => {
              const filter = buildCustomFilter();
              const group = createCustomGroup(filter, customGroupName());
              onAddGroup(group);
            }}
            className="w-full py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors"
          >
            + Add &ldquo;{customGroupName()}&rdquo;
          </button>
        </div>
      </TreeSection>
    </div>
  );
}
