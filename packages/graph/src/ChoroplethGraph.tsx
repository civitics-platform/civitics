"use client";

/**
 * packages/graph/src/ChoroplethGraph.tsx — FIX-217
 *
 * Per-district choropleth. Reads /api/graph/voting-divergence which returns
 * one record per district with a derived measure value and the district's
 * boundary_geometry GeoJSON. Color encodes the measure (party-cohesion
 * rate by default — % of district's reps voting the same way).
 *
 * Note: proposals.party_line does not exist in the current schema, so the
 * default measure is within-district party-cohesion rather than per-vote
 * party-line divergence. The plan flagged this as a follow-up MV refinement.
 *
 * Powers the "Voting Divergence Map" preset.
 */

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { ChoroplethOptions } from "./types";
import { resolveToken } from "./tokens";

interface DistrictRow {
  districtId: string;
  districtName: string;
  geojson: GeoJSON.Geometry | null;
  measureValue: number | null;
  officialIds: string[];
  primaryParty: string | null;
  /** FIX-1170 — an NH floterial overlay polygon rather than a base district. */
  floterial?: boolean;
}

export interface ChoroplethGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<ChoroplethOptions>;
  primaryEntityId?: string | null;
}

export function ChoroplethGraph({
  className = "",
  svgRef: externalSvgRef,
  vizOptions,
  primaryEntityId,
}: ChoroplethGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRef  = useRef<SVGSVGElement>(null);
  const svgRef       = externalSvgRef ?? internalRef;

  const [rows, setRows] = useState<DistrictRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // FIX-1170 — overlay layer visibility. On by default: the 58 floterial
  // representatives are the reason the rows are fetched at all.
  const [showFloterial, setShowFloterial] = useState(true);

  const measure    = vizOptions?.measure    ?? "party_cohesion";
  const bandLevel  = vizOptions?.bandLevel  ?? "congressional";
  const colorScale = vizOptions?.colorScale ?? "diverging";

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ measure, bandLevel });
    fetch(`/api/graph/voting-divergence?${params.toString()}`)
      .then(r => r.json())
      .then((data: DistrictRow[] | { error: string }) => {
        if ("error" in data) throw new Error(data.error);
        setRows(data as DistrictRow[]);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [measure, bandLevel]);

  useEffect(() => {
    if (!svgRef.current || rows.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const container = containerRef.current;
    const width  = container?.clientWidth  ?? 800;
    const height = container?.clientHeight ?? 600;

    // FIX-1170 — two layers, not one. Floterial districts OVERLAP the base
    // districts they sit on, so painting them into the same fill would cover
    // whatever drew last and stop the state reading as a partition of itself
    // (FIX-914 D7). Base fills first; overlay outlines over the top.
    const toFeature = (r: DistrictRow): GeoJSON.Feature => ({
      type: "Feature",
      geometry: r.geojson as GeoJSON.Geometry,
      properties: { ...r },
    });
    const withGeom = rows.filter(r => r.geojson);
    const features        = withGeom.filter(r => !r.floterial).map(toFeature);
    const overlayFeatures = showFloterial ? withGeom.filter(r => r.floterial).map(toFeature) : [];
    if (features.length === 0 && overlayFeatures.length === 0) return;

    // The projection is fitted on the BASE layer alone where one exists, so
    // toggling the overlay never re-frames the map under the reader.
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: features.length > 0 ? features : overlayFeatures,
    };

    // Albers USA projection for congressional districts; mercator for state SLDs.
    const projection = d3
      .geoAlbersUsa()
      .fitSize([width, height], collection);
    const path = d3.geoPath(projection);

    // Color scale on the measure. d3's stock interpolators emit per-datum rgb
    // strings in JS, so CSS vars can't flow through — build interpolators from
    // token endpoints resolved at render time instead (FIX-729). Resolving from
    // svgEl keeps them scope-aware (terminal luminous vs paper ink).
    const T = {
      panel:  resolveToken("--c-term-panel", svgRef.current),
      teal:   resolveToken("--c-viz-2", svgRef.current),
      accent: resolveToken("--c-accent", svgRef.current),
      blue:   resolveToken("--c-blue", svgRef.current),
      line:   resolveToken("--c-term-line", svgRef.current),
      amber:  resolveToken("--c-amber", svgRef.current),
      bg:     resolveToken("--c-term-bg", svgRef.current),
      dim:    resolveToken("--c-term-dim", svgRef.current),
    };
    const measureValues = rows
      .map(r => r.measureValue)
      .filter((v): v is number => typeof v === "number");
    const ext = (measureValues.length ? d3.extent(measureValues) : [-1, 1]) as [number, number];
    const isDiverging = colorScale === "diverging";
    // FIX-855 — the server returns party CONTROL, not cohesion: −1 = Democrat,
    // +1 = Republican, 0 = mixed / independent. Democrat → blue, Republican →
    // red (the interpolator was reversed, painting Democrats red). Fixed
    // [−1,0,1] domain so a solid-party district always renders full colour and a
    // single-party band never collapses to a rescaled flat map.
    const colorFn = colorScale === "diverging"
      ? d3.scaleDiverging<string>(
          d3.piecewise(d3.interpolateRgb, [T.blue, T.panel, T.accent])
        ).domain([-1, 0, 1])
      // panel → teal replaces interpolateBlues (sequential measures)
      : d3.scaleSequential<string>(d3.interpolateRgb(T.panel, T.teal)).domain(ext);

    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const g = svg.append("g");

    g.selectAll("path.district")
      .data(features)
      .join("path")
      .attr("class", "district")
      .attr("d", d => path(d) ?? "")
      .attr("fill", d => {
        const v = (d.properties as DistrictRow).measureValue;
        return v == null ? T.line : colorFn(v);
      })
      .attr("stroke", d => {
        const props = d.properties as DistrictRow;
        return primaryEntityId && props.officialIds.includes(primaryEntityId)
          ? T.amber
          : T.bg;
      })
      .attr("stroke-width", d => {
        const props = d.properties as DistrictRow;
        return primaryEntityId && props.officialIds.includes(primaryEntityId) ? 2 : 0.5;
      })
      .style("cursor", "pointer")
      .append("title")
      .text(d => {
        const p = d.properties as DistrictRow;
        return `${p.districtName}\n${labelFor(measure)}: ${fmtMeasure(p.measureValue, isDiverging)}`;
      });

    // FIX-1170 — the floterial overlay. Dashed outline, no fill, so the base
    // choropleth stays fully readable underneath it. `fill: none` plus
    // pointer-events on the stroke keeps the interior click-through to the base
    // district, which is the one a reader is usually after.
    if (overlayFeatures.length > 0) {
      g.selectAll("path.floterial")
        .data(overlayFeatures)
        .join("path")
        .attr("class", "floterial")
        .attr("d", d => path(d) ?? "")
        .attr("fill", "none")
        .attr("stroke", d => {
          const props = d.properties as DistrictRow;
          return primaryEntityId && props.officialIds.includes(primaryEntityId)
            ? T.amber
            : T.dim;
        })
        .attr("stroke-width", d => {
          const props = d.properties as DistrictRow;
          return primaryEntityId && props.officialIds.includes(primaryEntityId) ? 2.5 : 1.5;
        })
        .attr("stroke-dasharray", "4 3")
        .style("pointer-events", "stroke")
        .style("cursor", "pointer")
        .append("title")
        .text(d => {
          const p = d.properties as DistrictRow;
          return `${p.districtName} (floterial)\n${labelFor(measure)}: ${fmtMeasure(p.measureValue, isDiverging)}`;
        });
    }

    // Legend (compact, bottom-left). Party-control (diverging) gradients run over
    // the fixed [−1,1] party domain with Dem/Rep endpoints; sequential measures
    // keep the data-extent percentage endpoints.
    const [loLeg, hiLeg] = isDiverging ? [-1, 1] : ext;
    const legendW = 180;
    const legendH = 8;
    const lg = svg.append("g").attr("transform", `translate(20,${height - 40})`);
    const stops = 12;
    for (let i = 0; i < stops; i++) {
      const t = i / (stops - 1);
      lg.append("rect")
        .attr("x", (legendW / stops) * i)
        .attr("y", 0)
        .attr("width", legendW / stops + 0.5)
        .attr("height", legendH)
        .attr("fill", colorFn(loLeg + t * (hiLeg - loLeg)));
    }
    lg.append("text")
      .attr("x", 0).attr("y", -4)
      .attr("font-size", 10).attr("fill", T.dim)
      .text(labelFor(measure));
    lg.append("text")
      .attr("x", 0).attr("y", legendH + 12)
      .attr("font-size", 9).attr("fill", T.dim)
      .text(isDiverging ? "Democrat" : `${(loLeg * 100).toFixed(0)}%`);
    lg.append("text")
      .attr("x", legendW).attr("y", legendH + 12).attr("text-anchor", "end")
      .attr("font-size", 9).attr("fill", T.dim)
      .text(isDiverging ? "Republican" : `${(hiLeg * 100).toFixed(0)}%`);
  }, [rows, measure, colorScale, primaryEntityId, svgRef, showFloterial]);

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full text-accent text-sm ${className}`}>
        Choropleth error: {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className={`flex items-center justify-center h-full text-ink-soft text-sm ${className}`}>
        Loading district data…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-ink-soft text-sm ${className}`}>
        No district boundary data loaded — run pnpm data:districts to seed
      </div>
    );
  }

  // FIX-855 — rows exist but nothing colours the map: no linked representatives
  // (every measure null → the FIX-217 uniform-flat symptom) or no geometry for
  // this band, or a degenerate sequential domain (min === max). Show an explicit
  // "no data" overlay rather than a misleading uniform fill.
  const measureValues = rows
    .map(r => r.measureValue)
    .filter((v): v is number => typeof v === "number");
  const hasGeom = rows.some(r => r.geojson != null);
  const extentDegenerate =
    measureValues.length > 0 && Math.min(...measureValues) === Math.max(...measureValues);
  const noData =
    !hasGeom ||
    measureValues.length === 0 ||
    (colorScale !== "diverging" && extentDegenerate);

  if (noData) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <div className="text-center max-w-xs px-4">
          <p className="text-ink text-sm font-medium">
            No {labelFor(measure).toLowerCase()} data for {bandLabel(bandLevel)}.
          </p>
          <p className="text-ink-soft text-xs mt-1.5 leading-relaxed">
            {hasGeom
              ? "These districts have no linked representatives yet, so there's nothing to colour. Try the U.S. House band."
              : "No boundary geometry is loaded for this band yet."}
          </p>
        </div>
      </div>
    );
  }

  // FIX-1170 — the overlay control appears only when this response actually
  // carries overlay rows, which today means the NH lower-chamber band. Keying
  // it on the data rather than on a hard-coded state keeps it correct if a
  // second state's floterials are ever derived.
  const floterialCount = rows.filter(r => r.floterial).length;

  return (
    <div ref={containerRef} className={`w-full h-full relative ${className}`}>
      {floterialCount > 0 && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 bg-term-bg/80 rounded-full px-2.5 py-1">
          <span aria-hidden="true" className="text-[10px] text-ink-soft">
            Floterial districts (NH)
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={showFloterial}
            aria-label={`Floterial districts (NH) — ${floterialCount} overlay districts`}
            onClick={() => setShowFloterial(v => !v)}
            className={`w-7 h-4 rounded-full transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${showFloterial ? 'bg-accent' : 'bg-ink/20'}`}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-paper shadow transition-transform ${showFloterial ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}
      <svg id="choropleth-svg" ref={svgRef} className="w-full h-full" />
    </div>
  );
}

function labelFor(measure: string): string {
  switch (measure) {
    // FIX-855 — the voting-divergence route returns party lean (party CONTROL),
    // not a cohesion rate; label it for what it actually is.
    case "party_cohesion":     return "Party control";
    case "divergence":         return "Vote divergence";
    case "small_dollar_share": return "% small-dollar";
    default:                   return measure;
  }
}

// FIX-855 — human label for a district band, used in the "no data" overlay.
function bandLabel(band: string): string {
  switch (band) {
    case "congressional": return "U.S. House districts";
    case "sld_u":         return "state upper-chamber districts";
    case "sld_l":         return "state lower-chamber districts";
    case "state":         return "states";
    default:              return band;
  }
}

// FIX-855 — format a district's measure value. Party control (diverging) reads as
// a party label, not a nonsensical percentage of a −1..1 scalar.
function fmtMeasure(v: number | null, isDiverging: boolean): string {
  if (v == null) return "no linked representative";
  if (isDiverging) {
    if (v <= -0.34) return "Democratic";
    if (v >= 0.34)  return "Republican";
    return "Mixed / Independent";
  }
  return `${(v * 100).toFixed(1)}%`;
}
