/**
 * FIX-1197 — the canary's condition keys, censused against the source.
 *
 * SOURCE-SCAN, not import. The keys are not a list anywhere in the running
 * program: they are first arguments at nineteen `push(` call sites in four
 * shapes. A test that imported a list would be testing the list.
 *
 * Both directions are asserted, and the asymmetry matters. "Every key the
 * source emits is in the registry" catches a key added without being declared —
 * which is the case cc-133 §7(a) found nothing catching. "Every registry entry
 * is emitted by the source" catches the opposite drift: a key deleted from the
 * detector and left standing here, which would make the registry read as a
 * census of conditions that can no longer occur.
 *
 * The last test is the one that proves the rest: a synthetic source carrying an
 * undeclared `push("made_up_key", …)` must FAIL. Without it a scan that silently
 * returned nothing would satisfy every assertion above.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CONDITION_KEYS,
  CONDITION_KEY_PREFIXES,
  PUSH_DEFINITION,
  extractPushedKeys,
} from "./canary-keys";
import { KEY_DISPATCH_REFUSED, KEY_DISPATCH_STALE } from "./canary-gha-dispatch";
import { KEY_FRONT_DOOR_BLIND } from "./canary-front-door";
import { KEY_BLIND, KEY_MISSING, KEY_UNCOLLECTED } from "./canary-fec-drop";
import { KEY_HOLD_STALE, KEY_LABEL_STALE, KEY_OVERRUN, KEY_READ_FAILED } from "./canary-prod-session";
import { KEY_MEM_STALE, KEY_PROBE_STALE } from "./canary-box-health";

const SRC = readFileSync(fileURLToPath(new URL("./canary-check.ts", import.meta.url)), "utf8");

/**
 * Constant NAME → its value, so a `push(KEY_FOO, …)` can be checked against a
 * registry that holds values.
 *
 * Itself audited below: a new `KEY_*` in canary-check.ts that is not in here
 * fails by name rather than being quietly skipped, which is what a scan that
 * dropped what it could not resolve would do.
 */
const CONSTANTS: Record<string, string> = {
  KEY_DISPATCH_REFUSED,
  KEY_DISPATCH_STALE,
  KEY_FRONT_DOOR_BLIND,
  KEY_OVERRUN,
  KEY_LABEL_STALE,
  KEY_HOLD_STALE,
  KEY_READ_FAILED,
  KEY_UNCOLLECTED,
  KEY_BLIND,
  KEY_MISSING,
  KEY_PROBE_STALE,
  KEY_MEM_STALE,
};

/** The scan, resolved to keys and prefixes. Throws on anything it cannot place. */
function censusOf(src: string): { keys: Set<string>; prefixes: Set<string> } {
  const keys = new Set<string>();
  const prefixes = new Set<string>();
  const problems: string[] = [];
  for (const f of extractPushedKeys(src)) {
    if (f.kind === "literal") keys.add(f.value);
    else if (f.kind === "prefix") prefixes.add(f.value);
    else if (f.kind === "constant") {
      const v = CONSTANTS[f.value];
      if (v === undefined) {
        problems.push(
          `${f.value} is pushed as a condition key but is not in CONSTANTS in ` +
            `canary-keys.test.ts. Import it there so its VALUE can be checked against ` +
            `CONDITION_KEYS — the registry holds values, the source holds names.`,
        );
      } else keys.add(v);
    } else {
      problems.push(
        `the first argument at offset ${f.at} (${f.value}…) is not a literal, a template, ` +
          `or a KEY_* constant, and extractPushedKeys could not resolve it. Teach the ` +
          `extractor the new shape rather than letting the census skip it.`,
      );
    }
  }
  assert.deepEqual(problems, [], problems.join("\n\n"));
  return { keys, prefixes };
}

test("the scan finds every push() call site — 19 today, none unresolved", () => {
  // A guard on the guard. If the anchor or the call shape drifts, every
  // assertion below passes over an empty set and measures nothing.
  const found = extractPushedKeys(SRC);
  assert.ok(found.length >= 19, `only ${found.length} push() call sites found`);
  assert.deepEqual(
    found.filter((f) => f.kind === "unresolved"),
    [],
    "extractPushedKeys could not resolve a first argument — see the values above",
  );
});

test("the scan excludes Array.prototype.push above the definition", () => {
  // canary-check.ts calls .push() about forty times before `const push =` is
  // even declared (parts, sections, failures, out). A scan from the top would
  // collect those, and would then "pass" a registry that listed none of them.
  const before = SRC.slice(0, SRC.indexOf(PUSH_DEFINITION));
  assert.ok(before.split(".push(").length - 1 > 20, "fixture assumption: many .push() above");
  const found = extractPushedKeys(SRC);
  const head = SRC.indexOf(PUSH_DEFINITION);
  assert.ok(found.every((f) => f.at > head), "a key was collected from above the definition");
});

test("every key the source emits is in the registry", () => {
  const { keys, prefixes } = censusOf(SRC);
  const missingKeys = [...keys].filter((k) => !CONDITION_KEYS.includes(k));
  const missingPrefixes = [...prefixes].filter((p) => !CONDITION_KEY_PREFIXES.includes(p));
  assert.deepEqual(
    missingKeys,
    [],
    `canary-check.ts pushes ${missingKeys.join(", ")}, which CONDITION_KEYS does not ` +
      `declare. A condition key is the identity the FIX-1036 transition classifier keys ` +
      `on, so an undeclared one is a condition nothing can be said about.`,
  );
  assert.deepEqual(
    missingPrefixes,
    [],
    `canary-check.ts pushes the family ${missingPrefixes.join(", ")}, which ` +
      `CONDITION_KEY_PREFIXES does not declare.`,
  );
});

test("every registry entry is still emitted by the source — no dead keys", () => {
  const { keys, prefixes } = censusOf(SRC);
  const deadKeys = CONDITION_KEYS.filter((k) => !keys.has(k));
  const deadPrefixes = CONDITION_KEY_PREFIXES.filter((p) => !prefixes.has(p));
  assert.deepEqual(
    deadKeys,
    [],
    `CONDITION_KEYS declares ${deadKeys.join(", ")}, which canary-check.ts no longer ` +
      `pushes. A registry carrying keys the detector cannot emit is a census of ` +
      `conditions that can no longer occur.`,
  );
  assert.deepEqual(deadPrefixes, [], `CONDITION_KEY_PREFIXES declares dead ${deadPrefixes.join(", ")}`);
});

test("cron_startup_burst is a FLAT key, deliberately not a prefix family", () => {
  // Its natural suffix is the hourly bucket timestamp, which changes every run
  // by construction — keying on it would make every burst permanently `new` and
  // page nightly, the exact defect FIX-1036 fixed. Pinned because "add the
  // suffix for consistency" is the obvious wrong move here.
  assert.ok(CONDITION_KEYS.includes("cron_startup_burst"));
  assert.ok(!CONDITION_KEY_PREFIXES.some((p) => p.startsWith("cron_startup_burst")));
});

test("the fec-drop three-way resolves to all THREE of its keys", () => {
  // `push(key, …)` where `key` is assigned from a three-way ternary above the
  // call. A census that read only the identifier would register one key (or
  // none) and leave two able to appear with nothing declaring them.
  const { keys } = censusOf(SRC);
  for (const k of [KEY_UNCOLLECTED, KEY_BLIND, KEY_MISSING]) assert.ok(keys.has(k), k);
});

test("the prod-session ternary resolves to BOTH of its keys", () => {
  const { keys } = censusOf(SRC);
  assert.ok(keys.has(KEY_OVERRUN));
  assert.ok(keys.has(KEY_LABEL_STALE));
});

test("an undeclared key in the source FAILS the census — the red case", () => {
  // The test that proves the test. A synthetic source with one extra push()
  // must be rejected by exactly the assertion the real source passes.
  const synthetic =
    SRC.slice(0, SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length) +
    '\n  push("made_up_key", "report", 1, "synthetic");' +
    SRC.slice(SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length);

  const { keys } = censusOf(synthetic);
  assert.ok(keys.has("made_up_key"), "the extractor must SEE the synthetic key");
  assert.ok(
    !CONDITION_KEYS.includes("made_up_key"),
    "the registry must NOT contain it — otherwise this proves nothing",
  );

  // And the real assertion, run against the synthetic source, must throw.
  assert.throws(
    () => {
      const missing = [...keys].filter((k) => !CONDITION_KEYS.includes(k));
      assert.deepEqual(missing, []);
    },
    /made_up_key/,
    "the census passed a source carrying an undeclared key",
  );
});

test("an undeclared PREFIX family fails the same way", () => {
  const synthetic =
    SRC.slice(0, SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length) +
    "\n  push(`made_up_family:${x}`, \"report\", 1, \"synthetic\");" +
    SRC.slice(SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length);

  const { prefixes } = censusOf(synthetic);
  assert.ok(prefixes.has("made_up_family:"));
  assert.ok(!CONDITION_KEY_PREFIXES.includes("made_up_family:"));
});

test("a new KEY_* constant with no entry in CONSTANTS fails by NAME", () => {
  // The third way a key can be added: as an imported constant. The census
  // cannot resolve its value without an import, so it must say which constant
  // rather than silently registering nothing.
  const synthetic =
    SRC.slice(0, SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length) +
    '\n  push(KEY_BRAND_NEW, "escalate", 1, "synthetic");' +
    SRC.slice(SRC.indexOf(PUSH_DEFINITION) + PUSH_DEFINITION.length);

  assert.throws(() => censusOf(synthetic), /KEY_BRAND_NEW/);
});
