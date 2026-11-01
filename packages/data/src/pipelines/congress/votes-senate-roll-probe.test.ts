/**
 * FIX-1324 — the roll walk stops past a session's last roll.
 *
 * Neither feed 404s there. senate.gov answered rolls 257–500 of session 2 with
 * a 200 HTML page that fast-xml-parser throws on (`TypeError … 'tagName'`, 241
 * lines a night, cc-228 §8); since 10-23 it answers everything 403. The House
 * clerk answers 200 `<xml>Error sanitizing file …</xml>` (324 "unexpected XML
 * structure" lines a night). HTML_PAGE below reproduces the TypeError with the
 * same frame the nightly logged (OrderedObjParser.js:310).
 *
 * The vote-menu path (read the session's roll list first) is not built: the
 * menu URL answers 403 from every client this run could test — see cc-260.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { parseHouseRoll, parseSenateRoll } from "./votes";
import {
  classifyFetchError,
  probeSessionRolls,
  MISS_LIMIT,
  type RollProbeOptions,
} from "./roll-probe";

const SENATE_ROLL = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "lis-senate-119-2-00256-nomination.xml"),
  "utf8",
);
const HOUSE_ROLL =
  `<?xml version="1.0" encoding="utf-8"?>\r\n<rollcall-vote>\r\n  <vote-metadata>` +
  `<congress>119</congress><legis-num>H R 1</legis-num><vote-question>On Passage</vote-question>` +
  `<vote-result>Passed</vote-result><action-date>1-Oct-2026</action-date></vote-metadata>` +
  `<vote-data><recorded-vote><legislator name-id="A000001">A</legislator><vote>Yea</vote></recorded-vote></vote-data>` +
  `</rollcall-vote>`;
const HTML_PAGE =
  `<!DOCTYPE html>\n<html><head><script>if (a<b) { /* it's the menu */ }</script></head>` +
  `<body><p>Page not found</p></body></html>`;
const HOUSE_SANITIZING = `<xml>Error sanitizing file "roll450.xml". Please try again.</xml>`;

type Answer = string | { status: number } | { network: string };

/** A fake fetchText: `answer(rollNum)` per URL, failing the way members.ts's does. */
function fakeFetch(answer: (rollNum: number) => Answer) {
  const fetched: number[] = [];
  const fetchText = async (url: string): Promise<string> => {
    const rollNum = Number(/(\d+)\.xml$/.exec(url)![1]);
    fetched.push(rollNum);
    const a = answer(rollNum);
    if (typeof a === "string") return a;
    if ("network" in a) throw new TypeError(a.network);
    throw new Error(`HTTP ${a.status} Status — ${url}\n  Body: <html>…</html>`);
  };
  return { fetched, fetchText };
}

async function walk<T>(
  answer: (rollNum: number) => Answer,
  over: Partial<RollProbeOptions<T>> & Pick<RollProbeOptions<T>, "parse" | "rootTag">,
) {
  const { fetched, fetchText } = fakeFetch(answer);
  const lines: string[] = [];
  const landed: number[] = [];
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const summary = await probeSessionRolls<T>({
      label: "Senate session 2",
      rollCallIdFor: (n) => `senate-119-2-${String(n).padStart(5, "0")}`,
      urlFor: (n) => `https://www.senate.gov/x/vote_119_2_${String(n).padStart(5, "0")}.xml`,
      stored: new Set(),
      fetchText,
      log: (line) => lines.push(line),
      maxRoll: 500,
      ...over,
    }, ({ rollNum }) => { landed.push(rollNum); });
    return { summary, fetched, lines, landed, errors };
  } finally {
    console.error = realError;
  }
}

const senate = { parse: parseSenateRoll, rootTag: "roll_call_vote" } as const;
const house = { parse: parseHouseRoll, rootTag: "rollcall-vote" } as const;

test("FIX-1324 the guard: an HTML body never reaches the parser, and nothing throws", () => {
  const raw = new XMLParser({ ignoreAttributes: false });
  assert.throws(() => raw.parse(HTML_PAGE), /reading 'tagName'/, "the body is the one the nightly threw on");
  assert.equal(parseSenateRoll(HTML_PAGE), null);
  assert.equal(parseSenateRoll(HOUSE_SANITIZING), null);
  assert.equal(parseHouseRoll(HTML_PAGE), null);
  assert.equal(parseHouseRoll(HOUSE_SANITIZING), null);
  // A root tag that does not parse is a null too, not a throw.
  assert.equal(parseSenateRoll(`<roll_call_vote><script>if (a<b) { /* it's */ }</script>`), null);
  assert.ok(parseSenateRoll(SENATE_ROLL), "a real roll still parses");
  const h = parseHouseRoll(HOUSE_ROLL);
  assert.ok(h);
  assert.equal(h!.meta["legis-num"], "H R 1");
});

test("FIX-1324 the fallback: rolls 1-3, then 200 HTML from roll 4 — stops at 6, one line, no console.error", async () => {
  const r = await walk((n) => (n <= 3 ? SENATE_ROLL : HTML_PAGE), senate);
  assert.deepEqual(r.fetched, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.landed, [1, 2, 3]);
  assert.deepEqual(r.summary.stop, { at: 6, why: `${MISS_LIMIT} consecutive misses` });
  assert.deepEqual(r.lines, [
    "  Senate session 2: stopped at roll 6 after 3 consecutive misses — fetched 6: 3 rolls, " +
      "3 misses (non-roll body ×3), 0 transient; 0 already stored",
  ]);
  assert.equal(r.errors.length, 0);
});

test("FIX-1324 a 503 at roll 2 does not count toward the stop — and does not reset the run", async () => {
  const early = await walk((n) => (n === 2 ? { status: 503 } : n <= 3 ? SENATE_ROLL : HTML_PAGE), senate);
  assert.deepEqual(early.landed, [1, 3]);
  assert.equal(early.summary.stop?.at, 6);
  assert.equal(early.summary.transient, 1);
  assert.equal(early.summary.misses, 3);
  assert.equal(early.lines.length, 2, "the transient's one line, then the summary");
  assert.match(early.lines[0]!, /Roll 2: transient fetch error — HTTP 503 \(not counted toward the stop\)/);

  // Misses at 3, 5 and 6 with a 503 between them: three misses, the stop at 6.
  const between = await walk((n) => (n <= 2 ? SENATE_ROLL : n === 4 ? { status: 503 } : HTML_PAGE), senate);
  assert.equal(between.summary.stop?.at, 6);
  assert.equal(between.summary.misses, 3);
  assert.equal(between.summary.transient, 1);
});

test("FIX-1324 a network failure (no HTTP status) is transient", async () => {
  const r = await walk((n) => (n === 2 ? { network: "fetch failed" } : n <= 3 ? SENATE_ROLL : HTML_PAGE), senate);
  assert.equal(r.summary.transient, 1);
  assert.deepEqual(r.landed, [1, 3]);
  assert.equal(r.summary.stop?.at, 6);
});

test("FIX-1324 a stored roll resets the run: it proves the session goes on", async () => {
  // 2 and 3 miss, 4 is stored, 5 and 6 miss — no stop until 7.
  const r = await walk((n) => (n === 1 ? SENATE_ROLL : HTML_PAGE), {
    ...senate,
    stored: new Set(["senate-119-2-00004"]),
  });
  assert.deepEqual(r.fetched, [1, 2, 3, 5, 6, 7]);
  assert.equal(r.summary.stop?.at, 7);
  assert.equal(r.summary.stored, 1);
});

test("FIX-1324 senate.gov's 403 (since 10-23) ends the session after 3, and the line names it", async () => {
  const r = await walk(() => ({ status: 403 }), senate);
  assert.deepEqual(r.fetched, [1, 2, 3]);
  assert.match(r.lines[0]!, /stopped at roll 3 after 3 consecutive misses — fetched 3: 0 rolls, 3 misses \(HTTP 403 ×3\)/);
  assert.equal(r.errors.length, 0);
});

test("FIX-1324 a real 404 still ends the session at once (the old break)", async () => {
  const r = await walk((n) => (n <= 2 ? SENATE_ROLL : { status: 404 }), senate);
  assert.deepEqual(r.fetched, [1, 2, 3]);
  assert.match(r.lines[0]!, /ended at roll 3 \(HTTP 404\) — fetched 3: 2 rolls, 0 misses, 0 transient/);
});

test("FIX-1324 the House clerk's 200 sanitizing error is a miss: 2025 stops at 365, not 500", async () => {
  // 2025's last House roll is 362; everything to 362 is already stored.
  const stored = new Set(Array.from({ length: 362 }, (_, i) => `2025-house-${String(i + 1).padStart(3, "0")}`));
  const r = await walk((n) => (n <= 362 ? HOUSE_ROLL : HOUSE_SANITIZING), {
    ...house,
    label: "House session 1 (2025)",
    rollCallIdFor: (n) => `2025-house-${String(n).padStart(3, "0")}`,
    urlFor: (n) => `https://clerk.house.gov/evs/2025/roll${String(n).padStart(3, "0")}.xml`,
    stored,
  });
  assert.deepEqual(r.fetched, [363, 364, 365]);
  assert.deepEqual(r.lines, [
    "  House session 1 (2025): stopped at roll 365 after 3 consecutive misses — fetched 3: 0 rolls, " +
      "3 misses (non-roll body ×3), 0 transient; 362 already stored",
  ]);
});

test("FIX-1324 the 10-15 shape: session 2 to roll 256 with 7 unstored holes — 10 fetches, not 251", async () => {
  const holes = new Set([3, 4, 6, 14, 50, 200, 249]);
  const stored = new Set<string>();
  for (let n = 1; n <= 256; n++) if (!holes.has(n)) stored.add(`senate-119-2-${String(n).padStart(5, "0")}`);
  const r = await walk((n) => (n <= 256 ? SENATE_ROLL : HTML_PAGE), { ...senate, stored });
  assert.equal(r.summary.fetched, holes.size + MISS_LIMIT);
  assert.deepEqual(r.landed, [...holes]);
  assert.equal(r.summary.stop?.at, 259);
});

test("FIX-1324 a session that never misses walks to maxRoll and says so", async () => {
  const r = await walk(() => SENATE_ROLL, { ...senate, maxRoll: 4 });
  assert.equal(r.summary.stop, null);
  assert.match(r.lines[0]!, /probed to roll 4 — fetched 4: 4 rolls/);
});

test("FIX-1324 classifyFetchError reads fetchText's message", () => {
  assert.deepEqual(classifyFetchError(new Error("HTTP 404 Not Found — u")), { kind: "end", why: "HTTP 404" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 403 Forbidden — u\n  Body: x")), { kind: "miss", why: "HTTP 403" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 429 Too Many — u")), { kind: "miss", why: "HTTP 429" });
  assert.deepEqual(classifyFetchError(new Error("HTTP 502 Bad Gateway — u")), { kind: "transient", why: "HTTP 502" });
  assert.equal(classifyFetchError(new TypeError("fetch failed")).kind, "transient");
});
