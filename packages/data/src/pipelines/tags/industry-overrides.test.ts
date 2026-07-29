/**
 * FIX-916 / FIX-917 — tests for the curated industry overrides.
 *
 * Covers the pure half (applyIndustryOverrides), the classifier exclusion guard
 * (selectClassifierCandidates), and the two drift alarms that keep the seeded
 * migration honest against the vocabulary and against the committed audit TSV.
 *
 * The DB half — that a second producer run reproduces the same counts rather
 * than zeroing or doubling them — is a run-twice check against local Docker, not
 * a unit test. See the FIX-916 verification block in docs/done.log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyIndustryOverrides, INDUSTRY_KEYWORDS, type IndustryOverride } from "./rules";
import { selectClassifierCandidates } from "./ai-classifier";
import { VALID_INDUSTRIES } from "./topics";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSV_PATH = join(REPO_ROOT, "docs", "audits", "2026-07-27-industry-tag-overrides.tsv");
const MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations", "20260728000000_fix916_industry_overrides.sql",
);

const ENT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ENT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ENT_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

/** A keyword/NAICS-derived row, shaped exactly as the producer emits them. */
function ruleTag(entityId: string, tag: string, category = "industry") {
  return {
    entity_type: "financial_entity",
    entity_id: entityId,
    tag,
    tag_category: category,
    display_label: tag,
    display_icon: null,
    visibility: "primary" as const,
    generated_by: "rule" as const,
    confidence: 0.8,
    pipeline_version: "v1",
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// (a) An overridden donor ends with exactly one industry tag, equal to the override
// ---------------------------------------------------------------------------

test("an overridden donor ends with exactly ONE industry tag, equal to the override", () => {
  // Real case from the audit TSV: America's Credit Unions PAC (C00007880) was
  // tagged finance+labor by the keyword rules ("credit" → finance, "union" →
  // labor) and the audit assigned it finance / credit_union.
  const computed = [ruleTag(ENT_A, "finance"), ruleTag(ENT_A, "labor")];
  const overrides: IndustryOverride[] = [
    {
      entity_id: ENT_A,
      fec_committee_id: "C00007880",
      industry: "finance",
      audited_sector: "credit_union",
      source: "audit-2026-07-27",
    },
  ];

  const out = applyIndustryOverrides(computed, overrides);
  const industry = out.filter((t) => t.tag_category === "industry");

  assert.equal(industry.length, 1, "exactly one industry tag");
  assert.equal(industry[0]?.tag, "finance");
  assert.equal(industry[0]?.generated_by, "curated");
  assert.equal(industry[0]?.confidence, 1.0);
  assert.equal(industry[0]?.visibility, "primary");
  // The two rule rows are GONE, not merely outnumbered — a surviving `labor`
  // row would still be picked up by the alphabetical DISTINCT ON tie-break on
  // eight surfaces (FIX-918).
  assert.equal(out.filter((t) => t.generated_by === "rule").length, 0);
});

test("curated metadata carries the audited sector and committee id, not just the label", () => {
  const overrides: IndustryOverride[] = [
    {
      entity_id: ENT_A,
      fec_committee_id: "C00007880",
      industry: "finance",
      audited_sector: "credit_union",
      source: "audit-2026-07-27",
    },
  ];
  const meta = applyIndustryOverrides([], overrides)[0]?.metadata as Record<string, unknown>;

  assert.equal(meta["source"], "audit-2026-07-27");
  assert.equal(meta["audited_sector"], "credit_union");
  assert.equal(meta["fec_committee_id"], "C00007880");
});

// ---------------------------------------------------------------------------
// (b) A NULL-override donor ends with ZERO industry tags even when its name
//     matches a keyword rule
// ---------------------------------------------------------------------------

test("a NULL-override donor ends with ZERO industry tags even though it trips a keyword rule", () => {
  // Real case: WINRED (C00694323) is a fundraising platform, not an industry.
  // It was tagged `lobby` before the audit, and the audit wrote NONE.
  const computed = [ruleTag(ENT_B, "lobby")];
  const overrides: IndustryOverride[] = [
    {
      entity_id: ENT_B,
      fec_committee_id: "C00694323",
      industry: null,
      audited_sector: "leadership_or_party_pac",
      source: "audit-2026-07-27",
    },
  ];

  const out = applyIndustryOverrides(computed, overrides);

  assert.equal(out.filter((t) => t.tag_category === "industry").length, 0);
  assert.equal(out.length, 0);
});

test("NULL means SUPPRESS, not omit — proven against the live keyword rules", () => {
  // The distinction only matters because the keyword pass genuinely fires on
  // these names. If it didn't, "suppress" and "omit" would be the same thing and
  // this whole branch would be untested wishful thinking. Assert that at least
  // one real de-tagged committee still matches a keyword rule today.
  const deTagged = readTsv()
    .filter((r) => r.industry === null)
    .map((r) => r.display_name.toLowerCase());

  const matches = (name: string) =>
    Object.values(INDUSTRY_KEYWORDS).some((kws) =>
      kws.some((kw) =>
        kw.length <= 4
          ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(name)
          : name.includes(kw),
      ),
    );

  const stillMatching = deTagged.filter(matches);
  assert.ok(
    stillMatching.length > 0,
    "no de-tagged committee trips a keyword rule — the suppression branch would be vacuous",
  );
});

// ---------------------------------------------------------------------------
// Non-industry categories, and non-overridden donors, are untouched
// ---------------------------------------------------------------------------

test("only the industry category is rewritten — size/pattern rows pass through", () => {
  const computed = [
    ruleTag(ENT_A, "finance"),
    ruleTag(ENT_A, "mega_donor", "size"),
  ];
  const overrides: IndustryOverride[] = [
    { entity_id: ENT_A, fec_committee_id: "C1", industry: "health", audited_sector: "hospital", source: "s" },
  ];

  const out = applyIndustryOverrides(computed, overrides);
  assert.equal(out.filter((t) => t.tag_category === "size").length, 1);
  assert.equal(out.filter((t) => t.tag_category === "industry").length, 1);
});

test("a donor with no override keeps every keyword tag it had", () => {
  const computed = [ruleTag(ENT_C, "oil_gas"), ruleTag(ENT_C, "utilities")];
  const out = applyIndustryOverrides(computed, [
    { entity_id: ENT_A, fec_committee_id: "C1", industry: "health", audited_sector: null, source: "s" },
  ]);

  const kept = out.filter((t) => t.entity_id === ENT_C);
  assert.equal(kept.length, 2, "the unaudited tail is deliberately left alone");
});

// ---------------------------------------------------------------------------
// (d) Idempotence of the pure transform
// ---------------------------------------------------------------------------

test("applying the overrides twice is a no-op — no accumulation, no doubling", () => {
  const computed = [ruleTag(ENT_A, "finance"), ruleTag(ENT_A, "labor"), ruleTag(ENT_C, "tech")];
  const overrides: IndustryOverride[] = [
    { entity_id: ENT_A, fec_committee_id: "C1", industry: "finance", audited_sector: "credit_union", source: "s" },
    { entity_id: ENT_B, fec_committee_id: "C2", industry: null, audited_sector: "pac", source: "s" },
  ];

  const once = applyIndustryOverrides(computed, overrides);
  const twice = applyIndustryOverrides(once, overrides);

  assert.deepEqual(twice, once);
  // And the (entity, tag, category) key is unique — the producer's bulk upsert
  // cannot affect the same row twice in one statement.
  const keys = once.map((t) => `${t.entity_id}|${t.tag}|${t.tag_category}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("vocabulary drift throws rather than silently dropping a curated row", () => {
  // A silent drop would leave the donor with NO tag while looking overridden —
  // indistinguishable from the NULL case, which is a real and different answer.
  assert.throws(
    () =>
      applyIndustryOverrides([], [
        { entity_id: ENT_A, fec_committee_id: "C1", industry: "crypto_mining", audited_sector: null, source: "s" },
      ]),
    /crypto_mining/,
  );
});

// ---------------------------------------------------------------------------
// (c) FIX-917 — the classifier candidate-set pin
// ---------------------------------------------------------------------------

const PAC = (id: string, name: string) => ({ id, display_name: name, total_donated_cents: 50_000_000 });

test("FIX-917: a NULL-override entity is NOT a classification candidate", () => {
  // THE test this guard exists for. The de-tagged committees have zero industry
  // tags by construction after the FIX-916 cleanup, which is exactly the shape
  // the classifier reads as "needs classifying". Remove the third argument's
  // effect and this fails.
  const allPacs = [PAC(ENT_B, "WINRED"), PAC(ENT_C, "SOME REAL TRADE PAC")];
  const alreadyTagged = new Set<string>(); // nothing tagged — the post-cleanup state
  const overridden = new Set<string>([ENT_B]);

  const candidates = selectClassifierCandidates(allPacs, alreadyTagged, overridden);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, ENT_C);
  assert.ok(
    !candidates.some((c) => c.id === ENT_B),
    "WINRED must never be re-classified — the audit de-tagged it on purpose",
  );
});

test("FIX-917: a re-assigned (non-NULL) override entity is also excluded", () => {
  // These are protected incidentally by carrying a curated tag, but the guard
  // must not depend on that — a tag-read failure would otherwise reopen them.
  const candidates = selectClassifierCandidates(
    [PAC(ENT_A, "AMERICA'S CREDIT UNIONS PAC")],
    new Set<string>(),
    new Set<string>([ENT_A]),
  );
  assert.deepEqual(candidates, []);
});

test("FIX-917: a normal untagged PAC is still a candidate — the guard is not a kill switch", () => {
  const candidates = selectClassifierCandidates(
    [PAC(ENT_C, "SOME REAL TRADE PAC")],
    new Set<string>(),
    new Set<string>(),
  );
  assert.equal(candidates.length, 1);
});

// ---------------------------------------------------------------------------
// Drift alarms — the migration vs the vocabulary, and the migration vs the TSV
// ---------------------------------------------------------------------------

type TsvRow = { fec: string; display_name: string; industry: string | null; sector: string };

function readTsv(): TsvRow[] {
  const lines = readFileSync(TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return {
      fec: c[0]!,
      display_name: c[1]!,
      industry: c[2] === "NONE" ? null : c[2]!,
      sector: c[4]!,
    };
  });
}

test("the audit TSV is the shape the migration was generated from: 742 / 380 / 362", () => {
  const rows = readTsv();
  assert.equal(rows.length, 742);
  assert.equal(rows.filter((r) => r.industry !== null).length, 380);
  assert.equal(rows.filter((r) => r.industry === null).length, 362);
  assert.equal(new Set(rows.map((r) => r.fec)).size, 742, "fec_committee_id must be unique");
});

test("every industry in the TSV is a VALID_INDUSTRIES member", () => {
  for (const r of readTsv()) {
    if (r.industry === null) continue;
    assert.ok(
      (VALID_INDUSTRIES as readonly string[]).includes(r.industry),
      `TSV row ${r.fec} carries '${r.industry}', which is not in the vocabulary`,
    );
  }
});

test("the migration's CHECK constraint mirrors VALID_INDUSTRIES exactly", () => {
  // The CHECK is generated from topics.ts. This is the drift alarm that keeps it
  // a mirror rather than a second source of truth: add a key to the vocabulary
  // without regenerating the migration and this fails.
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const m = sql.match(/CHECK \(industry IS NULL OR industry = ANY \(ARRAY\[([^\]]+)\]\)\)/);
  assert.ok(m, "could not locate the industry CHECK constraint in the migration");
  const inCheck = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...inCheck].sort(), [...VALID_INDUSTRIES].sort());
});

test("the migration seeds exactly the TSV — same ids, same industries", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string | null>();
  for (const m of sql.matchAll(/^ {2}\('(C\w+)', (NULL|'[a-z_]+')/gm)) {
    seeded.set(m[1]!, m[2] === "NULL" ? null : m[2]!.slice(1, -1));
  }

  const tsv = readTsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the TSV");
  for (const r of tsv) {
    assert.ok(seeded.has(r.fec), `TSV row ${r.fec} is missing from the migration seed`);
    assert.equal(seeded.get(r.fec), r.industry, `industry mismatch for ${r.fec}`);
  }
});

// ---------------------------------------------------------------------------
// FIX-921 — the second cohort: the oil_gas escapee sweep
//
// Same two drift alarms as the FIX-916 cohort above, against its own TSV and
// its own migration. Kept separate rather than generalised because the two
// files have different shapes: FIX-916's TSV carries a spare column (industry
// is c[2], sector is c[4]), this one does not (sector is c[3]).
// ---------------------------------------------------------------------------

const SWEEP_TSV_PATH = join(REPO_ROOT, "docs", "audits", "2026-07-28-oil-gas-escapees.tsv");
const SWEEP_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations", "20260729010000_fix921_oil_gas_escapee_sweep.sql",
);

function readSweepTsv(): TsvRow[] {
  const lines = readFileSync(SWEEP_TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return {
      fec: c[0]!,
      display_name: c[1]!,
      industry: c[2] === "NONE" ? null : c[2]!,
      sector: c[3]!,
    };
  });
}

test("FIX-921: the sweep TSV is 50 / 45 / 5, with unique committee ids", () => {
  const rows = readSweepTsv();
  assert.equal(rows.length, 50);
  assert.equal(rows.filter((r) => r.industry !== null).length, 45);
  assert.equal(rows.filter((r) => r.industry === null).length, 5);
  assert.equal(new Set(rows.map((r) => r.fec)).size, 50, "fec_committee_id must be unique");
});

test("FIX-921: every industry in the sweep TSV is a VALID_INDUSTRIES member", () => {
  for (const r of readSweepTsv()) {
    if (r.industry === null) continue;
    assert.ok(
      (VALID_INDUSTRIES as readonly string[]).includes(r.industry),
      `sweep TSV row ${r.fec} carries '${r.industry}', which is not in the vocabulary`,
    );
  }
});

test("FIX-921: the sweep migration seeds exactly its TSV", () => {
  const sql = readFileSync(SWEEP_MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string | null>();
  for (const m of sql.matchAll(/^ {2}\('(C\w+)', (NULL|'[a-z_]+')/gm)) {
    seeded.set(m[1]!, m[2] === "NULL" ? null : m[2]!.slice(1, -1));
  }

  const tsv = readSweepTsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the sweep TSV");
  for (const r of tsv) {
    assert.ok(seeded.has(r.fec), `sweep TSV row ${r.fec} is missing from the migration seed`);
    assert.equal(seeded.get(r.fec), r.industry, `industry mismatch for ${r.fec}`);
  }
});

test("FIX-921: no committee appears in BOTH cohorts", () => {
  // The sweep migration asserts a combined table of 792 rows. A committee id
  // present in both TSVs would be absorbed by ON CONFLICT DO UPDATE as an
  // UPDATE, so the table would hold 791 and the migration's own assertion would
  // fire — but it would fire with a count, not a name. This says which one.
  const first = new Set(readTsv().map((r) => r.fec));
  const overlap = readSweepTsv().filter((r) => first.has(r.fec)).map((r) => r.fec);
  assert.deepEqual(overlap, [], "a committee curated twice would silently shrink the table");
});

test("FIX-921: CNG Holdings is finance — the false positive that started this", () => {
  // Check 'n Go, a consumer lender. `oil_gas` matched it on the "CNG" initials
  // reading as compressed natural gas. Pinned by name because it is the single
  // clearest illustration of why the keyword list needed curating, and a future
  // re-audit that quietly flips it back should have to argue with a test.
  const cng = readSweepTsv().find((r) => r.fec === "C00441311");
  assert.ok(cng, "CNG Holdings (C00441311) must be in the sweep");
  assert.equal(cng!.industry, "finance");
  assert.equal(cng!.sector, "consumer_lending");
});
