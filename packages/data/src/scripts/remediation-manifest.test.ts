/**
 * FIX-1165 — anchors for the manifest seam and the tail cost table.
 *
 * Runs via:  tsx --test src/scripts/remediation-manifest.test.ts
 *
 * Everything pinned here has already cost prod something once. On 2026-09-07 a
 * 28-row remediation produced 202 statement cancellations at the front door
 * against a baseline of 1, and the two causes were (a) a full audit-scan
 * derivation running on prod for a population that was already known, and (b) a
 * tail that ran platform-scoped rebuilds for a manifest-scoped change. The tests
 * below are the parts of that which can be checked without a database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  declareRemediationTail,
  GHA_OWNERS,
  ownerColumns,
  OWNER_THIS_RUN,
  deferredUnder,
  diffActionable,
  diffVerdict,
  manifestColumn,
  readManifest,
  tailStep,
  type DiffInput,
} from "./remediation-manifest";

// ---------------------------------------------------------------------------
// Tail classes
// ---------------------------------------------------------------------------

test("--defer-tails defers both platform classes and never the manifest class", () => {
  assert.equal(deferredUnder("manifest", true), false);
  assert.equal(deferredUnder("platform-owned", true), true);
  assert.equal(deferredUnder("platform-orphan", true), true);

  // Without the flag nothing defers — the local run keeps its full tail, which
  // is FIX-943's standing bulk-rewrite convention and still right there.
  assert.equal(deferredUnder("manifest", false), false);
  assert.equal(deferredUnder("platform-owned", false), false);
  assert.equal(deferredUnder("platform-orphan", false), false);
});

test("a step that is not manifest-scoped must name an owner or declare itself an orphan", () => {
  // The failure this prevents: rebuild_financial_entity_ie_totals() sat in two
  // tails for months with no owner recorded anywhere, so nothing could tell that
  // its 28 minutes on prod were unowned rather than necessary.
  assert.throws(() => tailStep("x()", "platform-owned", null, false), /must name an owner/);
  assert.throws(() => tailStep("x()", "manifest", "", false), /must name an owner/);
  assert.throws(
    () => tailStep("x()", "platform-orphan", "someone", false),
    /carries no owner/,
  );
  assert.equal(tailStep("x()", "platform-orphan", null, false).owner, null);
});

test("deferred is derived from the class, never hand-set", () => {
  assert.equal(tailStep("a", "manifest", "this run", true).deferred, false);
  assert.equal(tailStep("b", "platform-owned", "some-job", true).deferred, true);
});

// ---------------------------------------------------------------------------
// The declared tail vs what the scripts actually execute
// ---------------------------------------------------------------------------

/**
 * The table is only worth printing if it is COMPLETE. A step that runs without
 * appearing in it is exactly how a platform-scoped rebuild stayed invisible
 * through two prompts, so this reads the three remediation scripts' source and
 * asserts every step label they execute is declared.
 *
 * Source-reading rather than mocking is deliberate: the thing being guarded is
 * that someone adds a step to runRollups and forgets the declaration, and a mock
 * of runRollups would not notice that.
 */
const SCRIPTS = [
  "remediate-role-ineligible-holders.ts",
  "remediate-cross-person-misattribution.ts",
  "merge-same-person-official-dupes.ts",
];

test("every executed tail step appears in the declared tail table", () => {
  const declared = new Set(declareRemediationTail(true).map((s) => s.label));

  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");

    // The SQL these scripts hand to budgeted()/step() for platform-scoped work
    // is always a bare SELECT/CALL of a zero-argument function. That shape is
    // what makes a step platform-scoped in the first place — no argument means
    // no way to know what this run touched — so it is also the right thing to
    // scan for.
    const called = new Set<string>();
    for (const m of src.matchAll(/`(?:SELECT|CALL) (\w+)\(\)`/g)) {
      called.add(`${m[1]}()`);
    }
    for (const m of src.matchAll(/`VACUUM \(ANALYZE\) public\.\$\{(\w+)\}`/g)) {
      // The vacuum loop is table-driven; its labels come from CHURNED_TABLES.
      void m;
      for (const t of ["financial_relationships", "entity_connections", "officials", "financial_entities"]) {
        called.add(`VACUUM ANALYZE ${t}`);
      }
    }

    // The MV loop calls its steps through `SELECT ${fn}()`, so the literal scan
    // above cannot see them. Read MV_REFRESH_FNS itself.
    const mvBlock = src.match(/const MV_REFRESH_FNS = \[([^\]]+)\]/);
    if (mvBlock) {
      for (const m of mvBlock[1]!.matchAll(/"(\w+)"/g)) called.add(`${m[1]}()`);
    }

    assert.ok(
      called.size >= 4,
      `${file}: the source scan found only ${called.size} tail step(s). The scan ` +
        `shape must have drifted — a vacuously-passing completeness test is worse ` +
        `than none.`,
    );

    for (const label of called) {
      assert.ok(
        declared.has(label),
        `${file} executes ${label} but declareRemediationTail() does not declare it. ` +
          `Add it with its cost class and owner — an undeclared step is one nobody can cost.`,
      );
    }
  }
});

/**
 * FIX-1183 — every fr-rewrite landing script prints the tail table BEFORE its
 * go-ahead point.
 *
 * FIX-1165 (c) shipped this behaviour into three scripts and the fourth,
 * remediate-fec-emit-residue.ts, silently did not have it: its dry run printed
 * the TO DELETE figure and then `DRY RUN -- nothing written`, with no cost
 * table anywhere. Nothing caught it, because the test above asks whether every
 * EXECUTED step is DECLARED, and a script that never prints the declaration
 * passes that question vacuously.
 *
 * The script list is DERIVED, not written down: any file in this directory that
 * calls drainFrRewrite() is an fr-rewrite landing script and is held to the
 * rule. Hard-coding the list is what let the fourth script sit outside it.
 */
const FR_REWRITE_SCRIPTS = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .filter((f) => /await drainFrRewrite\(/.test(fs.readFileSync(path.join(__dirname, f), "utf8")))
  .sort();

test("the fr-rewrite landing scripts are found by source scan, and there are four", () => {
  // A guard on the guard: if the scan shape drifts the tests below pass over an
  // empty list and assert nothing, which is worse than not having them.
  assert.deepEqual(FR_REWRITE_SCRIPTS, [
    "merge-same-person-official-dupes.ts",
    "remediate-cross-person-misattribution.ts",
    "remediate-fec-emit-residue.ts",
    "remediate-role-ineligible-holders.ts",
  ]);
});

test("every fr-rewrite landing script prints the tail table before its go-ahead point", () => {
  for (const file of FR_REWRITE_SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");

    const printAt = src.indexOf(
      "printTailTable(declareRemediationTail(defer), defer, owners)",
    );
    assert.ok(
      printAt > -1,
      `${file} calls drainFrRewrite() but never calls printTailTable(). FIX-1165 (c): ` +
        `the tail's cost must be visible at decision time, not discovered at minute 28.`,
    );

    // FIX-1193 - the schedule/guarded columns are only populated when the
    // owners map is read first. A call that passes `owners` without reading it
    // would not compile, but a call that drops the third argument compiles fine
    // and silently prints `?` in both columns, which is the shape this pins.
    const readAt = src.indexOf("readOwnerSchedules(client)");
    assert.ok(
      readAt > -1 && readAt < printAt,
      `${file}: readOwnerSchedules(client) must be called before printTailTable() ` +
        `(${readAt} vs ${printAt}). Without it the schedule/guarded columns render ` +
        `'?', which reads as 'nothing owns this' to anyone who did not write it.`,
    );

    const mainAt = src.indexOf("async function main(");
    assert.ok(mainAt > -1, `${file}: no main() found — has the shape changed?`);
    assert.ok(
      printAt > mainAt,
      `${file}: printTailTable() is called outside main(). It has to run on the path the ` +
        `operator actually takes, not from a helper nothing calls on a dry run.`,
    );

    // The go-ahead is the manifest transaction — the LAST BEGIN in the file.
    // Deliberately not the FIRST: merge-same-person-official-dupes opens and
    // closes an unrelated step-0 bookkeeping transaction well before the
    // manifest is even built, and anchoring to that would fail a script that is
    // in fact correct.
    const lastBegin = src.lastIndexOf('await client.query("BEGIN")');
    assert.ok(lastBegin > mainAt, `${file}: no manifest transaction found after main()`);
    assert.ok(
      printAt < lastBegin,
      `${file}: printTailTable() sits AFTER the manifest transaction opens ` +
        `(${printAt} vs ${lastBegin}). A cost table printed once the run is already ` +
        `writing is a receipt, not a decision.`,
    );

    // And it must be on the DRY-RUN path too: every --apply early-return has to
    // come after it, or the table only ever prints for a run that was already
    // going ahead. This is the half FIX-1183 was missing.
    for (const m of src.matchAll(/if \(!apply\) \{/g)) {
      assert.ok(
        m.index! > printAt,
        `${file}: a dry-run return at ${m.index} precedes printTailTable() at ${printAt}. ` +
          `The dry run is where the go-ahead is given; it is the run that most needs the table.`,
      );
    }
  }
});

test("no fr-rewrite landing script prints the tail table twice", () => {
  // drainFrRewrite prints its own table unless told not to. A script that prints
  // above the go-ahead AND lets the drain print gets two tables on the apply
  // path, which trains the reader to skip both.
  for (const file of FR_REWRITE_SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const call = src.slice(src.indexOf("await drainFrRewrite("));
    const opts = call.slice(0, call.indexOf("\n    );"));
    assert.match(
      opts,
      /printTable:\s*false/,
      `${file}: drainFrRewrite() must be passed printTable: false — the script already ` +
        `printed the table above its go-ahead point.`,
    );
  }
});

test("the two steps FIX-1165 found unowned are declared, deferred, and owned", () => {
  const tail = declareRemediationTail(true);
  const byLabel = new Map(tail.map((s) => [s.label, s]));

  const ie = byLabel.get("rebuild_financial_entity_ie_totals()");
  assert.ok(ie, "rebuild_financial_entity_ie_totals() must be declared");
  assert.equal(ie.cls, "platform-owned");
  assert.match(ie.owner ?? "", /fec-bulk/);
  assert.equal(ie.deferred, true, "it ran 28 min on a 28-row manifest; it must defer");

  const gdr = byLabel.get("refresh_group_donor_rollup()");
  assert.ok(gdr, "refresh_group_donor_rollup() must be declared");
  assert.equal(gdr.cls, "platform-owned");
  assert.match(
    gdr.owner ?? "",
    /group-donor-rollup-refresh/,
    "FIX-1165 gave it a scheduled owner; the table must name that job",
  );
  assert.equal(gdr.deferred, true);
});

test("under --defer-tails nothing platform-scoped runs", () => {
  const here = declareRemediationTail(true).filter((s) => !s.deferred);
  assert.ok(here.length > 0, "the manifest-scoped rollups always run");
  for (const s of here) {
    assert.equal(
      s.cls,
      "manifest",
      `${s.label} runs under --defer-tails but its cost is not the manifest's`,
    );
  }
});

/**
 * The gap this closes, and it is a gap the test above did NOT catch.
 *
 * "Every executed step is declared" is necessary and not sufficient: a step can
 * be correctly declared as platform-owned-and-deferred and still execute,
 * because declaring is done in one file and gating in another. That is exactly
 * what happened. merge-same-person-official-dupes carried a SECOND
 * MV_REFRESH_FNS loop inside runRollups with no `defer` guard at all, so all six
 * platform-scoped MV refreshes ran even with --defer-tails passed -- and ran
 * TWICE without it, because main() also calls runMvsAndVacuum, which owns phase
 * 3 and iterates the same list behind a correct guard. It was found by watching
 * refresh_official_sector_dollars_mv() start during the set-3 prod apply on
 * 2026-09-08, not by any test.
 *
 * The structural invariant that makes it impossible to reintroduce: the MV loop
 * belongs to runMvsAndVacuum and to nowhere else. One loop per script, inside
 * the function named for the phase, which is the function that carries the
 * guard.
 */
test("the MV refresh loop lives only in runMvsAndVacuum, exactly once per script", () => {
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");

    const loops = [...src.matchAll(/for \(const fn of MV_REFRESH_FNS\)/g)];
    assert.equal(
      loops.length,
      1,
      `${file}: expected exactly ONE MV_REFRESH_FNS loop, found ${loops.length}. ` +
        `A second one is how six platform-scoped refreshes ran under --defer-tails.`,
    );

    // The nearest function declaration above the loop must be runMvsAndVacuum.
    const at = loops[0]!.index!;
    const before = src.slice(0, at);
    const fns = [...before.matchAll(/(?:async )?function (\w+)/g)];
    const enclosing = fns.length ? fns[fns.length - 1]![1] : "(none)";
    assert.equal(
      enclosing,
      "runMvsAndVacuum",
      `${file}: the MV loop sits in ${enclosing}(), not runMvsAndVacuum(). ` +
        `Phase 3 is runMvsAndVacuum's job and it is where the defer guard lives; ` +
        `a loop anywhere else runs unguarded.`,
    );
  }
});

test("runMvsAndVacuum short-circuits before its MV loop when deferring", () => {
  // The guard itself, asserted rather than assumed: the deferred path must
  // return before reaching the loop, not merely log something.
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const start = src.indexOf("async function runMvsAndVacuum");
    assert.ok(start > -1, `${file}: runMvsAndVacuum not found`);
    const loopAt = src.indexOf("for (const fn of MV_REFRESH_FNS)", start);
    assert.ok(loopAt > start, `${file}: MV loop not found after runMvsAndVacuum`);

    const head = src.slice(start, loopAt);
    assert.match(
      head,
      /if \(defer\)[\s\S]*?return;/,
      `${file}: runMvsAndVacuum must RETURN on defer before reaching the MV loop`,
    );
  }
});

// ---------------------------------------------------------------------------
// Clone-vs-prod diff
// ---------------------------------------------------------------------------

const d = (expectedRows: number, actualRows: number): DiffInput => ({
  key: "k",
  expectedRows,
  expectedCents: expectedRows * 100,
  actualRows,
  actualCents: actualRows * 100,
});

test("diff verdicts", () => {
  assert.equal(diffVerdict(d(10, 10)), "match");
  assert.equal(diffVerdict(d(10, 4)), "shrunk");
  assert.equal(diffVerdict(d(10, 12)), "grown");
  assert.equal(diffVerdict(d(10, 0)), "gone");
  // A manifest row that recorded zero and still finds zero is 'gone', not
  // 'match' — FIX-1164's id-carriers hold no FR rows by definition and must not
  // be reported as a clean match on a delete that has nothing to delete.
  assert.equal(diffVerdict(d(0, 0)), "gone");
});

test("a key that GREW is not actionable — the manifest never authorised those rows", () => {
  assert.equal(diffActionable("match"), true);
  assert.equal(diffActionable("shrunk"), true, "someone already acted; act on what is here");
  assert.equal(diffActionable("grown"), false);
  assert.equal(diffActionable("gone"), false);
});

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function withTempManifest(body: string, fn: (p: string) => void): void {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix1165-")), "m.tsv");
  fs.writeFileSync(p, body, "utf8");
  try {
    fn(p);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
}

test("readManifest skips comments and blank lines, keeps the comments", () => {
  // The FIX-928 manifest is mostly `#` commentary and it carries the disposition
  // rationale, so comments are retained rather than dropped.
  withTempManifest(
    "# note one\n\nofficial_id\tfec_rows\n" + "a\t3\n" + "# trailing note\n" + "b\t4\n",
    (p) => {
      const m = readManifest(p);
      assert.deepEqual(m.header, ["official_id", "fec_rows"]);
      assert.equal(m.rows.length, 2);
      assert.equal(m.rows[0]!["official_id"], "a");
      assert.equal(m.rows[1]!["fec_rows"], "4");
      assert.deepEqual(m.comments, ["# note one", "# trailing note"]);
    },
  );
});

test("manifestColumn de-duplicates, preserves order, and refuses a missing column", () => {
  withTempManifest("official_id\n" + "a\nb\na\n", (p) => {
    const m = readManifest(p);
    assert.deepEqual(manifestColumn(m, "official_id"), ["a", "b"]);
    assert.throws(() => manifestColumn(m, "nope"), /has no column "nope"/);
  });
});

test("the real FIX-1153 manifest parses to the numbers the prompt was written against", () => {
  // A regression anchor on the artefact itself: 84 officials, 2,736 FR rows,
  // CROSS 2,733 / ONLY-COPY 3, $11,300 of only-copy money. If this file is ever
  // regenerated, these are the numbers the set-1 go-ahead was given against.
  const p = path.join(
    __dirname,
    "../../../../docs/audits/2026-09-07-fix1153-role-ineligible-holders.tsv",
  );
  if (!fs.existsSync(p)) return; // the manifest is an artefact, not a build input
  const m = readManifest(p);
  assert.equal(m.rows.length, 84);
  const sum = (col: string) => m.rows.reduce((a, r) => a + Number(r[col] ?? 0), 0);
  assert.equal(sum("fec_rows"), 2736);
  assert.equal(sum("cross_rows"), 2733);
  assert.equal(sum("only_rows"), 3);
  assert.equal(sum("only_cents"), 1130000);
  assert.equal(manifestColumn(m, "official_id").length, 84);
});

// ---------------------------------------------------------------------------
// FIX-1193 — the schedule / guarded columns
// ---------------------------------------------------------------------------

const OWNERS: ReadonlyMap<string, { schedule: string; guarded: boolean; active: boolean }> =
  new Map([
    // A bare-VACUUM job: no procedure, so nothing consults prod_session_state().
    ["fr-vacuum-analyze", { schedule: "0 1 * * 1", guarded: false, active: true }],
    // A CALL job whose procedure does consult it.
    ["refresh-derived-mvs-daily", { schedule: "0 6 * * *", guarded: true, active: true }],
    // On the books, switched off — collects nothing today.
    ["group-donor-rollup-refresh", { schedule: "10 3 * * 3", guarded: true, active: false }],
  ]);

test("ownerColumns renders a VACUUM owner as scheduled but UNGUARDED", () => {
  assert.deepEqual(ownerColumns("fr-vacuum-analyze", OWNERS), {
    schedule: "0 1 * * 1",
    guarded: "NO",
  });
});

test("ownerColumns renders a guarded CALL owner as guarded", () => {
  assert.deepEqual(ownerColumns("refresh-derived-mvs-daily", OWNERS), {
    schedule: "0 6 * * *",
    guarded: "yes",
  });
});

test("ownerColumns marks an INACTIVE job — on the books, collecting nothing", () => {
  // Distinct from NOT SCHEDULED on purpose: a disabled job is a different
  // problem from an absent one and has a different fix (turn it on vs. give
  // the step an owner at all).
  assert.deepEqual(ownerColumns("group-donor-rollup-refresh", OWNERS), {
    schedule: "10 3 * * 3 [INACTIVE]",
    guarded: "yes",
  });
});

test("ownerColumns renders a GHA owner as gha/gate, never as an orphan", () => {
  const gha = [...GHA_OWNERS][0]!;
  assert.deepEqual(ownerColumns(gha, OWNERS), { schedule: "gha", guarded: "gate" });
});

test("ownerColumns renders the manifest owner as not-applicable", () => {
  const dashed = ownerColumns(OWNER_THIS_RUN, OWNERS);
  assert.equal(dashed.schedule, dashed.guarded);
  assert.notEqual(dashed.schedule, "NOT SCHEDULED");
  assert.deepEqual(ownerColumns(null, OWNERS), dashed);
});

test("ownerColumns renders an unknown owner NOT SCHEDULED — the FIX-1165 orphan", () => {
  assert.deepEqual(ownerColumns("no-such-job", OWNERS), {
    schedule: "NOT SCHEDULED",
    guarded: "NO",
  });
});

test("ownerColumns distinguishes 'not read' from 'not scheduled'", () => {
  // The wrong-but-plausible shape: rendering NOT SCHEDULED when the map was
  // never read would manufacture an orphan signal for every owner in the table
  // out of a query nobody ran.
  assert.deepEqual(ownerColumns("fr-vacuum-analyze", undefined), {
    schedule: "?",
    guarded: "?",
  });
});

test("every declared owner is a jobname, a GHA owner, or the manifest owner", () => {
  // The census that keeps the two non-cron sets honest: a new owner string
  // that is prose rather than a job name would render NOT SCHEDULED and read
  // as an orphan. Job names have no spaces; the two exceptions are named.
  for (const s of declareRemediationTail(true)) {
    if (s.owner === null || s.owner === OWNER_THIS_RUN || GHA_OWNERS.has(s.owner)) continue;
    assert.ok(
      !/\s/.test(s.owner),
      `owner ${JSON.stringify(s.owner)} is neither a bare cron job name nor a declared ` +
        `non-cron owner. Add it to GHA_OWNERS, or drop the prose — FIX-1193 looks this ` +
        `string up in cron.job verbatim.`,
    );
  }
});

test("no declared owner still carries a hard-coded schedule parenthetical", () => {
  // The thing FIX-1193 removed. A parenthetical is a second source of truth
  // for a fact the table now reads live, and FIX-1191 makes the fr one wrong.
  for (const s of declareRemediationTail(true)) {
    if (s.owner === null || s.owner === OWNER_THIS_RUN || GHA_OWNERS.has(s.owner)) continue;
    assert.ok(
      !s.owner.includes("("),
      `owner ${JSON.stringify(s.owner)} carries a parenthetical. The schedule is read ` +
        `from cron.job now; a written-down copy goes stale the day the job moves.`,
    );
  }
});
