/**
 * FIX-751 — registry-driven ledger column model (decision 2). Each kind's
 * column set derives from BROWSE_REGISTRY[kind].ledger; the all-kinds scope
 * gets a generic KIND/NAME/DETAIL/CONN set. Header sorts map onto the keyset
 * BrowseSort modes — never client-side re-sorts.
 */

import type { ReactNode } from "react";
import type { BrowseKind, BrowseRow, BrowseSort } from "@/lib/browse/types";
import { BROWSE_REGISTRY, ledgerColumnsFor, sortsFor } from "@/lib/browse/registry";
import { SyntheticMark } from "../../../components/integrity/Synthetic";
import { Chip, chipVariantFor } from "./Chip";
import { formatAgeCompact, formatDollarsCompact, initials, titleizeValue } from "./format";

export interface LedgerColumn {
  id: string;
  header: string;
  align?: "right";
  /** Sort applied on header click; sortAlt is the toggle partner (name asc⇄desc). */
  sort?: BrowseSort;
  sortAlt?: BrowseSort;
  width?: string;
  render: (row: BrowseRow) => ReactNode;
}

function NameCell({ row, withPhoto }: { row: BrowseRow; withPhoto: boolean }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      {withPhoto && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-term-line bg-paper-2 font-mono text-[8px] font-semibold text-ink-soft">
          {row.photo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={row.photo_url} alt="" width={20} height={20} loading="lazy" decoding="async" className="h-5 w-5 object-cover" />
            : initials(row.display_name)}
        </span>
      )}
      <span className="truncate text-ink">{row.display_name}</span>
      {row.is_synthetic && <SyntheticMark size="xs" className="shrink-0" />}
    </span>
  );
}

const DIM = "text-ink-soft";

/** Facet-column cell (party gets a chip; the rest render as dim titleized text). */
function facetCell(key: string) {
  return function FacetCell(row: BrowseRow) {
    const value = row.facets[key];
    if (!value) return <span className={DIM}>—</span>;
    if (key === "party") {
      return <Chip variant={chipVariantFor("party", value)}>{value.slice(0, 3).toUpperCase()}</Chip>;
    }
    if (key === "status") {
      return <Chip variant={chipVariantFor("status", value)}>{titleizeValue(value)}</Chip>;
    }
    if (key === "state") return <span className="font-mono text-ink">{value.toUpperCase()}</span>;
    return <span className={`${DIM} truncate`}>{titleizeValue(value)}</span>;
  };
}

const FACET_HEADERS: Record<string, string> = {
  party: "PARTY",
  state: "STATE",
  chamber: "CHAMBER",
  jurisdiction_level: "LEVEL",
  status: "STATUS",
  proposal_type: "TYPE",
  initiative_stage: "STAGE",
  agency_type: "TYPE",
  financial_type: "TYPE",
  industry: "INDUSTRY",
  institution_type: "TYPE",
};

function has(sorts: BrowseSort[], s: BrowseSort): BrowseSort | undefined {
  return sorts.includes(s) ? s : undefined;
}

/** Column defs for a kind (null = all-kinds generic set). */
export function ledgerColumnDefs(kind: BrowseKind | null): LedgerColumn[] {
  // All-kinds sorts are restricted to what is meaningful across kinds.
  const sorts: BrowseSort[] = kind ? sortsFor(kind) : ["connections_desc", "name_asc", "name_desc"];

  const cols: LedgerColumn[] = [];

  if (!kind) {
    cols.push({
      id: "kind",
      header: "KIND",
      width: "w-[92px]",
      render: (row) => <Chip>{BROWSE_REGISTRY[row.kind].label.toUpperCase()}</Chip>,
    });
  }

  const ledger = kind ? ledgerColumnsFor(kind) : ["display_name", "secondary_label", "connection_count", "activity_at"];
  const withPhoto = ledger.includes("photo_url");

  cols.push({
    id: "name",
    header: "NAME",
    sort: has(sorts, "name_asc"),
    sortAlt: has(sorts, "name_desc"),
    render: (row) => <NameCell row={row} withPhoto={withPhoto} />,
  });

  cols.push({
    id: "detail",
    header: "DETAIL",
    render: (row) => <span className={`${DIM} block max-w-[240px] truncate`}>{row.secondary_label ?? "—"}</span>,
  });

  for (const col of ledger) {
    if (col in FACET_HEADERS) {
      cols.push({ id: col, header: FACET_HEADERS[col] as string, render: facetCell(col) });
    }
  }

  if (ledger.includes("amount_cents")) {
    cols.push({
      id: "amount",
      header: "AMOUNT",
      align: "right",
      sort: has(sorts, "amount_desc"),
      render: (row) => (
        <span className="font-mono tabular-nums text-ink">
          {row.amount_cents != null && row.amount_cents > 0 ? formatDollarsCompact(row.amount_cents) : <span className={DIM}>—</span>}
        </span>
      ),
    });
  }

  cols.push({
    id: "conn",
    header: "CONN",
    align: "right",
    sort: has(sorts, "connections_desc"),
    render: (row) => (
      <span className={`font-mono tabular-nums ${DIM}`}>{row.connection_count > 0 ? row.connection_count.toLocaleString() : "—"}</span>
    ),
  });

  if (ledger.includes("activity_at")) {
    cols.push({
      id: "activity",
      header: "LAST ACTION",
      align: "right",
      sort: has(sorts, "recent"),
      // Relative age computed at render → server/client drift is possible on a
      // leaf text node only; decision 10 keeps this bare-age (no feed text).
      render: (row) => (
        <span suppressHydrationWarning className={`font-mono tabular-nums ${DIM}`}>{formatAgeCompact(row.activity_at)}</span>
      ),
    });
  }

  if (ledger.includes("primary_source")) {
    cols.push({
      id: "source",
      header: "SOURCE",
      render: (row) => <span className={`${DIM} block max-w-[110px] truncate font-mono text-[10.5px]`}>{row.primary_source ?? "—"}</span>,
    });
  }

  return cols;
}
