/**
 * FIX-1130 — the front-door detector, replayed against the real incidents.
 *
 * These are not synthetic fixtures. Both arrays are verbatim Supabase Logs API
 * output (analytics/endpoints/logs.all over edge_logs, 15-minute buckets),
 * pulled 2026-09-04. Each row is [bucketStartMs, requests, n_5xx, n_52x]. They
 * live in __fixtures__/front-door-series.ts since FIX-1285, which replays the
 * restart decision against the same rows.
 *
 * The point of testing this way is that the thresholds in front-door-verdict.ts
 * were chosen FROM this data, so the tests are the calibration itself rather
 * than a restatement of the code. If someone widens a threshold, the
 * false-positive test fails against six real days of production traffic.
 *
 * WHY THE HEALTHY SET IS SIX DAYS AND NOT SEVEN: the Logs API retains about
 * seven days. Measured 2026-09-04, a query starting 2026-08-27 returns zero
 * rows and 2026-08-28 returns data. 2026-08-31 is excluded because it is the
 * outage. The set is therefore 08-28/29/30 + 09-01/02/03.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bucketIsRed,
  alignBuckets,
  floorToBucket,
  decideFrontDoorVerdict,
  shouldSend,
  renderFrontDoorEmail,
  BUCKET_MS,
  BUCKET_COUNT,
  RED_MIN_52X,
  RED_MIN_52X_RATIO,
  bucketIs503Red,
  DB_UNREACHABLE_RUNBOOK,
  RED_MIN_503,
  RED_MIN_503_RATIO,
  corroboratorLabel,
  isLogsEndpointGone,
  type FrontDoorBucket,
  type FrontDoorCorroborator,
  type FrontDoorProbe,
} from "./front-door-verdict";
import {
  OUTAGE_0831,
  HEALTHY,
  OUTAGE_1006,
  OUTAGE_1123,
  WEEK_1120,
  type FrontDoorRow,
} from "./__fixtures__/front-door-series";

type Row = FrontDoorRow;

const toBucket = (r: Row): FrontDoorBucket => ({
  startMs: r[0],
  requests: r[1],
  n5xx: r[2],
  n52x: r[3],
  // FIX-1446: a four-element row was pulled before anyone counted 503.
  n503: r[4] ?? 0,
});

/** A probe that answered — isolates the logs arm in these replays. */
const PROBE_OK: FrontDoorProbe = {
  answered: true,
  attempts: [{ status: 401, ms: 96 }],
};

/**
 * Replay a series the way the cron actually sees it: at each 15-minute tick,
 * evaluate the four buckets that closed before it, and record what would be
 * sent. Returns one entry per email that would leave the building.
 * `offsetMs` is where in the slot the tick fires: :02 by default, :00:28 for
 * the instants prod's ticks actually land at (FIX-1446's 11-23 replay).
 */
function replay(rows: Row[], offsetMs = 2 * 60 * 1000): Array<{ at: string; state: string }> {
  const byStart = new Map<number, FrontDoorBucket>();
  for (const r of rows) byStart.set(r[0], toBucket(r));
  const starts = rows.map((r) => r[0]).sort((a, b) => a - b);
  const first = starts[0]!;
  const last = starts[starts.length - 1]!;

  const sent: Array<{ at: string; state: string }> = [];
  // Tick at :02 past each boundary, so the boundary's bucket is closed and the
  // on-the-hour tick lands inside the minute<15 hourly-dedup window.
  for (let t = first + BUCKET_COUNT * BUCKET_MS; t <= last + BUCKET_MS; t += BUCKET_MS) {
    const nowMs = t + offsetMs;
    const endBoundary = floorToBucket(nowMs);
    const present: FrontDoorBucket[] = [];
    for (let i = BUCKET_COUNT; i >= 1; i--) {
      const b = byStart.get(endBoundary - i * BUCKET_MS);
      if (b) present.push(b);
    }
    const buckets = alignBuckets(present, endBoundary);
    const verdict = decideFrontDoorVerdict(buckets, PROBE_OK);
    if (shouldSend(verdict, nowMs)) {
      sent.push({ at: new Date(nowMs).toISOString(), state: verdict.state });
    }
  }
  return sent;
}

describe("bucketIsRed", () => {
  const b = (requests: number, n52x: number): FrontDoorBucket => ({
    startMs: 0,
    requests,
    n5xx: n52x,
    n52x,
  });

  test("a fully wedged low-traffic bucket is RED — the case a count-only rule loses", () => {
    // 2026-08-31 07:15 UTC: five requests, all five 52x.
    assert.equal(bucketIsRed(b(5, 5)), true);
  });

  test("the count floor rejects the one contaminating healthy bucket", () => {
    // 2026-09-01 13:15 UTC: 2 x 52x in 48 requests.
    assert.equal(bucketIsRed(b(48, 2)), false);
  });

  test("a high 52x count at a low ratio is not RED", () => {
    assert.equal(bucketIsRed(b(1000, 49)), false); // 08-31 23:00 recovery bucket
  });

  test("an empty bucket is never RED", () => {
    assert.equal(bucketIsRed(b(0, 0)), false);
  });

  test("thresholds are exactly the calibrated values", () => {
    assert.equal(RED_MIN_52X, 3);
    assert.equal(RED_MIN_52X_RATIO, 0.5);
  });
});

describe("2026-08-31 replay — the incident the detector was built for", () => {
  const sent = replay(OUTAGE_0831);

  test("it pages, and the first page is DOWN", () => {
    assert.ok(sent.length > 0, "expected at least one email");
    assert.equal(sent[0]!.state, "down");
  });

  test("DOWN is declared within an hour of the wedge going total at 06:15", () => {
    const firstDown = sent.find((s) => s.state === "down")!;
    const lagMin = (Date.parse(firstDown.at) - Date.parse("2026-08-31T06:15:00Z")) / 60000;
    assert.ok(lagMin > 0 && lagMin <= 60, "DOWN lag was " + lagMin + " min");
  });

  test("exactly one RECOVERED, and it lands after the front door cleared at 23:15", () => {
    const rec = sent.filter((s) => s.state === "recovered");
    assert.equal(rec.length, 1, "expected 1 RECOVERED, got " + rec.length);
    assert.ok(Date.parse(rec[0]!.at) >= Date.parse("2026-08-31T23:15:00Z"));
  });

  test("hourly dedup holds — a 17-hour wedge does not send 68 emails", () => {
    const downs = sent.filter((s) => s.state === "down");
    assert.ok(downs.length <= 20, "expected at most ~1/hour over ~17h, got " + downs.length);
    assert.ok(downs.length >= 10, "expected sustained hourly paging, got " + downs.length);
  });

  test("nothing is sent after recovery", () => {
    const rec = sent.find((s) => s.state === "recovered")!;
    const after = sent.filter((s) => Date.parse(s.at) > Date.parse(rec.at));
    assert.deepEqual(after, []);
  });
});

describe("six healthy days — the false-positive budget is zero", () => {
  test("the 2026-09-01 statement-timeout window sends nothing", () => {
    // 12:00-18:00 UTC on 09-01: up to 100% 5xx in a bucket, at most 2 x 52x.
    // A 5xx-ratio arm at 0.2 would have paged here with "restart the project",
    // which was both wrong and harmful advice. See front-door-verdict.ts.
    const window = HEALTHY.filter(
      (r) =>
        r[0] >= Date.parse("2026-09-01T11:00:00Z") &&
        r[0] < Date.parse("2026-09-01T20:00:00Z"),
    );
    const worst = Math.max(...window.map((r) => (r[1] ? r[2] / r[1] : 0)));
    assert.ok(worst >= 0.5, "fixture should contain a high-5xx bucket, saw " + worst);
    assert.deepEqual(replay(window), []);
  });

  test("no healthy day pages, except the 08-29 outage that should", () => {
    const byDay = new Map<string, Row[]>();
    for (const r of HEALTHY) {
      const d = new Date(r[0]).toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(r);
    }
    for (const [day, rows] of byDay) {
      const sent = replay(rows);
      if (day === "2026-08-29") {
        // The FIX-1125 event: the postmaster could not fork a backend and the
        // front door went 52x-saturated 06:15-07:15. A true positive.
        assert.ok(sent.length > 0, "08-29 is a real outage and must page");
        assert.equal(sent[0]!.state, "down");
      } else {
        assert.deepEqual(sent, [], day + " must not page");
      }
    }
  });

  test("across all healthy buckets only the 08-29 outage is RED", () => {
    const red = HEALTHY.filter((r) => bucketIsRed(toBucket(r)));
    for (const r of red) {
      const iso = new Date(r[0]).toISOString();
      assert.ok(
        iso.startsWith("2026-08-29T06") || iso.startsWith("2026-08-29T07"),
        "unexpected RED bucket at " + iso,
      );
    }
    assert.equal(red.length, 4);
  });
});

// FIX-1446 — every email the 52x arm sends over every real series, pinned
// before the 503 arm is built beside it. These are the contract: the new arm
// may add its own emails to 11-23, and must not move one of these.
describe("the 52x arm's emails, pinned (the FIX-1446 contract)", () => {
  const emails = (rows: Row[]) => replay(rows).map((s) => `${s.at.slice(5, 16)} ${s.state}`);
  const hourly = (from: number, to: number, day: string) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${day}T${String(from + i).padStart(2, "0")}:02 down`);

  test("2026-08-31: DOWN at 06:47 and 07:02, then hourly 08:02-23:02, and one RECOVERED at 23:32 — 19 emails", () => {
    assert.deepEqual(emails(OUTAGE_0831), [
      "08-31T06:47 down",
      "08-31T07:02 down",
      ...hourly(8, 23, "08-31"),
      "08-31T23:32 recovered",
    ]);
  });

  test("2026-10-06: DOWN at 17:02, then hourly to 00:02, and one RECOVERED at 01:02 — 9 emails", () => {
    assert.deepEqual(emails(OUTAGE_1006), [
      ...hourly(17, 23, "10-06"),
      "10-07T00:02 down",
      "10-07T01:02 recovered",
    ]);
  });

  test("six healthy days as one series: the 08-29 event's two DOWN and its RECOVERED, nothing else", () => {
    assert.deepEqual(emails(HEALTHY), ["08-29T06:47 down", "08-29T07:02 down", "08-29T07:47 recovered"]);
  });

  test("2026-11-23: not one bucket is 52x-RED, so the 52x arm sends nothing — the outage nobody was paged for", () => {
    // 5xx was 74 % at 00:00Z and 99.1 % at 01:00Z, with 0 x 52x until 01:45Z.
    assert.deepEqual(OUTAGE_1123.filter((r) => bucketIsRed(toBucket(r))), []);
    assert.deepEqual(
      emails(OUTAGE_1123).filter((e) => e.endsWith(" down") || e.endsWith(" recovered")),
      [],
    );
  });

  test("the week of 11-20 (671 buckets): no bucket is 52x-RED and the 52x arm sends nothing", () => {
    assert.equal(WEEK_1120.length, 671);
    assert.deepEqual(WEEK_1120.filter((r) => bucketIsRed(toBucket(r))), []);
    assert.deepEqual(
      emails(WEEK_1120).filter((e) => e.endsWith(" down") || e.endsWith(" recovered")),
      [],
    );
  });
});

describe("the direct probe arm", () => {
  const green = alignBuckets([], 4 * BUCKET_MS);

  test("a probe that got no answer is DOWN even with clean buckets", () => {
    const v = decideFrontDoorVerdict(green, {
      answered: false,
      attempts: [
        { status: null, ms: 5000, error: "timeout" },
        { status: 522, ms: 210 },
        { status: null, ms: 5000, error: "timeout" },
      ],
    });
    assert.equal(v.state, "down");
    assert.equal(v.isDownEdge, true);
  });

  test("401 counts as answered — PostgREST rejects the key before touching Postgres", () => {
    const v = decideFrontDoorVerdict(green, PROBE_OK);
    assert.equal(v.state, "ok");
  });
});

describe("mechanics", () => {
  test("alignBuckets fills gaps and returns oldest-first", () => {
    const end = 100 * BUCKET_MS;
    const out = alignBuckets(
      [{ startMs: end - 2 * BUCKET_MS, requests: 9, n5xx: 9, n52x: 9 }],
      end,
    );
    assert.equal(out.length, BUCKET_COUNT);
    assert.equal(out[0]!.startMs, end - 4 * BUCKET_MS);
    assert.equal(out[3]!.startMs, end - BUCKET_MS);
    assert.equal(out[2]!.requests, 9);
    assert.equal(out[3]!.requests, 0);
  });

  test("decideFrontDoorVerdict refuses a wrong-sized window", () => {
    assert.throws(() => decideFrontDoorVerdict([], PROBE_OK));
  });

  test("shouldSend rate-limits a steady DOWN to the :00 tick", () => {
    const down = {
      state: "down" as const,
      red: [true, true, true, true],
      isDownEdge: false,
      reason: "x",
    };
    assert.equal(shouldSend(down, Date.parse("2026-08-31T09:02:00Z")), true);
    assert.equal(shouldSend(down, Date.parse("2026-08-31T09:17:00Z")), false);
    assert.equal(shouldSend(down, Date.parse("2026-08-31T09:32:00Z")), false);
    assert.equal(shouldSend(down, Date.parse("2026-08-31T09:47:00Z")), false);
  });

  test("shouldSend always lets the DOWN edge through", () => {
    const edge = {
      state: "down" as const,
      red: [false, false, true, true],
      isDownEdge: true,
      reason: "x",
    };
    assert.equal(shouldSend(edge, Date.parse("2026-08-31T09:47:00Z")), true);
  });

  test("an ok verdict never sends", () => {
    const ok = {
      state: "ok" as const,
      red: [false, false, false, false],
      isDownEdge: false,
      reason: "x",
    };
    assert.equal(shouldSend(ok, Date.parse("2026-08-31T09:02:00Z")), false);
  });
});

describe("the alert body", () => {
  const buckets = OUTAGE_0831.filter(
    (r) =>
      r[0] >= Date.parse("2026-08-31T06:00:00Z") &&
      r[0] < Date.parse("2026-08-31T07:00:00Z"),
  ).map(toBucket);

  test("a DOWN email carries the runbook and the bucket table", () => {
    const v = decideFrontDoorVerdict(buckets, PROBE_OK);
    assert.equal(v.state, "down");
    const { subject, html } = renderFrontDoorEmail({
      verdict: v,
      buckets,
      probe: PROBE_OK,
      probeUrl: "https://example.supabase.co/rest/v1/",
      nowMs: Date.parse("2026-08-31T07:02:00Z"),
    });
    assert.ok(subject.startsWith("[Civitics][FRONT DOOR DOWN]"));
    assert.match(html, /Restart project/);
    assert.match(html, /RED/);
    assert.ok(!html.includes("undefined"));
  });

  test("a RECOVERED email says no action is needed", () => {
    const v = {
      state: "recovered" as const,
      red: [true, true, false, false],
      isDownEdge: false,
      reason: "cleared",
    };
    const { subject, html } = renderFrontDoorEmail({
      verdict: v,
      buckets,
      probe: PROBE_OK,
      probeUrl: "https://example.supabase.co/rest/v1/",
      nowMs: Date.parse("2026-08-31T23:32:00Z"),
    });
    assert.match(subject, /FRONT DOOR RECOVERED/);
    assert.match(html, /No action needed/);
  });

  test("FIX-1285: the restart decision rides the DOWN email as one line, and is absent when not given", () => {
    const v = decideFrontDoorVerdict(buckets, PROBE_OK);
    const base = {
      verdict: v,
      buckets,
      probe: PROBE_OK,
      probeUrl: "https://example.supabase.co/rest/v1/",
      nowMs: Date.parse("2026-08-31T07:02:00Z"),
    };
    const line = "Auto-restart (FIX-1285, FRONT_DOOR_AUTO_RESTART=report): skip — the direct probe answers";
    assert.ok(renderFrontDoorEmail({ ...base, restartLine: line }).html.includes(line));
    assert.ok(!renderFrontDoorEmail(base).html.includes("Auto-restart"));
  });
});

// FIX-1219 — from 2026-09-24 10:15 UTC the Logs API's logs.all answered 410
// Gone, the route zero-filled the buckets, and every firing read `ok` while
// the corroborator saw nothing. A blind tick now says so.
describe("the Logs corroborator unavailable (FIX-1219)", () => {
  const END = Date.parse("2026-09-25T00:45:00Z");
  const EMPTY = alignBuckets([], END);
  const GONE: FrontDoorCorroborator = { kind: "unavailable", status: 410 };
  const DARK: FrontDoorCorroborator = { kind: "dark", detail: "HTTP 503" };

  test("a 410 corroborator with a probe that answered is corroborator_unavailable — never ok, never paged", () => {
    const v = decideFrontDoorVerdict(EMPTY, PROBE_OK, GONE);
    assert.equal(v.state, "corroborator_unavailable");
    assert.equal(v.isDownEdge, false);
    assert.match(v.reason, /direct probe answered; the Logs corroborator is unavailable \(410, FIX-1219\)/);
    assert.equal(shouldSend(v, Date.parse("2026-09-25T01:00:00Z")), false, "report-only: no email, even on the :00 tick");
  });

  test("a dark corroborator reads the same state, naming dark", () => {
    const v = decideFrontDoorVerdict(EMPTY, PROBE_OK, DARK);
    assert.equal(v.state, "corroborator_unavailable");
    assert.match(v.reason, /dark \(HTTP 503\)/);
  });

  test("a probe with no answer is still DOWN, whatever the corroborator did — the page does not depend on the Logs API", () => {
    const noAnswer: FrontDoorProbe = { answered: false, attempts: [{ status: null, ms: 5000, error: "timeout" }] };
    const v = decideFrontDoorVerdict(EMPTY, noAnswer, GONE);
    assert.equal(v.state, "down");
    assert.equal(shouldSend(v, END), true);
  });

  test("the old shape is unchanged: buckets with an ok corroborator, or no corroborator argument at all", () => {
    for (const c of [undefined, { kind: "ok", buckets: 4 } as FrontDoorCorroborator]) {
      assert.equal(decideFrontDoorVerdict(EMPTY, PROBE_OK, c).state, "ok");
    }
    const replayed = replay(OUTAGE_0831);
    assert.ok(replayed.some((r) => r.state === "down"), "the 08-31 replay still pages");
  });

  test("the logs_api labels, and which statuses mean the endpoint is gone", () => {
    assert.equal(corroboratorLabel({ kind: "ok", buckets: 4 }), "4 bucket(s)");
    assert.equal(corroboratorLabel(GONE), "unavailable (410, FIX-1219)");
    assert.equal(corroboratorLabel({ kind: "unavailable", status: 410, detail: "Logs API 410 Gone" }), "unavailable (410, FIX-1219)");
    // cc-156: a removed table or field answers 200; the label names what is missing.
    assert.equal(
      corroboratorLabel({ kind: "unavailable", status: 200, detail: 'Logs API schema changed: Table "edge_logs" does not exist.' }),
      'unavailable (Logs API schema changed: Table "edge_logs" does not exist., FIX-1219)',
    );
    assert.equal(corroboratorLabel(DARK), "dark (HTTP 503)");
    assert.equal(isLogsEndpointGone(410), true);
    assert.equal(isLogsEndpointGone(404), true);
    assert.equal(isLogsEndpointGone(503), false);
    assert.equal(isLogsEndpointGone(401), false);
  });
});

// FIX-1446 — the 503 arm. On 11-23 the edge answered 503 (PostgREST unable to
// reach Postgres) on 89 % and 79 % of two consecutive buckets with 0 x 52x, and
// nothing paged. These replay the real series the thresholds were read from.
describe("the 503 arm (FIX-1446)", () => {
  const at = (iso: string) => Date.parse(iso);
  const b = (requests: number, n503: number, extra: Partial<FrontDoorBucket> = {}): FrontDoorBucket => ({
    startMs: 0,
    requests,
    n5xx: n503,
    n52x: 0,
    n503,
    ...extra,
  });
  const window = (rows: FrontDoorBucket[], end: number) =>
    alignBuckets(rows.map((r, i) => ({ ...r, startMs: end - (rows.length - i) * BUCKET_MS })), end);
  const G = b(300, 0);
  const U = b(216, 192); // 11-23 01:00Z
  const OUTAGE_FROM = at("2026-11-22T23:45:00Z");
  const OUTAGE_TO = at("2026-11-23T02:15:00Z");

  test("the thresholds are exactly the calibrated values", () => {
    assert.equal(RED_MIN_503, 10);
    assert.equal(RED_MIN_503_RATIO, 0.5);
  });

  test("11-23's 01:00Z and 01:15Z are 503-RED; 00:45Z at 46.2 % is not, and is the only near miss", () => {
    const red = OUTAGE_1123.filter((r) => bucketIs503Red(toBucket(r))).map((r) => new Date(r[0]).toISOString());
    assert.deepEqual(red, ["2026-11-23T01:00:00.000Z", "2026-11-23T01:15:00.000Z"]);
    const r0045 = OUTAGE_1123.find((r) => r[0] === at("2026-11-23T00:45:00Z"))!;
    assert.deepEqual(r0045, [at("2026-11-23T00:45:00Z"), 65, 53, 0, 30]);
    assert.equal(bucketIs503Red(toBucket(r0045)), false);
  });

  test("the count floor, the ratio, an empty bucket and a row with no 503 count", () => {
    assert.equal(bucketIs503Red(b(9, 9)), false, "nine of nine is under the floor of ten");
    assert.equal(bucketIs503Red(b(20, 10)), true, "ten of twenty is exactly the ratio");
    assert.equal(bucketIs503Red(b(21, 10)), false);
    assert.equal(bucketIs503Red(b(0, 0)), false);
    assert.equal(bucketIs503Red({ startMs: 0, requests: 100, n5xx: 100, n52x: 0 }), false, "absent n503 reads 0");
  });

  test("09-01's statement-timeout afternoon (583 x 500 + 112 x 504 + one 520 + one 525) is never 503-RED", () => {
    // The audit's seven hours (12:00 through 18:59Z), as one bucket and as the
    // fixture's buckets: every 5xx there was 500 or 504, so n_503 is 0.
    assert.equal(bucketIs503Red({ startMs: 0, requests: 3775, n5xx: 697, n52x: 2, n503: 0 }), false);
    const afternoon = HEALTHY.filter((r) => r[0] >= at("2026-09-01T12:00:00Z") && r[0] < at("2026-09-01T19:00:00Z"));
    assert.equal(afternoon.length, 27);
    assert.deepEqual(
      [afternoon.reduce((s, r) => s + r[1], 0), afternoon.reduce((s, r) => s + r[2], 0)],
      [3775, 697],
      "the audit's 3,775 requests and 697 5xx",
    );
    assert.ok(afternoon.every((r) => !bucketIs503Red(toBucket(r))));
    assert.deepEqual(replay(afternoon).filter((s) => s.state.startsWith("db_")), []);
  });

  test("11-23 replayed at prod's :00:28 ticks: DATABASE UNREACHABLE at 01:30:28Z, DATABASE REACHABLE AGAIN at 02:00:28Z, nothing else", () => {
    const sent = replay(OUTAGE_1123, 28_000);
    assert.deepEqual(sent, [
      { at: "2026-11-23T01:30:28.000Z", state: "db_unreachable" },
      { at: "2026-11-23T02:00:28.000Z", state: "db_reachable" },
    ]);
    // Craig found the site down at 01:53Z and restarted it at 02:03Z.
    assert.equal(Math.floor((at("2026-11-23T01:53:00Z") - at(sent[0]!.at)) / 60000), 22);
    assert.ok(at(sent[1]!.at) < at("2026-11-23T02:03:00Z"), "the all-clear lands before the restart, not after it");
    // The :02 grid the other replays use reads the same two ticks.
    assert.deepEqual(
      replay(OUTAGE_1123).map((s) => s.at.slice(11, 16) + " " + s.state),
      ["01:32 db_unreachable", "02:02 db_reachable"],
    );
  });

  test("the week of 11-20 pages only the 11-23 outage — no 503 anywhere else, not one single 503-RED bucket outside it", () => {
    const outside = WEEK_1120.filter((r) => r[0] < OUTAGE_FROM || r[0] >= OUTAGE_TO);
    assert.equal(outside.length, 661);
    assert.equal(Math.max(...outside.map((r) => r[4] ?? 0)), 0);
    assert.deepEqual(outside.filter((r) => bucketIs503Red(toBucket(r))), []);
    assert.deepEqual(replay(WEEK_1120, 28_000), [
      { at: "2026-11-23T01:30:28.000Z", state: "db_unreachable" },
      { at: "2026-11-23T02:00:28.000Z", state: "db_reachable" },
    ]);
  });

  test("it pages like DOWN: on its edge, then the :00 tick only; DATABASE REACHABLE AGAIN once", () => {
    const end = at("2026-11-23T02:00:00Z");
    const edge = decideFrontDoorVerdict(window([G, G, U, U], end), PROBE_OK);
    assert.equal(edge.state, "db_unreachable");
    assert.equal(edge.isDownEdge, true);
    assert.equal(shouldSend(edge, at("2026-11-23T02:47:28Z")), true, "the edge sends whatever the minute");
    const steady = decideFrontDoorVerdict(window([U, U, U, U], end), PROBE_OK);
    assert.equal(steady.state, "db_unreachable");
    assert.equal(steady.isDownEdge, false);
    assert.equal(shouldSend(steady, at("2026-11-23T03:00:28Z")), true);
    for (const m of ["03:15:28", "03:30:28", "03:45:28"]) {
      assert.equal(shouldSend(steady, at("2026-11-23T" + m + "Z")), false, m);
    }
    const back = decideFrontDoorVerdict(window([U, U, G, G], end), PROBE_OK);
    assert.equal(back.state, "db_reachable");
    assert.equal(shouldSend(back, at("2026-11-23T02:17:28Z")), true);
    // One tick later the 503-RED bucket has slid to index 0: ok, no email.
    const after = decideFrontDoorVerdict(window([U, G, G, G], end), PROBE_OK);
    assert.equal(after.state, "ok");
    assert.equal(shouldSend(after, at("2026-11-23T03:00:28Z")), false);
  });

  test("precedence: a wedge outranks it, the probe and the blind corroborator are unchanged, RECOVERED beats DB_REACHABLE", () => {
    const end = at("2026-11-23T02:00:00Z");
    // 10 x 52x + 10 x 503 of 20: RED and 503-RED at once — DOWN.
    const both = b(20, 10, { n5xx: 20, n52x: 10 });
    assert.equal(bucketIsRed(both) && bucketIs503Red(both), true);
    const v = decideFrontDoorVerdict(window([G, G, both, both], end), PROBE_OK);
    assert.equal(v.state, "down");
    assert.match(v.reason, /Cloudflare 52x/);
    const dark: FrontDoorProbe = { answered: false, attempts: [{ status: null, ms: 5000, error: "timeout" }] };
    assert.equal(decideFrontDoorVerdict(window([G, G, U, U], end), dark).state, "down");
    assert.equal(
      decideFrontDoorVerdict(window([G, G, U, U], end), PROBE_OK, { kind: "dark", detail: "HTTP 429" }).state,
      "corroborator_unavailable",
    );
    // The one bucket before the two clean ones is both RED and 503-RED: RECOVERED is the all-clear sent.
    assert.equal(decideFrontDoorVerdict(window([G, both, G, G], end), PROBE_OK).state, "recovered");
  });

  test("a caller that omits n503 gets today's verdicts exactly", () => {
    const strip = (rows: Row[]) => rows.map((r) => [r[0], r[1], r[2], r[3]] as Row);
    assert.deepEqual(replay(strip(OUTAGE_1123)), []);
    assert.deepEqual(replay(strip(OUTAGE_0831)), replay(OUTAGE_0831));
  });

  test("the DATABASE UNREACHABLE email: its subject, the four buckets with a 503 column, the owner's text, no restart line", () => {
    const end = at("2026-11-23T01:30:00Z");
    const rows = alignBuckets(OUTAGE_1123.map(toBucket), end);
    const v = decideFrontDoorVerdict(rows, PROBE_OK);
    assert.equal(v.state, "db_unreachable");
    const { subject, html } = renderFrontDoorEmail({
      verdict: v,
      buckets: rows,
      probe: PROBE_OK,
      probeUrl: "https://example.supabase.co/rest/v1/",
      nowMs: at("2026-11-23T01:30:28Z"),
      restartLine: "Auto-restart (FIX-1285, FRONT_DOOR_AUTO_RESTART=arm): none — front door not DOWN (db_unreachable)",
    });
    assert.equal(
      subject,
      "[Civitics][DATABASE UNREACHABLE] the front door is answering 503 — the two newest closed buckets are both >= 50% 503 (newest: 120/152)",
    );
    assert.ok(html.includes(DB_UNREACHABLE_RUNBOOK));
    assert.match(html, /^DATABASE UNREACHABLE — 2026-11-23T01:30:28\.000Z$/m);
    assert.match(html, /^01:00 +216 req +214 5xx +0 52x +0\.0% +192 503 +88\.9% +503-RED$/m);
    assert.match(html, /^00:45 +65 req +53 5xx +0 52x +0\.0% +30 503 +46\.2% +ok$/m);
    assert.doesNotMatch(html, /Auto-restart/, "the 503 arm never restarts, so it carries no restart line");
    assert.doesNotMatch(html, /Restart project/, "not the wedge runbook");
    assert.ok(!html.includes("undefined"));
  });

  test("the DATABASE REACHABLE AGAIN email clears the 503 page only, and says plain 500 / 504 are not paged", () => {
    const end = at("2026-11-23T02:00:00Z");
    const rows = alignBuckets(OUTAGE_1123.map(toBucket), end);
    const v = decideFrontDoorVerdict(rows, PROBE_OK);
    assert.equal(v.state, "db_reachable");
    const { subject, html } = renderFrontDoorEmail({
      verdict: v,
      buckets: rows,
      probe: PROBE_OK,
      probeUrl: "https://example.supabase.co/rest/v1/",
      nowMs: at("2026-11-23T02:00:28Z"),
    });
    assert.ok(subject.startsWith("[Civitics][DATABASE REACHABLE AGAIN]"));
    assert.match(html, /This clears that alert only/);
    assert.match(html, /500 \/ 504/);
    assert.match(html, /^01:45 +136 req +84 5xx +3 52x +2\.2% +0 503 +0\.0% +ok$/m);
  });
});
