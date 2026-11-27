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
 * (then `analytics/endpoints/logs.all`, removed 2026-09-23; since FIX-1219 the
 * same `edge_logs` buckets come from `logs` through supabase-logs.ts, which
 * reproduced cc-151's buckets exactly), that distinction is the whole ballgame:
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
 * them. That is why the wedge rule reads one number. (The 503 arm below reads
 * a second, and only pages.)
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
 * ── THE 503 ARM (FIX-1446) ────────────────────────────────────────────────────
 *
 * On 2026-11-23 the front door served 5xx on 74% of requests at 00:00Z and
 * 99.1% at 01:00Z (192 x 503 of 216) with 0 x 52x. Every tick read `ok` and
 * nothing paged: Craig found the site down at 01:53Z and restarted it at
 * 02:03Z. A 503 is PostgREST answering and saying it cannot reach Postgres —
 * that day, the disk IO budget spent in the pass after a landing. A statement
 * timeout answers 500 or 504, never 503: 09-01's afternoon (up to 67.7% 5xx
 * with the front door up) was 583 x 500 and 112 x 504, plus one 520 and one
 * 525 — not one 503.
 *
 * A bucket is 503-RED when `n_503 >= 10 AND n_503 / requests >= 0.5`. The
 * state is DB_UNREACHABLE when the two newest closed buckets are both 503-RED,
 * the shape DOWN uses, and it sits below DOWN: a wedge outranks it. Calibrated
 * on every bucket the Logs API held on 2026-11-27, 11-20 05:15Z -> 11-27 05:00Z
 * (671 buckets: two landings, the 11-23 restart, four days of crawl):
 *
 *   661 buckets outside 11-22 23:45Z -> 11-23 02:15Z
 *     n_503   p50 0   p90 0   p99 0   max 0    — every one is exactly 0
 *     n_5xx   p50 0   p90 2   p99 5   max 9    — all 459 of them plain 500
 *   the outage: 00:45Z 30 of 65 (46.2%), 01:00Z 192 of 216 (88.9%),
 *               01:15Z 120 of 152 (78.9%); no other bucket in it has a 503
 *
 * The gap is emptier than the 52x rule's: nothing outside the outage carries a
 * single 503. Replayed, 11-23 reads DB_UNREACHABLE at the 01:30Z tick only
 * (the 01:30Z bucket was clean, 2 x 500 of 295) and DB_REACHABLE at 02:00Z:
 * a page about 22 minutes before Craig found the site down, and an all-clear
 * three before his restart, with 01:45Z at 62% 5xx of 500 and 504. The week
 * reads it nowhere else. It is slower than hoped: 00:00-00:15Z were 500 / 504
 * (statement timeouts, which this arm must not page on) and 00:45Z sat at 46%,
 * under the ratio.
 *
 * IT PAGES AND NEVER RESTARTS (Craig, 2026-11-23). front-door-restart.ts counts
 * only the wedge rule's DOWN; a DB_UNREACHABLE tick is any other tick there,
 * and clears the hold. A restart on this state is the owner's, by hand.
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
 * (Since FIX-1125 there IS an off-box store — the Upstash memory ring's — and
 * FIX-1285's restart decision keeps its hold there. This verdict still needs
 * none.)
 */

import { isLogsEndpointGone } from "./supabase-logs";

/** One 15-minute slice of `edge_logs`, as returned by the Logs API. */
export type FrontDoorBucket = {
  /** Bucket start, ms since epoch, aligned to a 15-minute boundary. */
  startMs: number;
  requests: number;
  n5xx: number;
  n52x: number;
  /**
   * FIX-1446: 503, PostgREST answering but unable to reach Postgres. Absent
   * reads as 0, so a caller that omits it gets the pre-FIX-1446 verdicts.
   */
  n503?: number;
};

/** Result of the direct, Postgres-independent liveness probe. */
export type FrontDoorProbe = {
  /** True when at least one attempt got an HTTP response with status < 500. */
  answered: boolean;
  /** Per-attempt outcome, for the alert body. `status: null` = transport error. */
  attempts: Array<{ status: number | null; ms: number; error?: string }>;
};

/**
 * FIX-1219 — what the Logs corroborator returned. `ok` carries the rows;
 * `unavailable` is the instrument GONE (410, or 404 on the same path — how
 * `logs.all` answered after Supabase removed it, changelog 48235 — or a 200
 * naming a table or field that no longer exists, how a schema removal
 * answers); `dark` is any other failure to answer. Before
 * this, the route turned every failure into zero buckets and the verdict read
 * `ok` — from 2026-09-24 10:15 UTC on, every firing reported a healthy front
 * door while seeing nothing.
 */
export type FrontDoorCorroborator =
  | { kind: "ok"; buckets: number }
  /** `detail` is the helper's: for a 200 it names the table or field that no
   *  longer exists (isLogsSchemaRemoval, cc-156). */
  | { kind: "unavailable"; status: number; detail?: string }
  | { kind: "dark"; detail: string };

/** 410 Gone, and 404 on the same path. Defined once, in supabase-logs.ts. */
export { isLogsEndpointGone };

/** The `logs_api` field of the route's body and its data_sync_log row. */
export function corroboratorLabel(c: FrontDoorCorroborator): string {
  if (c.kind === "ok") return `${c.buckets} bucket(s)`;
  if (c.kind === "unavailable") {
    // A removed path reads by its status, as it always has; a removed table or
    // field reads by what is missing — "200" alone would say nothing.
    return c.detail && !isLogsEndpointGone(c.status)
      ? `unavailable (${c.detail}, FIX-1219)`
      : `unavailable (${c.status}, FIX-1219)`;
  }
  return `dark (${c.detail})`;
}

export type FrontDoorVerdict = {
  /**
   * `corroborator_unavailable` (FIX-1219): the direct probe answered, but the
   * Logs corroborator returned nothing, so the 52x wedge rule could not be
   * evaluated. Never `ok`, and never paged: shouldSend() never sends it, and
   * a probe that gets no answer is still `down` whatever the corroborator did.
   *
   * `db_unreachable` / `db_reachable` (FIX-1446): the 503 arm's page and its
   * all-clear. Both page; neither is `down`, so neither moves the restart.
   */
  state: "ok" | "down" | "recovered" | "corroborator_unavailable" | "db_unreachable" | "db_reachable";
  /** Per-bucket RED (52x) evaluation, oldest first, aligned with the input. */
  red: boolean[];
  /**
   * True when this tick is the edge of the paging state it reports: DOWN's
   * (newest two RED, the one before green), or DB_UNREACHABLE's (newest two
   * 503-RED, the one before not).
   */
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

/**
 * Minimum absolute 503 count for a bucket to be 503-RED (FIX-1446).
 *
 * The 661 buckets retained on 2026-11-27 outside the 11-23 outage carry no 503
 * at all (p50/p90/p99/max 0); its two 503-RED buckets carry 192 and 120. Ten
 * keeps a near-empty bucket — 08-31's wedge held buckets of five requests —
 * from turning one stray 503 into a page.
 */
export const RED_MIN_503 = 10;

/**
 * Minimum 503 share of a bucket's requests for it to be 503-RED (FIX-1446).
 *
 * 11-23's 503-RED buckets ran 88.9% and 78.9%; its 00:45Z bucket ran 46.2% and
 * is not RED. Every other retained bucket ran 0%.
 */
export const RED_MIN_503_RATIO = 0.5;

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

/** Is PostgREST failing to reach Postgres in this bucket? See "THE 503 ARM" in the module header. */
export function bucketIs503Red(b: FrontDoorBucket): boolean {
  const n503 = b.n503 ?? 0;
  if (n503 < RED_MIN_503) return false;
  if (b.requests <= 0) return false;
  return n503 / b.requests >= RED_MIN_503_RATIO;
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
    out.push(byStart.get(startMs) ?? { startMs, requests: 0, n5xx: 0, n52x: 0, n503: 0 });
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
 *
 * CORROBORATOR_UNAVAILABLE (FIX-1219) when the probe answered and
 * `corroborator` says the Logs API returned nothing (unavailable or dark). The
 * buckets are then zero-filled, so "no RED" means nothing, and `ok` would be a
 * claim this tick cannot make. Omitting `corroborator` is the pre-FIX-1219
 * call, and its verdicts are unchanged.
 *
 * DB_UNREACHABLE (FIX-1446) when the two newest closed buckets are both
 * 503-RED, and DB_REACHABLE on its exact edge — the two newest not 503-RED,
 * the one before them 503-RED — anchored as RECOVERED is. Precedence, in order:
 * the probe with no answer (DOWN), the corroborator blind, the wedge rule's
 * DOWN, DB_UNREACHABLE, RECOVERED, DB_REACHABLE, OK. So a wedge outranks the
 * 503 arm, and where an all-clear of each would fall on one tick RECOVERED is
 * the one sent. Buckets without `n503` read 0 and get today's verdicts exactly.
 */
export function decideFrontDoorVerdict(
  buckets: FrontDoorBucket[],
  probe: FrontDoorProbe,
  corroborator?: FrontDoorCorroborator,
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
  if (corroborator && corroborator.kind !== "ok") {
    return {
      state: "corroborator_unavailable",
      red,
      isDownEdge: false,
      reason:
        `direct probe answered; the Logs corroborator is ${corroboratorLabel(corroborator)} — ` +
        "the 52x wedge rule could not be evaluated this tick",
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
  const [, u1, u2, u3] = buckets.map(bucketIs503Red) as [boolean, boolean, boolean, boolean];
  if (u3 && u2) {
    const n = buckets[3]!;
    return {
      state: "db_unreachable",
      red,
      isDownEdge: !u1,
      reason:
        `the two newest closed buckets are both >= ${Math.round(RED_MIN_503_RATIO * 100)}% 503 ` +
        `(newest: ${n.n503 ?? 0}/${n.requests})`,
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
  if (!u3 && !u2 && u1) {
    return {
      state: "db_reachable",
      red,
      isDownEdge: false,
      reason: "the two newest closed buckets are clear of 503 and the one before them was 503-saturated",
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
 *
 * DB_UNREACHABLE pages exactly as DOWN does, edge then hourly, and DB_REACHABLE
 * sends once, as RECOVERED does (FIX-1446).
 */
export function shouldSend(verdict: FrontDoorVerdict, nowMs: number): boolean {
  if (verdict.state === "recovered" || verdict.state === "db_reachable") return true;
  if (verdict.state !== "down" && verdict.state !== "db_unreachable") return false;
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

/**
 * FIX-1446 — what the DATABASE UNREACHABLE page says in place of the restart
 * runbook. It names no restart rule because there is none: the restart is the
 * owner's (Craig, 2026-11-23).
 */
export const DB_UNREACHABLE_RUNBOOK =
  "PostgREST is answering but cannot reach Postgres. This is not the 52x wedge " +
  "and the watchdog will not restart the project for it. On 2026-11-23 this was " +
  "the disk IO budget spent in the pass after a landing: look at the dashboard's " +
  "Disk IO % consumed and whether the database answers at all. A restart from " +
  "the dashboard cleared it then; that is the owner's decision.";

/** The DATABASE REACHABLE AGAIN all-clear. It clears the 503 page only. */
const DB_REACHABLE_TEXT =
  "No action needed for the DATABASE UNREACHABLE alert above it: the two newest " +
  "closed buckets are clear of 503. This clears that alert only. Plain 500 / 504 " +
  "(statement timeouts) are not this detector's and are never paged, so read the " +
  "table: on 2026-11-23 this all-clear would have come at 02:00Z with 01:45Z at " +
  "62% 5xx of 500 and 504, three minutes before the restart that ended it.";

function fmtBucket(b: FrontDoorBucket, red: boolean): string {
  const t = new Date(b.startMs).toISOString().slice(11, 16);
  const pct = b.requests ? ((100 * b.n52x) / b.requests).toFixed(1) : "0.0";
  const n503 = b.n503 ?? 0;
  const pct503 = b.requests ? ((100 * n503) / b.requests).toFixed(1) : "0.0";
  const mark = red ? "RED" : bucketIs503Red(b) ? "503-RED" : "ok";
  return `${t}  ${String(b.requests).padStart(6)} req  ${String(b.n5xx).padStart(5)} 5xx  ${String(b.n52x).padStart(5)} 52x ${pct.padStart(6)}%  ${String(n503).padStart(5)} 503 ${pct503.padStart(6)}%  ${mark}`;
}

/** Subject, title and closing paragraph, by state. Every unpaged state reads as RECOVERED, as before FIX-1446. */
function emailHead(verdict: FrontDoorVerdict): { subject: string; title: string; text: string } {
  switch (verdict.state) {
    case "down":
      return {
        subject: `[Civitics][FRONT DOOR DOWN] Supabase REST is not answering — ${verdict.reason}`,
        title: "FRONT DOOR DOWN",
        text: FRONT_DOOR_RUNBOOK,
      };
    case "db_unreachable":
      return {
        subject: `[Civitics][DATABASE UNREACHABLE] the front door is answering 503 — ${verdict.reason}`,
        title: "DATABASE UNREACHABLE",
        text: DB_UNREACHABLE_RUNBOOK,
      };
    case "db_reachable":
      return {
        subject: "[Civitics][DATABASE REACHABLE AGAIN] the front door has stopped answering 503",
        title: "DATABASE REACHABLE AGAIN",
        text: DB_REACHABLE_TEXT,
      };
    default:
      return {
        subject: `[Civitics][FRONT DOOR RECOVERED] Supabase REST is answering again`,
        title: "FRONT DOOR RECOVERED",
        text: "No action needed. This is the all-clear for the alert above it.",
      };
  }
}

/** Render the alert email. Plain `<pre>` on purpose — this is read at 3am. */
export function renderFrontDoorEmail(args: {
  verdict: FrontDoorVerdict;
  buckets: FrontDoorBucket[];
  probe: FrontDoorProbe;
  probeUrl: string;
  nowMs: number;
  /** FIX-1285: the restart decision's one line (front-door-restart.ts `restartLine`). */
  restartLine?: string | null;
}): { subject: string; html: string } {
  const { verdict, buckets, probe, probeUrl, nowMs } = args;
  const { subject, title, text } = emailHead(verdict);
  // FIX-1446: the 503 arm never restarts, so its emails carry no restart line.
  const restartLine =
    verdict.state === "db_unreachable" || verdict.state === "db_reachable" ? null : args.restartLine;

  const table = buckets.map((b, i) => fmtBucket(b, verdict.red[i] ?? false)).join("\n");
  const probeLines = probe.attempts
    .map(
      (a, i) =>
        `  attempt ${i + 1}: ${a.status === null ? `NO RESPONSE (${a.error ?? "unknown"})` : `HTTP ${a.status}`} in ${a.ms} ms`,
    )
    .join("\n");

  const html = `<pre style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">
${title} — ${new Date(nowMs).toISOString()}

${verdict.reason}

Last ${BUCKET_COUNT} closed 15-minute buckets (Supabase edge_logs, UTC):
${table}

Direct liveness probe — ${probeUrl}
${probeLines}
  verdict: ${probe.answered ? "front door ANSWERED (any status &lt; 500 counts; 401 is healthy here)" : "front door did NOT answer"}

${text}
${restartLine ? `\n${restartLine.replace(/</g, "&lt;")}\n` : ""}

A bucket is RED at >= ${RED_MIN_52X} Cloudflare-class 52x responses AND >= ${Math.round(
    RED_MIN_52X_RATIO * 100,
  )}% of that bucket's requests.
It is 503-RED at >= ${RED_MIN_503} x 503 AND >= ${Math.round(RED_MIN_503_RATIO * 100)}%: PostgREST answering
but unable to reach Postgres. That pages and never restarts (FIX-1446).
This detector deliberately ignores plain 5xx: on 2026-09-01 the front door served
up to 67.7% 5xx while healthy, from statement timeouts under I/O load.
</pre>`;

  return { subject, html };
}
