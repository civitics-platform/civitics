/**
 * FIX-897 — tests for the derived official industry labels.
 *
 * Covers the pure half of the block (row shape, visibility-by-rank, auditable
 * metadata, vocabulary guard). The DB half — the ranked, paginated read of
 * official_sector_affinity_rollup — is exercised against local Docker by
 * running tagOfficials(); the property that matters there (industry rows
 * survive the authoritative DELETE) is a run-twice check, not a unit test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildOfficialIndustryTags,
  assertIndustryVocabulary,
  partitionSectorRowsByVocabulary,
  formatSectorVocabularyWarning,
  INDUSTRY_TOP_N,
  type OfficialSector,
} from "./rules";
import { VALID_INDUSTRIES } from "./topics";

const OFFICIAL_ID = "33333333-3333-3333-3333-333333333333";

const SECTORS: OfficialSector[] = [
  { industry: "finance", total_cents: 5_000_00, donor_count: 42, rank: 1 },
  { industry: "health", total_cents: 2_000_00, donor_count: 17, rank: 2 },
  { industry: "oil_gas", total_cents: 1_000_00, donor_count: 5, rank: 3 },
];

test("rank 1 is primary, the rest secondary", () => {
  const tags = buildOfficialIndustryTags(OFFICIAL_ID, SECTORS);

  assert.equal(tags.length, 3);
  assert.equal(tags[0]?.visibility, "primary");
  assert.equal(tags[1]?.visibility, "secondary");
  assert.equal(tags[2]?.visibility, "secondary");
  // Exactly one primary — more than one would fight for EntityTags' 3 tier-1
  // slots against the pattern tags that already live there.
  assert.equal(tags.filter((t) => t.visibility === "primary").length, 1);
});

test("rows mirror the rule-tag contract: rule-generated, confidence 1.0, industry category", () => {
  const tags = buildOfficialIndustryTags(OFFICIAL_ID, SECTORS);

  for (const t of tags) {
    assert.equal(t.entity_type, "official");
    assert.equal(t.entity_id, OFFICIAL_ID);
    assert.equal(t.tag_category, "industry");
    assert.equal(t.generated_by, "rule");
    // 1.0 because it's derived, not inferred. The AI path this replaces let the
    // model self-report confidence and then gated visibility on it (FIX-896).
    assert.equal(t.confidence, 1.0);
  }
});

test("every tag carries a non-null display label and icon", () => {
  const tags = buildOfficialIndustryTags(OFFICIAL_ID, SECTORS);

  for (const t of tags) {
    assert.ok(t.display_label, `null display_label for ${t.tag}`);
    assert.ok(t.display_icon, `null display_icon for ${t.tag}`);
  }
  // FIX-908 widened these labels; `oil_gas` is pinned narrow on purpose (see
  // the decision-4 pin in industry-vocabulary.test.ts).
  assert.equal(tags[0]?.display_label, "Finance & Insurance");
  assert.equal(tags[1]?.display_label, "Health Care");
  assert.equal(tags[2]?.display_label, "Oil & Gas");
});

test("metadata carries the auditable number behind the label", () => {
  const tags = buildOfficialIndustryTags(OFFICIAL_ID, SECTORS);
  const meta = tags[0]?.metadata as Record<string, unknown>;

  assert.equal(meta["rank"], 1);
  assert.equal(meta["total_cents"], 5_000_00);
  assert.equal(meta["donor_count"], 42);
  // Load-bearing wording: sector affinity is donation-scoped by design
  // (FIX-872) and excludes independent expenditures, so the label must never
  // imply total money raised.
  assert.equal(meta["source"], "donations");
});

test("every VALID_INDUSTRIES member resolves to a label — no null-labelled pill is reachable", () => {
  // The vocabulary and the label table are two separate lists in two files.
  // This is what stops them drifting apart silently.
  const tags = buildOfficialIndustryTags(
    OFFICIAL_ID,
    VALID_INDUSTRIES.map((industry, i) => ({
      industry,
      total_cents: 1000,
      donor_count: 1,
      rank: i + 1,
    })),
  );

  assert.equal(tags.length, VALID_INDUSTRIES.length);
  for (const t of tags) {
    assert.ok(t.display_label, `${t.tag} has no label`);
    assert.ok(t.display_icon, `${t.tag} has no icon`);
  }
});

test("assertIndustryVocabulary accepts the real vocabulary", () => {
  assert.doesNotThrow(() => assertIndustryVocabulary([...VALID_INDUSTRIES]));
});

test("assertIndustryVocabulary throws on an unregistered slug, naming it", () => {
  assert.throws(
    () => assertIndustryVocabulary(["finance", "crypto_mining"]),
    /crypto_mining/,
  );
});

test("'Untagged' is NOT a valid industry — it is the absence of one", () => {
  // The rollup's bucket for donors carrying no industry tag (4,174 of 4,326
  // officials on prod). It is excluded in SQL before the assert ever sees it;
  // this pins that it would throw rather than render a meaningless pill if that
  // filter were ever dropped.
  assert.throws(() => assertIndustryVocabulary(["Untagged"]), /Untagged/);
});

test("an unlabellable official produces zero rows, not an empty pill", () => {
  // OfficialCard guards on tags.length > 0, so [] renders no container at all.
  assert.deepEqual(buildOfficialIndustryTags(OFFICIAL_ID, []), []);
});

test("INDUSTRY_TOP_N is 3 — matches the EntityTags tier-1 budget", () => {
  assert.equal(INDUSTRY_TOP_N, 3);
});

// ---------------------------------------------------------------------------
// FIX-920 — the officials-side read must not be able to halt the nightly
//
// THE FAILURE THESE PIN. tagOfficials() used to call assertIndustryVocabulary()
// on the rollup read, which THROWS. official_sector_affinity_rollup.industry is
// an unconstrained text mirror of whatever the donor taggers wrote, so a single
// junk donor tag reaching rank <= 3 for ONE official took down the entire
// nightly official tagger for all ~27k officials — tenure, voting-pattern and
// donor-profile tags included, none of which have anything to do with
// industries. Prod was safe only by margin: the 8 `other` rows existed but
// happened to sit at rank > 3 for every official they touched.
//
// The guard-removal proof (the FIX-917 convention): replace the
// partitionSectorRowsByVocabulary() call in tagOfficials() with the old
// `assertIndustryVocabulary(sectorRows.map(r => r.industry))` and re-run
// `pnpm --filter @civitics/data test` — the three tests below fail and nothing
// else does.
// ---------------------------------------------------------------------------

/** A rollup row, shaped exactly as tagOfficials()'s SQL read returns them. */
function rollupRow(industry: string, rank: number) {
  return {
    official_id: OFFICIAL_ID,
    industry,
    total_cents: "500000",
    donor_count: "7",
    rank: String(rank),
  };
}

test("FIX-920: an out-of-vocabulary industry at rank<=3 is SKIPPED, not thrown on", () => {
  // `other` is the real case — ai-classifier.ts wrote 8 of them to prod. Rank 2
  // puts it squarely inside the band tagOfficials() reads, which is the only
  // band that could ever have triggered the halt.
  const rows = [rollupRow("finance", 1), rollupRow("other", 2), rollupRow("health", 3)];

  const { kept, skipped } = partitionSectorRowsByVocabulary(rows);

  assert.deepEqual(kept.map((r) => r.industry), ["finance", "health"]);
  assert.equal(skipped.get("other"), 1);
  // The whole point: the two good pills still write. A missing pill is the right
  // failure for a rendering path; a dead nightly is not.
  assert.equal(kept.length, 2);
});

test("FIX-920: the skip is COUNTED and the warning names the offending key", () => {
  const rows = [
    rollupRow("finance", 1),
    rollupRow("other", 2),
    rollupRow("other", 3),
    rollupRow("crypto_mining", 1),
  ];

  const { skipped } = partitionSectorRowsByVocabulary(rows);
  assert.equal(skipped.get("other"), 2);
  assert.equal(skipped.get("crypto_mining"), 1);

  // A bare count would be unactionable — the warning has to say WHICH key so the
  // reader can go find the tagger that emitted it.
  const warning = formatSectorVocabularyWarning(skipped);
  assert.match(warning, /other \(2 rows\)/);
  assert.match(warning, /crypto_mining \(1 row\)/);
  assert.match(warning, /SKIPPED 3/);
});

test("FIX-920: a clean rollup is passed through untouched, with no warning", () => {
  // The guard must not be a kill switch — same shape as FIX-917's third case.
  const rows = [...VALID_INDUSTRIES].map((ind, i) => rollupRow(ind, i + 1));

  const { kept, skipped } = partitionSectorRowsByVocabulary(rows);

  assert.equal(kept.length, VALID_INDUSTRIES.length);
  assert.equal(skipped.size, 0);
  assert.deepEqual(kept.map((r) => r.industry), [...VALID_INDUSTRIES]);
});

test("FIX-920: 'Untagged' is skipped too if the SQL filter is ever dropped", () => {
  // Belt-and-braces. tagOfficials() excludes it in SQL; if that filter went
  // away, the rollup's absence-of-industry sentinel must degrade to a skipped
  // row rather than a thrown nightly.
  const { kept, skipped } = partitionSectorRowsByVocabulary([rollupRow("Untagged", 1)]);
  assert.equal(kept.length, 0);
  assert.equal(skipped.get("Untagged"), 1);
});

test("FIX-920: tagOfficials() is WIRED to the soft guard, not the throwing one", () => {
  // The tests above pin what partitionSectorRowsByVocabulary DOES. This pins
  // that tagOfficials() actually calls it — without this, swapping the call site
  // back to assertIndustryVocabulary() would restore the halt while every test
  // above kept passing, because the extracted function would still exist and
  // still behave. Same read-the-source-off-disk convention as
  // industry-overrides.test.ts (migration vs TSV) and industry-vocabulary.test.ts
  // (packages/graph key list).
  const src = readFileSync(join(__dirname, "rules.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function tagOfficials"));

  assert.ok(
    body.includes("partitionSectorRowsByVocabulary(sectorRows)"),
    "tagOfficials() must partition the rollup read through the soft vocabulary guard",
  );
  assert.ok(
    !/assertIndustryVocabulary\(\s*sectorRows/.test(body),
    "tagOfficials() must NOT assert-and-throw on the rollup read — that is the FIX-920 halt",
  );
});

test("FIX-920: assertIndustryVocabulary still THROWS — the donor side is unchanged", () => {
  // The two call sites have opposite correct failure modes and this pins that
  // the soft officials-side read did not soften the donor side with it.
  // applyIndustryOverrides() reads a CHECK-constrained table where an
  // out-of-vocabulary value is impossible-by-construction, so it means real
  // drift and a silent drop would be indistinguishable from the deliberate NULL
  // "no industry, ever" case.
  assert.throws(() => assertIndustryVocabulary(["other"]), /other/);
});
