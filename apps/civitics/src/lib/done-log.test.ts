// FIX-1097 — done.log parser. The file is hand-appendable and read at runtime
// from the lambda filesystem, so the parser's job is to be unsurprising on
// malformed input: skip what it cannot read, never guess, never throw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDoneLog } from "./done-log";

const REAL_TAIL = [
  "# docs/done.log — append-only completion record",
  "#   ISO-DATE | FIX-ID | commit-sha | verified | note",
  "2026-08-22 | FIX-1085 | 732ccdea | local+prod | docs(phases): PHASE_GOALS.md verified refresh",
  "2026-08-22 | FIX-1086 | dcbd6058 | local+prod | fix(ui): stretched-link hit-testing",
  "2026-08-22 | FIX-1087 | dcbd6058 | local+prod | fix(ui): stretched-link hit-testing",
  "2026-08-22 | FIX-1088 | dcbd6058 | local+prod | fix(ui): stretched-link hit-testing",
].join("\n");

describe("parseDoneLog", () => {
  it("collapses one commit's several FIX rows into a single entry", () => {
    const out = parseDoneLog(REAL_TAIL);
    assert.equal(out.length, 2);
    const stretched = out.find((e) => e.sha === "dcbd6058");
    assert.ok(stretched);
    assert.deepEqual(stretched.fixIds, ["FIX-1086", "FIX-1087", "FIX-1088"]);
    assert.equal(stretched.subject, "fix(ui): stretched-link hit-testing");
  });

  it("returns newest first (file order, not date sort)", () => {
    const out = parseDoneLog(REAL_TAIL);
    assert.equal(out[0]!.sha, "dcbd6058");
    assert.equal(out[1]!.sha, "732ccdea");
  });

  it("honours the limit, counting commits not rows", () => {
    assert.equal(parseDoneLog(REAL_TAIL, 1).length, 1);
    assert.equal(parseDoneLog(REAL_TAIL, 1)[0]!.sha, "dcbd6058");
  });

  it("skips comments, blanks and malformed lines without throwing", () => {
    const messy = [
      "",
      "# a comment",
      "not a pipe-delimited line at all",
      "2026-08-22 | FIX-1 | abc",              // too few columns
      "not-a-date | FIX-2 | abc | local | x",  // bad date
      "2026-08-22 | 1093 | abc | local | x",   // bad FIX id
      "2026-08-22 | FIX-3 | abc | local+prod |", // empty subject
      "2026-08-22 | FIX-4 | good1 | local+prod | feat: a real one",
    ].join("\n");
    const out = parseDoneLog(messy);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sha, "good1");
  });

  it("excludes reopen rows — a reopen is the opposite of shipped", () => {
    const withReopen = [
      "2026-08-20 | FIX-9 | abc1234 | local+prod | feat: shipped thing",
      "2026-08-21 | FIX-9 | reopen | unverified | feat: shipped thing",
    ].join("\n");
    const out = parseDoneLog(withReopen);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sha, "abc1234");
  });

  it("keeps a subject containing a pipe intact", () => {
    const out = parseDoneLog(
      "2026-08-22 | FIX-5 | abc1234 | local+prod | feat(x): a | b split",
    );
    assert.equal(out[0]!.subject, "feat(x): a | b split");
  });

  it("maps the verified vocabulary and nulls anything unrecognized", () => {
    const rows = [
      "2026-08-22 | FIX-6 | s1 | local+prod | one",
      "2026-08-22 | FIX-7 | s2 | local-only | two",
      "2026-08-22 | FIX-8 | s3 | closes-as-superseded | three",
      "2026-08-22 | FIX-9 | s4 | wat | four",
    ].join("\n");
    const byS = Object.fromEntries(parseDoneLog(rows).map((e) => [e.sha, e.verified]));
    assert.equal(byS.s1, "local + prod");
    assert.equal(byS.s2, "local");
    assert.equal(byS.s3, "superseded");
    assert.equal(byS.s4, null);
  });

  it("does NOT merge distinct backfill rows sharing the placeholder sha", () => {
    const out = parseDoneLog(
      [
        "2026-04-01 | FIX-10 | backfill | unverified | first thing",
        "2026-04-02 | FIX-11 | backfill | unverified | second thing",
      ].join("\n"),
    );
    assert.equal(out.length, 2);
  });

  it("returns [] on an empty or comments-only file", () => {
    assert.deepEqual(parseDoneLog(""), []);
    assert.deepEqual(parseDoneLog("# only a header\n\n"), []);
  });
});
