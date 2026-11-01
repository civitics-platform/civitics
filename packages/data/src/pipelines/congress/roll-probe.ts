/**
 * FIX-1324 — walk one chamber session's roll numbers, and stop past its last roll.
 *
 * Both collectors probed rolls 1..500 and relied on an HTTP 404 to end the
 * session. Neither feed sends one (read 2026-11-01):
 *
 *   - clerk.house.gov answers a missing roll 200 `application/xml` with
 *     `<xml>Error sanitizing file "roll450.xml". Please try again.</xml>`. Every
 *     nightly fetched and logged 324 of them ("unexpected XML structure"): 138
 *     past 2025's roll 362, 186 past 2026's last.
 *   - www.senate.gov answered rolls 257–500 of session 2 with an HTML page
 *     (10-15 → 10-22 nightlies). fast-xml-parser throws on it inside
 *     `OrderedObjParser.parseXml` — `TypeError … reading 'tagName'`, from a `<`
 *     in an inline script followed by an unclosed quote — so each one surfaced
 *     as an `unexpected error` with a six-frame stack (241 a night, cc-228 §8).
 *   - Since the 10-23 nightly, senate.gov answers EVERY request 403 (Akamai),
 *     real rolls included. That is its own FIX; here it just counts as a miss.
 *
 * So every fetched response is classified, and only a roll body reaches `parse`:
 *
 *   roll       the body holds the chamber's root tag and `parse` returns a value
 *   miss       200 without the root tag (HTML, the clerk's sanitizing error), a
 *              root tag that does not parse, or a 4xx other than 404. Counted.
 *   end        HTTP 404 — the old `break`, kept for a feed that does send one
 *   transient  5xx, or no HTTP status at all (network, timeout). Not counted.
 *
 * `missLimit` (3) consecutive misses end the session. A roll already stored
 * resets the run: it proves the session goes on past the misses before it.
 * The per-roll lines are gone — one summary line per session says what was
 * fetched, what landed in which class, and where and why the walk stopped.
 */

/** Consecutive misses that end a session. */
export const MISS_LIMIT = 3;

/**
 * The walk's upper bound — a runaway guard now, not the stop. It was 500 when
 * nothing else ended a session, and Senate session 1 (2025) runs past 500: on
 * every 10-15 → 10-22 nightly, rolls 1–500 of it all answered as rolls (none of
 * the 241 misses was session 1's), so its rolls above 500 were never requested.
 */
export const MAX_ROLL = 1000;

export type RollOutcome =
  | { kind: "roll" }
  | { kind: "miss"; why: string }
  | { kind: "end"; why: string }
  | { kind: "transient"; why: string };

/**
 * A `fetchText` failure, by its message (`HTTP <status> <text> — <url>…`, see
 * members.ts). No status at all is a network failure or a timeout: transient.
 */
export function classifyFetchError(err: unknown): RollOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (!m) return { kind: "transient", why: msg.split("\n")[0]!.slice(0, 120) };
  const status = Number(m[1]);
  if (status === 404) return { kind: "end", why: "HTTP 404" };
  if (status >= 500) return { kind: "transient", why: `HTTP ${status}` };
  return { kind: "miss", why: `HTTP ${status}` };
}

/** True when the body carries the chamber's roll root element. */
export function looksLikeRoll(body: string, rootTag: string): boolean {
  return body.includes(`<${rootTag}`);
}

export interface ProbedRoll<T> {
  rollNum: number;
  rollCallId: string;
  url: string;
  parsed: T;
}

export interface RollProbeOptions<T> {
  /** "Senate session 2", "House session 1 (2025)" — leads the summary line. */
  label: string;
  /** The root element a roll body carries: `roll_call_vote`, `rollcall-vote`. */
  rootTag: string;
  rollCallIdFor: (rollNum: number) => string;
  urlFor: (rollNum: number) => string;
  /** roll_call_ids already in `votes` — skipped, never fetched. */
  stored: ReadonlySet<string>;
  fetchText: (url: string) => Promise<string>;
  /** Called only on a body that passed `looksLikeRoll`. Null is a miss. */
  parse: (body: string) => T | null;
  log: (line: string) => void;
  maxRoll?: number;
  missLimit?: number;
}

export interface RollProbeSummary {
  fetched: number;
  rolls: number;
  misses: number;
  transient: number;
  stored: number;
  missReasons: Record<string, number>;
  /** Where and why the walk ended early; null when it reached maxRoll. */
  stop: { at: number; why: string } | null;
}

export async function probeSessionRolls<T>(
  opts: RollProbeOptions<T>,
  onRoll: (roll: ProbedRoll<T>) => void | Promise<void>,
): Promise<RollProbeSummary> {
  const maxRoll = opts.maxRoll ?? MAX_ROLL;
  const missLimit = opts.missLimit ?? MISS_LIMIT;
  const s: RollProbeSummary = {
    fetched: 0, rolls: 0, misses: 0, transient: 0, stored: 0, missReasons: {}, stop: null,
  };
  let run = 0;

  for (let rollNum = 1; rollNum <= maxRoll; rollNum++) {
    const rollCallId = opts.rollCallIdFor(rollNum);
    if (opts.stored.has(rollCallId)) {
      s.stored++;
      run = 0;
      continue;
    }

    const url = opts.urlFor(rollNum);
    s.fetched++;
    let outcome: RollOutcome;
    let parsed: T | null = null;
    try {
      const body = await opts.fetchText(url);
      if (!looksLikeRoll(body, opts.rootTag)) {
        outcome = { kind: "miss", why: "non-roll body" };
      } else {
        try {
          parsed = opts.parse(body);
        } catch {
          parsed = null;
        }
        outcome = parsed === null ? { kind: "miss", why: "unparseable roll body" } : { kind: "roll" };
      }
    } catch (err) {
      outcome = classifyFetchError(err);
    }

    if (outcome.kind === "roll") {
      s.rolls++;
      run = 0;
      await onRoll({ rollNum, rollCallId, url, parsed: parsed as T });
      continue;
    }
    if (outcome.kind === "transient") {
      s.transient++;
      opts.log(`    Roll ${rollNum}: transient fetch error — ${outcome.why} (not counted toward the stop)`);
      continue;
    }
    if (outcome.kind === "end") {
      s.stop = { at: rollNum, why: outcome.why };
      break;
    }
    s.misses++;
    s.missReasons[outcome.why] = (s.missReasons[outcome.why] ?? 0) + 1;
    if (++run >= missLimit) {
      s.stop = { at: rollNum, why: `${missLimit} consecutive misses` };
      break;
    }
  }

  opts.log(summaryLine(opts.label, s, maxRoll));
  return s;
}

/**
 * `Senate session 2: stopped at roll 259 after 3 consecutive misses — fetched
 * 164: 161 rolls, 3 misses (non-roll body ×3), 0 transient; 92 already stored`
 */
export function summaryLine(label: string, s: RollProbeSummary, maxRoll: number): string {
  const head = s.stop === null
    ? `probed to roll ${maxRoll}`
    : s.stop.why === "HTTP 404"
      ? `ended at roll ${s.stop.at} (HTTP 404)`
      : `stopped at roll ${s.stop.at} after ${s.stop.why}`;
  const reasons = Object.entries(s.missReasons).map(([why, n]) => `${why} ×${n}`).join(", ");
  return (
    `  ${label}: ${head} — fetched ${s.fetched}: ${s.rolls} rolls, ` +
    `${s.misses} misses${reasons ? ` (${reasons})` : ""}, ${s.transient} transient; ` +
    `${s.stored} already stored`
  );
}
