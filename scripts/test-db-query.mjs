#!/usr/bin/env node
// test-db-query.mjs — FIX-1213
//
// Fixture suite for scripts/lib/db-query-prelude.mjs (what db-query.mjs puts in
// front of the caller's SQL). Dependency-free, no database, same shape as the
// other scripts/test-*.mjs suites.

import { buildPrelude, claimantProblem, sqlLiteral } from "./lib/db-query-prelude.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("db-query — prelude");

{
  const p = buildPrelude({ call: false, readOnly: true, timeout: "60min" });
  check("plain --prod is read-only and nothing else", p === "SET TRANSACTION READ ONLY;\n", JSON.stringify(p));
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

console.log("db-query — claimant validation");
check("empty is refused (an empty GUC reads as unset)", claimantProblem("") !== null);
check("blank is refused", claimantProblem("   ") !== null);
check("a newline is refused (it would split the SET)", claimantProblem("a\nCALL x()") !== null);
check("a normal reason passes", claimantProblem("FIX-1212 bootstrap (cc-147 runner)") === null);
check("sqlLiteral doubles every quote", sqlLiteral("a'b'c") === "'a''b''c'");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
