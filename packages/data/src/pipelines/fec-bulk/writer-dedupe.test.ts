/**
 * FIX-995 — the individual-donor client-side dedupe, after the clone was
 * dropped.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/writer-dedupe.test.ts
 *
 * The change under test is a RETENTION change, not a semantics change:
 * mergeIndividualDonorInputs used to store `{ ...input }` (a second full object
 * graph of the donor population — ~840k objects on a presidential cycle) so the
 * merge could mutate safely; it now stores by reference and mutates in place.
 *
 * These tests are the pin. Every assertion below is the OLD behavior, written
 * out longhand: longer displayName wins, first-non-empty wins per metadata
 * field, totals sum, insertion order is preserved. If a future edit changes any
 * of them, this fails — the clone's removal must be invisible to the rows that
 * reach Postgres.
 *
 * The one intended observable difference — that `inputs` elements may be
 * mutated — is asserted explicitly at the bottom so it is a documented
 * contract rather than a surprise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIndividualDonorInputs } from "./writer";
import type { IndividualDonorInput } from "./writer";

function donor(over: Partial<IndividualDonorInput> = {}): IndividualDonorInput {
  return {
    fingerprint: "SMITH, JOHN|90210",
    displayName: "SMITH, JOHN",
    city: "",
    state: "",
    zip5: "90210",
    employer: "",
    occupation: "",
    totalDonatedCents: 0,
    ...over,
  };
}

test("unique fingerprints pass through untouched, in insertion order", () => {
  const a = donor({ fingerprint: "A|1", totalDonatedCents: 100 });
  const b = donor({ fingerprint: "B|2", totalDonatedCents: 200 });
  const c = donor({ fingerprint: "C|3", totalDonatedCents: 300 });

  const merged = mergeIndividualDonorInputs([a, b, c]);

  assert.equal(merged.size, 3);
  assert.deepEqual([...merged.keys()], ["A|1", "B|2", "C|3"], "insertion order preserved");
  // The rows array is built from merged.values(), so identity matters for the
  // no-duplicate path: nothing is copied.
  assert.equal(merged.get("A|1"), a, "stored by reference, not cloned");
  assert.equal(merged.get("A|1")!.totalDonatedCents, 100, "untouched");
});

test("totals SUM across duplicates", () => {
  const merged = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", totalDonatedCents: 250 }),
    donor({ fingerprint: "X|1", totalDonatedCents: 400 }),
    donor({ fingerprint: "X|1", totalDonatedCents: 25 }),
  ]);

  assert.equal(merged.size, 1);
  assert.equal(merged.get("X|1")!.totalDonatedCents, 675);
});

test("longer displayName wins, regardless of arrival order", () => {
  const short = "SMITH, J";
  const long = "SMITH, JOHN QUINCY";

  // Longer arrives second → adopted.
  const a = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", displayName: short }),
    donor({ fingerprint: "X|1", displayName: long }),
  ]);
  assert.equal(a.get("X|1")!.displayName, long);

  // Longer arrives first → kept (strictly-greater comparison, so equal-length
  // later values do NOT replace).
  const b = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", displayName: long }),
    donor({ fingerprint: "X|1", displayName: short }),
  ]);
  assert.equal(b.get("X|1")!.displayName, long);
});

test("equal-length displayName does not replace the incumbent", () => {
  const merged = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", displayName: "SMITH, JOHN" }),
    donor({ fingerprint: "X|1", displayName: "SMITH, JANE" }), // same length
  ]);
  assert.equal(merged.get("X|1")!.displayName, "SMITH, JOHN");
});

test("first NON-EMPTY value wins for every metadata field", () => {
  const merged = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", employer: "", occupation: "", city: "", state: "", zip5: "" }),
    donor({ fingerprint: "X|1", employer: "ACME", occupation: "ENGINEER", city: "LA", state: "CA", zip5: "90210" }),
    donor({ fingerprint: "X|1", employer: "LATER", occupation: "LATER", city: "LATER", state: "NY", zip5: "10001" }),
  ]);

  const m = merged.get("X|1")!;
  assert.equal(m.employer, "ACME", "second (first non-empty) wins, third does not overwrite");
  assert.equal(m.occupation, "ENGINEER");
  assert.equal(m.city, "LA");
  assert.equal(m.state, "CA");
  assert.equal(m.zip5, "90210");
});

test("a populated field is never overwritten by a later empty one", () => {
  const merged = mergeIndividualDonorInputs([
    donor({ fingerprint: "X|1", employer: "ACME", city: "LA", state: "CA" }),
    donor({ fingerprint: "X|1", employer: "", city: "", state: "" }),
  ]);

  const m = merged.get("X|1")!;
  assert.equal(m.employer, "ACME");
  assert.equal(m.city, "LA");
  assert.equal(m.state, "CA");
});

test("fingerprint is invariant under merging — the property the caller relies on", () => {
  // fec-bulk/index.ts reads donorInputs[].fingerprint after the call (the
  // FIX-754 resume backfill). Merging must never move a fingerprint, or that
  // backfill would query for keys that were never written.
  const inputs = [
    donor({ fingerprint: "X|1", displayName: "A" }),
    donor({ fingerprint: "X|1", displayName: "LONGER NAME" }),
    donor({ fingerprint: "Y|2" }),
  ];
  const merged = mergeIndividualDonorInputs(inputs);

  for (const [key, value] of merged) {
    assert.equal(value.fingerprint, key, "map key and row fingerprint agree");
  }
  assert.deepEqual(inputs.map((i) => i.fingerprint), ["X|1", "X|1", "Y|2"], "no element's fingerprint moved");
});

test("DOCUMENTED CONTRACT: surviving input elements are mutated in place", () => {
  // This is the one intended observable change from dropping the clone. It is
  // asserted rather than merely commented so a future caller that needs
  // pristine inputs fails here instead of in production.
  const first = donor({ fingerprint: "X|1", totalDonatedCents: 100, employer: "" });
  const second = donor({ fingerprint: "X|1", totalDonatedCents: 50, employer: "ACME" });

  mergeIndividualDonorInputs([first, second]);

  assert.equal(first.totalDonatedCents, 150, "the surviving element absorbed the duplicate");
  assert.equal(first.employer, "ACME");
  assert.equal(second.totalDonatedCents, 50, "the absorbed element is left alone");
});

test("empty input yields an empty map", () => {
  assert.equal(mergeIndividualDonorInputs([]).size, 0);
});
