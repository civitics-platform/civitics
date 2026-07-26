/**
 * FIX-896 — regression tests for the official-tagging retirement at the drain
 * write boundary.
 *
 * The retirement rests on ONE non-obvious property of `checkTagVocabulary`:
 * it FAILS OPEN for unregistered entity types. So `official: {}` and
 * `delete TAG_VOCABULARY.official` are NOT equivalent — the first rejects every
 * official tag, the second silently re-permits exactly the writes the
 * retirement exists to stop, and the two look identical until someone audits
 * row counts.
 *
 * These tests pin BOTH halves of that: officials are rejected, AND the
 * fail-open they'd have inherited from a deleted key still works for a genuinely
 * unregistered type. A test that only asserted "officials are rejected" would
 * pass just as happily against a guard that had been changed to fail closed
 * globally — which would be a different (and breaking) change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTagVocabulary, TAG_VOCABULARY } from "./vocabulary";
import { ISSUE_AREAS } from "../pipelines/tags/topics";

test("official is REGISTERED with an empty category map — not deleted", () => {
  // The structural assertion. If someone "cleans up" by deleting the key, this
  // fails before any behavioural test gets a chance to mislead.
  assert.ok(
    Object.prototype.hasOwnProperty.call(TAG_VOCABULARY, "official"),
    "TAG_VOCABULARY.official must exist — deleting it makes officials fail OPEN",
  );
  assert.deepEqual(TAG_VOCABULARY["official"], {});
});

test("an official topic tag is rejected, with a reason naming the empty valid set", () => {
  // The exact shape the retired classifier used to emit.
  const verdict = checkTagVocabulary("official", "topic", "healthcare");

  assert.equal(verdict.allowed, false);
  assert.match(
    verdict.allowed === false ? verdict.reason : "",
    /empty tag vocabulary/,
    "rejection reason must say the valid set is empty, not print '(valid: )'",
  );
  assert.match(verdict.allowed === false ? verdict.reason : "", /official/);
});

test("EVERY former issue-area is now rejected for officials", () => {
  // Not just a sample: the whole retired vocabulary, so a partial re-permit
  // (e.g. someone re-adding one category) can't slip through.
  for (const area of ISSUE_AREAS) {
    const verdict = checkTagVocabulary("official", "topic", area);
    assert.equal(verdict.allowed, false, `official/topic/${area} must be rejected`);
  }
});

test("no tag_category is writable to an official — not just 'topic'", () => {
  // Industry labels for officials are written by tagOfficials() over direct pg
  // (FIX-897), never through this guard. Nothing may reach an official here.
  for (const category of ["topic", "industry", "pattern", "quality", "size"]) {
    const verdict = checkTagVocabulary("official", category, "finance");
    assert.equal(verdict.allowed, false, `official/${category} must be rejected`);
  }
});

test("rejection comes from official: {} — an UNREGISTERED type still fails OPEN", () => {
  // The control. This is what officials would do if the key had been deleted,
  // and it proves the previous tests measure the empty map rather than a guard
  // that started failing closed for everything.
  const unregistered = checkTagVocabulary("agency", "topic", "healthcare");
  assert.equal(unregistered.allowed, true);

  assert.equal(
    Object.prototype.hasOwnProperty.call(TAG_VOCABULARY, "agency"),
    false,
    "this control test is only meaningful while 'agency' is unregistered",
  );
});

test("proposal and financial_entity vocabularies are unaffected", () => {
  assert.equal(checkTagVocabulary("proposal", "topic", "climate").allowed, true);
  assert.equal(checkTagVocabulary("proposal", "quality", "technical").allowed, true);
  assert.equal(checkTagVocabulary("financial_entity", "industry", "pharma").allowed, true);
});
