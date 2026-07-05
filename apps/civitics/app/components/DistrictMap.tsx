"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import { initMapbox, mapboxgl } from "@civitics/maps/client";
import type { FeatureCollection } from "geojson";

type MapState = "placeholder" | "address_input" | "loading" | "active";
type LayerKey = "upper" | "lower";

// The map is a WebGL canvas — Tailwind `var()` tokens can't reach paint
// properties, so chamber fills/lines and DOM markers are resolved to literal
// color strings at layer-add time via tokenRgb() below. Upper chamber →
// civic-blue, lower chamber → green-ink, location markers → accent.
interface SldLayerProps {
  source: string;
  fillVar: string;
  lineVar: string;
}

const SLD_LAYERS: Record<LayerKey, SldLayerProps> = {
  upper: { source: "sld-upper", fillVar: "--c-blue",      lineVar: "--c-blue" },
  lower: { source: "sld-lower", fillVar: "--c-green-ink", lineVar: "--c-green-ink" },
};

// Resolve a semantic token var to a comma-form rgb() string. MapLibre's color
// parser predates CSS Color 4, so the space-separated triplet the vars hold
// ("43 74 139") must be emitted as "rgb(43, 74, 139)". Self-contained on
// purpose (see packages/graph tokens.ts for the same idea) — the map stays
// dependency-free.
function tokenRgb(varName: string): string {
  if (typeof window === "undefined") return "rgb(0, 0, 0)";
  const triplet = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return `rgb(${triplet.split(/\s+/).join(", ")})`;
}

type Representative = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  jurisdiction: string | null;
};

const PARTY_BADGE: Record<string, string> = {
  democrat: "bg-civic-blue/10 text-civic-blue",
  republican: "bg-accent/10 text-accent",
  independent: "bg-viz-7/10 text-viz-7",
};

function track(metric: string) {
  fetch("/api/track-usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: "mapbox", metric }),
  }).catch(() => {});
}

export function DistrictMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const pendingFlyToRef = useRef<{
    lng: number;
    lat: number;
    reps: Representative[];
  } | null>(null);

  const [mapState, setMapState] = useState<MapState>("placeholder");
  const [geolocating, setGeolocating] = useState(false);
  const [address, setAddress] = useState("");
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [representatives, setRepresentatives] = useState<Representative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastMethod, setLastMethod] = useState<"geo" | "address" | null>(null);
  const [activeLayers, setActiveLayers] = useState<Record<LayerKey, boolean>>({ upper: false, lower: false });

  const loadDistrictsLayer = useCallback(async (map: mapboxgl.Map, chamber: LayerKey) => {
    const bounds = map.getBounds();
    if (!bounds) return;
    const w = bounds.getWest(), s = bounds.getSouth(), e = bounds.getEast(), n = bounds.getNorth();
    try {
      const res = await fetch(`/api/districts?chamber=${chamber}&bbox=${w},${s},${e},${n}&limit=300`);
      if (!res.ok) return;
      const fc = (await res.json()) as FeatureCollection;
      const cfg = SLD_LAYERS[chamber];
      const src = map.getSource(cfg.source) as mapboxgl.GeoJSONSource | undefined;
      if (src) {
        src.setData(fc);
      } else {
        map.addSource(cfg.source, { type: "geojson", data: fc });
        map.addLayer({
          id: `${cfg.source}-fill`, type: "fill", source: cfg.source,
          paint: { "fill-color": tokenRgb(cfg.fillVar), "fill-opacity": 0.15 },
        });
        map.addLayer({
          id: `${cfg.source}-line`, type: "line", source: cfg.source,
          paint: { "line-color": tokenRgb(cfg.lineVar), "line-width": 1 },
        });
        // Click → district detail page. Add once, when the layer is created.
        map.on("click", `${cfg.source}-fill`, (ev) => {
          const f = ev.features?.[0];
          const did = f?.properties?.["id"];
          if (typeof did === "string") window.location.href = `/districts/${did}`;
        });
        map.on("mouseenter", `${cfg.source}-fill`, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", `${cfg.source}-fill`, () => { map.getCanvas().style.cursor = ""; });
      }
    } catch {
      // Silent — overlay just won't appear.
    }
  }, []);

  const removeDistrictsLayer = useCallback((map: mapboxgl.Map, chamber: LayerKey) => {
    const cfg = SLD_LAYERS[chamber];
    if (map.getLayer(`${cfg.source}-fill`)) map.removeLayer(`${cfg.source}-fill`);
    if (map.getLayer(`${cfg.source}-line`)) map.removeLayer(`${cfg.source}-line`);
    if (map.getSource(cfg.source)) map.removeSource(cfg.source);
  }, []);

  const toggleLayer = useCallback((chamber: LayerKey) => {
    setActiveLayers((prev) => {
      const next = { ...prev, [chamber]: !prev[chamber] };
      const map = mapRef.current;
      if (map) {
        if (next[chamber]) void loadDistrictsLayer(map, chamber);
        else removeDistrictsLayer(map, chamber);
      }
      return next;
    });
  }, [loadDistrictsLayer, removeDistrictsLayer]);

  // Stable helper — only touches refs and the mapboxgl import
  const placeMarkers = useCallback(
    (map: mapboxgl.Map, lng: number, lat: number, reps: Representative[]) => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      const accent = tokenRgb("--c-accent");
      const inkSoft = tokenRgb("--c-ink-soft");

      const userEl = document.createElement("div");
      userEl.style.cssText =
        `width:14px;height:14px;background:${accent};border:2px solid white;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.3)`;
      new mapboxgl.Marker({ element: userEl }).setLngLat([lng, lat]).addTo(map);

      reps.forEach((rep, i) => {
        const angle = (i / Math.max(reps.length, 1)) * 2 * Math.PI;
        const spread = reps.length > 1 ? 0.25 : 0;
        const rLng = lng + spread * Math.cos(angle);
        const rLat = lat + spread * Math.sin(angle);

        const popup = new mapboxgl.Popup({ offset: 28, closeButton: false }).setHTML(
          `<div style="font:13px/1.4 system-ui,sans-serif;padding:2px 0">` +
            `<p style="font-weight:600;margin:0 0 2px">${rep.full_name}</p>` +
            `<p style="color:${inkSoft};margin:0 0 2px;font-size:11px">${rep.role_title}</p>` +
            (rep.party
              ? `<p style="color:${inkSoft};margin:0 0 6px;font-size:11px">${rep.party}</p>`
              : "") +
            `<a href="/officials/${rep.id}" style="color:${accent};font-size:11px;font-weight:500">View profile →</a>` +
            `</div>`
        );

        const marker = new mapboxgl.Marker({ color: accent })
          .setLngLat([rLng, rLat])
          .setPopup(popup)
          .addTo(map);

        markersRef.current.push(marker);
      });
    },
    []
  );

  // Initialize Mapbox only once — when mapState first becomes "active".
  // The map div is already in the DOM (absolute positioned) so it has real dimensions.
  useEffect(() => {
    if (mapState !== "active" || mapRef.current || !containerRef.current) return;

    initMapbox();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-98.5795, 39.8283], // geographic center of contiguous US
      zoom: 3.5,
    });

    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right"
    );
    mapRef.current = map;

    // Apply any pending fly-to from address/geo search that ran before map init
    map.on("load", () => {
      const pending = pendingFlyToRef.current;
      if (pending) {
        pendingFlyToRef.current = null;
        map.flyTo({ center: [pending.lng, pending.lat], zoom: 8, duration: 1200 });
        placeMarkers(map, pending.lng, pending.lat, pending.reps);
      }
    });

    // Refresh visible-bbox districts when the user pans/zooms (debounced).
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    map.on("moveend", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        for (const [k, on] of Object.entries(activeLayers)) {
          if (on) void loadDistrictsLayer(map, k as LayerKey);
        }
      }, 300);
    });

    track("map_load");
  }, [mapState, placeMarkers, activeLayers, loadDistrictsLayer]);

  // Shared: fetch representatives, then activate map
  async function activateMapWithLocation(
    lng: number,
    lat: number,
    method: "geo" | "address",
    newPlaceName?: string
  ) {
    setError(null);
    setRepresentatives([]);
    setPlaceName(newPlaceName ?? null);
    setLastMethod(method);
    setMapState("loading");

    try {
      const repsRes = await fetch(`/api/representatives?lat=${lat}&lng=${lng}`);
      const repsData = await repsRes.json();
      const reps: Representative[] = repsData.representatives ?? [];
      setRepresentatives(reps);

      if (mapRef.current) {
        // Map already live — fly and place markers immediately
        mapRef.current.flyTo({ center: [lng, lat], zoom: 8, duration: 1200 });
        placeMarkers(mapRef.current, lng, lat, reps);
      } else {
        // Map will init after state change; store pending location for map.on('load')
        pendingFlyToRef.current = { lng, lat, reps };
      }

      setMapState("active");
    } catch {
      setError("Something went wrong. Please try again.");
      setMapState("address_input");
    }
  }

  async function handleAddressSubmit(e: React.FormEvent) {
    e.preventDefault();
    const query = address.trim();
    if (!query) return;

    track("address_used");
    setError(null);
    setMapState("loading");

    try {
      const token = process.env["NEXT_PUBLIC_MAPBOX_TOKEN"];
      const geocodeRes = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
          `?country=us&types=address,postcode,place,region&access_token=${token}`
      );
      if (!geocodeRes.ok) throw new Error("Geocoding failed");

      const geocodeData = await geocodeRes.json();
      const feature = geocodeData.features?.[0];

      if (!feature) {
        setError("Address not found. Try a street address, city, or ZIP code.");
        setMapState("address_input");
        return;
      }

      const [lng, lat] = feature.center as [number, number];
      // Coarsen on client side before sending — same rule as the server
      const cLat = Math.round(lat * 100) / 100;
      const cLng = Math.round(lng * 100) / 100;

      await activateMapWithLocation(cLng, cLat, "address", feature.place_name);
    } catch {
      setError("Something went wrong. Please try again.");
      setMapState("address_input");
    }
  }

  function handleGeolocate() {
    if (!navigator.geolocation) {
      setError(
        "Geolocation is not supported by your browser. Please enter your address."
      );
      return;
    }

    track("geolocation_used");
    setGeolocating(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeolocating(false);
        // Coarsen immediately — ~1km accuracy, never store precise coords
        const lat = Math.round(position.coords.latitude * 100) / 100;
        const lng = Math.round(position.coords.longitude * 100) / 100;
        activateMapWithLocation(lng, lat, "geo");
      },
      (err) => {
        setGeolocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setError("Location access denied. Please enter your address below.");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setError("Unable to detect location. Please enter your address.");
        } else {
          setError("Location request timed out. Please enter your address.");
        }
      },
      {
        enableHighAccuracy: false, // district-level accuracy is enough
        timeout: 8000,
        maximumAge: 300_000, // cache 5 min — don't re-request on repeat clicks
      }
    );
  }

  // ─── Inactive panel content ────────────────────────────────────────────────

  function renderPlaceholder() {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-12 h-12 text-ink-soft/40"
          aria-hidden="true"
        >
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
          <circle cx="12" cy="9" r="2.5" />
        </svg>

        <div>
          <p className="text-base font-semibold text-ink-soft">
            Find Your Representatives
          </p>
          <p className="mt-1 text-sm text-ink-soft/70 max-w-xs">
            Enter your address to see every elected official who represents
            you — federal, state, and local.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 justify-center">
          <button
            onClick={() => {
              track("map_activated");
              setMapState("address_input");
            }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            Search by Address
          </button>
          <button
            onClick={() => {
              track("map_activated");
              setMapState("active");
            }}
            className="rounded-md border border-rule bg-card px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper-2 transition-colors"
          >
            Browse the Map
          </button>
        </div>

        <p className="text-xs text-ink-soft/70">
          Your location is never stored. Coordinates are coarsened to district level.
        </p>
      </div>
    );
  }

  function renderAddressInput() {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-base font-semibold text-ink-soft">
          Find Your Representatives
        </p>

        {error && (
          <p className="text-sm text-accent text-center max-w-sm">{error}</p>
        )}

        {/* Use My Location */}
        <button
          onClick={handleGeolocate}
          disabled={geolocating}
          className="w-full max-w-sm flex items-center justify-center gap-2 rounded-md border border-rule bg-card px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-paper-2 disabled:opacity-50 transition-colors"
        >
          {geolocating ? (
            <>
              <svg
                className="animate-spin h-4 w-4 text-accent"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Getting your location…
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-4 h-4 text-accent"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-2.003 3.5-4.697 3.5-8.333 0-4.36-3.14-7.994-7-7.994S5 4.641 5 9.001c0 3.636 1.556 6.33 3.5 8.333a19.58 19.58 0 002.683 2.282 16.975 16.975 0 001.144.742zM12 13.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z"
                  clipRule="evenodd"
                />
              </svg>
              Use My Location
            </>
          )}
        </button>

        {/* OR separator */}
        <div className="w-full max-w-sm flex items-center gap-2">
          <div className="flex-1 h-px bg-rule" />
          <span className="text-xs text-ink-soft/70">or enter address</span>
          <div className="flex-1 h-px bg-rule" />
        </div>

        {/* Address form */}
        <form
          onSubmit={handleAddressSubmit}
          className="w-full max-w-sm flex flex-col gap-2"
        >
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, State"
            className="w-full rounded-md border border-rule px-3 py-2 text-sm text-ink placeholder-ink-soft/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            Find Representatives →
          </button>
        </form>

        <p className="text-xs text-ink-soft/70 text-center max-w-sm">
          🔒 Your address is used only to find your district. Never stored on
          our servers.
        </p>

        <button
          onClick={() => setMapState(mapRef.current ? "active" : "placeholder")}
          className="text-xs text-ink-soft/70 hover:text-ink-soft transition-colors"
        >
          {mapRef.current ? "← Back to map" : "← Back"}
        </button>
      </div>
    );
  }

  function renderLoading() {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-ink-soft/70">
          <svg
            className="animate-spin h-4 w-4 text-accent"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Finding your representatives…
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const privacyNote =
    lastMethod === "geo"
      ? "🔒 Your precise location is coarsened to ~1km accuracy. Never stored on our servers."
      : "🔒 Your address is used only to find your district. Never stored on our servers.";

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-ink">
          Find your representatives
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Enter your address to see who represents you — federal, state, and local.
        </p>
      </div>

      {/*
        The map container always has explicit dimensions so Mapbox can initialize.
        The inactive overlay is absolutely positioned inside it and fades out
        when the map activates — no layout shift, smooth cross-fade.
      */}
      <div
        ref={containerRef}
        className="relative w-full h-[400px] md:h-[500px] rounded-lg border border-rule overflow-hidden"
      >
        {/* Inactive overlay (placeholder / address_input / loading) — fades out */}
        <div
          className={`absolute inset-0 z-10 transition-opacity duration-300 ${
            mapState === "active"
              ? "opacity-0 pointer-events-none"
              : "opacity-100"
          }`}
          style={{
            backgroundColor: "rgb(var(--c-paper-2))",
            backgroundImage:
              "radial-gradient(circle, rgb(var(--c-rule)) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          {mapState === "placeholder" && renderPlaceholder()}
          {mapState === "address_input" && renderAddressInput()}
          {mapState === "loading" && renderLoading()}
        </div>

        {/* Change address — overlaid top-left on the live map */}
        {mapState === "active" && (
          <div className="absolute top-2 left-2 z-10 flex flex-col gap-2">
            <button
              onClick={() => setMapState("address_input")}
              className="rounded-md bg-card/90 backdrop-blur-sm border border-rule px-2.5 py-1.5 text-xs font-medium text-ink-soft hover:bg-card shadow-sm transition-colors"
            >
              Change address
            </button>
            <div className="rounded-md bg-card/90 backdrop-blur-sm border border-rule shadow-sm p-2 flex flex-col gap-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">Layers</p>
              <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeLayers.upper}
                  onChange={() => toggleLayer("upper")}
                  className="rounded text-accent focus:ring-accent"
                />
                <span className="inline-block w-2 h-2 rounded-sm bg-civic-blue" /> State Senate
              </label>
              <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeLayers.lower}
                  onChange={() => toggleLayer("lower")}
                  className="rounded text-accent focus:ring-accent"
                />
                <span className="inline-block w-2 h-2 rounded-sm bg-green-ink" /> State House
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Below-map metadata */}
      {placeName && mapState === "active" && (
        <p className="mt-1.5 text-xs text-ink-soft/70">{placeName}</p>
      )}
      {lastMethod && mapState === "active" && (
        <p className="mt-1 text-xs text-ink-soft/70">{privacyNote}</p>
      )}

      {/* Representative cards */}
      {representatives.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {representatives.map((rep) => {
            const badge =
              PARTY_BADGE[rep.party?.toLowerCase() ?? ""] ??
              "bg-rule/40 text-ink-soft";
            return (
              <a
                key={rep.id}
                href={`/officials/${rep.id}`}
                className="block border border-rule bg-card p-3 hover:border-accent hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-ink leading-tight">
                    {rep.full_name}
                  </p>
                  {rep.party && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge}`}
                    >
                      {rep.party[0]}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">{rep.role_title}</p>
                {rep.jurisdiction && (
                  <p className="mt-0.5 text-xs text-ink-soft/70">
                    {rep.jurisdiction}
                  </p>
                )}
                <p className="mt-2 text-xs font-medium text-accent">
                  View profile →
                </p>
              </a>
            );
          })}
        </div>
      )}

      {representatives.length === 0 && lastMethod && mapState === "active" && (
        <p className="mt-3 text-sm text-ink-soft">
          No representatives found for this location. District boundary data may
          not be fully loaded yet — check back soon.
        </p>
      )}
    </section>
  );
}
