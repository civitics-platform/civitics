import { cache } from "react";
import { createPublicClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";

// FIX-683 — cheap per-official content signal. official_is_content_bearing(uuid)
// is true iff the official has >=1 vote / financial_relationship (as recipient) /
// entity_connection — index-backed (~0.14ms, 13 buffers). 64% of active officials
// are empty by this predicate and are the ones a crawl cold-reads through the
// heavy get_official_page RPC.
//
// React.cache() dedupes the single round-trip across generateMetadata (the empty
// -leaf noindex) and the page (the get_official_page skip) within one request,
// the same pattern as getCachedOfficial — and generateMetadata runs first, so the
// page's call is a warm cache hit (no extra latency on real official pages).
//
// FAIL OPEN: a timeout, error, or a freshly-deployed RPC's PostgREST schema-cache
// cold-start (which returns null) all resolve to TRUE — we never noindex or
// blank-shell a real official on uncertainty; only a DEFINITIVE false is treated
// as empty.
export const getOfficialContentBearing = cache(async (id: string): Promise<boolean> => {
  const supabase = createPublicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const { data, error } = await withDbTimeout(
    sb.rpc("official_is_content_bearing", { p_id: id }) as PromiseLike<{
      data: boolean | null;
      error: unknown;
    }>,
    3000,
    "officials:content-bearing",
  );
  if (error) return true;
  return data === false ? false : true;
});
