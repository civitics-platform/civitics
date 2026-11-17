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
 * THE VERDICT IS PER PHASE (FIX-1281). A row counts only toward the phase it
 * stamped (`metadata.phase`), so each of nightly.yml's four phase jobs gates on
 * its OWN phase's verdict. Before this, any row stood the whole run down: on
 * Mon 2026-10-05 the dispatched run's fec-phase was never acquired by a hosted
 * runner, heavy/light/tail ran on `!cancelled()` and wrote their rows, and the
 * late fallback stood down on THOSE — so the night's FEC phase was lost with no
 * retry. Per phase, that fallback runs FEC and the enrichment jobs stand down.
 * Whole-run stamps cover what they ran: a null phase (the pre-FIX-462 shape)
 * and the orchestrator's `all` count for every phase, and its `enrichment`
 * counts for the three enrichment sub-phases (index.ts, runNightlySync).
 *
 * WHO IT GUARDS. Only the AUTOMATED triggers, `schedule`, `vercel-cron` and (N2) `dispatcher`.
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
 * AN UNREADABLE DB (FIX-1418, cc-291). The read is tried three times, 20 s
 * and then 40 s apart. If all three fail, the preflight asks GitHub for
 * nightly.yml's `workflow_dispatch` runs: one that is not this run and whose
 * `created_at` names this nominal day stands every phase down, whatever its
 * status. With no such run, or no answer from GitHub, it FAILS OPEN as before.
 * That branch is the lapse net for a night the dispatcher never armed. On Mon
 * 2026-11-16 the fallback could not read the table, failed open, and redid a
 * night the dispatched run had finished an hour earlier, for 1 h 40 m inside a
 * stall. A DB too slow for one indexed read is the worst moment to add a
 * night's work.
 *
 * The decisions are pure, so they are unit-testable without the DB or GitHub.
 * The orchestration takes its I/O injected (`resolvePreflight`), and the real
 * reads and the `$GITHUB_OUTPUT` write live in scripts/nightly-preflight.ts.
 */

import type { NightlyPhase } from "./index";
import { retryWithBackoff } from "./utils";
import { nominalSlotInstant } from "./weekly-gate";

/**
 * The phases nightly.yml runs as separate jobs, each through
 * `data:nightly:<phase>:ci` → `--phase=<phase>`, which runNightlySync stamps
 * verbatim into `metadata.phase`. Typed against the orchestrator's own
 * NightlyPhase, and the test reads package.json and nightly.yml to hold the
 * list to the tree.
 */
export const PREFLIGHT_PHASES = [
  "fec",
  "enrichment-heavy",
  "enrichment-light",
  "enrichment-tail",
] as const satisfies readonly NightlyPhase[];

export type PreflightPhase = (typeof PREFLIGHT_PHASES)[number];

/**
 * The `$GITHUB_OUTPUT` name each phase's verdict is written under. `already_ran`
 * stays the FEC phase's, so its existing readers (the `Run FEC phase` step,
 * mark-killed, and the receipts job's role read off that step) are unchanged.
 */
export const PREFLIGHT_OUTPUT: Readonly<Record<PreflightPhase, string>> = {
  fec: "already_ran",
  "enrichment-heavy": "already_ran_enrichment_heavy",
  "enrichment-light": "already_ran_enrichment_light",
  "enrichment-tail": "already_ran_enrichment_tail",
};

/** Env var the workflow sets from `inputs.dispatched_by` / the event name. */
export const DISPATCHED_BY_ENV = "NIGHTLY_DISPATCHED_BY";

/** The automated firing paths the preflight de-duplicates between. */
// N2 (FIX-1336, cc-243): `dispatcher` — the nightly-request route firing the dispatcher's stamp.
export const GUARDED_TRIGGERS: readonly string[] = ["schedule", "vercel-cron", "dispatcher"];

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

/**
 * Does a row stamped `rowPhase` count toward `phase`? Its own phase, or a
 * whole-run stamp that ran it (see the header).
 */
export function rowCoversPhase(rowPhase: string | null, phase: PreflightPhase): boolean {
  if (rowPhase === null || rowPhase === "all") return true;
  if (rowPhase === "enrichment") return phase !== "fec";
  return rowPhase === phase;
}

export function decidePreflight(args: {
  nominalDay: string;
  dispatchedBy: string | null;
  runId: string | null;
  rows: PriorNightlyRow[];
  /** The phase this verdict is for (FIX-1281). */
  phase: PreflightPhase;
}): PreflightVerdict {
  const { nominalDay: day, dispatchedBy, runId, rows, phase } = args;
  if (dispatchedBy === null || !GUARDED_TRIGGERS.includes(dispatchedBy)) {
    return {
      alreadyRan: false,
      reason:
        `${phase}: trigger ${dispatchedBy ?? "(unset)"} is not an automated firing path — ` +
        "a human dispatch always runs (FIX-1218 guards schedule and vercel-cron only)",
      matched: [],
    };
  }
  const matched = rows.filter(
    (r) =>
      rowCoversPhase(r.phase, phase) &&
      r.status !== NOT_RAN_STATUS &&
      (runId === null || r.github_run_id !== runId),
  );
  if (matched.length === 0) {
    return {
      alreadyRan: false,
      reason:
        `${phase}: no other run has a nightly_cron row that ran this phase for nominal day ${day}` +
        (rows.length > 0 ? ` (${rows.length} row(s) ignored: another phase, this run's own, or skipped)` : "") +
        ` — this run does the ${phase} phase`,
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
      `${phase}: nominal day ${day} already ran (run ${runs.join(", ")}: ${phases}) — ` +
      `this ${dispatchedBy} run skips the ${phase} phase (FIX-1218, FIX-1281)`,
    matched,
  };
}

/** {@link decidePreflight} for every phase nightly.yml runs, in job order. */
export function decideAllPhases(args: {
  nominalDay: string;
  dispatchedBy: string | null;
  runId: string | null;
  rows: PriorNightlyRow[];
}): Record<PreflightPhase, PreflightVerdict> {
  const out = {} as Record<PreflightPhase, PreflightVerdict>;
  for (const phase of PREFLIGHT_PHASES) out[phase] = decidePreflight({ ...args, phase });
  return out;
}

/** The `$GITHUB_OUTPUT` lines for a set of verdicts — one per phase, plus the day. */
export function preflightOutputs(
  verdicts: Record<PreflightPhase, PreflightVerdict>,
  day: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const phase of PREFLIGHT_PHASES) out[PREFLIGHT_OUTPUT[phase]] = verdicts[phase].alreadyRan ? "true" : "false";
  out["nominal_day"] = day;
  return out;
}

/**
 * FAIL OPEN: a preflight that could not read answers `false` for EVERY phase,
 * so a crash never costs any phase of the night.
 */
export function failOpenOutputs(day: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const phase of PREFLIGHT_PHASES) out[PREFLIGHT_OUTPUT[phase]] = "false";
  if (day !== null) out["nominal_day"] = day;
  return out;
}

// ── FIX-1418 — the DB is unreadable: does GitHub show the night's run? ──────

/** D1: the read is tried once, then once after each of these waits. */
export const PREFLIGHT_READ_RETRY_DELAYS_MS: readonly number[] = [20_000, 40_000];

/**
 * The offset the dispatcher passes (`slot_offset_hours: "3"`,
 * apps/civitics/src/lib/gha-dispatch.ts), so a dispatched run's `created_at`
 * names its nominal day through {@link nominalDay}, the same function the run
 * stamped its rows with.
 */
export const DISPATCH_SLOT_OFFSET_HOURS = 3;

/** One nightly.yml run as GitHub's REST API lists it, narrowed to what D2 reads. */
export interface DispatchedNightlyRun {
  id: string;
  created_at: string;
  status: string | null;
  conclusion: string | null;
}

/**
 * `GET /repos/{repo}/actions/workflows/nightly.yml/runs` → the runs. A body
 * that is not that shape is `null` (GitHub unreadable), never a throw; a run
 * missing its id or created_at is dropped.
 */
export function parseWorkflowRuns(body: unknown): DispatchedNightlyRun[] | null {
  const list = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(list)) return null;
  const out: DispatchedNightlyRun[] = [];
  for (const r of list as Array<Record<string, unknown> | null>) {
    const id = r?.["id"];
    const created = r?.["created_at"];
    if ((typeof id !== "number" && typeof id !== "string") || typeof created !== "string") continue;
    out.push({
      id: String(id),
      created_at: created,
      status: typeof r?.["status"] === "string" ? (r["status"] as string) : null,
      conclusion: typeof r?.["conclusion"] === "string" ? (r["conclusion"] as string) : null,
    });
  }
  return out;
}

/** Does a dispatched run created at `createdAt` name nominal day `day`? */
export function runCoversDay(createdAt: string, day: string): boolean {
  const t = Date.parse(createdAt);
  return !Number.isNaN(t) && nominalDay(new Date(t), DISPATCH_SLOT_OFFSET_HOURS) === day;
}

export interface UnreadableVerdict {
  /** true → every phase `already_ran=true`; false → today's FAIL OPEN. */
  standDown: boolean;
  /** One line, printed as the step's notice (stand down) or warning (fail open). */
  reason: string;
  /** The covering runs, newest first; empty when it fails open. */
  covering: DispatchedNightlyRun[];
}

const FAIL_OPEN_TAIL = "FAIL OPEN: already_ran=false for every phase, this run does the night's work";

/**
 * D2 / D3 — the DB stayed unreadable after `tries` reads. `runs` is GitHub's
 * `workflow_dispatch` list for nightly.yml (newest first), or `null` when
 * GitHub could not be read either. A run COVERS the day when it is not this
 * run and its `created_at` names this nominal day; any covering run, in any
 * status, stands the whole run down. Otherwise FAIL OPEN, unchanged.
 */
export function decideUnreadable(args: {
  day: string;
  runId: string | null;
  runs: readonly DispatchedNightlyRun[] | null;
  tries: number;
}): UnreadableVerdict {
  const { day, runId, runs, tries } = args;
  const head = `DB unreadable after ${tries} tries`;
  if (runs === null) {
    return { standDown: false, reason: `${head}, and GitHub's run list unreadable too — ${FAIL_OPEN_TAIL}`, covering: [] };
  }
  const covering = runs.filter((r) => r.id !== runId && runCoversDay(r.created_at, day));
  if (covering.length === 0) {
    return {
      standDown: false,
      reason:
        `${head}, and none of the ${runs.length} workflow_dispatch run(s) GitHub lists names nominal day ${day} ` +
        `— ${FAIL_OPEN_TAIL}`,
      covering: [],
    };
  }
  const c = covering[0]!;
  return {
    standDown: true,
    reason:
      `${head}; GitHub shows dispatched run ${c.id} (${c.status ?? "?"} / ${c.conclusion ?? "—"}, created ${c.created_at}) ` +
      `for nominal day ${day} — every phase stands down (FIX-1418)`,
    covering,
  };
}

/** Every phase `already_ran=true` — the D2 stand-down. */
export function standDownOutputs(day: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const phase of PREFLIGHT_PHASES) out[PREFLIGHT_OUTPUT[phase]] = "true";
  out["nominal_day"] = day;
  return out;
}

/** What {@link resolvePreflight} reads through. The script passes the real ones. */
export interface PreflightIo {
  readRows(day: string): Promise<PriorNightlyRow[]>;
  /** GitHub's workflow_dispatch runs, or null. Must not throw; a throw is read as null. */
  listDispatchedRuns(): Promise<DispatchedNightlyRun[] | null>;
  sleep(ms: number): Promise<void>;
  info(line: string): void;
  warn(line: string): void;
}

/**
 * The whole preflight, with its I/O injected: read (with D1's retries), decide
 * per phase, and on an unreadable DB ask GitHub (D2) before failing open (D3).
 * Returns the `$GITHUB_OUTPUT` lines. An unguarded trigger reads neither the DB
 * nor GitHub.
 */
export async function resolvePreflight(
  args: { day: string; dispatchedBy: string | null; runId: string | null },
  io: PreflightIo,
  delaysMs: readonly number[] = PREFLIGHT_READ_RETRY_DELAYS_MS,
): Promise<Record<string, string>> {
  const { day, dispatchedBy, runId } = args;
  const tries = delaysMs.length + 1;
  let rows: PriorNightlyRow[] = [];
  if (dispatchedBy !== null && GUARDED_TRIGGERS.includes(dispatchedBy)) {
    try {
      rows = await retryWithBackoff(() => io.readRows(day), {
        delaysMs,
        sleep: io.sleep,
        onRetry: (n, err, waitMs) =>
          io.warn(
            `[preflight] data_sync_log read ${n} of ${tries} failed (${err.message}) — trying again in ${waitMs / 1000} s`,
          ),
      });
    } catch (err) {
      io.warn(
        `[preflight] could not read data_sync_log (${err instanceof Error ? err.message : String(err)}) ` +
          `after ${tries} tries — asking GitHub for the night's dispatched run`,
      );
      let runs: DispatchedNightlyRun[] | null;
      try {
        runs = await io.listDispatchedRuns();
      } catch {
        runs = null;
      }
      const v = decideUnreadable({ day, runId, runs, tries });
      if (v.standDown) {
        io.info(`::notice::[preflight] ${v.reason}`);
        return standDownOutputs(day);
      }
      io.warn(`[preflight] ${v.reason}`);
      return failOpenOutputs(day);
    }
  }

  for (const r of rows) {
    io.info(
      `[preflight]   row ${r.id} phase=${r.phase ?? "all"} status=${r.status} started=${r.started_at} ` +
        `run=${r.github_run_id ?? "—"} dispatched_by=${r.dispatched_by ?? "—"}`,
    );
  }
  const verdicts = decideAllPhases({ nominalDay: day, dispatchedBy, runId, rows });
  // One line per phase. `::notice::` renders as an annotation on the run page,
  // so a fallback that stood a phase down says why without anyone opening the log.
  for (const phase of PREFLIGHT_PHASES) {
    const v = verdicts[phase];
    io.info(`${v.alreadyRan ? "::notice::" : ""}[preflight] ${v.reason}`);
  }
  return preflightOutputs(verdicts, day);
}
