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
//              (fresh marker) · 906 (when: after Tue 16:30Z) · 907 (a
//              prod-writes window Thu 23:15–03:30) · 908 (prod-writes, Thu) ·
//              950 (no front matter, past every report)
//   projects/  demo.md — one step of every kind, one naming a FAILing report;
//              all-done.md (every step done, file says active); archived.md;
//              loose.md (no goal)
//   receipts/  2026-09-28.json (held=true; daily, weekly, two monthly, one
//              inactive and one */15 job), an older day, and bands.json
//   receipts-history/  fifteen days: a weekly job carried seven files at a
//              time, a failed firing, a mid-window re-schedule, weekday /
//              Saturday / Sunday nightlies, and a newest file 32 h stale
//   lanes-backfill.json · done.log · FIXES.md (a fec-marked bullet under
//   BUGS) · board.local.json · PHASE_GOALS.md
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
  windowPill,
  whenDays,
  cronHistory,
  historyReceiptNames,
} from "./board.mjs";
import { verifyReport } from "./cc-verify.mjs";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import { DEFAULT_LANES, parseWhen, checkPromptFrontMatter } from "./lib/cc-front-matter.mjs";

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
  fixesLinkPath: resolve(F, "FIXES.md"),
  archivePath: resolve(F, "no-archive.md"),
  phaseGoalsPath: resolve(F, "PHASE_GOALS.md"),
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
// The section → lane map, as docs/cc/cc.config.json carries it — minus HOMEPAGE,
// so FIX-87 has a section the map does not name.
const SECTION_LANES = {
  "BUGS — Fix These First": "bugs",
  "GENERAL / CROSS-CUTTING": "hygiene",
  "INFRASTRUCTURE & PERFORMANCE": "ops",
};
const opts = { nowMs: NOW_MS, verify, lanes: DEFAULT_LANES, head: "fixture0", paths, sectionLanes: SECTION_LANES };

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
assertEq("every numbered prompt is listed", inputs.prompts.map((p) => p.n), [900, 901, 902, 903, 904, 905, 906, 907, 908, 950]);
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
assertEq("2 reports in the window + 7 in-flight prompts = 9 cards", [r.window_reports, r.prompt_cards, r.cards], [2, 7, 9]);
assertEq("every card placed exactly once", [r.placed, r.ok], [9, true]);
for (const l of [...board.lanes, board.unlaned]) {
  assertEq(`${l.name ?? "no lane"}: in flight + landed + verified = count`, l.in_flight + l.landed + l.verified, l.count);
}
assertEq(
  "lane counts",
  board.lanes.map((l) => [l.name, l.count, l.in_flight, l.landed, l.verified]),
  [["ops", 3, 2, 0, 1], ["fec", 0, 0, 0, 0], ["app", 3, 3, 0, 0], ["hygiene", 2, 2, 0, 0], ["design", 0, 0, 0, 0]],
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
assertEq("in flight: 1 running, 1 stale, 5 drafted", board.badges.in_flight, { running: 1, stale: 1, drafted: 5 });
assertEq("open count from done.log + FIXES.md (50, 60, 61, 80–87)", board.badges.open_count, 11);
assertEq("the open badge carries the priority counts (D2c)", board.badges.open_text, "11 open · 🔴 2 · 🟠 4 · 🟡 3 · 🟢 1 · ⬜ 1");
assertTrue("the badge line names the interlock and counts", /held by cc-902/.test(board.badge_line) && /11 open · 🔴 2/.test(board.badge_line), board.badge_line);

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
  "queue: plan steps not done and not already a card (an archived plan queues nothing)",
  [...board.lanes.flatMap((l) => l.queue.map((q) => `${l.name}:${q.step}`))].sort(),
  ["app:s1", "design:s7", "ops:s5", "ops:s6", "ops:s8"],
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

// -- 6b. the backlog (FIX-1243 D2) --------------------------------------------
console.log("\nbacklog:");
const row = (lane) => board.backlog.rows.find((x) => x.lane === lane);
const shownIds = (lane) => row(lane)?.shown.map((i) => i.id);
// Rule 105: a bullet UNDER BUGS carrying <!--lane:fec--> is fec's, not a bug.
// A reader that consulted the section first would put it in the bugs row and
// every count would still add up.
assertEq("a fec-marked bullet under BUGS lands in fec", shownIds("fec"), ["FIX-80"]);
assertEq("…and not in the bugs row", shownIds("bugs"), ["FIX-81"]);
assertEq(
  "ops: 🔴 first, then size S→XL; the archived plan's FIX-83 is NOT hidden; the prompt-named 🟠 FIX-86 is",
  shownIds("ops"),
  ["FIX-85", "FIX-83", "FIX-82"],
);
assertEq("a 🔴 a plan step names is shown, labelled ◆ project", row("ops")?.shown[0]?.named, "◆ loose");
assertEq("the hidden 🟠 is counted, not dropped", row("ops")?.named_hidden, 1);
assertEq("the 🟢 is in `+ N more`", [row("ops")?.more_count, row("ops")?.more.quick], [1, 1]);
assertEq("a backlog item reads `FIX-NNN · emoji size · title`", [row("ops")?.shown[1]?.emoji, row("ops")?.shown[1]?.size, row("ops")?.shown[1]?.title.slice(0, 15)], ["🟠", "S", "infra high, sma"]);
assertEq("hygiene: three 🟡, all in `+ N more`", [row("hygiene")?.open, row("hygiene")?.shown.length, row("hygiene")?.more.medium], [3, 0, 3]);
assertEq("a section the map does not name → unmapped", shownIds("unmapped"), []);
assertEq("…counted there", [row("unmapped")?.open, row("unmapped")?.more.future], [1, 1]);
const br = board.backlog.reconciliation;
assertEq(
  "rule 116: Σ lanes + bugs + unmapped = open_count",
  [br.rows_sum, br.open_count, br.ok, br.by_row],
  [11, 11, true, { ops: 5, fec: 1, app: 0, hygiene: 3, design: 0, bugs: 1, unmapped: 1 }],
);
assertTrue("every row sums: shown + named_hidden + more = open", br.rows_add_up);
assertTrue("the backlog rows render, linking FIXES.md", html.includes('<span class="fid">FIX-85</span>') && html.includes("◆ loose"));
assertTrue("the bugs row renders full width", /Bugs — FIXES\.md § BUGS/.test(html));
assertTrue("`+ N more` renders with its emoji split", html.includes("+ 1 more (🟢 1)") && html.includes("+ 3 more (🟡 3)"));

// -- 6c. phases, done and archived projects (D3, D4) --------------------------
console.log("\nphases and done projects:");
const proj = (slug) => board.projects.find((p) => p.slug === slug);
assertEq(
  "tiles group under the phase their goal names, `no phase` last",
  board.project_groups.map((g) => [g.header, g.projects]),
  [["Phase 1 — MVP · ~42%", ["demo"]], ["no phase", ["loose"]]],
);
assertTrue("the phase header's token is PHASE_GOALS.md's own", html.includes("Phase 1 — MVP · ~42%"));
// Rule 105: status says active, every step is done — collapse AND lint.
assertEq("an all-done plan is done whatever its status says", proj("all-done")?.derived_status, "done");
assertTrue(
  "…with a lint line naming the disagreement",
  proj("all-done")?.problems.some((x) => /status: active, but all 2 steps are done/.test(x)),
  JSON.stringify(proj("all-done")?.problems),
);
assertTrue("a goal group PHASE_GOALS.md lacks is a lint line", proj("all-done")?.problems.some((x) => /no `### Not A Group` under Phase 2/.test(x)));
assertEq("done projects collapse into one row, finish date = the latest step's", board.done_row_text, "done: all-done ✓ 2/2 (2026-09-27)");
assertTrue("…which is not also a tile", !board.project_groups.some((g) => g.projects.includes("all-done")));
assertEq("archived: hidden entirely, a count remains", [board.archived_projects, board.projects.find((p) => p.slug === "archived")?.derived_status], [{ count: 1, slugs: ["archived"] }, "archived"]);
assertTrue("…and it is not rendered as a tile", !html.includes("An archived plan"));
const allBoard = buildBoard(inputs, { ...opts, projectsView: "all" });
assertEq("--projects all: no collapsed row", allBoard.done_row_text, "");
assertTrue("--projects all: the done plan is a tile", allBoard.project_groups.some((g) => g.projects.includes("all-done")));
assertTrue("--projects all: archived stays hidden", !allBoard.project_groups.some((g) => g.projects.includes("archived")));

// -- 6d. run windows and the prod-day collision (D5) --------------------------
console.log("\nrun windows:");
assertEq("parseWhen: after", [parseWhen("after 2026-09-29T16:30Z").kind, parseWhen("after 2026-09-29T16:30Z").start], ["after", "2026-09-29T16:30Z"]);
assertEq("parseWhen: window", parseWhen("2026-10-01T23:15Z..2026-10-02T03:30Z").kind, "window");
assertEq("parseWhen: a zoneless after is invalid", parseWhen("after 2026-09-29T16:30").kind, "invalid");
assertEq("parseWhen: a window that ends before it starts is invalid", parseWhen("2026-10-02T00:00Z..2026-10-01T00:00Z").kind, "invalid");
assertEq("parseWhen: any / absent", [parseWhen("any").kind, parseWhen(undefined).kind], ["any", "none"]);
assertEq("cc-906's pill, with board.local.json's zone", card(906)?.window_pill, "runs after Tue 09-29 16:30 UTC · 09:30 PDT");
assertEq("…and without a local file", windowPill(parseWhen("after 2026-09-29T16:30Z"), null), "runs after Tue 09-29 16:30 UTC");
assertEq("cc-907's pill is the bounded window", card(907)?.window_pill, "window Thu 10-01 23:15–03:30 UTC · 16:15–20:30 PDT");
assertEq("cc-904 (an instant) → runs …", card(904)?.window_pill, "runs Thu 10-01 16:30 UTC · 09:30 PDT");
assertEq("`when: any` → any time", windowPill(parseWhen("any"), null), "any time");
assertTrue("cc-906 sits on Tuesday at its instant", (day("2026-09-29")?.events ?? []).some((e) => e.kind === "run" && e.time === "16:30" && e.display_time === "after 16:30" && /cc-906/.test(e.label)));
assertTrue("cc-907 is a span label on its start day", (day("2026-10-01")?.events ?? []).some((e) => e.kind === "run" && e.display_time === "23:15–03:30" && /cc-907/.test(e.label)));
assertEq("the two prod-writes prompts on Thursday flag each other", [card(907)?.collisions, card(908)?.collisions], [[{ cc: 908, days: ["2026-10-01"] }], [{ cc: 907, days: ["2026-10-01"] }]]);
assertEq("a prod-reads prompt on the same day does not", card(904)?.collisions ?? [], []);
assertEq("the header counts the colliding cards", board.badges.prod_day_collisions, 2);
assertEq(
  "prod-writes → needs a supervised slot, and the next window after its own start",
  card(908)?.needs_slot,
  "needs a supervised slot · next supervised Mon 10-05 23:15 UTC (16:15 PDT)",
);
assertTrue("the collision renders on the card", html.includes("⚠ shares a prod day with cc-908 (10-01)"));
assertEq("whenDays: a window crossing midnight touches both days", whenDays(parseWhen("2026-10-01T23:15Z..2026-10-02T03:30Z")), ["2026-10-01", "2026-10-02"]);
assertEq("whenDays: ending exactly at midnight does not touch the next", whenDays(parseWhen("2026-10-01T20:00Z..2026-10-02T00:00Z")), ["2026-10-01"]);
// cc:prompt / cc:verify accept the new forms (one reader, one check).
assertEq("checkPromptFrontMatter accepts `after …`", checkPromptFrontMatter({ cc: "1", lane: "ops", when: "after 2026-09-29T16:30Z" }, { n: 1 }).problems, []);
assertEq("…and a window", checkPromptFrontMatter({ cc: "1", lane: "ops", when: "2026-10-01T23:15Z..2026-10-02T03:30Z" }, { n: 1 }).problems, []);
assertTrue("…and refuses a zoneless one", /when:/.test(checkPromptFrontMatter({ cc: "1", lane: "ops", when: "after 2026-09-29T16:30" }, { n: 1 }).problems.join(" ")));

// -- 6e. cron and nightly history (D6) ----------------------------------------
console.log("\nreceipts history:");
const histPaths = { ...paths, receiptsDir: resolve(F, "receipts-history") };
const histInputs = loadBoardInputs(histPaths);
assertEq("the newest 14 dated files are read, oldest first", [histInputs.history.length, histInputs.history[0].name, histInputs.history[13].name], [14, "2026-09-15.json", "2026-09-28.json"]);
assertEq("historyReceiptNames skips bands.json", historyReceiptNames(["2026-09-01.json", "bands.json", "2026-09-02.json"]), ["2026-09-01.json", "2026-09-02.json"]);
const hb = buildBoard(histInputs, { ...opts, paths: histPaths });
const hist = (name) => hb.cron_history.find((h) => h.jobname === name);
// The weekly job sits in seven files with one last_start, then seven with the
// next: two firings. Counting file rows would say fourteen.
assertEq("a weekly job carried seven files at a time is TWO firings", hist("weekly-job")?.firings, 2);
assertEq("…median / max / last over the firings, not the files", [hist("weekly-job")?.median_s, hist("weekly-job")?.max_s, hist("weekly-job")?.last_s], [200, 300, 300]);
assertEq("…the 15th (oldest) file's 9999 s firing is outside the window", hist("weekly-job")?.max_s < 9999, true);
assertEq("…its band, from bands.json", hist("weekly-job")?.band, { lo_s: 50, hi_s: 250 });
assertEq("…its last verdict, from the newest file", hist("weekly-job")?.last_verdict, "above");
assertEq("a failed firing counts, with no duration", [hist("failing-weekly")?.firings, hist("failing-weekly")?.with_duration, hist("failing-weekly")?.median_s], [1, 0, undefined]);
assertEq("a mid-window re-schedule is visible", hist("resched-job")?.schedules_seen, ["0 3 * * *", "0 1 * * 1"]);
assertEq("cronHistory dedupes by (jobname, last_start)", cronHistory([
  { name: "a", json: { cron_jobs: [{ jobname: "j", last_start: "t1", duration_s: 5 }] } },
  { name: "b", json: { cron_jobs: [{ jobname: "j", last_start: "t1", duration_s: 5 }] } },
]).map((h) => h.firings), [1]);
assertEq(
  "nightly walls by class: weekday / Sat / Sun",
  ["weekday", "sat", "sun"].map((k) => [hb.nightly_history[k].runs, hb.nightly_history[k].fec_median_s]),
  [[10, 300], [2, 300], [2, 5760]],
);
const hday = (date) => hb.week.days.find((d) => d.date === date);
const nightlyOn = (date) => hday(date)?.events.find((e) => e.kind === "nightly")?.label;
assertEq("Sunday's nightly label is Sunday's median", nightlyOn("2026-10-04"), "nightly dispatch (gha-dispatch) · Sun ~103 min, fec ~96 min (median of 2)");
assertEq("a weekday's label is the weekday median", nightlyOn("2026-09-29"), "nightly dispatch (gha-dispatch) · weekday ~12 min, fec ~5 min (median of 10)");
const weeklyEv = hday("2026-09-29")?.events.find((e) => e.kind === "cron" && /weekly-job/.test(e.label));
assertEq("the Tuesday cron event carries its size and last verdict", [weeklyEv?.size, weeklyEv?.verdict], ["~3 min · last 5 min · band 50s–4 min · 2 firings", "above"]);
assertTrue("…coloured by it", hb && renderHtml(hb).includes('class="ev v-above"'));
// Staleness: the history's newest file was generated 32 h before --now.
assertEq("a receipts file > 30 h old raises the banner", hb.receipts_stale, { stale: true, text: "receipts stale: last 2026-09-26 20:00 UTC" });
assertTrue("…at the top of the page", renderHtml(hb).indexOf('class="stale"') < renderHtml(hb).indexOf('class="hdr"'));
assertEq("the fixture's own receipts (4.5 h old) do not", board.receipts_stale.stale, false);
assertTrue("history board: no undefined / null / NaN", !/\bundefined\b|\bnull\b|\bNaN\b/.test(renderBoardJson(hb)) && !/\bundefined\b|\bnull\b|\bNaN\b/.test(renderHtml(hb)));

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
  const code = run(argv, { paths: pathsFor(boardDir), lanes: DEFAULT_LANES, sectionLanes: SECTION_LANES, head: "fixture0", verify, stdout: out, stderr: err });
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
