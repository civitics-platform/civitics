"use client";

/**
 * packages/graph/src/hooks/useEntitySearch.ts
 *
 * Debounced entity search hook.
 * Queries /api/graph/search and returns results as FocusEntity[].
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
          `/api/graph/search?q=` + encodeURIComponent(query.trim())
        );
        const data = await res.json();

        // Map API results to FocusEntity shape
        setResults(
          (data ?? []).map((e: Record<string, unknown>) => ({
            id: e.id as string,
            name: e.label as string,
            type: (e.type as string) ?? 'official',
            role: (e.subtitle as string) ?? undefined,
            party: (e.party as string) ?? undefined,
            photoUrl: undefined,
            connectionCount: (e.connectionCount as number) ?? 0,
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
