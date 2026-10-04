// db-query-prelude.mjs — the statements db-query.mjs sends in FRONT of the
// caller's SQL. Pure, so scripts/test-db-query.mjs can assert the exact lines.
//
// FIX-1213 — `--claimant "<reason>"` adds
//     SET civitics.prod_session_claimant = '<reason>';
// on its OWN line under --call. psql sends each `;`-terminated statement of
// stdin as its own simple query when --single-transaction is off, so the SET
// and the CALL arrive as two statements — never one multi-statement string,
// which is an implicit transaction block in which a COMMITting procedure dies
// at its first COMMIT (FIX-1128). And the SET is IN FRONT of the CALL, which is
// the only place a session setting can reach the guard (rule 109).

/** A single-quoted SQL literal. standard_conforming_strings is on everywhere we connect. */
export function sqlLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Why a claimant value is unusable, or null when it is fine. One line, because
 * the value is interpolated into a psql stdin line and a newline would split
 * the SET; non-empty, because an empty value reads as "unset" to the reader.
 */
export function claimantProblem(value) {
  if (typeof value !== "string" || value.trim() === "") return "--claimant needs a non-empty value (the claim's reason)";
  if (/[\r\n\0]/.test(value)) return "--claimant must be one line";
  if (value.length > 300) return "--claimant is longer than the 300-char claim reason it must match";
  return null;
}

/**
 * The prelude, as the exact text prepended to stdin.
 *
 * @param {{call: boolean, readOnly: boolean, timeout: string, claimant?: string|null}} o
 */
export function buildPrelude({ call, readOnly, timeout, claimant = null }) {
  if (claimant != null && !call) {
    throw new Error("--claimant is only meaningful with --call (a guarded procedure is CALLed, and only --call can run one)");
  }
  if (call) {
    let p = `SET statement_timeout = '${timeout}';\n`;
    if (claimant != null) p += `SET civitics.prod_session_claimant = ${sqlLiteral(claimant)};\n`;
    return p;
  }
  // cc-188 (candidate 236) — an ad-hoc --prod read runs with parallelism OFF.
  // It logs in as `postgres`, whose parallel workers each map a DSM segment;
  // cc-182's census reads hit the 128 MB DSM refusal and were 8 of the 15
  // worst swap-in minutes on the ring. LOCAL scopes it to the
  // --single-transaction wrapper, so nothing outlives the read on a pooled
  // session. A read that wants a parallel plan sets it back itself. Not on
  // --call: a procedure sets its own planner GUCs.
  return readOnly
    ? "SET LOCAL max_parallel_workers_per_gather = 0;\nSET TRANSACTION READ ONLY;\n"
    : "";
}
