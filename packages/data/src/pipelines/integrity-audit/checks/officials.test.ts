/**
 * FIX-1428 — officials.president_count / vp_count name their rows when the
 * count is not 1. The seed's duplicate inserts read as vp_count 5 → 43 for six
 * weeks with `sample: []`. No DB: a fake `query` answers by SQL shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { officialsChecks } from "./officials";
import type { CheckContext, CheckResult } from "../types";

const VP_RE = "^Vice President( of the United States)?$";
const PRES_RE = "^President( of the United States)?$";

function fakeQuery(counts: { pres: number; vp: number }, sampleCalls: string[]): CheckContext["query"] {
  return (async (sql: string) => {
    const isVp = sql.includes(VP_RE);
    const isPres = !isVp && sql.includes(PRES_RE);
    if (isVp || isPres) {
      const n = isVp ? counts.vp : counts.pres;
      if (/COUNT\(\*\)/.test(sql)) return [{ count: String(n) }];
      assert.match(sql, /ORDER BY created_at, id\s+LIMIT 10/);
      sampleCalls.push(isVp ? "vp" : "pres");
      return Array.from({ length: Math.min(n, 10) }, (_, i) => ({
        id: `${isVp ? "v" : "p"}${i}`,
        full_name: isVp ? "J.D. Vance" : "Donald J. Trump",
        role_title: isVp ? "Vice President of the United States" : "President of the United States",
        created_at: `2026-10-${String(8 + i).padStart(2, "0")}T21:00:00Z`,
      }));
    }
    if (/COUNT\(\*\)/.test(sql)) return [{ count: "0" }];
    return [];
  }) as CheckContext["query"];
}

const byCategory = (rs: CheckResult[], c: string) => {
  const r = rs.find((x) => x.category === c);
  assert.ok(r, c);
  return r;
};

test("a count of 1 keeps sample empty and runs no sample query", async () => {
  const calls: string[] = [];
  const rs = await officialsChecks({ query: fakeQuery({ pres: 1, vp: 1 }, calls) });
  assert.deepEqual(byCategory(rs, "officials.president_count").sample, []);
  assert.deepEqual(byCategory(rs, "officials.vp_count").sample, []);
  assert.deepEqual(calls, []);
});

test("a count other than 1 samples up to 10 rows with id, full_name, role_title, created_at", async () => {
  const calls: string[] = [];
  const rs = await officialsChecks({ query: fakeQuery({ pres: 4, vp: 43 }, calls) });
  const pres = byCategory(rs, "officials.president_count");
  const vp = byCategory(rs, "officials.vp_count");
  assert.equal(pres.severity, "error");
  assert.equal(pres.actual, 4);
  assert.equal(pres.sample.length, 4);
  assert.equal(vp.actual, 43);
  assert.equal(vp.sample.length, 10);
  assert.deepEqual(Object.keys(vp.sample[0] as object).sort(), ["created_at", "full_name", "id", "role_title"]);
  assert.deepEqual(calls.sort(), ["pres", "vp"]);
});

test("a count of 0 also samples (and finds nothing)", async () => {
  const calls: string[] = [];
  const rs = await officialsChecks({ query: fakeQuery({ pres: 0, vp: 1 }, calls) });
  assert.deepEqual(byCategory(rs, "officials.president_count").sample, []);
  assert.deepEqual(calls, ["pres"]);
});
