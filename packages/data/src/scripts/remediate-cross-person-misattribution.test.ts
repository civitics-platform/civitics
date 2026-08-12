/**
 * FIX-964 — the advertised resume path has to be usable after the commit it
 * exists to resume.
 *
 * Runs via:  tsx --test src/scripts/remediate-cross-person-misattribution.test.ts
 *
 * The surfacing case (prod, 2026-08-05, prompt-39 / FIX-934 apply):
 * refresh_treemap_individuals_global() blew its 2400s budget mid-tail and the
 * script printed "Resume with --rollups-only". That mode re-ran the FIX-930
 * SUSPECT_SQL derivation, which post-commit finds 0 CROSS suspects — the
 * deletes already happened — and exited "Nothing to remediate" WITHOUT running
 * a single rollup step. `--vacuum-only` and `--mvs-only` were immune only
 * because they short-circuit before the derivation.
 *
 * The property under test is therefore narrow and exact: which modes derive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOfficialsArg, selectMode } from "./remediate-cross-person-misattribution";

const UUID_A = "0f9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

test("FIX-964 --rollups-only no longer re-derives the manifest", () => {
  const s = selectMode(["--rollups-only"]);
  assert.equal(s.mode, "rollups-only");
  assert.equal(s.derives, false, "deriving post-commit finds 0 suspects and exits before the rollups");
  assert.equal(s.apply, true);
});

test("FIX-964 --vacuum-only / --mvs-only are unchanged (already immune)", () => {
  for (const flag of ["--vacuum-only", "--mvs-only"] as const) {
    const s = selectMode([flag]);
    assert.equal(s.mode, flag.slice(2));
    assert.equal(s.derives, false);
    assert.equal(s.apply, true);
  }
});

test("the full path still derives, and only commits with --apply", () => {
  const dry = selectMode([]);
  assert.equal(dry.mode, "full");
  assert.equal(dry.derives, true);
  assert.equal(dry.apply, false);

  const applied = selectMode(["--apply"]);
  assert.equal(applied.mode, "full");
  assert.equal(applied.derives, true);
  assert.equal(applied.apply, true);
});

test("mode precedence is stable when flags are combined", () => {
  // vacuum is the narrowest step and wins; nothing derives either way.
  assert.equal(selectMode(["--rollups-only", "--vacuum-only"]).mode, "vacuum-only");
  assert.equal(selectMode(["--rollups-only", "--mvs-only"]).mode, "mvs-only");
  assert.equal(selectMode(["--apply", "--rollups-only"]).derives, false);
});

test("--officials parses comma lists and repeats, deduped", () => {
  assert.deepEqual(parseOfficialsArg(["--officials", `${UUID_A},${UUID_B}`]), [UUID_A, UUID_B]);
  assert.deepEqual(parseOfficialsArg([`--officials=${UUID_A}`, "--officials", UUID_B]), [UUID_A, UUID_B]);
  assert.deepEqual(parseOfficialsArg(["--officials", `${UUID_A}, ${UUID_A}`]), [UUID_A]);
  assert.deepEqual(parseOfficialsArg(["--rollups-only"]), []);
});

test("--officials refuses non-UUID input rather than silently scoping to nothing", () => {
  assert.throws(() => parseOfficialsArg(["--officials", "not-a-uuid"]), /non-UUID/);
  assert.throws(() => parseOfficialsArg(["--officials", `${UUID_A},oops`]), /oops/);
});
