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
import {
  classifyCollision,
  DUPLICATE_BAND_BP,
  firstNameKeyGate,
  withinBand,
  type CollisionFacts,
} from "./adopt-prior-rules";

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "merge-same-person-official-dupes.ts"),
  "utf8",
);
const AUDITS = path.join(__dirname, "..", "..", "..", "..", "docs", "audits");
const SHARED_MANIFEST = path.join(AUDITS, "2026-09-16-fix1187-shared-id-manifest.tsv");
const PROMOTE_MANIFEST = path.join(AUDITS, "2026-09-16-fix1187-office-promotion-manifest.tsv");
const LUJAN_MANIFEST = path.join(AUDITS, "2026-10-05-fix1189-lujan-h-stub-manifest.tsv");

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
  // FIX-1302 moved the key into firstNameKeyGate (./adopt-prior-rules); the
  // gate hands it both keys and refuses on its verdict.
  const body = sharedIdGateBody();
  assert.ok(body.includes("firstNameKeyGate({"));
  assert.ok(body.includes("survivorKey: r.survivor_fkey"));
  assert.ok(body.includes("dupKey: r.dup_fkey"));
  assert.ok(body.includes('if (key.verdict === "refuse")'));
  for (const [s, d] of [[null, "WIL"], ["BIL", null], [null, null]] as const) {
    const v = firstNameKeyGate({ survivorKey: s, dupKey: d, adoption: null, listings: null });
    assert.equal(v.verdict, "refuse");
    assert.match((v as { reason: string }).reason, /^first-name key is undecidable/);
  }
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

// ---------------------------------------------------------------------------
// FIX-1288 (cc-199) — shape C: --adopt-prior
// ---------------------------------------------------------------------------

/** The SQL template passed to run() under `label`, up to its closing backtick. */
function statementAfter(label: string): string {
  const at = SCRIPT.indexOf(`"${label}"`);
  assert.notEqual(at, -1, `the "${label}" statement must exist`);
  const open = SCRIPT.indexOf("`", at);
  const close = SCRIPT.indexOf("`", open + 1);
  return SCRIPT.slice(open + 1, close);
}

/** A `const <name> = \`…\`` SQL template's body. */
function sqlConst(name: string): string {
  const at = SCRIPT.indexOf(`const ${name} = \``);
  assert.notEqual(at, -1, `const ${name} must exist`);
  const open = SCRIPT.indexOf("`", at);
  return SCRIPT.slice(open + 1, SCRIPT.indexOf("`;", open));
}

/** The SET clause of a retire statement: from `SET` through `updated_at = now()`. */
function setClause(sql: string): string {
  const start = sql.indexOf("SET source_ids");
  const end = sql.indexOf("updated_at = now()", start);
  assert.ok(start !== -1 && end !== -1, "a retire statement has a source_ids SET and an updated_at stamp");
  return sql.slice(start, end).replace(/\s+/g, " ").trim();
}

test("FIX-1288 (a) --adopt-prior is refused outside --manifest", () => {
  const msg = SCRIPT.indexOf("✗ --adopt-prior is a --manifest option");
  assert.notEqual(msg, -1, "the refusal text must exist");
  const guard = SCRIPT.slice(SCRIPT.lastIndexOf("if (adoptPrior &&", msg), msg);
  assert.ok(guard.startsWith("if (adoptPrior &&"), "the refusal must be guarded on the flag");
  for (const tok of ["!sharedIdManifestPath", "promoteManifestPath", "pairArg", "ownSeat", "repairResplit"]) {
    assert.ok(guard.includes(tok), `--adopt-prior must be refused with/without ${tok}`);
  }
  // Refused means exit, not a warning that carries on.
  assert.ok(SCRIPT.slice(msg, msg + 200).includes("process.exit(1)"));
});

test("FIX-1288 (b) the gate's adopt branch needs an other-chamber live id AND evidence", () => {
  const body = sharedIdGateBody();
  assert.ok(
    body.includes("s.source_ids->>'fec_candidate_id' AS survivor_fec"),
    "the gate must read the survivor's live id",
  );
  const at = body.indexOf("const adoptable =");
  assert.notEqual(at, -1, "the adopt branch is one named conjunction");
  const expr = body.slice(at, body.indexOf(";", at));
  for (const [term, why] of [
    ["opts.adoptPrior", "only under --adopt-prior"],
    ["r.survivor_fec !== null", "the survivor holds a live id"],
    [".charAt(0).toUpperCase() !== p.fecId.charAt(0).toUpperCase()", "rule 157: the live id is the OTHER chamber's"],
    ["r.survivor_fec !== p.fecId", "the live id is not the pair's id"],
    ['(p.evidence ?? "").trim() !== ""', "rule 42: the evidence cell is the authorisation"],
  ] as const) {
    assert.ok(expr.includes(term), `adopt branch lost ${term} (${why})`);
  }
  // Wrong-but-green guard: an `||` anywhere in the conjunction would let one
  // term stand in for the others.
  assert.equal(/\|\|/.test(expr), false, "the adopt branch is a pure conjunction");
  // It lives INSIDE the not-claimed branch, ahead of today's rejection, which
  // keeps its text for every other unclaimed pair.
  const notClaimed = body.indexOf("if (r.survivor_claims_it !== true)");
  const rejection = body.indexOf(
    "survivor does not claim ${p.fecId} (neither fec_candidate_id nor prior_fec_candidate_ids)",
  );
  assert.ok(notClaimed !== -1 && rejection !== -1);
  assert.ok(notClaimed < at && at < rejection, "adopt is decided inside the unclaimed branch, before the rejection");
  // Every later check still applies to an adopted pair: the branch must not
  // push to `ok` past them.
  assert.equal(body.slice(at, rejection).includes("ok.push"), false, "an adopted pair still runs the later gates");
});

test("FIX-1288 (c) step 1's prior branch appends-if-absent and never writes the live id", () => {
  // The defect first: every statement that writes the manifest id as the
  // survivor's LIVE id must be guarded by the complement of the predicate.
  // Unguarded, a sitting Senator merged with his House stub becomes a House
  // member and S0NM00058 is held by no row.
  const liveWrite = "jsonb_build_object('fec_candidate_id', m.fec_id)";
  for (let at = SCRIPT.indexOf(liveWrite); at !== -1; at = SCRIPT.indexOf(liveWrite, at + 1)) {
    const stmt = SCRIPT.slice(SCRIPT.lastIndexOf("`", at), SCRIPT.indexOf("`", at));
    assert.ok(
      stmt.includes('AND NOT ${survivorKeepsLiveIdSql("o")}'),
      "step 1 writes m.fec_id as the survivor's LIVE id unconditionally — " +
        "an other-chamber survivor would lose its own live id",
    );
  }

  const prior = statementAfter("officials.prior_fec_candidate_ids += fec_id (live kept)");
  assert.ok(prior.includes("'prior_fec_candidate_ids'"));
  assert.ok(
    /COALESCE\(o\.source_ids->'prior_fec_candidate_ids', '\[\]'::jsonb\)\s+\|\| CASE WHEN COALESCE\(o\.source_ids->'prior_fec_candidate_ids','\[\]'::jsonb\)\s+\? m\.fec_id\s+THEN '\[\]'::jsonb\s+ELSE jsonb_build_array\(m\.fec_id\) END/.test(
      prior,
    ),
    "the append-if-absent shape of shape B's prior write",
  );
  assert.equal(prior.includes("'fec_candidate_id'"), false, "the prior branch must not touch fec_candidate_id");
  assert.ok(prior.includes('${survivorKeepsLiveIdSql("o")}'), "the prior branch is keyed on the stated predicate");

  const live = statementAfter("officials.source_ids += fec_candidate_id");
  assert.ok(
    live.includes(
      "SET source_ids = COALESCE(o.source_ids, '{}'::jsonb)\n" +
        "                        || jsonb_build_object('fec_candidate_id', m.fec_id),",
    ),
    "the live branch's write is today's, byte-for-byte",
  );
  // Wrong-but-green guard: both branches on the SAME predicate, one negated.
  // Drop the NOT and an adopt-prior survivor gets both writes.
  assert.ok(live.includes('AND NOT ${survivorKeepsLiveIdSql("o")}'), "the live branch is the complement");

  const pred = SCRIPT.slice(SCRIPT.indexOf("function survivorKeepsLiveIdSql("));
  const predBody = pred.slice(0, pred.indexOf("\n}\n"));
  assert.ok(predBody.includes("->>'fec_candidate_id' IS NOT NULL"));
  assert.ok(predBody.includes("->>'fec_candidate_id' <> m.fec_id"));
  // Stated once: no second hand-written copy of the predicate.
  assert.equal(SCRIPT.split("->>'fec_candidate_id' <> m.fec_id").length - 1, 1);
});

test("FIX-1288 (d) the merge's retire is manifest-scoped + claims-aware; step 0 is unchanged", () => {
  // The defect first: the merge-time retire (after the leftover check, before
  // the ambiguous check) must not be step 0's live-equality statement on a
  // --manifest run. With the survivor's live id kept, live = live never
  // matches, the stub keeps its claim, and the ambiguous check rolls back.
  const leftover = SCRIPT.indexOf("duplicate side still holds");
  // Anchored AFTER the leftover check: step 0's own message also says
  // "duplicate(s) still claim their CAND_ID", and it comes first.
  const ambiguous = SCRIPT.indexOf("the merge would be undone by the next FEC run", leftover);
  assert.ok(leftover !== -1 && ambiguous > leftover, "the leftover check precedes the ambiguous check");
  const retire = SCRIPT.slice(leftover, ambiguous);
  assert.ok(
    retire.includes("reconcileManifestSql"),
    "the merge-time retire is step 0's live-only reconcileSql — an adopt-prior stub keeps its claim",
  );
  assert.ok(retire.includes("sharedIdManifestPath"), "the --manifest run is the branch");

  const manifestRetire = sqlConst("reconcileManifestSql");
  for (const [tok, why] of [
    ["FROM _manifest m", "scoped to this run's pairs"],
    ["JOIN officials s ON s.id = m.survivor", "the survivor is the manifest's, not any elected row"],
    ["d.id = m.dup", "the duplicate is the manifest's"],
    ["d.tier = 'candidate'", "only a candidate stub is retired"],
    ["s.tier = 'elected'", "against an elected survivor"],
    ["d.source_ids->>'fec_candidate_id' = m.fec_id", "the stub still holds the pair's id"],
    ['${authoritativeClaimsJsonb("s")} ? m.fec_id', "the survivor claims it, live OR prior"],
    ["NOT EXISTS (SELECT 1 FROM financial_relationships fr", "the stub holds no money"],
  ] as const) {
    assert.ok(manifestRetire.includes(tok), `reconcileManifestSql lost ${tok} (${why})`);
  }
  // Rule 62: the platform-wide step 0 is NOT widened to prior arrays — that
  // would retire every $0 other-office stub on prod in one pass.
  const step0 = sqlConst("reconcileSql");
  assert.equal(
    step0.replace(/\s+/g, " ").trim(),
    "UPDATE officials d SET source_ids = (d.source_ids - 'fec_candidate_id') || " +
      "jsonb_build_object('merged_fec_candidate_ids', (SELECT jsonb_agg(DISTINCT v) FROM " +
      "jsonb_array_elements_text( COALESCE(d.source_ids->'merged_fec_candidate_ids', '[]'::jsonb) || " +
      "to_jsonb(ARRAY[d.source_ids->>'fec_candidate_id']) ) AS v)), updated_at = now() " +
      "FROM officials s WHERE d.tier = 'candidate' AND s.tier = 'elected' AND s.id <> d.id " +
      "AND d.source_ids->>'fec_candidate_id' IS NOT NULL " +
      "AND s.source_ids->>'fec_candidate_id' = d.source_ids->>'fec_candidate_id' " +
      "AND NOT EXISTS (SELECT 1 FROM financial_relationships fr WHERE fr.to_type = 'official' AND fr.to_id = d.id)",
    "step 0 (reconcileSql) is untouched",
  );
  assert.equal(setClause(manifestRetire), setClause(step0), "the two retires write the same marker");
});

test("FIX-1288 (e) the Luján manifest: four required columns, ONE other-chamber row", () => {
  const m = readManifest(LUJAN_MANIFEST);
  for (const col of ["survivor", "dup", "fec_id", "evidence"]) {
    assert.ok(m.header.includes(col), `the Luján manifest lacks ${col}`);
  }
  assert.equal(m.rows.length, 1);
  const r = m.rows[0]!;
  assert.ok((r["evidence"] ?? "").trim().length > 0, "--adopt-prior refuses an empty evidence cell");
  // The survivor's recorded live id, from the manifest's own comment block —
  // the prod read cc-194 made, not a DB read here.
  const line = m.comments.find((c) => /#\s+survivor\s+/.test(c));
  assert.ok(line, "the comment block records the survivor's live id");
  const live = /\blive\s+([A-Z0-9]{9})\b/.exec(line)?.[1];
  assert.ok(live, "a 9-char CAND_ID after 'live'");
  const short = /#\s+survivor\s+([0-9a-f]{8})/.exec(line)?.[1];
  assert.ok(short && r["survivor"]!.startsWith(short), "the comment names this row's survivor");
  assert.equal(r["fec_id"]![0], "H", "the stub's id is the House id");
  assert.equal(live[0], "S", "the survivor's live id is the Senate id");
  assert.notEqual(live[0], r["fec_id"]![0], "the shape C case: other-chamber live id");
});

// ---------------------------------------------------------------------------
// FIX-1302 (cc-289) — D1: the dataset listing overrides the first-name key
// ---------------------------------------------------------------------------

/** Cassidy's case: C001075 lists both his House and Senate ids. */
const CASSIDY = { bioguide: "C001075", survivorLiveId: "S4LA00107", pairId: "H8LA00017" };
const LISTINGS = new Map<string, readonly string[]>([
  ["C001075", ["H8LA00017", "S4LA00107"]],
  ["B001299", ["S4IN00196"]], // lacks the House id
]);
const BANKS_LACKING = { bioguide: "B001299", survivorLiveId: "S4IN00196", pairId: "H6IN03229" };

test("FIX-1302 D1 a disagreeing key with a listing of BOTH ids is accepted, with the override line", () => {
  const v = firstNameKeyGate({ survivorKey: "BIL", dupKey: "WIL", adoption: CASSIDY, listings: LISTINGS });
  assert.equal(v.verdict, "override");
  const detail = (v as { detail: string }).detail;
  // the line names both keys, the bioguide and the listing
  for (const tok of ["BIL", "WIL", "C001075", "H8LA00017", "S4LA00107"]) {
    assert.ok(detail.includes(tok), `override line lacks ${tok}: ${detail}`);
  }
});

test("FIX-1302 D1 a listing that lacks either id refuses, naming what is missing", () => {
  for (const adoption of [
    BANKS_LACKING, // lacks the pair's id
    { bioguide: "C001075", survivorLiveId: "S9LA99999", pairId: "H8LA00017" }, // lacks the live id
  ]) {
    const v = firstNameKeyGate({ survivorKey: "JIM", dupKey: "JAM", adoption, listings: LISTINGS });
    assert.equal(v.verdict, "refuse");
    const reason = (v as { reason: string }).reason;
    assert.match(reason, /^first names disagree \(JIM vs JAM\)/, "today's refusal leads the reason");
    assert.match(reason, /lacks (H6IN03229|S9LA99999)/);
  }
});

test("FIX-1302 D1 no bioguide, a bioguide the dataset does not list, or no dataset, refuses", () => {
  const noBio = firstNameKeyGate({
    survivorKey: "TED", dupKey: "THE", adoption: { ...CASSIDY, bioguide: null }, listings: LISTINGS,
  });
  assert.equal(noBio.verdict, "refuse");
  assert.match((noBio as { reason: string }).reason, /no bioguide/);
  const unlisted = firstNameKeyGate({
    survivorKey: "TOM", dupKey: "THO", adoption: { ...CASSIDY, bioguide: "X000000" }, listings: LISTINGS,
  });
  assert.equal(unlisted.verdict, "refuse");
  assert.match((unlisted as { reason: string }).reason, /X000000 is not in legislators-current/);
  const unread = firstNameKeyGate({ survivorKey: "BIL", dupKey: "WIL", adoption: CASSIDY, listings: null });
  assert.equal(unread.verdict, "refuse");
});

test("FIX-1302 D1 the flag absent (no adoption) is today's refusal, byte for byte", () => {
  assert.deepEqual(firstNameKeyGate({ survivorKey: "BIL", dupKey: "WIL", adoption: null, listings: LISTINGS }), {
    verdict: "refuse",
    reason: "first names disagree (BIL vs WIL) — a FIX-934 question, not a merge",
  });
  assert.deepEqual(firstNameKeyGate({ survivorKey: "S", dupKey: null, adoption: null, listings: LISTINGS }), {
    verdict: "refuse",
    reason: "first-name key is undecidable (S vs -)",
  });
});

test("FIX-1302 D1 an undecidable key behaves the same way as a disagreeing one", () => {
  const ok = firstNameKeyGate({ survivorKey: null, dupKey: "WIL", adoption: CASSIDY, listings: LISTINGS });
  assert.equal(ok.verdict, "override");
  const lacks = firstNameKeyGate({ survivorKey: null, dupKey: "JAM", adoption: BANKS_LACKING, listings: LISTINGS });
  assert.equal(lacks.verdict, "refuse");
  assert.match((lacks as { reason: string }).reason, /^first-name key is undecidable/);
  const noBio = firstNameKeyGate({
    survivorKey: "BIL", dupKey: null, adoption: { ...CASSIDY, bioguide: null }, listings: LISTINGS,
  });
  assert.equal(noBio.verdict, "refuse");
  assert.deepEqual(firstNameKeyGate({ survivorKey: null, dupKey: "WIL", adoption: null, listings: LISTINGS }), {
    verdict: "refuse",
    reason: "first-name key is undecidable (- vs WIL)",
  });
});

test("FIX-1302 D1 an agreeing key never consults the dataset", () => {
  assert.deepEqual(
    firstNameKeyGate({ survivorKey: "AND", dupKey: "AND", adoption: { ...CASSIDY, bioguide: null }, listings: null }),
    { verdict: "agree" },
  );
});

test("FIX-1302 D1 the gate offers the override to an ADOPTED pair only, and prints one line per override", () => {
  const body = sharedIdGateBody();
  assert.ok(body.includes("NULLIF(s.source_ids->>'congress_gov', '') AS survivor_bioguide"));
  const call = body.slice(body.indexOf("firstNameKeyGate({"), body.indexOf('if (key.verdict === "refuse")'));
  assert.ok(
    /adoption:\s*pair\.cls === "adopt-prior"\s*\?/.test(call),
    "a pair the survivor already claims must never reach the override",
  );
  assert.ok(call.includes(": null"), "every other pair gets no adoption facts");
  // the later gates still run on an overridden pair
  const after = body.slice(body.indexOf('if (key.verdict === "override")'));
  assert.ok(after.includes('r.dup_attachments !== "0"'), "the empty-shell check still follows the override");
  assert.ok(SCRIPT.includes("OVERRIDE ${p.name.padEnd(52)} ${p.override}"));
  // the dataset is read before the merge transaction, never inside it
  const read = SCRIPT.indexOf("await readLegislatorListings(legislatorsFile)");
  assert.ok(read !== -1 && read < SCRIPT.lastIndexOf('await client.query("BEGIN")'));
  assert.ok(SCRIPT.includes("✗ --legislators-file is an --adopt-prior option"));
});

test("FIX-1302 D1 the four refused class-A rows: each evidence listing names both ids", () => {
  // The evidence cells record the listing at ETag W/"6ab4f9aa-166a83"; cc-289
  // re-read the same ETag on 2026-11-16 and found 22/22 list both.
  const m = readManifest(path.join(AUDITS, "2026-10-11-fix1189-class-a-adopt-prior-manifest.tsv"));
  assert.equal(m.rows.length, 22);
  for (const fec of ["H8LA00017", "H6IN03229", "H6NC13129", "H2AR04083"]) {
    const r = m.rows.find((x) => x["fec_id"] === fec);
    assert.ok(r, `${fec} is in the manifest`);
    const ev = r["evidence"]!;
    const listed = /lists ([A-Z0-9, ]+) \(ETag/.exec(ev)?.[1]?.split(", ") ?? [];
    const liveId = /-> live ([A-Z0-9]{9})/.exec(ev)?.[1];
    assert.ok(liveId && listed.includes(liveId) && listed.includes(fec), `${r["name"]}: ${ev}`);
  }
});

// ---------------------------------------------------------------------------
// FIX-1302 (cc-289) — D2: the collision classifier
// ---------------------------------------------------------------------------

const us = (iso: string): bigint => BigInt(Date.parse(iso)) * 1000n;
/** A live pair: the survivor's row refreshed after the stub's row was written. */
const liveFacts = (o: Partial<CollisionFacts>): CollisionFacts => ({
  type: "donation",
  survCents: 500000n,
  dupCents: 1500000n,
  survUpdatedUs: us("2026-09-01T00:00:00Z"),
  dupCreatedUs: us("2026-05-11T00:00:00Z"),
  dupUpdatedUs: us("2026-09-08T00:00:00Z"),
  ...o,
});

test("FIX-1302 D2 stale: the survivor's row predates the stub's row — the fresher row stays", () => {
  // Moore's $62,000 pair (audit §4(c)): survivor last touched 05-01, stub row from 05-11.
  const v = classifyCollision(
    liveFacts({ survCents: 6200000n, dupCents: 6200000n, survUpdatedUs: us("2026-05-01T00:00:00Z") }),
  );
  assert.deepEqual(v, { cls: "stale", keepDup: true });
  // stale wins over every other test, IE included
  assert.equal(classifyCollision(liveFacts({ type: "ie_support", survUpdatedUs: us("2026-05-01T00:00:00Z") })).cls, "stale");
  // the boundary is strict: updated AT the stub's creation instant is not stale…
  assert.notEqual(classifyCollision(liveFacts({ survUpdatedUs: us("2026-05-11T00:00:00Z") })).cls, "stale");
  // …and one microsecond earlier is
  assert.equal(classifyCollision(liveFacts({ survUpdatedUs: us("2026-05-11T00:00:00Z") - 1n })).cls, "stale");
});

test("FIX-1302 D2 ie_duplicate: an IE pair equal or within 2 % — kept once, never summed", () => {
  for (const type of ["ie_support", "ie_oppose"]) {
    assert.deepEqual(classifyCollision(liveFacts({ type, survCents: 21855190n, dupCents: 21855190n })), {
      cls: "ie_duplicate",
      keepDup: true,
    });
  }
  // the fresher row is the one kept: here the survivor's, refreshed after the stub's last write
  assert.deepEqual(
    classifyCollision(
      liveFacts({ type: "ie_support", survCents: 100n, dupCents: 100n, survUpdatedUs: us("2026-10-01T00:00:00Z") }),
    ),
    { cls: "ie_duplicate", keepDup: false },
  );
});

test("FIX-1302 D2 the 2 % edge, both sides", () => {
  // exactly 2 % of the larger is inside the band; one cent more is outside
  assert.equal(classifyCollision(liveFacts({ type: "ie_support", survCents: 1000000n, dupCents: 980000n })).cls, "ie_duplicate");
  assert.equal(classifyCollision(liveFacts({ type: "ie_support", survCents: 1000000n, dupCents: 979999n })).cls, "live");
  // symmetric in which side is larger
  assert.equal(classifyCollision(liveFacts({ type: "ie_oppose", survCents: 980000n, dupCents: 1000000n })).cls, "ie_duplicate");
  assert.equal(classifyCollision(liveFacts({ type: "ie_oppose", survCents: 979999n, dupCents: 1000000n })).cls, "live");
  assert.equal(withinBand(1000000n, 980000n, 200), true);
  assert.equal(withinBand(1000000n, 979999n, 200), false);
});

test("FIX-1302 D2 live: a donation pair EQUAL TO THE CENT is summed, like any live donation pair", () => {
  assert.deepEqual(classifyCollision(liveFacts({ survCents: 250000n, dupCents: 250000n })), { cls: "live", keepDup: false });
  assert.deepEqual(classifyCollision(liveFacts({})), { cls: "live", keepDup: false });
  // an IE pair more than 2 % apart is live too (Gallego 2024 on prod: $52,861 vs $2,694)
  assert.deepEqual(classifyCollision(liveFacts({ type: "ie_support", survCents: 269442n, dupCents: 5286142n })), {
    cls: "live",
    keepDup: false,
  });
});

test("FIX-1302 D2 each of Cowork's two cells is one constant", () => {
  assert.equal(DUPLICATE_BAND_BP.donation, null, "a live donation pair is always summed");
  assert.equal(DUPLICATE_BAND_BP.ie_support, 200, "within 2 % is one IE filing");
  assert.equal(DUPLICATE_BAND_BP.ie_oppose, 200);
});

test("FIX-1302 D2 a live collision of a type the writer does not merge throws", () => {
  assert.throws(() => classifyCollision(liveFacts({ type: "contract" })), /no shape-C merge rule for a live contract/);
  // a stale one of any type keeps today's rule
  assert.equal(classifyCollision(liveFacts({ type: "contract", survUpdatedUs: us("2026-01-01T00:00:00Z") })).cls, "stale");
});

// ---------------------------------------------------------------------------
// FIX-1302 (cc-289) — a pair that is not adopt-prior: today's SQL, unchanged
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

test("FIX-1302 the _collision CTAS and the two loser DELETEs are de65d66's, byte for byte", () => {
  assert.equal(
    norm(collisionCtas()),
    norm(`CREATE TEMP TABLE _collision ON COMMIT DROP AS
        SELECT d.relationship_type,
               s.id AS surv_row, d.id AS dup_row,
               s.updated_at AS surv_upd, d.updated_at AS dup_upd,
               s.amount_cents AS surv_cents, d.amount_cents AS dup_cents,
               (d.updated_at >= s.updated_at) AS keep_dup
          FROM _manifest m
          JOIN financial_relationships d
            ON d.to_type='official' AND d.to_id = m.dup
          JOIN financial_relationships s
            ON s.to_type='official' AND s.to_id = m.survivor
           AND s.relationship_type = d.relationship_type
           AND s.from_id           = d.from_id
           AND s.cycle_year        = d.cycle_year;`),
  );
  assert.equal(
    statementAfter("FR delete colliding losers (survivor side)"),
    "\n      DELETE FROM financial_relationships fr\n       USING _collision c\n" +
      "       WHERE fr.id = c.surv_row AND c.keep_dup",
  );
  assert.equal(
    statementAfter("FR delete colliding losers (duplicate side)"),
    "\n      DELETE FROM financial_relationships fr\n       USING _collision c\n" +
      "       WHERE fr.id = c.dup_row AND NOT c.keep_dup",
  );
});

test("FIX-1302 only an adopt-prior pair's collisions are classed; nothing else reads a class", () => {
  // The fill is guarded on the adopted dups, and is the ONLY write to _collision_class.
  assert.ok(SCRIPT.includes('const adoptDups = pairs.filter((p) => p.cls === "adopt-prior").map((p) => p.dup);'));
  assert.equal(SCRIPT.split("INSERT INTO _collision_class").length - 1, 1);
  const fill = SCRIPT.slice(SCRIPT.indexOf("if (adoptDups.length > 0) {"), SCRIPT.indexOf("FIX-1302 D3 — the table"));
  assert.ok(fill.includes("INSERT INTO _collision_class"), "the fill sits inside the adopt-only branch");
  assert.ok(fill.includes("WHERE d.to_id = ANY($1::uuid[])"), "keyed on the adopted stubs");
  // keep_dup is rewritten only through a join to _collision_class: a pair with
  // no class row keeps the CTAS's (d.updated_at >= s.updated_at)
  const rewrite = fill.slice(fill.indexOf("UPDATE _collision c SET keep_dup"));
  assert.ok(rewrite.includes("FROM _collision_class k WHERE k.dup_row = c.dup_row"));
  // the live sum touches only rows classed live, and runs before the deletes
  const sum = statementAfter("FR sum live collisions onto the survivor row");
  assert.ok(sum.includes("JOIN _collision_class k ON k.dup_row = c.dup_row AND k.cls = 'live'"));
  assert.ok(
    SCRIPT.indexOf('"FR sum live collisions onto the survivor row"') <
      SCRIPT.indexOf('"FR delete colliding losers (survivor side)"'),
    "the stub's amounts are read before its row is deleted",
  );
  // the writer's merge: sum amount, sum tx_count, the later occurred_at
  assert.ok(sum.includes("COALESCE(s.amount_cents, 0) + COALESCE(d.amount_cents, 0)"));
  assert.ok(sum.includes("'tx_count'"));
  assert.ok(sum.includes("GREATEST(s.occurred_at, d.occurred_at)"));
  assert.equal(/updated_at/.test(sum), false, "updated_at is the trigger's, as for a moved row");
});

test("FIX-1302 D3 conservation is per type over donation and both IE types", () => {
  const sql = sqlConst("MANIFEST_MONEY_SQL");
  assert.ok(sql.includes("GROUP BY 1"));
  assert.ok(sql.includes("SUMMABLE_TYPES"));
  assert.ok(SCRIPT.includes("before - after - deleted - trio"), "each type's drop equals exactly its deleted losers");
  assert.ok(SCRIPT.includes("const dropOk = money.every((m) => m.delta === 0n);"));
  // a summed live pair is not a deleted loser
  assert.ok(SCRIPT.includes("sum(CASE WHEN k.cls = 'live' THEN 0"));
});
