/**
 * FIX-1427 — referential.data_flags_orphan_officials counts the official flags
 * whose entity_id has no officials row, the bullet's census. No DB: a fake
 * `query` answers by SQL shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { referentialChecks } from "./referential";
import type { CheckContext, CheckResult } from "../types";

function fakeQuery(flagOrphans: { id: string; entity_id: string }[], seen: string[]): CheckContext["query"] {
  return (async (sql: string) => {
    if (sql.includes("FROM data_flags d")) {
      seen.push(sql);
      return flagOrphans;
    }
    return []; // orphansFor(): no entity types, so no per-type queries
  }) as CheckContext["query"];
}

const byCategory = (rs: CheckResult[], c: string) => {
  const r = rs.find((x) => x.category === c);
  assert.ok(r, c);
  return r;
};

test("no orphan official flags reads info, 0", async () => {
  const seen: string[] = [];
  const r = byCategory(await referentialChecks({ query: fakeQuery([], seen) }), "referential.data_flags_orphan_officials");
  assert.equal(r.severity, "info");
  assert.equal(r.actual, 0);
  assert.deepEqual(r.sample, []);
  // The census: official refs only, anti-joined to officials.
  assert.equal(seen.length, 1);
  assert.match(seen[0] as string, /WHERE d\.entity_type = 'official'\s+AND NOT EXISTS \(SELECT 1 FROM officials o WHERE o\.id = d\.entity_id\)/);
});

test("orphan official flags read warning with the count and up to 10 rows", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, entity_id: `o${i}` }));
  const r = byCategory(await referentialChecks({ query: fakeQuery(rows, []) }), "referential.data_flags_orphan_officials");
  assert.equal(r.severity, "warning");
  assert.equal(r.actual, 12);
  assert.equal(r.sample.length, 10);
});
