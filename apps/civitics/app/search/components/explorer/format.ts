/**
 * FIX-751 — explorer display helpers. Compact terminal-idiom formatting for
 * the ledger/cards/facet surfaces. Money/number formats mirror the old
 * SearchResultCard helpers; the compact relative time is W1-specific ("2d",
 * no "ago" — decision 10 renders LAST ACTION as bare relative age).
 */

import type { BrowseRow } from "@/lib/browse/types";

/** Stable selection/detail key for a browse row. */
export function rowKey(row: BrowseRow): string {
  return `${row.kind}:${row.entity_id}`;
}

export function formatDollarsCompact(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000_000) return `$${(d / 1_000_000_000).toFixed(1)}B`;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

export function formatCountCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Bare compact age ("2h", "3d", "5mo") — LAST ACTION column, decision 10. */
export function formatAgeCompact(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "soon";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** "open_comment" → "Open comment" — generic enum-value display. */
export function titleizeValue(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}
