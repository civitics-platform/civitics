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
  buildAttributionSql,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  sanitizeLike,
  verdictFor,
  ATTRIBUTABLE_FIELDS,
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

test("just past 2x fails", () => {
  const v = verdictFor({ cancellations: [min(0, 5)], minutes: 60, baseline: 4 / 60 / RATIO_GATE });
  assert.ok(v.ratio > RATIO_GATE);
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

test("--by query groups by the function name, never the pgrst envelope", () => {
  const sql = buildAttributionSql("query", null);
  // The envelope is ~600 chars and differs per bind shape; grouping on it would
  // return one row per shape and blow the ~100-row cap.
  assert.match(sql, /regexp_extract\(p\.query/);
  assert.match(sql, /"public"/);
  assert.match(sql, /group by g/);
  assert.match(sql, /limit 20/);
});

test("a non-query field groups on the field itself", () => {
  const sql = buildAttributionSql("user_name", null);
  assert.match(sql, /cast\(p\.user_name as string\)/);
  assert.doesNotMatch(sql, /regexp_extract/);
});

test("--like lands in the WHERE clause, not the grouping", () => {
  const sql = buildAttributionSql("query", "get_official_page");
  assert.match(sql, /and p\.query like '%get_official_page%'/);
});

test("every attributable field is a field a cancel row actually carries", () => {
  // Probed on prod, cc-137 read 2. A field not in metadata.parsed makes the
  // whole query error rather than return a null column, so this list is load-
  // bearing and not decoration.
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
  // Measured (cc-137 read 2): above 1440 minutes the Logs API returns the
  // OLDEST 24 h of the range with no error — a wrong answer that looks right.
  assert.equal(MAX_ATTRIBUTION_MINUTES, 1440);
  assert.equal(LOGS_RETENTION_DAYS, 7);
});

test("the attribution path RETURNS — a process.exit(0) there exits 127 on Windows", () => {
  // Not a style point. `process.exit(0)` after a single fetch aborts the
  // process on Windows (libuv UV_HANDLE_CLOSING assertion) and the shell reads
  // 127, so a prompt gating on `exit 0` sees a failure. Measured on this box.
  // The gate path below it still exits explicitly and is fine — it awaits two
  // fetches. This pins the asymmetry, which is otherwise invisible.
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
