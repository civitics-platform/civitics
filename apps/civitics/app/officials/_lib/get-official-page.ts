import { cache } from "react";
import { createPublicClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
// The pure classifier lives under src/ so the app test runner (src/**/*.test.ts)
// discovers it; this module keeps the side-effecting fetcher.
import type { PageEnvelope } from "@/lib/official-page-outcome";
export { classifyOfficialPage } from "@/lib/official-page-outcome";
export type { OfficialPageOutcome, PageEnvelope } from "@/lib/official-page-outcome";

/**
 * The consolidated page RPC (FIX-646), React.cache-shared across
 * `generateMetadata` and the page within one request — the same pattern as
 * `getCachedOfficial` and `getOfficialContentBearing`.
 *
 * WHY IT MOVED HERE, and what it costs. `robots: noindex` can only be set from
 * `generateMetadata`, and `generateMetadata` runs before the page body — so the
 * only way for a FAILED render to be noindexed is for the failure to be known
 * by then. That means the RPC has to be reachable from both, which means the
 * cached fetcher.
 *
 * The cost is honest and worth stating: the RPC used to sit inside the page's
 * `Promise.all` alongside the donor-rollup read, and now resolves in
 * `generateMetadata` first, so those two are sequential rather than parallel on
 * a cold render. That is the price of not indexing empty shells of real
 * officials. It is also the read FIX-1180 just cut by 40–48 % of its buffers,
 * which is what makes the trade payable now and would not have made it payable
 * before.
 *
 * FAILS LOUD, NOT OPEN — the opposite of `getOfficialContentBearing`, on
 * purpose. That one fails open because the cost of being wrong is hiding a real
 * official's sections. This one's failure IS the thing being detected, so
 * swallowing it would reintroduce exactly the bug.
 */
export const getCachedOfficialPage = cache(async (id: string): Promise<PageEnvelope> => {
  const supabase = createPublicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const res = (await withDbTimeout(
    sb.rpc("get_official_page", { p_id: id }) as PromiseLike<PageEnvelope>,
    5000,
    "officials:page-rpc",
  )) as PageEnvelope;
  if (res?.error) {
    // One line, greppable, with the id — no PII. A 57014 here is the visitor
    // seeing an empty record, so it should never be inferable only from a
    // Postgres log.
    const e = res.error as { code?: unknown; message?: unknown };
    console.error(
      `[officials:page-rpc] get_official_page FAILED for official_id=${id} ` +
        `code=${typeof e?.code === "string" ? e.code : "(none)"} ` +
        `message=${typeof e?.message === "string" ? e.message : String(res.error)}`,
    );
  }
  return res;
});
