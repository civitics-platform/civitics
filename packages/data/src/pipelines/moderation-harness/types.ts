// SF-P3 shadow moderation harness (FIX-601) — types.
//
// Each fixture instantiates synthetic bad behavior INSIDE a transaction, computes
// what the live deterministic moderation rules would do, and returns a verdict.
// The harness rolls the fixture content back and writes one moderation_audit row.
// Fixtures NEVER write outside the rolled-back transaction and never confer
// consequence.

/**
 * Expectation tier (state-of-franklin-bible §11.1):
 *  - 'handled' — a live rule catches it; expected verdict is MATCH. A flip to
 *                MISMATCH is a REGRESSION (CI fails).
 *  - 'partial' — only a sub-rule is evaluable in a DB harness; the evaluable part
 *                is expected MATCH. Notes flag the unevaluable remainder.
 *  - 'gap'     — no detector exists; expected MISMATCH, logged as known-failing
 *                (drives SF-P4/P5/P10). CI does NOT fail on these.
 */
export type Expectation = "handled" | "partial" | "gap";

export interface RaiseResult {
  raised: boolean;
  /** Postgres SQLSTATE, if it raised. */
  code?: string;
  message?: string;
}

/**
 * Per-fixture execution context. The harness opens a transaction, hands this to
 * `Fixture.run`, then rolls back. All `query`s run inside that transaction.
 */
export interface TxContext {
  /** Run a query inside the fixture's open transaction. */
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  /**
   * Create an ephemeral, NON-synthetic user (auth.users + public.users) so the
   * live standing/scorer rules actually evaluate it. Rolled back with the txn —
   * never persists, so no real standing is ever conferred. Returns the user id.
   */
  createUser: (label?: string) => Promise<string>;
  /**
   * Impersonate a user for auth.uid()-gated RPCs by setting a txn-local
   * request.jwt.claims GUC (vanishes on rollback).
   */
  impersonate: (userId: string) => Promise<void>;
  /**
   * Run a statement that is EXPECTED to RAISE, isolated in a SAVEPOINT so the
   * transaction is not poisoned. Returns whether it raised + the SQLSTATE.
   */
  expectRaise: (sql: string, params?: unknown[]) => Promise<RaiseResult>;
}

export interface FixtureResult {
  /** Short machine-ish string describing what the live rule actually did. */
  computedVerdict: string;
  /** Did the computed verdict satisfy the fixture's expectation? */
  match: boolean;
  /** Free-text context — REQUIRED for partial/gap rows (what's unevaluable / why). */
  notes?: string;
}

export interface Fixture {
  /** 'F1'..'F12'. */
  id: string;
  title: string;
  /** The live surface evaluated (function/trigger name). */
  ruleId: string;
  expectation: Expectation;
  /** Human-readable expected verdict, logged verbatim. */
  expectedVerdict: string;
  run: (tx: TxContext) => Promise<FixtureResult>;
}

export interface AuditRow {
  fixtureId: string;
  ruleId: string;
  expectation: Expectation;
  expectedVerdict: string;
  computedVerdict: string;
  match: boolean;
  notes: string | null;
}

export interface HarnessReport {
  ranAt: string;
  durationMs: number;
  dbHost: string;
  sha: string;
  rows: AuditRow[];
  /** Zero-pollution proof: row counts of mutable tables before vs after the run. */
  pollution: {
    table: string;
    before: number;
    after: number;
    delta: number;
  }[];
  summary: {
    total: number;
    matches: number;
    mismatches: number;
    /** A handled/partial fixture that produced match=false — a real regression. */
    regressions: number;
    /** A gap fixture producing match=false — expected, known-failing. */
    knownFailing: number;
  };
}
