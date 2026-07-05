"use client";

import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { MultiPolygon, Polygon } from "geojson";

// Why this wrapper exists, instead of using next/dynamic({ ssr: false })
// directly in the page file:
//
// next/dynamic in App Router still pulls the dynamic chunk into the route's
// static prefetch graph — Next.js reports the page's First Load JS as if the
// chunk were eager. For /districts/[id] that meant ~450 kB of mapbox-gl +
// associated CSS counted against the initial page bundle, even though the
// component renders client-side only.
//
// A useEffect-driven `import()` is invisible to the route prefetch graph.
// The browser parses the page chunk (small), paints the placeholder, and
// only then schedules the mapbox-gl fetch. The placeholder remains visible
// until the chunk lands, which is the same UX the previous loading={} prop
// provided.

type SingleDistrictMapProps = { geometry: Polygon | MultiPolygon | null };

export function DeferredDistrictMap({ geometry }: SingleDistrictMapProps) {
  const [Map, setMap] = useState<ComponentType<SingleDistrictMapProps> | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    import("./SingleDistrictMap").then((mod) => {
      if (!cancelled) {
        setMap(() => mod.SingleDistrictMap);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Map) {
    return (
      <div className="w-full h-[400px] rounded-lg border border-rule bg-paper-2 animate-pulse" />
    );
  }
  return <Map geometry={geometry} />;
}
