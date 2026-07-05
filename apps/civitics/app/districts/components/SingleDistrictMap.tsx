"use client";

import { useEffect, useRef } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import { initMapbox, mapboxgl } from "@civitics/maps/client";
import type { MultiPolygon, Polygon } from "geojson";

interface Props {
  geometry: Polygon | MultiPolygon | null;
}

// Resolve a semantic token var to comma-form rgb() for MapLibre, whose color
// parser predates CSS Color 4 space-separated syntax. Vars hold "R G B".
function tokenRgb(varName: string): string {
  if (typeof window === "undefined") return "rgb(0, 0, 0)";
  const triplet = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return `rgb(${triplet.split(/\s+/).join(", ")})`;
}

export function SingleDistrictMap({ geometry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    initMapbox();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-98.5795, 39.8283],
      zoom: 3.5,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      if (!geometry) return;

      map.addSource("district-boundary", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry,
        },
      });
      map.addLayer({
        id: "district-fill",
        type: "fill",
        source: "district-boundary",
        paint: { "fill-color": tokenRgb("--c-blue"), "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: "district-line",
        type: "line",
        source: "district-boundary",
        paint: { "line-color": tokenRgb("--c-blue"), "line-width": 2 },
      });

      const bbox = computeBbox(geometry);
      if (bbox) map.fitBounds(bbox, { padding: 40, animate: false, maxZoom: 11 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [geometry]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[400px] rounded-lg border border-rule overflow-hidden"
    />
  );
}

function computeBbox(geom: Polygon | MultiPolygon): [[number, number], [number, number]] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings) {
    for (const coord of ring) {
      const x = coord[0];
      const y = coord[1];
      if (x === undefined || y === undefined) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return [[minX, minY], [maxX, maxY]];
}
