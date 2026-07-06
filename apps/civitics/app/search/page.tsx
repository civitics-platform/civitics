export const dynamic = "force-dynamic";

/**
 * /search — the W1 Explorer (FIX-751). Params resolve server-side: legacy
 * URLs (?q=…&type=…&party=… — the pre-W1 SearchFilters grammar) translate
 * into BrowseState (FIX-752) so existing links, nav, and GlobalSearch
 * "view all" keep working; new-grammar URLs (scope=/f_*) parse directly.
 *
 * The first browse read is SSR'd through the same executeBrowse core the
 * /api/browse route uses, behind a hard time cap — a slow/degraded DB yields
 * initialData=null and the client fetches on mount instead of the render
 * hanging (cost defense; see CLAUDE.md → withDbTimeout rationale).
 */

import { PageViewTracker } from "../components/PageViewTracker";
import { ExplorerPage } from "./components/explorer/ExplorerPage";
import { resolveBrowseParams } from "@/lib/browse/legacy";
import { serializeBrowseState } from "@/lib/browse/browse-state";
import type { BrowseResponse } from "@/lib/browse/types";
import { executeBrowse } from "../api/browse/execute";

const SSR_TIMEOUT_MS = 5000;
const SSR_PAGE_LIMIT = 48; // mirror the client's page size so cursors line up

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) sp.append(key, v);
  }

  const { state } = resolveBrowseParams(sp);
  const viewParam = sp.get("view");
  const initialView = viewParam === "cards" ? "cards" as const : viewParam === "table" ? "table" as const : null;

  let initialData: BrowseResponse | null = null;
  try {
    const query = serializeBrowseState(state);
    query.set("limit", String(SSR_PAGE_LIMIT));
    const result = await Promise.race([
      executeBrowse(query),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_TIMEOUT_MS)),
    ]);
    if (result && result.status === 200) initialData = result.body as BrowseResponse;
  } catch {
    // Degrade to a client-side first fetch.
  }

  return (
    <>
      <PageViewTracker entityType="search" />
      <ExplorerPage initialState={state} initialView={initialView} initialData={initialData} />
    </>
  );
}
