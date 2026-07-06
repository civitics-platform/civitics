/**
 * FIX-749 — keyset cursor codec round-trip + fail-open decode.
 * Runs via:  pnpm --filter @civitics/app-civitics test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor, type Cursor } from "./cursor";

const cases: Cursor[] = [
  { sortValue: "MAKE AMERICA GREAT AGAIN INC.", entityId: "4ce3358f-c4f7-421a-acdb-e6ff652ac55e" },
  { sortValue: 35689218370, entityId: "a0f11c04-04af-446a-8ffd-80b21de8dd45" },
  { sortValue: null, entityId: "00000000-0000-0000-0000-000000000001" }, // NULLS-LAST tail
  { sortValue: "name, with, commas (and parens).", entityId: "abc" }, // hostile string
  { sortValue: "", entityId: "def" },
];

test("cursor round-trips every sortValue shape", () => {
  for (const c of cases) {
    const decoded = decodeCursor(encodeCursor(c));
    assert.deepEqual(decoded, c);
  }
});

test("cursor encoding is base64url (no +/= that would break URLs)", () => {
  for (const c of cases) {
    const enc = encodeCursor(c);
    assert.equal(/[+/=]/.test(enc), false, `unexpected URL-unsafe char in ${enc}`);
  }
});

test("decodeCursor fails open to null on malformed input", () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor("not-base64!!!"), null);
  assert.equal(decodeCursor(Buffer.from('{"not":"an array"}').toString("base64")), null);
  assert.equal(decodeCursor(Buffer.from("[1]").toString("base64")), null); // wrong arity
  assert.equal(decodeCursor(Buffer.from('["v", 123]').toString("base64")), null); // non-string id
  assert.equal(decodeCursor(Buffer.from('[{}, "id"]').toString("base64")), null); // bad sortValue type
});
