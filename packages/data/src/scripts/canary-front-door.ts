/**
 * FIX-1219 — is the front-door watch seeing anything?
 *
 * /api/cron/front-door-watch (FIX-1130, Vercel cron every 15 min) has two
 * instruments: a direct probe of /rest/v1/ and the Logs API's edge_logs as a
 * corroborator. From 2026-09-24 10:15 UTC the corroborator answered 410 Gone
 * (Supabase removed logs.all), and the route zero-filled its buckets and read
 * `ok` on every firing. It now writes `corroborator_unavailable` instead, and
 * since FIX-1219 moved the watch to the `logs` endpoint (through
 * packages/db/src/supabase-logs.ts) it reads that state only when the
 * corroborator is actually blind — dark (a 5xx, the endpoint's 10/min 429, a
 * 200 carrying an error) or unavailable (the next removal). This key surfaces
 * that state, because nothing else reads the watch's rows: the rollup
 * registry reads only their cadence.
 *
 * REPORT-ONLY. The direct probe still pages on a front door that does not
 * answer, whatever the corroborator did. What a blind corroborator loses is
 * the 52x wedge shape (08-31: the probe answering while Cloudflare 52x
 * saturates the data front door). That wants a look, not a page.
 *
 * Staleness is NOT this key's job. A watch that stopped writing rows is the
 * rollup registry's `rollup:front_door_watch` (cadence 0.25 h). Here, no rows
 * in the window raises nothing.
 *
 * Pure: the PostgREST read lives in canary-check.ts.
 */

export const KEY_FRONT_DOOR_BLIND = "front_door_corroborator_unavailable";

/** The window the classifier reads: four firings of a 15-minute cron. */
export const FRONT_DOOR_WINDOW_MINUTES = 60;

export const BLIND_STATE = "corroborator_unavailable";

export interface FrontDoorWatchRow {
  started_at: string;
  metadata: { state?: unknown; reason?: unknown; logs_api?: unknown } | null;
}

export interface FrontDoorCanary {
  tier: "report" | null;
  /** Constant 1 while blind: the condition is one fact, not a count that should read `worse`. */
  severity: number;
  detail: string;
  /** Firings in the window, and how many were blind. */
  firings: number;
  blind: number;
}

/**
 * `rows` are the front_door_watch data_sync_log rows of the last
 * FRONT_DOOR_WINDOW_MINUTES, newest first. Raises when the NEWEST row is blind:
 * a watch that has since recovered is not reported on an older firing.
 */
export function classifyFrontDoorWatch(rows: readonly FrontDoorWatchRow[]): FrontDoorCanary {
  const firings = rows.length;
  const blindRows = rows.filter((r) => r.metadata?.state === BLIND_STATE);
  const newest = rows[0];
  if (!newest || newest.metadata?.state !== BLIND_STATE) {
    return {
      tier: null,
      severity: 0,
      firings,
      blind: blindRows.length,
      detail: newest
        ? `front-door watch newest firing ${newest.started_at} reads ${String(newest.metadata?.state ?? "(no state)")}`
        : `no front-door watch firing in the last ${FRONT_DOOR_WINDOW_MINUTES} min (staleness is the rollup registry's)`,
    };
  }
  const logsApi = typeof newest.metadata?.logs_api === "string" ? newest.metadata.logs_api : "(no logs_api)";
  return {
    tier: "report",
    severity: 1,
    firings,
    blind: blindRows.length,
    detail:
      `front-door watch corroborator ${logsApi} on ${blindRows.length} of ${firings} firing(s) in the last ` +
      `${FRONT_DOOR_WINDOW_MINUTES} min (newest ${newest.started_at}): the 52x wedge rule is blind; ` +
      "the direct probe still pages — FIX-1219",
  };
}
