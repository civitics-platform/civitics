"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, TreemapOptions } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TreemapOfficial {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  chamber: string;
  total_donated_cents: number;
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
}

// ── Industry colors (entity mode) ─────────────────────────────────────────────

const INDUSTRY_FILL_PALETTE = [
  "#1a2a3a", "#1a3a2a", "#2a1a3a", "#3a2a1a", "#1a3a3a",
  "#3a1a2a", "#2a3a1a", "#1a2a2a", "#2a2a1a", "#1a1a3a",
  "#3a1a1a", "#2a1a2a", "#1a3a1a",
];
const INDUSTRY_STROKE_PALETTE = [
  "#06b6d4", "#22c55e", "#a855f7", "#f97316", "#14b8a6",
  "#ec4899", "#84cc16", "#0ea5e9", "#eab308", "#6366f1",
  "#ef4444", "#8b5cf6", "#10b981",
];

function getIndustryFill(index: number): string {
  return INDUSTRY_FILL_PALETTE[index % INDUSTRY_FILL_PALETTE.length] ?? "#1e3040";
}

function getIndustryStroke(index: number): string {
  return INDUSTRY_STROKE_PALETTE[index % INDUSTRY_STROKE_PALETTE.length] ?? "#64748b";
}

// ── Party colors ──────────────────────────────────────────────────────────────

const PARTY_FILL: Record<string, string> = {
  democrat:    "#1e3a5f",
  republican:  "#5f1e1e",
  independent: "#3b1e5f",
  nonpartisan: "#1e3040",
};

const PARTY_STROKE: Record<string, string> = {
  democrat:    "#3b82f6",
  republican:  "#ef4444",
  independent: "#a855f7",
  nonpartisan: "#64748b",
};

const PARTY_LABEL: Record<string, string> = {
  democrat:    "Democrat",
  republican:  "Republican",
  independent: "Independent",
  nonpartisan: "Nonpartisan",
};

// ── Chamber colors ────────────────────────────────────────────────────────────

const CHAMBER_FILL: Record<string, string> = {
  senate: "#1e2f4f",
  house:  "#2f1e4f",
  unknown: "#1e3040",
};

const CHAMBER_STROKE: Record<string, string> = {
  senate: "#60a5fa",
  house:  "#c084fc",
  unknown: "#64748b",
};

const CHAMBER_LABEL: Record<string, string> = {
  senate: "Senate",
  house:  "House",
  unknown: "Unknown",
};

function getFill(key: string, colorBy: 'party' | 'chamber'): string {
  if (colorBy === 'chamber') return CHAMBER_FILL[key] ?? "#1e3040";
  return PARTY_FILL[key] ?? "#1e3040";
}

function getStroke(key: string, colorBy: 'party' | 'chamber'): string {
  if (colorBy === 'chamber') return CHAMBER_STROKE[key] ?? "#64748b";
  return PARTY_STROKE[key] ?? "#64748b";
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
    case 'party':
    default:        return official.party;
  }
}

function getSizeValue(official: TreemapOfficial, sizeBy: TreemapOptions['sizeBy']): number {
  switch (sizeBy) {
    case 'connection_count': return 1;      // flat; real data not in treemap payload
    case 'vote_count':       return 1;      // flat; real data not in treemap payload
    case 'donation_total':
    default:                 return official.total_donated_cents;
  }
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
}

export function TreemapGraph({ className = "", svgRef: externalSvgRef, vizOptions, primaryEntityId, primaryEntityName }: TreemapGraphProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef         = externalSvgRef ?? internalSvgRef;

  const [officials, setOfficials]         = useState<TreemapOfficial[]>([]);
  const [donors, setDonors]               = useState<DonorRow[]>([]);
  const [pacHierarchy, setPacHierarchy]   = useState<PacHierarchy | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup]       = useState<NewGraphNode | null>(null);
  const [drillNode, setDrillNode] = useState<GroupDatum | null>(null);

  const groupBy  = vizOptions?.groupBy  ?? 'party';
  const sizeBy   = vizOptions?.sizeBy   ?? 'donation_total';
  const colorBy  = vizOptions?.colorBy  ?? 'party';
  const dataMode = vizOptions?.dataMode ?? 'officials';

  // ── Fetch data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);

    // PAC modes — fetch from treemap-pac endpoint
    if (dataMode === 'pac_sector' || dataMode === 'pac_party') {
      const pacGroupBy = dataMode === 'pac_sector' ? 'sector' : 'party';
      fetch(`/api/graph/treemap-pac?groupBy=${pacGroupBy}`)
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

    const url = entityIdParam
      ? `/api/graph/treemap?entityId=${encodeURIComponent(entityIdParam)}&groupBy=${groupBy}&sizeBy=${sizeBy}`
      : `/api/graph/treemap?groupBy=${groupBy}&sizeBy=${sizeBy}`;

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
  // Refetch when entity / groupBy / sizeBy / dataMode change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEntityId, groupBy, sizeBy, dataMode]);

  // Reset drill state when the view changes
  useEffect(() => {
    setDrillNode(null);
  }, [vizOptions?.groupBy, vizOptions?.dataMode, primaryEntityId]);

  // ── Render treemap ──────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;

    const isPacMode       = dataMode === 'pac_sector' || dataMode === 'pac_party';
    const isPacSectorMode = dataMode === 'pac_sector';
    const isPacPartyMode  = dataMode === 'pac_party';
    const isEntityMode    = !!primaryEntityId && donors.length > 0;

    if (isPacMode && !pacHierarchy) return;
    if (!isPacMode && !isEntityMode && officials.length === 0) return;
    if (!isPacMode && isEntityMode && donors.length === 0) return;

    const width  = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    let root: GroupDatum;

    if (isPacMode && pacHierarchy) {
      // PAC hierarchy — pre-grouped from the API
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
      // Group donors by industry, assign a palette index per industry
      const grouped = d3.group(donors, (d) => d.industry_category);
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
            value:   getSizeValue(o, sizeBy),
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
      .attr("fill", (d) => (isPacSectorMode || isEntityMode)
        ? getIndustryFill(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_FILL[d.data.name.toLowerCase()] ?? "#1e3040")
          : getFill(d.data.name, colorBy as 'party' | 'chamber'))
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
      .attr("fill", (d) => (isPacSectorMode || isEntityMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[d.data.name.toLowerCase()] ?? "#64748b")
          : getStroke(d.data.name, colorBy as 'party' | 'chamber'))
      .attr("font-size", 11)
      .attr("font-weight", "600")
      .attr("font-family", "system-ui, sans-serif")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .style("-webkit-user-select", "none")
      .text((d) => isEntityMode
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
        .attr("fill", "#64748b")
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
      .attr("fill",   (d) => (isPacSectorMode || isEntityMode)
        ? getIndustryFill(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_FILL[(d.data.donor?.industry_category ?? "").toLowerCase()] ?? "#1e3040")
          : (() => {
              const key = d.data.official ? getGroupKey(d.data.official, colorBy === 'chamber' ? 'chamber' : 'party') : 'nonpartisan';
              return getFill(key, colorBy as 'party' | 'chamber');
            })())
      .attr("stroke", (d) => (isPacSectorMode || isEntityMode)
        ? getIndustryStroke(d.data.industryIndex ?? 0)
        : isPacPartyMode
          ? (PARTY_STROKE[(d.data.donor?.industry_category ?? "").toLowerCase()] ?? "#64748b")
          : (() => {
              const key = d.data.official ? getGroupKey(d.data.official, colorBy === 'chamber' ? 'chamber' : 'party') : 'nonpartisan';
              return getStroke(key, colorBy as 'party' | 'chamber');
            })())
      .attr("stroke-width", 0.5)
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
      .attr("fill", "#e2e8f0")
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
      .attr("fill", "#94a3b8")
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
  }, [officials, donors, pacHierarchy, primaryEntityId, groupBy, sizeBy, colorBy, dataMode, drillNode, showTip, hideTip]);

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
    addToComparison:  () => {},
    expandNode:       () => {},
  };

  const isPacMode    = dataMode === 'pac_sector' || dataMode === 'pac_party';
  const isEntityMode = !!primaryEntityId && !loading;

  // ── Legend ─────────────────────────────────────────────────────────────────

  function renderLegend() {
    if (isPacMode) {
      return (
        <span className="text-[10px] text-gray-500">
          Color = {dataMode === 'pac_sector' ? 'industry' : 'party'} · Size = total donated
        </span>
      );
    }
    if (isEntityMode) {
      return (
        <span className="text-[10px] text-gray-500">
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
              <span className="text-[10px] text-gray-400">{label}</span>
            </div>
          ))}
          <span className="text-[10px] text-gray-600 border-l border-gray-700 pl-3 ml-1">
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
            <span className="text-[10px] text-gray-400">{label}</span>
          </div>
        ))}
        <span className="text-[10px] text-gray-600 border-l border-gray-700 pl-3 ml-1">
          Size = donations received
        </span>
      </>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Loading donation data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-red-400 text-sm">Failed to load treemap: {error}</p>
      </div>
    );
  }

  const hasData = isPacMode
    ? !!pacHierarchy && pacHierarchy.children.length > 0
    : primaryEntityId
      ? donors.length > 0
      : officials.length > 0;
  if (!hasData) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-gray-500 text-sm">No donation data available yet.</p>
      </div>
    );
  }

  const contextLabel = isPacMode
    ? (dataMode === 'pac_sector' ? "PAC Money by Sector" : "PAC Money by Party")
    : primaryEntityId && primaryEntityName
      ? `${primaryEntityName} — Top Donors`
      : "All Officials by Party";

  return (
    <div ref={containerRef} className={`relative overflow-hidden flex flex-col ${className}`}>
      {/* Breadcrumb bar — shown only when drilled into a group */}
      {drillNode && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/80 border-b border-gray-700 text-xs shrink-0 z-10">
          <button
            onClick={() => setDrillNode(null)}
            className="text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
          >
            ← All
          </button>
          <span className="text-gray-500">/</span>
          <span className="text-gray-200 font-medium">
            {getGroupLabel(drillNode.name, groupBy)}
          </span>
          <span className="text-gray-500 ml-auto">
            {drillNode.children?.length ?? 0} officials
            {drillNode.value
              ? ` · $${(drillNode.value / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : ""}
          </span>
        </div>
      )}

      {/* Context label */}
      {!drillNode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <span className="text-xs text-gray-400 bg-gray-950/70 px-2 py-0.5 rounded-full">
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
      <div className="absolute bottom-3 right-3 flex items-center gap-3 bg-gray-950/80 rounded-lg px-3 py-1.5">
        {renderLegend()}
      </div>
    </div>
  );
}
