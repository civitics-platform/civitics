"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import { initMapbox, mapboxgl } from "@civitics/maps/client";

type Representative = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  jurisdiction: string | null;
};

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-800",
  republican:  "bg-red-100 text-red-800",
  independent: "bg-purple-100 text-purple-800",
};

export function DistrictMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  const [address, setAddress] = useState("");
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [representatives, setRepresentatives] = useState<Representative[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track map load for billing monitor (fire-and-forget)
  useEffect(() => {
    fetch("/api/track-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "mapbox", metric: "map_load" }),
    }).catch(() => {/* non-critical */});
  }, []);

  // Initialize map once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    initMapbox();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-98.5795, 39.8283], // geographic center of the contiguous US
      zoom: 3.5,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
    };
  }, []);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = address.trim();
    if (!query) return;

    setLoading(true);
    setError(null);
    setRepresentatives([]);
    setPlaceName(null);

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
        return;
      }

      const [lng, lat] = feature.center as [number, number];
      setPlaceName(feature.place_name);

      // Fetch representatives via our API route
      const repsRes = await fetch(
        `/api/representatives?lat=${lat}&lng=${lng}`
      );
      const repsData = await repsRes.json();
      const reps: Representative[] = repsData.representatives ?? [];
      setRepresentatives(reps);

      // Pan the map
      if (mapRef.current) {
        mapRef.current.flyTo({ center: [lng, lat], zoom: 8, duration: 1200 });

        // Clear old markers
        markersRef.current.forEach((m) => m.remove());
        markersRef.current = [];

        // User location pin
        const userEl = document.createElement("div");
        userEl.style.cssText =
          "width:14px;height:14px;background:#4f46e5;border:2px solid white;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.3)";
        new mapboxgl.Marker({ element: userEl })
          .setLngLat([lng, lat])
          .addTo(mapRef.current);

        // Representative pins — spread slightly around the location so they don't overlap
        reps.forEach((rep, i) => {
          const angle = (i / Math.max(reps.length, 1)) * 2 * Math.PI;
          const spread = reps.length > 1 ? 0.25 : 0;
          const rLng = lng + spread * Math.cos(angle);
          const rLat = lat + spread * Math.sin(angle);

          const popup = new mapboxgl.Popup({ offset: 28, closeButton: false }).setHTML(
            `<div style="font:13px/1.4 system-ui,sans-serif;padding:2px 0">` +
              `<p style="font-weight:600;margin:0 0 2px">${rep.full_name}</p>` +
              `<p style="color:#555;margin:0 0 2px;font-size:11px">${rep.role_title}</p>` +
              (rep.party
                ? `<p style="color:#777;margin:0 0 6px;font-size:11px">${rep.party}</p>`
                : "") +
              `<a href="/officials/${rep.id}" style="color:#4f46e5;font-size:11px;font-weight:500">View profile →</a>` +
              `</div>`
          );

          const marker = new mapboxgl.Marker({ color: "#6366f1" })
            .setLngLat([rLng, rLat])
            .setPopup(popup)
            .addTo(mapRef.current!);

          markersRef.current.push(marker);
        });
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            Find your representatives
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Enter your address to see who represents you in Congress.
          </p>
        </div>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Street address, city, or ZIP code"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/* Map */}
      <div
        ref={containerRef}
        className="h-72 w-full rounded-lg border border-gray-200 overflow-hidden"
      />

      {placeName && (
        <p className="mt-1.5 text-xs text-gray-400">{placeName}</p>
      )}

      {/* Representative cards */}
      {representatives.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {representatives.map((rep) => {
            const badge =
              PARTY_BADGE[rep.party?.toLowerCase() ?? ""] ??
              "bg-gray-100 text-gray-700";
            return (
              <a
                key={rep.id}
                href={`/officials/${rep.id}`}
                className="block rounded-lg border border-gray-200 bg-white p-3 hover:border-indigo-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900 leading-tight">
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
                <p className="mt-0.5 text-xs text-gray-500">{rep.role_title}</p>
                {rep.jurisdiction && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    {rep.jurisdiction}
                  </p>
                )}
                <p className="mt-2 text-xs font-medium text-indigo-600">
                  View profile →
                </p>
              </a>
            );
          })}
        </div>
      )}

      {placeName && representatives.length === 0 && !loading && (
        <p className="mt-3 text-sm text-gray-500">
          No representatives found for this location. District boundary data may
          not be fully loaded yet — check back soon.
        </p>
      )}
    </section>
  );
}
