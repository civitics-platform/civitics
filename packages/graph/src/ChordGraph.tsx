"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, ChordOptions, FocusGroup } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";
import { resolveColor, resolveToken } from "./tokens";

interface DynamicGroup {
  label: string;
  icon: string;
  color: string;
  kind: "donor" | "recipient";
}

interface RawGroup {
  id: string;
  label: string;
  icon?: string;
  total_usd: number;
  pac_count: number;
  /** Industry tag — populated for top-pacs granularity so each PAC arc
   *  can be colored by its sector. */
  industry?: string;
}

interface RawRecipient {
  id: string;
  label: string;
  total_received_usd: number;
  official_count: number;
}

export interface ChordGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<ChordOptions>;
  primaryEntityId?: string | null;
  primaryGroup?: FocusGroup | null;
  secondaryGroup?: FocusGroup | null;
  /**
   * All officials currently in focus. When 2+ are present, the chord
   * renders a comparison view: M donor arcs × N official arcs, with each
   * ribbon weight proportional to that donor's contributions to that
   * specific official. Falls back to single-official mode when length<2.
   */
  focusedOfficials?: { id: string; name: string }[];
}

// Slider max for top-pacs granularity. Always fetch this many from the
// server so the user can drag the slider without firing new requests.
const MAX_PAC_ARCS = 50;

// Industry arc colors — enough for up to 13 industries. Built from the
// 9-hue categorical viz ramp (--c-viz-1..9), cycling for slots 10–13
// (FIX-729). Length must stay 13 — industryColor() hashes mod length.
const INDUSTRY_COLORS = [
  "rgb(var(--c-viz-1))", "rgb(var(--c-viz-2))", "rgb(var(--c-viz-3))",
  "rgb(var(--c-viz-4))", "rgb(var(--c-viz-5))", "rgb(var(--c-viz-6))",
  "rgb(var(--c-viz-7))", "rgb(var(--c-viz-8))", "rgb(var(--c-viz-9))",
  "rgb(var(--c-viz-1))", "rgb(var(--c-viz-2))", "rgb(var(--c-viz-3))",
  "rgb(var(--c-viz-4))",
];

// Party arc colors keyed to API party_chamber values.
// Includes both the legacy underscore form ("dem_senate") and the
// post-cutover space form ("Democrat Senate") emitted by the new RPCs.
// Token strings (FIX-729) — the per-chamber shade split (blue-500 senate vs
// blue-600 house) collapses to one hue per party; chamber is still legible
// from the arc labels.
const PARTY_COLORS: Record<string, string> = {
  // Legacy
  dem_senate:  "rgb(var(--c-blue))",
  rep_senate:  "rgb(var(--c-accent))",
  dem_house:   "rgb(var(--c-blue))",
  rep_house:   "rgb(var(--c-accent))",
  independent: "rgb(var(--c-viz-7))",
  // Post-cutover party_chamber strings
  "Democrat Senate":     "rgb(var(--c-blue))",
  "Republican Senate":   "rgb(var(--c-accent))",
  "Democrat House":      "rgb(var(--c-blue))",
  "Republican House":    "rgb(var(--c-accent))",
  "Independent Senate":  "rgb(var(--c-viz-7))",
  "Independent House":   "rgb(var(--c-viz-7))",
  "Other Senate":        "rgb(var(--c-ink-soft))",
  "Other House":         "rgb(var(--c-ink-soft))",
};

// Vote-outcome arc colors — green for affirmative, red for negative,
// neutral grey for abstain / present / not-voting.
const VOTE_OUTCOME_COLORS: Record<string, string> = {
  yes:   "rgb(var(--c-green-ink))",
  no:    "rgb(var(--c-accent))",
  other: "rgb(var(--c-ink-soft))",
};

// Donor-type arc colors — distinct hues for the financial_entities.entity_type
// enum (individual / pac / super_pac / corporation / union / party_committee /
// small_donor_aggregate / tribal / 527 / other).
const DONOR_TYPE_COLORS: Record<string, string> = {
  individual:            "rgb(var(--c-amber))",     // was amber
  pac:                   "rgb(var(--c-viz-6))",     // was orange → terracotta
  super_pac:             "rgb(var(--c-accent))",    // was red
  corporation:           "rgb(var(--c-viz-2))",     // was cyan → teal
  union:                 "rgb(var(--c-green-ink))", // was emerald
  party_committee:       "rgb(var(--c-viz-4))",     // was indigo → civic blue
  small_donor_aggregate: "rgb(var(--c-viz-8))",     // was lime → olive
  tribal:                "rgb(var(--c-viz-7))",     // was purple → wine
  '527':                 "rgb(var(--c-viz-9))",     // was pink → bronze
  other:                 "rgb(var(--c-ink-soft))",  // neutral
};

// Donor-bracket arc colors — match BRACKET_TIERS in types.ts so chord and
// force graph speak the same visual language for donor size brackets.
// Was a 4-step amber-monochrome ramp (amber-700 → amber-400); the token
// system has one amber, so the tiers now step through the warm viz hues
// dark→bright: bronze → terracotta → ochre-gold → amber (FIX-729).
const BRACKET_COLORS: Record<string, string> = {
  mega:  "rgb(var(--c-viz-9))",
  major: "rgb(var(--c-viz-6))",
  mid:   "rgb(var(--c-viz-3))",
  small: "rgb(var(--c-amber))",
};

// Stable colorhash for industry tags so each industry maps to the same
// INDUSTRY_COLORS slot regardless of arc order. Keeps colors consistent
// when switching granularity between 'aggregate' and 'top-pacs'.
function industryColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return INDUSTRY_COLORS[Math.abs(h) % INDUSTRY_COLORS.length] ?? "rgb(var(--c-ink-soft))";
}

/**
 * Pick a color for a chord arc based on its kind (donor / recipient),
 * the active dataMode, and the active granularity. Falls back to
 * INDUSTRY_COLORS / PARTY_COLORS for the default behavior.
 */
function colorForArc(
  group: { kind: 'donor' | 'recipient'; id?: string; industry?: string },
  index: number,
  dataMode?: string,
  granularity?: string,
): string {
  // Recipient-side palettes override INDUSTRY_COLORS
  if (group.kind === 'recipient') {
    if (dataMode === 'sector-vote' && group.id) {
      return VOTE_OUTCOME_COLORS[group.id] ?? "rgb(var(--c-ink-soft))";
    }
    const partyColor = PARTY_COLORS[group.id ?? ''];
    if (partyColor) return partyColor;
    // Compare mode: recipient ids are UUIDs (not party_chamber strings).
    // Hash to a stable INDUSTRY_COLORS slot so each official gets a
    // distinct color across re-renders.
    if (group.id) return industryColor(group.id);
    return "rgb(var(--c-ink-soft))";
  }
  // Donor-side palettes
  // FIX-L — the untagged bucket is money from donors with no industry tag;
  // render it neutral so it never masquerades as a categorized sector.
  if (group.id === 'untagged') return "rgb(var(--c-ink-soft))";
  if (granularity === 'by-bracket' && group.id) {
    return BRACKET_COLORS[group.id] ?? "rgb(var(--c-ink-soft))";
  }
  if (granularity === 'top-pacs') {
    // Color each PAC arc by its industry so PACs cluster visually by sector.
    return industryColor(group.industry ?? 'untagged');
  }
  if (dataMode === 'donor-type-party' && group.id) {
    return DONOR_TYPE_COLORS[group.id] ?? "rgb(var(--c-ink-soft))";
  }
  if (dataMode === 'industry-party' || dataMode === 'industry-official') {
    // Use the industry tag (group.id) for stable per-industry colors.
    return industryColor(group.id ?? `idx-${index}`);
  }
  return INDUSTRY_COLORS[index % INDUSTRY_COLORS.length] ?? "rgb(var(--c-ink-soft))";
}

function formatDollars(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

function draw(
  svgEl: SVGSVGElement,
  squareMatrix: number[][],
  allGroups: DynamicGroup[],
  width: number,
  height: number,
  showLabels: boolean,
  onGroupHover: (index: number, x: number, y: number) => void,
  onGroupLeave: () => void,
  onGroupClick: (index: number) => void
) {
  d3.select(svgEl).selectAll("*").remove();

  // SVG presentation attributes can't carry var() — resolve tokens to
  // concrete colors against the svg's scope at draw time (FIX-729).
  const T = {
    bg:      resolveToken("--c-term-bg", svgEl),
    inkSoft: resolveToken("--c-ink-soft", svgEl),
  };

  if (width < 100 || height < 100) {
    d3.select(svgEl)
      .attr("width", width)
      .attr("height", height)
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", T.inkSoft)
      .attr("font-size", "12px")
      .text("Expand panel to see chord diagram");
    return;
  }

  const size   = Math.min(width, height);
  const outerR = Math.max(10, size / 2 - 80);
  const innerR = Math.max(5, outerR - 24);

  const g = d3.select(svgEl)
    .attr("width", width)
    .attr("height", height)
    .append("g")
    .attr("transform", `translate(${width / 2},${height / 2})`);

  const chord  = d3.chord().padAngle(0.05).sortSubgroups(d3.descending);
  const chords = chord(squareMatrix);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arc    = d3.arc<d3.ChordGroup>().innerRadius(innerR).outerRadius(outerR) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ribbon = d3.ribbon<d3.Chord, d3.ChordSubgroup>().radius(innerR) as any;

  const group = g.append("g")
    .selectAll("g")
    .data(chords.groups)
    .join("g");

  group.append("path")
    .attr("fill", (d) => resolveColor(allGroups[d.index]?.color ?? T.inkSoft, svgEl))
    .attr("stroke", T.bg)
    .attr("stroke-width", 1)
    .attr("d", arc)
    .style("cursor", "pointer")
    .on("mouseover", (event: MouseEvent, d) => {
      const rect = svgEl.getBoundingClientRect();
      const angle = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
      const r = (innerR + outerR) / 2;
      const x = width / 2 + r * Math.cos(angle);
      const y = height / 2 + r * Math.sin(angle);
      onGroupHover(d.index, x + rect.left - rect.left, y + rect.top - rect.top);
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => {
          const r = rd as d3.Chord;
          return r.source.index === d.index || r.target.index === d.index ? 0.9 : 0.1;
        });
    })
    .on("mouseout", () => {
      onGroupLeave();
      g.selectAll("path.ribbon").style("opacity", 0.7);
    })
    .on("click", (_event: MouseEvent, d) => {
      onGroupClick(d.index);
    });

  if (showLabels) {
    group.append("text")
      .each((d) => { (d as d3.ChordGroup & { angle: number }).angle = (d.startAngle + d.endAngle) / 2; })
      .attr("dy", "0.35em")
      .attr("transform", (d) => {
        const angle  = (d.startAngle + d.endAngle) / 2;
        const rotate = (angle * 180) / Math.PI - 90;
        const flip   = angle > Math.PI;
        return `rotate(${rotate}) translate(${outerR + 8},0)${flip ? " rotate(180)" : ""}`;
      })
      .attr("text-anchor", (d) => ((d.startAngle + d.endAngle) / 2 > Math.PI ? "end" : "start"))
      .attr("fill", T.inkSoft)
      .attr("font-size", "10px")
      .text((d) => {
        const grp = allGroups[d.index];
        return grp ? `${grp.icon} ${grp.label}`.trim() : `Group ${d.index}`;
      });
  }

  g.append("g")
    .attr("fill-opacity", 0.7)
    .selectAll("path")
    .data(chords)
    .join("path")
    .attr("class", "ribbon")
    .attr("d", ribbon)
    .attr("fill", (d) => resolveColor(allGroups[d.source.index]?.color ?? T.inkSoft, svgEl))
    .attr("stroke", T.bg)
    .attr("stroke-width", 0.5)
    .style("cursor", "pointer")
    .on("mouseover", (_event: MouseEvent, d) => {
      const src = allGroups[d.source.index];
      const tgt = allGroups[d.target.index];
      // Show tooltip at center of SVG for ribbons
      const rect = svgEl.getBoundingClientRect();
      onGroupHover(d.source.index, rect.width / 2, rect.height / 2);
      void tgt; void src; // used in label below
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => rd === d ? 1 : 0.1);
    })
    .on("mouseout", () => {
      onGroupLeave();
      g.selectAll("path.ribbon").style("opacity", 0.7);
    });
}

// ── Chart data stored in state ─────────────────────────────────────────────────

interface ChartData {
  square:     number[][];
  allGroups:  DynamicGroup[];
  rawGroups:  RawGroup[];
  rawRecipients: RawRecipient[];
}

export function ChordGraph({ className = "", svgRef: externalSvgRef, vizOptions, primaryEntityId, primaryGroup, secondaryGroup, focusedOfficials }: ChordGraphProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef        = externalSvgRef ?? internalSvgRef;
  const lastSizeRef   = useRef({ w: 0, h: 0 });

  const [status,    setStatus]    = useState<"loading" | "empty" | "error" | "ok">("loading");
  const [rawData,   setRawData]   = useState<{ groups: RawGroup[]; recipients: RawRecipient[]; matrix: number[][] } | null>(null);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [entityName, setEntityName] = useState<string | null>(null);
  // FIX-L — untagged donor money reported by the entity-aggregate route, so the
  // empty state can say what is actually missing instead of a pipeline platitude.
  const [untagged,  setUntagged]  = useState<{ usd: number; donors: number } | null>(null);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup] = useState<NewGraphNode | null>(null);

  // Map a chord group index → NewGraphNode for Tooltip/NodePopup
  const groupToNode = (i: number, data: ChartData): NewGraphNode => {
    if (i < data.rawGroups.length) {
      const g = data.rawGroups[i]!;
      return {
        id:              g.id,
        name:            g.label,
        type:            'financial',
        connectionCount: g.pac_count,
        donationTotal:   g.total_usd * 100,
      };
    }
    const r = data.rawRecipients[i - data.rawGroups.length];
    if (!r) return { id: String(i), name: `Group ${i}`, type: 'organization' };
    return {
      id:              r.id,
      name:            r.label,
      type:            'official',
      connectionCount: r.official_count,
      donationTotal:   r.total_received_usd * 100,
    };
  };

  // ── Effect 1: Fetch raw data ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setEntityName(null);
      setUntagged(null);
      try {
        // Both topPacsLimit and minFlowUsd are applied client-side in
        // Effect 2 — the server fetch is invariant of slider position so
        // dragging never refetches (no API spam, no 429s, no stale cache).
        const minFlow = 0;
        const dataMode = vizOptions?.dataMode;
        const granularity = vizOptions?.granularity ?? 'aggregate';
        const topPacsLimit = MAX_PAC_ARCS;

        let url: string;

        // Explicit dataMode short-circuits the inferred routing below.
        // Each new mode forwards entityId / groupFilter when provided so
        // the route can scope the query to the cohort.
        if (dataMode && dataMode !== 'industry-party'
                     && dataMode !== 'industry-official'
                     && dataMode !== 'sector-group'
                     && dataMode !== 'sector-group-pair') {
          const params = new URLSearchParams();
          params.set('dataMode', dataMode);
          params.set('minFlowUsd', String(minFlow));
          if (primaryEntityId && !primaryEntityId.startsWith('group-')) {
            params.set('entityId', primaryEntityId);
          }
          if (primaryGroup) {
            params.set('groupId', primaryGroup.id);
            params.set('groupFilter', JSON.stringify(primaryGroup.filter));
            params.set('groupName', primaryGroup.name);
          }
          url = `/api/graph/chord?${params.toString()}`;
        } else if ((focusedOfficials?.length ?? 0) >= 2) {
          // MODE 1b: Compare — 2+ officials focused. Each becomes a recipient
          // arc; donor arcs are the union/aggregate across all of them.
          const params = new URLSearchParams();
          params.set('entityIds', focusedOfficials!.map(o => o.id).join(','));
          params.set('minFlowUsd', String(minFlow));
          params.set('granularity', granularity);
          if (granularity === 'top-pacs') params.set('topPacsLimit', String(topPacsLimit));
          url = `/api/graph/chord?${params.toString()}`;
        } else if (primaryEntityId && !primaryEntityId.startsWith('group-')) {
          // MODE 1: Single official — forward granularity (aggregate / top-pacs / by-bracket)
          const params = new URLSearchParams();
          params.set('entityId', primaryEntityId);
          params.set('minFlowUsd', String(minFlow));
          params.set('granularity', granularity);
          if (granularity === 'top-pacs') params.set('topPacsLimit', String(topPacsLimit));
          url = `/api/graph/chord?${params.toString()}`;
        } else if (primaryGroup && secondaryGroup) {
          // MODE 3: Cross-group chord — flows BETWEEN two groups
          url = `/api/graph/chord` +
            `?groupId=${primaryGroup.id}` +
            `&groupFilter=${encodeURIComponent(JSON.stringify(primaryGroup.filter))}` +
            `&groupName=${encodeURIComponent(primaryGroup.name)}` +
            `&secondaryGroupId=${secondaryGroup.id}` +
            `&secondaryFilter=${encodeURIComponent(JSON.stringify(secondaryGroup.filter))}` +
            `&secondaryGroupName=${encodeURIComponent(secondaryGroup.name)}` +
            `&minFlowUsd=${minFlow}`;
        } else if (primaryGroup) {
          // MODE 2: Single group chord — donor industries → group
          const f = primaryGroup.filter;
          url = `/api/graph/chord` +
            `?groupId=${primaryGroup.id}` +
            `&groupFilter=${encodeURIComponent(JSON.stringify(f))}` +
            `&groupName=${encodeURIComponent(primaryGroup.name)}` +
            `&entity_type=${f.entity_type}` +
            (f.chamber ? `&chamber=${f.chamber}` : '') +
            (f.party ? `&party=${f.party}` : '') +
            (f.state ? `&state=${f.state}` : '') +
            (f.industry ? `&industry=${f.industry}` : '') +
            `&minFlowUsd=${minFlow}`;
        } else {
          // MODE 0: Aggregate
          url = `/api/graph/chord?minFlowUsd=${minFlow}`;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json() as {
          groups?:     RawGroup[];
          recipients?: RawRecipient[];
          matrix?:     number[][];
          untagged_usd?: number;
          untagged_donors?: number;
          error?: string;
        };

        if (cancelled) return;

        // FIX-L — capture the untagged figure (entity-aggregate mode) so the
        // empty state can be honest about money that exists but isn't tagged.
        if (typeof json.untagged_usd === 'number' && json.untagged_usd > 0) {
          setUntagged({ usd: json.untagged_usd, donors: json.untagged_donors ?? 0 });
        }

        if (json.error || !json.groups?.length || !json.matrix?.length) {
          setStatus("empty");
          return;
        }

        if (!cancelled) {
          // In entity mode the single recipient label is the official's name
          if (primaryEntityId && !primaryEntityId.startsWith('group-') && json.recipients?.[0]?.label) {
            setEntityName(json.recipients[0].label);
          }
          setRawData({
            groups:     json.groups,
            recipients: json.recipients ?? [],
            matrix:     json.matrix,
          });
        }
      } catch (err) {
        console.error('[ChordGraph] fetch error:', err);
        if (!cancelled) setStatus("error");
      }
    }

    void load();
    return () => { cancelled = true; };
  // Note: vizOptions.topPacsLimit and vizOptions.minFlowUsd are intentionally
  // NOT in this list — both are applied client-side in Effect 2, so dragging
  // those sliders never refetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEntityId, primaryGroup?.id, secondaryGroup?.id, vizOptions?.dataMode, vizOptions?.granularity, focusedOfficials?.map(o => o.id).join(',')]);

  // ── Effect 2: Apply vizOptions to raw data → chartData ───────────────────
  useEffect(() => {
    if (!rawData) return;

    const minFlow      = vizOptions?.minFlowUsd ?? 0;
    const normalizeMode = vizOptions?.normalizeMode ?? false;
    const granularity  = vizOptions?.granularity ?? 'aggregate';
    const topPacsLimit = vizOptions?.topPacsLimit ?? 12;

    // Filter groups by minFlowUsd
    let filteredGroups = minFlow > 0
      ? rawData.groups.filter(g => g.total_usd >= minFlow)
      : rawData.groups;

    // Client-side slice for top-pacs granularity. Server returns up to
    // MAX_PAC_ARCS (50); slider trims to user's chosen N without refetch.
    if (granularity === 'top-pacs' && filteredGroups.length > topPacsLimit) {
      filteredGroups = filteredGroups.slice(0, topPacsLimit);
    }

    // If all groups filtered out, show empty state
    if (filteredGroups.length === 0) {
      setStatus("empty");
      return;
    }

    // Build index map: original group index → new filtered index
    const originalIndices = filteredGroups.map(g => rawData.groups.indexOf(g));

    const recipients = rawData.recipients;

    const dataMode = vizOptions?.dataMode;
    const allGroups: DynamicGroup[] = [
      ...filteredGroups.map((g, i) => ({
        label: g.label,
        icon:  g.icon ?? "🏢",
        color: colorForArc({ kind: 'donor', id: g.id, industry: g.industry }, i, dataMode, granularity),
        kind:  "donor" as const,
      })),
      ...recipients.map((r) => ({
        label: r.label,
        icon:  "",
        color: colorForArc({ kind: 'recipient', id: r.id }, 0, dataMode, granularity),
        kind:  "recipient" as const,
      })),
    ];

    // Rebuild matrix using only filtered groups
    const N = filteredGroups.length + recipients.length;
    let rawMatrix: number[][] = Array.from({ length: N }, () => Array(N).fill(0) as number[]);

    originalIndices.forEach((origI, newI) => {
      const row = rawData.matrix[origI];
      if (!row) return;
      row.forEach((val, j) => {
        const partyIdx = filteredGroups.length + j;
        const rowN = rawMatrix[newI];
        const rowP = rawMatrix[partyIdx];
        if (rowN) rowN[partyIdx] = val;
        if (rowP) rowP[newI] = val;
      });
    });

    // Apply normalizeMode: normalize each donor row to 100%
    const square = normalizeMode
      ? rawMatrix.map(row => {
          const total = row.reduce((s, v) => s + v, 0);
          return total === 0 ? row : row.map(v => v / total);
        })
      : rawMatrix;

    setChartData({ square, allGroups, rawGroups: filteredGroups, rawRecipients: recipients });
    setStatus("ok");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawData, vizOptions?.minFlowUsd, vizOptions?.normalizeMode, vizOptions?.topPacsLimit, vizOptions?.granularity]);

  // ── Effect 3: Draw ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "ok" || !chartData) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const container = containerRef.current;
    const { width, height } = container
      ? container.getBoundingClientRect()
      : { width: 600, height: 500 };

    draw(
      svgEl,
      chartData.square,
      chartData.allGroups,
      width || 600,
      height || 500,
      vizOptions?.showLabels ?? true,
      (index, x, y) => showTip(groupToNode(index, chartData), x, y),
      hideTip,
      (index) => setPopup(groupToNode(index, chartData))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, chartData, vizOptions?.showLabels, svgRef]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "ok" || !chartData) return;
    const container = containerRef.current;
    if (!container) return;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !svgRef.current) return;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w === lastSizeRef.current.w && h === lastSizeRef.current.h) return;
      lastSizeRef.current = { w, h };
      if (w > 0 && h > 0) {
        draw(
          svgRef.current,
          chartData.square,
          chartData.allGroups,
          w,
          h,
          vizOptions?.showLabels ?? true,
          (index, x, y) => showTip(groupToNode(index, chartData), x, y),
          hideTip,
          (index) => setPopup(groupToNode(index, chartData))
        );
      }
    });

    obs.observe(container);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, chartData, vizOptions?.showLabels, svgRef]);

  // NodeActions for chord — no recenter/comparison (groups aren't individual officials)
  const nodeActions: NodeActions = {
    recenter:         () => {},
    openProfile:      (nodeId) => window.open(`/officials/${nodeId}`, "_blank"),
    expandNode:       () => {},
  };

  return (
    <div ref={containerRef} className={`relative w-full h-full flex items-center justify-center ${className}`}>
      {status === "loading" && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <p className="text-ink-soft text-sm">Loading donation flows…</p>
        </div>
      )}

      {status === "error" && (
        <div className="text-center">
          <p className="text-accent text-sm">Failed to load chord data.</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-xs text-accent hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {status === "empty" && (
        <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-card/80 border border-rule">
          <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-rule flex items-center justify-center">
            <svg className="w-5 h-5 text-term-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          {untagged && untagged.usd > 0 ? (
            <>
              <p className="text-ink text-sm font-medium">
                {formatDollars(untagged.usd)} from {untagged.donors.toLocaleString()} donors — not yet industry-tagged.
              </p>
              <p className="text-ink-soft text-xs mt-2 leading-relaxed">
                {entityName ? `${entityName}'s` : "This cohort's"} donors haven&apos;t been
                assigned industries yet, so there are no sector arcs to chart. The money is
                real — it just isn&apos;t categorized.
              </p>
            </>
          ) : (
            <>
              <p className="text-ink text-sm font-medium">No donation flow data available.</p>
              <p className="text-ink-soft text-xs mt-2 leading-relaxed">
                No industry-tagged donations to chart for this view yet.
              </p>
            </>
          )}
        </div>
      )}

      {status === "ok" && (
        <>
          <svg id="chord-diagram-svg" ref={svgRef} className="w-full h-full" />
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <span className="text-xs text-ink-soft bg-term-bg/70 px-2 py-0.5 rounded-full">
              {(() => {
                const focusName = entityName ?? primaryGroup?.name ?? null;
                const compareCount = focusedOfficials?.length ?? 0;
                if (compareCount >= 2 && !vizOptions?.dataMode) {
                  const names = focusedOfficials!.map(o => o.name).join(' vs ');
                  const granLabel = vizOptions?.granularity === 'top-pacs' ? 'Top PACs'
                                  : vizOptions?.granularity === 'by-bracket' ? 'Donor Size'
                                  : 'Industries';
                  return `${granLabel} → ${names}`;
                }
                switch (vizOptions?.dataMode) {
                  case 'sector-vote':
                    return focusName
                      ? `${focusName}: Donor Sectors \u2194 Vote Outcomes`
                      : "Donor Sectors \u2194 Vote Outcomes";
                  case 'subject-party':
                    return focusName
                      ? `${focusName}: Bill Subjects \u2192 Party`
                      : "Bill Subjects \u2192 Party Chambers";
                  case 'donor-type-party':
                    return focusName
                      ? `${focusName}: Donor Types \u2192 Party`
                      : "Donor Types \u2192 Party Chambers";
                  case 'state-party':
                    return focusName
                      ? `${focusName}: Donor States \u2192 Party`
                      : "Donor States \u2192 Party Chambers";
                  default:
                    if (primaryGroup && secondaryGroup) return `${primaryGroup.name} \u2194 ${secondaryGroup.name} Money Flows`;
                    if (primaryGroup) return `Who Funds ${primaryGroup.name}?`;
                    if (primaryEntityId && !primaryEntityId.startsWith('group-') && entityName) return `${entityName}'s Industry Donors`;
                    return "Industry \u2192 Party Flows";
                }
              })()}
            </span>
          </div>
        </>
      )}

      {/* Shared tooltip */}
      <Tooltip
        node={tooltip.node}
        x={tooltip.x}
        y={tooltip.y}
        visible={tooltip.visible}
      />

      {/* Shared popup */}
      <NodePopup
        node={popup}
        onClose={() => setPopup(null)}
        actions={nodeActions}
        vizType="chord"
      />
    </div>
  );
}
