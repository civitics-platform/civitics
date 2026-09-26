/**
 * FIX-1217 / FIX-1225 — the donor page's inbound side, from the FE inbound
 * rollup instead of a sample.
 *
 * The page used to read the top 1,000 inbound donation ROWS by amount and sum
 * them per donor here, so its top 50 was a sum over a sample (wrong for 94 of the
 * 328 clone recipients over 1,000 rows) and "Donors" was the sample's distinct
 * count (the RNC showed 837 against 125,567). It now reads
 * `financial_entity_inbound_rollup` (the true top 200 by sum, rank-ordered) and
 * `financial_entity_inbound_totals` (donor_count / tx_total / sum_total over the
 * same range), both maintained by run_fe_inbound_rollup() — migration
 * 20260926000000_fix1217_fe_inbound_rollup.sql.
 *
 * Pure, so the fold and the fallbacks are unit-tested without Next.
 */

/** One `financial_entity_inbound_rollup` row as the page selects it. */
export interface InboundRollupRow {
  from_id: string;
  total_cents: number;
  tx_count: number;
  rank: number;
}

/** The recipient's `financial_entity_inbound_totals` row, or null when it has none. */
export interface InboundTotals {
  donor_count: number;
  tx_total: number;
  sum_total: number;
  refreshed_at: string;
}

export interface DonorEntityInfo {
  display_name: string;
  entity_type: string;
}

export interface TopDonorRow {
  id: string;
  name: string;
  industry: string | null;
  donor_type: string;
  total_cents: number;
  count: number;
}

/**
 * The Top donors list: the rollup rows in rank order, named from the donor
 * lookups. Each row is already one donor's whole total — nothing is summed here.
 */
export function foldInboundRollup(
  rows: readonly InboundRollupRow[],
  donorInfo: ReadonlyMap<string, DonorEntityInfo>,
  industryLabelOf: (id: string) => string | null,
): TopDonorRow[] {
  return [...rows]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const info = donorInfo.get(r.from_id);
      return {
        id: r.from_id,
        name: info?.display_name ?? "Unknown",
        industry: industryLabelOf(r.from_id),
        donor_type: info?.entity_type ?? "other",
        total_cents: Number(r.total_cents) || 0,
        count: Number(r.tx_count) || 0,
      };
    });
}

/**
 * The "Donors" stat and its transaction note. A recipient with no totals row
 * reads 0 / 0: either it has no inbound donations, or it is new since the last
 * daily refresh (at most one cycle stale).
 */
export function inboundStats(totals: InboundTotals | null): { uniqueDonors: number; donorTxCount: number } {
  return {
    uniqueDonors: Number(totals?.donor_count ?? 0) || 0,
    donorTxCount: Number(totals?.tx_total ?? 0) || 0,
  };
}

/**
 * "Total received": the rollup's sum_total when the recipient has a totals row,
 * else `financial_entities.total_received_cents`. The FE column is the fallback,
 * not the source, because the unscoped PAC upsert zeroed it for committees
 * (FIX-1226) and only a changed FR row brings it back.
 */
export function totalReceivedCents(totals: InboundTotals | null, entityTotalReceivedCents: number | null | undefined): number {
  if (totals) return Number(totals.sum_total) || 0;
  return Number(entityTotalReceivedCents ?? 0) || 0;
}
