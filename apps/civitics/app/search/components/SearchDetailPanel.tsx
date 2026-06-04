"use client";

import { useEffect, useState } from "react";
import type { AnySearchResult } from "./SearchResultCard";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";
import {
  attributionDetailEndpoint,
  type AttributionEntityType,
  type AttributionShape,
} from "@civitics/db";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityDetail {
  id: string;
  type: string;
  name: string;
  subtitle: string;
  photo_url?: string | null;
  party?: string | null;
  description?: string | null;
  connection_count: number;
  profile_url: string;
  meta?: Record<string, string | number | null>;
  // FIX-473 — list-endpoint attribution (primary source only; popover lazy-loads
  // the full list). Null when the entity's table row carries no primary_source.
  primary_source?: string | null;
  primary_source_url?: string | null;
}

// FIX-473 — search kinds → attribution entity-type (only column-bearing types).
const KIND_TO_ATTRIBUTION_TYPE: Record<string, AttributionEntityType> = {
  official:  "official",
  proposal:  "proposal",
  agency:    "agency",
  financial: "financial_entity",
  institution: "governing_body",
};

const PARTY_COLOR: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-700",
  republican:  "bg-red-100 text-red-700",
  independent: "bg-purple-100 text-purple-700",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function formatDollars(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// SearchDetailPanel
// ---------------------------------------------------------------------------

interface SearchDetailPanelProps {
  result: AnySearchResult | null;
  onSeedToGraph: (result: AnySearchResult) => void;
}

export function SearchDetailPanel({ result, onSeedToGraph }: SearchDetailPanelProps) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!result) { setDetail(null); return; }

    setLoading(true);
    setDetail(null);

    const controller = new AbortController();
    fetch(`/api/search/entity?id=${result.data.id}&type=${result.kind}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EntityDetail | null) => {
        if (!controller.signal.aborted) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [result]);

  if (!result) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 border-l border-gray-200 bg-white">
        <div className="text-3xl mb-3 text-gray-200">◎</div>
        <p className="text-sm text-gray-400">Click any result to see details</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white overflow-hidden">
      {loading || !detail ? (
        <DetailSkeleton />
      ) : (
        <DetailContent detail={detail} result={result} onSeedToGraph={onSeedToGraph} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail content
// ---------------------------------------------------------------------------

function DetailContent({
  detail,
  result,
  onSeedToGraph,
}: {
  detail: EntityDetail;
  result: AnySearchResult;
  onSeedToGraph: (result: AnySearchResult) => void;
}) {
  const partyBadge = detail.party ? (PARTY_COLOR[detail.party] ?? "bg-gray-100 text-gray-600") : null;

  // FIX-472 — only offer "Seed to graph" for kinds the graph can render.
  const seedable = isGraphSeedableKind(result.kind);

  // FIX-473 — build a primary-only AttributionShape from the list-endpoint
  // fields; SourceBadge renders nothing when primary is null, and the popover
  // lazy-loads the full source list from detail_endpoint on open.
  const attributionType = KIND_TO_ATTRIBUTION_TYPE[result.kind];
  const attribution: AttributionShape | null =
    attributionType && detail.primary_source
      ? {
          primary: {
            source:       detail.primary_source,
            source_url:   detail.primary_source_url ?? null,
            last_seen_at: "",
          },
          source_count:    0,
          detail_endpoint: attributionDetailEndpoint(attributionType, detail.id),
        }
      : null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="flex-shrink-0 h-12 w-12 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center text-sm font-semibold text-gray-600">
            {detail.photo_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={detail.photo_url} alt={detail.name} width={48} height={48} loading="lazy" decoding="async" className="h-12 w-12 object-cover" />
              : initials(detail.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 leading-snug">{detail.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{detail.subtitle}</p>
            {partyBadge && (
              <span className={`inline-block mt-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${partyBadge}`}>
                {detail.party}
              </span>
            )}
            {/* FIX-473 — data-provenance pill (renders nothing when no primary source) */}
            {attribution && attributionType && (
              <div className="mt-1.5">
                <SourceDetailPopover
                  entityType={attributionType}
                  entityId={detail.id}
                  attribution={attribution}
                >
                  <SourceBadge attribution={attribution} variant="pill" />
                </SourceDetailPopover>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 py-3 space-y-2 border-b border-gray-100">
        <StatRow label="Connections" value={detail.connection_count.toLocaleString()} />
        {detail.meta && Object.entries(detail.meta).map(([k, v]) =>
          v != null ? <StatRow key={k} label={k} value={String(v)} /> : null
        )}
      </div>

      {/* Description / AI summary */}
      {detail.description && (
        <div className="px-4 py-3 border-b border-gray-100">
          <p className="text-xs text-gray-600 leading-relaxed line-clamp-4">{detail.description}</p>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-3 space-y-2 mt-auto">
        <a
          href={detail.profile_url}
          className="flex items-center justify-center gap-1.5 w-full rounded-md border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:text-indigo-700 transition-colors"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          View full profile
        </a>
        {seedable ? (
          <button
            onClick={() => onSeedToGraph(result)}
            className="flex items-center justify-center gap-1.5 w-full rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Seed to graph
          </button>
        ) : (
          <p className="text-center text-[11px] text-gray-400 px-2 py-1.5">
            This kind can&apos;t be shown on the graph yet.
          </p>
        )}
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-gray-400 capitalize">{label.replace(/_/g, " ")}</span>
      <span className="text-[11px] font-medium text-gray-700">{value}</span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="px-4 py-4 space-y-3 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-full bg-gray-100 shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3.5 bg-gray-100 rounded w-3/4" />
          <div className="h-3 bg-gray-100 rounded w-1/2" />
        </div>
      </div>
      <div className="h-px bg-gray-100" />
      <div className="space-y-2">
        <div className="h-3 bg-gray-100 rounded w-full" />
        <div className="h-3 bg-gray-100 rounded w-2/3" />
      </div>
    </div>
  );
}
