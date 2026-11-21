/**
 * FIX-1436 — the three-outcome lookup (playbook §E13), with no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveByKey, resolveByName } from "./lookup-outcome";

const row = (id: string, created_at: string | null) => ({ id, created_at });

test("an error is failed, never absent", () => {
  const res = { data: null, error: { message: "canceling statement due to statement timeout" } };
  assert.deepEqual(resolveByKey(res), { kind: "failed", error: "canceling statement due to statement timeout" });
  assert.deepEqual(resolveByName(res), { kind: "failed", error: "canceling statement due to statement timeout" });
});

test("an error wins even when rows came back with it", () => {
  const res = { data: [row("a", "2026-05-09T00:00:00+00:00")], error: { message: "boom" } };
  assert.equal(resolveByKey(res).kind, "failed");
  assert.equal(resolveByName(res).kind, "failed");
});

test("no rows is absent with nothing ambiguous", () => {
  for (const data of [[], null]) {
    assert.deepEqual(resolveByKey({ data, error: null }), { kind: "absent", ambiguous: [] });
    assert.deepEqual(resolveByName({ data, error: null }), { kind: "absent", ambiguous: [] });
  }
});

test("by key, two rows: the oldest wins and the other is a duplicate", () => {
  const out = resolveByKey({
    data: [row("newer", "2026-07-06T04:00:00+00:00"), row("older", "2026-05-13T04:00:00+00:00")],
    error: null,
  });
  assert.equal(out.kind, "found");
  if (out.kind !== "found") return;
  assert.equal(out.row.id, "older");
  assert.deepEqual(out.duplicates, ["newer"]);
});

test("by key, a created_at tie falls to the id; microseconds still order", () => {
  const tie = resolveByKey({
    data: [row("b", "2026-05-09T04:54:13.105946+00:00"), row("a", "2026-05-09T04:54:13.105946+00:00")],
    error: null,
  });
  assert.equal(tie.kind === "found" && tie.row.id, "a");
  const us = resolveByKey({
    data: [row("a", "2026-05-09T04:54:13.105947+00:00"), row("b", "2026-05-09T04:54:13.105946+00:00")],
    error: null,
  });
  assert.equal(us.kind === "found" && us.row.id, "b");
});

test("by key, one row is found with no duplicates", () => {
  const out = resolveByKey({ data: [row("only", "2026-05-09T00:00:00+00:00")], error: null });
  assert.deepEqual(out, { kind: "found", row: row("only", "2026-05-09T00:00:00+00:00"), duplicates: [] });
});

test("by name, one row is adopted", () => {
  const out = resolveByName({ data: [row("only", "2026-05-09T00:00:00+00:00")], error: null });
  assert.equal(out.kind === "found" && out.row.id, "only");
});

test("by name, two rows adopt neither: absent, with both ids oldest first", () => {
  const out = resolveByName({
    data: [row("plum", "2026-07-14T00:00:00+00:00"), row("wikidata", "2026-05-07T00:00:00+00:00")],
    error: null,
  });
  assert.deepEqual(out, { kind: "absent", ambiguous: ["wikidata", "plum"] });
});
