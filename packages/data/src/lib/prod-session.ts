/**
 * FIX-950 — the supervised prod session: claim, preflight, release.
 *
 * The DB half is `public.prod_session_state()` (migration
 * 20260911000000_fix950_prod_session_state.sql); this is the side that takes
 * the lock and the side that refuses to.
 *
 * ── D3b: THE SAFE PATH IS THE DEFAULT PATH (rule 47) ────────────────────────
 * `withProdSession()` wraps a prod-writing script's body. It is not a
 * convention an operator has to remember — the four FR-rewrite landing scripts
 * call it from `main()`, so a landing cannot write prod without the scheduled
 * writers being able to see it. FIX-950 exists because the previous mechanism
 * WAS a convention ("cancel the nightly first"), and conventions are what
 * failed twice.
 *
 * ── D4: THE PREFLIGHT REFUSES, IT DOES NOT WARN ─────────────────────────────
 * The interlock is symmetric and the second direction is the one the prompts
 * have been enforcing by prose ("no concurrent heavy reads during a supervised
 * run", rule 43). A session that claims while a six-hour rollup is mid-flight
 * has coordinated nothing — it has added a second writer to a 2-vCPU box, and
 * FIX-1165 measured what that costs: 202 statement cancellations in 97 minutes
 * against a baseline of 1, with the rate HIGHEST during the global rebuild.
 * So a live heavy writer REFUSES the claim (exit 2). `--force` overrides and
 * records what it overrode in the label, because an override nobody can find
 * afterwards is the same as no override.
 *
 * Two refusals, and only one of them is forceable:
 *
 *   writers-live   another heavy writer holds its own advisory lock, or a
 *                  nightly phase has an open `running` row. --force overrides.
 *   session-held   ANOTHER supervised session holds the box. NEVER forceable:
 *                  two simultaneous supervised sessions is the precise thing
 *                  the lock exists to prevent, and `--force` on it would make
 *                  the interlock advisory in the one case that matters.
 *
 * ── WHY THIS CLAIMS AGAINST LOCAL TOO ───────────────────────────────────────
 * There is deliberately no "skip the claim when the target is local Docker"
 * branch. One code path means the local clone walk-through exercises exactly
 * what prod will run, and a local nightly deferring under a local claim is the
 * proof, not a nuisance. The lock costs one connection.
 *
 * ── FAIL OPEN ───────────────────────────────────────────────────────────────
 * Inherited from the FIX-1067 lock and extended to the preflight: if
 * `prod_session_state()` cannot be read (it is missing on this DB, the
 * connection fails, the query throws), the preflight reports `unknown` and the
 * claim proceeds with a loud line. A safety interlock that stops a landing
 * because its own reader is unavailable has converted an operational nuisance
 * into a blocked remediation, and the landing's other guards (the manifest
 * requirement, --allow-prod, the dry run) are all still in force.
 */

import os from "node:os";
import type { Client } from "pg";
import { buildDbUrl } from "./heavy-rebuild";
import { Q_GUARDED_PIPELINES } from "./cron-job-pipelines";
import {
  acquireNamedSessionLock,
  errText,
  type NamedSessionLock,
} from "./session-lock";

/** Advisory-lock name. Must match `c_lock_name` in prod_session_state(). */
export const PROD_SESSION_LOCK_NAME = "prod_supervised_session";
/** `pipeline_state` key carrying the label. Must match the same function. */
export const PROD_SESSION_LABEL_KEY = "prod_session";
/** Default when a caller gives no estimate. Feeds the canary's overrun tier. */
export const DEFAULT_EXPECTED_MINUTES = 60;

/** One entry of `prod_session_state()->'live_writer_detail'`. */
export interface LiveWriter {
  name: string;
  pid: number | null;
  age_seconds: number | null;
  source: "advisory_lock" | "data_sync_log";
}

/** The shape `public.prod_session_state()` returns. */
export interface ProdSessionState {
  held: boolean;
  defer: boolean;
  label_present: boolean;
  label_stale: boolean;
  reason: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  age_seconds: number | null;
  expected_minutes: number | null;
  pid: number | null;
  live_writers: string[];
  live_writer_detail: LiveWriter[];
  reason_text: string;
}

export type PreflightVerdict =
  | { ok: true; forced: false; forcedOver: [] }
  | { ok: true; forced: true; forcedOver: string[] }
  | { ok: false; code: "session-held"; detail: string }
  | { ok: false; code: "writers-live"; writers: string[]; detail: string };

/**
 * Decide whether a claim may proceed. Pure over the reader's output so the
 * refusal matrix is assertable without a database.
 *
 * `null` state means the reader could not be consulted — fail open (see the
 * module header), and say so in the caller's log rather than here.
 */
export function classifyPreflight(
  state: ProdSessionState | null,
  opts: { force: boolean },
): PreflightVerdict {
  if (state === null) return { ok: true, forced: false, forcedOver: [] };

  // Checked FIRST and never forceable: a second supervised session is the exact
  // failure this lock exists to prevent, and it is also the only refusal whose
  // cause is another human rather than a schedule.
  if (state.held) {
    const who = state.claimed_by ?? "(unknown)";
    const why = state.reason ?? "(no reason given)";
    const age = state.age_seconds == null ? "unknown age" : `${formatAge(state.age_seconds)} ago`;
    return {
      ok: false,
      code: "session-held",
      detail: `a supervised prod session is already held by ${who} (${age}): ${why}`,
    };
  }

  const writers = state.live_writers ?? [];
  if (writers.length > 0 && !opts.force) {
    return {
      ok: false,
      code: "writers-live",
      writers,
      detail:
        `${writers.length} heavy writer(s) are live: ${writers.join(", ")}. ` +
        "Claiming now would add a second writer to the box rather than coordinate " +
        "with it (FIX-1165). Wait for them, or re-run with --force.",
    };
  }

  if (writers.length > 0) return { ok: true, forced: true, forcedOver: writers };
  return { ok: true, forced: false, forcedOver: [] };
}

/** `137` → `2m17s`. Used in every refusal and status line. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line per live writer, for the refusal and the status ticker. */
export function describeWriters(detail: readonly LiveWriter[]): string[] {
  return detail.map((w) => {
    const age = w.age_seconds == null ? "age unknown" : `${formatAge(w.age_seconds)} in`;
    const pid = w.pid == null ? "" : ` pid ${w.pid}`;
    return `${w.name} — ${age}${pid} (${w.source})`;
  });
}

/** Who is claiming. OS user + host is the most an unattended script can know. */
export function claimedBy(): string {
  let user = "unknown";
  try { user = os.userInfo().username; } catch { /* container without a passwd entry */ }
  return `${user}@${os.hostname()}`;
}

/**
 * Read `public.prod_session_state()`. Returns null when it cannot be read at
 * all — a missing function on a not-yet-migrated DB included.
 */
export async function readProdSessionState(client: Client): Promise<ProdSessionState | null> {
  try {
    const res = await client.query<{ state: ProdSessionState }>(
      `SELECT public.prod_session_state() AS state`,
    );
    return res.rows[0]?.state ?? null;
  } catch (err) {
    console.warn(
      `  [prod-session] could not read prod_session_state() (${errText(err)}) — ` +
        "treating the interlock as UNKNOWN and proceeding (FIX-950)",
    );
    return null;
  }
}

/** Thrown by withProdSession when the preflight refuses. Exit code 2. */
export class ProdSessionRefused extends Error {
  readonly verdict: Extract<PreflightVerdict, { ok: false }>;
  constructor(verdict: Extract<PreflightVerdict, { ok: false }>) {
    super(verdict.detail);
    this.name = "ProdSessionRefused";
    this.verdict = verdict;
  }
}

export interface ProdSessionOptions {
  /** What this session is doing. Ends up in every deferred firing's skip_reason. */
  reason: string;
  /** Estimate, minutes. Twice this is the canary's overrun threshold. */
  expectedMinutes?: number;
  /** Claim over live heavy writers, recording what was overridden. */
  force?: boolean;
  /** Override the DSN (tests). */
  dbUrl?: string;
}

/**
 * Run `fn` while holding the supervised-prod-session lock.
 *
 * Preflight → acquire → run → release in `finally`. Throws
 * {@link ProdSessionRefused} before `fn` is ever called when the preflight
 * refuses; every other failure mode fails open and runs `fn` unserialized with
 * a loud line.
 */
export async function withProdSession<T>(
  opts: ProdSessionOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await claimProdSession(opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * The entry-point wrapper for a supervised landing script (D3b).
 *
 * Wraps the script's whole `main()` rather than only its `--apply` branch,
 * because FIX-1165 Rule 1 says the DERIVATION is the expensive half: the
 * 2026-09-07 dry run cost 81 minutes and 132 of the day's 202 statement
 * cancellations without writing a row. A hold that only covered writes would
 * have covered the cheaper half of that day.
 *
 * `--force` is read straight from argv so an operator who has decided to claim
 * over a live writer does not need a second flag spelling to learn.
 *
 * A script that calls `process.exit()` from inside `main()` skips the `finally`
 * release. That is survivable by construction and is why the lock is
 * session-scoped: the backend goes away with the process and Postgres drops the
 * lock. What can survive is the LABEL row, which defers nothing, reports as
 * `prod_session_label_stale`, and is overwritten by the next claim.
 */
export async function runUnderProdSession(
  opts: { script: string; expectedMinutes: number },
  main: () => Promise<void>,
): Promise<void> {
  const argv = process.argv.slice(2);
  const reason = `${opts.script}${argv.length ? ` ${argv.join(" ")}` : ""}`.slice(0, 300);
  try {
    await withProdSession(
      { reason, expectedMinutes: opts.expectedMinutes, force: argv.includes("--force") },
      main,
    );
  } catch (err) {
    if (err instanceof ProdSessionRefused) {
      console.error(`\n✗ REFUSED — ${err.verdict.detail}`);
      console.error(
        err.verdict.code === "session-held"
          ? "  Two supervised sessions on one box is what this lock prevents; --force\n" +
              "  does not apply. Wait, or talk to the holder."
          : "  Nothing was derived and nothing was written. Re-run when they finish,\n" +
              "  or add --force to claim over them (it is recorded in the label).",
      );
      process.exit(2);
    }
    throw err;
  }
}

/**
 * The claim half of {@link withProdSession}, exposed for the foreground CLI
 * (which holds the session and does no work of its own).
 */
export async function claimProdSession(opts: ProdSessionOptions): Promise<NamedSessionLock> {
  const dbUrl = opts.dbUrl ?? buildDbUrl();
  const expected = opts.expectedMinutes ?? DEFAULT_EXPECTED_MINUTES;

  // FIX-1177/1172 self-heal, FIRST. A session killed with SIGKILL drops its
  // advisory lock with its backend but leaves its holds behind, and a hold
  // suppresses freshness instruments. Clearing leftovers before this claim's
  // own preflight bounds that to "until the next claim" — the same shape as
  // the FIX-950 label, which the next claim also overwrites. It runs even if
  // this claim goes on to be REFUSED: a leftover hold from a dead session is
  // not this claim's to keep, whichever way the preflight goes.
  const swept = await clearGuardedHolds(dbUrl).catch((err: unknown) => {
    console.warn(`  [prod-session] leftover-hold sweep failed (${errText(err)}) — continuing`);
    return 0;
  });
  // Said out loud, because a non-zero sweep is EVIDENCE: the previous session
  // did not release, and its holds had been suppressing freshness thresholds
  // in the meantime. Clearing that silently would delete the only trace.
  if (swept > 0) {
    console.warn(
      `  [prod-session] swept ${swept} leftover hold(s) from a session that did not ` +
        "release — freshness was unwatched for those pipelines until now (FIX-1177)",
    );
  }

  // The preflight runs on its own short-lived connection, BEFORE anything is
  // held: a refusal must not have taken the lock it is refusing to take.
  const state = await withClient(dbUrl, readProdSessionState);
  const verdict = classifyPreflight(state, { force: opts.force === true });

  if (!verdict.ok) {
    if (verdict.code === "writers-live" && state) {
      for (const line of describeWriters(state.live_writer_detail ?? [])) {
        console.error(`  [prod-session]   ${line}`);
      }
    }
    throw new ProdSessionRefused(verdict);
  }
  if (verdict.forced) {
    console.warn(
      `  [prod-session] --force: claiming OVER ${verdict.forcedOver.length} live writer(s): ` +
        `${verdict.forcedOver.join(", ")} (FIX-950)`,
    );
  }

  const value: Record<string, unknown> = {
    reason: opts.reason,
    claimed_by: claimedBy(),
    claimed_at: new Date().toISOString(),
    expected_minutes: expected,
    pid: process.pid,
  };
  if (verdict.forced) value["forced_over"] = verdict.forcedOver;

  const lock = await acquireNamedSessionLock(PROD_SESSION_LOCK_NAME, {
    logTag: "prod-session",
    ref: "FIX-950",
    label: { key: PROD_SESSION_LABEL_KEY, value },
    // The SAME dsn the preflight read. Letting the lock re-resolve buildDbUrl()
    // would let the preflight and the hold land on different databases.
    dbUrl,
  });

  // AFTER the lock, BEFORE it is returned. Holding before the lock is taken
  // would suppress instruments for a claim that then gets refused; holding
  // after the caller already has the lock back would leave a window in which
  // the session is live and the thresholds are not yet suppressed.
  const held = await setGuardedHolds(dbUrl, opts.reason).catch((err: unknown) => {
    console.warn(
      `  [prod-session] could not hold guarded pipelines (${errText(err)}) — ` +
        "the session proceeds; a long one may report a stale rollup (FIX-1172)",
    );
    return 0;
  });
  if (held > 0) {
    console.log(`  [prod-session] held ${held} guarded pipeline(s) (FIX-1177/1172)`);
  }

  // The same `dbUrl` again (the FIX-950 same-dsn rule): the release must clear
  // the holds on the database the claim set them on.
  return {
    get acquired() {
      return lock.acquired;
    },
    get blockedBy() {
      return lock.blockedBy;
    },
    async release() {
      const cleared = await clearGuardedHolds(dbUrl).catch((err: unknown) => {
        console.warn(
          `  [prod-session] could not clear holds (${errText(err)}) — the next ` +
            "claim will, and canary-prod-session reports prod_session_hold_stale " +
            "until something does",
        );
        return 0;
      });
      if (cleared > 0) console.log(`  [prod-session] cleared ${cleared} hold(s)`);
      await lock.release();
    },
  };
}


// ---------------------------------------------------------------------------
// FIX-1177 / FIX-1172 — the session HOLDS the guarded pipelines
// ---------------------------------------------------------------------------

/**
 * A supervised session is a deliberate operator action. The FIX-950 interlock
 * turns it into a `skipped` data_sync_log row on every guarded pipeline that
 * fires during it — correctly — and `check_rollup_freshness()` counts only
 * `status = 'complete'`, so a skip advances nothing. Past ~48 minutes on prod
 * that is enough for `financial_entity_totals_refresh` to cross its report
 * threshold and the nightly canary to raise `stale rollup: …` at an operator
 * who was doing the right thing (FIX-1172). FIX-1177 is the same asymmetry
 * stated generally: a correct skip is invisible to every freshness reader.
 *
 * The suppression mechanism already exists on the READ side and needs no
 * migration. `list_scheduled_rollup_pipelines()` NULLs both
 * `report_after_hours` and `escalate_after_hours` when a pipeline is `held`,
 * and `canary-check.ts` gates its finding on `!w.held`. What was missing is a
 * WRITER: nothing set `held_since` for the duration of a session.
 *
 * ── WHICH PIPELINES (D1(a)) ─────────────────────────────────────────────────
 * The GUARDED set only — the pipelines whose writer procedure consults
 * `prod_session_state()`, derived at claim time from
 * `Q_GUARDED_PIPELINES` (seventeen of them today). A hold cannot make a
 * GHA-driven or Vercel-driven pipeline late for its own reasons, so those keep
 * their thresholds: suppressing a threshold a session cannot affect would turn
 * the hold into a blindfold.
 *
 * Deriving the set rather than listing it in code is the same decision as
 * FIX-1190's: a list here would silently stop covering a pipeline the next
 * migration adds a guard to.
 *
 * ── WHY BEST-EFFORT ─────────────────────────────────────────────────────────
 * Neither the set nor the clear can fail a claim or a release. This is the
 * FIX-1067 label rule applied one layer out: a bookkeeping write that can veto
 * the safety mechanism is worse than no bookkeeping. Every failure is one
 * `[prod-session]` warn line and the session proceeds.
 *
 * ── WHY A STALE HOLD IS A FINDING ───────────────────────────────────────────
 * A hold suppresses instruments, so a hold that outlives its session has
 * blinded them. Three things bound that. The next claim clears leftovers
 * before its own preflight (self-healing, the FIX-950 label pattern); the
 * release clears them; and `canary-prod-session.ts` reports
 * `prod_session_hold_stale` when held rows exist with no session holding the
 * lock. A hold must not be able to become permanent quietly.
 */

/** The `hold_reason` prefix. Shared with the guard procedures' `skip_reason`. */
export const SESSION_HOLD_PREFIX = "prod session held: ";

/**
 * The `note` a session-created row carries.
 *
 * `rollup_watch_overrides.note` is NOT NULL because the table is a table of
 * human decisions and an unexplained row is not one. A row this code creates
 * has to say so, both so an operator reading the table knows it is machinery
 * and so the release can tell its own rows from a human's when deciding what
 * to delete.
 */
export const SESSION_HOLD_NOTE =
  "FIX-1177/1172 — set by claimProdSession(); cleared by release(); " +
  "a row with this note and no hold is inert";

/**
 * Hold every guarded pipeline for the duration of this session.
 *
 * Two rows are deliberately left alone:
 *
 *   retired_at IS NOT NULL — the `not_both` CHECK forbids holding a retired
 *     pipeline, and a retired pipeline reports nothing anyway.
 *   held_since IS NOT NULL — somebody already holds it. If that somebody is a
 *     human, their reason is the one an operator needs to see, and a session's
 *     generic reason must not overwrite it. If it is a previous session's
 *     leftover, `clearGuardedHolds()` has already run above this.
 *
 * Returns how many pipelines this session now holds.
 */
export async function setGuardedHolds(dbUrl: string, reason: string): Promise<number> {
  const n = await withClient(dbUrl, async (client) => {
    const res = await client.query<{ pipeline: string }>(
      `INSERT INTO public.rollup_watch_overrides (pipeline, held_since, hold_reason, note)
       SELECT g.pipeline, now(), $1, $2
       FROM (${Q_GUARDED_PIPELINES}) AS g
       ON CONFLICT (pipeline) DO UPDATE
         SET held_since  = EXCLUDED.held_since,
             hold_reason = EXCLUDED.hold_reason,
             updated_at  = now()
         WHERE public.rollup_watch_overrides.retired_at IS NULL
           AND public.rollup_watch_overrides.held_since IS NULL
       RETURNING pipeline`,
      [SESSION_HOLD_PREFIX + reason, SESSION_HOLD_NOTE],
    );
    return res.rowCount ?? 0;
  });
  return n ?? 0;
}

/**
 * Clear every hold THIS mechanism set, and remove the rows it created that now
 * declare nothing.
 *
 * The `LIKE` on the prefix is the whole safety property: a human-declared hold
 * is never cleared by a session release. Widening it to "clear all holds" would
 * make a release silently un-pause a pipeline an operator paused on purpose,
 * which is why the unit suite asserts the predicate rather than the behaviour.
 *
 * The DELETE then garbage-collects: a row this code created, whose hold is now
 * gone, which carries no asserted cadence and is not retired, declares nothing
 * at all — and `rollup_watch_overrides` is supposed to be a table of decisions,
 * not a residue of sessions. A row a human has since given a `cadence_hours`
 * or a `retired_at` survives, as does any row whose note they changed.
 */
export async function clearGuardedHolds(dbUrl: string): Promise<number> {
  const n = await withClient(dbUrl, async (client) => {
    const res = await client.query(
      `UPDATE public.rollup_watch_overrides
          SET held_since = NULL, hold_reason = NULL, updated_at = now()
        WHERE hold_reason LIKE $1`,
      [SESSION_HOLD_PREFIX + "%"],
    );
    await client.query(
      `DELETE FROM public.rollup_watch_overrides
        WHERE note = $1
          AND held_since    IS NULL
          AND retired_at    IS NULL
          AND cadence_hours IS NULL`,
      [SESSION_HOLD_NOTE],
    );
    return res.rowCount ?? 0;
  });
  return n ?? 0;
}

/** Open a client, run `fn`, always close. Returns null on a connect failure. */
export async function withClient<T>(
  dbUrl: string,
  fn: (client: Client) => Promise<T | null>,
): Promise<T | null> {
  let client: Client;
  try {
    const { Client: PgClient } = await import("pg");
    client = new PgClient({ connectionString: dbUrl });
    await client.connect();
  } catch (err) {
    console.warn(
      `  [prod-session] preflight connection failed (${errText(err)}) — ` +
        "treating the interlock as UNKNOWN and proceeding (FIX-950)",
    );
    return null;
  }
  try {
    await client.query("SET statement_timeout = '30s'");
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}
