/**
 * FIX-1184 — Guard 1's walk over a slice's run history.
 *
 * Runs via:  tsx --test src/scripts/audit-fec-emit-residue.test.ts
 *
 * The guard has always been "newest by started_at, NOT newest complete", and
 * that is not a detail — an older complete set's absences are last week's
 * answer, and anti-joining them would delete rows this week's run legitimately
 * re-emitted. What it could not do before FIX-1184 was distinguish a newest row
 * that is a real in-flight prefix from one that is scaffolding nobody ever
 * finished. On prod 2026-09-14 the second kind made (2024, fec_bulk_pac)
 * permanently unauditable and would have done the same to (2026, fec_bulk_pac)
 * on any weekday run with no new FEC drop.
 *
 * Four row shapes, and the whole guard is which of them may be walked past.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEmitRun, type EmitRun } from "./audit-fec-emit-residue";

let seq = 0;
function row(p: Partial<EmitRun> & { started_at: string }): EmitRun {
  return {
    run_id: `run-${++seq}`,
    cycle_year: 2026,
    source: "fec_bulk_pac",
    complete_at: null,
    keys: "0",
    superseded_at: null,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// The four shapes, one at a time
// ---------------------------------------------------------------------------

test("complete_at set — use it", () => {
  const r = row({ started_at: "2026-09-13", complete_at: "2026-09-14", keys: "111890" });
  const v = resolveEmitRun([r]);
  assert.equal(v.kind, "use");
  assert.equal(v.kind === "use" && v.run.run_id, r.run_id);
});

test("neither complete nor superseded — REFUSE, as before FIX-1184", () => {
  const v = resolveEmitRun([row({ started_at: "2026-09-13" })]);
  assert.equal(v.kind, "refuse");
  assert.equal(v.kind === "refuse" && v.reason, "incomplete");
});

test("superseded with keys = 0 — walk past it to the complete set beneath", () => {
  // This is the prod shape FIX-1184 was filed for: a pas2 arm row that was
  // opened, never stamped, and later replaced. It emitted nothing that the older
  // complete set does not already account for, so it cannot hide a re-emit.
  const complete = row({ started_at: "2026-09-13T22:55", complete_at: "2026-09-14", keys: "111890" });
  const orphan = row({ started_at: "2026-09-14T22:47", superseded_at: "2026-09-15" });
  const v = resolveEmitRun([orphan, complete]);
  assert.equal(v.kind, "use");
  assert.equal(v.kind === "use" && v.run.run_id, complete.run_id);
});

test("superseded with keys > 0 — REFUSE, naming it; a PREFIX was written", () => {
  // The one case where skipping would be wrong, and the exact reason the guard
  // is "newest" and not "newest complete". The older set's absences would delete
  // rows this prefix emitted.
  const complete = row({ started_at: "2026-09-13", complete_at: "2026-09-14", keys: "111890" });
  const prefix = row({ started_at: "2026-09-14", superseded_at: "2026-09-15", keys: "4271" });
  const v = resolveEmitRun([prefix, complete]);
  assert.equal(v.kind, "refuse");
  assert.equal(v.kind === "refuse" && v.reason, "superseded-prefix");
  assert.equal(v.kind === "refuse" && v.run.keys, "4271");
});

// ---------------------------------------------------------------------------
// Walk order and edges
// ---------------------------------------------------------------------------

test("an in-flight run above a superseded orphan still refuses", () => {
  // Order matters: the FIRST row that is neither complete nor superseded stops
  // the walk. A run that is genuinely mid-flight must not be walked past just
  // because something older is tidy.
  const v = resolveEmitRun([
    row({ started_at: "2026-09-15" }),
    row({ started_at: "2026-09-14", superseded_at: "2026-09-15" }),
    row({ started_at: "2026-09-13", complete_at: "2026-09-14", keys: "9" }),
  ]);
  assert.equal(v.kind, "refuse");
  assert.equal(v.kind === "refuse" && v.reason, "incomplete");
});

test("several superseded orphans in a row are all skipped", () => {
  // (2024, fec_bulk_pac) on prod accumulated one orphan per nightly. The walk
  // must not stop at the first of them.
  const complete = row({ started_at: "2026-09-10", complete_at: "2026-09-10", keys: "135192" });
  const v = resolveEmitRun([
    row({ started_at: "2026-09-13", superseded_at: "2026-09-14" }),
    row({ started_at: "2026-09-12", superseded_at: "2026-09-13" }),
    row({ started_at: "2026-09-11", superseded_at: "2026-09-12" }),
    complete,
  ]);
  assert.equal(v.kind, "use");
  assert.equal(v.kind === "use" && v.run.run_id, complete.run_id);
});

test("nothing but superseded orphans — 'none', not a silent pass", () => {
  const v = resolveEmitRun([
    row({ started_at: "2026-09-13", superseded_at: "2026-09-14" }),
    row({ started_at: "2026-09-12", superseded_at: "2026-09-13" }),
  ]);
  assert.equal(v.kind, "none");
});

test("no rows at all — 'none'", () => {
  assert.equal(resolveEmitRun([]).kind, "none");
});

test("a run both complete AND superseded is used — completion wins", () => {
  // Reachable when a run was superseded by a different run and then resumed and
  // finished. begin() clears the supersession on reopen, but the ordering here
  // is what makes that belt-and-braces rather than load-bearing.
  const r = row({ started_at: "2026-09-13", complete_at: "2026-09-14", superseded_at: "2026-09-14", keys: "7" });
  const v = resolveEmitRun([r]);
  assert.equal(v.kind, "use");
  assert.equal(v.kind === "use" && v.run.run_id, r.run_id);
});
