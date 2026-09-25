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

import {
  answersExit,
  unavailableJson,
  unavailableSummary,
  CENSUS_EXIT,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  poissonP99,
  sanitizeLike,
  verdictFor,
  ATTRIBUTABLE_FIELDS,
  FLOOR_QUANTILE,
  LOGS_RETENTION_DAYS,
  MAX_ATTRIBUTION_MINUTES,
  PCT_5XX_GATE,
  RATIO_GATE,
  type AttributionRow,
  type CancellationBucket,
  type EdgeBucket,
} from "./cancellation-census";

const min = (startMs: number, timeouts: number, userRequests = 0): CancellationBucket => ({
  startMs,
  timeouts,
  userRequests,
});

const bucket = (startMs: number, requests: number, n5xx: number): EdgeBucket => ({
  startMs,
  requests,
  n5xx,
});

test("the baseline hour passes — 2 cancellations in 60 min is 0.033/min", () => {
  // cc-129's measured baseline, which is the number the gate is stated against.
  const v = verdictFor({ cancellations: [min(0, 1), min(60_000, 1)], minutes: 60, baseline: 0.033 });
  assert.equal(v.total, 2);
  assert.ok(Math.abs(v.rate - 0.0333) < 0.001);
  assert.ok(Math.abs(v.ratio - 1.01) < 0.02);
  assert.equal(v.pass, true);
});

test("exactly 2x passes — the gate is <=, not <", () => {
  // 4 in 60 min = 0.0667/min = exactly 2 x 0.0333. A strict inequality here
  // would fail a run that is precisely at the stated boundary, which makes the
  // boundary unquotable.
  const v = verdictFor({
    cancellations: [min(0, 4)],
    minutes: 60,
    baseline: 4 / 60 / RATIO_GATE,
  });
  assert.equal(v.ratio, RATIO_GATE);
  assert.equal(v.pass, true);
});

test("just past 2x fails once the count is above the floor", () => {
  // At 1/min over 60 min, λ = 60 and the P99 floor (79) sits well under 2x
  // (120), so the ratio is what binds: 121 is just past 2x and fails.
  const v = verdictFor({ cancellations: [min(0, 121)], minutes: 60, baseline: 1 });
  assert.ok(v.ratio > RATIO_GATE);
  assert.ok(v.total > v.floor);
  assert.equal(v.pass, false);
  // cc-151: the same "just past 2x" at a small count is under the floor and
  // passes — this is the shape that failed before the floor.
  const small = verdictFor({ cancellations: [min(0, 5)], minutes: 60, baseline: 4 / 60 / RATIO_GATE });
  assert.ok(small.ratio > RATIO_GATE);
  assert.equal(small.floor, 6);
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

test("cc-148's three prod readings plus the edges — old verdict → new verdict", () => {
  // [total, minutes, old pass (ratio <= 2), new pass]
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
    const v = verdictFor({ cancellations: n > 0 ? [min(0, n)] : [], minutes, baseline: 0.033 });
    assert.equal(v.ratio <= RATIO_GATE, oldPass, `{${n}, ${minutes} min} old verdict`);
    assert.equal(v.pass, newPass, `{${n}, ${minutes} min} new verdict — ${v.note}`);
  }
});

test("the note names the ratio AND the floor", () => {
  const under = verdictFor({ cancellations: [min(0, 6)], minutes: 60, baseline: 0.033 });
  assert.equal(under.note, "6 over 60 min — ratio 3.03 > 2 but <= P99 floor 6 at λ=2.0");
  const over = verdictFor({ cancellations: [min(0, 12)], minutes: 60, baseline: 0.033 });
  assert.equal(over.note, "12 over 60 min — ratio 6.06 > 2 and > P99 floor 6 at λ=2.0");
  const fine = verdictFor({ cancellations: [min(0, 1)], minutes: 60, baseline: 0.033 });
  assert.equal(fine.note, "1 over 60 min — ratio 0.51 <= 2");
  assert.equal(under.lambda.toFixed(2), "1.98");
  assert.equal(under.floor, 6);
});

test("the 15-min floor does not blind the burst: 6 in 15 min fails, as cc-148's 00:08–00:23 did", () => {
  const v = verdictFor({ cancellations: [min(0, 2), min(60_000, 4)], minutes: 15, baseline: 0.033 });
  assert.equal(v.floor, 3);
  assert.equal(v.pass, false);
});

test("the 2026-09-07 shape fails loudly — 202 cancellations, ~70x baseline", () => {
  // The run this whole gate exists because of: FIX-1165's set-2 apply, 202
  // cancellations against a baseline of 1 over the equivalent window.
  const v = verdictFor({ cancellations: [min(0, 202)], minutes: 60, baseline: 0.033 });
  assert.equal(v.pass, false);
  assert.ok(v.ratio > 100);
});

test("zero cancellations passes and says so", () => {
  const v = verdictFor({ cancellations: [], minutes: 60, baseline: 0.033 });
  assert.equal(v.total, 0);
  assert.equal(v.rate, 0);
  assert.equal(v.pass, true);
  assert.match(v.note, /no cancellations/);
});

test("user-request cancels never enter the gated total", () => {
  // A cancel somebody issued by hand is a different event with a different
  // cause. Folding it in would fail a window whose only cancellations were an
  // operator pressing Ctrl-C.
  const v = verdictFor({
    cancellations: [min(0, 0, 40), min(60_000, 1, 9)],
    minutes: 60,
    baseline: 0.033,
  });
  assert.equal(v.total, 1);
  assert.equal(v.pass, true);
});

test("a zero baseline is called out rather than dividing to Infinity", () => {
  const clean = verdictFor({ cancellations: [], minutes: 60, baseline: 0 });
  assert.equal(clean.pass, true);
  assert.match(clean.note, /baseline is 0/);

  const dirty = verdictFor({ cancellations: [min(0, 1)], minutes: 60, baseline: 0 });
  assert.equal(dirty.pass, false);
  assert.equal(dirty.ratio, Number.POSITIVE_INFINITY);
  // unchanged by the floor (cc-151): λ = 0, floor 0, one event still fails
  assert.equal(dirty.floor, 0);
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
  for (const f of ["queryCancellationBuckets", "queryEdgeBuckets", "queryAttribution"]) assert.match(src, new RegExp(`\\b${f}\\(`));
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
  assert.equal((src.match(/process\.exitCode = CENSUS_EXIT\.dark;\s*\n\s*return;/g) ?? []).length, 2, "both dark paths");
  assert.doesNotMatch(src, /process\.exit\(8\)/);
  assert.equal((src.match(/exitUnavailable\(/g) ?? []).length, 3, "defined once, called from the gate and from --by");
});
