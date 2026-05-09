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

interface DistrictRow {
  districtId: string;
  districtName: string;
  geojson: GeoJSON.Geometry | null;
  measureValue: number | null;
  officialIds: string[];
  primaryParty: string | null;
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

    const features: GeoJSON.Feature[] = rows
      .filter(r => r.geojson)
      .map((r) => ({
        type: "Feature",
        geometry: r.geojson as GeoJSON.Geometry,
        properties: { ...r },
      }));
    if (features.length === 0) return;

    const collection: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };

    // Albers USA projection for congressional districts; mercator for state SLDs.
    const projection = d3
      .geoAlbersUsa()
      .fitSize([width, height], collection);
    const path = d3.geoPath(projection);

    // Color scale on the measure
    const measureValues = rows
      .map(r => r.measureValue)
      .filter((v): v is number => typeof v === "number");
    const ext = d3.extent(measureValues) as [number, number];
    const colorFn = colorScale === "diverging"
      ? d3.scaleDiverging<string>(d3.interpolateRdBu).domain([ext[0], (ext[0] + ext[1]) / 2, ext[1]])
      : d3.scaleSequential<string>(d3.interpolateBlues).domain(ext);

    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const g = svg.append("g");

    g.selectAll("path.district")
      .data(features)
      .join("path")
      .attr("class", "district")
      .attr("d", d => path(d) ?? "")
      .attr("fill", d => {
        const v = (d.properties as DistrictRow).measureValue;
        return v == null ? "#1f2937" : colorFn(v);
      })
      .attr("stroke", d => {
        const props = d.properties as DistrictRow;
        return primaryEntityId && props.officialIds.includes(primaryEntityId)
          ? "#facc15"
          : "#0f172a";
      })
      .attr("stroke-width", d => {
        const props = d.properties as DistrictRow;
        return primaryEntityId && props.officialIds.includes(primaryEntityId) ? 2 : 0.5;
      })
      .style("cursor", "pointer")
      .append("title")
      .text(d => {
        const p = d.properties as DistrictRow;
        const v = p.measureValue == null ? "n/a" : `${(p.measureValue * 100).toFixed(1)}%`;
        return `${p.districtName}\n${labelFor(measure)}: ${v}`;
      });

    // Legend (compact, bottom-left)
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
        .attr("fill", colorFn(ext[0] + t * (ext[1] - ext[0])));
    }
    lg.append("text")
      .attr("x", 0).attr("y", -4)
      .attr("font-size", 10).attr("fill", "#94a3b8")
      .text(labelFor(measure));
    lg.append("text")
      .attr("x", 0).attr("y", legendH + 12)
      .attr("font-size", 9).attr("fill", "#94a3b8")
      .text(`${(ext[0] * 100).toFixed(0)}%`);
    lg.append("text")
      .attr("x", legendW).attr("y", legendH + 12).attr("text-anchor", "end")
      .attr("font-size", 9).attr("fill", "#94a3b8")
      .text(`${(ext[1] * 100).toFixed(0)}%`);
  }, [rows, measure, colorScale, primaryEntityId, svgRef]);

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full text-red-400 text-sm ${className}`}>
        Choropleth error: {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className={`flex items-center justify-center h-full text-gray-400 text-sm ${className}`}>
        Loading district data…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-gray-400 text-sm ${className}`}>
        No district boundary data loaded — run pnpm data:districts to seed
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`w-full h-full ${className}`}>
      <svg id="choropleth-svg" ref={svgRef} className="w-full h-full" />
    </div>
  );
}

function labelFor(measure: string): string {
  switch (measure) {
    case "party_cohesion":     return "Party cohesion";
    case "divergence":         return "Vote divergence";
    case "small_dollar_share": return "% small-dollar";
    default:                   return measure;
  }
}
