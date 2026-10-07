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
  corroboratorLabel,
  isLogsEndpointGone,
  type FrontDoorBucket,
  type FrontDoorCorroborator,
  type FrontDoorProbe,
} from "./front-door-verdict";
import { OUTAGE_0831, HEALTHY, type FrontDoorRow } from "./__fixtures__/front-door-series";

type Row = FrontDoorRow;

const toBucket = (r: Row): FrontDoorBucket => ({
  startMs: r[0],
  requests: r[1],
  n5xx: r[2],
  n52x: r[3],
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
 */
function replay(rows: Row[]): Array<{ at: string; state: string }> {
  const byStart = new Map<number, FrontDoorBucket>();
  for (const r of rows) byStart.set(r[0], toBucket(r));
  const starts = rows.map((r) => r[0]).sort((a, b) => a - b);
  const first = starts[0]!;
  const last = starts[starts.length - 1]!;

  const sent: Array<{ at: string; state: string }> = [];
  // Tick at :02 past each boundary, so the boundary's bucket is closed and the
  // on-the-hour tick lands inside the minute<15 hourly-dedup window.
  for (let t = first + BUCKET_COUNT * BUCKET_MS; t <= last + BUCKET_MS; t += BUCKET_MS) {
    const nowMs = t + 2 * 60 * 1000;
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
