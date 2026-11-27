/**
 * FIX-1218 — is the GHA dispatcher alive, and is its token still good?
 *
 * /api/cron/gha-dispatch/<stem> stamps pipeline_state.gha_dispatch_<stem> on
 * EVERY call that reaches GitHub (rule 167). Two ways it goes wrong, and they
 * get one key each so the FIX-1036 transition classifier never reads one
 * recovering as the other:
 *
 *   gha_dispatch_refused — the LAST call was not `dispatched`. Almost always
 *     the fine-grained PAT expiring (a 401 one year after it was minted), a
 *     revoked token (401/403), or GITHUB_DISPATCH_TOKEN missing from the
 *     deployment. The route keeps being called; GitHub keeps saying no.
 *   gha_dispatch_stale — the route is not being called, or not answering: the
 *     Vercel cron was removed, disabled, or the deployment is down.
 *
 * BOTH ARE REPORT-ONLY. The nightly, sync-canary-check and platform-snapshot
 * keep their `schedule:` trigger as the fallback, so a dead dispatcher degrades
 * to GitHub's own late start. irs990, audit (FIX-1424, cc-292) and the two
 * walkers carry none: a dead dispatcher skips their run, which this says inside
 * a day. It wants a look, not a page.
 *
 * FIX-1460 (cc-324) — THE STEMS COME FROM job_registry (every row whose
 * unit_call is `gha-dispatch:<stem>`), and each is judged by its rule's class:
 *
 *   `at <cron>` / `by <cron>` — a SLOT. The stamp's age against the cron's
 *     period plus slack: weekly 169 h, daily 25 h, sub-hourly three periods
 *     (`*\/10` → 0.5 h). An absent stamp is stale once the row is older than
 *     its limit (D3), or after DISPATCH_FIRST_SLOT for the stems it names.
 *   `stale_after …` — a REQUEST-GATED WALKER (crs-summaries, bill-details). It
 *     rests for days on next_due_at, and under a hold a 2-hour unit goes
 *     unarmed for hours, so its stamp's age says nothing. What goes wrong is a
 *     request the route never answers. Stale when the request key says so —
 *     reaped `missed`, or older than REQUEST_ANSWER_MINUTES and unconsumed — or
 *     when dispatch_log has a `missed` row in the last 24 h newer than the
 *     stem's last stamp. That third read is the one a daily canary can
 *     actually see: step 3b reaps `missed` at +20 min and the ARM re-arms in the
 *     same tick, replacing the key, so while the row stays due the key itself
 *     only ever shows a fresh request (cc-324 read 4).
 *   anything else, or a cron this code cannot size — `unjudged (<rule>)` in the
 *     detail, counted in neither condition.
 *
 * A failed or empty registry read classifies on FALLBACK_DISPATCH_STALE_HOURS,
 * the hand list as it stood before, and says so first in the stale detail. A
 * blind canary is worse than a stale list.
 *
 * Pure: the PostgREST reads live in canary-check.ts.
 */

import { parseCronSchedule } from "../lib/cron-next";

export const KEY_DISPATCH_REFUSED = "gha_dispatch_refused";
export const KEY_DISPATCH_STALE = "gha_dispatch_stale";

/** The registry's unit_call prefix for a route-started workflow; canary-check reads `LIKE` this + `%`. */
export const GHA_DISPATCH_UNIT_PREFIX = "gha-dispatch:";
/** The dispatcher's own stem grammar (dispatch_one_unit step 3b). */
const UNIT_CALL_RE = /^gha-dispatch:([a-z0-9-]+)$/;

/**
 * FIX-1460 D5 — the FALLBACK, used only when the registry read fails or returns
 * no row: the hand list as FIX-1218 / FIX-1424 left it, in hours. nightly and
 * sync-canary-check fire daily (25 h = one day plus an hour); platform-snapshot
 * every 10 minutes (30 min = three firings — one alone is Vercel's documented
 * best-effort delivery); irs990, audit and crs-summaries weekly (169 h = a week
 * plus an hour). crs-summaries' 169 h is its old Saturday slot, wrong for the
 * walker it is since cc-318 — which is why the registry, not this, is the truth.
 */
export const FALLBACK_DISPATCH_STALE_HOURS: Readonly<Record<string, number>> = {
  nightly: 25,
  "sync-canary-check": 25,
  "platform-snapshot": 0.5,
  irs990: 169,
  audit: 169,
  "crs-summaries": 169,
};
export const FALLBACK_DETAIL_PREFIX = "registry unread — judged on the fallback list";

/**
 * FIX-1424 (cc-292) — a stem that joined after the route was live has no stamp
 * until its first slot, because nothing calls the route before then. Until that
 * slot plus an hour (Vercel's best-effort delivery) an ABSENT stamp is not
 * stale; from then on it is, like any other stem's. No hand dispatch is needed
 * to quiet it. A stem that has stamped is judged by its age alone.
 */
export const DISPATCH_FIRST_SLOT: Readonly<Record<string, string>> = {
  "crs-summaries": "2026-11-21T10:00:00Z",
  irs990: "2026-11-24T15:00:00Z",
  audit: "2026-11-24T17:00:00Z",
};
const FIRST_SLOT_GRACE_MS = 3_600_000;

/**
 * FIX-1460 D2 — an unconsumed request this old is one the route did not
 * answer: step 3b reaps it `missed` at +20 min (c_gha_fire_lapse); five more
 * cover the tick that would reap it.
 */
export const REQUEST_ANSWER_MINUTES = 25;
/** FIX-1460 — how far back canary-check reads dispatch_log's `missed` rows: one canary interval. */
export const MISSED_LOOKBACK_HOURS = 24;

/** An absent stamp before its stem's first slot (+ grace) is a stem not yet due, not a dead route. */
function notYetDue(stem: string, now: Date): boolean {
  const first = DISPATCH_FIRST_SLOT[stem];
  if (first === undefined) return false;
  const t = Date.parse(first);
  return !Number.isNaN(t) && now.getTime() < t + FIRST_SLOT_GRACE_MS;
}

/** The pipeline_state key for a stem's last route call. */
export function dispatchStampKey(stem: string): string {
  return `gha_dispatch_${stem}`;
}

/** The pipeline_state key the dispatcher's ARM writes for a request-gated stem. */
export function dispatchRequestKey(stem: string): string {
  return `gha_dispatch_request_${stem}`;
}

/** FIX-1460 — a job_registry row, as canary-check reads it. */
export interface DispatchRegistryRow {
  job: string;
  unit_call: string;
  deadline_rule: string | null;
  updated_at: string | null;
}

/** FIX-1460 — a dispatch_log `missed` row, as canary-check reads it. */
export interface MissedRequestRow {
  armed_jobname: string;
  ticked_at: string;
  armed_for: string | null;
}

export type DispatchJudgement =
  | { kind: "slot"; limit_hours: number }
  | { kind: "request" }
  | { kind: "unjudged" };

/**
 * FIX-1460 D2 — a slot cron's stale limit in hours, or null when it is not one
 * of the three shapes this sizes (parsed by cron-next's parseCronSchedule):
 *   weekly     — one minute, one hour, one day-of-week   → 168 h + 1 h
 *   daily      — one minute, one hour, every day         → 24 h + 1 h
 *   sub-hourly — every N minutes (60 % N = 0), every hour → 3 × N minutes
 */
export function slotLimitHours(cron: string): number | null {
  const c = parseCronSchedule(cron);
  if (c === null || c.dom !== null || c.months !== null) return null;
  const oneSlotADay = c.minutes.length === 1 && c.hours.length === 1;
  // parseCronSchedule adds 0 beside a 7, so Sunday is one day either way.
  if (oneSlotADay && c.dow !== null && new Set([...c.dow].map((d) => d % 7)).size === 1) return 7 * 24 + 1;
  if (oneSlotADay && c.dow === null) return 24 + 1;
  if (c.dow === null && c.hours.length === 24 && c.minutes[0] === 0 && c.minutes.length > 1) {
    const step = c.minutes[1]!;
    const even = 60 % step === 0 && c.minutes.length === 60 / step && c.minutes.every((m, i) => m === i * step);
    if (even) return (3 * step) / 60;
  }
  return null;
}

/** FIX-1460 D2 — what a deadline_rule makes of a stem. */
export function judgeRule(rule: string | null): DispatchJudgement {
  const r = (rule ?? "").trim();
  const slot = /^(?:at|by)\s+(.+)$/.exec(r);
  if (slot) {
    const limit = slotLimitHours(slot[1]!);
    return limit === null ? { kind: "unjudged" } : { kind: "slot", limit_hours: limit };
  }
  if (/^stale_after\s+\S/.test(r)) return { kind: "request" };
  return { kind: "unjudged" };
}

/** A `by` / `stale_after` row is armed by the dispatcher, so its Vercel cron is the `-request` poll. */
function vercelPath(stem: string, rule: string | null): string {
  return `/api/cron/gha-dispatch/${stem}${/^(?:by|stale_after)\s/.test((rule ?? "").trim()) ? "-request" : ""}`;
}

interface StemPlan {
  stem: string;
  rule: string | null;
  judged: DispatchJudgement;
  /** D3: the row's updated_at — an absent slot stamp is not stale before it + the limit. */
  since: string | null;
}

function planStems(registry: readonly DispatchRegistryRow[] | null | undefined): { source: "registry" | "fallback"; stems: StemPlan[] } {
  if (!registry || registry.length === 0) {
    return {
      source: "fallback",
      stems: Object.entries(FALLBACK_DISPATCH_STALE_HOURS).map(([stem, limit]) => ({
        stem,
        rule: null,
        judged: { kind: "slot", limit_hours: limit },
        since: null,
      })),
    };
  }
  return {
    source: "registry",
    stems: registry.map((r) => {
      const m = UNIT_CALL_RE.exec(r.unit_call);
      return m
        ? { stem: m[1]!, rule: r.deadline_rule, judged: judgeRule(r.deadline_rule), since: r.updated_at }
        : { stem: r.job, rule: `unit_call ${r.unit_call}`, judged: { kind: "unjudged" as const }, since: r.updated_at };
    }),
  };
}

/**
 * FIX-1460 — what canary-check reads once the registry is in hand: every
 * stem's stamp and request key, and the request keys whose `missed` rows the
 * dispatch_log read fetches (request-judged stems only; none on the fallback).
 */
export function planGhaDispatchReads(registry: readonly DispatchRegistryRow[] | null | undefined): {
  keys: string[];
  missedJobnames: string[];
} {
  const { stems } = planStems(registry);
  return {
    keys: stems.flatMap((s) => [dispatchStampKey(s.stem), dispatchRequestKey(s.stem)]),
    missedJobnames: stems.filter((s) => s.judged.kind === "request").map((s) => dispatchRequestKey(s.stem)),
  };
}

/** The request key's fields the canary reads; the ARM writes all of them, consume and 3b merge theirs. */
export interface DispatchRequestReading {
  requested_at: string | null;
  consumed_at: string | null;
  outcome: string | null;
  reaped_at: string | null;
  reap: string | null;
}

export interface DispatchStampReading {
  stem: string;
  at: string | null;
  status: string | null;
  http_status: number | null;
  detail: string | null;
  last_dispatched_at: string | null;
  age_hours: number | null;
  stale: boolean;
  refused: boolean;
  /** FIX-1460 — the registry's deadline_rule; null on the fallback. */
  rule: string | null;
  judged: DispatchJudgement["kind"];
  /** The slot limit; null for a request-judged or unjudged stem. */
  limit_hours: number | null;
  /** The request key, for a request-judged stem; null when it has none. */
  request: DispatchRequestReading | null;
  /** Which condition made it stale, with its instant. */
  stale_why: string | null;
}

export interface DispatchCondition {
  tier: "report" | null;
  /** How many stems are in this state — monotone-worse as more join. */
  severity: number;
  detail: string;
}

export interface GhaDispatchCanary {
  /** FIX-1460 D5 — where the stems came from. */
  source: "registry" | "fallback";
  stamps: DispatchStampReading[];
  refused: DispatchCondition;
  stale: DispatchCondition;
}

function hoursBetween(at: string | null, now: Date): number | null {
  if (at === null) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : Math.round(((now.getTime() - t) / 3_600_000) * 100) / 100;
}

const str = (v: Record<string, unknown> | undefined, k: string): string | null =>
  typeof v?.[k] === "string" ? (v[k] as string) : null;

/** FIX-1460 D2 — a request-gated stem: why it is stale, or null. */
function requestStaleWhy(
  req: DispatchRequestReading | null,
  stampAt: string | null,
  missed: readonly MissedRequestRow[],
  now: Date,
): string | null {
  if (req?.reaped_at && /^missed\b/.test(req.reap ?? "")) {
    return `request ${req.requested_at} reaped missed at ${req.reaped_at}`;
  }
  const reqT = Date.parse(req?.requested_at ?? "");
  if (req && !req.consumed_at && !req.reaped_at && !Number.isNaN(reqT)) {
    const minutes = Math.floor((now.getTime() - reqT) / 60_000);
    if (minutes > REQUEST_ANSWER_MINUTES) return `request ${req.requested_at} unconsumed for ${minutes} min`;
  }
  // dispatch_log: a miss the route has not answered since (no stamp after it).
  const stampT = Date.parse(stampAt ?? "");
  const since = now.getTime() - MISSED_LOOKBACK_HOURS * 3_600_000;
  const unanswered = missed
    .filter((m) => {
      const t = Date.parse(m.ticked_at);
      return !Number.isNaN(t) && t >= since && t <= now.getTime() && (Number.isNaN(stampT) || t > stampT);
    })
    .sort((a, b) => Date.parse(b.ticked_at) - Date.parse(a.ticked_at));
  if (unanswered.length > 0) {
    const m = unanswered[0]!;
    return (
      `request ${m.armed_for ?? "?"} reaped missed at ${m.ticked_at}` +
      ` (${unanswered.length} missed in ${MISSED_LOOKBACK_HOURS} h, dispatch_log; no route answer since, last stamp ${stampAt ?? "never"})`
    );
  }
  return null;
}

/**
 * `rows` is `{ [pipeline_state.key]: value }` for whichever gha_dispatch_<stem>
 * and gha_dispatch_request_<stem> rows exist. `registry` is the job_registry
 * read — `null` / absent / empty when it failed or found nothing, which
 * classifies on the fallback list. `missed` is the dispatch_log read of the
 * request-judged stems' `missed` rows; `null` when it failed or was not made.
 */
export function classifyGhaDispatch(
  rows: Record<string, Record<string, unknown> | undefined>,
  now: Date,
  registry?: readonly DispatchRegistryRow[] | null,
  missed?: readonly MissedRequestRow[] | null,
): GhaDispatchCanary {
  const { source, stems } = planStems(registry);
  const stamps: DispatchStampReading[] = stems.map(({ stem, rule, judged, since }) => {
    const v = rows[dispatchStampKey(stem)];
    const at = str(v, "at");
    const status = str(v, "status");
    const age = hoursBetween(at, now);
    const limit = judged.kind === "slot" ? judged.limit_hours : null;
    let request: DispatchRequestReading | null = null;
    let staleWhy: string | null = null;
    if (judged.kind === "slot") {
      const sinceT = Date.parse(since ?? "");
      const rowNew = !Number.isNaN(sinceT) && now.getTime() < sinceT + judged.limit_hours * 3_600_000;
      const stale = age === null ? !notYetDue(stem, now) && !rowNew : age > judged.limit_hours;
      if (stale) staleWhy = at === null ? "never stamped" : `last stamped ${at} (${age} h ago, limit ${judged.limit_hours} h)`;
    } else if (judged.kind === "request") {
      const q = rows[dispatchRequestKey(stem)];
      request = q
        ? {
            requested_at: str(q, "requested_at"),
            consumed_at: str(q, "consumed_at"),
            outcome: str(q, "outcome"),
            reaped_at: str(q, "reaped_at"),
            reap: str(q, "reap"),
          }
        : null;
      const mine = (missed ?? []).filter((m) => m.armed_jobname === dispatchRequestKey(stem));
      staleWhy = requestStaleWhy(request, at, mine, now);
    }
    return {
      stem,
      at,
      status,
      http_status: typeof v?.["http_status"] === "number" ? (v["http_status"] as number) : null,
      detail: str(v, "detail"),
      last_dispatched_at: str(v, "last_dispatched_at"),
      age_hours: age,
      stale: staleWhy !== null,
      // D4: unchanged — the last stamp's status, for every judged stem.
      refused: judged.kind !== "unjudged" && status !== null && status !== "dispatched",
      rule,
      judged: judged.kind,
      limit_hours: limit,
      request,
      stale_why: staleWhy,
    };
  });

  const refused = stamps.filter((s) => s.refused);
  const stale = stamps.filter((s) => s.stale);
  const unjudged = stamps.filter((s) => s.judged === "unjudged");
  const lead = source === "fallback" ? `${FALLBACK_DETAIL_PREFIX}; ` : "";
  const tail = unjudged.length === 0 ? "" : `; unjudged: ${unjudged.map((s) => `${s.stem} (${s.rule ?? "no rule"})`).join(", ")}`;
  const hint =
    source === "fallback"
      ? "/api/cron/gha-dispatch/<stem>"
      : stale.map((s) => vercelPath(s.stem, s.rule)).join(", ");
  return {
    source,
    stamps,
    refused: {
      tier: refused.length > 0 ? "report" : null,
      severity: refused.length,
      detail:
        refused.length === 0
          ? "every dispatcher stamp reads dispatched"
          : "GHA dispatcher refused: " +
            refused
              .map(
                (s) =>
                  `${s.stem} ${s.status} http=${s.http_status ?? "none"} "${s.detail ?? ""}" at ${s.at}` +
                  ` (last good dispatch ${s.last_dispatched_at ?? "never"})`,
              )
              .join("; ") +
            " — the schedule: fallback is running these workflows late until the token is fixed",
    },
    stale: {
      tier: stale.length > 0 ? "report" : null,
      severity: stale.length,
      detail:
        lead +
        (stale.length === 0
          ? "every dispatcher stamp is inside its cadence"
          : "GHA dispatcher not calling: " +
            stale.map((s) => `${s.stem} ${s.stale_why}`).join("; ") +
            ` — check the Vercel crons for ${hint}`) +
        tail,
    },
  };
}
