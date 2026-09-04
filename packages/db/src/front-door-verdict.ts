/**
 * FIX-1130 — the front-door wedge detector's decision logic.
 *
 * THE FAILURE MODE THIS EXISTS FOR. The Supabase front door (Cloudflare -> Kong
 * -> PostgREST/pooler) can wedge on its own and STAY wedged long after the
 * database underneath is healthy. On 2026-08-31 it did exactly that for about
 * seventeen hours and nothing in this repo noticed; a Supabase project restart
 * cleared it (`pg_postmaster_start_time()` reads 2026-08-31T23:01:12Z, which
 * lands inside the recovery bucket the series below shows).
 *
 * WHY THIS MODULE IS PURE, AND WHY IT IS IN packages/db RATHER THAN THE ROUTE:
 * the detector must not depend on a Postgres connection succeeding, because a
 * dead Postgres connection is the *symptom* it is built to report. So the route
 * (`/api/cron/front-door-watch`) does the two I/O calls and this module does
 * every decision, which also makes the 2026-08-31 series replayable as a test
 * fixture rather than as prose.
 *
 * ── THE INSTRUMENT: 52x, NOT 5xx ──────────────────────────────────────────────
 *
 * The Cloudflare-class 52x statuses (520-526) are edge-to-origin failures, not
 * application errors. Measured over the Logs API's full retention window
 * (`analytics/endpoints/logs.all` over `edge_logs`, 15-minute buckets), that
 * distinction is the whole ballgame:
 *
 *   550 healthy buckets across 2026-08-28/29/30 and 09-01/02/03
 *     n_52x   p50 0   p90 0   p95 0   p99 0    — and 544 of 550 are exactly 0
 *     n_5xx   p50 0   p90 4   p95 7   p99 28   max 345
 *
 * The six healthy buckets that do carry 52x are not noise, they are the OTHER
 * real outage in the window (2026-08-29 06:15-07:15, the FIX-1125 event where
 * the postmaster could not fork a backend). This detector fires on those too,
 * correctly.
 *
 * ── WHY THERE IS NO 5xx-RATIO ARM ─────────────────────────────────────────────
 *
 * The obvious second rule — "or the 5xx rate is over 20%" — was DESIGNED IN AND
 * THEN REMOVED, because the calibration data says it is a false-page generator
 * with a harmful runbook attached. On 2026-09-01 12:00-18:00 UTC the front door
 * served up to 67.7% 5xx in a 15-minute bucket (345 in one bucket) while
 * n_52x stayed at 0-2. That was the Tuesday cron pile-up: ordinary
 * request-path reads pushed past `service_role`'s 8 s statement timeout by I/O
 * saturation (see docs/audits/front-door-degradation-2026-09-01.md, 683
 * statement timeouts against 695 front-door 5xx). The front door was UP. It
 * recovered on its own. Paging "FRONT DOOR DOWN — restart the project" into
 * that window would have been both wrong and actively bad advice.
 *
 * A 5xx-ratio arm at 0.2 would have fired on six buckets that afternoon, two of
 * them consecutive — i.e. it would have paged. The 52x rule fires on none of
 * them. That is why this module reads one number.
 *
 * ── THE RED RULE, AND THE MARGIN IT SITS IN ───────────────────────────────────
 *
 * A bucket is RED when `n_52x >= 3 AND n_52x / requests >= 0.5`.
 *
 * Both halves earn their place:
 *
 *  * The RATIO half is what makes low-traffic buckets work, and that matters
 *    more than it looks. During the 08-31 wedge a 15-minute bucket held as few
 *    as FIVE requests (07:15) — the wedge itself suppresses traffic. A
 *    count-only threshold of 10 would have called seven mid-outage buckets
 *    green (06:45, 07:15, 07:45, 08:45, 14:15, 17:45, 19:45), and a
 *    `requests >= 20` guard would have excluded them from evaluation entirely.
 *  * The COUNT half suppresses the single contaminating healthy bucket that has
 *    a non-trivial ratio (2026-09-01 13:15: 2 of 48). Two is below three.
 *
 * The margin between the populations is enormous, which is the real reason to
 * trust this: every genuinely-wedged bucket measured runs at 95.8-100% 52x,
 * and every non-outage bucket in nine days of retention runs at <= 7.1%. The
 * 0.5 threshold is not tuned to a cliff edge, it is sitting in the middle of a
 * gap with nothing in it.
 *
 * ── WHY FOUR BUCKETS, AND WHY THE NEWEST IS DISCARDED ─────────────────────────
 *
 * The route asks for exactly the last four CLOSED 15-minute buckets. The bucket
 * containing `now` is still filling and its ratio is meaningless early in the
 * window, so it is never evaluated. That costs up to 15 minutes of detection
 * latency and buys freedom from a whole class of phantom transitions.
 *
 * Replayed against 08-31 (first fully-red bucket 06:15), DOWN is declared at the
 * ~07:02 tick — about 47 minutes after onset. Compare: the request-path probe's
 * first red run that day was 11:49, and nothing else noticed at all.
 *
 * ── STATELESSNESS IS A CONSTRAINT, NOT A SHORTCUT ─────────────────────────────
 *
 * There is no Postgres-independent state store in this codebase — both
 * `platform_alert_state` and `pipeline_state` are Postgres tables, and a
 * detector that reads its own dedup state from the database it is reporting on
 * would be dead in exactly the outage it exists for (the FIX-1125 lesson: a
 * guard starved by the condition it exists to end is not a guard). So dedup is
 * derived from the bucket shape plus the wall clock, and nothing is persisted.
 */

/** One 15-minute slice of `edge_logs`, as returned by the Logs API. */
export type FrontDoorBucket = {
  /** Bucket start, ms since epoch, aligned to a 15-minute boundary. */
  startMs: number;
  requests: number;
  n5xx: number;
  n52x: number;
};

/** Result of the direct, Postgres-independent liveness probe. */
export type FrontDoorProbe = {
  /** True when at least one attempt got an HTTP response with status < 500. */
  answered: boolean;
  /** Per-attempt outcome, for the alert body. `status: null` = transport error. */
  attempts: Array<{ status: number | null; ms: number; error?: string }>;
};

export type FrontDoorVerdict = {
  state: "ok" | "down" | "recovered";
  /** Per-bucket RED evaluation, oldest first, aligned with the input. */
  red: boolean[];
  /** True when this tick is the DOWN edge (newest two RED, the one before green). */
  isDownEdge: boolean;
  /** Human-readable one-liner naming why. */
  reason: string;
};

/**
 * Minimum absolute 52x count for a bucket to be RED.
 *
 * Suppresses 2026-09-01 13:15 (2 x 52x in 48 requests), the only healthy bucket
 * in the retention window with a non-zero 52x ratio that is not itself an
 * outage. Every measured wedge bucket carries at least 5.
 */
export const RED_MIN_52X = 3;

/**
 * Minimum 52x share of a bucket's requests for it to be RED.
 *
 * Sits in an empty gap: measured wedge buckets run 95.8-100%, every non-outage
 * bucket in nine days runs at or below 7.1%.
 */
export const RED_MIN_52X_RATIO = 0.5;

/** Bucket width. Matches the route's fifteen-minute Vercel cron tick. */
export const BUCKET_MS = 15 * 60 * 1000;

/** How many closed buckets the verdict reads. */
export const BUCKET_COUNT = 4;

/** Is this bucket a front-door failure? See the module header for the calibration. */
export function bucketIsRed(b: FrontDoorBucket): boolean {
  if (b.n52x < RED_MIN_52X) return false;
  if (b.requests <= 0) return false;
  return b.n52x / b.requests >= RED_MIN_52X_RATIO;
}

/**
 * Fill gaps and align a Logs API result to exactly `BUCKET_COUNT` closed
 * buckets ending at `endBoundaryMs` (exclusive).
 *
 * A bucket the Logs API did not return had no rows at all, which is zero
 * requests and therefore cannot be RED. That is the right reading: a wedge
 * produces 52x log entries rather than silence (the 08-31 series never dropped
 * below 5 requests in a bucket), so an empty bucket means "nobody asked",
 * not "everybody failed".
 */
export function alignBuckets(
  rows: FrontDoorBucket[],
  endBoundaryMs: number,
): FrontDoorBucket[] {
  const byStart = new Map<number, FrontDoorBucket>();
  for (const r of rows) byStart.set(r.startMs, r);

  const out: FrontDoorBucket[] = [];
  for (let i = BUCKET_COUNT; i >= 1; i--) {
    const startMs = endBoundaryMs - i * BUCKET_MS;
    out.push(byStart.get(startMs) ?? { startMs, requests: 0, n5xx: 0, n52x: 0 });
  }
  return out;
}

/** Floor a timestamp to the 15-minute boundary at or before it. */
export function floorToBucket(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/**
 * Decide the front door's state from four closed buckets plus the direct probe.
 *
 * `buckets` is oldest-first and must be exactly BUCKET_COUNT long (use
 * `alignBuckets`). Index 3 is the newest closed bucket.
 *
 * DOWN when the direct probe got no answer at all, OR the two newest closed
 * buckets are both RED. Requiring two consecutive buckets is what keeps a
 * single 15-minute blip from paging; the probe arm is the fast path that does
 * not wait for them, and three failed attempts against a front door that
 * normally answers in ~100 ms is already a strong signal on its own.
 *
 * RECOVERED on the exact edge where the two newest closed buckets are green and
 * the one before them is RED. Anchoring to that exact position — rather than
 * "any RED in the window" — is what makes RECOVERED fire once without any
 * stored state: one tick later the RED bucket has slid to index 0 and the
 * pattern no longer matches.
 */
export function decideFrontDoorVerdict(
  buckets: FrontDoorBucket[],
  probe: FrontDoorProbe,
): FrontDoorVerdict {
  if (buckets.length !== BUCKET_COUNT) {
    throw new Error(
      `decideFrontDoorVerdict expects ${BUCKET_COUNT} buckets, got ${buckets.length}`,
    );
  }
  const red = buckets.map(bucketIsRed);
  const [, b1, b2, b3] = red as [boolean, boolean, boolean, boolean];

  const logsDown = b3 && b2;
  const isDownEdge = logsDown && !b1;

  if (!probe.answered) {
    return {
      state: "down",
      red,
      isDownEdge: true,
      reason: `direct probe got no answer in ${probe.attempts.length} attempt(s)`,
    };
  }
  if (logsDown) {
    const n = buckets[3]!;
    return {
      state: "down",
      red,
      isDownEdge,
      reason:
        `the two newest closed buckets are both >= ${Math.round(RED_MIN_52X_RATIO * 100)}% Cloudflare 52x ` +
        `(newest: ${n.n52x}/${n.requests})`,
    };
  }
  if (!b3 && !b2 && b1) {
    return {
      state: "recovered",
      red,
      isDownEdge: false,
      reason: "the two newest closed buckets are clean and the one before them was 52x-saturated",
    };
  }
  return { state: "ok", red, isDownEdge: false, reason: "no sustained 52x, front door answering" };
}

/**
 * Should this tick actually send an email?
 *
 * DOWN pages on the transition tick, and thereafter at most once an hour — the
 * fifteen-minute cron means minute < 15 selects exactly the :00 tick. Over the 17-hour
 * 08-31 wedge that is ~17 emails rather than ~68, without any stored state.
 *
 * RECOVERED sends on its edge, which by construction occurs once.
 */
export function shouldSend(verdict: FrontDoorVerdict, nowMs: number): boolean {
  if (verdict.state === "recovered") return true;
  if (verdict.state !== "down") return false;
  if (verdict.isDownEdge) return true;
  return new Date(nowMs).getUTCMinutes() < 15;
}

/**
 * The one thing an alert reader needs that a dashboard will not tell them.
 *
 * Kept next to the decision logic on purpose: the runbook and the threshold
 * that triggers it should not be able to drift apart.
 */
export const FRONT_DOOR_RUNBOOK =
  "The only known remediation is a Supabase project restart " +
  "(dashboard -> Project Settings -> General -> Restart project). " +
  "Postgres underneath is usually HEALTHY during this failure — check " +
  "pg_postmaster_start_time() afterwards to confirm the restart landed, and do " +
  "not go looking for a slow query first. On 2026-08-31 the front door stayed " +
  "wedged about 17 hours after the database had recovered.";

function fmtBucket(b: FrontDoorBucket, red: boolean): string {
  const t = new Date(b.startMs).toISOString().slice(11, 16);
  const pct = b.requests ? ((100 * b.n52x) / b.requests).toFixed(1) : "0.0";
  return `${t}  ${String(b.requests).padStart(6)} req  ${String(b.n5xx).padStart(5)} 5xx  ${String(b.n52x).padStart(5)} 52x  ${pct.padStart(6)}%  ${red ? "RED" : "ok"}`;
}

/** Render the alert email. Plain `<pre>` on purpose — this is read at 3am. */
export function renderFrontDoorEmail(args: {
  verdict: FrontDoorVerdict;
  buckets: FrontDoorBucket[];
  probe: FrontDoorProbe;
  probeUrl: string;
  nowMs: number;
}): { subject: string; html: string } {
  const { verdict, buckets, probe, probeUrl, nowMs } = args;
  const down = verdict.state === "down";
  const subject = down
    ? `[Civitics][FRONT DOOR DOWN] Supabase REST is not answering — ${verdict.reason}`
    : `[Civitics][FRONT DOOR RECOVERED] Supabase REST is answering again`;

  const table = buckets.map((b, i) => fmtBucket(b, verdict.red[i] ?? false)).join("\n");
  const probeLines = probe.attempts
    .map(
      (a, i) =>
        `  attempt ${i + 1}: ${a.status === null ? `NO RESPONSE (${a.error ?? "unknown"})` : `HTTP ${a.status}`} in ${a.ms} ms`,
    )
    .join("\n");

  const html = `<pre style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">
${down ? "FRONT DOOR DOWN" : "FRONT DOOR RECOVERED"} — ${new Date(nowMs).toISOString()}

${verdict.reason}

Last ${BUCKET_COUNT} closed 15-minute buckets (Supabase edge_logs, UTC):
${table}

Direct liveness probe — ${probeUrl}
${probeLines}
  verdict: ${probe.answered ? "front door ANSWERED (any status &lt; 500 counts; 401 is healthy here)" : "front door did NOT answer"}

${down ? FRONT_DOOR_RUNBOOK : "No action needed. This is the all-clear for the alert above it."}

A bucket is RED at >= ${RED_MIN_52X} Cloudflare-class 52x responses AND >= ${Math.round(
    RED_MIN_52X_RATIO * 100,
  )}% of that bucket's requests.
This detector deliberately ignores plain 5xx: on 2026-09-01 the front door served
up to 67.7% 5xx while healthy, from statement timeouts under I/O load.
</pre>`;

  return { subject, html };
}
