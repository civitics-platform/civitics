#!/usr/bin/env node
// scripts/test-check-doc-links.mjs — `pnpm check:doc-links:test` (FIX-1243 D7)
//
// Every case can fail (playbook rule E10). The one this suite exists for is
// rule 105's wrong-but-green shape: a doc moved with ONE stale reference left
// behind. A checker that only looked at markdown links, or a move that only
// rewrote `docs/<name>`, would pass that tree.
//
// Run:   pnpm check:doc-links:test
// Exit:  0 on pass, 1 on fail.

import { scanText, resolveRef, checkTree, compareKnown, planArchive } from "./check-doc-links.mjs";

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  x ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ok ${label}`);
}
function assertTrue(label, cond, detail = "") {
  if (cond) console.log(`  ok ${label}`);
  else failures.push(`  x ${label}${detail ? `\n     ${detail}` : ""}`);
}

// -- 1. what counts as a reference --------------------------------------------
console.log("scanText:");
const refs = scanText(
  [
    "See [the plan](GRAPH_PLAN.md#§3) and [ops](./OPERATIONS.md) and [x](../docs/API.md).",
    "Root path: `docs/FIXES.md:186`, `docs/CLOUDFLARE.md §2`, `docs/cc/README.md`.",
    "Not links: [web](https://example.com/A.md), `docs/cc/reports/cc-<n>.md`, `docs/*.md`, `FIXES.md` (bare).",
    "```",
    "[in a fence](NOPE.md) `docs/NOPE.md`",
    "```",
  ].join("\n"),
);
assertEq(
  "links + backtick docs paths, anchors and :line dropped",
  refs.map((r) => `${r.kind}:${r.target}`),
  ["link:GRAPH_PLAN.md", "link:./OPERATIONS.md", "link:../docs/API.md", "backtick:docs/FIXES.md", "backtick:docs/CLOUDFLARE.md", "backtick:docs/cc/README.md"],
);
assertEq("a link resolves from its file's directory", resolveRef("docs/cc/README.md", { kind: "link", target: "../FIXES.md" }), "docs/FIXES.md");
assertEq("a backtick path resolves from the repo root", resolveRef("docs/cc/README.md", { kind: "backtick", target: "docs/FIXES.md" }), "docs/FIXES.md");
assertEq("a link that climbs out of the repo is null", resolveRef("README.md", { kind: "link", target: "../x.md" }), null);

// -- 2. the check --------------------------------------------------------------
console.log("\ncheckTree:");
const tree = new Map([
  ["docs/A.md", "see [B](B.md) and `docs/C.md`"],
  ["docs/B.md", "back to [A](./A.md)"],
  ["CLAUDE.md", "`docs/A.md` and [gone](docs/GONE.md)"],
]);
const exists = (p) => tree.has(p);
const r1 = checkTree([...tree.keys()], (f) => tree.get(f), exists);
assertEq("two breaks: the missing backtick path and the missing link", r1.breaks.map((b) => `${b.file}->${b.target}`), ["docs/A.md->docs/C.md", "CLAUDE.md->docs/GONE.md"]);
const cmp = compareKnown(r1.breaks, [{ file: "docs/A.md", target: "docs/C.md" }, { file: "docs/Z.md", target: "fixed.md" }]);
assertEq("a known break is not fresh; an unknown one is", [cmp.fresh.map((b) => b.target), cmp.known.map((b) => b.target)], [["docs/GONE.md"], ["docs/C.md"]]);
assertEq("a known break that resolves now is stale", cmp.stale.map((s) => s.target), ["fixed.md"]);

// -- 3. the archive move -------------------------------------------------------
console.log("\nplanArchive:");
const texts = new Map([
  ["docs/OLD.md", "Old spec. Depends on [kept](KEPT.md), `KEPT.md` and [code](../packages/x/README.md).\nSource: [idx](../packages/x/src/index.ts#L12), [web](https://x.test/a.ts), [top](#top)."],
  ["docs/KEPT.md", "Read [the old one](OLD.md), `OLD.md` and `docs/OLD.md` first."],
  ["docs/sub/NOTE.md", "Up: [old](../OLD.md)."],
  ["CLAUDE.md", "> `docs/OLD.md` is historical."],
  ["docs/archive/LOG.md", "Wrote OLD.md today; [old](../OLD.md)."],
  ["docs/audits/2026-01-01.md", "audit cites docs/OLD.md"],
  ["docs/CODE_CITED.md", "cited by a migration"],
  ["supabase/migrations/1.sql", "-- See docs/CODE_CITED.md §2"],
]);
const plan = planArchive(["OLD.md", "CODE_CITED.md"], texts);
assertEq("a doc a migration cites is refused, not moved", [plan.refused.map((r) => r.name), plan.moves.map((m) => m.to)], [["CODE_CITED.md"], ["docs/archive/OLD.md"]]);
const after = (f) => plan.edits.get(f)?.after ?? texts.get(f);
assertEq("a sibling's link, bare name and root path all follow", after("docs/KEPT.md"), "Read [the old one](archive/OLD.md), `archive/OLD.md` and `docs/archive/OLD.md` first.");
assertEq("a link from a subdirectory follows", after("docs/sub/NOTE.md"), "Up: [old](../archive/OLD.md).");
assertEq("CLAUDE.md's root path follows", after("CLAUDE.md"), "> `docs/archive/OLD.md` is historical.");
assertEq(
  "the moved file's own outward links are re-based — .ts ones too; URLs and #anchors untouched",
  after("docs/OLD.md"),
  "Old spec. Depends on [kept](../KEPT.md), `../KEPT.md` and [code](../../packages/x/README.md).\nSource: [idx](../../packages/x/src/index.ts#L12), [web](https://x.test/a.ts), [top](#top).",
);
assertEq("a link from docs/archive/ re-bases to its new sibling", after("docs/archive/LOG.md"), "Wrote OLD.md today; [old](OLD.md).");
assertEq("history is read, never edited", [after("docs/audits/2026-01-01.md"), plan.history.map((h) => h.file)], ["audit cites docs/OLD.md", ["docs/audits/2026-01-01.md"]]);

// Rule 105: move the file, rewrite everything but ONE reference — the checker
// must fail that tree. (A checker that only knew markdown links would pass it:
// the leftover is a backtick root path.)
const moved = new Map([...texts].filter(([f]) => f !== "docs/OLD.md" && !f.startsWith("supabase/")).map(([f]) => [f, after(f)]));
moved.set("docs/archive/OLD.md", after("docs/OLD.md"));
moved.set("docs/archive/KEPT_README.md", "a doc with the one stale reference: `docs/OLD.md`");
const r2 = checkTree([...moved.keys()].filter((f) => !f.startsWith("docs/audits/")), (f) => moved.get(f), (p) => moved.has(p) || p === "packages/x/README.md");
assertEq("…the checker FAILs the one stale reference, and only it", r2.breaks.map((b) => `${b.file}->${b.target}`), ["docs/archive/KEPT_README.md->docs/OLD.md"]);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\ncheck:doc-links:test — all assertions passed.");
