/**
 * FIX-914 — the reader contract for the New Hampshire floterial overlay.
 *
 * Seeding 39 polygons that overlap 164 breaks the one thing every district
 * reader assumed: that a state's 'HD' rows partition it. These cases pin the
 * three query_districts() paths apart, because the right answer differs by
 * path and a single global filter cannot express that:
 *
 *   fill   (bbox / state)  -> base districts only. A choropleth of New
 *                             Hampshire must stay a partition of New Hampshire,
 *                             and voting-divergence pages this RPC at
 *                             p_limit 200 — 203 rows would truncate three
 *                             districts off the map without anyone noticing.
 *   point  (containment)   -> BOTH. "Which districts contain this address" is
 *                             the question the overlay exists to answer
 *                             differently; a Belmont resident has Belknap 4 AND
 *                             Belknap 8 representatives.
 *   id     (exact lookup)  -> the row asked for, overlay or not, or the
 *                             floterial's own /districts/[id] page has no map.
 *   FIX-1170 added a fourth: an explicit p_include_floterial := true, which
 *                             returns BOTH layers with a `floterial` column
 *                             saying which is which, for the overlay layer on
 *                             the choropleth. It is an opt-in, so the fill case
 *                             above is unchanged and stays the default.
 *
 * Skips when 127.0.0.1:54322 is unreachable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function connectOrNull(): Promise<Client | null> {
  const client = new Client({
    connectionString: LOCAL_DB_URL,
    application_name: "civitics_nh_floterial_reader_test",
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

/** A point inside Belmont, which is base district Belknap 4 and floterial Belknap 8. */
const BELMONT = { lng: -71.4784, lat: 43.4451 };

test("the NH lower-chamber FILL is still a partition — 164 rows, no overlay", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    const { rows } = await client.query<{ district_id: string }>(
      `SELECT district_id FROM public.query_districts('lower', 'NH', NULL, NULL, NULL, NULL,
                                                      NULL, NULL, 0.01, 500, NULL)`,
    );
    assert.equal(rows.length, 164,
      "a state fill must return the base layer only — 203 would overflow " +
      "voting-divergence's p_limit of 200 and silently drop districts");

    // Positively: not one of them is an overlay row.
    const { rows: flot } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM public.query_districts('lower','NH',NULL,NULL,NULL,NULL,NULL,NULL,0.01,500,NULL) q
         JOIN public.jurisdictions j ON j.id = q.id
        WHERE COALESCE((j.metadata->>'floterial')::boolean, false)`,
    );
    assert.equal(flot[0]!.n, "0");
  } finally { await client.end().catch(() => {}); }
});

test("a POINT lookup in Belmont returns both the base district and its floterial", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    const { rows } = await client.query<{ district_id: string; name: string }>(
      `SELECT district_id, name
         FROM public.query_districts('lower', 'NH', NULL, NULL, NULL, NULL, $1, $2, 0.01, 500, NULL)
        ORDER BY district_id`,
      [BELMONT.lng, BELMONT.lat],
    );
    const ids = rows.map((r) => r.district_id);
    assert.deepEqual(ids, ["004", "008"],
      `Belmont should resolve to base Belknap 4 and floterial Belknap 8, got ${JSON.stringify(ids)}`);
  } finally { await client.end().catch(() => {}); }
});

test("an exact ID lookup returns a floterial's geometry — /districts/[id] needs it", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    const { rows: seed } = await client.query<{ id: string }>(
      `SELECT id FROM public.jurisdictions
        WHERE type='district' AND metadata->>'source'='derived'
          AND metadata->>'district_id'='008'`,
    );
    assert.equal(seed.length, 1, "Belknap 8 should exist exactly once");

    const { rows } = await client.query<{ id: string; geom_geojson: string | null }>(
      `SELECT id, geom_geojson
         FROM public.query_districts(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0.0005,1,$1)`,
      [seed[0]!.id],
    );
    assert.equal(rows.length, 1, "the page's p_id lookup must find the floterial");
    assert.ok(rows[0]!.geom_geojson && rows[0]!.geom_geojson.length > 100,
      "the floterial page would render with no map");
  } finally { await client.end().catch(() => {}); }
});

test("jurisdictions_containing_point returns the overlay too, and its caller writes a grant per match", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    // /api/auth/verify-constituent iterates every row this returns and upserts
    // one constituent grant per jurisdiction. The overlay row arriving here is
    // the point: a Belmont resident is a constituent of Belknap 8 as well.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM public.jurisdictions_containing_point($1, $2) p
         JOIN public.jurisdictions j ON j.id = p.id
        WHERE j.type='district' AND j.metadata->>'chamber'='lower'
          AND COALESCE((j.metadata->>'floterial')::boolean,false)`,
      [BELMONT.lng, BELMONT.lat],
    );
    assert.equal(rows[0]!.n, "1", "Belmont sits in exactly one floterial (Belknap 8)");
  } finally { await client.end().catch(() => {}); }
});

test("every floterial's representatives are linked to it and its seat count is respected", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    const { rows } = await client.query<{ district_id: string; seats: string; linked: string }>(
      `SELECT j.metadata->>'district_id' AS district_id,
              j.metadata->>'seats'       AS seats,
              count(o.id)::text          AS linked
         FROM public.jurisdictions j
         LEFT JOIN public.officials o
                ON o.metadata->>'district_jurisdiction_id' = j.id::text
               AND o.is_active
        WHERE j.type='district' AND j.metadata->>'source'='derived'
        GROUP BY 1, 2 ORDER BY 1`,
    );
    assert.equal(rows.length, 39);
    const total = rows.reduce((n, r) => n + Number(r.linked), 0);
    assert.equal(total, 58, "all 58 floterial representatives should be linked");
    for (const r of rows) {
      assert.ok(Number(r.linked) <= Number(r.seats),
        `${r.district_id}: ${r.linked} linked but only ${r.seats} seats`);
    }
  } finally { await client.end().catch(() => {}); }
});

test("FIX-1170 — the OVERLAY reader opts in explicitly and gets 203 rows, 39 of them tagged", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    // The fourth path, added by FIX-1170: /api/graph/voting-divergence asks for
    // the base layer AND the overlay in one round trip, and draws them as two
    // layers. It is a new reader rather than a relaxation of the fill — the
    // case above still pins the default at 164, and must keep doing so.
    const { rows } = await client.query<{ district_id: string; floterial: boolean }>(
      `SELECT district_id, floterial
         FROM public.query_districts('lower','NH',NULL,NULL,NULL,NULL,NULL,NULL,0.01,400,NULL,true)`,
    );
    assert.equal(rows.length, 203, "164 base + 39 overlay");
    assert.equal(rows.filter((r) => r.floterial).length, 39);
    assert.equal(rows.filter((r) => !r.floterial).length, 164);
  } finally { await client.end().catch(() => {}); }
});

test("FIX-1170 — p_limit 400 clears the largest band in the country, which is NOT New Hampshire", async (t) => {
  const client = await connectOrNull();
  if (!client) { t.skip("local Postgres unreachable"); return; }
  try {
    // The 200 that FIX-914's header flagged as an NH hazard was ALREADY
    // truncating Pennsylvania: PA's lower chamber is 203 base districts with no
    // floterial anywhere near it, so three have been missing from the
    // choropleth since FIX-217. Pin the measurement the new limit was chosen
    // from, so a future state crossing 400 fails here rather than on the map.
    const { rows } = await client.query<{ st: string; ch: string; n: string }>(
      `SELECT metadata->>'state_abbr' AS st, metadata->>'chamber' AS ch, count(*)::text AS n
         FROM public.jurisdictions
        WHERE type = 'district'
        GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`,
    );
    const largest = Number(rows[0]!.n);
    assert.ok(largest <= 400,
      `voting-divergence pages query_districts at p_limit 400; the largest band is ` +
      `${rows[0]!.st}/${rows[0]!.ch} at ${largest} rows, which would truncate`);
    assert.ok(largest > 200,
      "fixture check: if no band exceeds 200 any more, the p_limit finding has changed and this case should be re-read");
  } finally { await client.end().catch(() => {}); }
});
