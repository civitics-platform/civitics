#!/usr/bin/env node
// test-check-proconfig.mjs — FIX-1128
//
// Fixture suite for scripts/check-proconfig-timeouts.mjs. Dependency-free, no
// database, same shape as the other scripts/test-*.mjs suites.
//
// The four cases the design named, plus the ALTER form and the masking edge
// cases that decide whether the scanner can tell a header from a body.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSql, maskNonCode, BASELINE_MIGRATION } from "./check-proconfig-timeouts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "proconfig");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const fixture = (f) => scanSql(readFileSync(join(FIXTURES, f), "utf8"));

console.log("check:proconfig — fixtures");

// ── the four the design named ───────────────────────────────────────────────
{
  const hits = fixture("01_pattern_fails.sql");
  const undeclared = hits.filter((h) => !h.waiver);
  check("a migration with the pattern FAILS", undeclared.length === 1,
    `got ${undeclared.length} undeclared hit(s): ${JSON.stringify(hits)}`);
  check("…and it is reported as a CREATE FUNCTION hit",
    undeclared[0]?.kind === "CREATE FUNCTION", `kind=${undeclared[0]?.kind}`);
  check("…on the statement_timeout line, not the search_path line",
    undeclared[0]?.snippet.includes("statement_timeout"), `snippet=${undeclared[0]?.snippet}`);
}
{
  const hits = fixture("02_annotated_passes.sql");
  check("the annotated form PASSES", hits.every((h) => h.waiver),
    JSON.stringify(hits));
  check("…and the reason is carried through",
    hits[0]?.waiver?.startsWith("deliberate"), `waiver=${hits[0]?.waiver}`);
}
{
  const hits = fixture("03_standalone_set_passes.sql");
  check("standalone SET / set_config / RESET / ALTER ROLE all PASS",
    hits.length === 0, JSON.stringify(hits));
}
{
  const hits = fixture("04_procedure_fails.sql");
  const undeclared = hits.filter((h) => !h.waiver);
  check("a PROCEDURE with the pattern FAILS", undeclared.length === 1, JSON.stringify(hits));
  check("…and is reported as a CREATE PROCEDURE hit",
    undeclared[0]?.kind === "CREATE PROCEDURE", `kind=${undeclared[0]?.kind}`);
}
{
  const hits = fixture("05_alter_fails.sql");
  const undeclared = hits.filter((h) => !h.waiver);
  check("the ALTER FUNCTION … SET form FAILS", undeclared.length === 1, JSON.stringify(hits));
  check("…and is reported as an ALTER FUNCTION hit",
    undeclared[0]?.kind === "ALTER FUNCTION", `kind=${undeclared[0]?.kind}`);
}

// ── masking: the distinction the whole scanner rests on ─────────────────────
{
  const body = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET statement_timeout = '5s';
END $$;`;
  check("a SET inside a routine BODY is not a hit", scanSql(body).length === 0);
}
{
  const commented = `-- SET statement_timeout = '5s' in a comment
CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`;
  check("a SET inside a comment is not a hit", scanSql(commented).length === 0);
}
{
  const stringy = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET statement_timeout = ''5s''';
END $$;`;
  check("a SET inside a quoted string is not a hit", scanSql(stringy).length === 0);
}
{
  const reset = `ALTER FUNCTION public.f() RESET statement_timeout;`;
  check("RESET is never a hit", scanSql(reset).length === 0);
}
{
  const { code } = maskNonCode(`SELECT 'a$$b', $tag$ SET statement_timeout $tag$;`);
  check("masking preserves length (offsets map back to real lines)",
    code.length === `SELECT 'a$$b', $tag$ SET statement_timeout $tag$;`.length);
}

// ── the baseline ────────────────────────────────────────────────────────────
{
  const migrations = readdirSync(join(HERE, "..", "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"));
  check("the baseline migration exists on disk",
    migrations.includes(BASELINE_MIGRATION), BASELINE_MIGRATION);
  const after = migrations.filter((f) => f > BASELINE_MIGRATION);
  const hits = after.flatMap((f) =>
    scanSql(readFileSync(join(HERE, "..", "supabase", "migrations", f), "utf8"))
      .filter((h) => !h.waiver).map((h) => `${f}:${h.line}`));
  check("the tree after the baseline is clean", hits.length === 0, hits.join(", "));
  // The history is expected to be dirty — that is why the baseline exists.
  const historyHits = migrations.filter((f) => f <= BASELINE_MIGRATION).flatMap((f) =>
    scanSql(readFileSync(join(HERE, "..", "supabase", "migrations", f), "utf8"))
      .filter((h) => !h.waiver));
  check("history DOES carry the pattern, so the baseline is load bearing",
    historyHits.length > 0, `found ${historyHits.length}`);
}

console.log(`\ncheck:proconfig fixtures — ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
