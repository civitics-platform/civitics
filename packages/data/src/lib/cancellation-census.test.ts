/**
 * The census's two verdicts, against the cases that decide whether a prod op
 * goes ahead.
 *
 * The fixture that matters most is the LAST one: zero traffic passes the 5xx
 * gate and must not be read as evidence of health, because a front door that is
 * answering nothing at all is exactly the FIX-1130 wedge.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sampleQueryName } from "@civitics/db";

import {
  answersExit,
  unavailableJson,
  unavailableSummary,
  CENSUS_EXIT,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  poissonP99,
  rendersIn,
  rendersLine,
  sanitizeLike,
  topPages,
  verdictFor,
  ATTRIBUTABLE_FIELDS,
  FLOOR_QUANTILE,
  LOGS_RETENTION_DAYS,
  MAX_ATTRIBUTION_MINUTES,
  PCT_5XX_GATE,
  RATIO_GATE,
  type AttributionRow,
  type EdgeBucket,
  type RenderSecond,
} from "./cancellation-census";

/** One second that lost a render. `events` is how many statements timed out in it. */
const sec = (startMs: number, events = 1, sampleQuery = "get_official_page"): RenderSecond => ({ startMs, events, sampleQuery });

/** `n` renders of one event each, one per second. */
const renders = (n: number): RenderSecond[] => Array.from({ length: n }, (_, i) => sec(i * 1000));

const bucket = (startMs: number, requests: number, n5xx: number): EdgeBucket => ({
  startMs,
  requests,
  n5xx,
});

/** A db fixture's rows (the raw Logs answer cc-162 pulled), as the census receives them from the helper. */
const fixtureRenders = (win: string): RenderSecond[] => {
  const f = JSON.parse(readFileSync(new URL(`../../../db/src/__fixtures__/census-renders/${win}.renders.json`, import.meta.url), "utf8")) as {
    answer: { rows: { s: number; n: number; q: string }[] };
  };
  return f.answer.rows.map((r) => ({ startMs: r.s * 1000, events: r.n, sampleQuery: sampleQueryName(r.q) }));
};

test("the baseline hour passes — 2 renders in 60 min is 0.033/min", () => {
  // cc-129's measured baseline, which is the number the gate is stated against.
  const v = verdictFor({ renders: [sec(0), sec(60_000)], minutes: 60, baseline: 0.033 });
  assert.equal(v.renders, 2);
  assert.ok(Math.abs(v.ratio_renders - 1.01) < 0.02);
  assert.equal(v.pass, true);
  // continuity: the pre-FIX-1232 fields keep their meanings, on events
  assert.equal(v.total, 2);
  assert.ok(Math.abs(v.rate - 0.0333) < 0.001);
  assert.ok(Math.abs(v.ratio - 1.01) < 0.02);
});

test("exactly 2x passes — the gate is <=, not <", () => {
  // 4 in 60 min = 0.0667/min = exactly 2 x 0.0333. A strict inequality here
  // would fail a run that is precisely at the stated boundary, which makes the
  // boundary unquotable.
  const v = verdictFor({ renders: renders(4), minutes: 60, baseline: 4 / 60 / RATIO_GATE });
  assert.equal(v.ratio_renders, RATIO_GATE);
  assert.equal(v.pass, true);
});

test("just past 2x fails once the count is above the floor", () => {
  // At 1/min over 60 min, λ = 60 and the P99 floor (79) sits well under 2x
  // (120), so the ratio is what binds: 121 is just past 2x and fails.
  const v = verdictFor({ renders: renders(121), minutes: 60, baseline: 1 });
  assert.ok(v.ratio_renders > RATIO_GATE);
  assert.ok(v.renders > v.floor_renders);
  assert.equal(v.pass, false);
  // cc-151: the same "just past 2x" at a small count is under the floor and
  // passes — this is the shape that failed before the floor.
  const small = verdictFor({ renders: renders(5), minutes: 60, baseline: 4 / 60 / RATIO_GATE });
  assert.ok(small.ratio_renders > RATIO_GATE);
  assert.equal(small.floor_renders, 6);
  assert.equal(small.pass, true);
});

// ───────────────────────────── the floor (cc-151 D1) ─────────────────────────

test("poissonP99 pins: λ=2.0 → 6, λ=0.5 → 3, λ=0 → 0", () => {
  assert.equal(poissonP99(2.0), 6);
  assert.equal(poissonP99(0.5), 3);
  assert.equal(poissonP99(0), 0);
  // the λ this census actually runs at: 0.033 x 60 and 0.033 x 15
  assert.equal(poissonP99(0.033 * 60), 6);
  assert.equal(poissonP99(0.033 * 15), 3);
  // not finite or negative is "no expected events"
  assert.equal(poissonP99(-1), 0);
  assert.equal(poissonP99(Number.NaN), 0);
});

test("poissonP99 is the SMALLEST k at the 99th percentile — checked against the CDF", () => {
  const cdf = (l: number, k: number) => {
    let p = Math.exp(-l);
    let c = p;
    for (let i = 1; i <= k; i++) { p *= l / i; c += p; }
    return c;
  };
  for (const l of [0.1, 0.5, 1, 1.98, 2, 5, 10, 30]) {
    const k = poissonP99(l);
    assert.ok(cdf(l, k) >= FLOOR_QUANTILE, `λ=${l}: P(X<=${k}) >= 0.99`);
    if (k > 0) assert.ok(cdf(l, k - 1) < FLOOR_QUANTILE, `λ=${l}: P(X<=${k - 1}) < 0.99`);
  }
});

test("poissonP99 does not underflow at a large λ", () => {
  // e^-1000 is 0 in a double; a naive sum would never reach 0.99.
  const k = poissonP99(1000);
  assert.ok(k > 1000 && k < 1100, `got ${k}`);
});

test("cc-148's three prod readings plus the edges — old verdict → new verdict (now counted in renders)", () => {
  // [renders, minutes, old pass (ratio <= 2), new pass]
  const FIXTURES: Array<[number, number, boolean, boolean]> = [
    [6, 60, false, true], //   cc-148 23:55 — ratio 3.03, under the floor 6
    [12, 60, false, false], // cc-148 00:23
    [6, 15, false, false], //  cc-148 00:23, the 15-min reading — the 00:08–00:23 burst
    [4, 60, false, true], //   failed before the floor (ratio 2.02)
    [7, 60, false, false], //  first count over the 60-min floor
    [3, 15, false, true], //   the 15-min floor is 3
    [4, 15, false, false], //  a burst of 4 in 15 min still trips
    [40, 60, false, false], // the ratio dominates at a large count
    [2, 60, true, true], //    the baseline hour
    [0, 15, true, true],
  ];
  for (const [n, minutes, oldPass, newPass] of FIXTURES) {
    const v = verdictFor({ renders: renders(n), minutes, baseline: 0.033 });
    assert.equal(v.ratio_renders <= RATIO_GATE, oldPass, `{${n}, ${minutes} min} old verdict`);
    assert.equal(v.pass, newPass, `{${n}, ${minutes} min} new verdict — ${v.note}`);
  }
});

test("the note names the renders, the events, the ratio AND the floor", () => {
  const under = verdictFor({ renders: renders(6), minutes: 60, baseline: 0.033 });
  assert.equal(under.note, "6 render(s) (6 event(s)) over 60 min — ratio 3.03 > 2 but <= P99 floor 6 at λ=2.0");
  const over = verdictFor({ renders: renders(12), minutes: 60, baseline: 0.033 });
  assert.equal(over.note, "12 render(s) (12 event(s)) over 60 min — ratio 6.06 > 2 and > P99 floor 6 at λ=2.0");
  const fine = verdictFor({ renders: [sec(0, 3)], minutes: 60, baseline: 0.033 });
  assert.equal(fine.note, "1 render(s) (3 event(s)) over 60 min — ratio 0.51 <= 2");
  assert.equal(under.lambda_renders.toFixed(2), "1.98");
  assert.equal(under.floor_renders, 6);
  assert.equal(under.floor, 6, "the events floor, kept for continuity, is the same number at the same baseline");
});

test("the 15-min floor does not blind a real burst: 6 renders in 15 min fails, as cc-148's 00:08–00:23 did", () => {
  const v = verdictFor({ renders: renders(6), minutes: 15, baseline: 0.033 });
  assert.equal(v.floor_renders, 3);
  assert.equal(v.pass, false);
});

test("the 2026-09-07 shape fails loudly — 202 cancellations, even if every render fanned out five ways", () => {
  // The run this whole gate exists because of: FIX-1165's set-2 apply, 202
  // cancellations against a baseline of 1 over the equivalent window. Grouped
  // by second at the worst plausible fan-out it is still ~40 renders.
  const v = verdictFor({ renders: Array.from({ length: 40 }, (_, i) => sec(i * 1000, 5)), minutes: 60, baseline: 0.033 });
  assert.equal(v.events, 200);
  assert.equal(v.pass, false);
  assert.ok(v.ratio_renders > 20);
});

test("zero cancellations passes and says so", () => {
  const v = verdictFor({ renders: [], minutes: 60, baseline: 0.033 });
  assert.equal(v.renders, 0);
  assert.equal(v.events, 0);
  assert.equal(v.rate, 0);
  assert.equal(v.pass, true);
  assert.match(v.note, /no cancellations/);
});

test("FIX-1232: a fan-out of six statements in one second is ONE render — cc-151's 09:30:26 page", () => {
  const v = verdictFor({ renders: [sec(0, 6, "entity_tags")], minutes: 15, baseline: 0.033 });
  assert.equal(v.renders, 1);
  assert.equal(v.events, 6);
  assert.equal(v.pass, true, "one render is under the 15-min floor of 3");
  // In the old unit the same page was 6 > floor 3 at ratio 12.1 — a trip on its own.
  assert.ok(v.total > v.floor && v.ratio > RATIO_GATE, "the continuity fields show what the old gate saw");
});

test("a zero baseline is called out rather than dividing to Infinity", () => {
  const clean = verdictFor({ renders: [], minutes: 60, baseline: 0 });
  assert.equal(clean.pass, true);
  assert.match(clean.note, /baseline is 0/);

  const dirty = verdictFor({ renders: [sec(0)], minutes: 60, baseline: 0 });
  assert.equal(dirty.pass, false);
  assert.equal(dirty.ratio_renders, Number.POSITIVE_INFINITY);
  // unchanged by the floor (cc-151): λ = 0, floor 0, one render still fails
  assert.equal(dirty.floor_renders, 0);
});

test("FIX-1232: --baseline-renders moves the renders floor and nothing else; absent, it IS the printed baseline (decision 6)", () => {
  const same = verdictFor({ renders: renders(4), minutes: 60, baseline: 0.033 });
  assert.equal(same.baseline_renders, 0.033);
  assert.equal(same.floor_renders, same.floor);
  const low = verdictFor({ renders: renders(4), minutes: 60, baseline: 0.033, baselineRenders: 0.01 });
  assert.equal(low.baseline_renders, 0.01);
  assert.equal(low.floor_renders, poissonP99(0.6));
  assert.equal(low.floor, 6, "the events floor stays on --baseline");
  assert.equal(low.pass, false, "4 renders at 0.01/min: ratio 6.67, floor 3");
});

// ── FIX-1232 rule 105: the shapes that must flip, on the real fixture rows ──

test("FIX-1232 rule 105: cc-151's stopping 15-min reading (8 events) is 3 renders — the 57014 half PASSES at floor 3", () => {
  const rows = fixtureRenders("cc151");
  const end = Date.parse("2026-09-24T09:34:11.098Z");
  const pre6 = rendersIn(rows, end - 15 * 60_000, end);
  const v = verdictFor({ renders: pre6, minutes: 15, baseline: 0.033 });
  assert.deepEqual([v.renders, v.events, v.floor_renders], [3, 8, 3]);
  assert.equal(v.pass, true, "3 renders <= floor 3");
  // Before: the same window, gated on the 8 events — 8 > 3 at ratio 16.16.
  assert.ok(v.total > v.floor && v.ratio > RATIO_GATE);
  // The edge half is unchanged (its floor was stopped — FIX-1233): 2 of 183 still fails.
  assert.equal(edgeVerdictFor([bucket(0, 183, 2)]).pass, false);
});

test("FIX-1232 rule 105: cc-148's ~97 %-trip shape — seven 15-min readings of an ordinary night — all pass in renders", () => {
  for (const n of [0, 1, 1, 2, 0, 1, 3]) {
    assert.equal(verdictFor({ renders: renders(n), minutes: 15, baseline: 0.033 }).pass, true, `${n} render(s) in 15 min`);
  }
});

test("FIX-1232: rendersIn windows a reading into CALLs; topPages and rendersLine name what was lost — cc-151's run", () => {
  const rows = fixtureRenders("cc151");
  // CALL 5 (09:28:20.064 → 09:32:36.625): the six-event page.
  const call5 = rendersIn(rows, Date.parse("2026-09-24T09:28:20.064Z"), Date.parse("2026-09-24T09:32:36.625Z"));
  assert.equal(rendersLine(call5), "renders_lost 1 · events 6 · pages: entity_tags");
  assert.equal(rendersLine([]), "renders_lost 0 · events 0");
  assert.equal(rendersLine(rows), "renders_lost 4 · events 9 · pages: entity_tags, get_official_page, officials");
  assert.deepEqual(topPages([sec(0, 1, "a"), sec(1000, 1, "b"), sec(2000, 2, "b")], 5),
    [{ page: "b", renders: 2, events: 3 }, { page: "a", renders: 1, events: 1 }]);
  // The CALL's first second counts even though the CALL began mid-second.
  assert.equal(rendersIn([sec(Date.parse("2026-09-24T09:04:58Z"))], Date.parse("2026-09-24T09:04:58.789Z"), Date.parse("2026-09-24T09:05:00Z")).length, 1);
});

test("the edge gate reads the last bucket WITH traffic, not the last bucket", () => {
  // The newest bucket is routinely empty (the window is aligned to a boundary
  // that has only just passed). Reading it literally would gate on 0 of 0.
  const v = edgeVerdictFor([
    bucket(0, 500, 0),
    bucket(900_000, 400, 20), // 5.0 % — the one that should decide
    bucket(1_800_000, 0, 0),
  ]);
  assert.equal(v.lastClosed?.startMs, 900_000);
  assert.ok(v.pct5xx !== null && Math.abs(v.pct5xx - 5) < 0.001);
  assert.equal(v.pass, false);
});

test("1 % exactly passes", () => {
  const v = edgeVerdictFor([bucket(0, 1000, 10)]);
  assert.equal(v.pct5xx, PCT_5XX_GATE);
  assert.equal(v.pass, true);
});

test("no traffic at all passes, and the note refuses to call it health", () => {
  // The wrong-but-green shape. A front door answering nothing is the FIX-1130
  // wedge, and the verdict must not read as a clean bill just because 0/0 has
  // no 5xx in it.
  const v = edgeVerdictFor([bucket(0, 0, 0), bucket(900_000, 0, 0)]);
  assert.equal(v.lastClosed, null);
  assert.equal(v.pct5xx, null);
  assert.equal(v.pass, true);
  assert.match(v.note, /nothing proved/);
});

test("an empty bucket list is the same case as empty buckets", () => {
  const v = edgeVerdictFor([]);
  assert.equal(v.pass, true);
  assert.match(v.note, /no traffic/);
});

// ───────────────────────── attribution mode (cc-137) ─────────────────────────

const row = (group: string, count: number): AttributionRow => ({ group, count });

const FIXTURE: AttributionRow[] = [
  row("get_official_page", 10),
  row("enrichment_queue", 9),
  row("check_senate_reference_cohort", 7),
  row("link_officials_to_districts", 1),
];

test("attribution renders every group with its share, and a total", () => {
  const out = formatAttribution({
    rows: FIXTURE,
    field: "query",
    like: null,
    startIso: "2026-09-18T03:12:52Z",
    endIso: "2026-09-19T03:12:52Z",
  });
  assert.match(out, /by query/);
  assert.match(out, /get_official_page\s+10\s+37\.0 %/);
  assert.match(out, /link_officials_to_districts\s+1\s+3\.7 %/);
  assert.match(out, /27\s+total/);
  // Attribution is not a gate, and the output says so — the one line that stops
  // a reader quoting it as one.
  assert.match(out, /NOT A GATE/);
});

test("--like is echoed into the header so a quoted number carries its filter", () => {
  const out = formatAttribution({
    rows: [row("get_official_page", 10)],
    field: "query",
    like: "get_official_page",
    startIso: "a",
    endIso: "b",
  });
  assert.match(out, /query like %get_official_page%/);
});

test("no match is stated, not rendered as an empty table", () => {
  const out = formatAttribution({
    rows: [],
    field: "user_name",
    like: null,
    startIso: "a",
    endIso: "b",
  });
  assert.match(out, /no statement-timeout cancellation matched/);
  assert.doesNotMatch(out, /total/);
});

// The attribution SQL's own tests (grouping by function name, the field key,
// --like in the WHERE) moved with the builder to packages/db/src/
// supabase-logs.test.ts (FIX-1219). What stays here is the census's side: the
// allow-list it re-exports is the one the builder enforces.

test("every attributable field is a field a cancel row actually carries", () => {
  // Probed on prod, cc-137 read 2, and re-probed on the `logs` endpoint in
  // cc-155 (every one is a parsed.* key on the 09-24 09:30:26 cancellation).
  // An unknown key reads '' rather than erroring now, so the list is what
  // keeps --by from grouping everything under (null).
  for (const f of ATTRIBUTABLE_FIELDS) assert.equal(isAttributableField(f), true);
  assert.equal(isAttributableField("duration"), false);
  assert.equal(isAttributableField("role"), false);
});

test("sanitizeLike rejects anything that could close the SQL string literal", () => {
  assert.equal(sanitizeLike("get_official_page"), "get_official_page");
  assert.equal(sanitizeLike("public.votes"), "public.votes");
  assert.equal(sanitizeLike("a'b"), null);
  assert.equal(sanitizeLike("a--b"), "a--b"); // hyphens are fine INSIDE a literal
  assert.equal(sanitizeLike("a\b"), null);
  assert.equal(sanitizeLike(""), null);
  assert.equal(sanitizeLike("x".repeat(121)), null);
});

test("the 24h clamp and the 7-day retention are stated as constants, not prose", () => {
  // Measured (cc-137 read 2, and again on the `logs` endpoint in cc-155 D2):
  // above 1440 minutes the Logs API returns the OLDEST 24 h of the range with
  // no error — a wrong answer that looks right.
  assert.equal(MAX_ATTRIBUTION_MINUTES, 1440);
  assert.equal(LOGS_RETENTION_DAYS, 7);
});

test("FIX-1219: the census refuses --minutes over the clamp in BOTH modes, not only --by", () => {
  const src = readFileSync(new URL("../scripts/cancellation-census.ts", import.meta.url), "utf8");
  assert.match(src, /if \(a\.minutes > MAX_ATTRIBUTION_MINUTES\) \{/);
  assert.doesNotMatch(src, /a\.by !== null && a\.minutes > MAX_ATTRIBUTION_MINUTES/);
});

test("FIX-1219: a bare `--` (pnpm passes it through) is skipped, not an unknown flag that exits 2 = dark", () => {
  const src = readFileSync(new URL("../scripts/cancellation-census.ts", import.meta.url), "utf8");
  const sw = src.slice(src.indexOf("switch (argv[i])"), src.indexOf("default:", src.indexOf("switch (argv[i])")));
  assert.match(sw, /case "--":\s*\n(\s*\/\/[^\n]*\n)*\s*break;/);
});

test("FIX-1219: the census builds no Logs URL and no SQL of its own — both come from the helper", () => {
  const src = readFileSync(new URL("../scripts/cancellation-census.ts", import.meta.url), "utf8");
  // (The header may still NAME logs.all as history; it must not build a URL.)
  assert.doesNotMatch(src, /api\.supabase\.com|analytics\/endpoints/);
  assert.doesNotMatch(src, /\bselect\b[\s\S]*\bfrom (postgres|edge)_logs\b/i);
  assert.doesNotMatch(src, /\/ 1000\)/, "buckets arrive in ms; no consumer keeps a unit conversion");
  for (const f of ["queryCancellationRenders", "queryEdgeBuckets", "queryAttribution"]) assert.match(src, new RegExp(`\\b${f}\\(`));
});

test("FIX-1232: the gate reads renders IN PLACE of the per-minute buckets — still two Logs calls, not three (rule 190)", () => {
  const src = readFileSync(new URL("../scripts/cancellation-census.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /queryCancellationBuckets/, "the bucket read is gone from the census");
  const gate = code.slice(code.indexOf("const edgeEnd"), code.indexOf("main().catch("));
  assert.equal((gate.match(/\bquery[A-Za-z]+\(/g) ?? []).length, 2, "the gate path makes exactly two reads");
  const only = code.slice(code.indexOf("if (args.rendersOnly) {"), code.indexOf("const edgeEnd"));
  assert.deepEqual(only.match(/\bquery[A-Za-z]+\(/g), ["queryCancellationRenders("], "--renders-only makes one");
  assert.match(code, /verdictFor\(\{ renders, minutes: args\.minutes, baseline: args\.baseline, baselineRenders: args\.baselineRenders \?\? undefined \}\)/);
  assert.match(code, /user_requests: null,/, "the field stays, stated as not read");
});

test("the attribution path RETURNS — a process.exit(0) there exits 127 on Windows", () => {
  // Not a style point. `process.exit(0)` after a single fetch aborts the
  // process on Windows (libuv UV_HANDLE_CLOSING assertion) and the shell reads
  // 127, so a prompt gating on `exit 0` sees a failure. Measured on this box.
  // The gate path was believed safe because it awaits two fetches; cc-156
  // measured it too (2026-09-25 03:55:12 UTC: VERDICT PASS, then the
  // assertion, exit 127), so it sets exitCode as well.
  const src = readFileSync(
    new URL("../scripts/cancellation-census.ts", import.meta.url),
    "utf8",
  );
  // Anchored to the attribution block alone — `--help` legitimately calls
  // process.exit(0) from parseArgs, before any fetch has been opened.
  const from = src.indexOf("── attribution mode ──");
  const to = src.indexOf("// The edge half is bucketed");
  assert.ok(from > 0 && to > from, "attribution block not found where expected");
  const block = src.slice(from, to);
  assert.match(block, /process\.exitCode = 0;\s*\n\s*return;/);
  assert.doesNotMatch(block, /process\.exit\(0\);/);
  // The gate path, after both halves' fetches: exitCode, never process.exit.
  const gate = src.slice(to, src.indexOf("main().catch("));
  assert.match(gate, /process\.exitCode = v\.pass && ev\.pass \? 0 : 1;/);
  assert.doesNotMatch(gate, /^\s*process\.exit\(/m, "a call, not the comments that name it");
});

test("--by is allow-listed before it reaches the SQL string", () => {
  // buildAttributionSql interpolates the field name directly, so the guard has
  // to be the type predicate rather than anything downstream of it.
  const src = readFileSync(
    new URL("../scripts/cancellation-census.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /isAttributableField\(f\)/);
});

// ── FIX-1219 (cc-154 D1): a removed endpoint is `unavailable` (exit 8), not dark (exit 2) ──
//
// The fetch cases (410 / 404 / 503 / 429 / throw / 200-with-error / row cap)
// moved with `queryLogs` to packages/db/src/supabase-logs.test.ts. The exit
// mapping stays here: it is the census's vocabulary, not the helper's.

test("FIX-1219: rows on every half go on to the verdict", () => {
  const rows = [{ startMs: 1, requests: 10, n5xx: 0 }];
  assert.equal(answersExit([{ kind: "rows", rows: [] }, { kind: "rows", rows }]), null, "rows on both halves: go on to the verdict");
});

test("FIX-1219: exit 8 when any half is unavailable, 2 when any half is dark, and 8 wins over a dark sibling", () => {
  const u = { kind: "unavailable" as const, status: 410, detail: "Logs API 410 Gone" };
  const d = { kind: "dark" as const, detail: "Logs API 503" };
  const r = { kind: "rows" as const, rows: [] };
  assert.deepEqual(answersExit([u, u]), { code: 8, status: 410, detail: "Logs API 410 Gone" });
  assert.deepEqual(answersExit([d, u]), { code: 8, status: 410, detail: "Logs API 410 Gone" });
  assert.deepEqual(answersExit([r, d]), { code: 2, detail: "Logs API 503" });
  assert.deepEqual(CENSUS_EXIT, { pass: 0, fail: 1, dark: 2, unavailable: 8 });
  assert.ok(!(Object.values(CENSUS_EXIT) as number[]).includes(3), "3 stays retired");
});

test("FIX-1219: the exit-8 JSON replaces the verdict halves, and the summary names the status and the FIX", () => {
  const w = { start: "2026-09-24T23:38:54Z", end: "2026-09-25T00:38:54Z", minutes: 60 };
  assert.equal(unavailableSummary(410), "unavailable — Logs API endpoint removed (410; FIX-1219)");
  const j = unavailableJson(410, w);
  assert.deepEqual(j, {
    window: w, unavailable: true, http_status: 410, fix: "FIX-1219",
    summary: "unavailable — Logs API endpoint removed (410; FIX-1219)",
  });
  assert.ok(!("cancellations" in j) && !("edge" in j) && !("pass" in j), "no verdict half rides an exit 8");
});

test("cc-156: a removed table or field (a 200) exits 8 with the helper's detail in the summary", () => {
  const w = { start: "2026-09-25T02:40:00Z", end: "2026-09-25T03:40:00Z", minutes: 60 };
  const detail = 'Logs API schema changed: Field "source_name" does not exist.';
  assert.equal(unavailableSummary(200, detail), `unavailable — ${detail} (FIX-1219)`);
  assert.deepEqual(unavailableJson(200, w, detail), {
    window: w, unavailable: true, http_status: 200, detail, fix: "FIX-1219",
    summary: `unavailable — ${detail} (FIX-1219)`,
  });
  // A removed PATH keeps cc-154's wording whatever the detail says.
  assert.equal(unavailableSummary(410, "Logs API 410 Gone"), "unavailable — Logs API endpoint removed (410; FIX-1219)");
  const u = { kind: "unavailable" as const, status: 200, detail };
  assert.deepEqual(answersExit([{ kind: "rows" as const, rows: [] }, u]), { code: 8, status: 200, detail });
});

test("FIX-1219: the script ends exit 8 and exit 2 on process.exitCode, never process.exit() (the Windows 127)", () => {
  const src = readFileSync(new URL("../scripts/cancellation-census.ts", import.meta.url), "utf8");
  assert.match(src, /process\.exitCode = CENSUS_EXIT\.unavailable;/);
  assert.equal((src.match(/process\.exitCode = CENSUS_EXIT\.dark;\s*\n\s*return;/g) ?? []).length, 3, "all three dark paths: --by, --renders-only, the gate");
  assert.doesNotMatch(src, /process\.exit\(8\)/);
  assert.equal((src.match(/exitUnavailable\(/g) ?? []).length, 4, "defined once, called from the gate, --by and --renders-only");
});
