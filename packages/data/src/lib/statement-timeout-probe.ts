/**
 * FIX-968 — the one place the "is this session actually unarmed?" check lives.
 *
 * WHY THIS IS A SHARED MODULE AND NOT AN INLINE QUERY
 * Every break-glass sweep script does the same thing: `SET statement_timeout = 0`
 * at SESSION level (the only place the 6h postgres-role ceiling can be lifted —
 * neither an in-procedure SET nor ALTER PROCEDURE ... SET re-arms a running
 * timer), then verifies it took before starting hours of work.
 *
 * That verification was written twice and got it wrong the first time:
 *
 *     const armed = await client.query<{ st: string }>("SHOW statement_timeout");
 *     if (armed.rows[0]?.st !== "0") { ...refuse... }
 *
 * `SHOW <setting>` names its result column after the SETTING — the row is
 * `{ statement_timeout: "0" }`, never `{ st: "0" }` — so `.st` was always
 * `undefined`, always `!== "0"`, and donor-rollup-sweep.ts ALWAYS refused to
 * run. The break-glass path for the money rollups was dead from the day it
 * shipped (FIX-944) and only surfaced when FIX-965 needed it. `current_setting()`
 * is an ordinary function call, so `AS st` binds the way the caller expects.
 *
 * The failure mode is silent and identical in both directions — a gate that
 * always refuses looks exactly like a gate that is correctly refusing — so
 * both sweeps now import this rather than hand-rolling it a third time.
 *
 * Tested against a live Postgres in statement-timeout-probe.test.ts: a string
 * assertion cannot catch a column-naming bug, only a real server can.
 */

/**
 * Probe SQL. `current_setting()`, NOT `SHOW` — see the module header.
 * Aliased to `st` so the row shape is stable regardless of the setting name.
 */
export const ARMED_PROBE_SQL = "SELECT current_setting('statement_timeout') AS st";

/** Row shape `ARMED_PROBE_SQL` returns. */
export interface ArmedProbeRow {
  st: string;
}

/**
 * True only when the session's statement_timeout is genuinely disabled.
 *
 * Postgres reports a disabled timeout as the string `"0"` (not `"0ms"`), so the
 * comparison is exact. `undefined` — the shape the broken `SHOW` form produced —
 * is false, which keeps the fail-closed direction: an unreadable setting refuses
 * the sweep rather than starting hours of work that a 6h cancel would truncate.
 */
export function isTimeoutDisarmed(row: ArmedProbeRow | undefined): boolean {
  return row?.st === "0";
}
