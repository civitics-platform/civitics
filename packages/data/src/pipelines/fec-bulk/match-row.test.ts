/**
 * FIX-929 — matchRow's weball name fallback must compare first names on EVERY
 * match, including a pool that state-narrowing already collapsed to one.
 *
 * Before this gate, `if (pool.length === 1) return pool[0]` returned without
 * ever looking at the first name. Ohio has three officials surnamed Brown, so
 * before the cn{yy} candidate-tier row for S6OH00163 existed the OH Brown pool
 * was effectively just the sitting House member — and Sherrod Brown's SENATE
 * CAND_ID bound to Shontel M. Brown, parking $51.0M of his donors on her page.
 *
 * The writer upserts on (relationship_type, from_id, to_id, cycle_year), so a
 * later corrected binding writes a NEW row and never retires the bad one. That
 * makes a wrong match permanent-until-cleaned (FIX-930) while a missed match
 * only renders $0 plus a "FEC sync weekly" note — hence the gate is deliberately
 * tighter than the coverage it costs.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/match-row.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatchIndex, matchRow, type OfficialRecord, type WeBallRow } from "./index";
import { parseFecName } from "./util";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function official(
  id: string,
  full_name: string,
  first_name: string | null,
  last_name: string,
  role_title: string,
  state: string,
  source_ids: Record<string, string> = {},
): OfficialRecord {
  return { id, full_name, first_name, last_name, role_title, source_ids, state };
}

/** Only candId / candName / candOfficeSt are read by matchRow; rest is filler. */
function weball(candId: string, candName: string, candOfficeSt: string): WeBallRow {
  return {
    candId,
    candName,
    candOfficeSt,
    ttlReceipts: 0,
    ttlDisb: 0,
    cohCop: 0,
    candContrib: 0,
    candLoans: 0,
    otherLoans: 0,
    indivContrib: 0,
    polPtyContrib: 0,
    cvrdHarReceipts: 0,
  };
}

// The real Ohio Brown pool. Shontel is the sitting House member; Sherrod's
// candidate-tier row is the one the cn{yy} stage mints from CAND_ID S6OH00163.
const SHONTEL = official(
  "f29bbd4e-944f-4840-adbd-16a4706a3c02",
  "Shontel M. Brown",
  "Shontel",
  "Brown",
  "Representative",
  "OH",
  { congress_gov: "B001313" },
);
const SHERROD = official(
  "d758a091-fa36-47d4-b2b0-e264d41f1fc2",
  "Sherrod Brown",
  "Sherrod",
  "Brown",
  "Candidate for Senator",
  "OH",
  { fec_candidate_id: "S6OH00163" },
);

const SHERROD_WEBALL = weball("S6OH00163", "BROWN, SHERROD", "OH");

// ---------------------------------------------------------------------------
// The motivating regression
// ---------------------------------------------------------------------------

test("FIX-929 a single-element state pool is NOT matched when the first names disagree", () => {
  // The pre-cn{yy} world: Shontel is the only Ohio Brown in the index.
  const index = buildMatchIndex([SHONTEL]);
  const match = matchRow(SHERROD_WEBALL, index);

  assert.equal(
    match,
    null,
    "SHERROD must not bind to Shontel M. Brown just because she is the only OH Brown",
  );
});

test("FIX-929 once the candidate-tier row exists, SHERROD resolves to it", () => {
  const index = buildMatchIndex([SHONTEL, SHERROD]);
  const match = matchRow(SHERROD_WEBALL, index);

  assert.ok(match, "Sherrod Brown's own row must match");
  assert.equal(match.officialId, SHERROD.id);
  // fec_candidate_id is in the index, so this resolves on the authoritative
  // step-1 path rather than the name fallback.
  assert.equal(match.byFecId, true);
});

test("FIX-929 SHERROD still resolves by NAME when only the stored id is missing", () => {
  // Same pool, but strip the stored fec_candidate_id so step 1 cannot fire.
  const sherrodNoId = { ...SHERROD, source_ids: {} };
  const index = buildMatchIndex([SHONTEL, sherrodNoId]);
  const match = matchRow(SHERROD_WEBALL, index);

  assert.ok(match, "the name fallback must still find the right Brown");
  assert.equal(match.officialId, SHERROD.id);
  assert.equal(match.byFecId, false);
});

test("FIX-929 the byFecId direct-lookup path is untouched by the gate", () => {
  // A stored fec_candidate_id is authoritative even when the FEC name would
  // never pass the first-name gate (legal name vs the name we hold).
  const cruz = official(
    "00000000-0000-0000-0000-0000000000c2",
    "Ted Cruz",
    "Ted",
    "Cruz",
    "Senator",
    "TX",
    { fec_candidate_id: "S2TX00312" },
  );
  const index = buildMatchIndex([cruz]);
  const match = matchRow(weball("S2TX00312", "CRUZ, RAFAEL EDWARD", "TX"), index);

  assert.ok(match, "a stored fec_candidate_id must always win");
  assert.equal(match.officialId, cruz.id);
  assert.equal(match.byFecId, true);
});

// ---------------------------------------------------------------------------
// Coverage the gate must NOT cost
// ---------------------------------------------------------------------------

test("FIX-929 a genuine single-official state pool still matches when first names agree", () => {
  const ossoff = official(
    "1376dc1e-f697-40b2-8c0f-780f8fe8ea00",
    "Jon Ossoff",
    "Jon",
    "Ossoff",
    "Senator",
    "GA",
    { congress_gov: "O000174" },
  );
  const index = buildMatchIndex([ossoff]);
  const match = matchRow(weball("S8GA00180", "OSSOFF, JON", "GA"), index);

  assert.ok(match, "an unambiguous, first-name-agreeing pool of one must still match");
  assert.equal(match.officialId, ossoff.id);
  assert.equal(match.byFecId, false);
});

test("FIX-929 first-name agreement is a 3-letter prefix, so middle names do not block it", () => {
  const warnock = official(
    "00000000-0000-0000-0000-0000000000w1",
    "Raphael Warnock",
    "Raphael",
    "Warnock",
    "Senator",
    "GA",
  );
  const index = buildMatchIndex([warnock]);
  // FEC carries the middle initial; parseFecName drops it, leaving "RAPHAEL".
  const match = matchRow(weball("S0GA00559", "WARNOCK, RAPHAEL G", "GA"), index);

  assert.ok(match, "a trailing middle initial must not block the match");
  assert.equal(match.officialId, warnock.id);
});

test("FIX-929 an official with a NULL first_name falls back to the leading full_name token", () => {
  const noFirst = official(
    "00000000-0000-0000-0000-0000000000n1",
    "Marjorie Taylor Greene",
    null,
    "Greene",
    "Representative",
    "GA",
  );
  const index = buildMatchIndex([noFirst]);
  const match = matchRow(weball("H8GA14067", "GREENE, MARJORIE TAYLOR", "GA"), index);

  assert.ok(match, "first_name=NULL must degrade to full_name's first token, not to a skip");
  assert.equal(match.officialId, noFirst.id);
});

// ---------------------------------------------------------------------------
// Ambiguity and unusable first names
// ---------------------------------------------------------------------------

test("FIX-929 a multi-element pool still resolves on first-name agreement", () => {
  const shontelWeball = weball("H2OH11169", "BROWN, SHONTEL M", "OH");
  const index = buildMatchIndex([
    SHONTEL,
    { ...SHERROD, source_ids: {} },
    official("00000000-0000-0000-0000-0000000000b3", "Bob Brown", "Bob", "Brown", "Representative", "OH"),
  ]);
  const match = matchRow(shontelWeball, index);

  assert.ok(match, "three OH Browns, one first-name agreement");
  assert.equal(match.officialId, SHONTEL.id);
});

test("FIX-929 two officials sharing surname AND first-3 stay ambiguous", () => {
  const index = buildMatchIndex([
    official("00000000-0000-0000-0000-0000000000j1", "Jon Smith", "Jon", "Smith", "Representative", "NY"),
    official("00000000-0000-0000-0000-0000000000j2", "Jonathan Smith", "Jonathan", "Smith", "Representative", "NY"),
  ]);

  assert.equal(
    matchRow(weball("H0NY00001", "SMITH, JON", "NY"), index),
    null,
    "JON vs JONATHAN both key to JON — genuinely ambiguous, must skip",
  );
});

test("FIX-929 an initials-only FEC first name is too short to compare and skips", () => {
  const pryce = official(
    "00000000-0000-0000-0000-0000000000p1",
    "Deborah Pryce",
    "Deborah",
    "Pryce",
    "Representative",
    "OH",
  );
  const index = buildMatchIndex([pryce]);

  assert.equal(parseFecName("PRYCE, B").first, "B");
  assert.equal(
    matchRow(weball("H2OH15082", "PRYCE, B", "OH"), index),
    null,
    "a one-letter FEC first name cannot be compared — skip rather than guess",
  );
});

test("FIX-929 a FEC name with no comma has no first name and skips", () => {
  const index = buildMatchIndex([
    official("00000000-0000-0000-0000-0000000000c1", "Ann Cooper", "Ann", "Cooper", "Representative", "TX"),
  ]);

  assert.equal(
    matchRow(weball("H0TX00001", "COOPER", "TX"), index),
    null,
    "no comma → parseFecName yields first='' → nothing to agree with → skip",
  );
});

// ---------------------------------------------------------------------------
// Recorded decision: the Cruz name-fallback regression
// ---------------------------------------------------------------------------

test("FIX-929 RECORDED DECISION — FEC legal name vs our short name no longer matches by name", () => {
  // FEC files Ted Cruz as "CRUZ, RAFAEL EDWARD". RAF !== TED, so under the new
  // gate the NAME fallback declines. This is the accepted cost of decision 3
  // (a missed match beats a wrong match): Cruz resolves through his stored
  // fec_candidate_id (S2TX00312, pinned above), so nothing is actually lost —
  // and the alternative, matching on surname+state alone, is exactly what put
  // Sherrod Brown's donors on Shontel Brown's page.
  //
  // The residual exposure this leaves is an official who uses a short name AND
  // has never had an FEC id persisted. Those are enumerated as the UNIQUE
  // HOLDER branch of FIX-930, whose remediation is to WRITE the missing id.
  const cruzNoId = official(
    "00000000-0000-0000-0000-0000000000c3",
    "Ted Cruz",
    "Ted",
    "Cruz",
    "Senator",
    "TX",
  );
  const index = buildMatchIndex([cruzNoId]);

  assert.equal(
    matchRow(weball("S2TX00312", "CRUZ, RAFAEL EDWARD", "TX"), index),
    null,
    "shipped behavior: no name-fallback match when the FEC legal first name disagrees",
  );
});
