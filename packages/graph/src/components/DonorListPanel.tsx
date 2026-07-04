"use client";

/**
 * packages/graph/src/components/DonorListPanel.tsx
 *
 * FIX-194 — Slide-in side panel showing real individual donors aggregated
 * into a bracket or employer node. Allows pinning a donor as a real graph node.
 *
 * Rendered by GraphPage when the user clicks "View donor list" on a bracket node.
 */

import React, { useEffect, useState, useCallback } from "react";
import { BRACKET_TIERS } from "../types";
import type { IndividualDisplayMode } from "../types";

export interface DonorListPanelProps {
  officialId: string;
  officialName: string;
  /** Bracket tier id ('mega' | 'major' | 'mid' | 'small') OR employer key for employer mode */
  tierOrEmployer: string;
  mode: IndividualDisplayMode;
  onClose: () => void;
  onPinDonor: (donorId: string, donorName: string) => void;
}

interface DonorRow {
  id: string;
  display_name: string;
  amount_cents: number;
  recipient_count: number;
  employer: string | null;
  state: string | null;
}

const PAGE_SIZE = 50;

export function DonorListPanel({
  officialId,
  officialName,
  tierOrEmployer,
  mode,
  onClose,
  onPinDonor,
}: DonorListPanelProps) {
  const [donors, setDonors] = useState<DonorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tierDef = BRACKET_TIERS.find(t => t.id === tierOrEmployer);
  const isEmployer = mode === 'employer';
  const panelTitle = isEmployer
    ? (tierOrEmployer === 'UNAFFILIATED' ? 'Unaffiliated' : tierOrEmployer)
    : (tierDef?.label ?? tierOrEmployer);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ officialId, page: String(p), pageSize: String(PAGE_SIZE) });
      if (isEmployer) {
        params.set("employer", tierOrEmployer);
      } else {
        params.set("tier", tierOrEmployer);
      }
      const res = await fetch(`/api/graph/individual-donors?${params}`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = await res.json() as { donors: DonorRow[]; total: number; page: number };
      setDonors(data.donors);
      setTotal(data.total);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load donors");
    } finally {
      setLoading(false);
    }
  }, [officialId, tierOrEmployer, isEmployer]);

  useEffect(() => {
    fetchPage(1);
  }, [fetchPage]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="absolute inset-y-0 right-0 w-80 bg-card border-l border-rule shadow-2xl z-30 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule/60">
        <div className="min-w-0">
          <div className="font-semibold text-ink text-sm leading-tight truncate">
            {panelTitle} Donors
          </div>
          <div className="text-xs text-ink-soft mt-0.5 truncate">{officialName}</div>
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 ml-2 text-ink-soft/60 hover:text-ink transition-colors text-lg leading-none"
          aria-label="Close donor list"
        >
          ✕
        </button>
      </div>

      {/* Total count */}
      {total > 0 && (
        <div className="px-4 py-2 bg-amber/20 border-b border-amber/30 text-xs text-ink">
          {total.toLocaleString()} donor{total !== 1 ? 's' : ''} in this group
          {totalPages > 1 && ` · page ${page} of ${totalPages}`}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-32 text-ink-soft/60 text-sm">
            Loading…
          </div>
        )}
        {error && (
          <div className="p-4 text-accent text-sm">{error}</div>
        )}
        {!loading && !error && donors.length === 0 && (
          <div className="flex items-center justify-center h-32 text-ink-soft/60 text-sm">
            No donors found
          </div>
        )}
        {!loading && donors.map((donor) => (
          <div
            key={donor.id}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink/5 border-b border-rule/40 group"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink leading-tight truncate">
                {donor.display_name}
              </div>
              <div className="text-xs text-ink-soft/60 mt-0.5 flex gap-2 truncate">
                {donor.employer && (
                  <span className="truncate">{donor.employer}</span>
                )}
                {donor.state && (
                  <span className="flex-shrink-0">{donor.state}</span>
                )}
                {donor.recipient_count >= 2 && (
                  <span className="flex-shrink-0 text-accent font-medium">
                    ×{donor.recipient_count} officials
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-sm font-semibold text-ink">
                ${Math.round(donor.amount_cents / 100).toLocaleString()}
              </span>
              <button
                onClick={() => onPinDonor(donor.id, donor.display_name)}
                title="Pin to graph"
                className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded text-xs bg-accent/10 text-accent hover:bg-accent/20 font-medium"
              >
                Pin
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-rule/60">
          <button
            onClick={() => fetchPage(page - 1)}
            disabled={page <= 1 || loading}
            className="px-3 py-1 rounded text-xs bg-ink/5 text-ink-soft disabled:opacity-40 hover:bg-ink/10 transition-colors"
          >
            ← Prev
          </button>
          <span className="text-xs text-ink-soft/60">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => fetchPage(page + 1)}
            disabled={page >= totalPages || loading}
            className="px-3 py-1 rounded text-xs bg-ink/5 text-ink-soft disabled:opacity-40 hover:bg-ink/10 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
