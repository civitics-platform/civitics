/**
 * The verdict half of the 57014 / front-door census — pure, so it is testable.
 *
 * The gates are cc-131's read 7 (f), which the drain-and-wait block in
 * `docs/cc/PROMPT_TEMPLATE.md` now states as a rule: statement cancellations
 * per minute over the last hour at or below TWICE the measured baseline, and
 * front-door 5xx at or below 1 % over the last CLOSED 15-minute bucket.
 *
 * Both are expressed as a RATIO against a stated baseline rather than as an
 * absolute, for the reason cc-130 earned: a gate must describe a state prod
 * actually visits. "Zero cancellations in an hour" is not that state — the
 * measured baseline is 0.033/min, i.e. about two an hour, on a healthy box.
 *
 * ── THE POISSON FLOOR (cc-151 D1) ───────────────────────────────────────────
 * A ratio test on a count under ~10 is noise. At 0.033/min the expected count
 * is λ = 2.0 in 60 min and λ = 0.5 in 15 min, so with no burst at all a 60-min
 * reading failed `ratio > 2` at >= 4 events (P = 14.3 % per reading) and a
 * 15-min reading failed at >= 1 (P = 39.4 %) — seven pre-CALL readings over a
 * one-hour run tripped with P ≈ 97 % on an ordinary night (cc-148 §5.3). So a
 * reading now FAILS only when BOTH hold:
 *   ratio > RATIO_GATE   AND   total > poissonP99(baseline × minutes)
 * i.e. the count is also above what the baseline itself produces 99 % of the
 * time. At λ = 2.0 the floor is 6 (a 60-min reading fails at >= 7, tail
 * 0.45 %); at λ = 0.5 it is 3 (a 15-min reading fails at >= 4, tail 0.18 %).
 * Above ~10 events the ratio dominates again and the floor stops binding.
 */

import { isLogsEndpointGone, worstLogsAnswer, type LogsAnswer } from "@civitics/db";

/** One minute of `postgres_logs`, as the census aggregates it. */
export interface CancellationBucket {
  /** Bucket start, ms since epoch. */
  startMs: number;
  /** `canceling statement due to statement timeout` — the 57014 class. */
  timeouts: number;
  /** `canceling statement due to user request` — cancelled by hand. Reported, not gated. */
  userRequests: number;
}

/** One 15-minute `edge_logs` bucket. The helper's LogsEdgeBucket, less the 52x count the verdict does not read. */
export interface EdgeBucket {
  startMs: number;
  requests: number;
  n5xx: number;
}

export interface CancellationVerdict {
  total: number;
  minutes: number;
  /** Cancellations per minute over the window. */
  rate: number;
  baseline: number;
  /** rate / baseline. Infinity when the baseline is 0 and the rate is not. */
  ratio: number;
  /** baseline × minutes — the count the baseline itself expects in the window. */
  lambda: number;
  /** poissonP99(lambda): a count at or below this never fails, whatever the ratio. */
  floor: number;
  pass: boolean;
  note: string;
}

export interface EdgeVerdict {
  /** The last bucket with any traffic in it, or null when every bucket is empty. */
  lastClosed: EdgeBucket | null;
  pct5xx: number | null;
  pass: boolean;
  note: string;
}

/** The gate: at most twice the stated baseline. */
export const RATIO_GATE = 2;

/** The gate: at most 1 % 5xx in the last closed bucket. */
export const PCT_5XX_GATE = 1;

/** The floor's quantile: a count the baseline alone exceeds 1 % of the time. */
export const FLOOR_QUANTILE = 0.99;

/**
 * The smallest k with P(X <= k) >= 0.99 for X ~ Poisson(λ). Summed in log
 * space so a large λ does not underflow e^-λ to zero. λ <= 0 (or not finite)
 * is 0: no expected events, so no tolerance above none.
 */
export function poissonP99(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  const logL = Math.log(lambda);
  const kMax = Math.ceil(lambda + 12 * Math.sqrt(lambda) + 25);
  let logP = -lambda; // log P(X = 0)
  let cum = 0;
  for (let k = 0; k <= kMax; k++) {
    cum += Math.exp(logP);
    if (cum >= FLOOR_QUANTILE) return k;
    logP += logL - Math.log(k + 1);
  }
  return kMax;
}

export function verdictFor(input: {
  cancellations: readonly CancellationBucket[];
  minutes: number;
  baseline: number;
}): CancellationVerdict {
  const { minutes, baseline } = input;
  const total = input.cancellations.reduce((n, b) => n + b.timeouts, 0);
  const rate = minutes > 0 ? total / minutes : 0;
  // A zero baseline makes the ratio meaningless rather than infinite-and-failing,
  // so it is called out as such instead of silently gating on division.
  const ratio = baseline > 0 ? rate / baseline : total === 0 ? 0 : Number.POSITIVE_INFINITY;
  const lambda = baseline > 0 ? baseline * minutes : 0;
  const floor = poissonP99(lambda);
  const overRatio = ratio > RATIO_GATE;
  const overFloor = total > floor;
  const pass = baseline > 0 ? !(overRatio && overFloor) : total === 0;
  const head = `${total} over ${minutes} min — ratio ${ratio.toFixed(2)}`;
  const at = `P99 floor ${floor} at λ=${lambda.toFixed(1)}`;
  return {
    total,
    minutes,
    rate,
    baseline,
    ratio,
    lambda,
    floor,
    pass,
    note:
      baseline <= 0
        ? "baseline is 0 — the ratio is not meaningful; gating on 'no cancellations at all'"
        : total === 0
          ? `no cancellations in the window (${at})`
          : !overRatio
            ? `${head} <= ${RATIO_GATE}`
            : overFloor
              ? `${head} > ${RATIO_GATE} and > ${at}`
              : `${head} > ${RATIO_GATE} but <= ${at}`,
  };
}

/**
 * The 5xx gate, read off the LAST CLOSED bucket.
 *
 * "Closed" matters: the newest bucket is usually still filling, so a single 5xx
 * arriving into a bucket holding three requests reads as 33 %. The caller aligns
 * its window to a bucket boundary, and this takes the last bucket that actually
 * carried traffic — a bucket with zero requests is not evidence of health and is
 * reported as `no traffic` rather than as a pass on 0 %.
 */
export function edgeVerdictFor(buckets: readonly EdgeBucket[]): EdgeVerdict {
  const withTraffic = buckets.filter((b) => b.requests > 0);
  const last = withTraffic.length > 0 ? withTraffic[withTraffic.length - 1]! : null;
  if (!last) {
    return {
      lastClosed: null,
      pct5xx: null,
      pass: true,
      note: "no traffic in any bucket — nothing to fail, and nothing proved either",
    };
  }
  const pct = (last.n5xx / last.requests) * 100;
  return {
    lastClosed: last,
    pct5xx: pct,
    pass: pct <= PCT_5XX_GATE,
    note: `${last.n5xx} of ${last.requests} request(s) = ${pct.toFixed(2)} %`,
  };
}

// ───────────────────────────── attribution mode ─────────────────────────────
//
// The gate above answers "is the box healthy enough to start". Attribution
// answers a different question — WHICH statement is being cancelled — and the
// two must not be confused, so this half returns no verdict and the caller
// exits 0 regardless. It is an instrument, not a gate.
//
// It exists because pgss CANNOT answer it. `pg_stat_statements` does not record
// a statement that was cancelled (measured on local PG17, cc-137 read 2: a
// `SET statement_timeout='1s'` + `pg_sleep(3.5)` leaves ZERO pgss rows), so
// every 57014 is invisible there by construction and the Logs API is the only
// instrument that can see one.
//
// The SQL, the field allow-list and the `--like` sanitiser live with the Logs
// helper (`packages/db/src/supabase-logs.ts`, FIX-1219): they are facts about
// the log schema, and the schema is what changed under them.

export {
  ATTRIBUTABLE_FIELDS,
  isAttributableField,
  sanitizeLike,
  LOGS_RETENTION_DAYS,
  type AttributableField,
} from "@civitics/db";

/** One attribution group: a field value and how many cancellations carried it. */
export interface AttributionRow {
  group: string;
  count: number;
}

/**
 * THE 24-HOUR CLAMP — the single most important thing to know about this API.
 *
 * Asked for more than 24 h, the Logs API answers the OLDEST 24 h of the range.
 * It does not error, it does not warn, and it does not return a short window —
 * it returns a FULL, PLAUSIBLE 24 h of rows that are the first day asked for.
 *
 * Measured on the old `logs.all` endpoint (cc-137 read 2, at 2026-09-19T03:07Z):
 *
 *   lookback   rows   rows actually covering
 *   1 day      3790   2026-09-18T03:08 → 2026-09-19T03:06   (the whole window)
 *   2 days     4824   2026-09-17T03:08 → 2026-09-18T03:06   (the OLDEST day)
 *   3 days     3857   2026-09-16T03:08 → 2026-09-17T03:06   (the OLDEST day)
 *   7 days     3874   2026-09-12T03:08 → 2026-09-13T03:06   (the OLDEST day)
 *
 * Re-measured on its replacement, `logs` (cc-155 D2, per-hour buckets of
 * postgres_logs): 24 h → 24 rows, the whole window; 25 h, 48 h and 7 d → 24
 * rows each, the OLDEST day each time. Same clamp, so the same constant — now
 * the helper's `MAX_LOGS_RANGE_MINUTES`, which also refuses to SEND a longer
 * range. The script refuses first, in both modes, with a message a person can
 * act on: walk a longer span with repeated `--end` runs.
 */
export { MAX_LOGS_RANGE_MINUTES as MAX_ATTRIBUTION_MINUTES } from "@civitics/db";

/**
 * Render the attribution table. Pure, so the shape is a test rather than a
 * thing you confirm by eye against prod.
 */
export function formatAttribution(input: {
  rows: readonly AttributionRow[];
  field: string;
  like: string | null;
  startIso: string;
  endIso: string;
}): string {
  const { rows, field, like, startIso, endIso } = input;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const head =
    `── 57014 attribution ── by ${field}` +
    (like ? ` · query like %${like}%` : "") +
    `\n   ${startIso} → ${endIso}`;
  if (rows.length === 0) {
    return `${head}\n   no statement-timeout cancellation matched in this window`;
  }
  const width = Math.max(...rows.map((r) => r.group.length), 5);
  const lines = rows.map((r) => {
    const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
    return `   ${r.group.padEnd(width)}  ${String(r.count).padStart(6)}  ${pct.padStart(5)} %`;
  });
  return [
    head,
    `   ${"group".padEnd(width)}  ${"count".padStart(6)}  ${"share".padStart(5)}  `,
    ...lines,
    `   ${"".padEnd(width)}  ${String(total).padStart(6)}  total`,
    "",
    "   NOT A GATE — attribution only; this exits 0 whatever it finds.",
  ].join("\n");
}

// ──────────────────── the Logs API's answer, three ways (FIX-1219) ────────────────────
//
// `rows` is a reading. `dark` is the Logs API failing to answer: a 5xx, a 429,
// a timeout, a network error, a 200 carrying an error or no result array. On
// 09-22 that was itself a symptom of the box (rule 164), so a runner counts it.
// `unavailable` is the endpoint being GONE — how `logs.all` answered from
// 2026-09-24 10:00 UTC (410; changelog 48235) until FIX-1219 ported the census
// to `logs`, and how the next removal will answer. That is not a reading and
// not a symptom, and it keeps its own exit code so no consumer mistakes it for
// dark. The answer type and its precedence are the Logs helper's
// (`packages/db/src/supabase-logs.ts`); the exit codes are the census's.

export type { LogsAnswer } from "@civitics/db";

/** The census's exit codes. 3 is not used (it is the bootstrap runner's retired census_fail). */
export const CENSUS_EXIT = { pass: 0, fail: 1, dark: 2, unavailable: 8 } as const;

/**
 * The exit a set of answers owes before any verdict: `unavailable` if ANY half
 * found the endpoint gone (both halves share one endpoint, and a dark sibling
 * of a removed endpoint says nothing), else `dark` if any half was dark, else
 * null (every half has rows, go on to the verdict). The precedence is the
 * helper's `worstLogsAnswer`; this only names the exit.
 */
export function answersExit(
  answers: readonly LogsAnswer<unknown>[],
): { code: typeof CENSUS_EXIT.unavailable; status: number; detail: string } | { code: typeof CENSUS_EXIT.dark; detail: string } | null {
  const worst = worstLogsAnswer(answers);
  if (!worst) return null;
  return worst.kind === "unavailable"
    ? { code: CENSUS_EXIT.unavailable, status: worst.status, detail: worst.detail }
    : { code: CENSUS_EXIT.dark, detail: worst.detail };
}

/**
 * The one-line summary of exit 8. A removed path (410/404) reads by its
 * status; a removed table or field (a 200 whose error says it does not exist,
 * cc-156) reads by the helper's detail, which names what is missing.
 */
export function unavailableSummary(status: number, detail?: string): string {
  return detail && !isLogsEndpointGone(status)
    ? `unavailable — ${detail} (FIX-1219)`
    : `unavailable — Logs API endpoint removed (${status}; FIX-1219)`;
}

/** The `--json` body of exit 8, in place of the verdict halves (or the attribution rows). */
export function unavailableJson(status: number, window: { start: string; end: string; minutes: number }, detail?: string) {
  return {
    window,
    unavailable: true as const,
    http_status: status,
    ...(detail ? { detail } : {}),
    fix: "FIX-1219",
    summary: unavailableSummary(status, detail),
  };
}
