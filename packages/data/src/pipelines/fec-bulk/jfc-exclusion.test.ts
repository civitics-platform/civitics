/**
 * FIX-698 — joint-fundraising committees (CMTE_DSGN ∈ {J,D,B}) must NOT enter
 * the individual→committee recipient set.
 *
 * Before FIX-698, nonCandCmtes was built from CMTE_TP alone, so JFCs filed as
 * CMTE_TP='N' / CMTE_DSGN='J' (Harris Victory Fund, the Trump JFCs, ~$1.4B+)
 * were captured as individual→committee donations AND re-itemized to
 * participants via JFC→participant transfers — a straight double-count. This
 * pins the parse of CMTE_DSGN (cm24 col 8) and the J/D/B exclusion.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/jfc-exclusion.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCm24, buildNonCandRecipientSet } from "./index";

// Build one pipe-delimited cm24 row. The committee-master layout is 15 fields;
// only CMTE_ID(0), CMTE_NM(1), CMTE_DSGN(8), CMTE_TP(9), CONNECTED_ORG_NM(13)
// are read. Everything else is filler so the column indices line up.
function cmRow(id: string, name: string, dsgn: string, tp: string): string {
  const cols = new Array(15).fill("");
  cols[0]  = id;
  cols[1]  = name;
  cols[8]  = dsgn;
  cols[9]  = tp;
  cols[13] = ""; // CONNECTED_ORG_NM
  return cols.join("|");
}

// The four JFCs confirmed on prod — all CMTE_TP='N', CMTE_DSGN='J'.
const JFCS = [
  ["C00744946", "HARRIS VICTORY FUND"],
  ["C00867937", "TRUMP 47 COMMITTEE"],
  ["C00873893", "TRUMP NATIONAL COMMITTEE JFC"],
  ["C00770941", "TRUMP SAVE AMERICA JFC"],
] as const;

const fixture = Buffer.from(
  [
    // four joint-fundraising committees — must be EXCLUDED
    ...JFCS.map(([id, nm]) => cmRow(id, nm, "J", "N")),
    // a legitimate super PAC (type O, unauthorized) — must be KEPT
    cmRow("C00010001", "LEGIT SUPER PAC", "U", "O"),
    // a legitimate non-JFC "other PAC" (type N, unauthorized) — must be KEPT
    cmRow("C00010002", "LEGIT OTHER PAC", "U", "N"),
    // a leadership PAC (designation D) — must be EXCLUDED even though type Q is kept
    cmRow("C00010003", "SOME LEADERSHIP PAC", "D", "Q"),
    // a "B" designation committee — must be EXCLUDED
    cmRow("C00010004", "SOME B COMMITTEE", "B", "N"),
  ].join("\n"),
  "latin1",
);

test("FIX-698 parseCm24 reads CMTE_DSGN from col 8", () => {
  const cm = parseCm24(fixture);
  assert.equal(cm.get("C00744946")?.designation, "J");
  assert.equal(cm.get("C00744946")?.type, "N");
  assert.equal(cm.get("C00010001")?.designation, "U");
  assert.equal(cm.get("C00010001")?.type, "O");
});

test("FIX-698 JFCs (CMTE_DSGN=J) are excluded from the indiv recipient set", () => {
  const cm = parseCm24(fixture);
  const nonCand = buildNonCandRecipientSet(cm, new Map());
  for (const [id, nm] of JFCS) {
    assert.ok(!nonCand.has(id), `${nm} (${id}) must NOT be a recipient — it is a JFC`);
  }
});

test("FIX-698 legitimate super PAC and non-JFC other PAC are kept", () => {
  const cm = parseCm24(fixture);
  const nonCand = buildNonCandRecipientSet(cm, new Map());
  assert.ok(nonCand.has("C00010001"), "type-O super PAC must be captured");
  assert.ok(nonCand.has("C00010002"), "type-N non-JFC PAC must be captured");
});

test("FIX-698 leadership (D) and B designations are also excluded", () => {
  const cm = parseCm24(fixture);
  const nonCand = buildNonCandRecipientSet(cm, new Map());
  assert.ok(!nonCand.has("C00010003"), "leadership PAC (DSGN=D) must be excluded");
  assert.ok(!nonCand.has("C00010004"), "B-designation committee must be excluded");
});

test("FIX-698 a candidate-authorized committee is skipped (handled by ccl path)", () => {
  const cm = parseCm24(fixture);
  // If a kept committee is already mapped to a candidate, the ccl path owns it.
  const cmteToCand = new Map([["C00010002", "H8XX00000"]]);
  const nonCand = buildNonCandRecipientSet(cm, cmteToCand);
  assert.ok(!nonCand.has("C00010002"), "ccl-mapped committee must not be double-added");
});
