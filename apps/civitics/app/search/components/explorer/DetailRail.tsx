"use client";

/**
 * FIX-751 — right detail rail. Data source stays /api/search/entity this wave
 * (decision 7); what's new are the PIVOT links — each pivot is just another
 * BrowseState (same scope, one facet swapped in), compiled purely from the
 * registry facets the row carries. No shared-donors pivot (no cheap query).
 *
 * Graph-seed gating mirrors the old SearchDetailPanel: registry graphSeedable
 * plus the FIX-490 municipal-institution degrade via detail.meta.Type.
 */

import { useEffect, useState } from "react";
import type { BrowseRow } from "@/lib/browse/types";
import { BROWSE_REGISTRY } from "@/lib/browse/registry";
import {
  attributionDetailEndpoint,
  type AttributionEntityType,
  type AttributionShape,
} from "@civitics/db";
import { SourceBadge } from "../../../components/SourceBadge";
import { SourceDetailPopover } from "../../../components/SourceDetailPopover";
import { SyntheticMark } from "../../../components/integrity/Synthetic";
import { initials, titleizeValue } from "./format";

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
  primary_source?: string | null;
  primary_source_url?: string | null;
}

// FIX-473 — browse kinds → attribution entity-type (only column-bearing types).
const KIND_TO_ATTRIBUTION_TYPE: Record<string, AttributionEntityType> = {
  official:  "official",
  proposal:  "proposal",
  agency:    "agency",
  financial: "financial_entity",
  institution: "governing_body",
};

const PARTY_TEXT: Record<string, string> = {
  democrat:    "text-civic-blue",
  republican:  "text-accent",
  independent: "text-viz-7",
};

export function DetailRail({
  row, onPivot, onSeedToGraph, onAddToSelection, isSelected,
}: {
  row: BrowseRow | null;
  onPivot: (key: string, value: string) => void;
  onSeedToGraph: (row: BrowseRow) => void;
  onAddToSelection: (row: BrowseRow) => void;
  isSelected: boolean;
}) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!row) { setDetail(null); return; }
    setLoading(true);
    setDetail(null);
    const controller = new AbortController();
    fetch(`/api/search/entity?id=${row.entity_id}&type=${row.kind}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EntityDetail | null) => {
        if (!controller.signal.aborted) { setDetail(data); setLoading(false); }
      })
      .catch(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [row]);

  if (!row) {
    return (
      <div className="flex h-full flex-col items-center justify-center border-l border-rule bg-card px-6 text-center">
        <div className="mb-3 text-3xl text-ink-soft/40">◎</div>
        <p className="font-mono text-[12px] text-ink-soft">Select any row to see details</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto border-l border-rule bg-card px-4 py-4">
      {loading || !detail ? (
        <DetailSkeleton />
      ) : (
        <DetailContent
          detail={detail}
          row={row}
          onPivot={onPivot}
          onSeedToGraph={onSeedToGraph}
          onAddToSelection={onAddToSelection}
          isSelected={isSelected}
        />
      )}
    </div>
  );
}

function DetailContent({
  detail, row, onPivot, onSeedToGraph, onAddToSelection, isSelected,
}: {
  detail: EntityDetail;
  row: BrowseRow;
  onPivot: (key: string, value: string) => void;
  onSeedToGraph: (row: BrowseRow) => void;
  onAddToSelection: (row: BrowseRow) => void;
  isSelected: boolean;
}) {
  const kindDef = BROWSE_REGISTRY[row.kind];

  // FIX-490 — municipal institutions are outside the graph-expansion allowlist;
  // degrade the seed affordance client-side on the detail endpoint's gb-type tell.
  const gbType = row.kind === "institution" ? String(detail.meta?.Type ?? "") : "";
  const gbNotExpandable = gbType === "municipal council" || gbType === "other";
  const seedable = kindDef.graphSeedable && !gbNotExpandable;

  const attributionType = KIND_TO_ATTRIBUTION_TYPE[row.kind];
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

  // Registry-facet pivots: one per facet key the row carries a value for.
  const pivots = kindDef.facets
    .map((def) => ({ def, value: row.facets[def.key] }))
    .filter((p): p is { def: (typeof kindDef.facets)[number]; value: string } => Boolean(p.value));

  return (
    <>
      {/* Header */}
      <div className="flex h-[54px] w-[54px] items-center justify-center overflow-hidden rounded-[2px] border border-term-line bg-paper-2 font-mono text-[16px] text-ink-soft">
        {detail.photo_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={detail.photo_url} alt={detail.name} width={54} height={54} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          : initials(detail.name)}
      </div>
      <h3 className="mt-2.5 font-serif text-[17px] font-semibold leading-snug text-ink">
        {detail.name}
        {row.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
      </h3>
      <p className="mb-3 mt-1 font-mono text-[11.5px] text-ink-soft">{detail.subtitle}</p>
      {attribution && attributionType && (
        <div className="mb-3">
          <SourceDetailPopover entityType={attributionType} entityId={detail.id} attribution={attribution}>
            <SourceBadge attribution={attribution} variant="pill" />
          </SourceDetailPopover>
        </div>
      )}

      {/* Meta rows */}
      <div className="border-t border-rule">
        {detail.party && (
          <MetaRow label="PARTY">
            <span className={PARTY_TEXT[detail.party] ?? "text-ink"}>{titleizeValue(detail.party)}</span>
          </MetaRow>
        )}
        <MetaRow label="CONNECTIONS">
          <span className="tabular-nums">{detail.connection_count.toLocaleString()}</span>
        </MetaRow>
        {detail.meta && Object.entries(detail.meta).map(([k, v]) =>
          v != null ? (
            <MetaRow key={k} label={k.replace(/_/g, " ").toUpperCase()}>{String(v)}</MetaRow>
          ) : null,
        )}
      </div>

      {detail.description && (
        <p className="mt-3 line-clamp-4 text-[11.5px] leading-relaxed text-ink-soft">{detail.description}</p>
      )}

      {/* Pivots */}
      {pivots.length > 0 && (
        <>
          <h6 className="mb-1.5 mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft/60">Pivot</h6>
          {pivots.map(({ def, value }) => (
            <button
              key={def.key}
              onClick={() => onPivot(def.key, value)}
              className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-[2px] border border-term-line px-2 py-1.5 text-left font-mono text-[11.5px] text-ink-soft transition-colors hover:border-amber/50 hover:text-amber focus-visible:outline-none focus-visible:border-accent focus-visible:text-accent"
            >
              <span className="min-w-0 truncate">Same {def.label.toLowerCase()}: {titleizeValue(value)}</span>
              <span aria-hidden>›</span>
            </button>
          ))}
        </>
      )}

      {/* Actions */}
      <div className="mt-auto flex flex-col gap-1.5 pt-4">
        <a
          href={detail.profile_url}
          className="rounded-[2px] border border-green-ink/50 bg-green-ink/5 px-3 py-2 text-center font-mono text-[11.5px] font-medium text-green-ink transition-colors hover:bg-green-ink/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-ink"
        >
          OPEN RECORD →
        </a>
        {seedable ? (
          <>
            <button
              onClick={() => onSeedToGraph(row)}
              className="rounded-[2px] border border-term-line px-3 py-2 font-mono text-[11.5px] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              SEED GRAPH ◉
            </button>
            <button
              onClick={() => onAddToSelection(row)}
              className="rounded-[2px] border border-term-line px-3 py-2 font-mono text-[11.5px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {isSelected ? "− REMOVE FROM SELECTION" : "+ ADD TO SELECTION"}
            </button>
          </>
        ) : (
          <p className="px-2 py-1.5 text-center font-mono text-[10.5px] text-ink-soft">
            {gbNotExpandable
              ? "This institution isn’t graph-expandable yet."
              : "This kind can’t be shown on the graph yet."}
          </p>
        )}
      </div>
    </>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule/50 py-1.5 font-mono text-[11.5px]">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-ink-soft/60">{label}</span>
      <span className="min-w-0 truncate text-right text-ink">{children}</span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-3 motion-reduce:animate-none" aria-hidden>
      <div className="h-[54px] w-[54px] rounded-[2px] bg-rule/50" />
      <div className="h-4 w-3/4 rounded-[2px] bg-rule/50" />
      <div className="h-3 w-1/2 rounded-[2px] bg-rule/50" />
      <div className="h-px bg-rule/50" />
      <div className="h-3 w-full rounded-[2px] bg-rule/50" />
      <div className="h-3 w-2/3 rounded-[2px] bg-rule/50" />
    </div>
  );
}
