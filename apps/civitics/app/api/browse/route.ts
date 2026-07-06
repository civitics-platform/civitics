/**
 * GET /api/browse — Browse Program Wave 0 endpoint (FIX-749).
 *
 * Params: a serialized BrowseState (scope, q, sort, cursor, f_<key> facets),
 * plus `only=rows|facets` (FIX-752) to split row and facet-count fetching.
 * Response envelope: { rows, facets, totals, counts_mode, cursor, refreshed_at, query }.
 *
 * The query core lives in ./execute.ts (executeBrowse) so app/search/page.tsx
 * can run the same read for its SSR first paint (FIX-751); this handler owns
 * only the HTTP layer. Registry-validated params: unknown facet keys → 400.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { executeBrowse } from "./execute";

export async function GET(req: NextRequest) {
  const { status, body } = await executeBrowse(req.nextUrl.searchParams);

  if (status !== 200) {
    return NextResponse.json(body, { status });
  }

  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
  });
}
