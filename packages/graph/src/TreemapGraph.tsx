"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, TreemapOptions, FocusGroup, FocusEntity } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";
import { resolveColor, resolveToken } from "./tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TreemapOfficial {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  chamber: string;
  total_donated_cents: number;
  connection_count: number;
  vote_count: number;
}

interface DonorRow {
  donor_id: string;
  donor_name: string;
  industry_category: string;
  amount_usd: number;
  entity_type: string;
}

// PAC hierarchy types (returned by /api/graph/treemap-pac)
interface PacLeaf {
  name: string;
  value: number;
  count: number;
  pacId?: string;
  officialCount?: number;
}

interface PacGroup {
  name: string;
  totalUsd: number;
  children: PacLeaf[];
}

interface PacHierarchy {
  name: string;
  children: PacGroup[];
}

// D3 hierarchy datum for internal nodes
interface GroupDatum {
  name: string;
  children?: GroupDatum[];
  value?: number;
  official?: TreemapOfficial;
  donor?: DonorRow;
  industryIndex?: number; // entity mode: palette index for the industry group
  /** FIX-186 — donor cells in compare mode: 'shared' = repeat color across cells */
  shared?: boolean;
}

// Compare mode (FIX-186): per-entity donor list
interface CompareEntry {
  entity: FocusEntity;
  donors: DonorRow[];
}

// ── Industry colors (entity mode) ─────────────────────────────────────────────
// FIX-729 — strokes cycle the 9-hue viz ramp; the dark cell fill is derived
// from the stroke hue at render time (see fillOf in render), replacing the
// legacy parallel *_FILL hex palette. Same 13-slot length / index logic.

const VIZ_RAMP = [
  "rgb(var(--c-viz-1))",
  "rgb(var(--c-viz-2))",
  "rgb(var(--c-viz-3))",
  "rgb(var(--c-viz-4))",
  "rgb(var(--c-viz-5))",
  "rgb(var(--c-viz-6))",
  "rgb(var(--c-viz-7))",
  "rgb(var(--c-viz-8))",
  "rgb(var(--c-viz-9))",
];

const INDUSTRY_STROKE_PALETTE = Array.from(
  { length: 13 },
  (_, i) => VIZ_RAMP[i % VIZ_RAMP.length]!,
);

function getIndustryStroke(index: number): string {
  return INDUSTRY_STROKE_PALETTE[index % INDUSTRY_STROKE_PALETTE.length] ?? "rgb(var(--c-ink-soft))";
}

// ── Party colors ──────────────────────────────────────────────────────────────

const PARTY_STROKE: Record<string, string> = {
  democrat:    "rgb(var(--c-blue))",
  republican:  "rgb(var(--c-accent))",
  independent: "rgb(var(--c-viz-7))", // wine — no purple in the token system
  nonpartisan: "rgb(var(--c-ink-soft))",
};

const PARTY_LABEL: Record<string, string> = {
  democrat:    "Democrat",
  republican:  "Republican",
  independent: "Independent",
  nonpartisan: "Nonpartisan",
};

// ── Chamber colors ────────────────────────────────────────────────────────────

const CHAMBER_STROKE: Record<string, string> = {
  senate: "rgb(var(--c-blue))",
  house:  "rgb(var(--c-viz-7))", // was purple — wine per token vocabulary
  unknown: "rgb(var(--c-ink-soft))",
};

const CHAMBER_LABEL: Record<string, string> = {
  senate: "Senate",
  house:  "House",
  unknown: "Unknown",
};

function getStroke(key: string, colorBy: 'party' | 'chamber'): string {
  if (colorBy === 'chamber') return CHAMBER_STROKE[key] ?? "rgb(var(--c-ink-soft))";
  return PARTY_STROKE[key] ?? "rgb(var(--c-ink-soft))";
}

function getGroupLabel(key: string, groupBy: TreemapOptions['groupBy']): string {
  if (groupBy === 'chamber') return CHAMBER_LABEL[key] ?? key;
  if (groupBy === 'party')   return PARTY_LABEL[key]   ?? key;
  // state or industry: use key directly
  return key;
}

function getGroupKey(official: TreemapOfficial, groupBy: TreemapOptions['groupBy']): string {
  switch (groupBy) {
    case 'state':   return official.state || 'Unknown';
    case 'chamber': return official.chamber || 'unknown';
    case 'industry':
    case 'donor_type':  // donor-type grouping doesn't apply to officials —
                        // fall through to party.
    case 'party':
    default:        return official.party;
  }
}

// FIX-218 — donor entity_type → user-friendly label for the
// "Fundraising by Donor Type" preset.
function prettyDonorType(entityType: string): string {
  const t = (entityType ?? '').toLowerCase();
  switch (t) {
    case 'pac':             return 'PACs';
    case 'super_pac':       return 'Super PACs';
    case 'party_committee': return 'Party Committees';
    case 'corporation':     return 'Corporations';
    case 'union':           return 'Unions';
    case 'individual':      return 'Individuals';
    // FIX-845 — the small-dollar tail aggregate + the explicit catch-all so
    // the default branch never prints a raw lowercase "other".
    case 'individual_aggregate': return 'Individual donors';
    case 'other':           return 'Other';
    default:                return entityType || 'Other';
  }
}

function getRawSizeValue(official: TreemapOfficial, sizeBy: TreemapOptions['sizeBy']): number {
  switch (sizeBy) {
    case 'connection_count': return Math.max(0, official.connection_count);
    case 'vote_count':       return Math.max(0, official.vote_count);
    case 'donation_total':
    default:                 return Math.max(0, official.total_donated_cents);
  }
}

function getSizeValue(
  official:  TreemapOfficial,
  sizeBy:    TreemapOptions['sizeBy'],
  sizeScale: TreemapOptions['sizeScale'],
  linearMin: number,
): number {
  const raw = getRawSizeValue(official, sizeBy);
  // 'log'    → compresses ratio so every cell is visible. Donation totals span
  //            $0 to >$1M (8 orders of magnitude); on a linear scale, top
  //            earners get virtually all area and others render as sub-pixel.
  //            log10(value+1)+1 maps $0→1, $1k→4, $1M→7 — ordering preserved,
  //            ratio capped near 8:1.
  // 'linear' → raw value with a small floor so 0-data cells stay visible.
  //            Preserves true ratios; useful when the user wants to see who
  //            actually dominates fundraising.
  if (sizeScale === 'linear') return Math.max(linearMin, raw);
  return Math.log10(raw + 1) + 1;
}

function officialToNode(o: TreemapOfficial): NewGraphNode {
  return {
    id:           o.official_id,
    name:         o.official_name,
    type:         'official',
    party:        (o.party as NewGraphNode['party']) ?? undefined,
    donationTotal: o.total_donated_cents,
  };
}

// ── TreemapGraph ──────────────────────────────────────────────────────────────

export interface TreemapGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<TreemapOptions>;
  primaryEntityId?: string | null;
  primaryEntityName?: string | null;
  primaryGroup?: FocusGroup | null;
  /**
   * FIX-185 — Cohort × Filter. When set to a PAC industry group, the treemap
   * cohort comes from primaryEntity / primaryGroup (officials side) but the
   * donation aggregate is restricted to donors tagged with this group's
   * industry. Use case: "Senate Democrats sized by donations from Finance
   * PACs only".
   */
  secondaryGroup?: FocusGroup | null;
  /**
   * FIX-186 — All currently focused single entities. Used by Compare mode
   * (TreemapOptions.compareMode) to render one cell per entity with their
   * donors, color-matched across cells where donors overlap.
   */
  focusEntities?: FocusEntity[];
  /**
   * FIX-220 — Donation floor in USD. Forwarded from
   * view.connections.donation.minAmount. Filters out donor leaves and
   * official cohort rows whose total falls below this floor. 0 = show all.
   */
  minAmountUsd?: number;
}

export function TreemapGraph({ className = "", svgRef: externalSvgRef, vizOptions, primaryEntityId, primaryEntityName, primaryGroup, secondaryGroup, focusEntities = [], minAmountUsd = 0 }: TreemapGraphProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef         = externalSvgRef ?? internalSvgRef;

  const [officials, setOfficials]         = useState<TreemapOfficial[]>([]);
  const [donors, setDonors]               = useState<DonorRow[]>([]);
  const [pacHierarchy, setPacHierarchy]   = useState<PacHierarchy | null>(null);
  const [compareEntries, setCompareEntries] = useState<CompareEntry[]>([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup]       = useState<NewGraphNode | null>(null);
  const [drillNode, setDrillNode] = useState<GroupDatum | null>(null);

  const groupBy     = vizOptions?.groupBy     ?? 'party';
  const sizeBy      = vizOptions?.sizeBy      ?? 'donation_total';
  const colorBy     = vizOptions?.colorBy     ?? 'party';
  const sizeScale   = vizOptions?.sizeScale   ?? 'log';
  const compareMode = (vizOptions?.compareMode ?? false) && focusEntities.length >= 2;

  // Derive the effective data mode from explicit vizOption + focus state.
  // When a PAC group is focused, route to the PAC endpoint regardless of
  // whether dataMode was explicitly toggled — adding "Finance PACs" to focus
  // should drive the treemap whether or not the user clicked "view as treemap".
  const explicitDataMode = vizOptions?.dataMode ?? 'officials';
  const isPacGroupFocus  = primaryGroup?.filter.entity_type === 'pac';
  const dataMode = isPacGroupFocus && explicitDataMode === 'officials'
    ? 'pac_sector'
    : explicitDataMode;

  // ── Fetch data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);

    // FIX-186 — Compare mode: parallel fetch donors for each focused entity
    // and render a top-level cell per entity. Bypasses single-primary logic.
    if (compareMode) {
      setPacHierarchy(null);
      setOfficials([]);
      setDonors([]);

      const isRealUuid = (id: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const validEntities = focusEntities.filter(e => e.type === 'official' && isRealUuid(e.id));

      Promise.all(
        validEntities.map(async (e) => {
          const res = await fetch(
            `/api/graph/treemap?entityId=${encodeURIComponent(e.id)}&groupBy=${groupBy}&sizeBy=${sizeBy}`,
          );
          const data = (await res.json()) as DonorRow[] | { error: string };
          if ("error" in data) throw new Error(data.error);
          return { entity: e, donors: data as DonorRow[] };
        }),
      )
        .then((entries) => setCompareEntries(entries))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
      return;
    }

    // Single-primary modes clear compare state
    setCompareEntries([]);

    // FIX-218 — Individuals-by-state mode. Response is hierarchy-shaped
    // (state → donors), so we slot it into the same pacHierarchy state.
    if (dataMode === 'individuals_by_state') {
      const isRealUuid = (id: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const params = new URLSearchParams();
      if (primaryEntityId && isRealUuid(primaryEntityId)) {
        params.set('entityId', primaryEntityId);
      }
      const qs = params.toString();
      fetch(`/api/graph/treemap-individuals${qs ? `?${qs}` : ''}`)
        .then((r) => r.json())
        .then((data: PacHierarchy | { error: string }) => {
          if ("error" in data) throw new Error((data as { error: string }).error);
          setPacHierarchy(data as PacHierarchy);
          setOfficials([]);
          setDonors([]);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
      return;
    }

    // PAC modes — fetch from treemap-pac endpoint
    if (dataMode === 'pac_sector' || dataMode === 'pac_party') {
      const pacGroupBy = dataMode === 'pac_sector' ? 'sector' : 'party';
      const params = new URLSearchParams({ groupBy: pacGroupBy });
      // FIX-173: forward primaryGroup.filter.industry when a single-industry PAC
      // group is focused ("Finance PACs", "Energy PACs", etc.). Without this,
      // every industry group renders the same global all-sectors view.
      if (
        primaryGroup &&
        primaryGroup.filter.entity_type === 'pac' &&
        primaryGroup.filter.industry
      ) {
        params.set('industry', primaryGroup.filter.industry);
      }
      // FIX-216: when an official is focused, restrict the PAC set to those
      // who donated to that official. Without this, "Ted Cruz > PAC Money by
      // Sector" returned every PAC in the database — a different scope than
      // the sibling "By State" preset, producing disjoint PAC sets across
      // presets that should overlap.
      const isRealUuid = (id: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (primaryEntityId && isRealUuid(primaryEntityId)) {
        params.set('entityId', primaryEntityId);
      }
      // FIX-220 — donation floor
      if (minAmountUsd > 0) params.set('minAmountUsd', String(minAmountUsd));
      fetch(`/api/graph/treemap-pac?${params.toString()}`)
        .then((r) => r.json())
        .then((data: PacHierarchy | { error: string }) => {
          if ("error" in data) throw new Error((data as { error: string }).error);
          setPacHierarchy(data as PacHierarchy);
          setOfficials([]);
          setDonors([]);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
      return;
    }

    // Officials mode (default)
    setPacHierarchy(null);

    const isRealUuid = (id: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    const entityIdParam =
      primaryEntityId && isRealUuid(primaryEntityId) ? primaryEntityId : null;

    // FIX-185: when a secondary PAC industry group is in focus alongside an
    // officials cohort, narrow the donation aggregate to that industry.
    const industryFilter =
      secondaryGroup?.filter.entity_type === 'pac'
        ? secondaryGroup.filter.industry ?? null
        : null;

    let url: string;

    if (primaryGroup && primaryGroup.filter.entity_type === 'official') {
      // Group of officials: fetch aggregate and filter server-side
      const g = primaryGroup.filter;
      const params = new URLSearchParams({ groupBy, sizeBy });
      if (g.chamber) params.set('chamber', g.chamber);
      if (g.party)   params.set('party',   g.party);
      if (g.state)   params.set('state',   g.state);
      if (industryFilter) params.set('industry_filter', industryFilter);
      if (minAmountUsd > 0) params.set('minAmountUsd', String(minAmountUsd));
      url = `/api/graph/treemap?${params.toString()}`;
    } else if (entityIdParam) {
      const params = new URLSearchParams({ entityId: entityIdParam, groupBy, sizeBy });
      if (industryFilter) params.set('industry_filter', industryFilter);
      if (minAmountUsd > 0) params.set('minAmountUsd', String(minAmountUsd));
      url = `/api/graph/treemap?${params.toString()}`;
    } else {
      const params = new URLSearchParams({ groupBy, sizeBy });
      if (industryFilter) params.set('industry_filter', industryFilter);
      if (minAmountUsd > 0) params.set('minAmountUsd', String(minAmountUsd));
      url = `/api/graph/treemap?${params.toString()}`;
    }

    fetch(url)
      .then((r) => r.json())
      .then((data: TreemapOfficial[] | DonorRow[] | { error: string }) => {
        if ("error" in data) throw new Error((data as { error: string }).error);
        if (entityIdParam) {
          const donorData = data as DonorRow[];
          setDonors(donorData);
          setOfficials([]);
        } else {
          setOfficials(data as TreemapOfficial[]);
          setDonors([]);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  // Refetch when entity / group / groupBy / sizeBy / dataMode / industry filter / compare / minAmount change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEntityId, primaryGroup, secondaryGroup, groupBy, sizeBy, dataMode, compareMode, focusEntities, minAmountUsd]);

  // Reset drill state when the view changes
  useEffect(() => {
    setDrillNode(null);
  }, [vizOptions?.groupBy, vizOptions?.dataMode, primaryEntityId, primaryGroup]);

  // ── Render treemap ──────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;

    // FIX-218 — individuals_by_state shares the pre-built-hierarchy render
    // path with PAC modes. Treat them together for the gating logic.
    const isPacMode       = dataMode === 'pac_sector' || dataMode === 'pac_party';
    const isPacSectorMode = dataMode === 'pac_sector';
    const isPacPartyMode  = dataMode === 'pac_party';
    const isHierarchyMode = isPacMode || dataMode === 'individuals_by_state';
    const isEntityMode    = !compareMode && !!primaryEntityId && donors.length > 0;
    const isCompareMode   = compareMode && compareEntries.length >= 2;

    if (isCompareMode) {
      // ok — compare mode
    } else if (isHierarchyMode && !pacHierarchy) return;
    else if (!isHierarchyMode && !isEntityMode && officials.length === 0) return;
    else if (!isHierarchyMode && isEntityMode && donors.length === 0) return;

    const width  = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    // FIX-729 — resolve design tokens against the svg's scope (terminal vs
    // paper) at render time; d3 .attr() needs concrete colors, not var().
    const R = (c: string) => resolveColor(c, svg);
    const T = {
      panel:   resolveToken("--c-term-panel", svg),
      ink:     resolveToken("--c-ink", svg),
      inkSoft: resolveToken("--c-ink-soft", svg),
    };
    // Dark cell fill derived from the stroke hue — replaces the legacy
    // parallel *_FILL hex palettes (same hue pairing, panel-anchored).
    const fillOf = (stroke: string) => d3.interpolateRgb(T.panel, R(stroke))(0.35);

    let root: GroupDatum;

    if (isCompareMode) {
      // FIX-186 — Compare mode: top-level cell per focused entity, each
      // subdivided by their donors. Donors common to multiple entities use
      // a stable color across cells so overlap pops visually.
      const donorOccurrence = new Map<string, number>();
      for (const entry of compareEntries) {
        for (const d of entry.donors) {
          donorOccurrence.set(d.donor_id, (donorOccurrence.get(d.donor_id) ?? 0) + 1);
        }
      }
      // Stable palette index per donor — collisions across entities produce
      // matching colors automatically.
      function donorPaletteIndex(donor_id: string): number {
        let h = 0;
        for (let i = 0; i < donor_id.length; i++) h = (h * 31 + donor_id.charCodeAt(i)) | 0;
        return Math.abs(h);
      }
      root = {
        name: "root",
        children: compareEntries.map((entry, idx) => ({
          name: entry.entity.name,
          industryIndex: idx,
          children: entry.donors.map((d) => ({
            name:  d.donor_name,
            value: Math.max(1, d.amount_usd),
            donor: d,
            shared: (donorOccurrence.get(d.donor_id) ?? 0) >= 2,
            industryIndex: donorPaletteIndex(d.donor_id),
          })),
        })),
      };
    } else if (isHierarchyMode && pacHierarchy) {
      // PAC or individuals-by-state hierarchy — pre-grouped from the API
      root = {
        name: "root",
        children: pacHierarchy.children.map((group, idx) => ({
          name: group.name,
          industryIndex: idx,
          children: group.children.map((leaf) => ({
            name:  leaf.name,
            value: leaf.value,
            industryIndex: idx,
            // Reuse donor slot to carry PAC data for tooltip/popup
            donor: {
              donor_id:          leaf.pacId ?? leaf.name,
              donor_name:        leaf.name,
              industry_category: group.name,
              amount_usd:        leaf.value,
              entity_type:       "pac",
            },
          })),
        })),
      };
    } else if (isEntityMode) {
      // Group donors by industry — or by entity_type when the preset
      // requests donor-type grouping (FIX-218).
      const groupKeyFn = groupBy === 'donor_type'
        ? (d: DonorRow) => prettyDonorType(d.entity_type)
        : (d: DonorRow) => d.industry_category;
      const grouped = d3.group(donors, groupKeyFn);
      const industryKeys = [...grouped.keys()].sort((a, b) => {
        const aTotal = grouped.get(a)!.reduce((s, r) => s + r.amount_usd, 0);
        const bTotal = grouped.get(b)!.reduce((s, r) => s + r.amount_usd, 0);
        return bTotal - aTotal;
      });
      root = {
        name: "root",
        children: industryKeys.map((industry, idx) => ({
          name: industry,
          industryIndex: idx,
          children: (grouped.get(industry) ?? []).map((d) => ({
            name:         d.donor_name,
            value:        d.amount_usd,
            donor:        d,
            industryIndex: idx,
          })),
        })),
      };
    } else {
      const grouped = d3.group(officials, (d) => getGroupKey(d, groupBy));
      root = {
        name: "root",
        children: Array.from(grouped, ([key, items]) => ({
          name: key,
          children: items.map((o) => ({
            name:    o.official_name,
            value:   getSizeValue(o, sizeBy, sizeScale, 1),
            official: o,
          })),
        })),
      };
    }

    const displayData: GroupDatum = drillNode
      ? { name: "root", children: [drillNode] }
      : root;

    const hierarchy = d3
      .hierarchy<GroupDatum>(displayData)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    d3.treemap<GroupDatum>()
      .size([width, height])
      .paddingOuter(4)
      .paddingInner(1)
      .paddingTop(20)
      .tile(d3.treemapSquarify)(hierarchy);

    d3.select(svg).selectAll("*").remove();
    d3.select(svg).attr("width", width).attr("height", height)
      .style("user-select", "none")
      .style("-webkit-user-select", "none");

    const g = d3.select(svg).append("g");

    // Group backgrounds (depth=1)
    const groupNodes = hierarchy.descendants().filter((d) => d.depth === 1);
    g.selectAll<SVGRectElement, d3.HierarchyRectangularNode<GroupDatum>>(".group-bg")
      .data(groupNodes as d3.HierarchyRectangularNode<GroupDatum>[])
      .join("rect")
      .attr("class", "group-bg")
      .attr("x", (d) => d.x0)
      .attr("y", (d) => d.y0)
      .attr("width", (d) => d.x1 - d.x0)
      .attr("height", (d) => d.y1 - d.y0)
      .attr("fill", (d) => fillOf((isPacSectorMode || isEntityMode || isCompareMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[d.data.name.toLowerCase()] ?? "rgb(var(--c-ink-soft))")
          : getStroke(d.data.name, colorBy as 'party' | 'chamber')))
      .attr("rx", 3)
      .style("cursor", (d) =>
        !drillNode && d.data.children?.length ? "zoom-in" : "default")
      .on("click", (_event, d) => {
        if (d.data.children && d.data.children.length > 0 && !drillNode) {
          setDrillNode(d.data);
        }
      });

    // Group labels
    g.selectAll<SVGTextElement, d3.HierarchyRectangularNode<GroupDatum>>(".group-label")
      .data(groupNodes as d3.HierarchyRectangularNode<GroupDatum>[])
      .join("text")
      .attr("class", "group-label")
      .attr("x", (d) => d.x0 + 6)
      .attr("y", (d) => d.y0 + 14)
      .attr("fill", (d) => R((isPacSectorMode || isEntityMode || isCompareMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[d.data.name.toLowerCase()] ?? "rgb(var(--c-ink-soft))")
          : getStroke(d.data.name, colorBy as 'party' | 'chamber')))
      .attr("font-size", 11)
      .attr("font-weight", "600")
      .attr("font-family", "system-ui, sans-serif")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .style("-webkit-user-select", "none")
      .text((d) => isCompareMode
        ? d.data.name
        : isEntityMode
          ? d.data.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
          : getGroupLabel(d.data.name, groupBy));

    // Drill hint on group cells (only when not already drilled)
    if (!drillNode) {
      g.selectAll<SVGTextElement, d3.HierarchyRectangularNode<GroupDatum>>(".group-hint")
        .data(groupNodes as d3.HierarchyRectangularNode<GroupDatum>[])
        .join("text")
        .attr("class", "group-hint")
        .attr("x", (d) => d.x0 + 6)
        .attr("y", (d) => d.y0 + 26)
        .attr("font-size", 8)
        .attr("fill", T.inkSoft)
        .attr("font-family", "system-ui, sans-serif")
        .attr("pointer-events", "none")
        .style("user-select", "none")
        .style("-webkit-user-select", "none")
        .text((d) => {
          if (!d.data.children?.length) return "";
          const w = d.x1 - d.x0;
          const h = d.y1 - d.y0;
          if (w < 60 || h < 30) return "";
          return `▸ ${d.data.children.length} officials`;
        });
    }

    // Leaf cells
    const leafNodes = hierarchy.leaves() as d3.HierarchyRectangularNode<GroupDatum>[];
    const cell = g
      .selectAll<SVGGElement, d3.HierarchyRectangularNode<GroupDatum>>(".leaf")
      .data(leafNodes)
      .join("g")
      .attr("class", "leaf")
      .attr("transform", (d) => `translate(${d.x0},${d.y0})`)
      .style("cursor", "pointer");

    cell
      .append("rect")
      .attr("width",  (d) => Math.max(0, d.x1 - d.x0 - 1))
      .attr("height", (d) => Math.max(0, d.y1 - d.y0 - 1))
      .attr("fill",   (d) => fillOf((isPacSectorMode || isEntityMode || isCompareMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[(d.data.donor?.industry_category ?? "").toLowerCase()] ?? "rgb(var(--c-ink-soft))")
          : (() => {
              const key = d.data.official ? getGroupKey(d.data.official, colorBy === 'chamber' ? 'chamber' : 'party') : 'nonpartisan';
              return getStroke(key, colorBy as 'party' | 'chamber');
            })()))
      .attr("stroke", (d) => R((isPacSectorMode || isEntityMode || isCompareMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[(d.data.donor?.industry_category ?? "").toLowerCase()] ?? "rgb(var(--c-ink-soft))")
          : (() => {
              const key = d.data.official ? getGroupKey(d.data.official, colorBy === 'chamber' ? 'chamber' : 'party') : 'nonpartisan';
              return getStroke(key, colorBy as 'party' | 'chamber');
            })()))
      // FIX-186: shared donors in compare mode get a thicker stroke so the
      // overlap reads as a "they both took money from this donor" signal.
      .attr("stroke-width", (d) => isCompareMode && d.data.shared ? 1.5 : 0.5)
      .attr("rx", 2)
      .on("mouseenter", function (event: MouseEvent, d) {
        d3.select(this).attr("stroke-width", 2).attr("fill-opacity", 0.85);
        const rect = (containerRef.current ?? svg).getBoundingClientRect();
        if (d.data.donor) {
          showTip(
            {
              id:           d.data.donor.donor_id,
              name:         d.data.donor.donor_name,
              type:         'financial',
              donationTotal: d.data.donor.amount_usd * 100,
            },
            event.clientX - rect.left,
            event.clientY - rect.top
          );
        } else if (d.data.official) {
          showTip(
            officialToNode(d.data.official),
            event.clientX - rect.left,
            event.clientY - rect.top
          );
        }
      })
      .on("mousemove", function (event: MouseEvent, d) {
        const rect = (containerRef.current ?? svg).getBoundingClientRect();
        if (d.data.donor) {
          showTip(
            {
              id:           d.data.donor.donor_id,
              name:         d.data.donor.donor_name,
              type:         'financial',
              donationTotal: d.data.donor.amount_usd * 100,
            },
            event.clientX - rect.left,
            event.clientY - rect.top
          );
        } else if (d.data.official) {
          showTip(
            officialToNode(d.data.official),
            event.clientX - rect.left,
            event.clientY - rect.top
          );
        }
      })
      .on("mouseleave", function () {
        d3.select(this).attr("stroke-width", 0.5).attr("fill-opacity", 1);
        hideTip();
      })
      .on("click", (_event: MouseEvent, d) => {
        if (d.data.donor) {
          setPopup({
            id:            d.data.donor.donor_id,
            name:          d.data.donor.donor_name,
            type:          'financial',
            donationTotal: d.data.donor.amount_usd * 100,
          });
          return;
        }
        if (d.data.official) {
          setPopup(officialToNode(d.data.official));
          return;
        }
        // Group leaf (shouldn't happen with current data shape, guard only)
        if (d.data.children && d.data.children.length > 0 && !drillNode) {
          setDrillNode(d.data);
        }
      });

    // Name labels
    cell
      .append("text")
      .attr("x", 4)
      .attr("y", 13)
      .attr("font-size", (d) => {
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        if (w < 40 || h < 20) return 0;
        return Math.min(11, Math.max(8, Math.sqrt(w * h) / 8));
      })
      .attr("fill", T.ink)
      .attr("font-family", "system-ui, sans-serif")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .style("-webkit-user-select", "none")
      .text((d) => {
        const w = d.x1 - d.x0;
        if (w < 40) return "";
        const name = d.data.donor?.donor_name ?? d.data.official?.official_name ?? d.data.name;
        const maxChars = Math.floor(w / 6);
        return name.length > maxChars ? name.slice(0, maxChars - 1) + "…" : name;
      });

    // Amount label — large cells only
    cell
      .append("text")
      .attr("x", 4)
      .attr("y", 26)
      .attr("font-size", 9)
      .attr("fill", T.inkSoft)
      .attr("font-family", "system-ui, sans-serif")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .style("-webkit-user-select", "none")
      .text((d) => {
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        if (w < 60 || h < 36) return "";
        const amount = d.data.donor?.amount_usd
          ?? (d.data.official ? d.data.official.total_donated_cents / 100 : 0);
        return "$" + amount.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
      });
  }, [officials, donors, pacHierarchy, compareEntries, compareMode, primaryEntityId, groupBy, sizeBy, sizeScale, colorBy, dataMode, drillNode, showTip, hideTip]);

  // Render on data change + resize
  useEffect(() => {
    render();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(render);
    ro.observe(container);
    return () => ro.disconnect();
  }, [render]);

  // NodeActions for treemap — officials have profiles; PACs link to financial entities
  const nodeActions: NodeActions = {
    recenter:         () => {},
    openProfile:      (nodeId) => window.open(`/officials/${nodeId}`, "_blank"),
    expandNode:       () => {},
  };

  const isPacMode    = dataMode === 'pac_sector' || dataMode === 'pac_party';
  const isEntityMode = !!primaryEntityId && !loading;

  // ── Legend ─────────────────────────────────────────────────────────────────

  function renderLegend() {
    if (isPacMode) {
      return (
        <span className="text-[10px] text-ink-soft">
          Color = {dataMode === 'pac_sector' ? 'industry' : 'party'} · Size = total donated
        </span>
      );
    }
    if (isEntityMode) {
      return (
        <span className="text-[10px] text-ink-soft">
          Color = industry · Size = donation amount
        </span>
      );
    }
    if (colorBy === 'chamber') {
      return (
        <>
          {Object.entries(CHAMBER_LABEL).map(([key, label]) => (
            <div key={key} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CHAMBER_STROKE[key] }} />
              <span className="text-[10px] text-ink-soft">{label}</span>
            </div>
          ))}
          <span className="text-[10px] text-ink-soft border-l border-rule pl-3 ml-1">
            Color = chamber
          </span>
        </>
      );
    }
    return (
      <>
        {Object.entries(PARTY_LABEL).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: PARTY_STROKE[key] }} />
            <span className="text-[10px] text-ink-soft">{label}</span>
          </div>
        ))}
        <span className="text-[10px] text-ink-soft border-l border-rule pl-3 ml-1">
          Size = donations ({sizeScale === 'linear' ? 'linear' : 'log scale'})
        </span>
      </>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-ink-soft text-sm">Loading donation data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-accent text-sm">Failed to load treemap: {error}</p>
      </div>
    );
  }

  const hasData = compareMode
    ? compareEntries.length >= 2 && compareEntries.some(e => e.donors.length > 0)
    : isPacMode
      ? !!pacHierarchy && pacHierarchy.children.length > 0
      : primaryEntityId
        ? donors.length > 0
        : officials.length > 0;
  if (!hasData) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-ink-soft text-sm">No donation data available yet.</p>
      </div>
    );
  }

  // FIX-185: when an industry filter is active, surface it in the context
  // label so the user knows the cell sizes are restricted ("Senate Dems —
  // Finance PACs only").
  const filterIndustryLabel =
    secondaryGroup?.filter.entity_type === 'pac' && secondaryGroup.filter.industry
      ? secondaryGroup.filter.industry
      : null;
  const baseLabel = compareMode
    ? `Compare donors — ${compareEntries.map(e => e.entity.name).join(' vs ')}`
    : isPacMode
    ? (dataMode === 'pac_sector' ? "PAC Money by Sector" : "PAC Money by Party")
    : primaryEntityId && primaryEntityName
      ? `${primaryEntityName} — Top Donors`
      : primaryGroup?.name
        ? `${primaryGroup.name} by ${groupBy}`
        : "All Officials by Party";
  const contextLabel = filterIndustryLabel && !isPacMode
    ? `${baseLabel} — ${filterIndustryLabel} PACs only`
    : baseLabel;

  return (
    <div ref={containerRef} className={`relative overflow-hidden flex flex-col ${className}`}>
      {/* Breadcrumb bar — shown only when drilled into a group */}
      {drillNode && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card/80 border-b border-rule text-xs shrink-0 z-10">
          <button
            onClick={() => setDrillNode(null)}
            className="text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
          >
            ← All
          </button>
          <span className="text-ink-soft">/</span>
          <span className="text-ink font-medium">
            {getGroupLabel(drillNode.name, groupBy)}
          </span>
          <span className="text-ink-soft ml-auto">
            {drillNode.children?.length ?? 0} officials
            {(() => {
              // drillNode.value is the log-scaled treemap area, not a dollar
              // amount — sum the actual donation cents from leaves instead.
              const realCents = drillNode.children?.reduce(
                (s, c) => s + (c.official?.total_donated_cents ?? 0),
                0,
              ) ?? 0;
              return realCents > 0
                ? ` · $${(realCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "";
            })()}
          </span>
        </div>
      )}

      {/* Context label */}
      {!drillNode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <span className="text-xs text-ink-soft bg-card/70 px-2 py-0.5 rounded-full">
            {contextLabel}
          </span>
        </div>
      )}

      <svg id="treemap-svg" ref={svgRef} className="w-full flex-1" />

      {/* Shared tooltip */}
      <Tooltip
        node={tooltip.node}
        x={tooltip.x}
        y={tooltip.y}
        visible={tooltip.visible}
        containerWidth={containerRef.current?.clientWidth}
      />

      {/* Shared popup */}
      <NodePopup
        node={popup}
        onClose={() => setPopup(null)}
        actions={nodeActions}
        vizType="treemap"
      />

      {/* Legend */}
      <div className="absolute bottom-3 right-3 flex items-center gap-3 bg-card/80 rounded-lg px-3 py-1.5">
        {renderLegend()}
      </div>
    </div>
  );
}
