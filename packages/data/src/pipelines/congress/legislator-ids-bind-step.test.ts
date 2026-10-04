/**
 * FIX-1189 O1 — the nightly bind step's switch and its write's statement.
 *
 * Runs via:  tsx --test src/pipelines/congress/legislator-ids-bind-step.test.ts
 *
 * The flag-unset path is the one Monday's nightly takes, so it is the one that
 * must be provably inert: it returns before any read, and in particular before
 * `startSync` (which would insert a data_sync_log row). The test runs with no
 * database at all — if the disabled path touched one, it would throw here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIND_SQL,
  LEGISLATOR_IDS_BIND_ENV,
  actedFrom,
  isLegislatorIdsBindEnabled,
  runLegislatorIdBindStep,
} from "./legislator-ids-report";
import type { BindingWrite } from "./legislator-ids";

test("O1 switch: only the literal \"1\" enables the writer", () => {
  assert.equal(isLegislatorIdsBindEnabled({}), false);
  assert.equal(isLegislatorIdsBindEnabled({ [LEGISLATOR_IDS_BIND_ENV]: "" }), false);
  assert.equal(isLegislatorIdsBindEnabled({ [LEGISLATOR_IDS_BIND_ENV]: "true" }), false);
  assert.equal(isLegislatorIdsBindEnabled({ [LEGISLATOR_IDS_BIND_ENV]: "0" }), false);
  assert.equal(isLegislatorIdsBindEnabled({ [LEGISLATOR_IDS_BIND_ENV]: "1" }), true);
});

test("O1 step, flag unset: `disabled`, and it returns before any read or write — held or not", async () => {
  for (const writersRun of [true, false]) {
    const r = await runLegislatorIdBindStep({ writersRun, holdReason: "prod session held: x", env: {} });
    assert.equal(r.status, "skipped");
    assert.match(r.reason ?? "", /^disabled — CIVITICS_LEGISLATOR_IDS_BIND unset$/);
  }
});

test("O1 acted: a planned row the UPDATE did not return is refused_changed, never counted as written", () => {
  const plans: BindingWrite[] = [
    { official_id: "a", kind: "bind", expect_live: null, set_live: "S1", add_prior: [] },
    { official_id: "b", kind: "promote", expect_live: "H1", set_live: "S2", add_prior: ["H1"] },
    { official_id: "c", kind: "prior_append", expect_live: "S3", set_live: null, add_prior: ["H3"] },
    { official_id: "d", kind: "prior_append", expect_live: "S4", set_live: null, add_prior: ["H4"] },
  ];
  assert.deepEqual(actedFrom(plans, new Set(["a", "b", "c"])), {
    bound: 1, promoted: 1, prior_appended: 1, refused_changed: 1,
  });
  assert.deepEqual(actedFrom(plans, new Set()), { bound: 0, promoted: 0, prior_appended: 0, refused_changed: 4 });
});

test("O1 BIND_SQL: the current live id is asserted, and nothing is written through jsonb_set", () => {
  assert.match(BIND_SQL, /o\.source_ids->>'fec_candidate_id' IS NOT DISTINCT FROM p\.expect_live/);
  assert.match(BIND_SQL, /RETURNING o\.id::text AS id/);
  // jsonb_set(x, path, NULL) is NULL — one NULL set_live would wipe source_ids.
  assert.doesNotMatch(BIND_SQL, /jsonb_set\s*\(/);
});
