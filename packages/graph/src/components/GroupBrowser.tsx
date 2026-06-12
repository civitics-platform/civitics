"use client";

/**
 * GroupBrowser
 *
 * Recursive 5-category browse hierarchy (FIX-135) with by-state drill-down
 * (FIX-136), by-topic-tag drill-down (FIX-137), home-location shortcut
 * (FIX-138), and by-committee drill-down (FIX-139). Walks GROUP_TREE — each
 * category is a TreeSection, each leaf is either a premade group, one of the
 * dynamic-list slots (state, topic-tag, committee, home-state), or the
 * custom-group form. Groups are queries, not lists — adding one stores a
 * filter, not entity IDs.
 */

import { useEffect, useState } from 'react';
import {
  BUILT_IN_GROUPS,
  GROUP_TREE,
  createCustomGroup,
  type GroupTreeNode,
} from '../groups';
import type { FocusEntity, FocusGroup, GroupFilter } from '../types';
import { loadRecent, clearRecent, type RecentEntity } from '../recently-viewed';
import { TreeSection } from './TreeNode';
import { CustomGroupForm } from './CustomGroupForm';

export interface GroupBrowserProps {
  onAddGroup: (group: FocusGroup) => void;
  /** Optional. When provided, the Recently-viewed slot becomes interactive. */
  onAddEntity?: (entity: FocusEntity) => void;
  /** IDs of groups already in focus so we can show them as active */
  activeGroupIds?: string[];
  /** IDs of focus entities (non-group) already in focus */
  activeEntityIds?: string[];
}

// Alphabetical by full name so the drill-down reads naturally.
// Abbreviations stay in sync with officials.metadata.state_abbr (FIX-124).
type UsState = { abbr: string; name: string };

const US_STATES: UsState[] = [
  { abbr: 'AL', name: 'Alabama' },        { abbr: 'AK', name: 'Alaska' },
  { abbr: 'AZ', name: 'Arizona' },        { abbr: 'AR', name: 'Arkansas' },
  { abbr: 'CA', name: 'California' },     { abbr: 'CO', name: 'Colorado' },
  { abbr: 'CT', name: 'Connecticut' },    { abbr: 'DE', name: 'Delaware' },
  { abbr: 'DC', name: 'District of Columbia' },
  { abbr: 'FL', name: 'Florida' },        { abbr: 'GA', name: 'Georgia' },
  { abbr: 'HI', name: 'Hawaii' },         { abbr: 'ID', name: 'Idaho' },
  { abbr: 'IL', name: 'Illinois' },       { abbr: 'IN', name: 'Indiana' },
  { abbr: 'IA', name: 'Iowa' },           { abbr: 'KS', name: 'Kansas' },
  { abbr: 'KY', name: 'Kentucky' },       { abbr: 'LA', name: 'Louisiana' },
  { abbr: 'ME', name: 'Maine' },          { abbr: 'MD', name: 'Maryland' },
  { abbr: 'MA', name: 'Massachusetts' },  { abbr: 'MI', name: 'Michigan' },
  { abbr: 'MN', name: 'Minnesota' },      { abbr: 'MS', name: 'Mississippi' },
  { abbr: 'MO', name: 'Missouri' },       { abbr: 'MT', name: 'Montana' },
  { abbr: 'NE', name: 'Nebraska' },       { abbr: 'NV', name: 'Nevada' },
  { abbr: 'NH', name: 'New Hampshire' },  { abbr: 'NJ', name: 'New Jersey' },
  { abbr: 'NM', name: 'New Mexico' },     { abbr: 'NY', name: 'New York' },
  { abbr: 'NC', name: 'North Carolina' }, { abbr: 'ND', name: 'North Dakota' },
  { abbr: 'OH', name: 'Ohio' },           { abbr: 'OK', name: 'Oklahoma' },
  { abbr: 'OR', name: 'Oregon' },         { abbr: 'PA', name: 'Pennsylvania' },
  { abbr: 'RI', name: 'Rhode Island' },   { abbr: 'SC', name: 'South Carolina' },
  { abbr: 'SD', name: 'South Dakota' },   { abbr: 'TN', name: 'Tennessee' },
  { abbr: 'TX', name: 'Texas' },          { abbr: 'UT', name: 'Utah' },
  { abbr: 'VT', name: 'Vermont' },        { abbr: 'VA', name: 'Virginia' },
  { abbr: 'WA', name: 'Washington' },     { abbr: 'WV', name: 'West Virginia' },
  { abbr: 'WI', name: 'Wisconsin' },      { abbr: 'WY', name: 'Wyoming' },
];

const STATE_BY_ABBR = new Map(US_STATES.map(s => [s.abbr, s]));

// ── Committee (FIX-139) ───────────────────────────────────────────────────────

interface CommitteeItem {
  id: string;
  name: string;
  chamber: 'house' | 'senate' | 'joint' | null;
  memberCount: number;
}

const CHAMBER_ORDER: Array<CommitteeItem['chamber']> = ['senate', 'house', 'joint', null];

const CHAMBER_LABEL: Record<string, string> = {
  senate: 'Senate',
  house: 'House',
  joint: 'Joint',
  other: 'Other',
};

function committeeGroupId(id: string): string {
  return `group-committee-${id}`;
}

function buildCommitteeGroup(c: CommitteeItem): FocusGroup {
  return {
    id: committeeGroupId(c.id),
    name: c.name,
    type: 'group',
    icon: '🪪',
    color: '#0ea5e9',
    filter: { entity_type: 'official', committeeId: c.id },
    isPremade: false,
    description: `${c.memberCount} members`,
    count: c.memberCount,
  };
}

// ── Topic tag (FIX-137) ───────────────────────────────────────────────────────

interface TagGroupItem {
  tag: string;
  label: string;
  icon: string | null;
  count: number;
}

function tagGroupId(tag: string): string {
  return `group-tag-${tag}`;
}

function buildTagGroup(t: TagGroupItem): FocusGroup {
  return {
    id: tagGroupId(t.tag),
    name: `${t.label} bills`,
    type: 'group',
    icon: t.icon ?? '🏷',
    color: '#a855f7',
    filter: { entity_type: 'proposal', tag: t.tag },
    isPremade: false,
    description: `${t.count.toLocaleString()} proposals tagged ${t.label}`,
    count: t.count,
  };
}

// ── State-legislature gbs (FIX-493) ──────────────────────────────────────────

interface GbListItem {
  slug: string;
  name: string;
  shortName: string | null;
  type: 'legislature_upper' | 'legislature_lower' | 'legislature_unicameral';
  stateAbbr: string | null;
  stateName: string;
}

// Same id shape as the /search institution handoff (GraphPage), so a chamber
// added from either entry point shows as active in both.
function gbGroupId(slug: string): string {
  return `group-gb-${slug}`;
}

// Colors mirror the group route's server-resolved GB_TYPE_VISUAL — the route
// overrides these on fetch (FIX-490), this is just the pre-fetch placeholder.
const GB_TYPE_COLOR: Record<GbListItem['type'], string> = {
  legislature_upper: '#6366f1',
  legislature_lower: '#8b5cf6',
  legislature_unicameral: '#6366f1',
};

function buildGbGroup(g: GbListItem): FocusGroup {
  return {
    id: gbGroupId(g.slug),
    name: g.name,
    type: 'group',
    icon: '🏛',
    color: GB_TYPE_COLOR[g.type],
    filter: { entity_type: 'official', governingBody: g.slug },
    isPremade: false,
    description: g.stateName,
  };
}

// Deterministic id so a state delegation already in focus shows as active.
function stateGroupId(abbr: string): string {
  return `group-state-${abbr}`;
}

function buildStateGroup(abbr: string, name: string): FocusGroup {
  return {
    id: stateGroupId(abbr),
    name: `${name} Delegation`,
    type: 'group',
    icon: '🗺',
    color: '#6366f1',
    filter: { entity_type: 'official', state: abbr },
    isPremade: false,
    description: `Officials representing ${name}`,
  };
}

export function GroupBrowser({
  onAddGroup,
  onAddEntity,
  activeGroupIds = [],
  activeEntityIds = [],
}: GroupBrowserProps) {

  // Build lookup map for quick access by ID
  const groupMap = new Map(BUILT_IN_GROUPS.map(g => [g.id, g]));

  // Save flow: build a FocusGroup, optionally persist via /api/graph/custom-groups,
  // then add to the active view. Persistence is best-effort — anonymous users
  // and network errors fall back to in-memory groups so the user never loses
  // their selection.
  async function handleCustomSave({ filter, name }: { filter: GroupFilter; name: string }) {
    try {
      await fetch('/api/graph/custom-groups', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, filter }),
        credentials: 'include',
      });
    } catch {
      // Silent fallback — user's group still works in-session even if persistence fails.
    }
    const group = createCustomGroup(filter, name);
    onAddGroup(group);
  }

  function handleStateSelect(abbr: string, name: string) {
    onAddGroup(buildStateGroup(abbr, name));
  }

  function handleTagSelect(t: TagGroupItem) {
    onAddGroup(buildTagGroup(t));
  }

  function handleCommitteeSelect(c: CommitteeItem) {
    onAddGroup(buildCommitteeGroup(c));
  }

  function handleGbSelect(g: GbListItem) {
    onAddGroup(buildGbGroup(g));
  }

  function renderNode(node: GroupTreeNode, depth: number, key: string): React.ReactNode {
    if (node.kind === 'category') {
      const hasContent = node.children.some(c => isLeafRenderable(c, groupMap));
      if (!hasContent) return null;
      return (
        <TreeSection
          key={key}
          label={node.label}
          icon={node.icon}
          defaultExpanded={node.defaultExpanded ?? false}
          separator={false}
          depth={depth}
        >
          {node.children.map((child, i) => renderNode(child, depth + 1, `${key}-${i}`))}
        </TreeSection>
      );
    }

    if (node.kind === 'group') {
      const group = groupMap.get(node.id);
      if (!group) return null;
      const isActive = activeGroupIds.includes(node.id);
      return (
        <GroupRow
          key={key}
          group={group}
          isActive={isActive}
          depth={depth}
          onAdd={() => onAddGroup(group)}
        />
      );
    }

    if (node.kind === 'state-list') {
      return (
        <StateList
          key={key}
          depth={depth}
          activeIds={activeGroupIds}
          onSelect={handleStateSelect}
        />
      );
    }

    if (node.kind === 'topic-tag-list') {
      return (
        <TopicTagList
          key={key}
          depth={depth}
          activeIds={activeGroupIds}
          onSelect={handleTagSelect}
        />
      );
    }

    if (node.kind === 'home-location') {
      return (
        <HomeLocationRow
          key={key}
          depth={depth}
          activeIds={activeGroupIds}
          onSelect={handleStateSelect}
        />
      );
    }

    if (node.kind === 'committee-list') {
      return (
        <CommitteeList
          key={key}
          depth={depth}
          activeIds={activeGroupIds}
          onSelect={handleCommitteeSelect}
        />
      );
    }

    if (node.kind === 'gb-list') {
      return (
        <GbList
          key={key}
          depth={depth}
          activeIds={activeGroupIds}
          onSelect={handleGbSelect}
        />
      );
    }

    if (node.kind === 'recent-list') {
      return (
        <RecentList
          key={key}
          depth={depth}
          activeIds={activeEntityIds}
          onSelect={onAddEntity}
        />
      );
    }

    if (node.kind === 'custom-form') {
      return (
        <div key={key} className="px-3 py-2" style={{ paddingLeft: `${8 + depth * 12}px` }}>
          <CustomGroupForm onSave={handleCustomSave} />
        </div>
      );
    }

    return null;
  }

  return (
    <div className="pb-2">
      {GROUP_TREE.map((node, i) => renderNode(node, 1, `root-${i}`))}
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────────

function GroupRow({
  group,
  isActive,
  depth,
  onAdd,
}: {
  group: FocusGroup;
  isActive: boolean;
  depth: number;
  onAdd: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
      style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: '12px' }}
    >
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
      <button
        onClick={onAdd}
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
}

function StateList({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect: (abbr: string, name: string) => void;
}) {
  return (
    <div>
      {US_STATES.map(s => {
        const isActive = activeIds.includes(stateGroupId(s.abbr));
        return (
          <div
            key={s.abbr}
            className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
            style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: '12px' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-semibold text-gray-400 shrink-0 w-6 tabular-nums">
                {s.abbr}
              </span>
              <span className="text-xs font-medium text-gray-700 truncate">
                {s.name}
              </span>
            </div>
            <button
              onClick={() => onSelect(s.abbr, s.name)}
              disabled={isActive}
              title={isActive ? 'Already in focus' : `Add ${s.name} delegation to focus`}
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
    </div>
  );
}

function CommitteeList({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect: (c: CommitteeItem) => void;
}) {
  const [committees, setCommittees] = useState<CommitteeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/graph/committees')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) setCommittees(data.committees ?? []); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const padding = `${8 + depth * 12}px`;

  if (error) {
    return (
      <div className="py-2 text-[10px] text-red-500" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Couldn’t load committees: {error}
      </div>
    );
  }

  if (committees === null) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Loading committees…
      </div>
    );
  }

  if (committees.length === 0) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        No committees ingested yet.
      </div>
    );
  }

  // Group by chamber so the list reads naturally; senate first.
  const byChamber = new Map<string, CommitteeItem[]>();
  for (const c of committees) {
    const key = c.chamber ?? 'other';
    const existing = byChamber.get(key);
    if (existing) existing.push(c);
    else byChamber.set(key, [c]);
  }

  return (
    <div>
      {CHAMBER_ORDER.map(chamber => {
        const key = chamber ?? 'other';
        const items = byChamber.get(key);
        if (!items || items.length === 0) return null;
        return (
          <div key={key}>
            <div
              className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold pt-2 pb-0.5"
              style={{ paddingLeft: padding, paddingRight: '12px' }}
            >
              {CHAMBER_LABEL[key] ?? key}
            </div>
            {items.map(c => {
              const isActive = activeIds.includes(committeeGroupId(c.id));
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
                  style={{ paddingLeft: padding, paddingRight: '12px' }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-gray-700 truncate">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                      {c.memberCount}
                    </span>
                  </div>
                  <button
                    onClick={() => onSelect(c)}
                    disabled={isActive}
                    title={isActive ? 'Already in focus' : `Add ${c.name} to focus`}
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
          </div>
        );
      })}
    </div>
  );
}

// FIX-493 — state-legislature chambers, fetched from /api/graph/gb-list
// (runtime-derived from the slugged legislature_* governing_bodies rows).
// Each row seeds a gb group through the FIX-490 governingBody route path.
function GbList({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect: (g: GbListItem) => void;
}) {
  const [gbs, setGbs] = useState<GbListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/graph/gb-list')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) setGbs(data.governingBodies ?? []); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const padding = `${8 + depth * 12}px`;

  if (error) {
    return (
      <div className="py-2 text-[10px] text-red-500" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Couldn’t load legislatures: {error}
      </div>
    );
  }

  if (gbs === null) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Loading legislatures…
      </div>
    );
  }

  if (gbs.length === 0) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        No state legislatures ingested yet.
      </div>
    );
  }

  return (
    <div>
      {gbs.map(g => {
        const isActive = activeIds.includes(gbGroupId(g.slug));
        return (
          <div
            key={g.slug}
            className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
            style={{ paddingLeft: padding, paddingRight: '12px' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-semibold text-gray-400 shrink-0 w-6 tabular-nums">
                {g.stateAbbr ?? ''}
              </span>
              <span className="text-xs font-medium text-gray-700 truncate" title={g.name}>
                {g.shortName ?? g.name}
              </span>
            </div>
            <button
              onClick={() => onSelect(g)}
              disabled={isActive}
              title={isActive ? 'Already in focus' : `Add ${g.name} to focus`}
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
    </div>
  );
}

function RecentList({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect?: (entity: FocusEntity) => void;
}) {
  const [recent, setRecent] = useState<RecentEntity[] | null>(null);

  // Defer the localStorage read to mount so SSR/CSR markup matches.
  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  function handleClear() {
    clearRecent();
    setRecent([]);
  }

  function handleClick(r: RecentEntity) {
    if (!onSelect) return;
    onSelect({
      id:        r.id,
      name:      r.name,
      type:      r.type,
      ...(r.role     ? { role:     r.role }     : {}),
      ...(r.party    ? { party:    r.party }    : {}),
      ...(r.photoUrl ? { photoUrl: r.photoUrl } : {}),
    });
  }

  const padding = `${8 + depth * 12}px`;

  if (recent === null) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Loading recent entities…
      </div>
    );
  }

  if (recent.length === 0) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Entities you focus will appear here.
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex items-center justify-between pt-1 pb-1"
        style={{ paddingLeft: padding, paddingRight: '12px' }}
      >
        <span className="text-[10px] text-gray-400">{recent.length} of 20</span>
        <button
          type="button"
          onClick={handleClear}
          className="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
        >
          Clear
        </button>
      </div>
      {recent.map(r => {
        const isActive = activeIds.includes(r.id);
        return (
          <div
            key={r.id}
            className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
            style={{ paddingLeft: padding, paddingRight: '12px' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm shrink-0">{ICON_BY_TYPE[r.type] ?? '◦'}</span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-700 truncate">
                  {r.name}
                </div>
                {r.role && (
                  <div className="text-[10px] text-gray-400 truncate">
                    {r.role}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => handleClick(r)}
              disabled={isActive || !onSelect}
              title={isActive ? 'Already in focus' : `Add ${r.name} back to focus`}
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
    </div>
  );
}

const ICON_BY_TYPE: Record<string, string> = {
  official:  '👤',
  agency:    '🏛',
  proposal:  '📜',
  financial: '💰',
};

function HomeLocationRow({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect: (abbr: string, name: string) => void;
}) {
  const [home, setHome] = useState<{ abbr: string; name: string } | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile/preferences', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled) return;
        setResolved(true);
        const abbr: string | null = data?.preferences?.home_state ?? null;
        if (!abbr) return;
        const state = STATE_BY_ABBR.get(abbr);
        if (state) setHome(state);
      })
      .catch(() => { if (!cancelled) setResolved(true); });
    return () => { cancelled = true; };
  }, []);

  // Render nothing until we know whether the user has a home set —
  // and nothing if they don't.
  if (!resolved || !home) return null;

  const isActive = activeIds.includes(stateGroupId(home.abbr));
  return (
    <div
      className="flex items-center justify-between py-1.5 hover:bg-violet-50/50 group/row border-l-2 border-violet-300"
      style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: '12px' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm shrink-0">📍</span>
        <div className="min-w-0">
          <div className="text-xs font-medium text-violet-700 truncate">
            My state’s reps
          </div>
          <div className="text-[10px] text-gray-400 truncate">
            {home.name} ({home.abbr})
          </div>
        </div>
      </div>
      <button
        onClick={() => onSelect(home.abbr, home.name)}
        disabled={isActive}
        title={isActive ? 'Already in focus' : `Add ${home.name} delegation to focus`}
        className={`shrink-0 ml-2 w-5 h-5 rounded text-xs font-bold transition-colors flex items-center justify-center ${
          isActive
            ? 'bg-violet-100 text-violet-400 cursor-default'
            : 'bg-gray-100 text-gray-500 hover:bg-violet-600 hover:text-white group-hover/row:bg-violet-50 group-hover/row:text-violet-600'
        }`}
      >
        {isActive ? '✓' : '+'}
      </button>
    </div>
  );
}

function TopicTagList({
  depth,
  activeIds,
  onSelect,
}: {
  depth: number;
  activeIds: string[];
  onSelect: (t: TagGroupItem) => void;
}) {
  const [tags, setTags] = useState<TagGroupItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/graph/tag-groups')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) setTags(data.tags ?? []); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const padding = `${8 + depth * 12}px`;

  if (error) {
    return (
      <div className="py-2 text-[10px] text-red-500" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Couldn’t load tags: {error}
      </div>
    );
  }

  if (tags === null) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        Loading topic tags…
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <div className="py-2 text-[10px] text-gray-400" style={{ paddingLeft: padding, paddingRight: '12px' }}>
        No topic tags available yet.
      </div>
    );
  }

  return (
    <div>
      {tags.map(t => {
        const isActive = activeIds.includes(tagGroupId(t.tag));
        return (
          <div
            key={t.tag}
            className="flex items-center justify-between py-1.5 hover:bg-gray-50 group/row"
            style={{ paddingLeft: padding, paddingRight: '12px' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm shrink-0">{t.icon ?? '🏷'}</span>
              <span className="text-xs font-medium text-gray-700 truncate">
                {t.label}
              </span>
              <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                {t.count}
              </span>
            </div>
            <button
              onClick={() => onSelect(t)}
              disabled={isActive}
              title={isActive ? 'Already in focus' : `Add ${t.label} bills to focus`}
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
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Is this leaf renderable right now? Used to skip empty categories so users
 * don't see hollow "Government" / "Legislation" headers before later FIX-NNN
 * land. A category counts as renderable iff at least one descendant is.
 */
function isLeafRenderable(
  node: GroupTreeNode,
  groupMap: Map<string, FocusGroup>,
): boolean {
  if (node.kind === 'group')          return groupMap.has(node.id);
  if (node.kind === 'state-list')     return true;
  if (node.kind === 'topic-tag-list') return true;
  if (node.kind === 'committee-list') return true;
  if (node.kind === 'gb-list')        return true;
  if (node.kind === 'home-location')  return true;
  if (node.kind === 'recent-list')    return true;
  if (node.kind === 'custom-form')    return true;
  return node.children.some(c => isLeafRenderable(c, groupMap));
}
