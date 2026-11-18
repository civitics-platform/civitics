/**
 * FIX-1218 — is the GHA dispatcher alive, and is its token still good?
 *
 * /api/cron/gha-dispatch/<stem> stamps pipeline_state.gha_dispatch_<stem> on
 * EVERY call (rule 167). Two ways it goes wrong, and they get one key each so
 * the FIX-1036 transition classifier never reads one recovering as the other:
 *
 *   gha_dispatch_refused — the LAST call was not `dispatched`. Almost always
 *     the fine-grained PAT expiring (a 401 one year after it was minted), a
 *     revoked token (401/403), or GITHUB_DISPATCH_TOKEN missing from the
 *     deployment. The route keeps being called; GitHub keeps saying no.
 *   gha_dispatch_stale — the stamp is older than its cadence allows (or absent
 *     entirely): the Vercel cron is not calling the route at all — the cron was
 *     removed, disabled, or the deployment is down.
 *
 * BOTH ARE REPORT-ONLY. Neither loses a night: the nightly, sync-canary-check and
 * platform-snapshot keep their `schedule:` trigger as the fallback, so a dead
 * dispatcher degrades to GitHub's own late start, which is where the platform
 * was before FIX-1218. It wants a look, not a page. irs990, audit and
 * crs-summaries (FIX-1424, cc-292) carry no fallback: a dead dispatcher skips
 * their week, which the weekly stamp's 169 h says inside a day.
 *
 * Pure: the PostgREST read lives in canary-check.ts.
 */

export const KEY_DISPATCH_REFUSED = "gha_dispatch_refused";
export const KEY_DISPATCH_STALE = "gha_dispatch_stale";

/**
 * Stale thresholds per stem, in hours: the cadence plus slack for one missed
 * firing. nightly and sync-canary-check fire daily (25 h = one day plus an
 * hour); platform-snapshot fires every 10 minutes (30 min = two missed
 * firings — one alone is Vercel's documented best-effort delivery); irs990,
 * audit and crs-summaries fire weekly (169 h = a week plus an hour).
 */
export const DISPATCH_STALE_HOURS: Readonly<Record<string, number>> = {
  nightly: 25,
  "sync-canary-check": 25,
  "platform-snapshot": 0.5,
  irs990: 169,
  audit: 169,
  "crs-summaries": 169,
};

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

/** An absent stamp before its stem's first slot (+ grace) is a stem not yet due, not a dead route. */
function notYetDue(stem: string, now: Date): boolean {
  const first = DISPATCH_FIRST_SLOT[stem];
  if (first === undefined) return false;
  const t = Date.parse(first);
  return !Number.isNaN(t) && now.getTime() < t + FIRST_SLOT_GRACE_MS;
}

/** The pipeline_state key for a stem. */
export function dispatchStampKey(stem: string): string {
  return `gha_dispatch_${stem}`;
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
}

export interface DispatchCondition {
  tier: "report" | null;
  /** How many stems are in this state — monotone-worse as more join. */
  severity: number;
  detail: string;
}

export interface GhaDispatchCanary {
  stamps: DispatchStampReading[];
  refused: DispatchCondition;
  stale: DispatchCondition;
}

function hoursBetween(at: string | null, now: Date): number | null {
  if (at === null) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : Math.round(((now.getTime() - t) / 3_600_000) * 100) / 100;
}

/**
 * `rows` is `{ [pipeline_state.key]: value }` for whichever gha_dispatch_* rows
 * exist. A stem with NO row is stale: the route has never stamped on this
 * database, which after the deploy means it has never been called — unless the
 * stem's first slot (DISPATCH_FIRST_SLOT) has not come yet.
 */
export function classifyGhaDispatch(
  rows: Record<string, Record<string, unknown> | undefined>,
  now: Date,
): GhaDispatchCanary {
  const stamps: DispatchStampReading[] = Object.entries(DISPATCH_STALE_HOURS).map(([stem, limit]) => {
    const v = rows[dispatchStampKey(stem)];
    const at = typeof v?.["at"] === "string" ? (v["at"] as string) : null;
    const status = typeof v?.["status"] === "string" ? (v["status"] as string) : null;
    const age = hoursBetween(at, now);
    return {
      stem,
      at,
      status,
      http_status: typeof v?.["http_status"] === "number" ? (v["http_status"] as number) : null,
      detail: typeof v?.["detail"] === "string" ? (v["detail"] as string) : null,
      last_dispatched_at: typeof v?.["last_dispatched_at"] === "string" ? (v["last_dispatched_at"] as string) : null,
      age_hours: age,
      stale: age === null ? !notYetDue(stem, now) : age > limit,
      refused: status !== null && status !== "dispatched",
    };
  });

  const refused = stamps.filter((s) => s.refused);
  const stale = stamps.filter((s) => s.stale);
  return {
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
        stale.length === 0
          ? "every dispatcher stamp is inside its cadence"
          : "GHA dispatcher not calling: " +
            stale
              .map((s) =>
                s.at === null
                  ? `${s.stem} never stamped`
                  : `${s.stem} last stamped ${s.at} (${s.age_hours} h ago, limit ${DISPATCH_STALE_HOURS[s.stem]} h)`,
              )
              .join("; ") +
            " — check the Vercel crons for /api/cron/gha-dispatch/<stem>",
    },
  };
}
