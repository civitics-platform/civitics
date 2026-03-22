"use client";

/**
 * packages/graph/src/hooks/useEntitySearch.ts
 *
 * Debounced entity search hook.
 * Queries /api/graph/entities and returns results as FocusEntity[].
 */

import { useState, useEffect } from 'react';
import type { FocusEntity } from '../types';

export function useEntitySearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FocusEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce 300ms
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/graph/entities?q=` + encodeURIComponent(query.trim())
        );
        const data = await res.json();

        // Map API results to FocusEntity shape
        setResults(
          (data.entities ?? data ?? []).map((e: Record<string, unknown>) => ({
            id: e.id,
            name: e.name,
            type: e.type ?? 'official',
            role: e.role ?? e.role_title,
            party: e.party ?? e.party_affiliation,
            photoUrl: e.photo_url,
          }))
        );
      } catch (err) {
        setError('Search failed');
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const clear = () => {
    setQuery('');
    setResults([]);
  };

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    clear,
  };
}
