#!/usr/bin/env node
// test-db-query.mjs — FIX-1213
//
// Fixture suite for scripts/lib/db-query-prelude.mjs (what db-query.mjs puts in
// front of the caller's SQL). Dependency-free, no database, same shape as the
// other scripts/test-*.mjs suites.

import { buildPrelude, claimantProblem, sqlLiteral, targetLabel, headerLine, timeoutProblem } from "./lib/db-query-prelude.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("db-query — prelude");

{
  const p = buildPrelude({ call: false, readOnly: true, timeout: "60min" });
  check("plain --prod turns parallelism off, then is read-only, and nothing else (cc-188)",
    p === "SET LOCAL max_parallel_workers_per_gather = 0;\nSET TRANSACTION READ ONLY;\n", JSON.stringify(p));
}
{
  const p = buildPrelude({ call: true, readOnly: false, timeout: "60min" });
  check("--call does NOT touch parallelism (a procedure sets its own)",
    !p.includes("max_parallel_workers_per_gather"), JSON.stringify(p));
}
{
  const p = buildPrelude({ call: false, readOnly: false, timeout: "60min" });
  check("plain --local has no prelude", p === "", JSON.stringify(p));
}
{
  const p = buildPrelude({ call: true, readOnly: false, timeout: "40min" });
  check("--call without --claimant is the FIX-791 prelude, unchanged",
    p === "SET statement_timeout = '40min';\n", JSON.stringify(p));
}
{
  const p = buildPrelude({ call: true, readOnly: false, timeout: "60min", claimant: "FIX-1212 bootstrap" });
  const lines = p.split("\n").filter(Boolean);
  check("--call --claimant adds the SET on its OWN line", lines.length === 2, JSON.stringify(lines));
  check("…after the timeout, so both precede the CALL",
    lines[0] === "SET statement_timeout = '60min';" &&
    lines[1] === "SET civitics.prod_session_claimant = 'FIX-1212 bootstrap';", JSON.stringify(lines));
}
{
  const p = buildPrelude({ call: true, readOnly: false, timeout: "60min", claimant: "Craig's run" });
  check("a quote in the reason is doubled, not a syntax error",
    p.includes("SET civitics.prod_session_claimant = 'Craig''s run';"), JSON.stringify(p));
}
{
  let threw = null;
  try { buildPrelude({ call: false, readOnly: true, timeout: "60min", claimant: "x" }); }
  catch (e) { threw = e; }
  check("--claimant without --call is refused", threw instanceof Error && /only meaningful with --call/.test(threw.message));
}

console.log("db-query — --timeout on a read (FIX-1438)");
{
  const p = buildPrelude({ call: false, readOnly: true, timeout: "30s", timeoutGiven: true });
  const lines = p.split("\n").filter(Boolean);
  check("--prod read with --timeout: SET LOCAL statement_timeout first, then cc-188's two lines",
    lines.length === 3 &&
    lines[0] === "SET LOCAL statement_timeout = '30s';" &&
    lines[1] === "SET LOCAL max_parallel_workers_per_gather = 0;" &&
    lines[2] === "SET TRANSACTION READ ONLY;", JSON.stringify(lines));
}
{
  const p = buildPrelude({ call: false, readOnly: false, timeout: "1s", timeoutGiven: true });
  check("--local read with --timeout: the SET LOCAL alone",
    p === "SET LOCAL statement_timeout = '1s';\n", JSON.stringify(p));
}
{
  const prod = buildPrelude({ call: false, readOnly: true, timeout: "60min", timeoutGiven: false });
  const local = buildPrelude({ call: false, readOnly: false, timeout: "60min", timeoutGiven: false });
  check("a read WITHOUT --timeout is byte-identical to before (the 60min default is --call's)",
    prod === "SET LOCAL max_parallel_workers_per_gather = 0;\nSET TRANSACTION READ ONLY;\n" && local === "",
    JSON.stringify([prod, local]));
}
{
  const p = buildPrelude({ call: true, readOnly: false, timeout: "40min", timeoutGiven: true });
  check("--call with --timeout is unchanged (SET, not SET LOCAL: there is no wrapping transaction)",
    p === "SET statement_timeout = '40min';\n", JSON.stringify(p));
}
check("a bad interval is refused on a read too", timeoutProblem("30 sekunden") !== null && timeoutProblem("1s'; DROP") !== null);
check("…and an absent one (--timeout as the last arg)", timeoutProblem(undefined) !== null);
check("a good interval passes", timeoutProblem("30s") === null && timeoutProblem("90min") === null && timeoutProblem("2h") === null);
check("the refusal text is FIX-791's, unchanged",
  timeoutProblem("x") === "--timeout must be a postgres interval like 60min / 90s / 2h, got: x", timeoutProblem("x"));
{
  const local = headerLine({ label: targetLabel({ target: "local", readOnly: false }), call: false, timeout: "1s", timeoutGiven: true });
  check("the header names a read's timeout", local === "[db-query] LOCAL (127.0.0.1:54322) — statement_timeout=1s", JSON.stringify(local));
  const prod = headerLine({ label: targetLabel({ target: "prod", readOnly: true }), call: false, timeout: "30s", timeoutGiven: true });
  check("…on --prod after READ ONLY", prod === "[db-query] PROD (Supabase Pro) — READ ONLY — statement_timeout=30s", JSON.stringify(prod));
  const bare = headerLine({ label: targetLabel({ target: "prod", readOnly: true }), call: false, timeout: "60min", timeoutGiven: false });
  check("…and not without it", bare === "[db-query] PROD (Supabase Pro) — READ ONLY", JSON.stringify(bare));
}

console.log("db-query — claimant validation");
check("empty is refused (an empty GUC reads as unset)", claimantProblem("") !== null);
check("blank is refused", claimantProblem("   ") !== null);
check("a newline is refused (it would split the SET)", claimantProblem("a\nCALL x()") !== null);
check("a normal reason passes", claimantProblem("FIX-1212 bootstrap (cc-147 runner)") === null);
check("sqlLiteral doubles every quote", sqlLiteral("a'b'c") === "'a''b''c'");

console.log("db-query — the first line (FIX-1301)");
{
  // The label follows readOnly, which is known only once --call is.
  const prodRead = headerLine({ label: targetLabel({ target: "prod", readOnly: true }), call: false, timeout: "60min" });
  check("plain --prod says READ ONLY", prodRead === "[db-query] PROD (Supabase Pro) — READ ONLY", JSON.stringify(prodRead));
  const prodCall = headerLine({ label: targetLabel({ target: "prod", readOnly: false }), call: true, timeout: "60min" });
  check("--prod --call says WRITE PATH, keeping the CALL MODE suffix",
    prodCall === "[db-query] PROD (Supabase Pro) — WRITE PATH — CALL MODE (autocommit, statement_timeout=60min)", JSON.stringify(prodCall));
  check("--prod --call never says READ ONLY", !prodCall.includes("READ ONLY"), JSON.stringify(prodCall));
  const prodClaim = headerLine({ label: targetLabel({ target: "prod", readOnly: false }), call: true, timeout: "40min", claimant: "FIX-1212 bootstrap" });
  check("…and with --claimant",
    prodClaim === "[db-query] PROD (Supabase Pro) — WRITE PATH — CALL MODE (autocommit, statement_timeout=40min, claimant=FIX-1212 bootstrap)", JSON.stringify(prodClaim));
  const local = headerLine({ label: targetLabel({ target: "local", readOnly: false }), call: false, timeout: "60min" });
  check("plain --local is the bare LOCAL label", local === "[db-query] LOCAL (127.0.0.1:54322)", JSON.stringify(local));
  const localCall = headerLine({ label: targetLabel({ target: "local", readOnly: false }), call: true, timeout: "60min" });
  check("--local --call is LOCAL + CALL MODE",
    localCall === "[db-query] LOCAL (127.0.0.1:54322) — CALL MODE (autocommit, statement_timeout=60min)", JSON.stringify(localCall));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
