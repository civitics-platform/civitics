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
 * Why a --timeout value is unusable, or null when it is fine. A bad interval
 * would otherwise be swallowed by psql at SET time. The shape also keeps the
 * value safe to splice into the SET's quoted literal.
 */
export function timeoutProblem(value) {
  if (!/^[0-9]+\s*(ms|s|min|h|d|second|seconds|minute|minutes|hour|hours)?$/i.test(String(value ?? ""))) {
    return `--timeout must be a postgres interval like 60min / 90s / 2h, got: ${value}`;
  }
  return null;
}

/**
 * The prelude, as the exact text prepended to stdin.
 *
 * `timeoutGiven` is whether --timeout was PASSED. `timeout` always carries a
 * value (the 60min default is --call's), so a read cannot tell a passed value
 * from the default without it.
 *
 * @param {{call: boolean, readOnly: boolean, timeout: string, timeoutGiven?: boolean, claimant?: string|null}} o
 */
export function buildPrelude({ call, readOnly, timeout, timeoutGiven = false, claimant = null }) {
  if (claimant != null && !call) {
    throw new Error("--claimant is only meaningful with --call (a guarded procedure is CALLed, and only --call can run one)");
  }
  if (call) {
    let p = `SET statement_timeout = '${timeout}';\n`;
    if (claimant != null) p += `SET civitics.prod_session_claimant = ${sqlLiteral(claimant)};\n`;
    return p;
  }
  // FIX-1438 — --timeout on a read bounds it. It used to be parsed and dropped,
  // so a prompt's "bounded at 30 s" read ran under the role and gateway caps
  // (cc-299). LOCAL, first inside the --single-transaction wrapper, so it
  // governs every statement after it and nothing outlives the read on a pooled
  // session. Not given: nothing, as before.
  let p = timeoutGiven ? `SET LOCAL statement_timeout = '${timeout}';\n` : "";
  // cc-188 (candidate 236) — an ad-hoc --prod read runs with parallelism OFF.
  // It logs in as `postgres`, whose parallel workers each map a DSM segment;
  // cc-182's census reads hit the 128 MB DSM refusal and were 8 of the 15
  // worst swap-in minutes on the ring. LOCAL scopes it to the
  // --single-transaction wrapper, so nothing outlives the read on a pooled
  // session. A read that wants a parallel plan sets it back itself. Not on
  // --call: a procedure sets its own planner GUCs.
  if (readOnly) p += "SET LOCAL max_parallel_workers_per_gather = 0;\nSET TRANSACTION READ ONLY;\n";
  return p;
}

/**
 * The connection label db-query.mjs prints first. FIX-1301: it follows
 * `readOnly`, not the target. It used to be fixed when the prod URL was
 * resolved, before anything knew about --call, so the one prod WRITE path
 * announced itself as "READ ONLY — CALL MODE" above its own write banner.
 *
 * @param {{target: "local"|"prod", readOnly: boolean}} o
 */
export function targetLabel({ target, readOnly }) {
  if (target === "local") return "LOCAL (127.0.0.1:54322)";
  return readOnly ? "PROD (Supabase Pro) — READ ONLY" : "PROD (Supabase Pro) — WRITE PATH";
}

/** The first line db-query.mjs prints, to stderr. FIX-1438: a read names a passed --timeout. */
export function headerLine({ label, call, timeout, timeoutGiven = false, claimant = null }) {
  if (!call) return `[db-query] ${label}${timeoutGiven ? ` — statement_timeout=${timeout}` : ""}`;
  return `[db-query] ${label} — CALL MODE (autocommit, statement_timeout=${timeout}${claimant !== null ? `, claimant=${claimant}` : ""})`;
}
