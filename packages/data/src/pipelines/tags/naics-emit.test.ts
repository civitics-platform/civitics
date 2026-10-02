/**
 * FIX-919 — the NAICS emit loop and the keyword/NAICS dedupe, pinned.
 *
 * get_financial_entity_naics() returned [] on both envs until FIX-919 repointed
 * it at the contractor (to_id) side, so this loop had never emitted a row. The
 * states that matter once it does:
 *
 *   - a mapped code emits exactly one `rule` row at 0.85;
 *   - an unmapped sector (23/56/61/71/72/81, and 54 outside 5411/5412/5415/5417
 *     since FIX-1246) and a null code emit nothing;
 *   - a NAICS tag that AGREES with the keyword tag dedupes to ONE row, and the
 *     keyword row is the one kept (it is pushed first);
 *   - a NAICS tag that DISAGREES yields TWO rows — the multi-tag donor that
 *     primary_industry_tag() now ranks (FIX-918) instead of alphabetising.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNaicsIndustryTags, dedupeIndustryTags, naicsToIndustry } from "./rules";
import { VALID_INDUSTRIES } from "./topics";

const E_MAPPED   = "11111111-1111-1111-1111-111111111111";
const E_UNMAPPED = "22222222-2222-2222-2222-222222222222";
const E_AGREE    = "33333333-3333-3333-3333-333333333333";
const E_DISAGREE = "44444444-4444-4444-4444-444444444444";
const E_NULL     = "55555555-5555-5555-5555-555555555555";

/** A keyword-pass row, shaped exactly as tagFinancialEntities pushes it. */
function keywordTag(entityId: string, tag: string, confidence = 0.8) {
  return {
    entity_type: "financial_entity",
    entity_id: entityId,
    tag,
    tag_category: "industry",
    display_label: tag,
    display_icon: null,
    visibility: "primary" as const,
    generated_by: "rule" as const,
    confidence,
    pipeline_version: "v1",
    metadata: { matched_count: 1 } as Record<string, unknown>,
  };
}

test("a mapped NAICS code emits exactly one rule row at 0.85, carrying the code", () => {
  const rows = buildNaicsIndustryTags([{ entity_id: E_MAPPED, naics_code: "336411" }]);
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r!.entity_id, E_MAPPED);
  assert.equal(r!.tag, "defense");            // 336 override beats the 33 → manufacturing bucket
  assert.equal(r!.tag_category, "industry");
  assert.equal(r!.generated_by, "rule");
  assert.equal(r!.confidence, 0.85);
  assert.deepEqual(r!.metadata, { naics_code: "336411" });
});

test("an unmapped sector and a null code emit nothing", () => {
  const rows = buildNaicsIndustryTags([
    { entity_id: E_UNMAPPED, naics_code: "236220" },  // 23 — construction, not in the vocabulary
    { entity_id: E_UNMAPPED, naics_code: "561612" },  // 56 — removed by FIX-909
    { entity_id: E_NULL, naics_code: null },
  ]);
  assert.deepEqual(rows, []);
});

test("NAICS confidence outranks both keyword confidences (0.8 single, 0.7 ambiguous)", () => {
  // primary_industry_tag() ranks on confidence after provenance; this ordering is
  // what makes a contract code beat a name match without a NAICS-specific key.
  const [n] = buildNaicsIndustryTags([{ entity_id: E_MAPPED, naics_code: "541511" }]);
  assert.ok(n!.confidence > 0.8);
  assert.ok(n!.confidence > 0.7);
});

test("a NAICS tag that AGREES with the keyword tag dedupes to ONE row — the keyword one", () => {
  const all = [
    keywordTag(E_AGREE, "defense"),
    ...buildNaicsIndustryTags([{ entity_id: E_AGREE, naics_code: "336411" }]),
  ];
  const out = dedupeIndustryTags(all);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tag, "defense");
  assert.equal(out[0]!.confidence, 0.8, "keyword pushed first → keyword kept");
  assert.deepEqual(out[0]!.metadata, { matched_count: 1 });
});

test("a NAICS tag that DISAGREES yields TWO rows — the multi-tag state FIX-918 ranks", () => {
  const all = [
    keywordTag(E_DISAGREE, "finance"),
    ...buildNaicsIndustryTags([{ entity_id: E_DISAGREE, naics_code: "541511" }]),  // 5415 → tech
  ];
  const out = dedupeIndustryTags(all);
  assert.deepEqual(
    out.map((t) => [t.tag, t.confidence]).sort(),
    [["finance", 0.8], ["tech", 0.85]],
  );
});

test("every tag the NAICS pass can emit is a vocabulary key", () => {
  const codes = ["11", "21", "22", "31", "32", "33", "3254", "325", "326", "334", "335", "336",
                 "42", "44", "45", "48", "49", "51", "52", "53", "5411", "5412",
                 "5415", "5417", "55", "62", "92"];
  const rows = buildNaicsIndustryTags(codes.map((c, i) => ({
    entity_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    naics_code: c.padEnd(6, "0"),
  })));
  assert.equal(rows.length, codes.length);
  for (const r of rows) assert.ok((VALID_INDUSTRIES as readonly string[]).includes(r.tag), r.tag);
});

/**
 * FIX-1246 — NAICS 54 is not tech. The "54" and "541" catch-alls are gone;
 * engineering, consulting, advertising, design and "other professional" have no
 * bucket in the vocabulary and go untagged (the sector-56 precedent), and the
 * four sub-sectors with a true home keep it. 541330 is the wrong-but-green
 * shape: the old map tagged it tech, and it is the largest retired prefix
 * (5413, 3,249 prod entities on 2026-09-30).
 */
test("FIX-1246: NAICS 54 outside 5411/5412/5415/5417 emits nothing", () => {
  for (const code of ["541330", "541611", "541810", "541990", "541430", "540000", "54"]) {
    assert.equal(naicsToIndustry(code), null, `${code} must not map`);
    assert.deepEqual(buildNaicsIndustryTags([{ entity_id: E_UNMAPPED, naics_code: code }]), [], code);
  }
});

test("FIX-1246: the four 54 sub-sectors with a bucket keep it", () => {
  const cases: Array<[string, string]> = [
    ["541511", "tech"],     // 5415 Computer Systems Design
    ["541715", "tech"],     // 5417 Scientific R&D (new)
    ["541110", "legal"],    // 5411 Legal Services
    ["541211", "finance"],  // 5412 Accounting
  ];
  for (const [code, want] of cases) {
    assert.equal(naicsToIndustry(code), want, code);
    const rows = buildNaicsIndustryTags([{ entity_id: E_MAPPED, naics_code: code }]);
    assert.equal(rows.length, 1, code);
    assert.equal(rows[0]!.tag, want, code);
  }
});

/**
 * FIX-1255 — 524114 (Direct Health and Medical Insurance Carriers) is health,
 * by its full six-digit code. Its 5241 siblings stay finance through "52":
 * a 5241 → health entry would send the life and property-and-casualty
 * carriers (Travelers, Chubb) to health. Humana Government Business is the
 * wrong-but-green shape: its dominant code is 524114 and the old map gave it
 * finance.
 */
test("FIX-1255: 524114 maps to health; its 5241 siblings stay finance", () => {
  assert.equal(naicsToIndustry("524114"), "health");
  assert.equal(naicsToIndustry(" 524114 "), "health", "trimmed like every other code");
  for (const code of ["524113", "524126", "524127", "524128", "524130", "524210"]) {
    assert.equal(naicsToIndustry(code), "finance", `${code} must stay finance`);
  }
  // A shorter code string still falls through the 4/3/2-digit arms.
  assert.equal(naicsToIndustry("5241"), "finance");
  assert.equal(naicsToIndustry("524"), "finance");
  const rows = buildNaicsIndustryTags([{ entity_id: E_MAPPED, naics_code: "524114" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tag, "health");
  assert.deepEqual(rows[0]!.metadata, { naics_code: "524114" });
});

test("FIX-1255: the six-digit arm does not disturb the 4- and 3-digit overrides", () => {
  assert.equal(naicsToIndustry("325412"), "health", "3254 still beats 325");
  assert.equal(naicsToIndustry("325211"), "manufacturing");
  assert.equal(naicsToIndustry("336411"), "defense");
  assert.equal(naicsToIndustry("541512"), "tech");
});
