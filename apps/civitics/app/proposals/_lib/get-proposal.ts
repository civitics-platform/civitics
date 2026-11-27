import { cache } from "react";
import { createPublicClient, fetchAttributionForEntity, type AttributionShape } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import type { BillDetails } from "@/lib/proposal-detail/identity";
import type { CongressRefRow, SponsorEmbed } from "@/lib/proposal-detail/bill-record";

// React.cache() dedupes within a single request. generateMetadata() and the
// page component both fetch the proposal row; without this wrapper, that's
// two identical Supabase round-trips per page render. Keep the column lists
// the union of what either caller needs so the cache hit is always a hit.
//
// Uses the publishable-key public client (not createServerClient(cookies))
// so the page can opt into ISR with `export const revalidate = N` without
// being forced dynamic by reading cookies.

/** FIX-1462 (cc-332 B1): the primary sponsor's official, one PK probe through bill_details_primary_sponsor_id_fkey. */
export type CachedBillDetails = BillDetails & { sponsor: SponsorEmbed };

export type CachedProposalRow = {
  id: string;
  title: string;
  type: string;
  status: string;
  summary_plain: string | null;
  introduced_at: string | null;
  last_action_at: string | null;
  external_url: string | null;
  primary_source: string | null;
  metadata: Record<string, string> | null;
  // SF-P2 (FIX-599): the proposal's own synthetic flag (entity marker).
  is_synthetic: boolean;
  // FIX-1447 (D5): the number, chamber, congress and congress.gov URL. An
  // embed over bill_details_proposal_id_fkey (one-to-one); null for a row
  // with no bill_details (regulations, court opinions, initiatives).
  bill_details: CachedBillDetails | null;
  attribution: AttributionShape;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export const getCachedProposal = cache(
  async (id: string): Promise<CachedProposalRow | null> => {
    const supabase = createPublicClient();
    const { data } = await withDbTimeout(
      supabase
        .from("proposals")
        .select("id,title,type,status,summary_plain,introduced_at,last_action_at,external_url,primary_source,metadata,is_synthetic,bill_details(bill_number,chamber,congress_number,congress_gov_url,sponsor:officials!bill_details_primary_sponsor_id_fkey(id,full_name))")
        .eq("id", id)
        .single(),
      3000,
      "proposals:detail-row",
    );
    if (!data) return null;
    type RawBillDetails = BillDetails & { sponsor: SponsorEmbed | SponsorEmbed[] };
    const row = data as unknown as Omit<CachedProposalRow, "attribution" | "bill_details"> & {
      bill_details: RawBillDetails | RawBillDetails[] | null;
    };
    const raw = one(row.bill_details);
    const bd = raw ? { ...raw, sponsor: one(raw.sponsor) } : null;
    const attribution = await fetchAttributionForEntity(supabase, "proposal", id);
    return { ...row, bill_details: bd, attribution };
  }
);

/**
 * FIX-1462 (cc-332 B1, B2): the proposal's congress_gov refs, `metadata.detail`
 * only — the bill-details walker's stamp. Cached so generateMetadata (the
 * heading in <title>) and the page share one read. Null when the read failed:
 * a failed read is never "not collected".
 */
export const getCachedCongressRefs = cache(
  async (id: string): Promise<CongressRefRow[] | null> => {
    const supabase = createPublicClient();
    const { data, error } = await withDbTimeout(
      supabase
        .from("external_source_refs")
        .select("external_id,detail:metadata->detail")
        .eq("entity_type", "proposal")
        .eq("entity_id", id)
        .eq("source", "congress_gov")
        .limit(5),
      3000,
      "proposals:detail-congress-ref",
    );
    if (error || !Array.isArray(data)) return null;
    return data as unknown as CongressRefRow[];
  }
);
