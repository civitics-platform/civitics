"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  SharedConnectionsBar,
  AiNarrative,
  EmbedModal,
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
import type { VizType, FocusGroup, GroupFilter, GraphNodeV2 as GraphNode, GraphEdgeV2 as GraphEdge, GraphMeta, UserNodeInfo, IndividualDisplayMode } from "@civitics/graph";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";
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
    const validVizTypes: VizType[] = ["force", "chord", "treemap", "sunburst", "spending", "hierarchy", "matrix", "alignment", "sankey"];
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

  useEffect(() => {
    if (userRepFetchedRef.current) return;
    if (initialCode) return;
    userRepFetchedRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/graph/my-representatives", { credentials: "include" });
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
        if (!configured || !reps.length) return;

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
  const { nodes, allEdges, loadingEntityId, graphMeta } = useGraphData(
    view.focus,
    view.connections,
    view.style.vizOptions?.force
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
  const [showEmbed,       setShowEmbed]       = useState(false);

  // FIX-149: shared-connections pill bar selection — null when nothing pinned.
  const [highlightedSharedId, setHighlightedSharedId] = useState<string | null>(null);

  // Clear pin whenever the focus set changes — old pin probably no longer makes sense.
  useEffect(() => {
    setHighlightedSharedId(null);
  }, [view.focus.entities]);

  // ── SVG refs for screenshot (chord / treemap / sunburst) ─────────────────
  // Force graph uses id="force-graph-canvas" via registry selector
  const chordSvgRef     = useRef<SVGSVGElement>(null);
  const treemapSvgRef   = useRef<SVGSVGElement>(null);
  const sunburstSvgRef  = useRef<SVGSVGElement>(null);
  const hierarchySvgRef = useRef<SVGSVGElement>(null);
  const matrixSvgRef    = useRef<SVGSVGElement>(null);
  const alignmentSvgRef = useRef<SVGSVGElement>(null);
  const sankeySvgRef    = useRef<SVGSVGElement>(null);

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
    const name = window.prompt("Name this preset:");
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
      case "chord":     return chordSvgRef;
      case "treemap":   return treemapSvgRef;
      case "sunburst":  return sunburstSvgRef;
      case "hierarchy": return hierarchySvgRef;
      case "matrix":    return matrixSvgRef;
      case "alignment": return alignmentSvgRef;
      case "sankey":    return sankeySvgRef;
      default:          return null; // force uses #force-graph-canvas via registry
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

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">

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
      />

      {/* ── Three-column body ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — Data Explorer */}
        <DataExplorerPanel
          view={view}
          hooks={graphHooks}
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(p => !p)}
          graphMeta={displayGraphMeta}
          userNode={userNodeInfo}
          onToggleUserNode={() => setUserNodeVisible(v => !v)}
        />

        {/* CANVAS */}
        <div className="flex-1 overflow-hidden relative">

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
                    <div className="max-w-md w-full mx-4 px-8 py-8 rounded-2xl bg-gray-950/80 backdrop-blur-sm border border-gray-800">
                      <div className="text-center">
                        <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-gray-700 flex items-center justify-center">
                          <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                        </div>
                        <p className="text-gray-300 text-sm font-medium">Search to start exploring</p>
                        <p className="text-gray-500 text-xs mt-2 leading-relaxed">
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
                  nodes={displayNodes}
                  edges={displayEdges}
                  loadingEntityId={loadingEntityId}
                  focusEntities={view.focus.entities.filter(isFocusEntity)}
                  connections={view.connections}
                  vizOptions={view.style.vizOptions?.force}
                  highlightedNodeId={highlightedSharedId}
                  className="w-full h-full"
                  onViewGroupAsTreemap={handleViewGroupAsTreemap}
                  onViewGroupAsChord={handleViewGroupAsChord}
                  onViewGroupAsSunburst={handleViewGroupAsSunburst}
                  onRemoveGroup={handleRemoveGroup}
                  onOpenDonorList={handleOpenDonorList}
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

        {/* RIGHT — Graph Config */}
        <GraphConfigPanel
          view={view}
          hooks={graphHooks}
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(p => !p)}
          onSavePreset={handleSavePreset}
          graphMeta={displayGraphMeta}
        />

      </div>

      {/* Embed Modal */}
      {showEmbed && (
        <EmbedModal shareCode={shareCode} onClose={() => setShowEmbed(false)} />
      )}
    </div>
  );
}
