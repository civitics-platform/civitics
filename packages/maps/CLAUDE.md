# packages/maps/CLAUDE.md

Mapbox GL JS + Deck.gl utilities and the PostGIS spatial helpers. Live:
`NEXT_PUBLIC_MAPBOX_TOKEN` (public, client SDK) is set locally and in Vercel.
The pre-cc-249 file (stack and cost notes, map use cases, the Civic Health Map
design) is `docs/archive/claude-md-maps-2026-10-25.md`.

Slow request-path query? See `packages/db/CLAUDE.md` §Materialization pattern
for slow request-path aggregations.

## Privacy

**Never store precise user coordinates.** Geocode once, coarsen to ~1 km
before any write, keep only the coarsened point and district ids. A Core
Principle: `docs/ONBOARDING.md` §Core Principles.

## Spatial queries

- Every spatial predicate on `jurisdictions.boundary_geometry` must use
  `jurisdictions_boundary_gist` (0001). Confirm with `EXPLAIN ANALYZE`.
- District reads go through `query_districts(...)` (id, bbox, point, state,
  chamber, simplify, limit); `GET /api/districts` wraps it as GeoJSON. Its
  point-in-polygon, fill and id paths differ for the NH floterial overlay
  (FIX-914, FIX-1170).
- Boundaries: `pnpm --filter @civitics/data data:districts` loads Census TIGER
  SLD-U, SLD-L and the 119th Congress districts (CD119) through
  `upsert_district_jurisdiction()`, annual cadence. TIGER SLD polygons include
  coastal water: clip to land before comparing areas
  (`docs/audits/2026-09-10-fix914-floterials-dry-run.md`). Officials are linked by
  `link_officials_to_districts()` at the end of the districts and bulk-people
  pipelines.
- `GET /api/districts` and `GET /api/representatives` still work but nothing
  in the app calls them since the homepage `DistrictMap` was removed (FIX-554,
  FIX-1119). The detail page `/districts/[id]` uses `SingleDistrictMap`.

## Visual principles

- Neutral base map — never red vs. blue for political data.
- Data drives colour: spending = green scale, engagement = blue scale.
- Progressive disclosure: the simple view first, expert layers optional.
- Mobile-first, touch-friendly controls.
- A map earns its place only where WHERE changes the meaning; otherwise use a
  table.
