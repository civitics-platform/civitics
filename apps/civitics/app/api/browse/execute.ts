/**
 * executeBrowse — the /api/browse core, extracted from route.ts (FIX-751) so
 * app/search/page.tsx can run the same query server-side for the SSR first
 * paint without a self-fetch. The route handler stays the HTTP envelope owner;
 * this module owns param parsing → RPC calls → BrowseResponse assembly.
 *
 * W1 adds `only=rows|facets` (FIX-752): the explorer fetches rows first and
 * facet counts as a secondary request on the same debounced settle, so the
 * slow narrowed-facet path (~733ms worst case on prod) never blocks row
 * rendering. Omitted → W0 behavior (both in one response).
 */

import { createAdminClient } from "@civitics/db";
import { parseBrowseState } from "@/lib/browse/browse-state";
import { compileScope } from "@/lib/browse/scope-tree";
import { encodeCursor, decodeCursor } from "@/lib/browse/cursor";
import type {
  BrowseRow, BrowseResponse, BrowseCountsMode, FacetMap, FacetValue,
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

export interface BrowseExecution {
  status: number;
  body: BrowseResponse | { error: string; details: string | string[] };
}

export async function executeBrowse(sp: URLSearchParams): Promise<BrowseExecution> {
  const { state, kind, errors } = parseBrowseState(sp);

  if (errors.length > 0) {
    return { status: 400, body: { error: "invalid_browse_state", details: errors } };
  }

  const only = sp.get("only"); // "rows" | "facets" | null (both)
  const wantRows = only !== "facets";
  const wantFacets = only !== "rows";

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
  const rows: BrowseRow[] = [];
  let nextCursor: string | null = null;

  if (wantRows) {
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
      return { status: 500, body: { error: "browse_page_failed", details: pageErr.message } };
    }

    const rawRows: Array<BrowseRow & { _sort_value: string | null }> = pageData?.rows ?? [];
    const hasMore: boolean = pageData?.has_more ?? false;

    for (const { _sort_value, ...r } of rawRows) rows.push(r);

    // Next-page cursor from the last INDEX row (passthrough individuals never page).
    const last = rawRows[rawRows.length - 1];
    if (hasMore && last) {
      nextCursor = encodeCursor({ sortValue: last._sort_value, entityId: last.entity_id });
    }

    // ── Financial-individual passthrough (page 1 only; decision 2) ────────────
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
  }

  // ── Facet counts ────────────────────────────────────────────────────────────
  const facets: Record<string, Record<string, number>> = {};
  let totals: { count: number | null } = { count: null };
  let countsMode: BrowseCountsMode = "omitted";

  if (wantFacets && kind && !hasNarrowing) {
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
  } else if (wantFacets && kind) {
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
  // kind === null (all-kinds scope) or only=rows: counts omitted.

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

  return { status: 200, body };
}
