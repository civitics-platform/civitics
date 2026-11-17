/**
 * FIX-1181 — the district linker runs over direct pg, bounded by its caller at
 * 60 s, and returns an outcome the caller records instead of only warning.
 *
 * No database: a fake client records the statements. The live call against
 * the local clone is in the cc-291 report.
 *
 * Runs via:  tsx --test src/lib/district-link.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DISTRICT_LINK_STATEMENT_TIMEOUT, linkOfficialsToDistricts } from "./district-link";

function fakeClient(answer: { linked?: unknown; throwOn?: "set" | "select"; message?: string }) {
  const sql: string[] = [];
  let ended = 0;
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (answer.throwOn === "set" && text.startsWith("SET")) throw new Error(answer.message ?? "boom");
      if (answer.throwOn === "select" && text.startsWith("SELECT")) throw new Error(answer.message ?? "boom");
      return { rows: text.startsWith("SELECT") ? [{ linked: answer.linked }] : [] };
    },
    end: async () => {
      ended++;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, sql, ended: () => ended };
}

/** A clock that advances 1,234 ms between its two reads. */
function clock() {
  let t = 1_000_000;
  return () => {
    const v = t;
    t += 1_234;
    return v;
  };
}

test("the caller's statement is bounded at 60 s BEFORE the call, and the count comes back", async () => {
  const f = fakeClient({ linked: "17" });
  const out = await linkOfficialsToDistricts({ connect: async () => f.client, now: clock() });
  assert.deepEqual(out, { ok: true, ms: 1_234, linked: 17, error: null });
  assert.deepEqual(f.sql, [
    `SET statement_timeout = '${DISTRICT_LINK_STATEMENT_TIMEOUT}'`,
    "SELECT public.link_officials_to_districts() AS linked",
  ]);
  assert.equal(DISTRICT_LINK_STATEMENT_TIMEOUT, "60s");
  assert.equal(f.ended(), 1, "the connection is closed");
});

test("a cancel is recorded, not thrown: ok false, linked 0, the error text", async () => {
  const f = fakeClient({ throwOn: "select", message: "canceling statement due to statement timeout" });
  const out = await linkOfficialsToDistricts({ connect: async () => f.client, now: clock() });
  assert.deepEqual(out, { ok: false, ms: 1_234, linked: 0, error: "canceling statement due to statement timeout" });
  assert.equal(f.ended(), 1, "closed on the failure path too");
});

test("no DSN / no connection is recorded the same way, never thrown", async () => {
  const out = await linkOfficialsToDistricts({
    connect: async () => {
      throw new Error("buildDbUrl: need SUPABASE_DB_URL, a local NEXT_PUBLIC_SUPABASE_URL, or …");
    },
    now: clock(),
  });
  assert.equal(out.ok, false);
  assert.equal(out.linked, 0);
  assert.match(out.error ?? "", /^buildDbUrl: need/);
});

test("a null count (nothing to link) is 0, not NaN", async () => {
  const f = fakeClient({ linked: null });
  const out = await linkOfficialsToDistricts({ connect: async () => f.client, now: clock() });
  assert.equal(out.linked, 0);
  assert.equal(out.ok, true);
});
