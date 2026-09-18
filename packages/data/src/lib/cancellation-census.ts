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
 */

/** One minute of `postgres_logs`, as the census aggregates it. */
export interface CancellationBucket {
  /** Bucket start, ms since epoch. */
  startMs: number;
  /** `canceling statement due to statement timeout` — the 57014 class. */
  timeouts: number;
  /** `canceling statement due to user request` — cancelled by hand. Reported, not gated. */
  userRequests: number;
}

/** One 15-minute `edge_logs` bucket. Same shape the front-door route reads. */
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
  const pass = baseline > 0 ? ratio <= RATIO_GATE : total === 0;
  return {
    total,
    minutes,
    rate,
    baseline,
    ratio,
    pass,
    note:
      baseline <= 0
        ? "baseline is 0 — the ratio is not meaningful; gating on 'no cancellations at all'"
        : total === 0
          ? "no cancellations in the window"
          : `${total} cancellation(s) over ${minutes} min`,
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
