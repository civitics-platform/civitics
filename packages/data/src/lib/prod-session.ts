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

  return acquireNamedSessionLock(PROD_SESSION_LOCK_NAME, {
    logTag: "prod-session",
    ref: "FIX-950",
    label: { key: PROD_SESSION_LABEL_KEY, value },
    // The SAME dsn the preflight read. Letting the lock re-resolve buildDbUrl()
    // would let the preflight and the hold land on different databases.
    dbUrl,
  });
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
