"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { ForceGraph }   from "@civitics/graph";
import { TreemapGraph } from "@civitics/graph";
import { ChordGraph }   from "@civitics/graph";
import { SunburstGraph } from "@civitics/graph";
import { AiNarrative }  from "@civitics/graph";
import { EmbedModal }   from "@civitics/graph";
import type { GraphNode, GraphEdge, EdgeType, VisualConfig, EntitySearchResult } from "@civitics/graph";
import { DEFAULT_VISUAL_CONFIG, VIZ_REGISTRY } from "@civitics/graph";
import type { VizMode } from "@civitics/graph";
// Old preset data — used for initial filter defaults only
import { PRESETS } from "@civitics/graph";
import type { PresetId } from "@civitics/graph";
// New architecture
import { useGraphView, GraphHeader, SettingsPanel } from "@civitics/graph";
import type { VizType } from "@civitics/graph";
import { SharePanel }      from "./SharePanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { GhostGraph }      from "./GhostGraph";

// ── Depth filter utility ───────────────────────────────────────────────────────

function filterEdgesByDepth(
  allEdges: GraphEdge[],
  centerId: string,
  maxDepth: number
): GraphEdge[] {
  if (maxDepth >= 5) return allEdges;
  const visited  = new Set<string>([centerId]);
  let frontier   = new Set<string>([centerId]);
  for (let hop = 0; hop < maxDepth; hop++) {
    const next = new Set<string>();
    for (const edge of allEdges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) { next.add(edge.target); visited.add(edge.target); }
      if (frontier.has(edge.target) && !visited.has(edge.source)) { next.add(edge.source); visited.add(edge.source); }
    }
    frontier = next;
    if (next.size === 0) break;
  }
  return allEdges.filter((e) => visited.has(e.source) && visited.has(e.target));
}

// ── Industry keyword matching ──────────────────────────────────────────────────

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  pharma:      ["pharma", "drug", "medical", "health", "biotech", "pfizer", "merck"],
  oil_gas:     ["oil", "gas", "energy", "petroleum", "exxon", "chevron", "koch", "pipeline"],
  finance:     ["bank", "financial", "investment", "securities", "goldman", "jpmorgan", "wells"],
  tech:        ["tech", "software", "google", "amazon", "meta", "apple", "microsoft"],
  defense:     ["defense", "military", "lockheed", "boeing", "raytheon", "northrop"],
  real_estate: ["real estate", "realty", "housing", "property"],
  labor:       ["union", "workers", "seiu", "afscme", "teamsters", "afl"],
  agriculture: ["farm", "agri", "crop", "cattle", "dairy"],
};

const FINANCIAL_NODE_TYPES = new Set(["pac", "individual", "corporation"]);

// ── GraphPage ──────────────────────────────────────────────────────────────────

interface GraphPageProps {
  initialCode?: string;
  initialState?: Record<string, unknown>;
}

export function GraphPage({ initialCode, initialState }: GraphPageProps = {}) {
  const [allNodes, setAllNodes] = useState<GraphNode[]>([]);
  const [allEdges, setAllEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Visualization mode (kept in sync with graphHooks.view.style.vizType)
  const [viewMode, setViewMode] = useState<VizMode>("force");

  // Entity focus
  const [centerEntity, setCenterEntity] = useState<{ id: string; type: string; label: string } | null>(null);
  const [depth, setDepth]               = useState<number>(
    typeof initialState?.depth === "number" ? initialState.depth : 2
  );

  // Filter state (old arch — drives filteredEdges)
  const [activeFilters, setActiveFilters] = useState<EdgeType[] | null>(
    (initialState?.activeFilters as EdgeType[] | null | undefined) ??
    PRESETS[(initialState?.preset as PresetId | undefined) ?? "full_picture"].edgeTypes
  );
  const [minStrength, setMinStrength]     = useState<number>(
    typeof initialState?.minStrength === "number" ? initialState.minStrength : 0
  );
  const [industryFilter, setIndustryFilter] = useState<string | null>(null);
  const [visualConfig, setVisualConfig]     = useState<VisualConfig>(
    (initialState?.visualConfig as VisualConfig | undefined) ?? DEFAULT_VISUAL_CONFIG
  );

  // Share / screenshot
  const [shareCode, setShareCode]       = useState<string | null>(initialCode ?? null);
  const [showShare, setShowShare]       = useState(false);
  const [showScreenshot, setShowScreenshot] = useState(false);

  // AI Narrative
  const [showNarrative, setShowNarrative] = useState(false);

  // Embed Modal
  const [showEmbed, setShowEmbed] = useState(false);

  // Compare mode
  const [compareMode, setCompareMode]         = useState(false);
  const [compareEntity, setCompareEntity]     = useState<{ id: string; type: string; label: string } | null>(null);
  const [compareNodes, setCompareNodes]       = useState<GraphNode[]>([]);
  const [compareEdges, setCompareEdges]       = useState<GraphEdge[]>([]);

  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);

  // New architecture state
  const graphHooks = useGraphView();
  const { view }   = graphHooks;

  // SVG refs for screenshot
  const svgRef         = useRef<SVGSVGElement>(null);
  const chordSvgRef    = useRef<SVGSVGElement>(null);
  const treemapSvgRef  = useRef<SVGSVGElement>(null);
  const sunburstSvgRef = useRef<SVGSVGElement>(null);

  const lastFetchUrl       = useRef<string | null>(null);
  const hasAutoFilteredRef = useRef(false);

  // ── Load graph data ──────────────────────────────────────────────────────────
  useEffect(() => {
    const serverDepth = centerEntity ? Math.min(depth, 2) : undefined;
    const url = centerEntity
      ? `/api/graph/connections?entityId=${encodeURIComponent(centerEntity.id)}&depth=${serverDepth}`
      : "/api/graph/connections";

    if (url === lastFetchUrl.current) return;
    lastFetchUrl.current = url;

    setLoading(true);
    setError(null);
    fetch(url)
      .then((r) => r.json())
      .then((data: { nodes: GraphNode[]; edges: GraphEdge[]; count: number; error?: string }) => {
        if (data.error) throw new Error(data.error);
        hasAutoFilteredRef.current = false;
        setAllNodes(data.nodes);
        setAllEdges(data.edges);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [centerEntity, depth]);

  // ── Load compare entity data ─────────────────────────────────────────────────
  useEffect(() => {
    if (!compareEntity?.id) { setCompareNodes([]); setCompareEdges([]); return; }
    const url = `/api/graph/connections?entityId=${encodeURIComponent(compareEntity.id)}&depth=${Math.min(depth, 2)}`;
    fetch(url)
      .then((r) => r.json())
      .then((data: { nodes: GraphNode[]; edges: GraphEdge[]; count: number; error?: string }) => {
        if (data.error) return;
        setCompareNodes(data.nodes);
        setCompareEdges(data.edges);
      })
      .catch(() => { setCompareNodes([]); setCompareEdges([]); });
  }, [compareEntity, depth]);

  // ── Expand a collapsed node ──────────────────────────────────────────────────
  const handleExpandNode = useCallback(async (node: GraphNode) => {
    const entityId = node.metadata?.entityId as string | undefined;
    if (!entityId) return;
    setExpandingNodeId(entityId);
    try {
      const res  = await fetch(`/api/graph/connections?entityId=${encodeURIComponent(entityId)}&depth=1`);
      const data = await res.json() as { nodes: GraphNode[]; edges: GraphEdge[]; count: number };
      setAllNodes((prev) => {
        const nodeMap = new Map(prev.map((n) => [n.id, n]));
        for (const n of data.nodes) { if (!nodeMap.has(n.id)) nodeMap.set(n.id, n); }
        for (const [nodeId, n] of nodeMap) {
          if (n.metadata?.entityId === entityId && n.metadata?.collapsed) {
            nodeMap.set(nodeId, { ...n, metadata: { ...n.metadata, collapsed: false, connectionCount: undefined } });
          }
        }
        return [...nodeMap.values()];
      });
      setAllEdges((prev) => {
        const edgeMap = new Map(prev.map((e) => [e.id, e]));
        for (const e of data.edges) edgeMap.set(e.id, e);
        return [...edgeMap.values()];
      });
    } catch (err) {
      console.error("[expand node]", err);
    } finally {
      setExpandingNodeId(null);
    }
  }, []);

  // suppress unused warning — expandingNodeId is shown in UI indirectly
  void expandingNodeId;

  // ── Search for compare entity ────────────────────────────────────────────────
  const searchEntities = useCallback(async (query: string): Promise<EntitySearchResult[]> => {
    try {
      const res = await fetch(`/api/graph/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      return res.json() as Promise<EntitySearchResult[]>;
    } catch { return []; }
  }, []);

  void searchEntities; // may be used for compare entity search in future

  // ── Filtered edges ───────────────────────────────────────────────────────────
  const filteredEdges = useMemo(() => {
    let edges = allEdges;

    if (activeFilters !== null) {
      const allowed = new Set<EdgeType>(activeFilters);
      edges = edges.filter((e) => allowed.has(e.type));
    }

    if (minStrength > 0) {
      edges = edges.filter((e) => e.strength >= minStrength);
    }

    if (centerEntity) {
      const centerId = allNodes.find(
        (n) => n.metadata?.entityId === centerEntity.id && String(n.metadata?.entityType) === centerEntity.type
      )?.id ?? centerEntity.id;
      edges = filterEdgesByDepth(edges, centerId, depth);
    }

    if (industryFilter) {
      const keywords     = INDUSTRY_KEYWORDS[industryFilter] ?? [];
      const matchingIds  = new Set(
        allNodes
          .filter((n) => FINANCIAL_NODE_TYPES.has(n.type) && keywords.some((kw) => (n as unknown as { label: string }).label?.toLowerCase().includes(kw)))
          .map((n) => n.id)
      );
      edges = edges.filter((e) => e.type === "donation" && (matchingIds.has(e.source) || matchingIds.has(e.target)));
    }

    return edges;
  }, [allEdges, activeFilters, minStrength, centerEntity, allNodes, depth, industryFilter]);

  const visibleNodeIds = new Set<string>();
  filteredEdges.forEach((e) => { visibleNodeIds.add(e.source); visibleNodeIds.add(e.target); });
  const filteredNodes =
    filteredEdges.length === allEdges.length ? allNodes : allNodes.filter((n) => visibleNodeIds.has(n.id));

  // Auto-filter at 1000+ nodes
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (filteredNodes.length > 1000 && minStrength < 0.5 && !hasAutoFilteredRef.current) {
      hasAutoFilteredRef.current = true;
      setMinStrength(0.5);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes.length]);

  // ── Header handlers — keep old + new arch in sync ────────────────────────────
  function handleHeaderVizChange(vizType: VizType) {
    graphHooks.setVizType(vizType);
    setViewMode(vizType as VizMode);
  }

  function handleHeaderEntitySelect(id: string, name: string) {
    graphHooks.setEntity(id, name);
    if (id) {
      setCenterEntity({ id, type: "official", label: name });
      // If compare mode is on, second search sets the compare entity
      if (compareMode && centerEntity) {
        setCompareEntity({ id, type: "official", label: name });
        return;
      }
    } else {
      setCenterEntity(null);
    }
  }

  function handleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ── Screenshot — call screenshotPrep from registry then show panel ───────────
  function handleScreenshot() {
    const vizDef = VIZ_REGISTRY.find((v) => v.id === viewMode);
    if (vizDef?.screenshotPrep) vizDef.screenshotPrep();
    setShowScreenshot(true);
  }

  function getScreenshotRef() {
    switch (viewMode) {
      case "chord":    return chordSvgRef;
      case "treemap":  return treemapSvgRef;
      case "sunburst": return sunburstSvgRef;
      default:         return svgRef;
    }
  }

  // AI narrative context
  const activeFilterNames = useMemo(() => {
    if (!activeFilters) return [];
    return activeFilters.map((f) => f.replace(/_/g, " "));
  }, [activeFilters]);

  // Theme
  const bgClass =
    visualConfig.theme === "light" ? "bg-white text-gray-900"
    : visualConfig.theme === "print" ? "bg-white text-black"
    : "bg-gray-950 text-white";

  void setVisualConfig; // may be exposed via StyleSection in future

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-screen overflow-hidden ${bgClass}`}>

      {/* ── GraphHeader ─────────────────────────────────────────────────────── */}
      <GraphHeader
        view={view}
        onVizChange={handleHeaderVizChange}
        onEntitySelect={handleHeaderEntitySelect}
        onShare={() => setShowShare(true)}
        onScreenshot={handleScreenshot}
        onFullscreen={handleFullscreen}
      />

      {/* ── Node count warning bar ───────────────────────────────────────────── */}
      {!loading && viewMode === "force" && filteredNodes.length > 200 && (() => {
        const n          = filteredNodes.length;
        const isCritical = n > 1000;
        const isHigh     = n > 500;
        const bg        = isCritical ? "bg-red-950/40 border-red-900/50" : isHigh ? "bg-orange-950/40 border-orange-900/50" : "bg-amber-950/40 border-amber-900/50";
        const textColor = isCritical ? "text-red-400"    : isHigh ? "text-orange-400"   : "text-amber-400";
        return (
          <div className={`flex items-center gap-2 px-4 py-1.5 border-b shrink-0 ${bg}`}>
            <svg className={`w-3.5 h-3.5 shrink-0 ${textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className={`text-xs ${textColor}`}>
              {n.toLocaleString()} nodes —{" "}
              {isCritical ? "increase strength filter above 0.5 or reduce depth"
               : isHigh    ? "may be slow" : "consider filtering"}
            </span>
            {isHigh && minStrength < 0.5 && (
              <button onClick={() => setMinStrength(0.5)} className={`ml-2 text-xs underline ${textColor}`}>
                Apply strength ≥ 0.5
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Main canvas area (full width now — no sidebar) ──────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* ── Force graph ───────────────────────────────────────────────────── */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{ opacity: viewMode === "force" ? 1 : 0, pointerEvents: viewMode === "force" ? "auto" : "none" }}
        >
          {compareMode && compareEntity ? (
            /* Side-by-side comparison */
            <div className="flex h-full overflow-hidden">
              <div className="flex-1 relative overflow-hidden border-r border-gray-800">
                {loading && <LoadingOverlay />}
                <ForceGraph
                  ref={svgRef}
                  nodes={filteredNodes}
                  edges={filteredEdges}
                  onExpandNode={handleExpandNode}
                  visualConfig={visualConfig}
                  connectionSettings={view.connections}
                  className="w-full h-full"
                />
                <div className="absolute top-2 left-2 text-xs text-gray-400 bg-gray-900/80 px-2 py-1 rounded pointer-events-none">
                  {centerEntity?.label ?? "Entity A"}
                </div>
              </div>
              <div className="flex-1 relative overflow-hidden">
                <ForceGraph
                  nodes={compareNodes}
                  edges={compareEdges}
                  onExpandNode={handleExpandNode}
                  visualConfig={visualConfig}
                  connectionSettings={view.connections}
                  className="w-full h-full"
                />
                <div className="absolute top-2 left-2 text-xs text-gray-400 bg-gray-900/80 px-2 py-1 rounded pointer-events-none">
                  {compareEntity.label}
                </div>
              </div>
            </div>
          ) : (
            /* Single force graph */
            <div className="relative w-full h-full">
              {loading && <LoadingOverlay />}

              {!loading && error && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                  <div className="text-center">
                    <p className="text-red-400 text-sm">Failed to load: {error}</p>
                    <button onClick={() => window.location.reload()} className="mt-3 text-xs text-indigo-400 hover:underline">Retry</button>
                  </div>
                </div>
              )}

              {!loading && !error && allNodes.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                  <GhostGraph className="w-full h-full absolute inset-0 opacity-30" />
                  <div className="relative z-10 text-center max-w-sm px-8 py-10 rounded-2xl bg-gray-950/80 backdrop-blur-sm border border-gray-800">
                    <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-gray-700 flex items-center justify-center">
                      <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <p className="text-gray-300 text-sm font-medium leading-relaxed">Connections are being mapped</p>
                    <p className="text-gray-500 text-xs mt-2 leading-relaxed">
                      Check back soon as we process donor, vote, and relationship data.
                    </p>
                    <div className="flex gap-3 mt-6 justify-center">
                      <a href="/officials" className="px-4 py-2 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors">View Officials →</a>
                      <a href="/agencies"  className="px-4 py-2 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors">View Agencies →</a>
                    </div>
                  </div>
                </div>
              )}

              {!loading && !error && allNodes.length > 0 && !centerEntity && (
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
                  <div className="bg-gray-900/80 backdrop-blur-sm border border-gray-700 rounded-lg px-4 py-2 text-center">
                    <p className="text-xs text-gray-500">
                      Top 10 most connected officials ·{" "}
                      <span className="text-indigo-400">Select any entity to explore their network</span>
                    </p>
                  </div>
                </div>
              )}

              {!loading && !error && allNodes.length > 0 && filteredEdges.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                  <div className="text-center">
                    <p className="text-gray-500 text-sm">No connections match this filter.</p>
                    <p className="text-gray-600 text-xs mt-1">Try a different preset in the settings panel.</p>
                  </div>
                </div>
              )}

              <ForceGraph
                ref={svgRef}
                nodes={filteredNodes}
                edges={filteredEdges}
                onExpandNode={handleExpandNode}
                visualConfig={visualConfig}
                connectionSettings={view.connections}
                className="w-full h-full"
              />
            </div>
          )}
        </div>

        {/* ── Treemap ───────────────────────────────────────────────────────── */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{ opacity: viewMode === "treemap" ? 1 : 0, pointerEvents: viewMode === "treemap" ? "auto" : "none" }}
        >
          <TreemapGraph className="w-full h-full" svgRef={treemapSvgRef} />
        </div>

        {/* ── Chord ─────────────────────────────────────────────────────────── */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{ opacity: viewMode === "chord" ? 1 : 0, pointerEvents: viewMode === "chord" ? "auto" : "none" }}
        >
          <ChordGraph className="w-full h-full" svgRef={chordSvgRef} />
        </div>

        {/* ── Sunburst ──────────────────────────────────────────────────────── */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{ opacity: viewMode === "sunburst" ? 1 : 0, pointerEvents: viewMode === "sunburst" ? "auto" : "none" }}
        >
          <SunburstGraph
            className="w-full h-full"
            svgRef={sunburstSvgRef}
            entityId={centerEntity?.id}
            entityLabel={centerEntity?.label}
          />
        </div>

        {/* ── SettingsPanel (bottom-left, floats over canvas) ───────────────── */}
        <SettingsPanel
          hooks={graphHooks}
          onShare={() => setShowShare(true)}
          compareMode={compareMode}
          onCompareModeChange={setCompareMode}
          compareEntityName={compareEntity?.label ?? null}
        />

        {/* ── AI Narrative ─────────────────────────────────────────────────── */}
        <AiNarrative
          vizType={viewMode}
          entityNames={centerEntity ? [centerEntity.label] : []}
          activeFilters={activeFilterNames}
          isVisible={showNarrative}
          onClose={() => setShowNarrative(false)}
        />

        {/* ── Floating panels ───────────────────────────────────────────────── */}
        {showShare && (
          <div className="absolute top-4 right-4 z-20">
            <SharePanel
              graphState={{
                preset:            view.meta?.presetId ?? 'custom',
                edgeTypes:         activeFilters,
                minStrength,
                nodeCount:         filteredNodes.length,
                edgeCount:         filteredEdges.length,
                centerEntityId:    centerEntity?.id,
                centerEntityType:  centerEntity?.type,
                depth,
                activeFilters,
                visualConfig:      visualConfig as unknown as Record<string, unknown>,
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

      </div>

      {/* ── Embed Modal ───────────────────────────────────────────────────────── */}
      {showEmbed && (
        <EmbedModal shareCode={shareCode} onClose={() => setShowEmbed(false)} />
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function LoadingOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center z-10">
      <div className="text-center">
        <div className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mx-auto mb-4" />
        <p className="text-gray-500 text-sm">Loading connections…</p>
      </div>
    </div>
  );
}
