/**
 * FIX-950 — "is a human holding the box, and has the hold gone wrong?"
 *
 * THE THING THIS IS NOT. A held prod session is NORMAL. It is the mechanism
 * working, and tiering it would page on every supervised landing — the FIX-943
 * cause-vs-consequence rule, and the same reason FIX-1166 gives `collected` and
 * `pending-within-window` no tier. So `held` carries NO tier. It is recorded on
 * every run and shown as a tile, because the trail is what makes "why did
 * nothing run on Tuesday night" answerable after the fact, and because an
 * operator looking at a quiet dashboard deserves to know the quiet is deliberate.
 *
 * WHAT DOES REPORT, and why exactly these two:
 *
 *   prod_session_overrun      The hold has outlived twice its own estimate.
 *                             Not an error — landings run long — but the two
 *                             ways a hold goes wrong both look like this from
 *                             outside: someone walked away from a claim, or a
 *                             landing is stuck. Both want a human to look, and
 *                             neither wants a page. `report`.
 *   prod_session_label_stale  A pipeline_state.prod_session row with no lock
 *                             behind it: a dead session. It defers NOTHING (the
 *                             lock is the truth, and prod_session_state() says
 *                             so), and the next claim overwrites it, so the only
 *                             harm is a dashboard that lies about who is on the
 *                             box. `report`, and it self-heals.
 *
 * The threshold is DERIVED FROM THE CLAIM, not configured here: the claimer
 * gave `expected_minutes`, and 2x their own number is the only threshold that
 * means the same thing for a 5-minute migration push and a 3-hour FEC replay.
 * A claim with no estimate falls back to DEFAULT_EXPECTED_MINUTES, which is the
 * same constant session:claim-prod defaults to.
 *
 * Pure functions over plain data — no DB, no network — so this is meaningful in
 * CI, which has no Postgres. Mirrors canary-fec-drop.ts and canary-transitions.ts.
 */

import { DEFAULT_EXPECTED_MINUTES, type ProdSessionState } from "../lib/prod-session";

export type ProdSessionCondition = "clear" | "held" | "overrun" | "label-stale";

export type ProdSessionStatus = {
  state: ProdSessionCondition;
  /** null means "recorded, but not a finding this run". */
  tier: "escalate" | "report" | null;
  /** Monotone-worse, for the FIX-1036 transition classifier. */
  severity: number;
  detail: string;
  held: boolean;
  reason: string | null;
  claimedBy: string | null;
  ageMinutes: number | null;
  expectedMinutes: number | null;
  /** Heavy writers live alongside the session — a --force claim leaves these. */
  liveWriters: string[];
};

/** Stable condition keys — the identity of the problem, not its wording. */
export const KEY_OVERRUN = "prod_session_overrun";
export const KEY_LABEL_STALE = "prod_session_label_stale";

/** A hold past this multiple of its own estimate is worth a look. */
export const OVERRUN_FACTOR = 2;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Classify the supervised-prod-session state.
 *
 * @param state `public.prod_session_state()`, or null when it could not be
 *              read — which is reported as nothing rather than as health, the
 *              same contract every other detector here keeps.
 */
export function classifyProdSession(state: ProdSessionState | null): ProdSessionStatus | null {
  if (state === null) return null;

  const ageMinutes = state.age_seconds == null ? null : round1(state.age_seconds / 60);
  const expected = state.expected_minutes ?? DEFAULT_EXPECTED_MINUTES;
  const liveWriters = state.live_writers ?? [];

  const base = {
    held: state.held,
    reason: state.reason,
    claimedBy: state.claimed_by,
    ageMinutes,
    expectedMinutes: state.expected_minutes,
    liveWriters,
  };

  // 1. A label with no lock. Checked FIRST because `held` is false here and
  //    everything below reads the age off a session that is not running.
  if (state.label_stale) {
    return {
      ...base,
      state: "label-stale",
      tier: "report",
      severity: ageMinutes ?? 0,
      detail:
        `stale prod_session label: ${state.claimed_by ?? "someone"} claimed ` +
        `${ageMinutes == null ? "at an unknown time" : `${ageMinutes}m ago`} for ` +
        `"${state.reason ?? "(no reason)"}" and the advisory lock is gone — a dead ` +
        "session. It defers nothing and the next claim clears it; the only harm is " +
        "a dashboard that says someone is on the box when nobody is.",
    };
  }

  if (!state.held) {
    return { ...base, state: "clear", tier: null, severity: 0, detail: "no supervised prod session" };
  }

  // 2. Held past twice its own estimate.
  if (ageMinutes !== null && ageMinutes > expected * OVERRUN_FACTOR) {
    return {
      ...base,
      state: "overrun",
      tier: "report",
      severity: round1(ageMinutes / expected),
      detail:
        `supervised prod session OVERRUNNING: ${state.claimed_by ?? "someone"} has held ` +
        `the box ${ageMinutes}m against an estimate of ${expected}m for ` +
        `"${state.reason ?? "(no reason)"}". Every guarded writer has been deferring ` +
        "for that whole span. Either the landing is stuck or a claim was left open.",
    };
  }

  // 3. Held, within estimate. The mechanism working.
  return {
    ...base,
    state: "held",
    tier: null,
    severity: ageMinutes === null ? 0 : round1(ageMinutes / expected),
    detail:
      `supervised prod session held by ${state.claimed_by ?? "someone"} for ` +
      `${ageMinutes ?? "?"}m of an expected ${expected}m: "${state.reason ?? "(no reason)"}"` +
      (liveWriters.length > 0 ? ` — claimed over ${liveWriters.join(", ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// FIX-1177 / FIX-1172 — a hold that outlived its session
// ---------------------------------------------------------------------------

/**
 * `prod_session_hold_stale` — session-set holds with nobody on the box.
 *
 * WHY THIS HAS TO EXIST AT ALL. `claimProdSession()` writes `held_since` on
 * every guarded pipeline so a long supervised session stops reporting
 * `stale rollup: financial_entity_totals_refresh` at the operator causing it
 * (FIX-1172). A hold does that by SUPPRESSING two thresholds —
 * `list_scheduled_rollup_pipelines()` NULLs `report_after_hours` and
 * `escalate_after_hours` for a held pipeline — which means a hold that outlives
 * its session is not harmless bookkeeping. It is a blindfold on the freshness
 * instruments, and a silent one, because the suppressed finding is exactly the
 * finding that would have told you.
 *
 * So the rule the FIX-943 canary keeps for bloat applies here too, one level
 * up: a mechanism that hides a finding must itself be watched. Three things
 * bound a leftover hold — the release clears it, the next claim clears it
 * before its own preflight, and this reports it — and the third is the only one
 * that works when nobody claims again for a week.
 *
 * `report`, not `escalate`. Nothing is broken and no data is at risk; some
 * thresholds are off and a human should turn them back on (or just claim
 * again, which does it). Escalating would page for a bookkeeping row, which is
 * how a tier stops meaning anything.
 */
export const KEY_HOLD_STALE = "prod_session_hold_stale";

/** One session-set row of `public.rollup_watch_overrides`. */
export type SessionHoldRow = {
  pipeline: string;
  /** ISO-8601, or null if the column somehow reads null. */
  held_since: string | null;
};

export type HoldStaleStatus = {
  tier: "report" | null;
  severity: number;
  detail: string;
  pipelines: string[];
  oldestAgeHours: number | null;
};

/**
 * Classify session-set holds against whether a session actually holds the box.
 *
 * @param rows  rows of `rollup_watch_overrides` whose `hold_reason` carries the
 *              session prefix — a human's own hold is NOT one of these and must
 *              never be reported as stale, because a human hold is a decision
 *              with no session behind it by design.
 * @param held  `prod_session_state()->>'held'`. The LOCK is the truth about
 *              whether a session is live, for the same reason the label is not
 *              (FIX-950): a killed process drops the lock and leaves the row.
 * @param now   injected so this stays pure.
 */
export function classifyHoldStale(
  rows: readonly SessionHoldRow[],
  held: boolean,
  now: Date = new Date(),
): HoldStaleStatus {
  const pipelines = rows.map((r) => r.pipeline).sort();

  if (pipelines.length === 0) {
    return { tier: null, severity: 0, detail: "no session-set rollup holds", pipelines: [], oldestAgeHours: null };
  }

  const ages = rows
    .map((r) => (r.held_since === null ? null : (now.getTime() - new Date(r.held_since).getTime()) / 3_600_000))
    .filter((a): a is number => a !== null && Number.isFinite(a));
  const oldestAgeHours = ages.length === 0 ? null : round1(Math.max(...ages));

  // A live session SHOULD have these rows. That is the mechanism, not a fault.
  if (held) {
    return {
      tier: null,
      severity: 0,
      detail:
        `${pipelines.length} guarded pipeline(s) held by the live supervised session` +
        (oldestAgeHours === null ? "" : ` (oldest ${oldestAgeHours}h)`),
      pipelines,
      oldestAgeHours,
    };
  }

  return {
    tier: "report",
    severity: oldestAgeHours ?? 0.1,
    detail:
      `${pipelines.length} rollup pipeline(s) still HELD with no supervised session on the box` +
      (oldestAgeHours === null ? "" : `; oldest held ${oldestAgeHours}h`) +
      `: ${pipelines.join(", ")}. A held pipeline reports and escalates NOTHING ` +
      "(list_scheduled_rollup_pipelines NULLs both thresholds), so freshness is " +
      "unwatched for these until the hold clears. The next claimProdSession() " +
      "clears it; `pnpm --filter @civitics/data session:claim` and Ctrl-C is the " +
      "one-liner. A hold a HUMAN declared is not counted here and is not stale.",
    pipelines,
    oldestAgeHours,
  };
}

// ---------------------------------------------------------------------------
// FIX-1224 — the two reads above, when they could not read at all
// ---------------------------------------------------------------------------

/**
 * `prod_session_read_failed` — the prod-session detectors read nothing.
 *
 * WHY. Both classifiers above take `null` as "could not read" and report it as
 * nothing, which is the right contract for ONE bad run and the wrong one for
 * every run. sync-canary-check.yml never passed a DB password, so
 * `buildDbUrl()` threw on every GHA run from the day FIX-950 shipped
 * (2026-09-11): 0 of 17 prod meta rows carried a prod-session read, and
 * `prod_session_overrun`, `prod_session_label_stale` and
 * `prod_session_hold_stale` could never fire. The only trace was a
 * `console.warn` in a log nobody reads — the FIX-1223 shape. A detector that
 * reads "unknown" on every run is absent, and absent has to be loud.
 *
 * `report`, not `escalate` — the posture of `front_door_corroborator_unavailable`.
 * Nothing is broken on the box; an instrument is blind and a human should look.
 * Escalating would page nightly for a missing env var.
 *
 * ONE key for both reads. They share a DSN and a connection path, so they fail
 * together, and the remedy is the same. Severity counts the reads that failed,
 * so one of the two recovering reads as better rather than as a new condition.
 */
export const KEY_READ_FAILED = "prod_session_read_failed";

/**
 * The detail for a read that produced nothing and threw nothing. Only
 * `buildDbUrl()` throws: `withClient` returns null on a failed connection (a
 * wrong password included) and `readProdSessionState` returns null on a failed
 * query, each after its own `[prod-session]` warning. So this is the COMMON
 * blind shape — every failure except a missing DSN.
 */
export const QUIET_FAILURE =
  "read nothing without throwing — a failed connection or prod_session_state() query (see the [prod-session] line)";

/** One of the canary's two direct-pg session reads, as it came back. */
export type SessionRead = {
  /** The name its log line uses. */
  name: "prod session" | "session holds";
  /** False when the read produced no status — thrown, or swallowed as null. */
  ok: boolean;
  /** The thrown error's text. Null when it did not throw, or read fine. */
  error: string | null;
};

export type SessionReadStatus = {
  tier: "report" | null;
  severity: number;
  detail: string;
  /** The names of the reads that failed. */
  failed: string[];
};

export function classifySessionReads(reads: readonly SessionRead[]): SessionReadStatus {
  const failed = reads.filter((r) => !r.ok);
  if (failed.length === 0) {
    return { tier: null, severity: 0, detail: "prod-session reads answered", failed: [] };
  }
  return {
    tier: "report",
    severity: failed.length,
    failed: failed.map((r) => r.name),
    detail:
      `prod-session detector blind — ${failed.length} of ${reads.length} direct-pg read(s) failed: ` +
      failed
        .map((r) => `${r.name}: ${r.error ?? QUIET_FAILURE}`)
        .join("; ") +
      `. ${KEY_OVERRUN}, ${KEY_LABEL_STALE} and ${KEY_HOLD_STALE} cannot fire, and this run's ` +
      "prod_session / session_holds trail is null. A workflow env with no SUPABASE_DB_PASSWORD " +
      "reads exactly like this — FIX-1224",
  };
}
