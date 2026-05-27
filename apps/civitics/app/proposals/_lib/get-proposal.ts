import { cache } from "react";
import { createPublicClient, fetchAttributionForEntity, type AttributionShape } from "@civitics/db";

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
  metadata: Record<string, string> | null;
  attribution: AttributionShape;
};

export const getCachedProposal = cache(
  async (id: string): Promise<CachedProposalRow | null> => {
    const supabase = createPublicClient();
    const { data } = await supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,introduced_at,metadata")
      .eq("id", id)
      .single();
    if (!data) return null;
    const attribution = await fetchAttributionForEntity(supabase, "proposal", id);
    return { ...(data as Omit<CachedProposalRow, "attribution">), attribution };
  }
);
