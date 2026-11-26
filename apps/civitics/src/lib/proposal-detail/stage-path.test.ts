/**
 * FIX-1447 (cc-317 D6) — the stage path, over every proposal_status value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureKind, stagePath } from "./stage-path";
import { enumValues } from "./enums.test-helper";

const FED = { congressNumber: 119 };

/** reached labels, the current label, and the end state — the whole rendered path in one line. */
function render(p: Parameters<typeof stagePath>[0]): string | null {
  const s = stagePath(p);
  if (!s) return null;
  const reached = s.steps.filter((x) => x.reached).map((x) => (x.current ? `[${x.label}]` : x.label));
  const todo = s.steps.filter((x) => !x.reached).map((x) => x.label);
  return `${reached.join(" > ")}${todo.length ? ` | ${todo.join(" > ")}` : ""}${s.end ? ` || ${s.end}` : ""}`;
}

const WANT_BILL: Record<string, string | null> = {
  introduced:           "[Introduced] | In committee > Floor > Passed one chamber > Passed both > Law",
  in_committee:         "Introduced > [In committee] | Floor > Passed one chamber > Passed both > Law",
  passed_committee:     "Introduced > [In committee] | Floor > Passed one chamber > Passed both > Law",
  floor_vote:           "Introduced > In committee > [Floor] | Passed one chamber > Passed both > Law",
  passed_chamber:       "Introduced > In committee > Floor > [Passed one chamber] | Passed both > Law",
  passed_both_chambers: "Introduced > In committee > Floor > Passed one chamber > [Passed both] | Law",
  signed:               "Introduced > In committee > Floor > Passed one chamber > Passed both > [Law]",
  veto_overridden:      "Introduced > In committee > Floor > Passed one chamber > Passed both > [Law]",
  enacted:              "Introduced > In committee > Floor > Passed one chamber > Passed both > [Law]",
  vetoed:               "Introduced > In committee > Floor > Passed one chamber > Passed both | Law || Vetoed",
  failed:               "Introduced | In committee > Floor > Passed one chamber > Passed both > Law || Failed",
  withdrawn:            "Introduced | In committee > Floor > Passed one chamber > Passed both > Law || Withdrawn",
  tabled:               "Introduced | In committee > Floor > Passed one chamber > Passed both > Law || Tabled",
  open_comment:         null,
  comment_closed:       null,
  final_rule:           null,
};

test("D6: every proposal_status value on a federal bill", () => {
  const statuses = enumValues("proposal_status");
  assert.deepEqual([...statuses].sort(), Object.keys(WANT_BILL).sort(), "a new status needs a decision here");
  for (const status of statuses) {
    assert.equal(render({ ...FED, type: "bill", status, billNumber: "HR 1" }), WANT_BILL[status], status);
  }
});

test("D6: an end state is never a step and is never current", () => {
  for (const status of ["failed", "withdrawn", "tabled", "vetoed"]) {
    const s = stagePath({ ...FED, type: "bill", status, billNumber: "S 5" })!;
    assert.ok(s.end);
    assert.ok(s.steps.every((x) => !x.current), status);
    assert.ok(!s.steps.some((x) => x.label === s.end), status);
  }
});

test("D6: a joint resolution takes the bill's path; concurrent and simple ones end where they end", () => {
  assert.equal(
    render({ ...FED, type: "resolution", status: "enacted", billNumber: "SJRES 83" }),
    "Introduced > In committee > Floor > Passed one chamber > Passed both > [Law]",
  );
  assert.equal(
    render({ ...FED, type: "resolution", status: "passed_both_chambers", billNumber: "HCONRES 14" }),
    "Introduced > In committee > Floor > Passed one chamber > [Passed both]",
  );
  assert.equal(
    render({ ...FED, type: "resolution", status: "passed_chamber", billNumber: "HRES 292" }),
    "Introduced > In committee > Floor > [Agreed to]",
  );
  assert.equal(
    render({ ...FED, type: "resolution", status: "floor_vote", billNumber: "SRES 12" }),
    "Introduced > In committee > [Floor] | Agreed to",
  );
  assert.equal(measureKind("H.Res. 5"), "simple");
  assert.equal(measureKind("SCONRES 7"), "concurrent");
  assert.equal(measureKind("HJRES 1"), "full");
  assert.equal(measureKind(null), "full");
});

test("D6: an appointment, an OpenStates row, a Legistar row and a regulation get no path", () => {
  assert.equal(stagePath({ ...FED, type: "appointment", status: "floor_vote", billNumber: "PN 858" }), null);
  assert.equal(stagePath({ congressNumber: null, type: "bill", status: "passed_chamber", billNumber: "SB 185" }), null);
  assert.equal(stagePath({ congressNumber: null, type: "ordinance", status: "enacted", billNumber: "CB 119913" }), null);
  assert.equal(stagePath({ congressNumber: null, type: "resolution", status: "introduced", billNumber: "Res 32001" }), null);
  assert.equal(stagePath({ congressNumber: null, type: "regulation", status: "open_comment", billNumber: null }), null);
  for (const type of enumValues("proposal_type").filter((t) => t !== "bill" && t !== "resolution")) {
    assert.equal(stagePath({ ...FED, type, status: "introduced", billNumber: "X 1" }), null, type);
  }
});
