"use client";

/**
 * packages/graph/src/components/EdgeSheet.tsx — FIX-828
 *
 * Aggregate edge detail sheet for a money edge (donation / opposition /
 * contract_award). Slide-in over the right side of the canvas (the DonorListPanel
 * pattern). Everything shown is already in client graph state — NO new API route.
 *
 * The full per-pair FEC transaction ledger is a deferred paid-tier feature
 * (FIX-830): the teaser slot below is a muted one-liner with no paywall UI and no
 * dead button — it does nothing on purpose.
 */

import { CONNECTION_TYPE_REGISTRY } from "../connections";

export interface EdgeSheetData {
  fromId: string;
  fromName: string;
  fromType: string;
  toId: string;
  toName: string;
  toType: string;
  connectionType: string;
  amountUsd?: number;
  txCount?: number;
  occurredAt?: string;
}

export interface EdgeSheetProps extends EdgeSheetData {
  onClose: () => void;
}

/** Endpoint → profile route (mirrors NodePopup's link map). Null = no profile link. */
function profileHref(id: string, type: string): string | null {
  const raw = id.replace(/^[a-z_]+:/, "");
  switch (type) {
    case "official":
      return `/officials/${raw}`;
    case "financial":
    case "pac":
    case "corporation":
    case "individual":
      return `/donors/${raw}`;
    case "agency":
    case "organization":
      return `/institutions/${raw}`;
    case "proposal":
      return `/proposals/${raw}`;
    default:
      return null;
  }
}

function fmtUsd(usd: number): string {
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function Endpoint({ id, name, type }: { id: string; name: string; type: string }) {
  const href = profileHref(id, type);
  return (
    <div className="min-w-0">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-ink leading-tight hover:text-accent hover:underline truncate block"
        >
          {name} ↗
        </a>
      ) : (
        <div className="font-medium text-ink leading-tight truncate">{name}</div>
      )}
      <div className="text-[11px] text-ink-soft capitalize">{type}</div>
    </div>
  );
}

export function EdgeSheet({
  fromId,
  fromName,
  fromType,
  toId,
  toName,
  toType,
  connectionType,
  amountUsd,
  txCount,
  occurredAt,
  onClose,
}: EdgeSheetProps) {
  const label = CONNECTION_TYPE_REGISTRY[connectionType]?.label ?? connectionType.replace(/_/g, " ");
  const occurredLabel = occurredAt
    ? new Date(occurredAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="absolute inset-y-0 right-0 w-80 bg-card border-l border-rule shadow-2xl z-30 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule/60">
        <div className="min-w-0">
          <div className="font-semibold text-ink text-sm leading-tight truncate">Connection detail</div>
          <div className="text-xs text-ink-soft mt-0.5 truncate">{label}</div>
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 ml-2 text-ink-soft/60 hover:text-ink transition-colors text-lg leading-none"
          aria-label="Close connection detail"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Endpoints */}
        <div className="px-4 py-3 space-y-2">
          <Endpoint id={fromId} name={fromName} type={fromType} />
          <div className="pl-1 text-ink-soft text-xs">↓ {label.toLowerCase()}</div>
          <Endpoint id={toId} name={toName} type={toType} />
        </div>

        {/* Aggregate stats */}
        <div className="px-4 py-3 border-t border-rule/60 space-y-1.5 text-sm">
          {amountUsd != null && (
            <div className="flex justify-between">
              <span className="text-ink-soft">Total</span>
              <span className="font-semibold text-ink tabular-nums">{fmtUsd(amountUsd)}</span>
            </div>
          )}
          {txCount != null && (
            <div className="flex justify-between">
              <span className="text-ink-soft">Transactions</span>
              <span className="font-medium text-ink tabular-nums">{txCount.toLocaleString("en-US")}</span>
            </div>
          )}
          {/* occurred_at only when present — MV-sourced aggregate edges omit it. */}
          {occurredLabel && (
            <div className="flex justify-between">
              <span className="text-ink-soft">Date</span>
              <span className="font-medium text-ink">{occurredLabel}</span>
            </div>
          )}
        </div>

        {/* Source line */}
        <div className="px-4 py-2 border-t border-rule/60 text-[11px] text-ink-soft/80">
          Source: FEC — aggregated pair total
        </div>

        {/* Deferred paid-tier teaser (FIX-830) — muted, no button, no paywall UI. */}
        <div className="px-4 py-2 text-[11px] text-ink-soft/50 italic">
          Full transaction ledger — coming soon
        </div>
      </div>
    </div>
  );
}
