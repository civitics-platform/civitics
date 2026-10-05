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

// ---------------------------------------------------------------------------
// FIX-922 — the uuid-keyed arm: an override for a donor with NO committee id.
//
// The FIX-916 table is keyed on fec_committee_id PRIMARY KEY, which silently
// excludes every donor that is not an FEC committee. Measured on prod
// 2026-09-20 that is 4 donating, industry-tagged donors worth $416,500, two of
// them oil_gas escapees of exactly the kind the FIX-921 cohort above swept —
// and unreachable by it.
//
// The DB half (the CHECK and the partial unique actually firing, and the
// reader resolving both arms) is a rolled-back transaction against local
// Docker, recorded in the FIX-922 verification block. What is pinned here is
// the shape the migration and the reader must keep.
// ---------------------------------------------------------------------------

const FIX922_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations",
  "20260920060000_fix922_industry_override_financial_entity_id.sql",
);
const RULES_PATH = join(__dirname, "rules.ts");

// The two prod escapees, by financial_entities.id.
const RIDGE_COAL = "a222d616-0487-48ac-af68-0ec7eca301ba";
const CUMBERLAND = "8a1e3c6f-03b1-46d0-9f61-42693de6f154";

test("FIX-922: a uuid-keyed override carries its synthetic key into the tag metadata", () => {
  // The applier is key-agnostic — it joins on entity_id — so what this pins is
  // that the PROVENANCE reaching entity_tags.metadata distinguishes a
  // uuid-keyed curation ('fe:<uuid>') from a committee-keyed one ('C…'). A
  // reader of the tag would otherwise have no way to tell which arm wrote it.
  const overrides: IndustryOverride[] = [
    {
      entity_id: RIDGE_COAL,
      fec_committee_id: `fe:${RIDGE_COAL}`,
      industry: "mining",
      audited_sector: "coal",
      source: "fix922",
    },
  ];
  const out = applyIndustryOverrides([ruleTag(RIDGE_COAL, "oil_gas")], overrides);
  const industry = out.filter((t) => t.tag_category === "industry");

  assert.equal(industry.length, 1);
  assert.equal(industry[0]?.tag, "mining");
  assert.equal(industry[0]?.generated_by, "curated");
  assert.equal(
    (industry[0]?.metadata as Record<string, unknown>)["fec_committee_id"],
    `fe:${RIDGE_COAL}`,
  );
  // The keyword row it displaced is gone, not merely outnumbered.
  assert.equal(out.filter((t) => t.generated_by === "rule").length, 0);
});

test("FIX-922: a NULL uuid-keyed override de-tags, exactly like a committee-keyed one", () => {
  // Both escapees are oil_gas today and the likely curation is NONE (neither is
  // an industry). NULL must SUPPRESS, not merely omit — the FIX-916 contract.
  const overrides: IndustryOverride[] = [
    { entity_id: RIDGE_COAL, fec_committee_id: `fe:${RIDGE_COAL}`, industry: null, audited_sector: "trust", source: "fix922" },
    { entity_id: CUMBERLAND, fec_committee_id: `fe:${CUMBERLAND}`, industry: null, audited_sector: "leadership_or_party_pac", source: "fix922" },
  ];
  const out = applyIndustryOverrides(
    [ruleTag(RIDGE_COAL, "oil_gas"), ruleTag(CUMBERLAND, "oil_gas"), ruleTag(ENT_C, "oil_gas")],
    overrides,
  );
  const industry = out.filter((t) => t.tag_category === "industry");
  assert.equal(industry.length, 1, "only the un-overridden donor keeps its tag");
  assert.equal(industry[0]?.entity_id, ENT_C);
});

test("FIX-922: the migration's CHECK makes the synthetic key and the uuid mutually derivable", () => {
  // A prefix-only rule ('fe:%') would accept 'fe:<some other uuid>', i.e. a row
  // whose primary key names one entity and whose uuid column names another.
  // Drift alarm: weaken the constraint and this fails.
  const sql = readFileSync(FIX922_MIGRATION_PATH, "utf8");
  assert.ok(
    /financial_entity_id IS NULL\s+AND fec_committee_id NOT LIKE 'fe:%'/.test(sql),
    "the committee arm must forbid the 'fe:' prefix",
  );
  assert.ok(
    /financial_entity_id IS NOT NULL\s+AND fec_committee_id = 'fe:' \|\| financial_entity_id::text/.test(sql),
    "the uuid arm must pin the key to 'fe:' || the uuid, not merely to the prefix",
  );
  assert.ok(
    /CREATE UNIQUE INDEX[^;]*\(financial_entity_id\)\s*\n?\s*WHERE financial_entity_id IS NOT NULL/.test(sql),
    "one override per entity on the uuid arm",
  );
});

test("FIX-922: the migration adds NO foreign key — a dangling id must surface, not cascade", () => {
  // FIX-916's reader comment is explicit that an unresolvable override is
  // surfaced and counted rather than silently vanishing, because the likely
  // cause is a FIX-544 merge and the fix is to re-point one row. ON DELETE
  // CASCADE would instead delete a hand-audited assignment when a merge drops
  // the loser entity. This is the alarm on that decision.
  const sql = readFileSync(FIX922_MIGRATION_PATH, "utf8");
  assert.ok(
    !/REFERENCES\s+public\.financial_entities/i.test(sql),
    "a FK here would cascade-delete curated rows on an entity merge",
  );
});

test("FIX-922: the tagger reads BOTH arms, each as its own indexable join", () => {
  // `ON a = b OR c = d` would typecheck, return the right rows, and plan as a
  // join filter rather than two index lookups. Measured on the local clone the
  // two-LEFT-JOIN form plans as Index Scan (fec_committee_id_key) + Index Only
  // Scan (pkey, 0 heap fetches). Pin the shape.
  const src = readFileSync(RULES_PATH, "utf8");
  assert.ok(
    /COALESCE\(fe_id\.id, fe_cmte\.id\) AS entity_id/.test(src),
    "the reader must resolve entity_id from either arm",
  );
  assert.ok(
    /LEFT JOIN public\.financial_entities fe_cmte\s+ON o\.financial_entity_id IS NULL\s+AND fe_cmte\.fec_committee_id = o\.fec_committee_id/.test(src),
    "the committee arm must be a LEFT JOIN restricted to committee-keyed rows",
  );
  assert.ok(
    /LEFT JOIN public\.financial_entities fe_id\s+ON fe_id\.id = o\.financial_entity_id/.test(src),
    "the uuid arm must be a LEFT JOIN on the pkey — joined, not COALESCE'd off " +
      "the column, so a dangling uuid still reaches the orphan warning",
  );
  assert.ok(
    !/ON fe\.fec_committee_id = o\.fec_committee_id\s+ORDER BY/.test(src),
    "the single-arm reader must be gone",
  );
});

// ---------------------------------------------------------------------------
// FIX-1255 — the first cohort on the uuid arm: twelve defense IT and R&D
// primes that the dominant-code NAICS map sends to tech. Its own TSV, its own
// drift alarm (the FIX-921 precedent), and a TSV that leads with
// financial_entity_id in place of fec_committee_id (FIX-922's header).
// ---------------------------------------------------------------------------

const DEFENSE_TSV_PATH = join(REPO_ROOT, "docs", "audits", "2026-10-01-fix1255-defense-primes.tsv");
const DEFENSE_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations", "20261002010000_fix1255_defense_primes_override.sql",
);

type DefenseRow = { id: string; display_name: string; industry: string; naics: string; pick: string };

function readDefenseTsv(): DefenseRow[] {
  const lines = readFileSync(DEFENSE_TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  assert.equal(
    lines[0],
    "financial_entity_id\tdisplay_name\tindustry\tnaics_dominant\tcontract_usd\tcoded_usd\tcurrent_pick\tnote",
  );
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0]!, display_name: c[1]!, industry: c[2]!, naics: c[3]!, pick: c[6]! };
  });
}

test("FIX-1255: the defense TSV is twelve unique contractor ids, all defense, all picked tech before", () => {
  const rows = readDefenseTsv();
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map((r) => r.id)).size, 12, "financial_entity_id must be unique");
  for (const r of rows) {
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, r.display_name);
    assert.equal(r.industry, "defense", r.display_name);
    assert.equal(r.pick, "tech", `${r.display_name}: the cohort is the defense → tech pick-changers`);
    assert.ok((VALID_INDUSTRIES as readonly string[]).includes(r.industry));
  }
});

test("FIX-1255: the migration seeds exactly its TSV, on the uuid arm's synthetic key", () => {
  const sql = readFileSync(DEFENSE_MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string>();
  for (const m of sql.matchAll(/^ {2}\('fe:([0-9a-f-]{36})', '([0-9a-f-]{36})', '([a-z_]+)'/gm)) {
    assert.equal(m[1], m[2], "the synthetic key must be 'fe:' || financial_entity_id (the CHECK)");
    seeded.set(m[2]!, m[3]!);
  }
  const tsv = readDefenseTsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the defense TSV");
  for (const r of tsv) {
    assert.equal(seeded.get(r.id), r.industry, `${r.display_name} (${r.id}) missing or mismatched`);
  }
  // The pre-check's id list is the same twelve.
  const precheck = sql.match(/v_ids\s+uuid\[\] := ARRAY\[([\s\S]*?)\]::uuid\[\]/);
  assert.ok(precheck, "the pre-check id list must be present");
  const ids = [...precheck![1]!.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]!);
  assert.deepEqual([...ids].sort(), tsv.map((r) => r.id).sort());
});

test("FIX-1255: the migration's total is every cohort's TSV plus HRPAC", () => {
  // 742 (FIX-916) + 50 (FIX-921) + 1 (FIX-923) + 12 (FIX-1255). A cohort row
  // that collided with another would be absorbed by ON CONFLICT and the total
  // would come up short on apply.
  const total = readTsv().length + readSweepTsv().length + 1 + readDefenseTsv().length;
  assert.equal(total, 805);
  const sql = readFileSync(DEFENSE_MIGRATION_PATH, "utf8");
  assert.match(sql, /IF v_total <> 805 THEN/);
  assert.match(sql, /IF v_cohort <> 12 THEN/);
});

test("FIX-1255: the migration does not delete the cohort's ai rows (FIX-1259 keeps them)", () => {
  // FIX-916/921/923 deleted an overridden entity's ai rows. Here the ai rows
  // say `defense` too, and FIX-1259 exists to keep another writer's judgment;
  // a DELETE would also be a prod write the prompt did not sanction.
  const sql = readFileSync(DEFENSE_MIGRATION_PATH, "utf8");
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.entity_tags/i);
});

test("FIX-1255: a uuid-keyed defense override replaces the computed tech NAICS tag", () => {
  const LLNS = "07f586a3-4996-47a6-97fc-55bf06f7dcf3";
  const computed = [
    { ...ruleTag(LLNS, "tech"), confidence: 0.85, metadata: { naics_code: "541710" } },
  ];
  const out = applyIndustryOverrides(computed, [
    { entity_id: LLNS, fec_committee_id: `fe:${LLNS}`, industry: "defense",
      audited_sector: "defense_prime_it_rd", source: "fix1255-defense-primes-2026-10-01" },
  ]);
  const industry = out.filter((t) => t.tag_category === "industry");
  assert.equal(industry.length, 1);
  assert.equal(industry[0]!.tag, "defense");
  assert.equal(industry[0]!.generated_by, "curated");
  assert.deepEqual(industry[0]!.metadata, {
    source: "fix1255-defense-primes-2026-10-01",
    audited_sector: "defense_prime_it_rd",
    fec_committee_id: `fe:${LLNS}`,
  });
});

// ---------------------------------------------------------------------------
// FIX-1255 (cc-184 D2) — CACI NSS joins the cohort in a SECOND migration with
// its own one-row TSV. The block above pins the applied 20261002010000 file
// (12 / 805), which is frozen history; this one pins the new file (13 / 806).
// ---------------------------------------------------------------------------

const CACI_TSV_PATH = join(REPO_ROOT, "docs", "audits", "2026-10-03-fix1255-caci-nss.tsv");
const CACI_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations", "20261003040000_fix1255_caci_nss_override.sql",
);

function readCaciTsv(): DefenseRow[] {
  const lines = readFileSync(CACI_TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  assert.equal(
    lines[0],
    "financial_entity_id\tdisplay_name\tindustry\tnaics_dominant\tcontract_usd\tcoded_usd\tcurrent_pick\tnote",
    "the same header as the twelve's TSV",
  );
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0]!, display_name: c[1]!, industry: c[2]!, naics: c[3]!, pick: c[6]! };
  });
}

test("FIX-1255 CACI NSS: the TSV is one defense row, picked tech before, not already in the twelve", () => {
  const rows = readCaciTsv();
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.match(r!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(r!.display_name, "CACI NSS, LLC");
  assert.equal(r!.industry, "defense");
  assert.equal(r!.pick, "tech");
  assert.ok(!readDefenseTsv().some((d) => d.id === r!.id), "a second seed of one of the twelve would not grow the cohort");
});

test("FIX-1255 CACI NSS: the migration seeds exactly its TSV, same source and sector, on the synthetic key", () => {
  const sql = readFileSync(CACI_MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string>();
  for (const m of sql.matchAll(/^ {2}\('fe:([0-9a-f-]{36})', '([0-9a-f-]{36})', '([a-z_]+)'/gm)) {
    assert.equal(m[1], m[2], "the synthetic key must be 'fe:' || financial_entity_id (the CHECK)");
    seeded.set(m[2]!, m[3]!);
  }
  const tsv = readCaciTsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the CACI NSS TSV");
  for (const r of tsv) assert.equal(seeded.get(r.id), r.industry, `${r.display_name} (${r.id}) missing or mismatched`);
  const precheck = sql.match(/v_ids\s+uuid\[\] := ARRAY\[([\s\S]*?)\]::uuid\[\]/);
  assert.ok(precheck, "the pre-check id list must be present");
  const ids = [...precheck![1]!.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]!);
  assert.deepEqual(ids, tsv.map((r) => r.id));
  assert.match(sql, /'defense_prime_it_rd', 'fix1255-defense-primes-2026-10-01'/);
  assert.match(sql, /o\.source <> 'fix1255-defense-primes-2026-10-01'/, "the not-curated-elsewhere pre-check");
  assert.match(sql, /ON CONFLICT \(fec_committee_id\) DO UPDATE/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.entity_tags/i);
});

test("FIX-1255 CACI NSS: cohort 13 across both migrations, table 806", () => {
  const cohort = readDefenseTsv().length + readCaciTsv().length;
  assert.equal(cohort, 13);
  const total = readTsv().length + readSweepTsv().length + 1 + cohort;
  assert.equal(total, 806);
  const sql = readFileSync(CACI_MIGRATION_PATH, "utf8");
  assert.match(sql, /IF v_cohort <> 13 THEN/);
  assert.match(sql, /IF v_total <> 806 THEN/);
});

// ---------------------------------------------------------------------------
// FIX-1204 (cc-187 D7) — the two real NULL-committee donors join on the uuid
// arm in their own migration and TSV; the other two the 09-20 selection named
// (RIDGE_COAL, CUMBERLAND above) are is_synthetic Franklin seed rows and are
// excluded, by the pre-check's is_synthetic gate as well as by omission.
// ---------------------------------------------------------------------------

const NULL_COMMITTEE_TSV_PATH = join(
  REPO_ROOT, "docs", "audits", "2026-10-03-fix1204-null-committee-overrides.tsv",
);
const NULL_COMMITTEE_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations",
  "20261004070000_fix501_group_donor_topn_fix1204_null_committee_overrides.sql",
);

function readNullCommitteeTsv(): DefenseRow[] {
  const lines = readFileSync(NULL_COMMITTEE_TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  assert.equal(
    lines[0],
    "financial_entity_id\tdisplay_name\tindustry\tnaics_dominant\tcontract_usd\tcoded_usd\tcurrent_pick\tnote",
    "the same header as the FIX-1255 TSVs",
  );
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0]!, display_name: c[1]!, industry: c[2]!, naics: c[3]!, pick: c[6]! };
  });
}

test("FIX-1204: the TSV is PCMA → health and NRA PVF → lobby, and neither synthetic row", () => {
  const rows = readNullCommitteeTsv();
  assert.deepEqual(
    rows.map((r) => [r.id, r.industry]),
    [
      ["ae4d58df-917c-47ef-80c9-0ebf8d096189", "health"],
      ["dac6b3f9-aebc-406d-a587-01998408f03b", "lobby"],
    ],
  );
  for (const r of rows) assert.ok((VALID_INDUSTRIES as readonly string[]).includes(r.industry), `${r.industry} is in the vocabulary`);
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(RIDGE_COAL) && !ids.includes(CUMBERLAND), "the two Franklin seed rows are never curated");
  const elsewhere = [...readDefenseTsv(), ...readCaciTsv()].map((r) => r.id);
  for (const id of ids) assert.ok(!elsewhere.includes(id), `${id} is not already in the FIX-1255 cohort`);
});

test("FIX-1204: the migration seeds exactly its TSV on the synthetic key, behind the is_synthetic gate", () => {
  const sql = readFileSync(NULL_COMMITTEE_MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string>();
  for (const m of sql.matchAll(/^ {2}\('fe:([0-9a-f-]{36})', '([0-9a-f-]{36})', '([a-z_]+)'/gm)) {
    assert.equal(m[1], m[2], "the synthetic key must be 'fe:' || financial_entity_id (the CHECK)");
    seeded.set(m[2]!, m[3]!);
  }
  const tsv = readNullCommitteeTsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the TSV");
  for (const r of tsv) assert.equal(seeded.get(r.id), r.industry, `${r.display_name} (${r.id}) missing or mismatched`);
  const precheck = sql.match(/v_ids\s+uuid\[\] := ARRAY\[([\s\S]*?)\]::uuid\[\]/);
  assert.ok(precheck, "the pre-check id list must be present");
  assert.deepEqual([...precheck![1]!.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]!), tsv.map((r) => r.id));
  assert.match(sql, /WHERE fe\.id = ANY \(v_ids\) AND COALESCE\(fe\.is_synthetic, false\)/, "the synthetic gate");
  assert.match(sql, /fe\.fec_committee_id IS NOT NULL/, "the committee-arm gate");
  assert.match(sql, /o\.source <> 'fix1204-null-committee-2026-10-03'/, "the not-curated-elsewhere gate");
  assert.equal((sql.match(/'null_committee_donor', 'fix1204-null-committee-2026-10-03'/g) ?? []).length, 2);
  assert.match(sql, /single-issue advocacy: firearms/);
  assert.match(sql, /ON CONFLICT \(fec_committee_id\) DO UPDATE/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.entity_tags/i);
});

test("FIX-1204: cohort 2, table 808", () => {
  const cohort = readNullCommitteeTsv().length;
  assert.equal(cohort, 2);
  const total = readTsv().length + readSweepTsv().length + 1 + readDefenseTsv().length + readCaciTsv().length + cohort;
  assert.equal(total, 808);
  const sql = readFileSync(NULL_COMMITTEE_MIGRATION_PATH, "utf8");
  assert.match(sql, /IF v_cohort <> 2 THEN/);
  assert.match(sql, /IF v_total <> 808 THEN/);
});

test("FIX-1204: the lobby override replaces the rule row with a curated one; no secondary axis", () => {
  const NRA = "dac6b3f9-aebc-406d-a587-01998408f03b";
  const out = applyIndustryOverrides([ruleTag(NRA, "lobby"), ruleTag(NRA, "small_donation", "size")], [
    { entity_id: NRA, fec_committee_id: `fe:${NRA}`, industry: "lobby",
      audited_sector: "null_committee_donor", source: "fix1204-null-committee-2026-10-03" },
  ]);
  const industry = out.filter((t) => t.tag_category === "industry");
  assert.equal(industry.length, 1, "one industry tag — no second axis");
  assert.equal(industry[0]!.tag, "lobby");
  assert.equal(industry[0]!.generated_by, "curated");
  assert.equal(out.filter((t) => t.tag_category === "size").length, 1, "size tags untouched");
});

// ---------------------------------------------------------------------------
// FIX-1266 (cc-196 D1) — the donation top-200's four wrong/none verdicts plus
// FIX-1280's two union residuals, on the COMMITTEE arm (real fec_committee_ids,
// financial_entity_id NULL). The three NULL rows' ai `lobby` rows are deleted in
// the same migration: a NULL override only filters what the tagger writes, so
// without the delete primary_industry_tag() would still pick the ai row.
// ---------------------------------------------------------------------------

const TOP200_TSV_PATH = join(REPO_ROOT, "docs", "audits", "2026-10-05-fix1266-top200-overrides.tsv");
const TOP200_MIGRATION_PATH = join(
  REPO_ROOT, "supabase", "migrations", "20261005100000_fix1266_top200_pick_overrides.sql",
);

type CommitteeRow = { fec: string; display_name: string; cmte_type: string; industry: string | null; sector: string };

function readTop200Tsv(): CommitteeRow[] {
  const lines = readFileSync(TOP200_TSV_PATH, "utf8").split(/\r?\n/).filter((l) => l.length);
  assert.equal(
    lines[0],
    "fec_committee_id\tdisplay_name\tfec_cmte_type\tconnected_org\ttotal_cents\tcurrent_pick\tindustry\taudited_sector\tnote",
    "the committee-arm header",
  );
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { fec: c[0]!, display_name: c[1]!, cmte_type: c[2]!, industry: c[6] === "NULL" ? null : c[6]!, sector: c[7]! };
  });
}

test("FIX-1266: the TSV is RTX → defense, three → NULL, two union super PACs → labor", () => {
  const rows = readTop200Tsv();
  assert.deepEqual(
    rows.map((r) => [r.fec, r.industry]),
    [
      ["C00097568", "defense"],
      ["C00327189", null],
      ["C00550970", null],
      ["C00448696", null],
      ["C00745745", "labor"],
      ["C00528448", "labor"],
    ],
  );
  for (const r of rows) {
    assert.match(r.fec, /^C\d{8}$/, "committee arm: a real FEC committee id");
    if (r.industry !== null) assert.ok((VALID_INDUSTRIES as readonly string[]).includes(r.industry), `${r.industry} is in the vocabulary`);
  }
  const earlier = new Set([...readTsv(), ...readSweepTsv()].map((r) => r.fec));
  for (const r of rows) assert.ok(!earlier.has(r.fec), `${r.fec} is not already in the FIX-916/921 cohorts`);
});

test("FIX-1266: the migration seeds exactly its TSV on the committee arm, behind the three gates", () => {
  const sql = readFileSync(TOP200_MIGRATION_PATH, "utf8");
  const seeded = new Map<string, string | null>();
  for (const m of sql.matchAll(/^ {2}\('(C\d{8})', NULL, (NULL|'[a-z_]+')/gm)) {
    seeded.set(m[1]!, m[2] === "NULL" ? null : m[2]!.slice(1, -1));
  }
  const tsv = readTop200Tsv();
  assert.equal(seeded.size, tsv.length, "seed row count must match the TSV");
  for (const r of tsv) {
    assert.ok(seeded.has(r.fec), `${r.fec} is missing from the migration seed`);
    assert.equal(seeded.get(r.fec), r.industry, `industry mismatch for ${r.fec}`);
  }
  const precheck = sql.match(/v_ids\s+text\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(precheck, "the pre-check id list must be present");
  assert.deepEqual([...precheck![1]!.matchAll(/'(C\d{8})'/g)].map((m) => m[1]!), tsv.map((r) => r.fec));
  assert.match(sql, /COALESCE\(fe\.is_synthetic, false\)/, "the synthetic gate");
  assert.match(sql, /o\.source <> 'fix1266-top200-2026-10-05'/, "the not-curated-elsewhere gate");
  for (const r of tsv) {
    assert.ok(sql.includes(`'${r.sector}', 'fix1266-top200-2026-10-05'`), `${r.fec} carries sector ${r.sector}`);
  }
  assert.match(sql, /ON CONFLICT \(fec_committee_id\) DO UPDATE/);
});

test("FIX-1266: the one entity_tags write deletes ai industry rows of this cohort's NULL rows, nothing else", () => {
  const sql = readFileSync(TOP200_MIGRATION_PATH, "utf8");
  const deletes = [...sql.matchAll(/DELETE\s+FROM\s+public\.entity_tags[\s\S]*?RETURNING/gi)].map((m) => m[0]);
  assert.equal(deletes.length, 1, "exactly one DELETE FROM entity_tags");
  const d = deletes[0]!;
  assert.match(d, /et\.generated_by\s+=\s+'ai'/);
  assert.match(d, /et\.tag_category\s+=\s+'industry'/);
  assert.match(d, /o\.industry IS NULL/);
  assert.match(d, /o\.source\s+=\s+'fix1266-top200-2026-10-05'/);
  assert.match(sql, /IF v_deleted NOT IN \(0, 3\) THEN/, "3 on first apply, 0 on re-apply");
});

test("FIX-1266: cohort 6 (3 NULL), table 814", () => {
  const rows = readTop200Tsv();
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.industry === null).length, 3);
  const total = readTsv().length + readSweepTsv().length + 1 + readDefenseTsv().length + readCaciTsv().length
    + readNullCommitteeTsv().length + rows.length;
  assert.equal(total, 814);
  const sql = readFileSync(TOP200_MIGRATION_PATH, "utf8");
  assert.match(sql, /IF v_cohort <> 6 THEN/);
  assert.match(sql, /IF v_nulls <> 3 THEN/);
  assert.match(sql, /IF v_total <> 814 THEN/);
});

test("FIX-1266: a NULL override drops the computed rows and emits none; the RTX override emits one defense row", () => {
  const VIEW = "88c80a62-e8fc-411b-86e9-f540767c85f6";
  const RTX = "0d571269-157e-4c4f-821e-4a915f0888d1";
  const out = applyIndustryOverrides([ruleTag(VIEW, "lobby"), ruleTag(RTX, "small_donation", "size")], [
    { entity_id: VIEW, fec_committee_id: "C00327189", industry: null, audited_sector: "top200_pick_audit", source: "fix1266-top200-2026-10-05" },
    { entity_id: RTX, fec_committee_id: "C00097568", industry: "defense", audited_sector: "top200_pick_audit", source: "fix1266-top200-2026-10-05" },
  ]);
  const industry = out.filter((t) => t.tag_category === "industry");
  assert.deepEqual(industry.map((t) => [t.entity_id, t.tag, t.generated_by]), [[RTX, "defense", "curated"]]);
});
