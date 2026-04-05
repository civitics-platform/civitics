"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  ForceGraph,
  TreemapGraph,
  ChordGraph,
  SunburstGraph,
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
} from "@civitics/graph";
import type { VizType, FocusGroup } from "@civitics/graph";
import { SharePanel }      from "./SharePanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { GhostGraph }      from "./GhostGraph";

// ── GraphPage ──────────────────────────────────────────────────────────────────

interface GraphPageProps {
  initialCode?: string;
  /** Serialized snapshot state (old arch or v2 JSON). Stage 2: restore full GraphView. */
  initialState?: Record<string, unknown>;
}

export function GraphPage({ initialCode }: GraphPageProps = {}) {
  // ── Graph view state (three-layer model) ──────────────────────────────────
  const graphHooks = useGraphView();
  const { view }   = graphHooks;

  // ── Graph data (nodes + edges for all focused entities) ───────────────────
  const { nodes, allEdges, loadingEntityId, graphMeta } = useGraphData(
    view.focus,
    view.connections
  );

  // ── Panel collapse state ──────────────────────────────────────────────────
  const [leftCollapsed,  setLeftCollapsed]  = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);

  // ── Overlay state ─────────────────────────────────────────────────────────
  const [shareCode,       setShareCode]       = useState<string | null>(initialCode ?? null);
  const [showShare,       setShowShare]       = useState(false);
  const [showScreenshot,  setShowScreenshot]  = useState(false);
  const [showEmbed,       setShowEmbed]       = useState(false);

  // ── SVG refs for screenshot (chord / treemap / sunburst) ─────────────────
  // Force graph uses id="force-graph-canvas" via registry selector
  const chordSvgRef    = useRef<SVGSVGElement>(null);
  const treemapSvgRef  = useRef<SVGSVGElement>(null);
  const sunburstSvgRef = useRef<SVGSVGElement>(null);

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
      case "chord":    return chordSvgRef;
      case "treemap":  return treemapSvgRef;
      case "sunburst": return sunburstSvgRef;
      default:         return null; // force uses #force-graph-canvas via registry
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

  const vizType      = view.style.vizType;
  const primaryEntity = (view.focus.entities.find(isFocusEntity) ?? null);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sunburstEntityId = primaryEntity?.id && UUID_RE.test(primaryEntity.id)
    ? primaryEntity.id
    : null;

  // ── Group-aware chord props ────────────────────────────────────────────────
  const primaryGroup =
    (view.focus.entities.find(isFocusGroup) as FocusGroup | undefined) ?? null;
  const focusGroups =
    view.focus.entities.filter(isFocusGroup) as FocusGroup[];

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
      />

      {/* ── Three-column body ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — Data Explorer */}
        <DataExplorerPanel
          view={view}
          hooks={graphHooks}
          collapsed={leftCollapsed}
          onCollapse={() => setLeftCollapsed(p => !p)}
          graphMeta={graphMeta}
        />

        {/* CANVAS */}
        <div className="flex-1 overflow-hidden relative">

          {/* Force graph */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: vizType === "force" ? 1 : 0, pointerEvents: vizType === "force" ? "auto" : "none" }}
          >
            {nodes.length === 0 && view.focus.entities.length === 0 ? (
              <div className="relative w-full h-full">
                <GhostGraph className="w-full h-full absolute inset-0 opacity-30" />
                <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                  <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-gray-950/80 backdrop-blur-sm border border-gray-800">
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
                </div>
              </div>
            ) : (
              <ForceGraph
                nodes={nodes}
                edges={allEdges}
                loadingEntityId={loadingEntityId}
                focusEntities={view.focus.entities.filter(isFocusEntity)}
                connections={view.connections}
                vizOptions={view.style.vizOptions?.force}
                className="w-full h-full"
                onViewGroupAsTreemap={handleViewGroupAsTreemap}
                onViewGroupAsChord={handleViewGroupAsChord}
                onViewGroupAsSunburst={handleViewGroupAsSunburst}
                onRemoveGroup={handleRemoveGroup}
              />
            )}
          </div>

          {/* Treemap */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: vizType === "treemap" ? 1 : 0, pointerEvents: vizType === "treemap" ? "auto" : "none" }}
          >
            <TreemapGraph
              className="w-full h-full"
              svgRef={treemapSvgRef}
              vizOptions={view.style.vizOptions.treemap}
              primaryEntityId={primaryEntity?.id ?? null}
              primaryEntityName={primaryEntity?.name ?? null}
              primaryGroup={primaryGroup}
            />
          </div>

          {/* Chord */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: vizType === "chord" ? 1 : 0, pointerEvents: vizType === "chord" ? "auto" : "none" }}
          >
            <ChordGraph
              className="w-full h-full"
              svgRef={chordSvgRef}
              vizOptions={view.style.vizOptions.chord}
              primaryEntityId={primaryEntity?.id ?? null}
              primaryGroup={primaryGroup}
              secondaryGroup={focusGroups[1] ?? null}
            />
          </div>

          {/* Sunburst */}
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ opacity: vizType === "sunburst" ? 1 : 0, pointerEvents: vizType === "sunburst" ? "auto" : "none" }}
          >
            <SunburstGraph
              className="w-full h-full"
              svgRef={sunburstSvgRef}
              entityId={sunburstEntityId ?? undefined}
              entityLabel={sunburstEntityId ? primaryEntity?.name : undefined}
              vizOptions={view.style.vizOptions.sunburst}
              primaryGroup={primaryGroup}
            />
          </div>

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

        </div>{/* end CANVAS */}

        {/* RIGHT — Graph Config */}
        <GraphConfigPanel
          view={view}
          hooks={graphHooks}
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(p => !p)}
          onSavePreset={handleSavePreset}
          graphMeta={graphMeta}
        />

      </div>

      {/* Embed Modal */}
      {showEmbed && (
        <EmbedModal shareCode={shareCode} onClose={() => setShowEmbed(false)} />
      )}
    </div>
  );
}
