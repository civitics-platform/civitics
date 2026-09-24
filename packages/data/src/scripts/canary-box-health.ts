/**
 * FIX-1194 P1-B / FIX-1125 — are the two box-health instruments alive?
 *
 * Two stamps, two keys, both REPORT-ONLY:
 *
 *   box_health_probe_stale  pipeline_state.box_health.at older than 10 min. The
 *                           every-minute probe is a pg_cron firing, so a stale stamp at
 *                           canary time means the forker was starved or the job
 *                           is off. Either way, box_is_saturated() is answering
 *                           "stale" for anything that asks.
 *   box_health_mem_stale    pipeline_state.box_health_mem.at older than 10 min.
 *                           The 2-minute Vercel route's ON-box mirror has stopped
 *                           landing. The off-box ring may still be fine, but
 *                           the canary cannot see Upstash (the GHA canary job
 *                           has no Upstash secret), so it reports what it CAN
 *                           see and says so.
 *
 * WHY 10 MINUTES FOR BOTH. For the 2-minute route, ten minutes is five missed
 * firings, the smallest unambiguous window, and the same reasoning as
 * VERCEL_LIVENESS_STALE_MIN. For the every-minute probe, box_is_saturated() already
 * calls three missed firings stale. The canary runs once a day, and a stamp
 * that is stale at that single moment is a finding. Ten keeps it from
 * reporting on a firing that is merely late.
 *
 * WHY REPORT, NOT ESCALATE. Neither is a THRESHOLD this build (the design:
 * "probe first, gates second"; rule 97: a week of data sizes a threshold).
 * These keys say an INSTRUMENT is dark, which wants a human to look and not a
 * page. The saturation the probe measures already escalates through FIX-1073's
 * tiers.
 *
 * One key per stamp, not one shared key: the two go dark for different reasons
 * (pg_cron vs Vercel), and the FIX-1036 transition classifier would read one
 * recovering as the other recovering.
 *
 * Pure functions over plain data, like canary-prod-session.ts and
 * canary-fec-drop.ts, so this is meaningful in CI, which has no Postgres.
 */

export const KEY_PROBE_STALE = "box_health_probe_stale";
export const KEY_MEM_STALE = "box_health_mem_stale";

export const BOX_HEALTH_CANARY_STALE_MIN = 10;

export type StampStatus = {
  key: typeof KEY_PROBE_STALE | typeof KEY_MEM_STALE;
  /** null = recorded, not a finding this run. */
  tier: "report" | null;
  /** Monotone-worse for the transition classifier: the age in minutes. */
  severity: number;
  ageMinutes: number | null;
  at: string | null;
  detail: string;
};

export type BoxHealthCanary = { probe: StampStatus; mem: StampStatus };

function one(
  key: StampStatus["key"],
  what: string,
  value: Record<string, unknown> | null | undefined,
  now: Date,
): StampStatus {
  const at = typeof value?.["at"] === "string" ? (value["at"] as string) : null;
  const t = at === null ? NaN : Date.parse(at);
  if (Number.isNaN(t)) {
    return {
      key, tier: "report", severity: 1_000_000, ageMinutes: null, at,
      detail: `${what}: no stamp (pipeline_state row absent or has no parseable \`at\`)`,
    };
  }
  const ageMinutes = Math.round((now.getTime() - t) / 6000) / 10;
  const stale = ageMinutes > BOX_HEALTH_CANARY_STALE_MIN;
  return {
    key,
    tier: stale ? "report" : null,
    severity: stale ? ageMinutes : 0,
    ageMinutes,
    at,
    detail: stale
      ? `${what} is STALE: last stamp ${at} (${ageMinutes} min ago, threshold ${BOX_HEALTH_CANARY_STALE_MIN} min)`
      : `${what} fresh: ${at} (${ageMinutes} min ago)`,
  };
}

/**
 * @param rows pipeline_state values keyed by `key`, or null when the read failed.
 *             A failed read is reported as nothing rather than as health, the
 *             same contract every other detector keeps.
 */
export function classifyBoxHealth(
  rows: Record<string, Record<string, unknown> | undefined> | null,
  now: Date,
): BoxHealthCanary | null {
  if (rows === null) return null;
  return {
    probe: one(KEY_PROBE_STALE, "box_health probe (every-minute pg_cron)", rows["box_health"], now),
    mem: one(KEY_MEM_STALE, "box_health_mem stamp (2-minute Vercel route, on-box mirror)", rows["box_health_mem"], now),
  };
}
