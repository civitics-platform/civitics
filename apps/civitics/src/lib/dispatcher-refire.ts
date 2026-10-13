/**
 * FIX-1308 — should the box-health route re-fire the dispatcher tick?
 *
 * The tick is a pg_cron job on odd minutes ('1-59/2'), so a healthy
 * dispatch_log has a row at most ~2 minutes old. pg_cron can drop firings
 * (job startup timeouts — the forker condition, D1), and a dispatcher that is
 * silently not ticking is a dispatcher whose deadlines slip. The 2-minute
 * Vercel box-health route needs no pg_cron worker, so it is the second path: when
 * the newest row is more than 360 s old (three missed odd-minute ticks), it
 * calls dispatch_one_unit('vercel') once. That call does everything a tick
 * does — reads the box and the pause dial itself — so the route decides only
 * WHETHER to call, never what the call should do.
 *
 * Pure: the route passes the newest ticked_at it read (or the read's error),
 * and this answers. Every branch is tested in dispatcher-refire.test.ts.
 */

export const DISPATCHER_STALE_SECONDS = 360;

export type DispatchLogRead = {
  /** The newest dispatch_log.ticked_at, or null when the table has no rows. */
  lastTickAt: string | null;
  /** The read's error, when it failed. */
  error?: { code?: string | null; message?: string | null } | null;
};

export type RefireVerdict = {
  refire: boolean;
  reason: string;
  /** Seconds since the newest row, when there is one. */
  ageSeconds: number | null;
  /** True when the failure is the table being absent — expected before the Pro push, never logged as an error. */
  notLanded: boolean;
};

/**
 * PostgREST answers a read of a table that does not exist with PGRST205 (or
 * PGRST200-family / 404 on older versions); Postgres itself says 42P01. Any of
 * them means "the migration is not on this database yet".
 */
export function isTableAbsent(error: DispatchLogRead["error"]): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "PGRST116" || code === "404") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

export function shouldRefireDispatcher({
  read,
  now,
  staleSeconds = DISPATCHER_STALE_SECONDS,
}: {
  read: DispatchLogRead;
  now: Date;
  staleSeconds?: number;
}): RefireVerdict {
  if (read.error) {
    if (isTableAbsent(read.error)) {
      return { refire: false, reason: "dispatch_log absent — not landed", ageSeconds: null, notLanded: true };
    }
    return {
      refire: false,
      reason: `dispatch_log read failed: ${read.error.message ?? read.error.code ?? "unknown"}`,
      ageSeconds: null,
      notLanded: false,
    };
  }
  if (read.lastTickAt === null) {
    return { refire: false, reason: "no dispatch_log rows — not landed", ageSeconds: null, notLanded: true };
  }
  const t = Date.parse(read.lastTickAt);
  if (Number.isNaN(t)) {
    return { refire: false, reason: `unparseable ticked_at: ${read.lastTickAt}`, ageSeconds: null, notLanded: false };
  }
  // Whole seconds, floored: a row 360.9 s old is 360 s old, which is NOT stale.
  const ageSeconds = Math.floor((now.getTime() - t) / 1000);
  if (ageSeconds <= staleSeconds) {
    return { refire: false, reason: `last tick ${ageSeconds} s ago`, ageSeconds, notLanded: false };
  }
  return {
    refire: true,
    reason: `last tick ${ageSeconds} s ago > ${staleSeconds} s — re-firing`,
    ageSeconds,
    notLanded: false,
  };
}
