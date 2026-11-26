import { cache } from "react";
import { createPublicClient, fetchAttributionForEntity, type AttributionShape } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import type { BillDetails } from "@/lib/proposal-detail/identity";

// React.cache() dedupes within a single request. generateMetadata() and the
// page component both fetch the proposal row; without this wrapper, that's
// two identical Supabase round-trips per page render. Keep the column lists
// the union of what either caller needs so the cache hit is always a hit.
//
// Uses the publishable-key public client (not createServerClient(cookies))
// so the page can opt into ISR with `export const revalidate = N` without
// being forced dynamic by reading cookies.

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
  bill_details: BillDetails | null;
  attribution: AttributionShape;
};

export const getCachedProposal = cache(
  async (id: string): Promise<CachedProposalRow | null> => {
    const supabase = createPublicClient();
    const { data } = await withDbTimeout(
      supabase
        .from("proposals")
        .select("id,title,type,status,summary_plain,introduced_at,last_action_at,external_url,primary_source,metadata,is_synthetic,bill_details(bill_number,chamber,congress_number,congress_gov_url)")
        .eq("id", id)
        .single(),
      3000,
      "proposals:detail-row",
    );
    if (!data) return null;
    const row = data as unknown as Omit<CachedProposalRow, "attribution" | "bill_details"> & {
      bill_details: BillDetails | BillDetails[] | null;
    };
    const bd = Array.isArray(row.bill_details) ? (row.bill_details[0] ?? null) : row.bill_details;
    const attribution = await fetchAttributionForEntity(supabase, "proposal", id);
    return { ...row, bill_details: bd, attribution };
  }
);
