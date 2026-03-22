"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { ForceGraph } from "@civitics/graph";
import { TreemapGraph } from "@civitics/graph";
import { ChordGraph } from "@civitics/graph";
import { SunburstGraph } from "@civitics/graph";
import { AiNarrative } from "@civitics/graph";
import { EmbedModal } from "@civitics/graph";
import type { GraphNode, GraphEdge, EdgeType, VisualConfig, EntitySearchResult } from "@civitics/graph";
import { DEFAULT_VISUAL_CONFIG, VIZ_REGISTRY } from "@civitics/graph";
import type { VizMode } from "@civitics/graph";
import { GraphSidebar, PRESETS, PRESET_ORDER } from "@civitics/graph";
import type { PresetId } from "@civitics/graph";
import { SharePanel } from "./SharePanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { GhostGraph } from "./GhostGraph";

// ── Depth filter utility ──────────────────────────────────────────────────────

function filterEdgesByDepth(
  allEdges: GraphEdge[],
  centerId: string,
  maxDepth: number
): GraphEdge[] {
  if (maxDepth >= 5) return allEdges;
  const visited = new Set<string>([centerId]);
  let frontier = new Set<string>([centerId]);
  for (let hop = 0; hop < maxDepth; hop++) {
    const next = new Set<string>();
    for (const edge of allEdges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) {
        next.add(edge.target);
        visited.add(edge.target);
      }
      if (frontier.has(edge.target) && !visited.has(edge.source)) {
        next.add(edge.source);
        visited.add(edge.source);
      }
    }
    frontier = next;
    if (next.size === 0) break;
  }
  return allEdges.filter((e) => visited.has(e.source) && visited.has(e.target));
}

// ── Industry keyword matching ─────────────────────────────────────────────────

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

// ── GraphPage ─────────────────────────────────────────────────────────────────

interface GraphPageProps {
  initialCode?: string;
  initialState?: Record<string, unknown>;
}

export function GraphPage({ initialCode, initialState }: GraphPageProps = {}) {
  const [allNodes, setAllNodes] = useState<GraphNode[]>([]);
  const [allEdges, setAllEdges] = useState<GraphEdge[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Visualization mode
  const [viewMode, setViewMode] = useState<VizMode>("force");

  // Preset state
  const [activePreset, setActivePreset] = useState<PresetId>(
    (initialState?.preset as PresetId | undefined) ?? "full_picture"
  );

  // Entity focus
  const [centerEntity, setCenterEntity] = useState<{ id: string; type: string; label: string } | null>(null);
  const [depth, setDepth] = useState<number>(
    typeof initialState?.depth === "number" ? initialState.depth : 2
  );

  // Filter state
  const [activeFilters, setActiveFilters] = useState<EdgeType[] | null>(
    (initialState?.activeFilters as EdgeType[] | null | undefined) ??
    PRESETS[(initialState?.preset as PresetId | undefined) ?? "full_picture"].edgeTypes
  );
  const [minStrength, setMinStrength] = useState<number>(
    typeof initialState?.minStrength === "number" ? initialState.minStrength : 0
  );
  const [industryFilter, setIndustryFilter] = useState<string | null>(null);

  // Visual config
  const [visualConfig, setVisualConfig] = useState<VisualConfig>(
    (initialState?.visualConfig as VisualConfig | undefined) ?? DEFAULT_VISUAL_CONFIG
  );

  // Share / screenshot
  const [shareCode, setShareCode] = useState<string | null>(initialCode ?? null);
  const [showShare, setShowShare] = useState(false);
  const [showScreenshot, setShowScreenshot] = useState(false);

  // AI Narrative
  const [showNarrative, setShowNarrative] = useState(false);

  // Embed Modal
  const [showEmbed, setShowEmbed] = useState(false);

  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareEntity, setCompareEntity] = useState<{ id: string; type: string; label: string } | null>(null);
  const [compareNodes, setCompareNodes] = useState<GraphNode[]>([]);
  const [compareEdges, setCompareEdges] = useState<GraphEdge[]>([]);

  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const chordSvgRef = useRef<SVGSVGElement>(null);
  const lastFetchUrl = useRef<string | null>(null);
  const hasAutoFilteredRef = useRef(false);

  // ── Load graph data ─────────────────────────────────────────────────────────
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
        setCount(data.count);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [centerEntity, depth]);

  // ── Load compare entity data ─────────────────────────────────────────────────
  useEffect(() => {
    if (!compareEntity || !compareEntity.id) {
      setCompareNodes([]);
      setCompareEdges([]);
      return;
    }
    const url = `/api/graph/connections?entityId=${encodeURIComponent(compareEntity.id)}&depth=${Math.min(depth, 2)}`;
    fetch(url)
      .then((r) => r.json())
      .then((data: { nodes: GraphNode[]; edges: GraphEdge[]; count: number; error?: string }) => {
        if (data.error) return;
        setCompareNodes(data.nodes);
        setCompareEdges(data.edges);
      })
      .catch(() => {
        setCompareNodes([]);
        setCompareEdges([]);
      });
  }, [compareEntity, depth]);

  // ── Expand a collapsed node ─────────────────────────────────────────────────
  const handleExpandNode = useCallback(async (node: GraphNode) => {
    const entityId = node.metadata?.entityId as string | undefined;
    if (!entityId) return;
    setExpandingNodeId(entityId);
    try {
      const res = await fetch(`/api/graph/connections?entityId=${encodeURIComponent(entityId)}&depth=1`);
      const data = await res.json() as { nodes: GraphNode[]; edges: GraphEdge[]; count: number };
      setAllNodes((prev) => {
        const nodeMap = new Map(prev.map((n) => [n.id, n]));
        for (const n of data.nodes) {
          if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
        }
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
      setSelectedNode((prev) => {
        if (prev?.metadata?.entityId === entityId) {
          return { ...prev, metadata: { ...prev.metadata, collapsed: false, connectionCount: undefined } };
        }
        return prev;
      });
    } catch (err) {
      console.error("[expand node]", err);
    } finally {
      setExpandingNodeId(null);
    }
  }, []);

  // ── Search function for EntitySelector ──────────────────────────────────────
  const searchEntities = useCallback(async (query: string): Promise<EntitySearchResult[]> => {
    try {
      const res = await fetch(`/api/graph/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      return res.json() as Promise<EntitySearchResult[]>;
    } catch {
      return [];
    }
  }, []);

  // ── Handle entity selection ─────────────────────────────────────────────────
  const handleEntitySelect = useCallback(
    (entity: { id: string; type: string; label: string }) => {
      if (!entity.id) { setCenterEntity(null); return; }
      setCenterEntity(entity);
      setSelectedNode(null);
    },
    []
  );

  // ── Handle compare entity selection ─────────────────────────────────────────
  const handleCompareEntitySelect = useCallback(
    (entity: { id: string; type: string; label: string }) => {
      if (!entity.id) { setCompareEntity(null); return; }
      setCompareEntity(entity);
    },
    []
  );

  // ── Handle preset change ────────────────────────────────────────────────────
  const handlePresetChange = useCallback((preset: PresetId) => {
    setActivePreset(preset);
    setActiveFilters(PRESETS[preset].edgeTypes);
    setMinStrength(PRESETS[preset].minStrength ?? 0);
    if (PRESETS[preset].defaultDepth !== undefined) setDepth(PRESETS[preset].defaultDepth!);
    setSelectedNode(null);
  }, []);

  // ── Compute filtered edges ──────────────────────────────────────────────────
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
      const keywords = INDUSTRY_KEYWORDS[industryFilter] ?? [];
      const matchingNodeIds = new Set(
        allNodes
          .filter((n) => FINANCIAL_NODE_TYPES.has(n.type) && keywords.some((kw) => n.label.toLowerCase().includes(kw)))
          .map((n) => n.id)
      );
      edges = edges.filter(
        (e) => e.type === "donation" && (matchingNodeIds.has(e.source) || matchingNodeIds.has(e.target))
      );
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

  const handleNodeClick = useCallback((node: GraphNode | null) => setSelectedNode(node), []);

  const nodeEdges = selectedNode
    ? allEdges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];

  // Active viz registry entry for header title
  const activeViz = VIZ_REGISTRY.find((v) => v.id === viewMode);

  // Active filter names for AI narrative
  const activeFilterNames = useMemo(() => {
    if (!activeFilters) return [];
    return activeFilters.map((f) => f.replace(/_/g, " "));
  }, [activeFilters]);

  // Theme
  const bgClass =
    visualConfig.theme === "light" ? "bg-white text-gray-900"
    : visualConfig.theme === "print" ? "bg-white text-black"
    : "bg-gray-950 text-white";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-screen overflow-hidden ${bgClass}`}>

      {/* ── Top bar: title + share/screenshot ─────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0 gap-4 bg-gray-950">
        <div className="flex items-center gap-3 min-w-0">
          <a href="/" className="text-gray-500 hover:text-white text-xs transition-colors shrink-0">← Civitics</a>
          <span className="text-gray-700">|</span>
          <h1 className="text-xs font-semibold tracking-wide shrink-0">
            {activeViz?.label ?? "Connection Graph"}
          </h1>
          {!loading && viewMode === "force" && (
            <span className="text-xs text-gray-600 truncate">
              {count} connections · {allNodes.length} entities
            </span>
          )}
          <span className="text-xs text-gray-700 font-mono hidden sm:inline shrink-0">
            v:{process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev"}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {shareCode && viewMode === "force" && (
            <span className="text-xs text-indigo-400 font-mono border border-indigo-800 rounded px-2 py-1 hidden sm:inline">
              {shareCode}
            </span>
          )}
          <button
            onClick={() => setShowShare(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 transition-colors text-gray-300"
          >
            Share
          </button>
          <button
            onClick={() => setShowScreenshot(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 transition-colors text-gray-300"
          >
            Screenshot
          </button>
        </div>
      </header>

      {/* ── Node count warning bar ─────────────────────────────────────────── */}
      {!loading && viewMode === "force" && filteredNodes.length > 200 && (() => {
        const n = filteredNodes.length;
        const isCritical = n > 1000;
        const isHigh = n > 500;
        const bg = isCritical ? "bg-red-950/40 border-red-900/50" : isHigh ? "bg-orange-950/40 border-orange-900/50" : "bg-amber-950/40 border-amber-900/50";
        const textColor = isCritical ? "text-red-400" : isHigh ? "text-orange-400" : "text-amber-400";
        return (
          <div className={`flex items-center gap-2 px-4 py-1.5 border-b shrink-0 ${bg}`}>
            <svg className={`w-3.5 h-3.5 shrink-0 ${textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className={`text-xs ${textColor}`}>
              {n.toLocaleString()} nodes —{" "}
              {isCritical ? "increase strength filter above 0.5 or reduce depth"
               : isHigh ? "may be slow"
               : "consider filtering"}
            </span>
            {isHigh && minStrength < 0.5 && (
              <button onClick={() => setMinStrength(0.5)} className={`ml-2 text-xs underline ${textColor}`}>
                Apply strength ≥ 0.5
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Main content: sidebar + graph area ────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <GraphSidebar
          viewMode={viewMode}
          onViewModeChange={(mode) => { setViewMode(mode); setSelectedNode(null); }}
          depth={depth}
          onDepthChange={setDepth}
          centerEntity={centerEntity}
          onEntitySelect={handleEntitySelect}
          searchFn={searchEntities}
          edges={allEdges}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          minStrength={minStrength}
          onMinStrengthChange={setMinStrength}
          industryFilter={industryFilter}
          onIndustryFilterChange={setIndustryFilter}
          visualConfig={visualConfig}
          onVisualConfigChange={setVisualConfig}
          activePreset={activePreset}
          onPresetChange={handlePresetChange}
          onShare={() => setShowShare(true)}
          onScreenshot={() => setShowScreenshot(true)}
          onNarrative={() => setShowNarrative((v) => !v)}
          onEmbed={() => setShowEmbed(true)}
          compareMode={compareMode}
          onCompareModeChange={setCompareMode}
          compareEntity={compareEntity}
          onCompareEntitySelect={handleCompareEntitySelect}
        />

        {/* Graph / Treemap area */}
        <div className="flex flex-1 overflow-hidden relative">

          {/* ── Force graph view (or compare side-by-side) ───────────────── */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: viewMode === "force" ? 1 : 0, pointerEvents: viewMode === "force" ? "auto" : "none" }}
          >
            {compareMode && viewMode === "force" && compareEntity ? (
              /* Side-by-side comparison */
              <div className="flex h-full overflow-hidden">
                <div className="flex-1 relative overflow-hidden border-r border-gray-800" id="graph-container">
                  {loading && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      <div className="text-center">
                        <div className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mx-auto mb-4" />
                        <p className="text-gray-500 text-sm">Loading…</p>
                      </div>
                    </div>
                  )}
                  <ForceGraph
                    ref={svgRef}
                    nodes={filteredNodes}
                    edges={filteredEdges}
                    onNodeClick={handleNodeClick}
                    visualConfig={visualConfig}
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
                    onNodeClick={handleNodeClick}
                    visualConfig={visualConfig}
                    className="w-full h-full"
                  />
                  <div className="absolute top-2 left-2 text-xs text-gray-400 bg-gray-900/80 px-2 py-1 rounded pointer-events-none">
                    {compareEntity.label}
                  </div>
                </div>
              </div>
            ) : (
              /* Single force graph */
              <div className="relative w-full h-full" id="graph-container">
                {loading && (
                  <div className="absolute inset-0 flex items-center justify-center z-10">
                    <div className="text-center">
                      <div className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mx-auto mb-4" />
                      <p className="text-gray-500 text-sm">Loading connections…</p>
                    </div>
                  </div>
                )}

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
                        <a href="/agencies" className="px-4 py-2 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors">View Agencies →</a>
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
                      <p className="text-gray-600 text-xs mt-1">Try a different preset in the sidebar.</p>
                    </div>
                  </div>
                )}

                <ForceGraph
                  ref={svgRef}
                  nodes={filteredNodes}
                  edges={filteredEdges}
                  onNodeClick={handleNodeClick}
                  visualConfig={visualConfig}
                  className="w-full h-full"
                />
              </div>
            )}
          </div>

          {/* ── Treemap view ─────────────────────────────────────────────── */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: viewMode === "treemap" ? 1 : 0, pointerEvents: viewMode === "treemap" ? "auto" : "none" }}
          >
            <TreemapGraph className="w-full h-full" />
          </div>

          {/* ── Chord view ───────────────────────────────────────────────── */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: viewMode === "chord" ? 1 : 0, pointerEvents: viewMode === "chord" ? "auto" : "none" }}
          >
            <ChordGraph className="w-full h-full" svgRef={chordSvgRef} />
          </div>

          {/* ── Sunburst view ────────────────────────────────────────────── */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: viewMode === "sunburst" ? 1 : 0, pointerEvents: viewMode === "sunburst" ? "auto" : "none" }}
          >
            <SunburstGraph
              className="w-full h-full"
              entityId={centerEntity?.id}
              entityLabel={centerEntity?.label}
            />
          </div>

          {/* ── Selected node detail panel (right side, force only) ───────── */}
          {selectedNode && viewMode === "force" && (
            <aside className="w-72 border-l border-gray-800 bg-gray-950 p-4 overflow-y-auto shrink-0 absolute right-0 top-0 bottom-0 z-10">
              <div className="flex items-start justify-between mb-3">
                <h2 className="text-sm font-semibold text-white leading-snug">{selectedNode.label}</h2>
                <button onClick={() => setSelectedNode(null)} className="text-gray-500 hover:text-white ml-2 shrink-0">✕</button>
              </div>

              <div className="space-y-1 mb-4">
                <p className="text-xs text-gray-500 capitalize">
                  {selectedNode.type.replace(/_/g, " ")}
                  {selectedNode.party && (
                    <span className={`ml-2 inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                      selectedNode.party === "democrat" ? "bg-blue-900 text-blue-300"
                      : selectedNode.party === "republican" ? "bg-red-900 text-red-300"
                      : "bg-purple-900 text-purple-300"
                    }`}>
                      {selectedNode.party.charAt(0).toUpperCase()}
                    </span>
                  )}
                </p>
              </div>

              {/* Expand collapsed node */}
              {selectedNode?.metadata?.collapsed === true && (() => {
                const connCount = Number(selectedNode.metadata.connectionCount ?? 0);
                const entityId = String(selectedNode.metadata.entityId ?? "");
                const isExpanding = expandingNodeId === entityId;
                return (
                  <div className="mb-4 p-3 rounded-lg bg-orange-950/40 border border-orange-900/50">
                    <p className="text-xs text-orange-400 font-medium mb-1">{connCount.toLocaleString()} connections not shown</p>
                    <p className="text-xs text-gray-500 mb-3">Expanding may slow the graph.</p>
                    <button
                      onClick={() => handleExpandNode(selectedNode)}
                      disabled={isExpanding}
                      className="w-full px-3 py-1.5 text-xs font-medium rounded bg-orange-900/60 hover:bg-orange-800/60 text-orange-300 hover:text-orange-200 transition-colors disabled:opacity-50"
                    >
                      {isExpanding ? "Expanding…" : `Expand (${connCount.toLocaleString()} connections)`}
                    </button>
                  </div>
                );
              })()}

              {nodeEdges.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
                    Connections ({nodeEdges.length})
                  </h3>
                  <ul className="space-y-2">
                    {nodeEdges.slice(0, 15).map((edge) => {
                      const isSource = edge.source === selectedNode.id;
                      const otherId = isSource ? edge.target : edge.source;
                      const otherNode = allNodes.find((n) => n.id === otherId);
                      return (
                        <li key={edge.id} className="flex items-start gap-2 text-xs">
                          <span className="text-gray-300">{edge.type.replace(/_/g, " ")}</span>
                          {" → "}
                          <span className="text-gray-400">{otherNode?.label ?? "Unknown"}</span>
                          {edge.amountCents && (
                            <span className="text-green-400 ml-1">${(edge.amountCents / 100).toLocaleString()}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </aside>
          )}

          {/* ── AI Narrative panel ───────────────────────────────────────── */}
          <AiNarrative
            vizType={viewMode}
            entityNames={centerEntity ? [centerEntity.label] : []}
            activeFilters={activeFilterNames}
            isVisible={showNarrative}
            onClose={() => setShowNarrative(false)}
          />

          {/* Floating panels */}
          {showShare && (
            <div className="absolute top-4 right-4 z-20">
              <SharePanel
                graphState={{
                  preset: activePreset,
                  edgeTypes: activeFilters,
                  minStrength,
                  nodeCount: filteredNodes.length,
                  edgeCount: filteredEdges.length,
                  centerEntityId: centerEntity?.id,
                  centerEntityType: centerEntity?.type,
                  depth,
                  activeFilters,
                  visualConfig: visualConfig as unknown as Record<string, unknown>,
                }}
                onCodeGenerated={(code) => { setShareCode(code); setShowShare(false); }}
                onClose={() => setShowShare(false)}
              />
            </div>
          )}
          {showScreenshot && (
            <div className="absolute top-4 right-4 z-20">
              <ScreenshotPanel svgRef={viewMode === "chord" ? chordSvgRef : svgRef} shareCode={shareCode} onClose={() => setShowScreenshot(false)} />
            </div>
          )}
        </div>
      </div>

      {/* ── Embed Modal (full-screen overlay) ─────────────────────────────── */}
      {showEmbed && (
        <EmbedModal
          shareCode={shareCode}
          onClose={() => setShowEmbed(false)}
        />
      )}
    </div>
  );
}
