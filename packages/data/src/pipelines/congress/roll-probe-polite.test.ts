/**
 * FIX-1407 — the polite walk: tail first, seen-unstored skips, `blocked` as its
 * own outcome, paced GETs. Every part is opt-in; the House passes none of it,
 * and the House fixture below is pinned to the FIX-1324 walk's own output (the
 * fetch order and the line were captured from the pre-FIX-1407 code).
 *
 * The four nights cc-271 read (11-09 → 11-12): senate.gov served the first few
 * dozen GETs and 403'd after them; Wed served 163 rolls and stored 2; a 403
 * counted as a miss, so three of them ended a session as if past its last roll.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parseSenateRoll } from "./votes";
import {
  BLOCKED_LIMIT,
  BLOCKED_RETRY_DELAYS_MS,
  classifyFetchError,
  probeSessionRolls,
  type RollProbeOptions,
} from "./roll-probe";

const SENATE_ROLL = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "lis-senate-119-2-00256-nomination.xml"),
  "utf8",
);
const HTML_PAGE = `<!DOCTYPE html>\n<html><body><p>Page not found</p></body></html>`;
const HOUSE_ROLL =
  `<?xml version="1.0" encoding="utf-8"?>\r\n<rollcall-vote>\r\n  <vote-metadata>` +
  `<congress>119</congress><legis-num>H R 1</legis-num><vote-question>On Passage</vote-question>` +
  `<vote-result>Passed</vote-result><action-date>1-Oct-2026</action-date></vote-metadata>` +
  `<vote-data><recorded-vote><legislator name-id="A000001">A</legislator><vote>Yea</vote></recorded-vote></vote-data>` +
  `</rollcall-vote>`;
const HOUSE_SANITIZING = `<xml>Error sanitizing file "roll450.xml". Please try again.</xml>`;

type Answer = string | { status: number } | { network: string };

const id = (n: number) => `senate-119-2-${String(n).padStart(5, "0")}`;
const ids = (...ns: number[]) => new Set(ns.map(id));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * A fake fetchText. `answer(rollNum, attempt)` — attempt is 1 for a roll's
 * first GET, 2 for its first retry, … — failing the way members.ts's does.
 */
function fakeFetch(answer: (rollNum: number, attempt: number) => Answer) {
  const fetched: number[] = [];
  const fetchText = async (url: string): Promise<string> => {
    const rollNum = Number(/(\d+)\.xml$/.exec(url)![1]);
    fetched.push(rollNum);
    const a = answer(rollNum, fetched.filter((n) => n === rollNum).length);
    if (typeof a === "string") return a;
    if ("network" in a) throw new TypeError(a.network);
    throw new Error(`HTTP ${a.status} Status — ${url}\n  Body: <html>…</html>`);
  };
  return { fetched, fetchText };
}

/** The Senate's polite options, as votes.ts passes them, with a recording sleep. */
async function walk(
  answer: (rollNum: number, attempt: number) => Answer,
  over: Partial<RollProbeOptions<Record<string, unknown>>> = {},
) {
  const { fetched, fetchText } = fakeFetch(answer);
  const lines: string[] = [];
  const landed: number[] = [];
  const sleeps: number[] = [];
  const summary = await probeSessionRolls<Record<string, unknown>>({
    label: "Senate session 2",
    rootTag: "roll_call_vote",
    rollCallIdFor: id,
    urlFor: (n) => `https://www.senate.gov/x/vote_119_2_${String(n).padStart(5, "0")}.xml`,
    stored: new Set(),
    fetchText,
    parse: parseSenateRoll,
    log: (line) => lines.push(line),
    maxRoll: 500,
    order: "tail-first",
    blocked: { retryDelaysMs: BLOCKED_RETRY_DELAYS_MS, limit: BLOCKED_LIMIT },
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  }, ({ rollNum }) => { landed.push(rollNum); });
  return { summary, fetched, lines, landed, sleeps };
}

test("FIX-1407 tail first: the rolls past the frontier, then the gaps below it, ascending", async () => {
  // Stored 1–10 but 3 and 7; seen 5; the session's last roll is 13.
  const r = await walk((n) => (n <= 13 ? SENATE_ROLL : HTML_PAGE), {
    stored: ids(1, 2, 4, 6, 8, 9, 10),
    seen: ids(5),
  });
  assert.deepEqual(r.fetched, [11, 12, 13, 14, 15, 16, 3, 7]);
  assert.deepEqual(r.landed, [11, 12, 13, 3, 7]);
  assert.equal(r.summary.tailNew, 3);
  assert.deepEqual(r.summary.tail, { frontier: 10, end: "past-end", at: 16, why: "3 consecutive misses", unsure: 0 });
  assert.deepEqual(r.summary.stop, { at: 16, why: "3 consecutive misses" });
  assert.equal(r.summary.stored, 7);
  assert.equal(r.summary.seenSkipped, 1);
  assert.deepEqual(r.sleeps, [], "no pacing asked for, no blocked roll: nothing slept");
  assert.deepEqual(r.lines, [
    "  Senate session 2: tail after roll 10: 3 new, past end at roll 16 (3 consecutive misses) — " +
      "fetched 8 in 8 GETs: 5 rolls, 3 misses (non-roll body ×3), 0 blocked (0 retries), 0 transient; " +
      "7 already stored, 1 seen-unstored skipped",
  ]);
});

test("FIX-1407 a 403 waits 30 s, retries, waits 120 s, retries — and the roll served on the second retry lands", async () => {
  const r = await walk((n, attempt) => (n === 1 && attempt < 3 ? { status: 403 } : n === 1 ? SENATE_ROLL : HTML_PAGE));
  assert.deepEqual(r.fetched, [1, 1, 1, 2, 3, 4]);
  assert.deepEqual(r.sleeps, [30_000, 120_000]);
  assert.deepEqual(r.landed, [1]);
  assert.equal(r.summary.blocked, 0);
  assert.equal(r.summary.blockedRetries, 2);
  assert.equal(r.summary.gets, 6);
  assert.deepEqual(r.summary.firstBlocked, { get: 1, at: 1, why: "HTTP 403" });
  assert.equal(r.lines[0], "    Roll 1: blocked, then answered on retry 2 after 30 s, 120 s");
  assert.match(r.lines[1]!, /0 blocked \(2 retries, first HTTP 403 at GET 1 on roll 1\)/);
});

test("FIX-1407 three rolls blocked after both retries end the session as blocked ×3 — never as past-end", async () => {
  const r = await walk((n) => (n <= 2 ? SENATE_ROLL : { status: 403 }), { stored: ids(1) });
  // Frontier 1; pass A: 2 lands, 3/4/5 each take three GETs and stay blocked.
  assert.deepEqual(r.fetched, [2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
  assert.deepEqual(r.landed, [2]);
  assert.equal(r.summary.blocked, 3);
  assert.equal(r.summary.misses, 0, "a block is never a miss");
  assert.deepEqual(r.summary.stop, { at: 5, why: "blocked ×3" });
  assert.equal(r.summary.tail?.end, "blocked");
  assert.deepEqual(r.sleeps, [30_000, 120_000, 30_000, 120_000, 30_000, 120_000]);
  assert.equal(r.lines.at(-1),
    "  Senate session 2: tail after roll 1: 1 new, stopped at roll 5 after blocked ×3 — fetched 4 in 10 GETs: " +
      "1 rolls, 0 misses, 3 blocked (6 retries, first HTTP 403 at GET 2 on roll 3), 0 transient; " +
      "1 already stored, 0 seen-unstored skipped");
  assert.equal(r.lines.filter((l) => /Roll \d+: blocked — HTTP 403 on 3 GETs after 30 s, 120 s/.test(l)).length, 3);
});

test("FIX-1407 a session blocked out in pass A does not walk its gaps", async () => {
  const r = await walk((n) => (n === 2 ? SENATE_ROLL : { status: 429 }), { stored: ids(1, 3) });
  // Frontier 3; pass A blocks out on 4, 5, 6; gap 2 is never asked for.
  assert.ok(!r.fetched.includes(2));
  assert.deepEqual(r.summary.stop, { at: 6, why: "blocked ×3" });
});

test("FIX-1407 a 403 in the middle of the tail does not end the tail", async () => {
  // 259 lands, 260 stays blocked, 261 lands, 262–264 are past the end.
  const stored = new Set(range(1, 258).map(id));
  const r = await walk((n) => (n === 260 ? { status: 403 } : n <= 261 ? SENATE_ROLL : HTML_PAGE), { stored });
  assert.deepEqual(r.landed, [259, 261]);
  assert.equal(r.summary.blocked, 1);
  assert.deepEqual(r.summary.tail, { frontier: 258, end: "past-end", at: 264, why: "3 consecutive misses", unsure: 1 });
  assert.match(r.lines.at(-1)!, /^ {2}Senate session 2: tail after roll 258: 2 new, past end at roll 264 \(3 consecutive misses\) — fetched 6 in 8 GETs: 2 rolls, 3 misses \(non-roll body ×3\), 1 blocked \(2 retries, first HTTP 403 at GET 2 on roll 260\)/);
});

test("FIX-1407 a block between two misses neither counts toward the run nor resets it", async () => {
  // Frontier 1: 2 misses, 3 blocks, 4 and 5 miss → past end at 5, not 6.
  const r = await walk((n) => (n === 3 ? { status: 403 } : HTML_PAGE), { stored: ids(1) });
  assert.deepEqual(r.summary.tail?.at, 5);
  assert.equal(r.summary.misses, 3);
});

test("FIX-1407 pass B: a hole below the frontier is a miss, not the session's end", async () => {
  // Stored 10; 1–9 unknown and every one a non-roll body or a 404. Tail past end at 13.
  const r = await walk((n) => (n === 4 ? { status: 404 } : HTML_PAGE), { stored: ids(10) });
  assert.deepEqual(r.fetched, [11, 12, 13, ...range(1, 9)]);
  assert.equal(r.summary.misses, 12);
  assert.deepEqual(r.summary.missReasons, { "non-roll body": 11, "HTTP 404": 1 });
  assert.deepEqual(r.summary.stop, { at: 13, why: "3 consecutive misses" }, "the stop is still the tail's");
});

test("FIX-1407 pass B: three blocked gaps end the session after a clean tail, and the line says which pass", async () => {
  const r = await walk((n) => (n > 10 ? HTML_PAGE : { status: 403 }), { stored: ids(10) });
  assert.deepEqual(r.summary.tail?.end, "past-end");
  assert.deepEqual(r.summary.stop, { at: 3, why: "blocked ×3" });
  assert.match(r.lines.at(-1)!, /tail after roll 10: 0 new, past end at roll 13 \(3 consecutive misses\); gaps stopped at roll 3 after blocked ×3 — /);
});

test("FIX-1407 seen rolls are never fetched, and in the ascending walk they reset the miss run like stored ones", async () => {
  // The FIX-1324 shape with `seen` alone: 2, 3 miss, 4 is seen, 5, 6 miss — no stop until 7.
  const r = await walk((n) => (n === 1 ? SENATE_ROLL : HTML_PAGE), { order: undefined, seen: ids(4) });
  assert.deepEqual(r.fetched, [1, 2, 3, 5, 6, 7]);
  assert.equal(r.summary.stop?.at, 7);
  assert.equal(r.summary.seenSkipped, 1);
  assert.match(r.lines[0]!, /^ {2}Senate session 2: stopped at roll 7 after 3 consecutive misses — fetched 6 in 6 GETs: .* 0 already stored, 1 seen-unstored skipped$/);
});

test("FIX-1407 seen rolls hold the frontier up: a session whose newest rolls never landed starts its tail above them", async () => {
  const r = await walk((n) => (n <= 6 ? SENATE_ROLL : HTML_PAGE), { stored: ids(1, 2, 3), seen: ids(4, 5) });
  assert.equal(r.summary.tail?.frontier, 5);
  assert.deepEqual(r.fetched, [6, 7, 8, 9]);
});

test("FIX-1407 skipTail: a closed session sends no tail GET and only fetches its gaps", async () => {
  const r = await walk(() => SENATE_ROLL, { stored: ids(1, 2, 4, 6), seen: ids(5), skipTail: true });
  assert.deepEqual(r.fetched, [3]);
  assert.deepEqual(r.summary.tail, { frontier: 6, end: "closed", at: null, why: null, unsure: 0 });
  assert.equal(r.summary.stop, null);
  assert.equal(r.lines.at(-1),
    "  Senate session 2: tail closed after roll 6 — fetched 1 in 1 GETs: 1 rolls, 0 misses, 0 blocked (0 retries), " +
      "0 transient; 4 already stored, 1 seen-unstored skipped");
});

test("FIX-1407 skipTail with nothing to fill: zero GETs", async () => {
  const r = await walk(() => SENATE_ROLL, { stored: ids(1, 2, 3), seen: ids(4), skipTail: true });
  assert.deepEqual(r.fetched, []);
  assert.equal(r.summary.gets, 0);
});

test("FIX-1407 recheck: a lapsed roll holds the frontier and is fetched with the gaps, even under skipTail", async () => {
  // 6 was the session's newest known roll; its skip lapsed, so it is no longer in `seen`.
  const r = await walk(() => SENATE_ROLL, { stored: ids(1, 2, 3, 4, 5), recheck: ids(6), skipTail: true });
  assert.equal(r.summary.tail?.frontier, 6);
  assert.deepEqual(r.fetched, [6]);
  assert.equal(r.summary.tailNew, 0);
});

test("FIX-1407 a transient in the tail marks it unsure", async () => {
  const r = await walk((n) => (n === 2 ? { status: 503 } : HTML_PAGE), { stored: ids(1) });
  assert.deepEqual(r.summary.tail, { frontier: 1, end: "past-end", at: 5, why: "3 consecutive misses", unsure: 1 });
});

test("FIX-1407 pacing: a sleep of 1.5–2.0 s between GETs, none before the first", async () => {
  const r = await walk((n, attempt) => (n === 2 && attempt === 1 ? { status: 403 } : n <= 2 ? SENATE_ROLL : HTML_PAGE), {
    paceMs: { base: 1500, jitter: 500 },
  });
  // GETs: 1, 2 (403), 2 (retry), 3, 4, 5. Sleeps: pace, pace, the 30 s wait (not a pace on top), pace, pace, pace.
  assert.deepEqual(r.fetched, [1, 2, 2, 3, 4, 5]);
  assert.equal(r.sleeps.length, 5, "one per GET after the first");
  assert.equal(r.sleeps[1], 30_000);
  for (const [i, ms] of r.sleeps.entries()) {
    if (i === 1) continue;
    assert.ok(ms >= 1500 && ms <= 2000, `pace ${i}: ${ms}`);
  }
});

test("FIX-1407 classifyFetchError: 403 and 429 are blocked only for a caller that opted in", () => {
  assert.deepEqual(classifyFetchError(new Error("HTTP 403 Forbidden — u"), { blocked: true }), { kind: "blocked", why: "HTTP 403" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 429 Too Many — u"), { blocked: true }), { kind: "blocked", why: "HTTP 429" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 410 Gone — u"), { blocked: true }), { kind: "miss", why: "HTTP 410" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 404 Not Found — u"), { blocked: true }), { kind: "end", why: "HTTP 404" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 403 Forbidden — u")), { kind: "miss", why: "HTTP 403" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 403 Forbidden — u"), {}), { kind: "miss", why: "HTTP 403" });
});

test("FIX-1407 the House passes no option: fetch order, landings and lines byte-identical to the FIX-1324 walk", async () => {
  // Captured from the pre-FIX-1407 roll-probe.ts on this exact fixture (cc-274).
  const stored = new Set([2, 3, 7, 10, 11, 16].map((n) => `2026-house-${String(n).padStart(3, "0")}`));
  const fetched: number[] = [];
  const lines: string[] = [];
  const landed: number[] = [];
  let slept = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { slept++; return realSetTimeout(fn, ms); }) as typeof setTimeout;
  try {
    const s = await probeSessionRolls({
      label: "House session 2 (2026)",
      rootTag: "rollcall-vote",
      rollCallIdFor: (n) => `2026-house-${String(n).padStart(3, "0")}`,
      urlFor: (n) => `https://clerk.house.gov/evs/2026/roll${String(n).padStart(3, "0")}.xml`,
      stored,
      fetchText: async (url) => {
        const n = Number(/(\d+)\.xml$/.exec(url)![1]);
        fetched.push(n);
        if (n === 6) throw new Error(`HTTP 403 Forbidden — ${url}\n  Body: x`);
        if (n === 9) throw new Error(`HTTP 429 Too Many Requests — ${url}`);
        if (n === 12) throw new Error(`HTTP 503 Service Unavailable — ${url}`);
        if (n === 13) throw new TypeError("fetch failed");
        if (n === 15) return `<rollcall-vote><broken`;
        if (n >= 18) return HOUSE_SANITIZING;
        return HOUSE_ROLL;
      },
      parse: (b) => (b.includes("</rollcall-vote>") ? { ok: true } : null),
      log: (l) => lines.push(l),
      maxRoll: 40,
    }, ({ rollNum }) => { landed.push(rollNum); });
    assert.deepEqual(fetched, [1, 4, 5, 6, 8, 9, 12, 13, 14, 15, 17, 18, 19, 20]);
    assert.deepEqual(landed, [1, 4, 5, 8, 14, 17]);
    assert.deepEqual(lines, [
      "    Roll 12: transient fetch error — HTTP 503 (not counted toward the stop)",
      "    Roll 13: transient fetch error — fetch failed (not counted toward the stop)",
      "  House session 2 (2026): stopped at roll 20 after 3 consecutive misses — fetched 14: 6 rolls, 6 misses " +
        "(HTTP 403 ×1, HTTP 429 ×1, unparseable roll body ×1, non-roll body ×3), 2 transient; 6 already stored",
    ]);
    assert.deepEqual(s.stop, { at: 20, why: "3 consecutive misses" });
    assert.equal(s.polite, false);
    assert.equal(s.blocked + s.blockedRetries + s.seenSkipped + s.tailNew, 0);
    assert.equal(s.tail, null);
    assert.equal(slept, 0, "no timer: the House walk is unpaced");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
