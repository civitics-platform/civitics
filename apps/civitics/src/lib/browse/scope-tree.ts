/**
 * FIX-749 — the By-Branch scope tree + scope-path compiler.
 *
 * W0 ships the "By Branch" tree, mirroring the current GROUP_TREE semantics
 * (packages/graph/src/groups.ts): People / Money / Government / Legislation /
 * Initiatives. Each node contributes a partial predicate; compiling a slash-
 * delimited path merges the contributions along it (deeper nodes override) into a
 * { kind, facets } predicate the /api/browse route applies to entity_search_index.
 *
 * Other roots (jurisdictions, institutions, meetings) are indexed by FIX-748 but
 * only become reachable via the tree when their roots land in W3.
 *
 * Dependency-free (no next/*, no @civitics/db) — unit-testable under tsx.
 */

import type { BrowseKind, CompiledScope, FacetMap, FacetValue } from "./types";

export interface ScopeNode {
  /** Path segment (slug). Unique among its siblings. */
  segment: string;
  label: string;
  /** Sets/overrides the kind for this subtree. */
  kind?: BrowseKind;
  /** Partial facet constraints this node contributes (deeper nodes override). */
  facets?: FacetMap;
  children?: ScopeNode[];
}

// ── The By-Branch tree ──────────────────────────────────────────────────────────
export const BROWSE_TREE: ScopeNode[] = [
  {
    segment: "people", label: "People", kind: "official",
    children: [
      {
        segment: "officials", label: "Officials",
        children: [
          {
            segment: "federal", label: "Federal", facets: { jurisdiction_level: "federal" },
            children: [
              {
                segment: "congress", label: "Congress", facets: { chamber: ["senate", "house"] },
                children: [
                  {
                    segment: "senate", label: "Senate", facets: { chamber: "senate" },
                    children: [
                      { segment: "democrat", label: "Democrats", facets: { party: "democrat" } },
                      { segment: "republican", label: "Republicans", facets: { party: "republican" } },
                    ],
                  },
                  {
                    segment: "house", label: "House", facets: { chamber: "house" },
                    children: [
                      { segment: "democrat", label: "Democrats", facets: { party: "democrat" } },
                      { segment: "republican", label: "Republicans", facets: { party: "republican" } },
                    ],
                  },
                ],
              },
            ],
          },
          { segment: "state", label: "By state", facets: { jurisdiction_level: "state" } },
        ],
      },
    ],
  },
  {
    segment: "money", label: "Money", kind: "financial",
    children: [
      { segment: "super-pacs", label: "Super PACs", facets: { financial_type: "super_pac" } },
      { segment: "party-committees", label: "Party committees", facets: { financial_type: "party_committee" } },
      { segment: "corporations", label: "Corporations", facets: { financial_type: "corporation" } },
      { segment: "unions", label: "Unions", facets: { financial_type: "union" } },
      { segment: "pacs", label: "PACs", facets: { financial_type: "pac" } },
    ],
  },
  {
    segment: "government", label: "Government", kind: "agency",
    children: [
      {
        segment: "agencies", label: "Agencies",
        children: [
          { segment: "federal", label: "Federal", facets: { agency_type: "federal" } },
          { segment: "independent", label: "Independent", facets: { agency_type: "independent" } },
        ],
      },
    ],
  },
  {
    segment: "legislation", label: "Legislation", kind: "proposal",
    children: [
      {
        segment: "proposals", label: "Proposals",
        children: [
          { segment: "open-comment", label: "Open for comment", facets: { status: "open_comment" } },
          { segment: "bills", label: "Bills", facets: { proposal_type: "bill" } },
          { segment: "regulations", label: "Regulations", facets: { proposal_type: "regulation" } },
        ],
      },
    ],
  },
  {
    segment: "initiatives", label: "Initiatives", kind: "initiative",
    children: [
      { segment: "active", label: "Active", facets: { initiative_stage: ["deliberate", "mobilise", "draft"] } },
      { segment: "resolved", label: "Resolved", facets: { initiative_stage: "resolved" } },
    ],
  },
];

/** Normalize a scope path into its segment list. "" / "all" → []. */
export function scopeSegments(path: string): string[] {
  const trimmed = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === "all") return [];
  return trimmed.split("/").filter(Boolean);
}

export class UnknownScopeError extends Error {
  constructor(public readonly path: string, public readonly badSegment: string) {
    super(`Unknown scope segment "${badSegment}" in path "${path}"`);
    this.name = "UnknownScopeError";
  }
}

/**
 * Compile a scope path into { kind, facets }. Walks the tree matching each
 * segment; a segment that matches no child throws UnknownScopeError. An empty
 * path compiles to { kind: null, facets: {} } (all kinds). Deeper facet
 * contributions override shallower ones for the same key.
 */
export function compileScope(path: string): CompiledScope {
  const segments = scopeSegments(path);
  let level: ScopeNode[] = BROWSE_TREE;
  let kind: BrowseKind | null = null;
  const facets: FacetMap = {};

  for (const seg of segments) {
    const node = level.find((n) => n.segment === seg);
    if (!node) throw new UnknownScopeError(path, seg);
    if (node.kind) kind = node.kind;
    if (node.facets) {
      for (const [k, v] of Object.entries(node.facets)) facets[k] = v as FacetValue;
    }
    level = node.children ?? [];
  }

  return { kind, facets };
}

/** All valid leaf + interior scope paths (used by round-trip tests + nav build). */
export function allScopePaths(): string[] {
  const out: string[] = [];
  const walk = (nodes: ScopeNode[], prefix: string) => {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.segment}` : n.segment;
      out.push(p);
      if (n.children?.length) walk(n.children, p);
    }
  };
  walk(BROWSE_TREE, "");
  return out;
}
