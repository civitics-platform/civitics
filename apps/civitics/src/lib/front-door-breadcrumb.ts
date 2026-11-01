// FIX-1348 (option b) — the front-door-watch breadcrumb says what a wedge swallowed.
//
// The route's data_sync_log INSERT is best-effort and runs after the alert, so
// a tick that cannot reach Postgres leaves no row. On 2026-10-25 that was the
// whole outage: rows at 11:15:28, then nothing until 13:45:28 — nine ticks, the
// seven DOWN ones among them — and the off-box store was dark too (Upstash at
// its request cap), so no record of those ticks existed anywhere.
//
// Option (b): accept the gap, and have the first tick that CAN write say so.
// Before its INSERT, each tick reads the newest front_door_watch row's
// started_at (one SELECT on idx_data_sync_log_pipeline). If more than one tick
// is missing since, the row carries
//
//   backfill: { missed_ticks, from, to, buckets, state, reason, mode, state_store }
//
// `from`/`to` bound the gap (the newest row before this tick, and this tick);
// `buckets` are the four closed 15-minute buckets this tick ALREADY holds —
// the 10-25 13:45 row's held 12:45, 13:00 and 13:15 RED — so a gap longer than
// an hour is covered only for its last hour. No new Upstash read: Upstash is
// the thing that was dark. The rest is this tick's verdict and restart state.
// `backfill` is null on a tick with no gap, and always present, so a reader
// never branches on absence. A failed read is `{ error }`, and the INSERT is
// still attempted: the read is best-effort exactly as the INSERT is.
//
// Option (a) — an off-box breadcrumb outside the Upstash request cap — stays
// filed, not built.

/** The cron's period: every 15 minutes (apps/civitics/vercel.json). */
export const TICK_MS = 15 * 60_000;
/** A tick up to this late is late, not missing. */
export const GRACE_MS = 2 * 60_000;

/** One closed bucket as the route's body and row already carry it. */
export interface BreadcrumbBucket {
  at: string;
  requests: number;
  n_5xx: number;
  n_52x: number;
  red: boolean;
}

/** What this tick knows, carried onto a backfill. */
export interface BackfillCarry {
  buckets: BreadcrumbBucket[];
  state: string;
  reason: string;
  mode: string;
  state_store: string;
}

export type Backfill =
  | ({ missed_ticks: number; from: string; to: string } & BackfillCarry)
  | { error: string }
  | null;

/**
 * The gap between the newest row and this tick, in missed ticks. Ticks land
 * at :x0:28 give or take a second, so the gap is rounded to whole periods.
 * Null when there is no newest row, or nothing is missing.
 */
export function decideBackfill(
  newestStartedAtMs: number | null,
  nowMs: number,
  carry: BackfillCarry,
): Backfill {
  if (newestStartedAtMs === null || !Number.isFinite(newestStartedAtMs)) return null;
  const gap = nowMs - newestStartedAtMs;
  if (gap <= TICK_MS + GRACE_MS) return null;
  const missed = Math.round(gap / TICK_MS) - 1;
  if (missed < 1) return null;
  return {
    missed_ticks: missed,
    from: new Date(newestStartedAtMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    ...carry,
  };
}

export interface BreadcrumbIo {
  /** started_at of the newest front_door_watch row, or null when there is none. Throws on failure. */
  newestStartedAt: () => Promise<string | null>;
  /** The data_sync_log INSERT. */
  insert: (metadata: Record<string, unknown>) => Promise<void>;
}

/**
 * Read the newest row, decide the backfill, then INSERT this tick's row with
 * `backfill` set. The read runs first — after the INSERT the newest row is this
 * one. A read failure becomes `{ error }` and never stops the INSERT.
 */
export async function landBreadcrumb(
  io: BreadcrumbIo,
  nowMs: number,
  metadata: Record<string, unknown>,
  carry: BackfillCarry,
): Promise<Backfill> {
  let backfill: Backfill;
  try {
    const newest = await io.newestStartedAt();
    backfill = decideBackfill(newest === null ? null : Date.parse(newest), nowMs, carry);
  } catch (err) {
    backfill = { error: err instanceof Error ? err.message : String(err) };
  }
  await io.insert({ ...metadata, backfill });
  return backfill;
}
