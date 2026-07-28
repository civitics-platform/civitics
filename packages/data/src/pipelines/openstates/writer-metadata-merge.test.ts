/**
 * FIX-915 — the correctness proof for the legislator metadata merge.
 *
 * upsertLegislatorsBatch's update path is `.upsert(records, { onConflict: 'id' })`,
 * which REPLACES officials.metadata wholesale — PostgREST cannot express a
 * server-side jsonb merge. The pipelines only ever supply
 * {org_classification, state}, so every run destroyed
 * metadata->>'district_jurisdiction_id', the SLD choropleth cross-link that
 * link_officials_to_districts() derives. Both OpenStates pipelines share this
 * writer, and the weekly API one never called the linker at all.
 *
 * What this proves, with no DB and no network (runs in the default `pnpm test`):
 *   1. UPDATE path — an existing district_jurisdiction_id SURVIVES an upsert
 *      that carries only {org_classification, state}, and the incoming keys
 *      still win over stale values.
 *   2. INSERT path — a first-seen legislator gets exactly the incoming
 *      metadata, with no merge and no leakage from the map/index.
 *   3. The prefetch is chunked over the update ids and covers all of them —
 *      a missed chunk silently re-clobbers exactly the keys this exists to
 *      preserve (the FIX-545 failure shape).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertLegislatorsBatch, type LegislatorInput } from "./writer";

interface Captured {
  officialUpserts: Array<Record<string, unknown>>;
  officialInserts: Array<Record<string, unknown>>;
  metadataPrefetchIds: string[][];
}

/**
 * Minimal stand-in for the supabase-js client, covering exactly the call shapes
 * upsertLegislatorsBatch uses: .from(t).select(..).eq(..).eq(..).in(..),
 * .from(t).select(..).in(..), .from(t).upsert(..), .from(t).insert(..).select(..),
 * and .rpc(..) (via refreshPrimarySourceForEntities).
 */
function fakeDb(
  refRows: Array<{ entity_id: string; external_id: string }>,
  officialRows: Array<{ id: string; metadata: unknown }>,
  captured: Captured,
) {
  const makeQuery = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      in: (_col: string, vals: string[]) => {
        if (table === "external_source_refs") {
          return Promise.resolve({
            data: refRows.filter((r) => vals.includes(r.external_id)),
            error: null,
          });
        }
        if (table === "officials") {
          captured.metadataPrefetchIds.push([...vals]);
          return Promise.resolve({
            data: officialRows.filter((r) => vals.includes(r.id)),
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      },
      upsert: (records: Array<Record<string, unknown>>) => {
        if (table === "officials") captured.officialUpserts.push(...records);
        return Promise.resolve({ data: null, error: null });
      },
      insert: (records: Array<Record<string, unknown>>) => {
        if (table === "officials") captured.officialInserts.push(...records);
        return {
          select: () =>
            Promise.resolve({
              data: records.map((_, i) => ({ id: `inserted-${i}` })),
              error: null,
            }),
        };
      },
    };
    return q;
  };
  return {
    from: (t: string) => makeQuery(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function legislator(over: Partial<LegislatorInput> = {}): LegislatorInput {
  return {
    openstatesId: "ocd-person/aaaa",
    fullName: "Test Legislator",
    roleTitle: "State Representative",
    governingBodyId: "gb-1",
    jurisdictionId: "jur-state-nh",
    party: "democrat",
    districtName: "Belknap 1",
    websiteUrl: null,
    metadata: { org_classification: "lower", state: "NH" },
    ...over,
  };
}

test("FIX-915 update path merges metadata — district_jurisdiction_id survives", async () => {
  const captured: Captured = { officialUpserts: [], officialInserts: [], metadataPrefetchIds: [] };
  const db = fakeDb(
    [{ entity_id: "off-1", external_id: "ocd-person/aaaa" }],
    [
      {
        id: "off-1",
        metadata: {
          org_classification: "upper",           // stale — incoming must win
          state: "NH",
          district_jurisdiction_id: "jur-district-123",  // must survive
          state_abbr: "NH",                      // unrelated key must survive too
        },
      },
    ],
    captured,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await upsertLegislatorsBatch(db as any, [legislator()]);

  assert.equal(res.updated, 1, "took the update path");
  assert.equal(res.inserted, 0);
  assert.equal(captured.officialUpserts.length, 1);

  const merged = captured.officialUpserts[0].metadata as Record<string, unknown>;
  assert.equal(
    merged.district_jurisdiction_id,
    "jur-district-123",
    "the SLD cross-link the pipeline never supplies must survive the upsert",
  );
  assert.equal(merged.state_abbr, "NH", "unrelated pre-existing keys survive too");
  assert.equal(
    merged.org_classification,
    "lower",
    "incoming keys win over stale existing values",
  );
  assert.equal(merged.state, "NH");
  assert.deepEqual(
    Object.keys(merged).sort(),
    ["district_jurisdiction_id", "org_classification", "state", "state_abbr"],
    "merge adds nothing beyond existing + incoming",
  );
});

test("FIX-915 insert path takes the incoming metadata verbatim, no merge", async () => {
  const captured: Captured = { officialUpserts: [], officialInserts: [], metadataPrefetchIds: [] };
  const db = fakeDb([], [], captured); // no xsr row → first-seen legislator

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await upsertLegislatorsBatch(db as any, [legislator()]);

  assert.equal(res.inserted, 1, "took the insert path");
  assert.equal(res.updated, 0);
  assert.equal(captured.officialInserts.length, 1);
  assert.deepEqual(
    captured.officialInserts[0].metadata,
    { org_classification: "lower", state: "NH" },
    "insert path carries exactly the incoming metadata — nothing to preserve, nothing leaked",
  );
  assert.equal(
    captured.metadataPrefetchIds.length,
    0,
    "no update targets → no metadata prefetch round-trip",
  );
});

test("FIX-915 metadata prefetch is chunked and covers every update target", async () => {
  // 250 existing legislators forces >1 chunk at LOOKUP_CHUNK_SIZE=100. A chunk
  // silently skipped here would make those rows look metadata-less and
  // re-clobber them — the FIX-545 regression shape.
  const n = 250;
  const items = Array.from({ length: n }, (_, i) =>
    legislator({ openstatesId: `ocd-person/p${i}`, fullName: `Legislator ${i}` }),
  );
  const refRows = Array.from({ length: n }, (_, i) => ({
    entity_id: `off-${i}`,
    external_id: `ocd-person/p${i}`,
  }));
  const officialRows = Array.from({ length: n }, (_, i) => ({
    id: `off-${i}`,
    metadata: { org_classification: "lower", state: "NH", district_jurisdiction_id: `jur-${i}` },
  }));

  const captured: Captured = { officialUpserts: [], officialInserts: [], metadataPrefetchIds: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await upsertLegislatorsBatch(fakeDb(refRows, officialRows, captured) as any, items);

  assert.equal(res.updated, n);
  assert.ok(captured.metadataPrefetchIds.length > 1, "prefetch was chunked, not one giant .in()");
  assert.equal(
    captured.metadataPrefetchIds.flat().length,
    n,
    "every update target was prefetched exactly once",
  );
  assert.equal(captured.officialUpserts.length, n);
  for (const rec of captured.officialUpserts) {
    const meta = rec.metadata as Record<string, unknown>;
    const idx = String(rec.id).replace("off-", "");
    assert.equal(
      meta.district_jurisdiction_id,
      `jur-${idx}`,
      `row ${rec.id} kept its own link (no cross-row bleed)`,
    );
  }
});
