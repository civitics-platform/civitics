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
import {
  buildMatchIndex,
  matchRow,
  perCycleNameFallback,
  type OfficialRecord,
  type WeBallRow,
} from "./index";
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

// ---------------------------------------------------------------------------
// FIX-955 — a RETIRED claim must never be re-selected or re-written
//
// FIX-933 neutralises a same-person duplicate by moving its `fec_candidate_id`
// to `merged_fec_candidate_id`. Nothing in the pipeline knew that marker
// existed, so the retired stub was re-matched BY NAME — the FIX-929 gate agrees,
// because it genuinely is the same person — and `persistNewFecIds` wrote the
// claim back. The money re-split across the pair and the merge undid itself on
// every run. Measured after one FEC_CYCLES=2020,2022 pass on a clone that had
// already been merged: 76 rows re-claimed, $309,080,435 re-duplicated.
//
// The real pair: Steny H. Hoyer (elected, MD-05) and the Steny Hoyer candidate
// stub, both claiming H2MD05155.
// ---------------------------------------------------------------------------

const HOYER_ELECTED = official(
  "e3cc18ef-131d-424b-aa6f-18d7057de207",
  "Steny H. Hoyer",
  "Steny",
  "Hoyer",
  "Representative",
  "MD",
  { congress_gov: "H000874", fec_candidate_id: "H2MD05155" },
);
/** Retired by FIX-933, then re-claimed by the very bug under test. */
const HOYER_RETIRED_STUB = official(
  "bf646f79-f45a-434d-8fcf-6cf4ba714951",
  "Steny Hoyer",
  "Steny",
  "Hoyer",
  "Candidate for Representative",
  "MD",
  { fec_candidate_id: "H2MD05155", merged_fec_candidate_id: "H2MD05155" },
);
const HOYER_WEBALL = weball("H2MD05155", "HOYER, STENY H", "MD");

test("FIX-955 a retired stub never wins the byFecId slot, even with the id re-written", () => {
  // Stub first, so a naive last-write-wins index would hand it the slot.
  const index = buildMatchIndex([HOYER_RETIRED_STUB, HOYER_ELECTED]);
  assert.equal(
    index.byFecId.get("H2MD05155"),
    HOYER_ELECTED.id,
    "the elected survivor must hold the CAND_ID slot",
  );
  assert.equal(matchRow(HOYER_WEBALL, index)?.officialId, HOYER_ELECTED.id);
});

test("FIX-955 a retired stub is not name-matched when it is the ONLY row left", () => {
  // The survivor is absent from this index, so the only Hoyer is the retired
  // stub and the first names agree perfectly. Pre-fix this returned the stub.
  const index = buildMatchIndex([HOYER_RETIRED_STUB]);
  assert.equal(
    matchRow(HOYER_WEBALL, index),
    null,
    "a retired claim is permanent — skip rather than re-bind the stub",
  );
});

test("FIX-955 the retired row does not count toward name-fallback ambiguity", () => {
  // Survivor carries no id yet (so the byFecId path cannot fire) and must still
  // be reachable by name — the retired sibling must not make the pool ambiguous.
  const survivorNoId = official(
    "e3cc18ef-131d-424b-aa6f-18d7057de207",
    "Steny H. Hoyer",
    "Steny",
    "Hoyer",
    "Representative",
    "MD",
    { congress_gov: "H000874" },
  );
  const index = buildMatchIndex([survivorNoId, HOYER_RETIRED_STUB]);
  assert.equal(
    matchRow(HOYER_WEBALL, index)?.officialId,
    survivorNoId.id,
    "filtering the retired row must not turn a lone survivor into 'ambiguous'",
  );
});

test("FIX-955 retiring one id does not disable an unrelated claim on the same row", () => {
  const twoIds = official(
    "00000000-0000-0000-0000-0000000000d1",
    "Jane Doe",
    "Jane",
    "Doe",
    "Representative",
    "MD",
    { fec_candidate_id: "H2MD09999", merged_fec_candidate_id: "H2MD05155" },
  );
  const index = buildMatchIndex([twoIds]);
  assert.equal(index.byFecId.get("H2MD09999"), twoIds.id, "the live claim still stands");
  assert.equal(index.byFecId.get("H2MD05155"), undefined, "the retired claim does not");
});

// ---------------------------------------------------------------------------
// FIX-960 — the per-cycle weball name-fallback (the SECOND name-resolution
// path; `perCycleNameFallback`, extracted from the cycle loop)
//
// FIX-955 guarded matchRow / buildMatchIndex / persistNewFecIds but NOT this
// loop. On prod (2026-08-02) it re-pooled the freshly id-less FIX-933 stubs
// (its filter was `!fec_candidate_id && !fec_id` only) and its unconditional
// `index.byFecId.set()` stole 79+3 CAND_IDs from their correctly-matched
// elected survivors — $132.9M of duplicate donation rows. Two guards now:
// merge stubs are excluded by merged_fec_candidate_id key-PRESENCE (any id,
// not just the retired one), and an existing byFecId binding is never
// overwritten.
// ---------------------------------------------------------------------------

/** The prod class-(b) shape: a FIX-933 stub, id-less, merge marker only. */
const BANKS_SENATE_STUB: OfficialRecord = {
  ...official(
    "00000000-0000-0000-0000-0000000000f1",
    "Jim Banks",
    "Jim",
    "Banks",
    "Candidate for Senator",
    "IN",
    { merged_fec_candidate_id: "S4IN00196" },
  ),
  tier: "candidate",
};

test("FIX-960 a merge stub is excluded from the fallback pool for its own retired id", () => {
  const index = buildMatchIndex([BANKS_SENATE_STUB]);
  const bound = perCycleNameFallback(
    [BANKS_SENATE_STUB],
    [weball("S4IN00196", "BANKS, JIM", "IN")],
    index,
  );
  assert.deepEqual(bound, [], "a retired claim is permanent — the stub must not re-enter the pool");
  assert.equal(index.byFecId.get("S4IN00196"), undefined);
});

test("FIX-960 a merge stub is excluded even for an id DIFFERENT from its retired one (the Banks shape)", () => {
  // Retired SENATE id on the stub; the weball row carries his old HOUSE id.
  // The exclusion is key-PRESENCE — hasRetiredClaim's id-equality would pass
  // this row straight through, which is exactly how Banks/Budd/Cotton took
  // +$451,756 of duplicated House-stub money on 2026-08-02.
  const index = buildMatchIndex([BANKS_SENATE_STUB]);
  const bound = perCycleNameFallback(
    [BANKS_SENATE_STUB],
    [weball("H6IN03229", "BANKS, JIM", "IN")],
    index,
  );
  assert.deepEqual(bound, [], "the House id must not bind to the Senate merge stub");
  assert.equal(index.byFecId.get("H6IN03229"), undefined);
});

test("FIX-960 the fallback never clobbers an existing byFecId binding", () => {
  // The elected row holds the CAND_ID via the authoritative path; a same-name
  // id-less official must not steal it — and the refused binding must not be
  // RETURNED either, or the caller would persist it via persistNewFecIds.
  const elected = official(
    "00000000-0000-0000-0000-0000000000g1",
    "Brett Guthrie",
    "Brett",
    "Guthrie",
    "Representative",
    "KY",
    { fec_candidate_id: "H8KY02015" },
  );
  const idless = official(
    "00000000-0000-0000-0000-0000000000g2",
    "Brett Guthrie",
    "Brett",
    "Guthrie",
    "Representative",
    "KY",
  );
  const index = buildMatchIndex([elected]);
  const bound = perCycleNameFallback(
    [elected, idless],
    [weball("H8KY02015", "GUTHRIE, BRETT", "KY")],
    index,
  );
  assert.deepEqual(bound, [], "a bound CAND_ID is never re-assigned and never re-reported");
  assert.equal(index.byFecId.get("H8KY02015"), elected.id, "the survivor keeps the slot");
});

test("FIX-960 an id-less official still gets its legitimate fallback binding", () => {
  const ossoff = official(
    "00000000-0000-0000-0000-0000000000o1",
    "Jon Ossoff",
    "Jon",
    "Ossoff",
    "Senator",
    "GA",
    { congress_gov: "O000174" },
  );
  const index = buildMatchIndex([ossoff]);
  const bound = perCycleNameFallback([ossoff], [weball("S8GA00180", "OSSOFF, JON", "GA")], index);
  assert.deepEqual(bound, [{ officialId: ossoff.id, fecId: "S8GA00180" }]);
  assert.equal(index.byFecId.get("S8GA00180"), ossoff.id);
});

test("FIX-960 an official already bound in the index does not re-enter the pool", () => {
  const ossoff = official(
    "00000000-0000-0000-0000-0000000000o1",
    "Jon Ossoff",
    "Jon",
    "Ossoff",
    "Senator",
    "GA",
    { congress_gov: "O000174" },
  );
  const index = buildMatchIndex([ossoff]);
  index.byFecId.set("S8GA00180", ossoff.id); // bound in an earlier cycle
  const bound = perCycleNameFallback([ossoff], [weball("S0GA00999", "OSSOFF, JON", "GA")], index);
  assert.deepEqual(bound, [], "one official never accumulates a second id via the fallback");
});

test("FIX-960 when an elected row and a stub share a name key, elected wins regardless of order", () => {
  // Same tier preference as buildMatchIndex (FIX-941) — without it the
  // outcome depends on officials load order.
  const electedBanks: OfficialRecord = {
    ...official("00000000-0000-0000-0000-0000000000e1", "Jim Banks", "Jim", "Banks", "Senator", "IN"),
    tier: "elected",
  };
  const stubBanks: OfficialRecord = {
    ...official("00000000-0000-0000-0000-0000000000c9", "Jim Banks", "Jim", "Banks", "Candidate for Senator", "IN"),
    tier: "candidate",
  };
  for (const pool of [[electedBanks, stubBanks], [stubBanks, electedBanks]]) {
    const index = buildMatchIndex([]);
    const bound = perCycleNameFallback(pool, [weball("S4IN00196", "BANKS, JIM", "IN")], index);
    assert.equal(index.byFecId.get("S4IN00196"), electedBanks.id, "elected takes the binding");
    assert.deepEqual(bound, [{ officialId: electedBanks.id, fecId: "S4IN00196" }]);
  }
});
