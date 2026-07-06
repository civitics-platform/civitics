/**
 * GET /api/browse — Browse Program Wave 0 endpoint (FIX-749).
 *
 * Params: a serialized BrowseState (scope, q, sort, cursor, f_<key> facets).
 * Response envelope: { rows, facets, totals, counts_mode, cursor, refreshed_at, query }.
 *
 * Reads the FIX-748 entity_search_index substrate (never a live COUNT/ILIKE seq
 * scan on the base tables):
 *  - rows        via get_browse_page (keyset over the (kind,<sort>,entity_id) btrees)
 *  - facets      via the browse_facet_counts rollup (un-narrowed kind-root → exact,
 *                fast) or get_browse_facets (any narrowing → exact on the index)
 *  - individuals via a capped financial_entities canonical_name trigram passthrough
 *                when the scope is financial AND a text query is present (page 1)
 *
 * No UI change in this wave — /api/search stays the source of truth for the
 * current page. Registry-validated params: unknown facet keys → 400.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { parseBrowseState } from "@/lib/browse/browse-state";
import { compileScope } from "@/lib/browse/scope-tree";
import { encodeCursor, decodeCursor } from "@/lib/browse/cursor";
import type {
  BrowseRow, BrowseResponse, BrowseCountsMode, BrowseKind, FacetMap, FacetValue,
} from "@/lib/browse/types";

const PAGE_SIZE = 24;
const MAX_PAGE = 50;
const INDIVIDUALS_PASSTHROUGH_LIMIT = 10;

/** Normalize a facet value (string | string[]) to a string[] for the jsonb param. */
function asArray(v: FacetValue): string[] {
  return Array.isArray(v) ? v : [v];
}

/** Merge scope-derived facets with explicit user facets (explicit wins), as jsonb arrays. */
function mergedFacetsJson(scopeFacets: FacetMap, explicit: FacetMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(scopeFacets)) out[k] = asArray(v);
  for (const [k, v] of Object.entries(explicit)) out[k] = asArray(v); // override
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const { state, kind, errors } = parseBrowseState(sp);

  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_browse_state", details: errors }, { status: 400 });
  }

  const pageSize = Math.min(
    Math.max(parseInt(sp.get("limit") ?? String(PAGE_SIZE)) || PAGE_SIZE, 1),
    MAX_PAGE,
  );

  // Scope predicates + explicit facets → the jsonb the RPCs filter on.
  const scope = compileScope(state.scope);
  const facetsJson = mergedFacetsJson(scope.facets, state.facets);
  const hasNarrowing = Object.keys(facetsJson).length > 0 || state.q.length > 0;

  const cursor = decodeCursor(state.cursor);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // ── Page rows (keyset) ──────────────────────────────────────────────────────
  const { data: pageData, error: pageErr } = await db.rpc("get_browse_page", {
    p_kind: kind,
    p_facets: facetsJson,
    p_q: state.q || null,
    p_sort: state.sort,
    p_cursor_value: cursor ? (cursor.sortValue === null ? null : String(cursor.sortValue)) : null,
    p_cursor_id: cursor ? cursor.entityId : null,
    p_limit: pageSize,
  });

  if (pageErr) {
    return NextResponse.json({ error: "browse_page_failed", details: pageErr.message }, { status: 500 });
  }

  const rawRows: Array<BrowseRow & { _sort_value: string | null }> = pageData?.rows ?? [];
  const hasMore: boolean = pageData?.has_more ?? false;

  const rows: BrowseRow[] = rawRows.map(({ _sort_value, ...r }) => r);

  // Next-page cursor from the last INDEX row (passthrough individuals never page).
  let nextCursor: string | null = null;
  const last = rawRows[rawRows.length - 1];
  if (hasMore && last) {
    nextCursor = encodeCursor({ sortValue: last._sort_value, entityId: last.entity_id });
  }

  // ── Financial-individual passthrough (page 1 only; decision 2) ──────────────
  // Individuals live outside the index (FIX-748 excludes ~4.9M of them). Reach
  // them via the FIX-238 canonical_name trigram. NOTE: a SQL `ORDER BY
  // total_donated_cents` here flips the planner to an ordered-index scan that
  // filters ILIKE over millions of rows and blows the 8s role cap — so fetch a
  // capped trigram-match set (guaranteed bitmap plan) and rank the top donors in
  // JS. Result: top-N by donation among the trigram matches, a capped supplement.
  if (kind === "financial" && state.q.length >= 2 && !cursor) {
    const { data: indivData } = await db
      .from("financial_entities")
      .select("id, display_name, total_donated_cents, is_synthetic")
      .eq("entity_type", "individual")
      .ilike("canonical_name", `%${state.q}%`)
      .limit(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const top = ((indivData ?? []) as any[])
      .sort((a, b) => (b.total_donated_cents ?? 0) - (a.total_donated_cents ?? 0))
      .slice(0, INDIVIDUALS_PASSTHROUGH_LIMIT);
    for (const f of top) {
      rows.push({
        kind: "financial",
        entity_id: f.id,
        display_name: f.display_name,
        secondary_label: "individual",
        photo_url: null,
        is_synthetic: f.is_synthetic ?? false,
        amount_cents: f.total_donated_cents ?? null,
        amount_label: "donation",
        connection_count: 0,
        activity_at: null,
        primary_source: "fec",
        facets: { financial_type: "individual" },
      });
    }
  }

  // ── Facet counts ────────────────────────────────────────────────────────────
  const facets: Record<string, Record<string, number>> = {};
  let totals: { count: number | null } = { count: null };
  let countsMode: BrowseCountsMode = "omitted";

  if (kind && !hasNarrowing) {
    // Un-narrowed kind-root browse → exact from the rollup (fast path).
    const { data: rollup } = await db
      .from("browse_facet_counts")
      .select("facet_key, facet_value, count")
      .eq("kind", kind);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (rollup ?? []) as any[]) {
      if (r.facet_key === "__total__") { totals = { count: Number(r.count) }; continue; }
      (facets[r.facet_key] ??= {})[r.facet_value] = Number(r.count);
    }
    countsMode = "exact";
  } else if (kind) {
    // Narrowed set → exact on the index via get_browse_facets; omit on failure.
    const { data: live, error: liveErr } = await db.rpc("get_browse_facets", {
      p_kind: kind,
      p_facets: facetsJson,
      p_q: state.q || null,
    });
    if (!liveErr && live) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = live as Record<string, any>;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "__total__") { totals = { count: Number(v) }; continue; }
        facets[k] = Object.fromEntries(Object.entries(v as Record<string, number>).map(([vv, c]) => [vv, Number(c)]));
      }
      countsMode = "exact";
    }
  }
  // kind === null (all-kinds scope): counts omitted for W0.

  // ── refreshed_at (when the substrate was last rebuilt) ──────────────────────
  let refreshedAt: string | null = null;
  {
    const { data: r } = await db
      .from("browse_facet_counts")
      .select("refreshed_at")
      .order("refreshed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    refreshedAt = r?.refreshed_at ?? null;
  }

  const body: BrowseResponse = {
    rows,
    facets,
    totals,
    counts_mode: countsMode,
    cursor: nextCursor,
    refreshed_at: refreshedAt,
    query: { scope: state.scope, kind, q: state.q, sort: state.sort },
  };

  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
  });
}
