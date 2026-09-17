/**
 * FIX-1187 — structural tests for the shared-CAND_ID manifest path in
 * merge-same-person-official-dupes.ts, and shape checks on the two committed
 * manifests.
 *
 * These lock the invariants the 151-pair apply rests on. They are structural
 * because the behaviour itself was exercised end-to-end on the local prod-clone
 * (two dry runs, 2026-09-16: 151/151 pairs accepted with conservation $0, and
 * 5/5 promotions with conservation $0) — what a unit test can add on top of that
 * is a guard against the gates silently drifting back.
 *
 * Runs via:  tsx --test src/scripts/merge-shared-id.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { readManifest } from "./remediation-manifest";

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "merge-same-person-official-dupes.ts"),
  "utf8",
);
const AUDITS = path.join(__dirname, "..", "..", "..", "..", "docs", "audits");
const SHARED_MANIFEST = path.join(AUDITS, "2026-09-16-fix1187-shared-id-manifest.tsv");
const PROMOTE_MANIFEST = path.join(AUDITS, "2026-09-16-fix1187-office-promotion-manifest.tsv");

/** The body of verifySharedIdInDb, up to the next top-level function. */
function sharedIdGateBody(): string {
  const start = SCRIPT.indexOf("async function verifySharedIdInDb(");
  assert.notEqual(start, -1, "verifySharedIdInDb must exist");
  const end = SCRIPT.indexOf("\nasync function verifyOwnSeatInDb(", start);
  assert.notEqual(end, -1, "verifyOwnSeatInDb must still follow it");
  return SCRIPT.slice(start, end);
}

// ---------------------------------------------------------------------------
// The gate: what it checks, and what it deliberately does not
// ---------------------------------------------------------------------------

test("FIX-1187 the shared-id gate applies NO seat gate — that is the whole point", () => {
  const body = sharedIdGateBody();
  // The own-seat gate's three tests, by the tokens that implement them.
  assert.equal(
    /roleMayHoldFecOffice/.test(body),
    false,
    "an office-char test would refuse the five office-changed pairs",
  );
  assert.equal(
    /survivor_district|district mismatch|slice\(4, 6\)/.test(body),
    false,
    "a district-digit test would refuse the 29 redistricted pairs",
  );
  assert.equal(
    /survivor_state/.test(body),
    false,
    "a state-chars test belongs to the seat gate, not to id-selected identity",
  );
});

test("FIX-1187 the shared-id gate keeps every identity and safety check", () => {
  const body = sharedIdGateBody();
  for (const [token, why] of [
    ["survivor_tier", "survivor must be tier elected"],
    ["dup_tier", "dup must be tier candidate"],
    ["survivor_active", "survivor must be is_active"],
    ["dup_fec", "dup's live CAND_ID must still be the manifest's"],
    ["survivor_claims_it", "survivor must authoritatively claim the id"],
    ["survivor_fkey", "FIX-929 first-name key"],
    ["dup_attachments", "decision-5 attachment gate"],
  ] as const) {
    assert.ok(body.includes(token), `shared-id gate lost its ${token} check (${why})`);
  }
});

test("FIX-1187 a candidate-vs-candidate pair cannot pass — survivor must be elected", () => {
  const body = sharedIdGateBody();
  assert.ok(
    body.includes('r.survivor_tier !== "elected"'),
    "the two candidate-vs-candidate shared-id pairs on the clone are reported, never selected",
  );
});

test("FIX-1187 an attachment-carrying stub is REFUSED, not warned", () => {
  const body = sharedIdGateBody();
  assert.ok(body.includes('r.dup_attachments !== "0"'));
  assert.ok(
    body.includes("FIX-1020"),
    "the refusal names the FIX that owns the re-anchor step it would need",
  );
  // FIX-940's lesson: a hard refusal, so the branch must `continue`, not warn.
  const idx = body.indexOf('r.dup_attachments !== "0"');
  assert.ok(body.slice(idx, idx + 400).includes("rejected.push"));
});

test("FIX-1187 the identity test accepts a PRIOR-office claim, not just the current id", () => {
  const body = sharedIdGateBody();
  assert.ok(
    body.includes('authoritativeClaimsJsonb("s")'),
    "after an office promotion the House id lives in prior_fec_candidate_ids",
  );
});

test("FIX-1187 an undecidable first-name key is refused, never read as agreement", () => {
  const body = sharedIdGateBody();
  assert.ok(body.includes("first-name key is undecidable"));
  assert.ok(body.includes("!r.survivor_fkey || !r.dup_fkey"));
});

// ---------------------------------------------------------------------------
// The FIX-1165 prod guard
// ---------------------------------------------------------------------------

test("FIX-1187 the prod guard accepts both manifest flags and still refuses a bare run", () => {
  const guard = SCRIPT.slice(
    SCRIPT.indexOf("if (\n    prod && !pairArg"),
    SCRIPT.indexOf("if (prod && !allowProd)"),
  );
  assert.ok(guard.includes("!sharedIdManifestPath"), "--manifest must exempt the guard");
  assert.ok(guard.includes("!promoteManifestPath"), "--promote-manifest must exempt the guard");
  assert.ok(guard.includes("prod && !pairArg"), "a bare prod run is still refused");
  assert.equal(
    /!ownSeat/.test(guard),
    false,
    "--own-seat DERIVES its population and must stay non-exempt",
  );
});

test("FIX-1187 --manifest and --promote-manifest are mutually exclusive", () => {
  assert.ok(SCRIPT.includes("if (sharedIdManifestPath && promoteManifestPath)"));
  assert.ok(SCRIPT.includes("are separate SETS"));
});

// ---------------------------------------------------------------------------
// Shape B — the promotion write
// ---------------------------------------------------------------------------

test("FIX-1187 the promotion write runs INSIDE the merge transaction, before the gates", () => {
  const begin = SCRIPT.indexOf('await client.query("BEGIN");');
  const promote = SCRIPT.indexOf("officials.source_ids: promote current_id, prior_id → array");
  const verify = SCRIPT.indexOf("const { ok: pairs, rejected } = repairResplit");
  assert.ok(begin > 0 && promote > begin, "the rewrite must be inside the transaction");
  assert.ok(
    promote < verify,
    "verifySharedIdInDb asks whether the survivor claims the SENATE id — only true after the rewrite",
  );
});

test("FIX-1187 the prior array is appended to, never replaced", () => {
  assert.ok(
    SCRIPT.includes("COALESCE(o.source_ids->'prior_fec_candidate_ids', '[]'::jsonb)\n                               || CASE WHEN"),
    "a member who changed office twice must keep both earlier ids",
  );
});

test("FIX-1187 a promotion whose live fec_candidate_id disagrees stops the whole set", () => {
  assert.ok(SCRIPT.includes("refusing the whole set"));
  assert.ok(
    SCRIPT.includes("IS DISTINCT FROM p.prior_id"),
    "the pre-write gate is keyed on live state, not on the manifest alone",
  );
});

// ---------------------------------------------------------------------------
// The committed manifests
// ---------------------------------------------------------------------------

test("FIX-1187 the shared-id manifest is 151 rows and carries the old seat verdict", () => {
  const m = readManifest(SHARED_MANIFEST);
  assert.equal(m.rows.length, 151);
  for (const col of ["survivor", "dup", "fec_id", "old_seat_verdict", "attachments"]) {
    assert.ok(m.header.includes(col), `manifest lost column ${col}`);
  }
  const verdicts = new Map<string, number>();
  for (const r of m.rows) verdicts.set(r["old_seat_verdict"]!, (verdicts.get(r["old_seat_verdict"]!) ?? 0) + 1);
  assert.equal(verdicts.get("pass"), 117);
  assert.equal(verdicts.get("fail-district"), 29);
  assert.equal(verdicts.get("fail-office"), 5);
});

test("FIX-1187 the manifest genuinely contains seat-gate FAILURES that this path accepts", () => {
  // Mast is the design's worked example: H6FL18097 encodes FL-18, the district
  // of first registration; he now sits for FL-21. The old gate refuses him; the
  // shared-id path takes him, because identity is the CAND_ID.
  const m = readManifest(SHARED_MANIFEST);
  const mast = m.rows.find((r) => r["fec_id"] === "H6FL18097");
  assert.ok(mast, "Mast must be in the manifest");
  assert.equal(mast["old_seat_verdict"], "fail-district");
});

test("FIX-1187 every shared-id stub carries ZERO attachments", () => {
  const m = readManifest(SHARED_MANIFEST);
  const withAttachments = m.rows.filter((r) => r["attachments"] !== "0");
  assert.deepEqual(
    withAttachments.map((r) => r["name"]),
    [],
    "a stub with attachments is FIX-1020's class and must not be in an authorisation",
  );
});

test("FIX-1187 the shared-id manifest is 1:1 — no id on both sides, neither side repeating", () => {
  const m = readManifest(SHARED_MANIFEST);
  const survivors = m.rows.map((r) => r["survivor"]!);
  const dups = m.rows.map((r) => r["dup"]!);
  assert.equal(new Set(survivors).size, 151, "_manifest.survivor is a PRIMARY KEY");
  assert.equal(new Set(dups).size, 151, "_manifest.dup is UNIQUE");
  assert.equal(survivors.filter((s) => dups.includes(s)).length, 0, "no chains");
});

test("FIX-1187 the office-promotion manifest is 5 rows, each with evidence", () => {
  const m = readManifest(PROMOTE_MANIFEST);
  assert.equal(m.rows.length, 5);
  for (const r of m.rows) {
    assert.ok((r["evidence"] ?? "").trim().length > 0, `${r["survivor_name"]} has no evidence`);
    assert.ok(r["evidence"]!.includes("OpenFEC"), "evidence names the source it was checked against");
    assert.equal(r["current_id"]![0], "S", "current_id is the SENATE id");
    assert.equal(r["prior_id"]![0], "H", "prior_id is the HOUSE id");
    assert.ok(r["evidence"]!.includes(r["current_id"]!), "evidence quotes the id it verifies");
  }
});

test("FIX-1187 the five House stubs ride set 1, and are NOT merged by set 2", () => {
  // The 1:1 invariant: two stubs for one survivor in one _manifest would move
  // both stubs' colliding rows onto the survivor and violate
  // financial_relationships_relcycle_unique.
  const promote = readManifest(PROMOTE_MANIFEST);
  const shared = readManifest(SHARED_MANIFEST);
  const sharedDups = new Set(shared.rows.map((r) => r["dup"]));
  for (const r of promote.rows) {
    assert.ok(
      sharedDups.has(r["house_stub"]),
      `${r["survivor_name"]}'s House stub must be a set-1 pair`,
    );
    assert.equal(
      sharedDups.has(r["senate_stub"]),
      false,
      `${r["survivor_name"]}'s Senate stub must NOT also be in set 1`,
    );
  }
});

// ---------------------------------------------------------------------------
// FIX-1192 — the _collision CTAS drives from the stub side
// ---------------------------------------------------------------------------

/** The _collision CTAS body, from CREATE to its terminating semicolon. */
function collisionCtas(): string {
  const start = SCRIPT.indexOf("CREATE TEMP TABLE _collision ON COMMIT DROP AS");
  assert.notEqual(start, -1, "the _collision CTAS must exist");
  const end = SCRIPT.indexOf("CREATE INDEX ON _collision(surv_row);", start);
  assert.notEqual(end, -1, "the surv_row index must still follow the CTAS");
  return SCRIPT.slice(start, end);
}

test("FIX-1192 _collision joins the STUB side (m.dup) FIRST, not the survivor", () => {
  const ctas = collisionCtas();
  const dupJoin  = ctas.indexOf("d.to_id = m.dup");
  const survJoin = ctas.indexOf("s.to_id = m.survivor");
  assert.notEqual(dupJoin,  -1, "the CTAS must still bind the stub side to m.dup");
  assert.notEqual(survJoin, -1, "the CTAS must still bind the survivor side to m.survivor");

  // THE invariant. Driving from the survivor materialises a sitting member's
  // whole career before probing the stub; measured on the local prod-clone
  // (2026-09-17, 151-pair manifest) that leg builds 573,884 rows / 252,812
  // block reads against 99,217 rows / 54,429 reads for the stub-driven form.
  // On prod it cost 97 minutes (FIX-1192). A refactor that reorders these two
  // JOINs silently reinstates that cost, so the order is asserted, not trusted.
  assert.ok(
    dupJoin < survJoin,
    "financial_relationships must be joined on m.dup BEFORE m.survivor (FIX-1192)",
  );
});

test("FIX-1192 the _collision output contract is unchanged", () => {
  const ctas = collisionCtas();
  // Every column the three consumers read: the census print (relationship_type,
  // dup_upd/surv_upd, keep_dup, surv_cents/dup_cents) and the two loser DELETEs
  // (surv_row, dup_row, keep_dup). Flipping the join must not drop or rename one.
  for (const col of [
    "relationship_type",
    "surv_row", "dup_row",
    "surv_upd", "dup_upd",
    "surv_cents", "dup_cents",
    "keep_dup",
  ]) {
    assert.ok(ctas.includes(col), `_collision must still emit ${col}`);
  }
  // keep_dup's tie-break direction is load-bearing: >= keeps the DUP on a tie.
  assert.ok(
    ctas.includes("(d.updated_at >= s.updated_at) AS keep_dup"),
    "keep_dup must stay (d.updated_at >= s.updated_at)",
  );
});

test("FIX-1165 the ANALYZE that feeds the planner survives the FIX-1192 reorder", () => {
  // The reorder only changes which side the planner is ASKED to drive from;
  // without statistics on _manifest it is still free to ignore the request.
  const start = SCRIPT.indexOf("ANALYZE _manifest;");
  assert.notEqual(start, -1, "ANALYZE _manifest must still run before the CTAS");
  assert.ok(
    start < SCRIPT.indexOf("CREATE TEMP TABLE _collision ON COMMIT DROP AS"),
    "ANALYZE _manifest must precede the _collision CTAS",
  );
  assert.ok(SCRIPT.includes("ANALYZE _trio;"), "ANALYZE _trio must still run too");
});
