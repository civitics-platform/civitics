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
 * BOTH ARE REPORT-ONLY. Neither loses a night: every dispatched workflow keeps
 * its `schedule:` trigger as the fallback, so a dead dispatcher degrades to
 * GitHub's own late start, which is where the platform was before FIX-1218. It
 * wants a look, not a page.
 *
 * Pure: the PostgREST read lives in canary-check.ts.
 */

export const KEY_DISPATCH_REFUSED = "gha_dispatch_refused";
export const KEY_DISPATCH_STALE = "gha_dispatch_stale";

/**
 * Stale thresholds per stem, in hours: the cadence plus slack for one missed
 * firing. nightly and sync-canary-check fire daily (25 h = one day plus an
 * hour); platform-snapshot fires every 10 minutes (30 min = two missed
 * firings — one alone is Vercel's documented best-effort delivery).
 */
export const DISPATCH_STALE_HOURS: Readonly<Record<string, number>> = {
  nightly: 25,
  "sync-canary-check": 25,
  "platform-snapshot": 0.5,
};

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
 * database, which after the deploy means it has never been called.
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
      stale: age === null || age > limit,
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
