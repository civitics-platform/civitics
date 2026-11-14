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
 *
 * FIX-1407 — the polite walk, every part opt-in (the House passes none of it):
 *
 *   seen        rolls known to parse as rolls that did not land (the Senate's
 *               `pipeline_state` record): skipped like stored ones, counted apart
 *   recheck     known rolls whose skip has lapsed: they hold the frontier up and
 *               are fetched again with the gaps
 *   tail-first  pass A walks up from the frontier (the highest stored or known
 *               roll) until `missLimit` misses — the new rolls; pass B then
 *               fetches the gaps below it, where a miss is not the session's end
 *   skipTail    no pass A: the session is over and its end was already found
 *   blocked     403 / 429 is "not now", not "no such roll": wait, retry the same
 *               roll, and only after the last retry count it blocked. `limit`
 *               blocked rolls end the session; a block is never a miss
 *   paceMs      a sleep between GETs (never before the first), plus jitter
 *
 * Wed 11-11's nightly fetched 163 Senate rolls and stored 2: the other 161
 * parse fine and carry no bill reference, so they were never in `votes` and
 * were fetched again every night, ahead of the new rolls at the session's end.
 */

/** Consecutive misses that end a session. */
export const MISS_LIMIT = 3;

/** FIX-1407: rolls that stay blocked after every retry before a session ends. */
export const BLOCKED_LIMIT = 3;

/** FIX-1407: the waits before each retry of a blocked roll. */
export const BLOCKED_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000];

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
  | { kind: "transient"; why: string }
  | { kind: "blocked"; why: string };

/**
 * A `fetchText` failure, by its message (`HTTP <status> <text> — <url>…`, see
 * members.ts). No status at all is a network failure or a timeout: transient.
 * A 403 or 429 is `blocked` only for a caller that opted in (FIX-1407); for the
 * House it stays a miss.
 */
export function classifyFetchError(err: unknown, opts: { blocked?: boolean } = {}): RollOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (!m) return { kind: "transient", why: msg.split("\n")[0]!.slice(0, 120) };
  const status = Number(m[1]);
  if (status === 404) return { kind: "end", why: "HTTP 404" };
  if (status >= 500) return { kind: "transient", why: `HTTP ${status}` };
  if (opts.blocked && (status === 403 || status === 429)) return { kind: "blocked", why: `HTTP ${status}` };
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

  // FIX-1407 — the polite walk. Every field is optional; passing none of them
  // is the FIX-1324 walk, fetch for fetch and line for line.

  /** roll_call_ids fetched before as rolls that did not land — skipped like stored ones. */
  seen?: ReadonlySet<string>;
  /** Known rolls whose skip has lapsed: they hold the frontier up and are fetched with the gaps. */
  recheck?: ReadonlySet<string>;
  /** "tail-first": pass A from the frontier up, then pass B over the gaps below it. */
  order?: "ascending" | "tail-first";
  /** Tail-first only: skip pass A — the session's end is already known. */
  skipTail?: boolean;
  /** 403 / 429 → wait `retryDelaysMs[i]`, retry; `limit` rolls blocked after every retry end the session. */
  blocked?: { retryDelaysMs: readonly number[]; limit: number };
  /** A sleep of `base` + 0..`jitter` ms before every GET but the first. */
  paceMs?: { base: number; jitter: number };
  /** Injectable for tests; a real timer by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** How a tail-first walk's pass A ended. */
export type TailEnd = "past-end" | "blocked" | "max-roll" | "closed";

export interface RollProbeSummary {
  fetched: number;
  rolls: number;
  misses: number;
  transient: number;
  stored: number;
  missReasons: Record<string, number>;
  /** Where and why the walk ended early; null when it reached maxRoll. */
  stop: { at: number; why: string } | null;

  // FIX-1407 — zero / null unless the caller opted in.

  /** True when the caller passed any FIX-1407 option; the summary line then prints the fields below. */
  polite: boolean;
  seenSkipped: number;
  /** Rolls still blocked after their last retry. */
  blocked: number;
  /** GETs sent to retry a blocked roll. */
  blockedRetries: number;
  /** The first blocked answer: which GET of this walk it was, and on which roll. */
  firstBlocked: { get: number; at: number; why: string } | null;
  /** GETs sent: one per fetched roll, plus each retry. */
  gets: number;
  /** Rolls pass A found past the frontier. */
  tailNew: number;
  /**
   * Tail-first only. `unsure` counts pass A's blocked and transient rolls: any
   * of them may be a real roll the walk stepped over, so a tail that ended
   * past-end with `unsure > 0` is not proof the session's last roll was seen.
   */
  tail: { frontier: number; end: TailEnd; at: number | null; why: string | null; unsure: number } | null;
}

type Attempt<T> = { outcome: RollOutcome; parsed: T | null };

const NONE: ReadonlySet<string> = new Set();
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function probeSessionRolls<T>(
  opts: RollProbeOptions<T>,
  onRoll: (roll: ProbedRoll<T>) => void | Promise<void>,
): Promise<RollProbeSummary> {
  const maxRoll = opts.maxRoll ?? MAX_ROLL;
  const missLimit = opts.missLimit ?? MISS_LIMIT;
  const seen = opts.seen ?? NONE;
  const recheck = opts.recheck ?? NONE;
  const sleep = opts.sleep ?? realSleep;
  const s: RollProbeSummary = {
    fetched: 0, rolls: 0, misses: 0, transient: 0, stored: 0, missReasons: {}, stop: null,
    polite:
      opts.seen !== undefined || opts.recheck !== undefined || opts.order !== undefined ||
      opts.skipTail !== undefined || opts.blocked !== undefined || opts.paceMs !== undefined,
    seenSkipped: 0, blocked: 0, blockedRetries: 0, firstBlocked: null, gets: 0, tailNew: 0, tail: null,
  };

  /** One GET and its classification. `waitMs` is a blocked retry's wait; null paces. */
  const attempt = async (rollNum: number, url: string, waitMs: number | null): Promise<Attempt<T>> => {
    if (waitMs !== null) await sleep(waitMs);
    else if (opts.paceMs && s.gets > 0) await sleep(opts.paceMs.base + Math.round(Math.random() * opts.paceMs.jitter));
    s.gets++;
    try {
      const body = await opts.fetchText(url);
      if (!looksLikeRoll(body, opts.rootTag)) return { outcome: { kind: "miss", why: "non-roll body" }, parsed: null };
      let parsed: T | null;
      try {
        parsed = opts.parse(body);
      } catch {
        parsed = null;
      }
      return parsed === null
        ? { outcome: { kind: "miss", why: "unparseable roll body" }, parsed: null }
        : { outcome: { kind: "roll" }, parsed };
    } catch (err) {
      const outcome = classifyFetchError(err, { blocked: opts.blocked !== undefined });
      if (outcome.kind === "blocked" && s.firstBlocked === null) {
        s.firstBlocked = { get: s.gets, at: rollNum, why: outcome.why };
      }
      return { outcome, parsed: null };
    }
  };

  /** One roll: its GET, then a retry after each wait while it answers blocked. */
  const fetchRoll = async (rollNum: number): Promise<Attempt<T> & { url: string }> => {
    const url = opts.urlFor(rollNum);
    s.fetched++;
    let a = await attempt(rollNum, url, null);
    const waits: number[] = [];
    for (const waitMs of opts.blocked?.retryDelaysMs ?? []) {
      if (a.outcome.kind !== "blocked") break;
      s.blockedRetries++;
      waits.push(waitMs);
      a = await attempt(rollNum, url, waitMs);
    }
    if (waits.length > 0 || a.outcome.kind === "blocked") {
      const retried = waits.length > 0 ? ` after ${waits.map((ms) => `${ms / 1000} s`).join(", ")}` : "";
      opts.log(
        a.outcome.kind === "blocked"
          ? `    Roll ${rollNum}: blocked — ${a.outcome.why} on ${waits.length + 1} GETs${retried} (not counted toward the stop)`
          : `    Roll ${rollNum}: blocked, then answered on retry ${waits.length}${retried}`,
      );
    }
    return { ...a, url };
  };

  const took = async (rollNum: number, a: Attempt<T> & { url: string }) => {
    s.rolls++;
    await onRoll({ rollNum, rollCallId: opts.rollCallIdFor(rollNum), url: a.url, parsed: a.parsed as T });
  };
  const transient = (rollNum: number, why: string) => {
    s.transient++;
    opts.log(`    Roll ${rollNum}: transient fetch error — ${why} (not counted toward the stop)`);
  };
  const miss = (why: string) => {
    s.misses++;
    s.missReasons[why] = (s.missReasons[why] ?? 0) + 1;
  };
  /** Count a roll blocked after its retries; true when that ends the session. */
  const blockedOut = (rollNum: number): boolean => {
    s.blocked++;
    if (s.blocked < (opts.blocked?.limit ?? BLOCKED_LIMIT)) return false;
    s.stop = { at: rollNum, why: `blocked ×${s.blocked}` };
    return true;
  };

  if (opts.order !== "tail-first") {
    let run = 0;
    for (let rollNum = 1; rollNum <= maxRoll; rollNum++) {
      const rollCallId = opts.rollCallIdFor(rollNum);
      if (opts.stored.has(rollCallId)) {
        s.stored++;
        run = 0;
        continue;
      }
      if (seen.has(rollCallId)) {
        s.seenSkipped++;
        run = 0;
        continue;
      }

      const a = await fetchRoll(rollNum);
      const outcome = a.outcome;
      if (outcome.kind === "roll") {
        run = 0;
        await took(rollNum, a);
        continue;
      }
      if (outcome.kind === "transient") {
        transient(rollNum, outcome.why);
        continue;
      }
      if (outcome.kind === "blocked") {
        if (blockedOut(rollNum)) break;
        continue;
      }
      if (outcome.kind === "end") {
        s.stop = { at: rollNum, why: outcome.why };
        break;
      }
      miss(outcome.why);
      if (++run >= missLimit) {
        s.stop = { at: rollNum, why: `${missLimit} consecutive misses` };
        break;
      }
    }
  } else {
    // The frontier: the highest roll stored, seen, or due a re-check.
    let frontier = 0;
    for (let rollNum = 1; rollNum <= maxRoll; rollNum++) {
      const rollCallId = opts.rollCallIdFor(rollNum);
      if (opts.stored.has(rollCallId)) s.stored++;
      else if (seen.has(rollCallId)) s.seenSkipped++;
      else if (!recheck.has(rollCallId)) continue;
      frontier = rollNum;
    }
    const tail: NonNullable<RollProbeSummary["tail"]> = { frontier, end: "closed", at: null, why: null, unsure: 0 };
    s.tail = tail;

    // Pass A — the new rolls: up from the frontier until the session ends.
    if (!opts.skipTail) {
      const endTail = (end: TailEnd, at: number, why: string) => {
        tail.end = end;
        tail.at = at;
        tail.why = why;
      };
      tail.end = "max-roll" as TailEnd;
      let run = 0;
      for (let rollNum = frontier + 1; rollNum <= maxRoll; rollNum++) {
        const a = await fetchRoll(rollNum);
        const outcome = a.outcome;
        if (outcome.kind === "roll") {
          run = 0;
          s.tailNew++;
          await took(rollNum, a);
          continue;
        }
        if (outcome.kind === "transient") {
          tail.unsure++;
          transient(rollNum, outcome.why);
          continue;
        }
        if (outcome.kind === "blocked") {
          tail.unsure++;
          if (blockedOut(rollNum)) {
            endTail("blocked", rollNum, s.stop!.why);
            break;
          }
          continue;
        }
        if (outcome.kind === "end") {
          endTail("past-end", rollNum, outcome.why);
          break;
        }
        miss(outcome.why);
        if (++run >= missLimit) {
          endTail("past-end", rollNum, `${missLimit} consecutive misses`);
          break;
        }
      }
      if (tail.end === "past-end") s.stop = { at: tail.at!, why: tail.why! };
    }

    // Pass B — the gaps below the frontier. A miss here is a hole in the
    // session, not its end, so nothing but `blocked` stops the pass.
    if (tail.end !== "blocked") {
      for (let rollNum = 1; rollNum <= frontier; rollNum++) {
        const rollCallId = opts.rollCallIdFor(rollNum);
        if (opts.stored.has(rollCallId) || seen.has(rollCallId)) continue;

        const a = await fetchRoll(rollNum);
        const outcome = a.outcome;
        if (outcome.kind === "roll") await took(rollNum, a);
        else if (outcome.kind === "transient") transient(rollNum, outcome.why);
        else if (outcome.kind === "blocked") {
          if (blockedOut(rollNum)) break;
        } else miss(outcome.why);
      }
    }
  }

  opts.log(summaryLine(opts.label, s, maxRoll));
  return s;
}

/**
 * `Senate session 2: stopped at roll 259 after 3 consecutive misses — fetched
 * 164: 161 rolls, 3 misses (non-roll body ×3), 0 transient; 92 already stored`
 *
 * A polite walk (FIX-1407) adds the tail, the GET count, the blocked rolls and
 * their retries, and the seen-unstored skips:
 *
 * `Senate session 2: tail after roll 258: 2 new, past end at roll 263 (3
 * consecutive misses) — fetched 5 in 5 GETs: 2 rolls, 3 misses (non-roll body
 * ×3), 0 blocked (0 retries), 0 transient; 196 already stored, 60
 * seen-unstored skipped`
 */
export function summaryLine(label: string, s: RollProbeSummary, maxRoll: number): string {
  const head = s.stop === null
    ? `probed to roll ${maxRoll}`
    : s.stop.why === "HTTP 404"
      ? `ended at roll ${s.stop.at} (HTTP 404)`
      : `stopped at roll ${s.stop.at} after ${s.stop.why}`;
  const reasons = Object.entries(s.missReasons).map(([why, n]) => `${why} ×${n}`).join(", ");
  if (!s.polite) {
    return (
      `  ${label}: ${head} — fetched ${s.fetched}: ${s.rolls} rolls, ` +
      `${s.misses} misses${reasons ? ` (${reasons})` : ""}, ${s.transient} transient; ` +
      `${s.stored} already stored`
    );
  }

  let politeHead = head;
  const t = s.tail;
  if (t) {
    politeHead =
      t.end === "closed"
        ? `tail closed after roll ${t.frontier}`
        : `tail after roll ${t.frontier}: ${s.tailNew} new, ` +
          (t.end === "past-end"
            ? `past end at roll ${t.at} (${t.why})`
            : t.end === "blocked"
              ? `stopped at roll ${t.at} after ${t.why}`
              : `probed to roll ${maxRoll}`);
    // Pass B blocked out after pass A ended on its own.
    if (s.stop && s.stop.why.startsWith("blocked") && t.end !== "blocked") {
      politeHead += `; gaps stopped at roll ${s.stop.at} after ${s.stop.why}`;
    }
  }
  const first = s.firstBlocked ? `, first ${s.firstBlocked.why} at GET ${s.firstBlocked.get} on roll ${s.firstBlocked.at}` : "";
  return (
    `  ${label}: ${politeHead} — fetched ${s.fetched} in ${s.gets} GETs: ${s.rolls} rolls, ` +
    `${s.misses} misses${reasons ? ` (${reasons})` : ""}, ` +
    `${s.blocked} blocked (${s.blockedRetries} retries${first}), ${s.transient} transient; ` +
    `${s.stored} already stored, ${s.seenSkipped} seen-unstored skipped`
  );
}
