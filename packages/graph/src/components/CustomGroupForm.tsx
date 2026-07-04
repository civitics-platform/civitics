"use client";

/**
 * CustomGroupForm — FIX-127
 *
 * Inline form for building a custom FocusGroup. Used in two places:
 *   - GroupBrowser (left panel of /graph): onSave creates a FocusGroup and
 *     adds it to the active view (optionally persisting via POST).
 *   - /agencies sidebar widget: onSave navigates to /graph with the filter
 *     encoded in the URL.
 *
 * Live count comes from /api/graph/group/preview.
 */

import { useEffect, useState } from 'react';
import type { GroupFilter } from '../types';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
  'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
  'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
];

const PAC_INDUSTRIES = [
  'Finance','Energy','Healthcare','Defense','Labor','Tech','Agriculture',
  'Real Estate','Transportation','Construction','Retail & Food','Education','Legal',
];

export interface CustomGroupFormPayload {
  filter: GroupFilter;
  name: string;
}

export interface CustomGroupFormProps {
  onSave: (payload: CustomGroupFormPayload) => void | Promise<void>;
  /** Label for the save button. Defaults to "+ Add to focus". */
  saveLabel?: string;
  /** When true, render an extra "Save to my groups" toggle (signed-in builder only). */
  allowPersist?: boolean;
  onPersistChange?: (persist: boolean) => void;
}

function suggestedName(filter: GroupFilter): string {
  const parts: string[] = [];
  if (filter.state)    parts.push(filter.state);
  if (filter.party)    parts.push(filter.party.charAt(0).toUpperCase() + filter.party.slice(1));
  if (filter.chamber)  parts.push(filter.chamber.charAt(0).toUpperCase() + filter.chamber.slice(1));
  if (filter.entity_type === 'pac' && filter.industry) parts.push(`${filter.industry} PACs`);
  else if (filter.entity_type === 'pac')               parts.push('PACs');
  else if (filter.entity_type === 'agency')            parts.push('Agencies');
  else                                                  parts.push('Officials');
  return parts.join(' ');
}

export function CustomGroupForm({
  onSave,
  saveLabel = '+ Add to focus',
  allowPersist = false,
  onPersistChange,
}: CustomGroupFormProps) {
  const [type,     setType]     = useState<GroupFilter['entity_type']>('official');
  const [chamber,  setChamber]  = useState<string>('');
  const [party,    setParty]    = useState<string>('');
  const [state,    setState]    = useState<string>('');
  const [industry, setIndustry] = useState<string>('');
  const [name,     setName]     = useState<string>('');
  const [persist,  setPersist]  = useState<boolean>(false);

  const [count,        setCount]        = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState<boolean>(false);
  const [saveLoading,  setSaveLoading]  = useState<boolean>(false);

  function buildFilter(): GroupFilter {
    const f: GroupFilter = { entity_type: type };
    if (type === 'official') {
      if (chamber) f.chamber = chamber as 'senate' | 'house';
      if (party)   f.party   = party;
      if (state)   f.state   = state;
    } else if (type === 'pac') {
      if (industry) f.industry = industry;
    }
    return f;
  }

  // Debounced live count
  useEffect(() => {
    const filter = buildFilter();
    const params = new URLSearchParams({ entity_type: filter.entity_type });
    if (filter.chamber)  params.set('chamber',  filter.chamber);
    if (filter.party)    params.set('party',    filter.party);
    if (filter.state)    params.set('state',    filter.state);
    if (filter.industry) params.set('industry', filter.industry);

    setCountLoading(true);
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/graph/group/preview?${params}`, { signal: ac.signal });
        if (!res.ok) { setCount(null); return; }
        const data = await res.json() as { count?: number };
        setCount(data.count ?? null);
      } catch (e) {
        if ((e as { name?: string } | null)?.name !== 'AbortError') setCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 250);
    return () => { clearTimeout(t); ac.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, chamber, party, state, industry]);

  const filter        = buildFilter();
  const effectiveName = (name.trim() || suggestedName(filter));

  async function handleSave() {
    if (saveLoading) return;
    setSaveLoading(true);
    try {
      await onSave({ filter, name: effectiveName });
    } finally {
      setSaveLoading(false);
    }
  }

  return (
    <div className="space-y-2">

      {/* Type toggle */}
      <div className="flex gap-1">
        {(['official', 'pac', 'agency'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setType(t);
              setChamber(''); setParty(''); setState(''); setIndustry('');
            }}
            className={`flex-1 py-0.5 text-[10px] rounded capitalize transition-colors ${
              type === t
                ? 'bg-accent text-paper'
                : 'bg-ink/5 text-ink-soft hover:bg-ink/10'
            }`}
          >
            {t === 'official' ? '👤 Officials' : t === 'pac' ? '💼 PACs' : '🏛 Agencies'}
          </button>
        ))}
      </div>

      {/* Official filters */}
      {type === 'official' && (
        <>
          <select
            value={chamber}
            onChange={e => setChamber(e.target.value)}
            className="w-full text-xs border border-rule rounded px-2 py-1 bg-card text-ink-soft focus:outline-none focus:border-accent"
          >
            <option value="">Any chamber</option>
            <option value="senate">Senate</option>
            <option value="house">House</option>
          </select>
          <select
            value={party}
            onChange={e => setParty(e.target.value)}
            className="w-full text-xs border border-rule rounded px-2 py-1 bg-card text-ink-soft focus:outline-none focus:border-accent"
          >
            <option value="">Any party</option>
            <option value="democrat">Democrat</option>
            <option value="republican">Republican</option>
            <option value="independent">Independent</option>
          </select>
          <select
            value={state}
            onChange={e => setState(e.target.value)}
            className="w-full text-xs border border-rule rounded px-2 py-1 bg-card text-ink-soft focus:outline-none focus:border-accent"
          >
            <option value="">Any state</option>
            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </>
      )}

      {/* PAC filters */}
      {type === 'pac' && (
        <select
          value={industry}
          onChange={e => setIndustry(e.target.value)}
          className="w-full text-xs border border-rule rounded px-2 py-1 bg-card text-ink-soft focus:outline-none focus:border-accent"
        >
          <option value="">Any industry</option>
          {PAC_INDUSTRIES.map(ind => <option key={ind} value={ind}>{ind}</option>)}
        </select>
      )}

      {/* Agency: no extra filters yet — count is just total active agencies. */}
      {type === 'agency' && (
        <p className="text-[10px] text-ink-soft/60 px-1">
          All active federal agencies. Industry/department filters coming soon.
        </p>
      )}

      {/* Name input */}
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={suggestedName(filter)}
        maxLength={80}
        className="w-full text-xs border border-rule rounded px-2 py-1 bg-card text-ink placeholder:text-ink-soft/60 focus:outline-none focus:border-accent"
      />

      {/* Live count */}
      <div className="flex items-center justify-between text-[10px] px-1 text-ink-soft">
        <span>
          {countLoading
            ? 'Counting…'
            : count === null
              ? 'No data'
              : `${count.toLocaleString()} match${count === 1 ? '' : 'es'}`}
        </span>
        {allowPersist && (
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={persist}
              onChange={e => {
                setPersist(e.target.checked);
                onPersistChange?.(e.target.checked);
              }}
              className="w-3 h-3"
              style={{ accentColor: 'rgb(var(--c-accent))' }}
            />
            <span>Save to my groups</span>
          </label>
        )}
      </div>

      {/* Save button */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saveLoading || (count !== null && count === 0)}
        className="w-full py-1.5 text-xs font-medium bg-accent hover:bg-accent/85 disabled:opacity-50 disabled:cursor-not-allowed text-paper rounded transition-colors"
      >
        {saveLoading ? 'Saving…' : `${saveLabel} "${effectiveName}"`}
      </button>
    </div>
  );
}
