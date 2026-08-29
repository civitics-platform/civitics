/**
 * Snapshot freshness thresholds + the dashboard's staleness cue — FIX-1094.
 *
 * WHY THIS IS A UI DERIVATION AND NOT A SELF-TEST
 *
 * "Is the status snapshot stale?" cannot be answered by a self-test, because the
 * self-tests are computed *inside* the snapshot. Any age a test could measure is
 * the age at write time, which is always ~0. The only place the question is
 * answerable is where the payload is read, so the cue lives on the render side
 * and derives purely from the payload's own timestamp — no new endpoint, no
 * extra read.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *
 * SNAPSHOT_STALE_MS lived in _lib/status-snapshot.ts, which imports
 * @civitics/db and the whole section-helper module — server-only code that must
 * not be pulled into the client bundle by DashboardClient. These are plain
 * numbers with no imports, so both sides can share them; status-snapshot.ts
 * re-exports SNAPSHOT_STALE_MS from here so its existing importers are unchanged.
 */

// Tuning history (moved here with the constant):
//   - FIX-297 set 30 min (three 10-min cron cycles).
//   - Prod observation 2026-05-22: GHA */10 cron drifts to 1h-3h35m gaps under
//     scheduler load — 30 min flipped most pageloads to a 30-s live recompute
//     path. Bumped to 4 h (covers 9 of last 10 observed gaps).
//   - FIX-1127 (2026-08-29): back down to 2 h. The 4 h value was never a
//     statement about how stale a snapshot may usefully be — it was pure
//     absorption of GHA's unreliability, and measurement showed GHA was worse
//     than "drift": eight scheduled firings in 51 hours, mean ~6.4 h, shortest
//     gap 3.2 h. That is wholesale skipping, and 4 h was clearing it by luck.
//     The tick now runs on a Vercel cron at */30, which honours its schedule, so
//     the threshold can go back to meaning what it should: ~3 missed ticks plus
//     margin. Re-tune this WITH the cron expression, never independently.
// This is the threshold at which a READER stops trusting the snapshot and
// recomputes; it is deliberately generous because the fallback is expensive.
export const SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;

// The cue's amber point. Deliberately far below SNAPSHOT_STALE_MS: the numbers
// answer different questions. 2 h is "recomputing is now cheaper than serving
// this"; 75 min is "the 30-minute cron has missed more than one tick and you
// should know that before you read the numbers below as current". Between them
// the dashboard is still serving the snapshot — it just stops implying the data
// is live.
//
// FIX-1127 moved this 45 min → 75 min to preserve that semantic at the new
// cadence: 45 min was "four missed 10-min ticks", 75 min is "two missed 30-min
// ticks plus half a cycle of slack", so a single late tick still renders clean.
export const SNAPSHOT_AGING_MS = 75 * 60 * 1000;

export type SnapshotFreshness = {
  level: "fresh" | "aging" | "stale";
  ageMs: number;
  /** Null when fresh — the cue renders nothing at all in that state. */
  label: string | null;
};

/** "1h 12m", "45m", "3d 2h" — coarse by design; this is a cue, not a clock. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/**
 * Classify a snapshot timestamp against `now`.
 *
 * A missing or unparseable timestamp is treated as `stale`, not as `fresh`: the
 * failure mode to avoid is a broken clock reading as a healthy one. A timestamp
 * in the future clamps to age 0 rather than going negative (clock skew between
 * the snapshot writer and the reader is real and is not the user's problem).
 */
export function classifySnapshotAge(
  fetchedAt: string | null | undefined,
  nowMs: number,
): SnapshotFreshness {
  const parsed = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
  if (!Number.isFinite(parsed)) {
    return { level: "stale", ageMs: 0, label: "snapshot age unknown" };
  }
  const ageMs = Math.max(0, nowMs - parsed);
  if (ageMs >= SNAPSHOT_STALE_MS) {
    return {
      level: "stale",
      ageMs,
      label: `snapshot ${formatAge(ageMs)} old — the 30-min refresh has not landed`,
    };
  }
  if (ageMs >= SNAPSHOT_AGING_MS) {
    return { level: "aging", ageMs, label: `snapshot ${formatAge(ageMs)} old` };
  }
  return { level: "fresh", ageMs, label: null };
}
