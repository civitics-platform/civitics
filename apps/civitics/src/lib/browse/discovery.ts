/**
 * FIX-768 — the discovery-path root registry, distinct from the static
 * By-Branch BROWSE_TREE (scope-tree.ts). The landing START FROM row (FIX-767)
 * and the explorer ScopeRail's root switcher both drive off this one source.
 *
 * Three shapes:
 *  - "branch": the static BROWSE_TREE (rendered by ScopeTree — People / Money /
 *              Government / Legislation / Initiatives).
 *  - "lazy":   By Place / By Topic — children fetched on demand from an endpoint
 *              (jurisdictions.parent_id / proposal tag taxonomy) so the ~10.5k
 *              jurisdiction nodes never load eagerly.
 *  - "preset": By Money / By Time — a one-shot jump into an explorer BrowseState
 *              (financial + amount sort; open-comment recency), NOT a tree.
 *
 * Dependency-free (no next/*, no @civitics/db) so it is unit-testable under tsx.
 */

export type DiscoveryRootKey = "branch" | "place" | "topic" | "money" | "time";
export type DiscoveryRootKind = "branch" | "lazy" | "preset";

export interface DiscoveryRoot {
  key: DiscoveryRootKey;
  /** Full label ("By Place"). */
  label: string;
  /** Pill label ("PLACE"). */
  short: string;
  kind: DiscoveryRootKind;
  /** lazy roots only — the child-fetch endpoint. */
  endpoint?: "jurisdictions" | "topics";
  /** preset roots only — the explorer BrowseState URL to jump to. */
  preset?: string;
  /** Tooltip / sub-label. */
  hint: string;
}

export const DISCOVERY_ROOTS: DiscoveryRoot[] = [
  {
    key: "branch", label: "By Branch", short: "BRANCH", kind: "branch",
    hint: "People · Money · Government · Legislation",
  },
  {
    key: "place", label: "By Place", short: "PLACE", kind: "lazy", endpoint: "jurisdictions",
    hint: "Country → state → county / city",
  },
  {
    key: "topic", label: "By Topic", short: "TOPIC", kind: "lazy", endpoint: "topics",
    hint: "Proposal subject taxonomy",
  },
  {
    key: "money", label: "By Money", short: "MONEY", kind: "preset",
    preset: "/search?scope=money&sort=amount_desc",
    hint: "Donors, PACs & corporations by dollars",
  },
  {
    key: "time", label: "By Time", short: "TIME", kind: "preset",
    preset: "/search?scope=legislation/proposals/open-comment&sort=recent",
    hint: "Open comment windows, newest first",
  },
];

export function discoveryRoot(key: string | null | undefined): DiscoveryRoot | undefined {
  if (!key) return undefined;
  return DISCOVERY_ROOTS.find((r) => r.key === key);
}

/**
 * The URL that activates a discovery root from the landing START FROM row.
 * Trees carry `?root=<key>` so the explorer's ScopeRail swaps to that tree
 * (a bare `scope=""` would fall back to the landing); presets jump straight
 * into their explorer BrowseState.
 */
export function discoveryHref(root: DiscoveryRoot): string {
  if (root.kind === "preset") return root.preset ?? "/search";
  return `/search?root=${root.key}`;
}
