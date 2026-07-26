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
import {
  buildOfficialIndustryTags,
  assertIndustryVocabulary,
  INDUSTRY_TOP_N,
  type OfficialSector,
} from "./rules";
import { VALID_INDUSTRIES } from "./topics";

const OFFICIAL_ID = "33333333-3333-3333-3333-333333333333";

const SECTORS: OfficialSector[] = [
  { industry: "finance", total_cents: 5_000_00, donor_count: 42, rank: 1 },
  { industry: "pharma", total_cents: 2_000_00, donor_count: 17, rank: 2 },
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
  assert.equal(tags[0]?.display_label, "Finance");
  assert.equal(tags[1]?.display_label, "Pharma");
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
