/**
 * FIX-1436 — resolveJudicialGovBodies with a stubbed client: a failed court
 * lookup writes nothing for that court, and a court name held by two rows
 * resolves to the oldest (playbook §E13).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveJudicialGovBodies } from "./writer";

type Res = { data: Array<Record<string, unknown>> | null; error: { message: string; code?: string } | null };

interface Captured {
  inserts: Array<Record<string, unknown>>;
  refUpserts: Array<Record<string, unknown>>;
}

/**
 * Covers: governing_bodies select→eq→eq→order→order (awaited; answered by the
 * court name), insert→select→single; external_source_refs upsert; rpc.
 */
function fakeDb(byName: Record<string, Res>, captured: Captured) {
  const from = (table: string) => {
    let name = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: (col: string, v: string) => {
        if (col === "name") name = v;
        return q;
      },
      order: () => q,
      then: (ok: (v: Res) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(byName[name] ?? { data: [], error: null }).then(ok, bad),
      insert: (values: Record<string, unknown>) => {
        captured.inserts.push(values);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: `new-${values["short_name"]}` }, error: null }) }) };
      },
      upsert: (rows: Array<Record<string, unknown>>) => {
        if (table === "external_source_refs") captured.refUpserts.push(...rows);
        return Promise.resolve({ error: null });
      },
    };
    return q;
  };
  return { from, rpc: () => Promise.resolve({ data: 0, error: null }) };
}

const SCOTUS = "Supreme Court of the United States";
const CA5 = "U.S. Court of Appeals for the Fifth Circuit";

test("a failed court lookup inserts nothing and leaves the court out of the map", async () => {
  const c: Captured = { inserts: [], refUpserts: [] };
  const out = await resolveJudicialGovBodies(
    fakeDb({ [CA5]: { data: null, error: { message: "canceling statement due to statement timeout" } } }, c),
    "fed",
    ["ca5"],
  );
  assert.deepEqual(out.failed, ["ca5"]);
  assert.equal(out.courtMap.size, 0);
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(c.refUpserts, []);
});

test("a court name held by two rows: the oldest is used, the other counted, nothing inserted", async () => {
  const c: Captured = { inserts: [], refUpserts: [] };
  const out = await resolveJudicialGovBodies(
    fakeDb(
      {
        [SCOTUS]: {
          data: [
            { id: "gb-newer", created_at: "2026-06-01T00:00:00+00:00" },
            { id: "gb-older", created_at: "2026-04-25T00:00:00+00:00" },
          ],
          error: null,
        },
      },
      c,
    ),
    "fed",
    ["scotus"],
  );
  assert.equal(out.courtMap.get("scotus"), "gb-older");
  assert.equal(out.duplicates, 1);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(c.refUpserts.map((r) => r["entity_id"]), ["gb-older"]);
});

test("absent: inserted once; one failed court does not stop the next", async () => {
  const c: Captured = { inserts: [], refUpserts: [] };
  const out = await resolveJudicialGovBodies(
    fakeDb({ [CA5]: { data: null, error: { message: "boom" } } }, c),
    "fed",
    ["ca5", "scotus"],
  );
  assert.deepEqual(out.failed, ["ca5"]);
  assert.equal(out.inserted, 1);
  assert.equal(out.courtMap.get("scotus"), "new-SCOTUS");
  assert.deepEqual(c.inserts.map((r) => r["name"]), [SCOTUS]);
});
