#!/usr/bin/env node
// scripts/test-board.mjs
//
// Assertion harness for scripts/board.mjs (FIX-1242), run against the
// miniature tree in scripts/__fixtures__/board/:
//
//   reports/   cc-900 (verifies, owes FIX-50), cc-903 (lane fec2 — FAILs),
//              cc-880 (older than the window; a plan step reads it)
//   prompts/   900 · 901 (no front matter, inside the report range) · 902
//              (marker 3 days old) · 903 · 904 (when: Thu 16:30Z) · 905
//              (fresh marker) · 950 (no front matter, past every report)
//   projects/  demo.md — one step of every kind, one naming a FAILing report
//   receipts/  2026-09-28.json (held=true; daily, weekly, two monthly, one
//              inactive and one */15 job), an older day, and bands.json
//   lanes-backfill.json · done.log · FIXES.md · board.local.json
//
// Run:   pnpm board:test
// Exit:  0 on pass, 1 on fail.
//
// The verifier is cc-verify's real verifyReport(), over an injected git
// context (the fixture shas), so the unknown-lane FAIL is the real check.

import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildBoard,
  renderHtml,
  renderBoardJson,
  loadBoardInputs,
  run,
  parseCron,
  cronEvents,
  markerState,
  latestReceiptName,
  supervisedLine,
  escapeHtml,
} from "./board.mjs";
import { verifyReport } from "./cc-verify.mjs";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import { DEFAULT_LANES } from "./lib/cc-front-matter.mjs";

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

const F = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/board");
const NOW = "2026-09-28T04:00:00Z"; // a Monday
const NOW_MS = Date.parse(NOW);

const tmpRoot = mkdtempSync(join(tmpdir(), "board-test-"));
const pathsFor = (boardDir) => ({
  reportsDir: resolve(F, "reports"),
  promptsDir: resolve(F, "prompts"),
  projectsDir: resolve(F, "projects"),
  boardDir,
  backfillPath: resolve(F, "lanes-backfill.json"),
  receiptsDir: resolve(F, "receipts"),
  doneLogPath: resolve(F, "done.log"),
  fixesPath: resolve(F, "FIXES.md"),
  archivePath: resolve(F, "no-archive.md"),
  localPath: resolve(F, "board.local.json"),
  reportLinkDir: resolve(F, "reports"),
});
const paths = pathsFor(resolve(tmpRoot, "board"));

// The fixture's trunk: two commits. Everything else "does not exist".
const TRUNK = new Set(["aaaaaaa1", "bbbbbbb2"]);
const verifierFor = (doneLogText) => {
  const vctx = {
    statusMap: deriveStatus(parseDoneLog(doneLogText)),
    fixesText: readFileSync(paths.fixesPath, "utf8"),
    archiveText: "",
    trunkRef: "origin/main",
    resolveSha: (s) => (TRUNK.has(s) ? s : null),
    isAncestor: (s) => TRUNK.has(s),
    fileOnTrunk: () => false,
    ghCi: null,
    lanes: DEFAULT_LANES,
    projectExists: (slug) => existsSync(resolve(F, "projects", `${slug}.md`)),
  };
  return (fm, loaded) => verifyReport(fm, { ...vctx, frontMatterSource: loaded.source, frontMatterDrift: loaded.drift });
};
const verify = verifierFor(readFileSync(paths.doneLogPath, "utf8"));
const opts = { nowMs: NOW_MS, verify, lanes: DEFAULT_LANES, head: "fixture0", paths };

const inputs = loadBoardInputs(paths);
const board = buildBoard(inputs, opts);
const html = renderHtml(board);
const json = renderBoardJson(board);
const card = (n) => [...board.lanes.flatMap((l) => l.cards), ...board.unlaned.cards].find((c) => c.cc === n);
const laneOf = (n) => board.lanes.find((l) => l.cards.some((c) => c.cc === n))?.name ?? (board.unlaned.cards.some((c) => c.cc === n) ? "(no lane)" : "(absent)");
const day = (date) => board.week.days.find((d) => d.date === date);

// -- 1. inputs ----------------------------------------------------------------
console.log("inputs:");
assertEq("latest receipt is the max DATED filename, never bands.json", inputs.receipt?.name, "2026-09-28.json");
assertEq("latestReceiptName ignores non-day files", latestReceiptName(["2026-09-20.json", "bands.json", "README.md", "2026-09-28.json", "2026-09-28.md"]), "2026-09-28.json");
assertEq("every numbered prompt is listed", inputs.prompts.map((p) => p.n), [900, 901, 902, 903, 904, 905, 950]);
assertEq("both markers read", inputs.markers.map((m) => m.n).sort(), [902, 905]);

// -- 2. card states -----------------------------------------------------------
console.log("\ncard states:");
assertEq("cc-900 — verifies, owes FIX-50 → owed", card(900)?.state, "owed");
assertEq("cc-900 is in its own lane", laneOf(900), "ops");
assertEq("cc-900 carries its project", card(900)?.project, "demo");
assertEq("cc-900 title comes from the PROMPT's first heading", card(900)?.title, "the landed fixture, with a title");
assertEq("cc-900 FIX chips", [card(900)?.fixes_closed, card(900)?.fixes_filed], [["FIX-40"], ["FIX-50"]]);
assertEq("cc-900 STOP count", card(900)?.stops, 1);
assertEq("cc-900 prod_writes → none", card(900)?.prod_writes, "none");
assertEq("cc-900 read from its sidecar", card(900)?.sidecar, "json");
assertEq("cc-903 — a lane not in the list → landed · verify FAILs", card(903)?.state, "landed · verify FAILs");
assertTrue(
  "cc-903's FAIL is the real cc:verify lane check",
  card(903)?.verify.fails.some((f) => /is a report lane/.test(f)),
  JSON.stringify(card(903)?.verify),
);
assertEq("cc-903 renders in no lane column (it has no valid lane)", laneOf(903), "(no lane)");
assertTrue("cc-903's missing sidecar is flagged", board.diagnostics.sidecar_missing.includes("cc-903"));
assertEq("cc-901 — no front matter, inside the report range → drafted · no front matter", card(901)?.state, "drafted · no front matter");
assertEq("cc-901 placed by lanes-backfill.json", [laneOf(901), card(901)?.lane_source], ["hygiene", "backfill"]);
assertEq("cc-902 — marker three days old → running · stale?", card(902)?.state, "running · stale?");
assertEq("cc-905 — marker two hours old → running", card(905)?.state, "running");
assertEq("cc-904 — prompt only → drafted", card(904)?.state, "drafted");
assertEq("cc-904's when/attended/posture on the card", [card(904)?.when, card(904)?.attended, card(904)?.posture], ["2026-10-01T16:30Z", "supervised", "prod-reads"]);
assertEq("a prompt-only card lists no FIX chips", [card(904)?.fixes_closed, card(904)?.fixes_filed], [[], []]);
assertEq("cc-950 — legacy, past every report → not on the board", laneOf(950), "(absent)");
assertEq("cc-880 — older than the window → not a card", laneOf(880), "(absent)");
assertEq("markerState at exactly 24 h is still running", markerState({ started_at: "2026-09-27T04:00:00Z" }, NOW_MS).state, "running");
assertEq("markerState past 24 h is stale", markerState({ started_at: "2026-09-27T03:59:00Z" }, NOW_MS).state, "running · stale?");
assertEq("markerState with no started_at is stale, never running", markerState({}, NOW_MS).state, "running · stale?");

// The same tree with FIX-50's receipt in done.log: owed → closed.
const closedDone = `${readFileSync(paths.doneLogPath, "utf8")}2026-09-30 | FIX-50 | aaaaaaa1 | prod-only | the receipt\n`;
const closedBoard = buildBoard({ ...inputs, doneLogText: closedDone }, { ...opts, verify: verifierFor(closedDone) });
const closed900 = closedBoard.lanes.flatMap((l) => l.cards).find((c) => c.cc === 900);
assertEq("…with FIX-50's row dated after finished_at, cc-900 → closed", closed900?.state, "closed");
assertEq("…and the owed line says received", closed900?.owed[0]?.received, "2026-09-30");
const staleRow = `${readFileSync(paths.doneLogPath, "utf8")}2026-09-26 | FIX-50 | aaaaaaa1 | prod-only | before the report\n`;
assertEq(
  "a FIX-50 row dated BEFORE the report's finished_at does not pay the debt",
  buildBoard({ ...inputs, doneLogText: staleRow }, { ...opts, verify: verifierFor(staleRow) }).lanes.flatMap((l) => l.cards).find((c) => c.cc === 900)?.state,
  "owed",
);

// -- 3. reconciliation (rule 116) ---------------------------------------------
console.log("\nreconciliation:");
const r = board.reconciliation;
assertEq("2 reports in the window + 4 in-flight prompts = 6 cards", [r.window_reports, r.prompt_cards, r.cards], [2, 4, 6]);
assertEq("every card placed exactly once", [r.placed, r.ok], [6, true]);
for (const l of [...board.lanes, board.unlaned]) {
  assertEq(`${l.name ?? "no lane"}: in flight + landed + verified = count`, l.in_flight + l.landed + l.verified, l.count);
}
assertEq(
  "lane counts",
  board.lanes.map((l) => [l.name, l.count, l.in_flight, l.landed, l.verified]),
  [["ops", 1, 0, 0, 1], ["fec", 0, 0, 0, 0], ["app", 2, 2, 0, 0], ["hygiene", 2, 2, 0, 0], ["design", 0, 0, 0, 0]],
);
assertEq("no-lane strip", [board.unlaned.count, board.unlaned.landed], [1, 1]);
const allCc = [...board.lanes.flatMap((l) => l.cards), ...board.unlaned.cards].map((c) => c.cc);
assertEq("no card appears twice", allCc.length, new Set(allCc).size);

// -- 4. badges ----------------------------------------------------------------
console.log("\nbadges:");
assertEq(
  "interlock held, quoting the receipt's generated_at",
  board.badges.interlock.text,
  "held by cc-902 fixture hold · claimed 2026-09-27T20:00:00Z · as of 2026-09-27T23:31:31.143Z",
);
assertEq("receipt_as_of", board.receipt_as_of, "2026-09-27T23:31:31.143Z");
assertEq("verify FAILs count", board.badges.verify_fails, 1);
assertEq("owed: one receipt in one report", board.badges.owed, { receipts: 1, reports: 1 });
assertEq("in flight: 1 running, 1 stale, 2 drafted", board.badges.in_flight, { running: 1, stale: 1, drafted: 2 });
assertEq("open count from done.log + FIXES.md (50, 60, 61)", board.badges.open_count, 3);
assertTrue("the badge line names the interlock and counts", /held by cc-902/.test(board.badge_line) && /3 open/.test(board.badge_line), board.badge_line);

// -- 5. the projects strip ----------------------------------------------------
console.log("\nprojects:");
const demo = board.projects.find((p) => p.slug === "demo");
const st = (id) => demo?.steps.find((s) => s.id === id)?.status;
assertEq("s1 cc-880 — report outside the window, verify PASS → done", st("s1"), "done");
assertEq("s2 op FIX-40 — done.log row → done", st("s2"), "done");
assertEq("s3 design — hand-dated → done", st("s3"), "done");
assertEq("s4 cc-902 — the marker → running · stale?", st("s4"), "running · stale?");
assertEq("s5 receipt FIX-50 after Wed → gated", st("s5"), "gated · 2026-09-30");
assertEq("s6 decision, undated → planned", st("s6"), "planned");
assertEq("s7 design after 10-20 → gated", st("s7"), "gated · 2026-10-20");
assertEq("s8 cc with no ref → planned", st("s8"), "planned");
assertEq("s9 names a report whose verify FAILs → landed · verify FAILs, never done", st("s9"), "landed · verify FAILs");
assertEq("3 of 9 done, current = the first not-done step", [demo?.done_count, demo?.total, demo?.current], [3, 9, "s4"]);
assertEq("the plan file has no shape problems", demo?.problems, []);
assertEq(
  "queue: plan steps not done and not already a card",
  [...board.lanes.flatMap((l) => l.queue.map((q) => `${l.name}:${q.step}`))].sort(),
  ["design:s7", "ops:s5", "ops:s6", "ops:s8"],
);

// -- 6. the week --------------------------------------------------------------
console.log("\nweek:");
assertEq("8 columns: today … today+6, then later", [board.week.days.length, board.week.days[0].date, board.week.days[6].date], [7, "2026-09-28", "2026-10-04"]);
assertEq("today is marked", board.week.days.filter((d) => d.today).map((d) => d.date), ["2026-09-28"]);
const has = (date, kind, re) => (day(date)?.events ?? []).some((e) => e.kind === kind && re.test(`${e.time} ${e.label}`));
assertTrue("jobid 17 `0 15 * * 2` lands on Tuesday 15:00", has("2026-09-29", "cron", /^15:00 jobid 17 donor-party-rollup-refresh/));
assertEq("parseCron: `0 15 * * 2` is a weekly each-firing job", [parseCron("0 15 * * 2").mode, parseCron("0 15 * * 2").daily], ["each", false]);
assertEq("cronEvents: `0 15 * * 2` from Mon 09-28 → Tue 09-29 15:00", cronEvents(parseCron("0 15 * * 2"), Date.parse("2026-09-28T00:00:00Z")), [{ date: "2026-09-29", time: "15:00" }]);
assertTrue(
  "the nightly dispatch sits at 21:00 on every day (from nightly.created_at)",
  board.week.days.every((d) => d.events.some((e) => e.kind === "nightly" && e.time === "21:00")),
);
assertTrue("a day-of-month job on its next occurrence (Thu 10-01 11:30)", has("2026-10-01", "cron", /^11:30 jobid 23/));
assertTrue("a day-of-month job past the week goes to later, with its date", board.week.later.some((e) => e.date === "2026-10-15" && /jobid 24/.test(e.label)));
assertTrue("a */15 job is drawn ONCE, on its next occurrence", board.week.days.flatMap((d) => d.events).filter((e) => /jobid 8 /.test(e.label)).length === 1);
assertTrue("…with its schedule in the label", has("2026-09-28", "cron", /jobid 8 every-quarter-hour-mondays \(`\*\/15 \* \* \* 1`\)/));
assertTrue("a daily job is not drawn", !board.week.days.some((d) => d.events.some((e) => /jobid 3 /.test(e.label))));
assertTrue("an inactive job is not drawn", !JSON.stringify(board.week).includes("inactive-weekly"));
assertTrue("…and is listed as inactive", board.diagnostics.cron_inactive.some((x) => /inactive-weekly/.test(x)));
assertTrue("cc-904's when → a run event Thursday 16:30", has("2026-10-01", "run", /^16:30 cc-904/));
assertTrue("cc-900's owed FIX-50 → a receipt event Wednesday 15:00", has("2026-09-30", "receipt", /^15:00 cc-900 owes FIX-50/));
assertTrue("demo s5's after → a gate event Wednesday 15:00", has("2026-09-30", "gate", /^15:00 demo s5/));
assertTrue("demo s7 (design) past the week → later, as a design event", board.week.later.some((e) => e.kind === "cowork" && /demo s7/.test(e.label)));
assertTrue("a landed prompt's when is not re-drawn as a run", !board.week.days.some((d) => d.events.some((e) => /cc-900 · /.test(e.label))));
assertEq(
  "supervised Monday 16:15–20:30 PDT → 23:15–03:30 UTC",
  day("2026-09-28")?.supervised,
  "supervised 23:15–03:30 UTC (16:15–20:30 PDT)",
);
assertEq("Saturday says variable", day("2026-10-03")?.supervised, "supervised · variable");
assertEq("a weekday with no entry has no footer", day("2026-09-29")?.supervised, "");
assertEq("no local file → no footer at all", supervisedLine(null, "2026-09-28"), "");
assertEq(
  "PST after the DST change (Mon 2026-11-02)",
  supervisedLine({ tz: "America/Los_Angeles", supervised: { mon: [["16:15", "20:30"]] } }, "2026-11-02"),
  "supervised 00:15–04:30 UTC (16:15–20:30 PST)",
);

// -- 7. the output ------------------------------------------------------------
console.log("\noutput:");
const FORBIDDEN = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/;
assertTrue("index.html has no undefined / null / NaN / [object Object]", !FORBIDDEN.test(html), (html.match(FORBIDDEN) ?? [""])[0]);
assertTrue("board.json has none either", !FORBIDDEN.test(json), (json.match(FORBIDDEN) ?? [""])[0]);
const count = (s, re) => (s.match(re) ?? []).length;
assertEq("balanced <div>s", count(html, /<div\b/g), count(html, /<\/div>/g));
assertEq("balanced <details>", count(html, /<details\b/g), count(html, /<\/details>/g));
assertTrue("no external fonts or scripts", !/fonts\.googleapis|<script|<link\b/i.test(html));
assertTrue("escaping: a title's < > & are escaped", escapeHtml(`<b>&"'`) === "&lt;b&gt;&amp;&quot;&#39;");
assertTrue("the header interlock quotes the receipt's generated_at", html.includes("as of 2026-09-27T23:31:31.143Z"));
assertTrue("the palette is the reference's", html.includes("#3b5bdb") && html.includes(".pill.owed{background:#0f766e"));

// Determinism: the same tree + the same now → byte-identical output.
const board2 = buildBoard(loadBoardInputs(paths), opts);
assertTrue("determinism: two builds, byte-identical board.json", renderBoardJson(board2) === json);
assertTrue("determinism: two builds, byte-identical index.html", renderHtml(board2) === html);

// -- 8. the command -----------------------------------------------------------
console.log("\ncommand:");
const sink = () => {
  let buf = "";
  return { write: (s) => (buf += s), get text() { return buf; } };
};
const runWith = (argv, boardDir) => {
  const out = sink();
  const err = sink();
  const code = run(argv, { paths: pathsFor(boardDir), lanes: DEFAULT_LANES, head: "fixture0", verify, stdout: out, stderr: err });
  return { code, out: out.text, err: err.text };
};
const dryDir = resolve(tmpRoot, "dry");
const dry1 = runWith(["--dry-run", "--now", NOW], dryDir);
const dry2 = runWith(["--dry-run", "--now", NOW], dryDir);
assertEq("--dry-run exits 0", dry1.code, 0);
assertTrue("--dry-run prints board.json", dry1.out === json.replace(`"board_dir": "${paths.boardDir.replace(/\\/g, "\\\\")}"`, `"board_dir": "${dryDir.replace(/\\/g, "\\\\")}"`));
assertTrue("--dry-run twice → byte-identical stdout", dry1.out === dry2.out);
assertTrue("--dry-run writes nothing (the dir is never created)", !existsSync(dryDir));
const jsonDir = resolve(tmpRoot, "json-only");
assertEq("--json exits 0", runWith(["--json", "--now", NOW], jsonDir).code, 0);
assertEq("--json writes only board.json", readdirSync(jsonDir).sort(), ["board.json"]);
const fullDir = resolve(tmpRoot, "full");
const full = runWith(["--now", NOW], fullDir);
assertEq("default writes board.json + index.html", readdirSync(fullDir).sort(), ["board.json", "index.html"]);
assertTrue("default prints the badge line", /^board — interlock held by cc-902/.test(full.out), full.out);
assertEq("a bad --now is a usage error", runWith(["--now", "not-a-date"], resolve(tmpRoot, "bad")).code, 1);

rmSync(tmpRoot, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nboard:test — all assertions passed.");
