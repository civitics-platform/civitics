/**
 * FIX-1428 — the executive seed's lookup reads every match and the oldest wins;
 * a lookup that fails writes nothing.
 *
 * Before the fix the lookup was `.maybeSingle()` and an error read as "not
 * found": one failed lookup inserted a duplicate, after which `.maybeSingle()`
 * errored every night (two rows match) and every nightly inserted another
 * (43 Vice Presidents on prod by 2026-11-18). No DB, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runExecutiveSeed } from "./seed";

interface Row {
  id: string;
  created_at: string;
}

interface Fake {
  /** Rows per seed id, deliberately NOT in created_at order. */
  rows: Record<string, Row[]>;
  /** Seed ids whose lookup returns an error. */
  lookupErrors?: Record<string, string>;
  /** Seed ids whose insert returns an error. */
  insertErrors?: Record<string, { code: string; message: string }>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ id: string; data: Record<string, unknown> }>;
}

const byCreatedThenId = (a: Row, b: Row) =>
  a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1;

/**
 * Stand-in for the supabase-js calls runExecutiveSeed makes. The officials
 * lookup is thenable at any chain length; it returns rows sorted only when the
 * code asked for `created_at` then `id`, the way an unordered read would not.
 */
function fakeDb(f: Fake) {
  return {
    from(table: string) {
      if (table === "jurisdictions" || table === "governing_bodies") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: () => Promise.resolve({ data: { id: `${table}-1` }, error: null }),
        };
        return q;
      }
      assert.equal(table, "officials");
      let seedId = "";
      const order: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        filter: (_col: string, _op: string, value: string) => {
          seedId = value;
          return q;
        },
        order: (col: string) => {
          order.push(col);
          return q;
        },
        maybeSingle: () => {
          throw new Error("the lookup must read every match, not maybeSingle()");
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const err = f.lookupErrors?.[seedId];
          const rows = [...(f.rows[seedId] ?? [])];
          if (order.join(",") === "created_at,id") rows.sort(byCreatedThenId);
          const res = err ? { data: null, error: { message: err } } : { data: rows, error: null };
          return Promise.resolve(res).then(resolve, reject);
        },
        update: (data: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            f.updates.push({ id, data });
            return Promise.resolve({ error: null });
          },
        }),
        insert: (data: Record<string, unknown>) => {
          f.inserts.push(data);
          return Promise.resolve({ error: f.insertErrors?.[seedOf(data)] ?? null });
        },
      };
      return q;
    },
  };
}

function quiet(t: { mock: { method: (o: object, m: string, impl: () => void) => unknown } }) {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
}

const seedOf = (data: Record<string, unknown>) =>
  (data.source_ids as { official_seed_id: string }).official_seed_id;

async function run(f: Fake) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return runExecutiveSeed({ db: fakeDb(f) as any });
}

test("no row → inserts one per executive", async (t) => {
  quiet(t);
  const f: Fake = { rows: {}, inserts: [], updates: [] };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 2, updated: 0, failed: 0, duplicates: 0 });
  assert.deepEqual(f.inserts.map(seedOf).sort(), ["potus_current", "vpotus_current"]);
  assert.equal(f.updates.length, 0);
});

test("one row → updates it, inserts none", async (t) => {
  quiet(t);
  const f: Fake = {
    rows: {
      potus_current: [{ id: "p1", created_at: "2026-05-25T05:34:55Z" }],
      vpotus_current: [{ id: "v1", created_at: "2026-05-25T05:34:55Z" }],
    },
    inserts: [],
    updates: [],
  };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 0, updated: 2, failed: 0, duplicates: 0 });
  assert.deepEqual(f.updates.map((u) => u.id).sort(), ["p1", "v1"]);
  assert.equal(f.inserts.length, 0);
});

test("three rows → updates the oldest only, inserts none, duplicates = 2", async (t) => {
  quiet(t);
  const warn = t.mock.method(console, "warn", () => {});
  const f: Fake = {
    rows: {
      potus_current: [{ id: "p1", created_at: "2026-05-25T05:34:55Z" }],
      // Out of order, and the two oldest share a created_at: id breaks the tie.
      vpotus_current: [
        { id: "v-newer", created_at: "2026-10-08T21:03:17Z" },
        { id: "v-b", created_at: "2026-05-25T05:34:55Z" },
        { id: "v-a", created_at: "2026-05-25T05:34:55Z" },
      ],
    },
    inserts: [],
    updates: [],
  };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 0, updated: 2, failed: 0, duplicates: 2 });
  assert.equal(f.inserts.length, 0);
  // The duplicates are left alone (D5): only the oldest of each is written.
  assert.deepEqual(f.updates.map((u) => u.id).sort(), ["p1", "v-a"]);
  const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    lines.some((l) =>
      l.includes("executive seed: vpotus_current has 3 rows — updating the oldest v-a; 2 duplicate(s) left for cleanup"),
    ),
    lines.join("\n"),
  );
});

test("a lookup error → no insert and no update for that executive, failed = 1", async (t) => {
  quiet(t);
  const f: Fake = {
    rows: { potus_current: [{ id: "p1", created_at: "2026-05-25T05:34:55Z" }] },
    lookupErrors: { vpotus_current: "canceling statement due to statement timeout" },
    inserts: [],
    updates: [],
  };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 0, updated: 1, failed: 1, duplicates: 0 });
  assert.equal(f.inserts.length, 0);
  assert.deepEqual(f.updates.map((u) => u.id), ["p1"]);
  assert.ok(!f.updates.some((u) => seedOf(u.data) === "vpotus_current"));
});

test("an insert refused by the unique seed-id index (23505) → failed = 1, no second row", async (t) => {
  // FIX-1429: officials_official_seed_id_key. A lookup that reads no row while
  // one exists ends in this insert, which the index now refuses.
  quiet(t);
  const f: Fake = {
    rows: { potus_current: [{ id: "p1", created_at: "2026-05-25T05:34:55Z" }] },
    insertErrors: {
      vpotus_current: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "officials_official_seed_id_key"',
      },
    },
    inserts: [],
    updates: [],
  };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 0, updated: 1, failed: 1, duplicates: 0 });
  assert.deepEqual(f.inserts.map(seedOf), ["vpotus_current"]);
  assert.deepEqual(f.updates.map((u) => u.id), ["p1"]);
});

test("every lookup errors → writes nothing at all", async (t) => {
  quiet(t);
  const f: Fake = {
    rows: {},
    lookupErrors: { potus_current: "boom", vpotus_current: "boom" },
    inserts: [],
    updates: [],
  };
  const r = await run(f);
  assert.deepEqual(r, { inserted: 0, updated: 0, failed: 2, duplicates: 0 });
  assert.equal(f.inserts.length + f.updates.length, 0);
});
