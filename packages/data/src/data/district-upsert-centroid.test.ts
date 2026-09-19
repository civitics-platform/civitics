/**
 * FIX-1171 — upsert_district_jurisdiction() writes centroid on BOTH paths.
 *
 * The bug was invisible to every count: the RPC wrote boundary_geometry and
 * never centroid, and the 7,211 TIGER rows look fine only because
 * 20260528170000's backfill filled them once — and that backfill refuses, by
 * construction, to touch a row that already has a boundary. So an INSERT landed
 * a NULL centroid nothing would ever fill, and an UPDATE left the label point at
 * the previous vintage's position while reporting success.
 *
 * Asserting on the live 7,250 rows cannot catch that, because the trigger is
 * only pulled by the next annual `districts-tiger` run. These cases fire the RPC
 * at a fixture polygon inside a transaction that is rolled back, which is the
 * only way to exercise the update path without waiting a year or writing to a
 * real district.
 *
 * Skips when 127.0.0.1:54322 is unreachable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Outside any real district, and unique enough to be unmistakable in a stray row. */
const FIXTURE_GEOID = "ZZ-FIX1171-FIXTURE";

/** Unit square at the origin → ST_PointOnSurface (0.5 0.5). */
const SQUARE_AT_ORIGIN =
  '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]}';
/** The same square shifted ten degrees east → (10.5 0.5). A redistricting, in miniature. */
const SQUARE_SHIFTED_EAST =
  '{"type":"Polygon","coordinates":[[[10,0],[10,1],[11,1],[11,0],[10,0]]]}';

async function connectOrNull(): Promise<Client | null> {
  const client = new Client({
    connectionString: LOCAL_DB_URL,
    application_name: "civitics_district_upsert_centroid_test",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

async function upsert(client: Client, geojson: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT public.upsert_district_jurisdiction(
       (SELECT id FROM public.jurisdictions WHERE type = 'state' ORDER BY id LIMIT 1),
       'FIX-1171 fixture', 'F1171', '99', $1, 'lower',
       jsonb_build_object('source','tiger','chamber','lower',
                          'state_abbr','ZZ','district_id','F1171'),
       $2
     ) AS id`,
    [FIXTURE_GEOID, geojson],
  );
  return rows[0]!.id;
}

async function centroidOf(client: Client, id: string): Promise<string | null> {
  const { rows } = await client.query<{ pt: string | null }>(
    `SELECT ST_AsText(centroid) AS pt FROM public.jurisdictions WHERE id = $1`,
    [id],
  );
  return rows[0]!.pt;
}

test("the INSERT path writes a centroid — a new district is not born with a NULL one", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    await client.query("BEGIN");
    const id = await upsert(client, SQUARE_AT_ORIGIN);
    const pt = await centroidOf(client, id);
    assert.equal(pt, "POINT(0.5 0.5)",
      "a district inserted by the RPC must carry the ST_PointOnSurface of its own geometry; " +
      "the 20260528170000 backfill will never fill it, because the boundary is already set");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});

test("the UPDATE path MOVES the centroid with the geometry — the FIX-1171 bug itself", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    await client.query("BEGIN");

    const id = await upsert(client, SQUARE_AT_ORIGIN);
    const before = await centroidOf(client, id);
    assert.equal(before, "POINT(0.5 0.5)");

    // Same key, new polygon — exactly what an annual TIGER refresh does to a
    // redistricted seat.
    const sameId = await upsert(client, SQUARE_SHIFTED_EAST);
    assert.equal(sameId, id, "the second call must take the UPDATE branch, not insert a second row");

    const after = await centroidOf(client, id);
    assert.equal(after, "POINT(10.5 0.5)",
      "before FIX-1171 this stayed at POINT(0.5 0.5) — the boundary moved and the label point did not");
    assert.notEqual(after, before);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});

test("ST_PointOnSurface, not ST_Centroid — the convention the 7,211 base rows were filled with", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    await client.query("BEGIN");

    // A C-shape: its ST_Centroid falls in the notch, OUTSIDE the polygon.
    // ST_PointOnSurface is guaranteed to land on it. This is why
    // 20260528170000, 20260528180100 and the FIX-914 derivation all use the
    // latter, and why the two populations would disagree if this one differed.
    const cShape =
      '{"type":"Polygon","coordinates":[[[0,0],[3,0],[3,1],[1,1],[1,2],[3,2],[3,3],[0,3],[0,0]]]}';
    const id = await upsert(client, cShape);

    const { rows } = await client.query<{ on_surface: boolean; centroid_inside: boolean }>(
      `SELECT ST_Contains(boundary_geometry, centroid)                    AS on_surface,
              ST_Contains(boundary_geometry, ST_Centroid(boundary_geometry)) AS centroid_inside
         FROM public.jurisdictions WHERE id = $1`,
      [id],
    );
    assert.equal(rows[0]!.on_surface, true, "the stored label point must lie ON the district");
    assert.equal(rows[0]!.centroid_inside, false,
      "fixture check: this shape's ST_Centroid should fall outside it, or the case proves nothing");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});
