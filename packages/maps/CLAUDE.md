# packages/maps/CLAUDE.md

## Purpose
Mapbox GL JS + Deck.gl utilities for the Civitics civic governance app.
Shared spatial query helpers built on PostGIS.

When a request-path query becomes slow as data grows, the durable fix is
materialization. See `../db/CLAUDE.md` — *Materialization pattern for
slow request-path aggregations* — for shape options (single-row MV,
per-entity MV, rolling-history snapshot table), refresh hook placement,
read-path conventions with live-compute fallback, and the table of existing
materializations to model off.

---

## Status

**Live.** `NEXT_PUBLIC_MAPBOX_TOKEN` is configured in `.env.local` and Vercel.
Map components render real tiles + Census TIGER state legislative district
boundaries via the `/api/districts` route.

```
NEXT_PUBLIC_MAPBOX_TOKEN     # public, exposed to client (Mapbox js SDK)
```

---

## Stack

- **Mapbox GL JS** — Main map tiles, district boundary rendering, geocoding
  (50k loads/mo free tier, then $0.50/1k)
- **Deck.gl** — Data overlays: spending flows, donation geography, engagement heat maps
  (free, WebGL-powered)
- **PostGIS** — All boundary files stored locally in `jurisdictions` table
  (no per-query cost, no external dependency for spatial lookups)

---

## Privacy Rules

**Never store precise user coordinates.**

1. Geocode user address once (Mapbox API)
2. Coarsen to ~1km accuracy before any database write
3. Store: coarsened lat/lng + district IDs (congressional, state, county, city)
4. Never store: exact address, precise GPS coordinates
5. Update only when user changes their address

This is a Core Principle — not a preference.

---

## PostGIS District Lookup Pattern

The canonical spatial query. Given coarsened coordinates, return every jurisdiction containing that point:

```sql
-- Find all officials representing a specific location
SELECT
  o.id,
  o.full_name,
  o.role_title,
  o.party,
  gb.name AS governing_body,
  j.name AS jurisdiction
FROM officials o
JOIN governing_bodies gb ON o.governing_body_id = gb.id
JOIN jurisdictions j ON o.jurisdiction_id = j.id
WHERE
  o.is_active = true
  AND ST_Contains(
    j.boundary_geometry,
    ST_SetSRID(ST_Point($user_lng, $user_lat), 4326)
  )
ORDER BY j.type, o.role_title;
```

**Spatial index — required for performance:**
```sql
CREATE INDEX jurisdictions_boundary_gist ON jurisdictions USING GIST(boundary_geometry);
```
Test with `EXPLAIN ANALYZE` to confirm the GIST index is being used on any spatial query.

**Boundary data setup:**
- `boundary_geometry` MULTIPOLYGON column already exists on `jurisdictions`
  (initial schema, migration 0001).
- State legislative districts are seeded by `pnpm --filter @civitics/data data:districts`
  — pulls Census TIGER SLD-U + SLD-L shapefiles, calls
  `upsert_district_jurisdiction()` RPC. Annual cadence.
- Officials are cross-linked to their district jurisdiction via
  `link_officials_to_districts()` (called automatically at the end of both
  the bulk-people pipeline and the districts pipeline).

**Districts query API:**
- RPC: `query_districts(p_chamber, p_state, p_bbox_*, p_point_*, p_simplify_tolerance, p_limit, p_id)`
  — supports id-lookup, bbox, point-in-polygon, state and chamber filters.
- HTTP route: `GET /api/districts` returns GeoJSON FeatureCollection.
  Query params: `chamber=upper|lower`, `state=XX`, `bbox=W,S,E,N`,
  `point=lng,lat`, `simplify` (0–0.05 degrees, default 0.001), `limit` (max 2000).
- Detail page: `/districts/[id]` renders a single district + its officials.
- Homepage `DistrictMap` exposes layer toggles for SLD-U / SLD-L; clicking a
  district polygon navigates to `/districts/[id]`.

---

## Geographic Data Sources (all free)

| Data | Source | Loader |
|------|--------|--------|
| Congressional districts | Census TIGER (`/CD/`) | not yet loaded |
| State legislative districts (SLD-U + SLD-L) | Census TIGER (`/SLDU/`, `/SLDL/`) | `pnpm data:districts` (annual) |
| County/municipal boundaries | Census TIGER | not yet loaded |
| Precincts | OpenPrecincts.org | not yet loaded |
| Census tracts | Census Bureau | not yet loaded |

> Note: OpenStates also publishes SLD GeoJSON, but the file dates to Nov 2018
> and is stale. Census TIGER is the canonical, annual-refresh source — also
> what the openstates-geo project uses upstream.

---

## Map Use Cases (Where Maps Earn Their Place)

Maps appear only where geography changes the meaning of the data.
Test: *Does seeing WHERE something happens change how you understand it?* If no — use a table.

| Location | Map | Why it earns its place |
|----------|-----|----------------------|
| Homepage | District context map | "Who represents me?" answered instantly |
| Proposal pages | Impact choropleth | Makes abstract policy concrete to the user's county |
| Official profiles | District + donor geography | Who they represent vs. who funds them |
| Agency pages | Spending geography | Where does the money actually go? |
| Spending data | Default to map | Geography IS the story |
| Connection graph | Optional geographic overlay | Lobbying corridors become literal |
| Civic crowdfunding | Supporter origin map | Proves grassroots spread |
| Global governance | Civic Health Map | The platform's visual north star |

---

## The Civic Health Map

The single most important map in the platform. A world map showing democratic health by jurisdiction.

**Score components:**
- Official engagement and constituent response rates
- Promise fulfillment scores
- Donor capture index (vote/donor correlation)
- Civic participation rate (comment submissions per capita)
- Platform transparency score

**Visual language:** Dark (low civic health) → bright (high civic health). Never red vs. blue.
Zoom from world → country → state → district. Every level shows its specific score with explanation.

The map is also an action surface: click any jurisdiction → "Here's why this score / here's what's improving / here's how to help."

---

## Visual Principles

- Neutral base map style — no red vs. blue for political data
- Data drives color: spending = green scale, engagement = blue scale
- Progressive disclosure: simple view first, expert layers optional
- Mobile-first — touch-friendly controls
