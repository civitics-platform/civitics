/**
 * FIX-908 — pins for the donor-industry vocabulary.
 *
 * Three things are asserted here, each guarding a failure that has already
 * happened once in this codebase:
 *
 *  1. VALID_INDUSTRIES and INDUSTRY_LABELS are key-complete in BOTH directions.
 *     A key with no label renders a blank pill; a label with no key is dead
 *     weight that reads as vocabulary. (FIX-889/890 class.)
 *  2. The drain write-boundary guard actually permits the new keys and still
 *     rejects junk. The guard reads VALID_INDUSTRIES by reference, so this is
 *     really a test that the reference has not been severed.
 *  3. The UI-layer mirror in packages/graph has not drifted. There is no
 *     dependency edge between @civitics/data and @civitics/graph, so the file is
 *     read off DISK — that is the only mechanism available, and a missing
 *     mechanism is how four copies of this vocabulary accumulated in the first
 *     place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VALID_INDUSTRIES, INDUSTRY_LABELS, industryDisplay } from "./topics";
import { INDUSTRY_KEYWORDS, NAICS_MAPS, naicsToIndustry } from "./rules";
import { checkTagVocabulary } from "../../drain/vocabulary";

test("VALID_INDUSTRIES and INDUSTRY_LABELS are key-complete in both directions", () => {
  const keys = [...VALID_INDUSTRIES].sort();
  const labelKeys = Object.keys(INDUSTRY_LABELS).sort();
  assert.deepEqual(
    labelKeys,
    keys,
    "every vocabulary key needs a label/icon and vice versa — a key with no " +
      "label renders a blank pill, a label with no key is not a real industry",
  );

  for (const k of VALID_INDUSTRIES) {
    const info = industryDisplay(k);
    assert.ok(info, `industryDisplay('${k}') must resolve`);
    assert.ok(info.label.trim().length > 0, `'${k}' must have a non-empty label`);
    assert.ok(info.icon.trim().length > 0, `'${k}' must have a non-empty icon`);
  }
});

test("the vocabulary is exactly 16 keys, including the four FIX-908 additions", () => {
  assert.equal(VALID_INDUSTRIES.length, 16);
  for (const k of ["utilities", "manufacturing", "mining", "media"] as const) {
    assert.ok(
      (VALID_INDUSTRIES as readonly string[]).includes(k),
      `'${k}' is one of the four buckets FIX-908 added to absorb the audit's ` +
        `largest error mass — it must stay in the vocabulary`,
    );
  }
});

test("`pharma` is gone — the key is `health` (FIX-908 blanket rename)", () => {
  assert.ok(!(VALID_INDUSTRIES as readonly string[]).includes("pharma"));
  assert.ok((VALID_INDUSTRIES as readonly string[]).includes("health"));
  assert.equal(INDUSTRY_LABELS.health.label, "Health Care");
});

/**
 * DECISION PIN (FIX-908 decision 4). `oil_gas` keeps its NARROW label on
 * purpose. Widening it to "Energy & Utilities" would take the tag from 40.7% to
 * 91.8% honest by dollars — the single cheapest accuracy win available — and it
 * is STILL the wrong move, because the money_vote_influence HR 26 measure needs
 * fossil-fuel money specifically and would be destroyed in the same edit. The
 * honest fix is to move the utilities OUT into the new `utilities` bucket, not
 * to relabel the tag around them.
 *
 * This assertion exists so that a future widening has to DELETE an explicit
 * statement of the reasoning rather than quietly drift past it.
 */
test("oil_gas label is still 'Oil & Gas' — do not widen it (FIX-908 decision 4)", () => {
  assert.equal(
    INDUSTRY_LABELS.oil_gas.label,
    "Oil & Gas",
    "See the comment above this test before changing it. Widening this label " +
      "breaks the money_vote_influence HR 26 measure.",
  );
});

test("the drain write-boundary guard permits every vocabulary key", () => {
  for (const k of VALID_INDUSTRIES) {
    const verdict = checkTagVocabulary("financial_entity", "industry", k);
    assert.equal(verdict.allowed, true, `'${k}' must be writable by the drain path`);
  }
});

test("the drain guard still rejects junk and the retired keys", () => {
  for (const junk of ["pharma", "energy", "pharmaceutical", "not_an_industry", ""]) {
    const verdict = checkTagVocabulary("financial_entity", "industry", junk);
    assert.equal(
      verdict.allowed,
      false,
      `'${junk}' is not in the vocabulary and must be rejected at the write boundary`,
    );
  }
});

/**
 * THE ZEROING GUARD. tagFinancialEntities does an AUTHORITATIVE rebuild: it
 * calls clear_financial_entity_rule_tags(['industry']) and then re-inserts from
 * these two maps, dropping any match whose key fails to resolve to a label
 * (`if (!info) continue`). So a key that stops resolving does not degrade
 * gracefully — it silently deletes that entire industry on the next nightly.
 *
 * This is exactly what the FIX-908 `pharma` → `health` rename would have caused
 * had INDUSTRY_KEYWORDS kept its old key: 4,919 rows, the single largest
 * industry tag, cleared and never re-inserted, with no error anywhere.
 *
 * These assertions are the durable form of the "run the tagger twice and
 * confirm identical counts, not zero" proof — they hold the invariant that
 * proof was checking, on every CI run rather than once by hand.
 */
test("every INDUSTRY_KEYWORDS key resolves — else the nightly silently zeroes that tag", () => {
  for (const key of Object.keys(INDUSTRY_KEYWORDS)) {
    assert.ok(
      (VALID_INDUSTRIES as readonly string[]).includes(key),
      `INDUSTRY_KEYWORDS key '${key}' is not in VALID_INDUSTRIES — every entity ` +
        `matching it would be dropped at insert, wiping the tag on the next ` +
        `authoritative rebuild`,
    );
    assert.ok(industryDisplay(key), `INDUSTRY_KEYWORDS key '${key}' has no label`);
  }
});

test("every NAICS mapping target resolves to a vocabulary key", () => {
  for (const [map, entries] of Object.entries(NAICS_MAPS)) {
    for (const [code, key] of Object.entries(entries)) {
      assert.ok(
        (VALID_INDUSTRIES as readonly string[]).includes(key),
        `${map}['${code}'] → '${key}' is not in VALID_INDUSTRIES`,
      );
      assert.ok(industryDisplay(key), `${map}['${code}'] → '${key}' has no label`);
    }
  }
});

/** FIX-909 decision 8 — the sector corrections, pinned by NAICS sector number. */
test("NAICS sectors map to their actual official sector (FIX-909)", () => {
  assert.equal(naicsToIndustry("221118"), "utilities",     "NAICS 22 IS Utilities");
  assert.equal(naicsToIndustry("311111"), "manufacturing", "NAICS 31 IS Manufacturing");
  assert.equal(naicsToIndustry("322121"), "manufacturing", "NAICS 32 IS Manufacturing");
  assert.equal(naicsToIndustry("332710"), "manufacturing", "NAICS 33 IS Manufacturing");
  assert.equal(naicsToIndustry("621111"), "health",        "NAICS 62 IS Health Care");
  assert.equal(naicsToIndustry("211120"), "oil_gas",       "NAICS 21 stays oil_gas — decision 4 keeps that tag narrow");

  // 3254 (Pharmaceutical and Medicine Mfg) keeps its true home even though its
  // 325 parent moved to manufacturing — the 4-digit override is checked first.
  assert.equal(naicsToIndustry("325412"), "health");
  assert.equal(naicsToIndustry("325199"), "manufacturing");

  // NAICS 56 is Administrative/Support/Waste — staffing, security and waste
  // firms, not unions. Removed rather than repointed: there is no right bucket,
  // and untagged is the honest answer.
  assert.equal(
    naicsToIndustry("561320"),
    null,
    "NAICS 56 must NOT map to labor — mapping staffing/security/waste firms to " +
      "unions is the category error FIX-909 removed",
  );
});

test("packages/graph INDUSTRY_KEYS has not drifted from VALID_INDUSTRIES", () => {
  // Read off disk: apps/civitics cannot import @civitics/data (no dependency
  // edge) so the UI layer keeps a mirror, and a mirror with no enforcement is
  // just the next copy waiting to drift.
  const mirrorPath = fileURLToPath(
    new URL("../../../../graph/src/industries.ts", import.meta.url),
  );
  const src = readFileSync(mirrorPath, "utf8");

  const block = /export const INDUSTRY_KEYS = \[([\s\S]*?)\] as const;/.exec(src);
  assert.ok(
    block,
    `could not find the INDUSTRY_KEYS array literal in ${mirrorPath} — if it was ` +
      `renamed or restructured, update this test to match`,
  );

  const mirrored = [...block[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual(
    mirrored,
    [...VALID_INDUSTRIES].sort(),
    "packages/graph/src/industries.ts INDUSTRY_KEYS must mirror VALID_INDUSTRIES " +
      "exactly. Add the key in BOTH places.",
  );
});

test("every vocabulary key has a lucide icon in the graph ICON_REGISTRY", () => {
  // Same disk-read mechanism, same reason. A vocabulary key with no icon falls
  // through to the generic Building2 fallback, which on an industry pill reads
  // as "we have no idea what this is".
  const iconsPath = fileURLToPath(
    new URL("../../../../graph/src/icons.tsx", import.meta.url),
  );
  const src = readFileSync(iconsPath, "utf8");

  const registry = /export const ICON_REGISTRY: Record<string, IconComponent> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(registry, "could not find the ICON_REGISTRY object literal in icons.tsx");

  const registered = new Set(
    [...registry[1]!.matchAll(/^\s{2}([a-z_0-9]+):\s/gm)].map((m) => m[1]!),
  );

  const missing = VALID_INDUSTRIES.filter((k) => !registered.has(k));
  assert.deepEqual(
    missing,
    [],
    `these vocabulary keys have no entry in packages/graph/src/icons.tsx ` +
      `ICON_REGISTRY and would render the generic fallback: ${missing.join(", ")}`,
  );
});
