/**
 * FIX-1419 — irs990's officials page read retries on the page that failed.
 *
 * Mon 2026-11-16 23:38:32Z: run 43980962350 died 10 s in on `officials load
 * failed: canceling statement due to statement timeout`. One 1,000-row keyset
 * page, no retry, and the run never reached the archives. D5: three tries per
 * page, 5 s then 15 s apart, on the same cursor; exhausted tries throw the same
 * message as before.
 *
 * No database: a fake PostgREST builder records each page's cursor and answers
 * from a script. The sleeps are injected.
 *
 * Runs via:  tsx --test src/pipelines/irs990/officials-retry.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIALS_PAGE_RETRY_DELAYS_MS,
  canonicalizePersonName,
  loadOfficialsByCanonicalName,
} from "./writer";

type Row = {
  id: string; full_name: string | null; first_name: string | null; last_name: string | null;
  tier: string | null; is_active: boolean | null;
};
type Answer = { data: Row[] | null; error: { message: string } | null };

const TIMEOUT = { data: null, error: { message: "canceling statement due to statement timeout" } };

/** Rows with ids that sort as text, and letter-only names the canonicalizer keeps. */
function rows(from: number, n: number): Row[] {
  const name = (i: number) =>
    String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (Math.floor(i / 26) % 26)) + String.fromCharCode(97 + (Math.floor(i / 676) % 26));
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return {
      id: `id-${String(i).padStart(5, "0")}`, full_name: null, first_name: `Ann${name(i)}`, last_name: `Lee${name(i)}`,
      tier: "candidate", is_active: true,
    };
  });
}

/** A fake `db` whose every `.from("officials")…` query records its cursor and takes the next scripted answer. */
function fakeDb(script: Answer[]) {
  const cursors: Array<string | null> = [];
  let next = 0;
  const db = {
    from(table: string) {
      assert.equal(table, "officials");
      let cursor: string | null = null;
      const q = {
        select: () => q,
        order: (col: string) => {
          assert.equal(col, "id");
          return q;
        },
        limit: (n: number) => {
          assert.equal(n, 1000);
          return q;
        },
        gt: (col: string, v: string) => {
          assert.equal(col, "id");
          cursor = v;
          return q;
        },
        then: (resolve: (a: Answer) => unknown, reject: (e: unknown) => unknown) => {
          cursors.push(cursor);
          const a = script[next++];
          return a ? Promise.resolve(a).then(resolve) : Promise.reject(new Error("script exhausted")).catch(reject);
        },
      };
      return q;
    },
  };
  return { db, cursors };
}

test("D5: the second page fails twice and succeeds on its third try, on the same cursor", async () => {
  const page1 = rows(0, 1000);
  const page2 = rows(1000, 3);
  const { db, cursors } = fakeDb([{ data: page1, error: null }, TIMEOUT, TIMEOUT, { data: page2, error: null }]);
  const sleeps: number[] = [];
  const { byName: map } = await loadOfficialsByCanonicalName(db, { sleep: async (ms) => void sleeps.push(ms) });

  const last1 = page1[999]!.id;
  assert.deepEqual(cursors, [null, last1, last1, last1], "every retry re-reads the page after the same id");
  assert.deepEqual(sleeps, [5_000, 15_000]);
  assert.deepEqual([...OFFICIALS_PAGE_RETRY_DELAYS_MS], [5_000, 15_000]);
  // Both pages landed in the map — nothing from the failed tries was lost or doubled.
  for (const r of [page1[0]!, page1[999]!, ...page2]) {
    assert.equal(map.get(canonicalizePersonName(`${r.first_name} ${r.last_name}`)), r.id, r.id);
  }
});

test("D5: the first page fails once — the retry starts from the beginning again", async () => {
  const { db, cursors } = fakeDb([TIMEOUT, { data: rows(0, 2), error: null }]);
  const sleeps: number[] = [];
  const { byName: map } = await loadOfficialsByCanonicalName(db, { sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(cursors, [null, null]);
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(map.size, 2);
});

test("D5: three failures on one page throw today's message, after 5 s and 15 s", async () => {
  const { db, cursors } = fakeDb([{ data: rows(0, 1000), error: null }, TIMEOUT, TIMEOUT, TIMEOUT, { data: rows(1000, 1), error: null }]);
  const sleeps: number[] = [];
  await assert.rejects(
    loadOfficialsByCanonicalName(db, { sleep: async (ms) => void sleeps.push(ms) }),
    (err: Error) => err.message === "officials load failed: canceling statement due to statement timeout",
  );
  assert.equal(cursors.length, 4, "one good page, then exactly three tries of the second");
  assert.deepEqual(sleeps, [5_000, 15_000]);
});
