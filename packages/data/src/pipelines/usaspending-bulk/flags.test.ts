/**
 * FIX-1274 / FIX-1291 — parseUsaSpendingFlags(): every dial, the defaults per
 * entry, and the two refusals that keep the clone-rehearsal levers off prod.
 *
 * Runs via:  tsx --test src/pipelines/usaspending-bulk/flags.test.ts
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import {
  parseUsaSpendingFlags,
  UsaSpendingFlagError,
  DEFAULT_BREATHER_S,
  DEFAULT_GATE_WAIT_S,
  MAX_WAIT_S,
} from "./flags";

test("defaults: both categories, gate 1800 s, breather 60 s, keep-archive ON standalone / OFF in CI", () => {
  const s = parseUsaSpendingFlags([], "standalone");
  assert.deepEqual(s, {
    category: "both", categories: ["contracts", "assistance"], force: false,
    maxParts: null, maxMinutes: null, gateWaitS: DEFAULT_GATE_WAIT_S, breatherS: DEFAULT_BREATHER_S,
    keepArchive: true, localArchive: null, allowProd: false,
  });
  assert.equal(DEFAULT_GATE_WAIT_S, 1800);
  assert.equal(DEFAULT_BREATHER_S, 60);

  const ci = parseUsaSpendingFlags(["--allow-prod"], "ci");
  assert.equal(ci.keepArchive, false, "CI runners are ephemeral — nothing to keep");
  assert.deepEqual(ci.categories, ["contracts", "assistance"], "the CI path keeps both");
  assert.equal(ci.allowProd, true);
});

test("every dial, in both spellings", () => {
  const f = parseUsaSpendingFlags([
    "--category", "contracts", "--max-parts", "2", "--max-minutes=240",
    "--gate-wait-s", "120", "--breather-s=5", "--no-keep-archive", "--force",
  ], "standalone");
  assert.equal(f.category, "contracts");
  assert.deepEqual(f.categories, ["contracts"]);
  assert.equal(f.maxParts, 2);
  assert.equal(f.maxMinutes, 240);
  assert.equal(f.gateWaitS, 120);
  assert.equal(f.breatherS, 5);
  assert.equal(f.keepArchive, false);
  assert.equal(f.force, true);

  // The existing assistance script's spelling.
  assert.deepEqual(parseUsaSpendingFlags(["--category=assistance"], "standalone").categories, ["assistance"]);
  // pnpm's `--` separator is passed through and ignored.
  assert.equal(parseUsaSpendingFlags(["--allow-prod", "--", "--max-minutes", "320"], "ci").maxMinutes, 320);
  // --keep-archive turns it on in CI.
  assert.equal(parseUsaSpendingFlags(["--keep-archive"], "ci").keepArchive, true);
});

test("--gate-wait-s 0 is the gate OFF — local only, refused with --allow-prod", () => {
  assert.equal(parseUsaSpendingFlags(["--gate-wait-s", "0"], "standalone").gateWaitS, 0);
  assert.throws(
    () => parseUsaSpendingFlags(["--gate-wait-s", "0", "--allow-prod"], "standalone"),
    (e: unknown) => e instanceof UsaSpendingFlagError && /local-only/.test(e.message),
  );
  assert.throws(() => parseUsaSpendingFlags(["--allow-prod", "--gate-wait-s=0"], "ci"), UsaSpendingFlagError);
});

test("--local-archive is a dev lever — refused with --allow-prod, needs ONE category, contradicts --force", () => {
  const f = parseUsaSpendingFlags(["--category", "contracts", "--local-archive", "C:/tmp/rehearsal_20261010.zip"], "standalone");
  assert.equal(f.localArchive, "C:/tmp/rehearsal_20261010.zip");
  assert.throws(
    () => parseUsaSpendingFlags(["--category", "contracts", "--local-archive", "x.zip", "--allow-prod"], "standalone"),
    (e: unknown) => e instanceof UsaSpendingFlagError && /dev lever/.test(e.message),
  );
  assert.throws(() => parseUsaSpendingFlags(["--local-archive", "x.zip"], "standalone"), /one category/);
  assert.throws(
    () => parseUsaSpendingFlags(["--category", "contracts", "--local-archive", "x.zip", "--force"], "standalone"),
    /--force/,
  );
});

test("bad values and unknown flags are errors, not silent defaults", () => {
  const bad: string[][] = [
    ["--category", "grants"],
    ["--max-parts", "0"],
    ["--max-parts", "1.5"],
    ["--max-parts"],
    ["--max-minutes", "-5"],
    ["--max-minutes", "abc"],
    ["--gate-wait-s", String(MAX_WAIT_S + 1)],   // a wait past the reaper's 60 min
    ["--breather-s", "-1"],
    ["--categroy", "contracts"],                 // the typo that would run BOTH on prod
    ["contracts"],
    ["--keep-archive", "--no-keep-archive"],
  ];
  for (const argv of bad) {
    assert.throws(() => parseUsaSpendingFlags(argv, "standalone"), UsaSpendingFlagError, argv.join(" "));
  }
  assert.ok(MAX_WAIT_S < 3600, "both waits stay under reap_stale_sync_log's 60-minute rule");
});
