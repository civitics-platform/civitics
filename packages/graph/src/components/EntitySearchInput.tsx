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
    <div className="relative px-2 pb-1">
      {/* Input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full pl-2 pr-2 py-1.5 text-xs border border-gray-200 rounded-md bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs leading-none w-4 h-4 flex items-center justify-center"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown results */}
      {query.trim().length >= 2 && (
        <div className="mt-1 border border-gray-200 rounded-md bg-white shadow-sm overflow-hidden max-h-48 overflow-y-auto w-full max-w-full">
          {loading && (
            <div className="px-3 py-2 text-xs text-gray-400">Loading…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No results</div>
          )}
          {!loading && results.map(entity => (
            <TreeNode
              key={entity.id}
              label={<span className="truncate block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{entity.name}</span>}
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
