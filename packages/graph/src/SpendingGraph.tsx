"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { SpendingOptions } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgencyRow {
  id: string;
  name: string;
  acronym: string;
  total_cents: number;
  award_count: number;
}

interface SectorRow {
  sector: string;
  total_cents: number;
  award_count: number;
}

interface ChordData {
  agencies: AgencyRow[];
  sectors: SectorRow[];
  total_cents: number;
}

interface RecipientRow {
  entity_id: string;
  entity_name: string;
  industry: string;
  naics_code: string | null;
  total_cents: number;
  award_count: number;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtMoney(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000_000) return `$${(d / 1_000_000_000).toFixed(1)}B`;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

// ── Mini bar component ────────────────────────────────────────────────────────

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="flex-1 h-2 rounded-full bg-term-panel overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.max(pct * 100, 1)}%`, backgroundColor: color }}
      />
    </div>
  );
}

// ── Empty / Loading states ─────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-ink-soft">
      <svg className="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
      <p className="text-sm font-medium">No contract data yet</p>
      <p className="text-xs mt-1 opacity-60">Run the USASpending pipeline to populate contract flows.</p>
    </div>
  );
}

// FIX-838: the /api/graph/spending RPCs now 502 on failure/timeout (instead of a
// swallowed empty 200 the CDN pinned for an hour). Render a distinct "couldn't
// load" state rather than the misleading "no data yet" — a refresh retries.
function ErrorState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-ink-soft">
      <svg className="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
      </svg>
      <p className="text-sm font-medium">Couldn&apos;t load contract flows</p>
      <p className="text-xs mt-1 opacity-60">The data service is busy — refresh to try again.</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-16 h-3 bg-term-line rounded" />
          <div className="flex-1 h-2 bg-term-line rounded" />
          <div className="w-12 h-3 bg-term-line rounded" />
        </div>
      ))}
    </div>
  );
}

// ── NAICS sector colors ───────────────────────────────────────────────────────

// Token strings (FIX-729) — this component is HTML-only (style= / gradients),
// so the browser resolves the var() strings directly; no resolveColor needed.
// Hex→token mapping matches SankeyGraph's so shared hues stay consistent.
const SECTOR_COLORS: Record<string, string> = {
  'Manufacturing':          'rgb(var(--c-viz-4))',     // was blue → civic blue
  'Professional Services':  'rgb(var(--c-viz-7))',     // was violet → wine
  'Information Technology': 'rgb(var(--c-viz-2))',     // was cyan → teal
  'Construction':           'rgb(var(--c-amber))',     // was amber
  'Healthcare':             'rgb(var(--c-green-ink))', // was emerald
  'Transportation':         'rgb(var(--c-viz-6))',     // was orange → terracotta
  'Finance':                'rgb(var(--c-blue))',      // was indigo → blue
  'Administrative Services':'rgb(var(--c-viz-8))',     // was lime → olive
  'Government':             'rgb(var(--c-viz-5))',     // was slate → steel-slate
  'Education':              'rgb(var(--c-viz-9))',     // was pink → bronze
  'Agriculture':            'rgb(var(--c-viz-1))',     // was green
  'Wholesale Trade':        'rgb(var(--c-viz-7))',     // was violet-400 → wine
  'Utilities':              'rgb(var(--c-viz-3))',     // was amber-400 → ochre-gold
  'Other Services':         'rgb(var(--c-ink-soft))',  // neutral
  'Other':                  'rgb(var(--c-viz-5))',     // was slate → steel-slate
};

function sectorColor(sector: string): string {
  return SECTOR_COLORS[sector] ?? 'rgb(var(--c-viz-5))';
}

// ── Main component ────────────────────────────────────────────────────────────

export interface SpendingGraphProps {
  className?: string;
  svgRef?: React.RefObject<SVGSVGElement>;
  vizOptions?: Partial<SpendingOptions>;
}

const DEFAULTS: SpendingOptions = {
  topAgencies: 8,
  topRecipients: 20,
  minFlowUsd: 0,
  showSectors: true,
};

export function SpendingGraph({ className = "", vizOptions }: SpendingGraphProps) {
  const [chord, setChord]           = useState<ChordData | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const topAgenciesN  = vizOptions?.topAgencies   ?? DEFAULTS.topAgencies;
  const topRecipientsN = vizOptions?.topRecipients ?? DEFAULTS.topRecipients;
  const minFlowUsd    = vizOptions?.minFlowUsd    ?? DEFAULTS.minFlowUsd;
  const showSectors   = vizOptions?.showSectors   ?? DEFAULTS.showSectors ?? true;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    // FIX-838: check res.ok — the route now 502s on RPC failure/timeout rather
    // than returning a swallowed empty 200. A non-ok status must surface as an
    // error (a distinct "couldn't load" state), never be .json()'d into the
    // recipients/chord shape (which would crash the render on .filter/.map).
    const getJson = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      return r.json();
    };

    // Pull a generous slice from the API so the user can re-rank client-side
    // via topN sliders without refetching.
    Promise.all([
      getJson("/api/graph/spending?type=chord"),
      getJson("/api/graph/spending?type=treemap&lim=100"),
    ])
      .then(([chordData, treemapData]) => {
        if (cancelled) return;
        setChord(chordData as ChordData);
        setRecipients((treemapData as RecipientRow[]) ?? []);
      })
      .catch((e) => { if (!cancelled) { console.error(e); setLoadError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

  // Apply min-flow + topN filters client-side. minFlowUsd applies to each row's
  // aggregate total_cents (i.e. agency total, sector total, recipient total) —
  // it's a "hide small buckets" filter, not a per-contract filter.
  const minFlowCents = minFlowUsd * 100;

  const topAgencies = useMemo(() => {
    if (!chord) return [];
    return chord.agencies
      .filter(a => a.total_cents >= minFlowCents)
      .slice(0, topAgenciesN);
  }, [chord, minFlowCents, topAgenciesN]);

  const topSectors = useMemo(() => {
    if (!chord || !showSectors) return [];
    return chord.sectors
      .filter(s => s.total_cents >= minFlowCents)
      .slice(0, topAgenciesN);
  }, [chord, minFlowCents, topAgenciesN, showSectors]);

  const visibleRecipients = useMemo(() => {
    return recipients
      .filter(r => r.total_cents >= minFlowCents)
      .slice(0, topRecipientsN);
  }, [recipients, minFlowCents, topRecipientsN]);

  const hasData = !loading && chord && (topAgencies.length > 0 || visibleRecipients.length > 0);

  const maxAgency   = topAgencies[0]?.total_cents ?? 1;
  const maxSector   = topSectors[0]?.total_cents ?? 1;
  const maxRecipient = visibleRecipients[0]?.total_cents ?? 1;

  return (
    <div
      id="spending-panel"
      ref={panelRef}
      className={`flex flex-col h-full bg-term-bg text-ink overflow-auto ${className}`}
    >
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-rule flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">Government Contract Flows</h2>
          <p className="text-[11px] text-ink-soft mt-0.5">USASpending · procurement contracts &gt;$1M · current FY</p>
        </div>
        {chord && chord.total_cents > 0 && (
          <span className="text-lg font-bold text-green-ink">{fmtMoney(chord.total_cents)}</span>
        )}
      </div>

      {loading && <Skeleton />}
      {!loading && !hasData && (loadError ? <ErrorState /> : <EmptyState />)}

      {hasData && (
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-rule">

            {/* ── Left: Agency breakdown + Sector breakdown ── */}
            <div className="p-5 space-y-6">

              {/* By Agency */}
              {topAgencies.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold text-ink-soft uppercase tracking-widest mb-3">
                    By Agency
                  </h3>
                  <div className="space-y-2">
                    {topAgencies.map(ag => (
                      <div key={ag.id} className="flex items-center gap-3">
                        <span className="text-[11px] text-ink w-12 shrink-0 truncate" title={ag.name}>
                          {ag.acronym}
                        </span>
                        <Bar pct={ag.total_cents / maxAgency} color="rgb(var(--c-viz-4))" />
                        <span className="text-[11px] font-semibold text-ink tabular-nums w-14 text-right shrink-0">
                          {fmtMoney(ag.total_cents)}
                        </span>
                        <span className="text-[10px] text-ink-soft w-10 text-right shrink-0 tabular-nums">
                          {ag.award_count.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* By Sector */}
              {showSectors && topSectors.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold text-ink-soft uppercase tracking-widest mb-3">
                    By Sector (NAICS)
                  </h3>
                  <div className="space-y-2">
                    {topSectors.map(sc => (
                      <div key={sc.sector} className="flex items-center gap-3">
                        <span className="text-[11px] text-ink w-32 shrink-0 truncate" title={sc.sector}>
                          {sc.sector}
                        </span>
                        <Bar pct={sc.total_cents / maxSector} color={sectorColor(sc.sector)} />
                        <span className="text-[11px] font-semibold text-ink tabular-nums w-14 text-right shrink-0">
                          {fmtMoney(sc.total_cents)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* ── Right: Top recipients ── */}
            <div className="p-5">
              <h3 className="text-[10px] font-semibold text-ink-soft uppercase tracking-widest mb-3">
                Top Recipients
              </h3>
              {visibleRecipients.length === 0 ? (
                <p className="text-xs text-ink-soft">No recipient data yet.</p>
              ) : (
                <div className="space-y-2">
                  {visibleRecipients.map((r, i) => (
                    <div key={r.entity_id} className="flex items-center gap-3">
                      <span className="text-[10px] text-term-faint w-4 shrink-0 tabular-nums">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-medium text-ink truncate" title={r.entity_name}>
                          {r.entity_name}
                        </p>
                        {r.industry && r.industry !== 'Other' && (
                          <p className="text-[10px] text-ink-soft">{r.industry}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <span
                          className="inline-block w-24 h-1.5 rounded-full"
                          style={{
                            background: `linear-gradient(to right, ${sectorColor(r.industry)} ${Math.round((r.total_cents / maxRecipient) * 100)}%, rgb(var(--c-term-panel)) 0%)`,
                          }}
                        />
                      </div>
                      <span className="text-[11px] font-semibold text-ink tabular-nums w-14 text-right shrink-0">
                        {fmtMoney(r.total_cents)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
