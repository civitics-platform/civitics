"use client";

/**
 * packages/graph/src/components/EntitySearchInput.tsx
 *
 * Search input with results dropdown. Used inside FocusTree.
 * Each result renders as a TreeNode variant='entity'.
 */

import { useEntitySearch } from '../hooks/useEntitySearch';
import type { FocusEntity } from '../types';
import { TreeNode } from './TreeNode';

export interface EntitySearchInputProps {
  onSelect: (entity: FocusEntity) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function EntitySearchInput({ onSelect, placeholder = 'Search officials, agencies…', disabled }: EntitySearchInputProps) {
  const { query, setQuery, results, loading, clear } = useEntitySearch();

  function handleSelect(entity: FocusEntity) {
    onSelect(entity);
    clear();
  }

  return (
    <div className="relative px-2 pb-1 w-full">
      {/* Input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full pl-2 pr-2 py-1.5 text-xs border border-rule rounded-md bg-card text-ink placeholder:text-ink-soft/60 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-soft/60 hover:text-ink text-xs leading-none w-4 h-4 flex items-center justify-center"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown results */}
      {query.trim().length >= 2 && (
        <div className="absolute left-2 right-2 z-50 border border-rule rounded-md bg-card shadow-lg overflow-hidden max-h-48 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-xs text-ink-soft/60">Loading…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-ink-soft/60">No results</div>
          )}
          {!loading && results.map(entity => (
            <TreeNode
              key={entity.id}
              label={(entity.name ?? '').length > 28 ? (entity.name ?? '').slice(0, 28) + '…' : (entity.name ?? '')}
              variant="entity"
              party={entity.party}
              photoUrl={entity.photoUrl}
              collapsible={false}
              separator={false}
              onClick={() => handleSelect(entity)}
            >
              {null}
            </TreeNode>
          ))}
        </div>
      )}
    </div>
  );
}
