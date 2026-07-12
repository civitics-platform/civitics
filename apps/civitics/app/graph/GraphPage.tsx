"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  SharedConnectionsBar,
  AiNarrative,
  useGraphView,
  useGraphData,
  GraphHeader,
  DataExplorerPanel,
  GraphConfigPanel,
  VIZ_REGISTRY,
  isFocusEntity,
  isFocusGroup,
  createCustomGroup,
  BRACKET_TIERS,
  DonorListPanel,
} from "@civitics/graph";
import type { VizType, FocusEntity, FocusGroup, GroupFilter, GraphNodeV2 as GraphNode, GraphEdgeV2 as GraphEdge, GraphMeta, UserNodeInfo, IndividualDisplayMode } from "@civitics/graph";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";
import { SidebarBrowser } from "../search/components/explorer/SidebarBrowser";
import { PorticoMark }     from "../components/brand/PorticoMark";
import { SharePanel }      from "./SharePanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { GhostGraph }      from "./GhostGraph";
import { EmptyStatePresets } from "./EmptyStatePresets";

// FIX-205 — defer the 9 viz components off the initial /graph chunk. Each
// import() goes through next/dynamic with ssr:false, so the D3 + Sankey
// payload (~180 KB) is loaded only when a viz is actually rendered, not on
// every navigation. Conditional rendering downstream ensures only the
// active viz is mounted; switching tabs incurs a small load on first visit
// to a new viz, but the chunk is cached so subsequent switches are instant.
const ForceGraph     = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.ForceGraph })),     { ssr: false });
const TreemapGraph   = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.TreemapGraph })),   { ssr: false });
const ChordGraph     = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.ChordGraph })),     { ssr: false });
const SunburstGraph  = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.SunburstGraph })),  { ssr: false });
const SpendingGraph  = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.SpendingGraph })),  { ssr: false });
const HierarchyGraph = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.HierarchyGraph })), { ssr: false });
const MatrixGraph    = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.MatrixGraph })),    { ssr: false });
const AlignmentGraph = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.AlignmentGraph })), { ssr: false });
const SankeyGraph    = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.SankeyGraph })),    { ssr: false });
// FIX-733 — the FIX-217 trio was registry-selectable but never mounted here,
// so picking Scatter/Choropleth/Gantt rendered a blank canvas.
const ScatterGraph    = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.ScatterGraph })),    { ssr: false });
const ChoroplethGraph = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.ChoroplethGraph })), { ssr: false });
const GanttGraph      = dynamic(() => import("@civitics/graph").then((m) => ({ default: m.GanttGraph })),      { ssr: false });

// ── GraphPage ──────────────────────────────────────────────────────────────────

interface GraphPageProps {
  initialCode?: string;
  /** Serialized snapshot state (old arch or v2 JSON). Stage 2: restore full GraphView. */
  initialState?: Record<string, unknown>;
  /** AI_NARRATIVE_ENABLED kill switch — read server-side and threaded down. Defaults true. */
  aiEnabled?: boolean;
}

export function GraphPage({ initialCode, aiEnabled = true }: GraphPageProps = {}) {
  // ── Graph view state (three-layer model) ──────────────────────────────────
  const graphHooks = useGraphView();
  const { view }   = graphHooks;

  // ── Group handoff from /agencies (FIX-127) ────────────────────────────────
  // The /agencies sidebar widget navigates to /graph?groupType=...&groupName=...
  // with the GroupFilter encoded in URL params. Decode once on mount, add the
  // group, and strip the params so a refresh doesn't re-add it.
  const groupHandoffRef = useRef(false);
  useEffect(() => {
    if (groupHandoffRef.current) return;
    if (initialCode) return; // share-code hydration owns focus
    if (typeof window === "undefined") return;

    const params = new URL(window.location.href).searchParams;
    const groupType = params.get("groupType");
    if (!groupType || !["official", "pac", "agency"].includes(groupType)) return;

    groupHandoffRef.current = true;

    const filter: GroupFilter = { entity_type: groupType as GroupFilter["entity_type"] };
    const chamber = params.get("groupChamber");
    if (chamber === "senate" || chamber === "house") filter.chamber = chamber;
    const party = params.get("groupParty");
    if (party) filter.party = party;
    const state = params.get("groupState");
    if (state) filter.state = state;
    const industry = params.get("groupIndustry");
    if (industry) filter.industry = industry;

    const name = params.get("groupName") ?? undefined;
    graphHooks.addGroup(createCustomGroup(filter, name));

    // Strip the group params so refresh / share doesn't re-trigger.
    const cleaned = new URL(window.location.href);
    for (const k of ["groupType","groupName","groupChamber","groupParty","groupState","groupIndustry"]) {
      cleaned.searchParams.delete(k);
    }
    window.history.replaceState({}, "", cleaned.toString());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  // FIX-764 — visible notice when the handoff decode drops non-seedable kinds.
  // The FIX-472 whitelist only console.warn'd, which is silent in prod — a
  // hand-built or stale URL read as a mysteriously-empty graph.
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);

  // ── Entity handoff from /search (multi-select "Add individually") ──────────
  // /search navigates to /graph?addEntityIds=uuid1,uuid2&addEntityTypes=official,agency
  // Decode once on mount, add each entity, strip the params.
  const entityHandoffRef = useRef(false);
  useEffect(() => {
    if (entityHandoffRef.current) return;
    if (initialCode) return;
    if (typeof window === "undefined") return;

    const params = new URL(window.location.href).searchParams;
    const rawIds   = params.get("addEntityIds");
    const rawTypes = params.get("addEntityTypes");
    if (!rawIds || !rawTypes) return;

    entityHandoffRef.current = true;

    const ids   = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
    const types = rawTypes.split(",").map((s) => s.trim()).filter(Boolean);
    const MAX = 5;

    // FIX-472 — the search UI already filters un-graphable kinds before building
    // the handoff URL; this whitelist is the backstop for hand-built / stale URLs.
    // Warn (dev console) instead of dropping silently so a malformed handoff is
    // visible rather than a mysteriously-empty graph.
    const dropped: Array<{ id: string; type: string }> = [];
    ids.slice(0, MAX).forEach((id, i) => {
      const type = types[i] ?? "official";
      if (!isGraphSeedableKind(type)) {
        dropped.push({ id, type });
        return;
      }
      // FIX-490 (FIX-468 Wave A C1) — institutions become gb-backed GROUPS, not
      // focus entities. The synthetic group id encodes the gb uuid so the route
      // resolves it (UUID fallback) and the id persists stably in saved sessions.
      // Mixed payloads compose: every other kind continues through addEntity.
      if (type === "institution") {
        graphHooks.addGroup({
          id: `group-gb-${id}`,
          name: "Institution", // server resolves the real name on group fetch
          type: "group",
          icon: "🏛",
          color: "rgb(var(--c-viz-5))",
          filter: { entity_type: "official", governingBody: id },
          isPremade: false,
        });
        return;
      }
      graphHooks.addEntity({
        id,
        name: id, // graph will resolve the real name on data fetch
        type,
      });
    });
    if (dropped.length > 0) {
      console.warn(
        `[graph] add-to-graph: dropped ${dropped.length} un-graphable entit${dropped.length === 1 ? "y" : "ies"} ` +
          `(the graph can't render these kinds yet):`,
        dropped,
      );
      // FIX-764 — surface the drop to the user, not just the dev console.
      const kinds = [...new Set(dropped.map((d) => d.type))].join(", ");
      setHandoffNotice(
        `${dropped.length} item${dropped.length === 1 ? "" : "s"} couldn't be added — ` +
          `the graph can't render ${kinds} records yet.`,
      );
    }

    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("addEntityIds");
    cleaned.searchParams.delete("addEntityTypes");
    window.history.replaceState({}, "", cleaned.toString());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  // ── Viz handoff from /agencies (FIX-144) ─────────────────────────────────
  // The /agencies HierarchyEmbed links to /graph?viz=hierarchy. Read once on
  // mount, set the viz type, and strip the param so a refresh doesn't re-apply
  // it after the user has navigated within the graph.
  const vizHandoffRef = useRef(false);
  useEffect(() => {
    if (vizHandoffRef.current) return;
    if (initialCode) return;
    if (typeof window === "undefined") return;

    const params = new URL(window.location.href).searchParams;
    const vizParam = params.get("viz");
    const validVizTypes: VizType[] = ["force", "chord", "treemap", "sunburst", "spending", "hierarchy", "matrix", "alignment", "sankey", "scatter", "choropleth", "gantt"];
    if (!vizParam || !validVizTypes.includes(vizParam as VizType)) return;

    vizHandoffRef.current = true;
    graphHooks.setVizType(vizParam as VizType);

    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("viz");
    window.history.replaceState({}, "", cleaned.toString());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  // ── Auto-focus signed-in user's followed entities (FIX-042) ──────────────
  // On first mount, if nothing is focused and nothing is pre-loaded from
  // a share code, call /api/graph/me and addEntity for each follow. Limits
  // to 5 to respect MAX_FOCUS_ENTITIES.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (autoFocusedRef.current) return;
    if (initialCode) return; // share-code hydration owns focus
    if (view.focus.entities.length > 0) return;
    autoFocusedRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/graph/me", { credentials: "include" });
        if (!res.ok) return;
        const { entities } = await res.json() as {
          entities: Array<{
            id: string; name: string;
            type: "official" | "agency";
            role?: string; party?: string; photoUrl?: string;
            highlight?: boolean;
          }>;
        };
        for (const entity of entities.slice(0, 5)) {
          graphHooks.addEntity(entity);
        }
      } catch {
        // Unauthenticated or network error — silently fall back to empty graph.
      }
    })();
  }, [initialCode, view.focus.entities.length, graphHooks]);

  // ── USER node: fetch representatives + alignment scores ──────────────────
  // Independently of focus entities — always present when home_state is set.
  // FIX-120: also tracks visibility (toggleable in FocusTree).
  const USER_NODE_ID = "user:me";
  const userRepFetchedRef = useRef(false);
  const [userNode,       setUserNode]       = useState<GraphNode | null>(null);
  const [repNodes,       setRepNodes]       = useState<GraphNode[]>([]);
  const [alignmentEdges, setAlignmentEdges] = useState<GraphEdge[]>([]);
  const [userNodeVisible, setUserNodeVisible] = useState(true);

  // FIX-812 — YOU-node affordance card. 'signed-out' (401) and 'no-home-state'
  // (configured:false) both surface the dismissible card in the left panel;
  // dismissal persists in localStorage.
  const YOU_CARD_DISMISS_KEY = "civitics-graph-you-card-dismissed";
  const [youCardReason, setYouCardReason] = useState<"signed-out" | "no-home-state" | null>(null);
  const [youCardDismissed, setYouCardDismissed] = useState(true); // true until localStorage read
  useEffect(() => {
    try {
      setYouCardDismissed(localStorage.getItem(YOU_CARD_DISMISS_KEY) === "1");
    } catch { /* localStorage unavailable — keep hidden */ }
  }, []);
  function dismissYouCard() {
    setYouCardDismissed(true);
    try { localStorage.setItem(YOU_CARD_DISMISS_KEY, "1"); } catch { /* ignore */ }
  }

  useEffect(() => {
    if (userRepFetchedRef.current) return;
    if (initialCode) return;
    userRepFetchedRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/graph/my-representatives", { credentials: "include" });
        if (res.status === 401) {
          setYouCardReason("signed-out");
          return;
        }
        if (!res.ok) return;
        const { configured, reps } = await res.json() as {
          configured: boolean;
          reps: Array<{
            id: string; name: string; type: "official";
            role?: string; party?: "democrat" | "republican" | "independent";
            photoUrl?: string;
            alignment: {
              ratio: number | null;
              matchedVotes: number;
              totalVotes: number;
              voteDetails: Array<{ title: string; user_pos: string; official_vote: string; aligned: boolean }>;
            };
          }>;
        };
        if (!configured) {
          setYouCardReason("no-home-state");
          return;
        }
        if (!reps.length) return;

        setUserNode({
          id: USER_NODE_ID,
          name: "YOU",
          type: "user",
        });

        setRepNodes(reps.map(rep => ({
          id: rep.id,
          name: rep.name,
          type: rep.type,
          role: rep.role,
          party: rep.party,
        })));

        setAlignmentEdges(reps.map(rep => ({
          fromId: USER_NODE_ID,
          toId: rep.id,
          connectionType: "alignment",
          strength: 1,
          metadata: {
            alignmentRatio: rep.alignment.ratio,
            matchedVotes: rep.alignment.matchedVotes,
            totalVotes: rep.alignment.totalVotes,
            voteDetails: rep.alignment.voteDetails,
            officialName: rep.name,
          },
        })));
      } catch {
        // Unauthenticated or no preferences set — silently skip.
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  // ── Graph data (nodes + edges for all focused entities) ───────────────────
  // FIX-498 — gb groups seed with a placeholder name ("Institution" from the
  // /search handoff above; gb-list entries carry their real name already). When
  // the group route returns the server-resolved gb name, patch the focus entry
  // so the FOCUS/ACTIVE panel shows it. Scoped to `group-gb-*` ids: party-
  // filtered presets like "Senate Democrats" also resolve to the bare gb name
  // server-side, and must NOT have their preset names overwritten.
  const handleGroupResolved = (groupId: string, resolvedName: string) => {
    if (!groupId.startsWith("group-gb-")) return;
    graphHooks.updateGroup(groupId, { name: resolvedName });
  };

  const { nodes, allEdges, loadingEntityId, graphMeta, retryGroup } = useGraphData(
    view.focus,
    view.connections,
    view.style.vizOptions?.force,
    handleGroupResolved
  );

  // ── Donor list panel state (bracket node click-through) ───────────────────
  const BRACKET_IDS = new Set<string>(BRACKET_TIERS.map(t => t.id));

  interface DonorListState {
    officialId: string;
    officialName: string;
    tierOrEmployer: string;
    mode: IndividualDisplayMode;
  }
  const [donorListState, setDonorListState] = useState<DonorListState | null>(null);

  // Merge user node + rep nodes + alignment edges into the display arrays.
  // repNodes not already in `nodes` are added so alignment edges can render.
  // FIX-120: when userNodeVisible is false, fall back to the raw focus data.
  const displayNodes = useMemo((): GraphNode[] => {
    if (!userNode || !userNodeVisible) return nodes;
    const existingIds = new Set(nodes.map(n => n.id));
    const newReps = repNodes.filter(n => !existingIds.has(n.id));
    return [...nodes, ...newReps, userNode];
  }, [nodes, userNode, userNodeVisible, repNodes]);

  const displayEdges = useMemo((): GraphEdge[] => {
    if (!userNode || !userNodeVisible) return allEdges;
    return [...allEdges, ...alignmentEdges];
  }, [allEdges, userNode, userNodeVisible, alignmentEdges]);

  // FIX-120: aggregate alignment ratio across the user's reps. Drives both the
  // FocusTree YOU row badge and (indirectly) the USER node ring color.
  const overallAlignmentRatio = useMemo((): number | null => {
    const ratios = alignmentEdges
      .map(e => e.metadata?.alignmentRatio as number | null | undefined)
      .filter((v): v is number => typeof v === "number");
    if (ratios.length === 0) return null;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }, [alignmentEdges]);

  const userNodeInfo: UserNodeInfo | null = useMemo(() => {
    if (!userNode) return null;
    return {
      visible: userNodeVisible,
      alignmentRatio: overallAlignmentRatio,
      repCount: repNodes.length,
    };
  }, [userNode, userNodeVisible, overallAlignmentRatio, repNodes.length]);

  // FIX-120: surface alignment in graphMeta.connectionTypes so the
  // ConnectionsTree shows it under "Active Types" with a real count when the
  // YOU node is rendered.
  const displayGraphMeta = useMemo((): GraphMeta | undefined => {
    if (!graphMeta) return graphMeta;
    if (!userNodeVisible || alignmentEdges.length === 0) return graphMeta;
    return {
      ...graphMeta,
      connectionTypes: {
        ...graphMeta.connectionTypes,
        alignment: {
          count: alignmentEdges.length,
          totalAmount: 0,
        },
      },
    };
  }, [graphMeta, userNodeVisible, alignmentEdges.length]);

  // ── Panel collapse state ──────────────────────────────────────────────────
  // Auto-collapse both panels on small screens (<768px) — panels are fixed-width
  // and would leave no canvas space on mobile.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const [leftCollapsed,  setLeftCollapsed]  = useState(isMobile);
  const [rightCollapsed, setRightCollapsed] = useState(true);

  // ── Overlay state ─────────────────────────────────────────────────────────
  const [shareCode,       setShareCode]       = useState<string | null>(initialCode ?? null);
  const [showShare,       setShowShare]       = useState(false);
  const [showScreenshot,  setShowScreenshot]  = useState(false);

  // FIX-149: shared-connections pill bar selection — null when nothing pinned.
  const [highlightedSharedId, setHighlightedSharedId] = useState<string | null>(null);

  // FIX-812 — entity-row hover in the left panel transiently spotlights that
  // entity's neighborhood on the force canvas (through the FIX-807 resolver).
  const [hoveredFocusEntityId, setHoveredFocusEntityId] = useState<string | null>(null);

  // Clear pin whenever the focus set changes — old pin probably no longer makes sense.
  useEffect(() => {
    setHighlightedSharedId(null);
  }, [view.focus.entities]);

  // ── SVG refs for screenshot ───────────────────────────────────────────────
  // FIX-731 — the force ref rides a `svgRef` prop (not a JSX ref: next/dynamic
  // doesn't forward refs), same convention as every other viz below.
  const forceSvgRef      = useRef<SVGSVGElement>(null);
  const chordSvgRef      = useRef<SVGSVGElement>(null);
  const treemapSvgRef    = useRef<SVGSVGElement>(null);
  const sunburstSvgRef   = useRef<SVGSVGElement>(null);
  const hierarchySvgRef  = useRef<SVGSVGElement>(null);
  const matrixSvgRef     = useRef<SVGSVGElement>(null);
  const alignmentSvgRef  = useRef<SVGSVGElement>(null);
  const sankeySvgRef     = useRef<SVGSVGElement>(null);
  const scatterSvgRef    = useRef<SVGSVGElement>(null);
  const choroplethSvgRef = useRef<SVGSVGElement>(null);
  const ganttSvgRef      = useRef<SVGSVGElement>(null);

  // ── Keyboard: [ = left panel, ] = right panel ─────────────────────────────
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "[") setLeftCollapsed(p => !p);
      if (e.key === "]") setRightCollapsed(p => !p);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Header handlers ───────────────────────────────────────────────────────
  function handleHeaderVizChange(vizType: VizType) {
    graphHooks.setVizType(vizType);
  }

  function handleHeaderEntitySelect(id: string, name: string) {
    if (id) {
      graphHooks.addEntity({ id, name, type: "official" });
    }
  }

  function handleSavePreset() {
    if (typeof window === "undefined") return;
    const name = window.prompt("Name this view:");
    if (!name?.trim()) return;
    try {
      const existing = JSON.parse(localStorage.getItem("civitics_presets") ?? "[]");
      const newPreset = {
        ...view,
        meta: { name: name.trim(), isPreset: true, presetId: `user-${Date.now()}`, isDirty: false },
      };
      localStorage.setItem("civitics_presets", JSON.stringify([...existing, newPreset]));
    } catch { /* localStorage unavailable */ }
  }

  function handleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function handleScreenshot() {
    const vizDef = VIZ_REGISTRY.find(v => v.id === view.style.vizType);
    if (vizDef?.screenshotPrep) vizDef.screenshotPrep();
    setShowScreenshot(true);
  }

  function getScreenshotRef() {
    switch (view.style.vizType) {
      case "chord":      return chordSvgRef;
      case "treemap":    return treemapSvgRef;
      case "sunburst":   return sunburstSvgRef;
      case "hierarchy":  return hierarchySvgRef;
      case "matrix":     return matrixSvgRef;
      case "alignment":  return alignmentSvgRef;
      case "sankey":     return sankeySvgRef;
      case "scatter":    return scatterSvgRef;    // FIX-733
      case "choropleth": return choroplethSvgRef; // FIX-733
      case "gantt":      return ganttSvgRef;      // FIX-733
      // FIX-731 — returning null here made the force Download PNG a silent
      // no-op (ScreenshotPanel reads svgRef.current at click time).
      default:           return forceSvgRef;
    }
  }

  // ── Group node actions ─────────────────────────────────────────────────────
  function handleViewGroupAsTreemap(groupId: string) {
    const group = view.focus.entities.find(
      (e) => e.id === groupId && isFocusGroup(e)
    ) as FocusGroup | undefined;
    if (!group) return;

    graphHooks.setVizType('treemap');

    if (group.filter.entity_type === 'pac') {
      graphHooks.setVizOption('treemap', 'dataMode', 'pac_sector');
      graphHooks.setVizOption('treemap', 'groupBy', 'sector');
    } else {
      graphHooks.setVizOption('treemap', 'dataMode', 'officials');
      graphHooks.setVizOption('treemap', 'groupBy', group.filter.chamber ?? group.filter.party ?? 'party');
    }
  }

  function handleViewGroupAsChord(groupId: string) {
    void groupId;
    graphHooks.setVizType('chord');
  }

  function handleViewGroupAsSunburst(groupId: string) {
    void groupId;
    graphHooks.setVizType('sunburst');
  }

  function handleRemoveGroup(groupId: string) {
    graphHooks.removeGroup(groupId);
  }

  // FIX-497 — re-request a group whose donor aggregation failed (degraded state
  // surfaced in the group NodePopup). retryGroup re-runs the data effect for
  // exactly that un-cached group.
  function handleRetryGroup(groupId: string) {
    retryGroup(groupId);
  }

  function handleOpenDonorList(officialId: string, tierOrEmployer: string) {
    const cleanId = officialId.startsWith('official:') ? officialId.slice(9) : officialId;
    const officialNode = displayNodes.find(n => n.id === `official:${cleanId}` || n.id === cleanId);
    const officialName = officialNode?.name ?? cleanId;
    const mode: IndividualDisplayMode = BRACKET_IDS.has(tierOrEmployer) ? 'bracket' : 'employer';
    setDonorListState({ officialId: cleanId, officialName, tierOrEmployer, mode });
  }

  function handlePinDonor(donorId: string, donorName: string) {
    graphHooks.addEntity({ id: donorId, name: donorName, type: 'financial' });
  }

  // FIX-805 — NodePopup "Expand connections" on a collapsed (+) node. Interim
  // implementation: add the node as a focus entity, which runs the same
  // whole-entity fetch that search-add uses. G5 replaces this with an
  // incremental neighborhood fetch.
  const EXPAND_TYPE_MAP: Record<string, FocusEntity["type"]> = {
    official: "official",
    agency: "agency",
    proposal: "proposal",
    financial: "financial",
    pac: "financial",
    corporation: "financial",
    individual: "financial",
    organization: "financial",
  };

  function handleExpandNode(node: GraphNode) {
    if (graphHooks.atMaxFocus) return;
    const focusType = EXPAND_TYPE_MAP[node.type];
    if (!focusType) return; // group / user / bracket nodes aren't expandable entities
    const rawId = node.id.replace(/^[a-z_]+:/, "");
    if (!UUID_RE.test(rawId)) return;
    graphHooks.addEntity({ id: rawId, name: node.name, type: focusType });
  }

  const vizType      = view.style.vizType;

  // FIX-184: "Primary" drives single-entity vizes (treemap, sunburst, chord).
  // Resolution order:
  //   1. Explicitly pinned via the ★ in FocusTree (focus.primaryEntityId / primaryGroupId)
  //   2. Last-added of each type — picking the FIRST element silently sticks
  //      the treemap to whatever was added first regardless of later clicks.
  const focusEntityList = view.focus.entities.filter(isFocusEntity);
  const focusGroupList  = view.focus.entities.filter(isFocusGroup) as FocusGroup[];
  const pinnedEntity    = view.focus.primaryEntityId
    ? focusEntityList.find(e => e.id === view.focus.primaryEntityId) ?? null
    : null;
  const pinnedGroup     = view.focus.primaryGroupId
    ? focusGroupList.find(g => g.id === view.focus.primaryGroupId) ?? null
    : null;
  const primaryEntity   = pinnedEntity ?? focusEntityList[focusEntityList.length - 1] ?? null;
  const primaryGroup    = pinnedGroup  ?? focusGroupList[focusGroupList.length  - 1] ?? null;
  const focusGroups     = focusGroupList;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sunburstEntityId = primaryEntity?.id && UUID_RE.test(primaryEntity.id)
    ? primaryEntity.id
    : null;

  // ── Matrix viz props — UUID-validated official IDs in focus ───────────────
  const matrixOfficialIds = useMemo(() => {
    return view.focus.entities
      .filter(isFocusEntity)
      .filter(e => e.type === "official" && UUID_RE.test(e.id))
      .map(e => e.id);
  }, [view.focus.entities]);

  // ── Unified browser sidebar mount (FIX-762) ────────────────────────────────
  // App-side because it depends on @/lib/browse + explorer components the
  // graph package can't import; FocusTree renders it in place of the legacy
  // Find Entity + Browse Groups sections.
  const browserSlot = (
    <SidebarBrowser
      onAddEntity={(entity) => {
        if (graphHooks.atMaxFocus) return;
        graphHooks.addEntity(entity);
      }}
      onAddGroup={(group) => graphHooks.addGroup(group)}
      activeEntityIds={focusEntityList.map((e) => e.id)}
      activeGroupIds={focusGroupList.map((g) => g.id)}
      atMaxFocus={graphHooks.atMaxFocus}
    />
  );

  // ── YOU-node affordance card (FIX-812) ─────────────────────────────────────
  // App-side because it links to app routes (sign-in / the Citizen Desk).
  // Shown when the viewer is signed out or has no home_state; dismissible.
  const youCardSlot = youCardReason && !youCardDismissed ? (
    <div className="mx-3 my-3 rounded border border-rule bg-ink/5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium text-ink leading-snug">
          See your representatives on the graph
        </p>
        <button
          onClick={dismissYouCard}
          aria-label="Dismiss"
          className="shrink-0 text-ink-soft/60 hover:text-ink text-xs leading-none transition-colors"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-[10px] text-ink-soft leading-relaxed">
        {youCardReason === "signed-out"
          ? "Sign in and set your home state to add a YOU node connected to your senators and representative."
          : "Set your home state to add a YOU node connected to your senators and representative."}
      </p>
      <a
        href={youCardReason === "signed-out" ? "/auth/sign-in?next=/graph" : "/desk"}
        className="mt-2 inline-block rounded border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/20 transition-colors"
      >
        {youCardReason === "signed-out" ? "Sign in" : "Set home state"}
      </a>
    </div>
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    // Terminal Wave 3 (FIX-728): /graph is a fullscreen instrument with no site
    // masthead — the whole page is a terminal scope. text-ink must be restated
    // alongside bg-paper (inherited body color doesn't re-resolve in scope).
    <div data-theme="terminal" className="flex flex-col h-screen bg-paper text-ink">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <GraphHeader
        view={view}
        onVizChange={handleHeaderVizChange}
        onEntitySelect={handleHeaderEntitySelect}
        onShare={() => setShowShare(true)}
        onScreenshot={handleScreenshot}
        onFullscreen={handleFullscreen}
        aiEnabled={aiEnabled}
        graphMeta={displayGraphMeta}
        brand={
          <a
            href="/"
            aria-label="Civitics home"
            className="flex items-center gap-1.5 shrink-0 text-ink hover:text-accent transition-colors"
          >
            <PorticoMark size={18} />
            <span className="font-mono text-[11px] font-bold tracking-[0.18em]">CIVITICS</span>
          </a>
        }
      />

      {/* ── Three-column body ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — Focus (what is on the graph) */}
        <DataExplorerPanel
          view={view}
          hooks={graphHooks}
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(p => !p)}
          graphMeta={displayGraphMeta}
          userNode={userNodeInfo}
          onToggleUserNode={() => setUserNodeVisible(v => !v)}
          browserSlot={browserSlot}
          youCardSlot={youCardSlot}
          onEntityHover={setHoveredFocusEntityId}
        />

        {/* CANVAS */}
        <div className="flex-1 overflow-hidden relative">

          {/* FIX-764 — dropped-handoff notice (dismissible) */}
          {handoffNotice && (
            <div className="absolute top-3 left-1/2 z-30 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-[2px] border border-amber/50 bg-card px-3 py-2 shadow-lg">
              <span className="font-mono text-[11px] text-amber">{handoffNotice}</span>
              <button
                onClick={() => setHandoffNotice(null)}
                aria-label="Dismiss notice"
                className="font-mono text-[11px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-accent"
              >
                ✕
              </button>
            </div>
          )}

          {/* Active viz only — see FIX-205 import block at the top for why.
              The previous "all 9 mounted with opacity:0" pattern kept the D3
              chunk in initial First Load JS for /graph; conditional render
              + next/dynamic moves it to an async chunk that loads on first
              viz mount. Trade-off: we lose the cross-viz fade transition. */}

          {vizType === "force" && (
            <div className="absolute inset-0">
              {displayNodes.length === 0 ? (
                <div className="relative w-full h-full">
                  <GhostGraph className="w-full h-full absolute inset-0 opacity-30" />
                  <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                    <div className="max-w-md w-full mx-4 px-8 py-8 rounded-2xl bg-paper/80 backdrop-blur-sm border border-rule">
                      <div className="text-center">
                        <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-rule flex items-center justify-center">
                          <svg className="w-5 h-5 text-ink-soft/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                        </div>
                        <p className="text-ink text-sm font-medium">Search to start exploring</p>
                        <p className="text-ink-soft text-xs mt-2 leading-relaxed">
                          Use the left panel to add officials, agencies, or proposals to the graph.
                        </p>
                      </div>
                      {/* FIX-131: one-click preset cards for newcomers. */}
                      <EmptyStatePresets hooks={graphHooks} />
                    </div>
                  </div>
                </div>
              ) : (
                <ForceGraph
                  svgRef={forceSvgRef}
                  nodes={displayNodes}
                  edges={displayEdges}
                  loadingEntityId={loadingEntityId}
                  focusEntities={view.focus.entities.filter(isFocusEntity)}
                  connections={view.connections}
                  vizOptions={view.style.vizOptions?.force}
                  highlightedNodeId={highlightedSharedId}
                  panelHoverEntityId={hoveredFocusEntityId}
                  className="w-full h-full"
                  onViewGroupAsTreemap={handleViewGroupAsTreemap}
                  onViewGroupAsChord={handleViewGroupAsChord}
                  onViewGroupAsSunburst={handleViewGroupAsSunburst}
                  onRemoveGroup={handleRemoveGroup}
                  onRetryGroup={handleRetryGroup}
                  onOpenDonorList={handleOpenDonorList}
                  onExpandNode={handleExpandNode}
                />
              )}

              {/* FIX-149: shared-connections pill bar */}
              {view.focus.entities.filter(isFocusEntity).length >= 2 && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-[90%]">
                  <SharedConnectionsBar
                    focusItems={view.focus.entities}
                    nodes={displayNodes}
                    edges={displayEdges}
                    highlightedNodeId={highlightedSharedId}
                    onHighlight={setHighlightedSharedId}
                  />
                </div>
              )}
            </div>
          )}

          {vizType === "treemap" && (
            <div className="absolute inset-0">
              <TreemapGraph
                className="w-full h-full"
                svgRef={treemapSvgRef}
                vizOptions={view.style.vizOptions.treemap}
                primaryEntityId={primaryEntity?.id ?? null}
                primaryEntityName={primaryEntity?.name ?? null}
                primaryGroup={primaryGroup}
                secondaryGroup={
                  // FIX-185 — Cohort × Filter. If a non-primary PAC industry
                  // group is also focused alongside an officials cohort, treat
                  // it as a donor-side filter ("Senate Democrats sized by
                  // donations from Finance PACs only").
                  focusGroups.find(g =>
                    g.id !== primaryGroup?.id &&
                    g.filter.entity_type === 'pac' &&
                    !!g.filter.industry,
                  ) ?? null
                }
                focusEntities={focusEntityList}
                // FIX-220 — donation floor sourced from connections state.
                minAmountUsd={view.connections?.donation?.minAmount ?? 0}
              />
            </div>
          )}

          {vizType === "chord" && (
            <div className="absolute inset-0">
              <ChordGraph
                className="w-full h-full"
                svgRef={chordSvgRef}
                vizOptions={view.style.vizOptions.chord}
                primaryEntityId={primaryEntity?.id ?? null}
                primaryGroup={primaryGroup}
                secondaryGroup={focusGroups[1] ?? null}
                focusedOfficials={focusEntityList
                  .filter(e => e.type === 'official')
                  .map(e => ({ id: e.id, name: e.name }))}
              />
            </div>
          )}

          {vizType === "sunburst" && (
            <div className="absolute inset-0">
              <SunburstGraph
                className="w-full h-full"
                svgRef={sunburstSvgRef}
                entityId={sunburstEntityId ?? undefined}
                entityLabel={sunburstEntityId ? primaryEntity?.name : undefined}
                vizOptions={view.style.vizOptions.sunburst}
                primaryGroup={primaryGroup}
              />
            </div>
          )}

          {vizType === "spending" && (
            <div className="absolute inset-0">
              <SpendingGraph
                className="w-full h-full"
                vizOptions={view.style.vizOptions.spending}
              />
            </div>
          )}

          {vizType === "hierarchy" && (
            <div className="absolute inset-0">
              <HierarchyGraph
                className="w-full h-full"
                svgRef={hierarchySvgRef}
                vizOptions={view.style.vizOptions.hierarchy}
                rootEntityId={primaryEntity?.type === "agency" ? primaryEntity.id : null}
              />
            </div>
          )}

          {vizType === "matrix" && (
            <div className="absolute inset-0">
              <MatrixGraph
                className="w-full h-full"
                svgRef={matrixSvgRef}
                vizOptions={view.style.vizOptions.matrix}
                officialIds={matrixOfficialIds}
              />
            </div>
          )}

          {vizType === "alignment" && (
            <div className="absolute inset-0">
              <AlignmentGraph
                className="w-full h-full"
                svgRef={alignmentSvgRef}
                vizOptions={view.style.vizOptions.alignment}
                userNode={userNodeVisible ? userNode : null}
                repNodes={repNodes}
                alignmentEdges={alignmentEdges}
              />
            </div>
          )}

          {vizType === "sankey" && (
            <div className="absolute inset-0">
              <SankeyGraph
                className="w-full h-full"
                svgRef={sankeySvgRef}
                vizOptions={view.style.vizOptions.sankey}
              />
            </div>
          )}

          {/* FIX-733 — the FIX-217 trio, previously selectable but unmounted */}
          {vizType === "scatter" && (
            <div className="absolute inset-0">
              <ScatterGraph
                className="w-full h-full"
                svgRef={scatterSvgRef}
                vizOptions={view.style.vizOptions.scatter}
                primaryEntityId={primaryEntity?.id ?? null}
                primaryGroup={primaryGroup}
              />
            </div>
          )}

          {vizType === "choropleth" && (
            <div className="absolute inset-0">
              <ChoroplethGraph
                className="w-full h-full"
                svgRef={choroplethSvgRef}
                vizOptions={view.style.vizOptions.choropleth}
                primaryEntityId={primaryEntity?.id ?? null}
              />
            </div>
          )}

          {vizType === "gantt" && (
            <div className="absolute inset-0">
              <GanttGraph
                className="w-full h-full"
                svgRef={ganttSvgRef}
                vizOptions={view.style.vizOptions.gantt}
                primaryEntityId={primaryEntity?.type === "agency" ? primaryEntity.id : null}
                primaryEntityName={primaryEntity?.type === "agency" ? primaryEntity.name : null}
              />
            </div>
          )}

          {/* Floating share / screenshot panels */}
          {showShare && (
            <div className="absolute top-4 right-4 z-20">
              <SharePanel
                graphState={{
                  preset:         view.meta?.presetId ?? "custom",
                  edgeTypes:      null,
                  minStrength:    0,
                  nodeCount:      nodes.length,
                  edgeCount:      allEdges.length,
                  activeFilters:  Object.keys(view.connections).filter(t => view.connections[t]?.enabled),
                  visualConfig:   view.style as unknown as Record<string, unknown>,
                }}
                onCodeGenerated={(code) => { setShareCode(code); setShowShare(false); }}
                onClose={() => setShowShare(false)}
              />
            </div>
          )}

          {showScreenshot && (
            <div className="absolute top-4 right-4 z-20">
              <ScreenshotPanel
                svgRef={getScreenshotRef()}
                shareCode={shareCode}
                onClose={() => setShowScreenshot(false)}
              />
            </div>
          )}

          {/* Donor list slide-in panel */}
          {donorListState && (
            <DonorListPanel
              officialId={donorListState.officialId}
              officialName={donorListState.officialName}
              tierOrEmployer={donorListState.tierOrEmployer}
              mode={donorListState.mode}
              onClose={() => setDonorListState(null)}
              onPinDonor={handlePinDonor}
            />
          )}

        </div>{/* end CANVAS */}

        {/* RIGHT — View (how it renders): View + Connections tabs */}
        <GraphConfigPanel
          view={view}
          hooks={graphHooks}
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(p => !p)}
          onSavePreset={handleSavePreset}
          graphMeta={displayGraphMeta}
          userNodeVisible={!!userNodeInfo?.visible}
        />

      </div>
      {/* EmbedModal mount removed (FIX-806) — setShowEmbed was never called;
          SharePanel's embed snippet is the surviving embed path. */}
    </div>
  );
}
