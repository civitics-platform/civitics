/**
 * FIX-1218 — the nightly is idempotent by NOMINAL DAY.
 *
 * WHY. nightly.yml now has two automated firing paths for one slot: the Vercel
 * cron at `/api/cron/gha-dispatch` fires `workflow_dispatch` at 21:00 UTC, and
 * the `schedule:` trigger still fires too — GitHub starts it 1.6–2.7 h late
 * (cc-150 read 2: 14 starts since 09-10, median 2.11 h) and it is KEPT as the
 * fallback for a dead dispatcher. Without a guard, every healthy night would run
 * the whole nightly twice. With one, the late scheduled run finds the
 * dispatched run's rows and exits in about a runner-minute, and on a night the
 * dispatcher died it finds nothing and does the work — a free fallback.
 *
 * THE KEY IS THE NOMINAL DAY, not the wall clock and not the run. Both paths
 * name the same day by construction: the dispatch passes `slot_offset_hours=3`
 * and a schedule event gets 3 from the workflow expression, so either one,
 * started anywhere in [slot, slot + 24h), reads the day off `now + 3h`
 * (FIX-1163, weekly-gate.ts). The orchestrator stamps that day into every
 * `nightly_cron` row's metadata (`nominal_day`); the preflight reads it back.
 *
 * WHAT COUNTS AS "ALREADY RAN". Any `nightly_cron` row for the day whose status
 * is not `skipped`: `running`, `complete`, `partial` (ran, some pipeline
 * failed — re-running the whole nightly for one flaky upstream would double the
 * box's load every such night), and the reaper's `reaped` / mark-killed's
 * `failed` (a run that was killed still ran). `skipped` is the one status that
 * means the phase did NOT run — a FIX-950 interlock hold — so a fallback that
 * arrives after the hold is released is allowed to do the night's work.
 *
 * WHO IT GUARDS. Only the two AUTOMATED triggers, `schedule` and `vercel-cron`.
 * A human `gh workflow run nightly.yml` (dispatched_by defaults to `manual`)
 * always runs: its offset defaults to 0, so it names the current UTC day, which
 * the previous evening's slot has always already claimed — guarding it would
 * make every manual dispatch a no-op, including FIX-743's supervised
 * `force_weekly` run and every "re-run last night" dispatch.
 *
 * A RE-RUN OF THE SAME RUN IS NOT A DUPLICATE. GitHub's "Re-run jobs" keeps
 * GITHUB_RUN_ID and bumps GITHUB_RUN_ATTEMPT, and attempt 1's rows carry that
 * run id — so rows from this run's own id are ignored, and a re-run does the
 * work it was asked to.
 *
 * Pure, so the decision is unit-testable without the DB; the read and the
 * `$GITHUB_OUTPUT` write live in scripts/nightly-preflight.ts.
 */

import { nominalSlotInstant } from "./weekly-gate";

/** Env var the workflow sets from `inputs.dispatched_by` / the event name. */
export const DISPATCHED_BY_ENV = "NIGHTLY_DISPATCHED_BY";

/** The automated firing paths the preflight de-duplicates between. */
export const GUARDED_TRIGGERS: readonly string[] = ["schedule", "vercel-cron"];

/** The one status that means the phase did not run (a FIX-950 hold). */
export const NOT_RAN_STATUS = "skipped";

/**
 * The nominal day as a UTC `YYYY-MM-DD` — the value stamped into
 * `metadata.nominal_day` and the one the preflight matches on.
 *
 * UTC, where computeRunWeekly reads LOCAL getDay(). On a GHA runner (UTC) the
 * two agree; on a developer machine they can differ by a day, and only the
 * automated triggers — which always run on GHA — are guarded, so the stamp is
 * written in the zone the receipts file is named in (receipts-format.ts
 * nominalDate) rather than the zone of the machine.
 */
export function nominalDay(now: Date, slotOffsetHours: number): string {
  return nominalSlotInstant(now, slotOffsetHours).toISOString().slice(0, 10);
}

/**
 * Parse NIGHTLY_DISPATCHED_BY. A short lowercase slug or nothing: the value is
 * written into a row and matched against GUARDED_TRIGGERS, so free text from a
 * dispatch input is refused rather than stored.
 */
export function readDispatchedBy(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(t) ? t : null;
}

/**
 * The two keys every `nightly_cron` row carries from FIX-1218 on. `dispatched_by`
 * is omitted off CI (unset env), so a local run's row is unchanged apart from
 * its nominal day.
 */
export function nightlyRunStamp(
  now: Date,
  slotOffsetHours: number,
  env: NodeJS.ProcessEnv = process.env,
): { nominal_day: string; dispatched_by?: string } {
  const by = readDispatchedBy(env[DISPATCHED_BY_ENV]);
  return { nominal_day: nominalDay(now, slotOffsetHours), ...(by === null ? {} : { dispatched_by: by }) };
}

/** One `nightly_cron` row, narrowed to what the decision reads. */
export interface PriorNightlyRow {
  id: string;
  status: string | null;
  started_at: string | null;
  phase: string | null;
  github_run_id: string | null;
  dispatched_by: string | null;
}

export interface PreflightVerdict {
  alreadyRan: boolean;
  /** One line, printed as the step's notice. */
  reason: string;
  /** The rows that made it a duplicate; empty when it is not one. */
  matched: PriorNightlyRow[];
}

export function decidePreflight(args: {
  nominalDay: string;
  dispatchedBy: string | null;
  runId: string | null;
  rows: PriorNightlyRow[];
}): PreflightVerdict {
  const { nominalDay: day, dispatchedBy, runId, rows } = args;
  if (dispatchedBy === null || !GUARDED_TRIGGERS.includes(dispatchedBy)) {
    return {
      alreadyRan: false,
      reason:
        `trigger ${dispatchedBy ?? "(unset)"} is not an automated firing path — ` +
        "a human dispatch always runs (FIX-1218 guards schedule and vercel-cron only)",
      matched: [],
    };
  }
  const matched = rows.filter(
    (r) => r.status !== NOT_RAN_STATUS && (runId === null || r.github_run_id !== runId),
  );
  if (matched.length === 0) {
    return {
      alreadyRan: false,
      reason:
        `no other run has a nightly_cron row that ran for nominal day ${day}` +
        (rows.length > 0 ? ` (${rows.length} row(s) ignored: this run's own, or skipped)` : "") +
        " — this run does the night's work",
      matched: [],
    };
  }
  const runs = [...new Set(matched.map((r) => r.github_run_id ?? "(no run id)"))];
  const phases = matched
    .map((r) => `${r.phase ?? "all"}=${r.status ?? "?"}`)
    .join(", ");
  return {
    alreadyRan: true,
    reason:
      `nominal day ${day} already ran (run ${runs.join(", ")}: ${phases}) — ` +
      `this ${dispatchedBy} run exits without running the nightly (FIX-1218)`,
    matched,
  };
}
