/**
 * FIX-1436 — resolveNominee with a stubbed client: what each lookup outcome
 * writes. The rule under test is playbook §E13 (only an empty result inserts)
 * and §E6 (a name matching two rows is not a match).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNominee, type NominationCounts } from "./index";

type Res = { data: Array<Record<string, unknown>> | null; error: { message: string } | null };

interface Captured {
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ values: Record<string, unknown>; id: string }>;
  lookups: Array<"key" | "name">;
}

/** Covers the shapes resolveNominee uses: select→filter|ilike→order→order (awaited), update→eq, insert→select→single. */
function fakeDb(byKey: Res, byName: Res, captured: Captured) {
  const from = () => {
    let kind: "key" | "name" = "key";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      filter: () => ((kind = "key"), q),
      ilike: () => ((kind = "name"), q),
      order: () => q,
      then: (ok: (v: Res) => unknown, bad: (e: unknown) => unknown) => {
        captured.lookups.push(kind);
        return Promise.resolve(kind === "key" ? byKey : byName).then(ok, bad);
      },
      update: (values: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          captured.updates.push({ values, id });
          return Promise.resolve({ error: null });
        },
      }),
      insert: (values: Record<string, unknown>) => {
        captured.inserts.push(values);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: "inserted-1" }, error: null }) }) };
      },
    };
    return q;
  };
  return { from };
}

const NOMINEE = { name: "Kevin Warsh", nominationId: "119-855-01", positionTitle: "Chairman of the Board of Governors" };
const FED = "fed-jurisdiction";
const ok = (rows: Array<Record<string, unknown>>): Res => ({ data: rows, error: null });
const err = (message: string): Res => ({ data: null, error: { message } });
const counts = (): NominationCounts => ({ inserted: 0, failed: 0, duplicates: 0, ambiguous_name: 0 });
const captured = (): Captured => ({ inserts: [], updates: [], lookups: [] });

test("a failed lookup by nomination id writes nothing and counts failed", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(fakeDb(err("statement timeout"), ok([]), c), NOMINEE, FED, n);
  assert.equal(id, null);
  assert.deepEqual(n, { inserted: 0, failed: 1, duplicates: 0, ambiguous_name: 0 });
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(c.updates, []);
  assert.deepEqual(c.lookups, ["key"], "a failed key lookup does not fall through to the name");
});

test("a failed lookup by name writes nothing and counts failed", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(fakeDb(ok([]), err("statement timeout"), c), NOMINEE, FED, n);
  assert.equal(id, null);
  assert.equal(n.failed, 1);
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(c.updates, []);
});

test("two rows carry the nomination id: the oldest is used, the other counted", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(
    fakeDb(
      ok([
        { id: "newer", created_at: "2026-07-06T04:00:00+00:00" },
        { id: "older", created_at: "2026-05-13T04:00:00+00:00" },
      ]),
      ok([]),
      c,
    ),
    NOMINEE,
    FED,
    n,
  );
  assert.equal(id, "older");
  assert.equal(n.duplicates, 1);
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(c.lookups, ["key"]);
});

test("the name matches two rows: neither adopted, ambiguous_name 1, the nomination-keyed row inserted", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(
    fakeDb(
      ok([]),
      ok([
        { id: "plum", created_at: "2026-07-14T00:00:00+00:00", source_ids: {} },
        { id: "wikidata", created_at: "2026-05-07T00:00:00+00:00", source_ids: { wikidata_id: "Q1" } },
      ]),
      c,
    ),
    NOMINEE,
    FED,
    n,
  );
  assert.equal(id, "inserted-1");
  assert.deepEqual(n, { inserted: 1, failed: 0, duplicates: 0, ambiguous_name: 1 });
  assert.deepEqual(c.updates, [], "no same-name row is adopted");
  assert.equal(c.inserts.length, 1);
  assert.deepEqual(c.inserts[0]!["source_ids"], { congress_nomination_id: "119-855-01" });
});

test("the name matches one row: adopted with the nomination id merged in, no insert (unchanged)", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(
    fakeDb(ok([]), ok([{ id: "wikidata", created_at: "2026-05-07T00:00:00+00:00", source_ids: { wikidata_id: "Q1" } }]), c),
    NOMINEE,
    FED,
    n,
  );
  assert.equal(id, "wikidata");
  assert.deepEqual(c.inserts, []);
  assert.equal(c.updates.length, 1);
  assert.equal(c.updates[0]!.id, "wikidata");
  assert.deepEqual(c.updates[0]!.values["source_ids"], { wikidata_id: "Q1", congress_nomination_id: "119-855-01" });
  assert.deepEqual(n, counts());
});

test("absent by key and by name: inserted", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(fakeDb(ok([]), ok([]), c), NOMINEE, FED, n);
  assert.equal(id, "inserted-1");
  assert.deepEqual(n, { inserted: 1, failed: 0, duplicates: 0, ambiguous_name: 0 });
});

test("absent with no federal jurisdiction: nothing inserted, nothing counted (unchanged)", async () => {
  const c = captured();
  const n = counts();
  const id = await resolveNominee(fakeDb(ok([]), ok([]), c), NOMINEE, null, n);
  assert.equal(id, null);
  assert.deepEqual(c.inserts, []);
  assert.deepEqual(n, counts());
});
