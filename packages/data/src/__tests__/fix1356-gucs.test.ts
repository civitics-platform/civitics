/**
 * FIX-1356 (cc-252) — `*_fix1356_parallel_zero_hash_mem_one.sql` and its revert
 * `scripts/fix1356-revert-parallel-hash.sql`: max_parallel_workers_per_gather = 0
 * and hash_mem_multiplier = 1 on the postgres and authenticator login roles.
 *
 * Runs via:  tsx --test src/__tests__/fix1356-gucs.test.ts
 *
 * Source anchors (no DB, run in CI):
 *   - the file parses as written: its only top-level statements are the four
 *     ALTER ROLEs and the read-back DO block, every dollar quote closed;
 *   - the four statements name exactly the two roles × the two parameters, IN
 *     DATABASE postgres, at 0 and 1;
 *   - the read-back asserts both values on both roles AND that M1's
 *     statement_timeout=3h / work_mem=64MB survived on postgres;
 *   - the revert restores cc-252 read 2's prior state (the fixture): neither
 *     parameter had an entry on either role, so each comes back with RESET and
 *     nothing is SET; it asserts postgres@postgres reads exactly M1's array.
 * Behavioural, against the clone when the file is applied there
 * (CIVITICS_CLONE_TESTS=1): the role rows carry the values, and a NEW postgres
 * login reads them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1356_parallel_zero_hash_mem_one.sql";
const REVERT = path.join(ROOT, "scripts", "fix1356-revert-parallel-hash.sql");
const LOCAL_URL =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** cc-252 read 2 (prod, 2026-10-28 00:47Z): pg_db_role_setting for the two roles in database postgres. */
const PRIOR: Record<string, string[] | null> = {
  postgres: ["statement_timeout=3h", "work_mem=64MB"],
  authenticator: null,
};
const ROLES = ["postgres", "authenticator"];
const TARGET: Record<string, string> = { max_parallel_workers_per_gather: "0", hash_mem_multiplier: "1" };

const FILE = () => {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
};

/** Top-level statements: DO blocks collapsed to `DO`, comments stripped, split on `;`. */
function topLevel(sql: string): string[] {
  const noDo = stripComments(sql).replace(/DO \$\$[\s\S]*?\$\$;/g, "DO;");
  return noDo.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const ALTER_RE = /^ALTER ROLE (\w+) IN DATABASE postgres (SET|RESET) (\w+)(?: = (\S+))?$/;

test("the file parses as written: four ALTER ROLEs and the read-back DO block, every dollar quote closed", () => {
  const sql = FILE();
  assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0, "unbalanced $$");
  const stmts = topLevel(sql);
  assert.deepEqual(stmts.filter((s) => s !== "DO" && !ALTER_RE.test(s)), [], "a statement that is neither");
  assert.equal(stmts.filter((s) => s === "DO").length, 1);
  assert.equal(stmts.filter((s) => ALTER_RE.test(s)).length, 4);
});

test("the four statements are exactly the two roles × the two parameters, SET to 0 and 1", () => {
  const got = topLevel(FILE())
    .map((s) => s.match(ALTER_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[1]} ${m[2]} ${m[3]}=${m[4]}`)
    .sort();
  const want = ROLES.flatMap((r) => Object.entries(TARGET).map(([p, v]) => `${r} SET ${p}=${v}`)).sort();
  assert.deepEqual(got, want);
});

test("the read-back asserts both values on both roles, and M1's two settings on postgres", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes("FOREACH v_role IN ARRAY ARRAY['postgres', 'authenticator'] LOOP"));
  assert.ok(sql.includes("WHERE r.rolname = v_role AND d.datname = 'postgres';"));
  for (const [p, v] of Object.entries(TARGET)) assert.ok(sql.includes(`NOT ('${p}=${v}' = ANY (cfg))`), p);
  for (const kept of PRIOR["postgres"] ?? []) assert.ok(sql.includes(`NOT ('${kept}' = ANY (cfg))`), kept);
  assert.equal((sql.match(/RAISE EXCEPTION/g) ?? []).length, 4);
  assert.doesNotMatch(sql, /\bRESET\b/, "the forward file never RESETs");
  assert.doesNotMatch(sql, /ALTER (DATABASE|SYSTEM)/, "role-level only");
});

test("the revert restores read 2's prior state: a missing entry → RESET, nothing SET", () => {
  const rv = read(REVERT);
  const stmts = topLevel(rv)
    .map((s) => s.match(ALTER_RE))
    .filter((m): m is RegExpMatchArray => m !== null);
  assert.equal(stmts.length, 4);
  for (const role of ROLES) {
    for (const p of Object.keys(TARGET)) {
      const prior = (PRIOR[role] ?? []).find((e) => e.startsWith(`${p}=`));
      const m = stmts.find((s) => s[1] === role && s[3] === p);
      assert.ok(m, `${role} ${p}: no statement`);
      if (prior) assert.equal(`${m[2]} ${m[4]}`, `SET ${prior.split("=")[1]}`, `${role} ${p}: SET back`);
      else assert.equal(m[2], "RESET", `${role} ${p}: no prior entry → RESET`);
    }
  }
  const code = stripComments(rv);
  assert.ok(code.includes("IF v_pg IS DISTINCT FROM ARRAY['statement_timeout=3h', 'work_mem=64MB'] THEN"));
  assert.ok(code.includes("IF v_auth IS NOT NULL THEN"), "authenticator had no db row");
  assert.ok(rv.includes("--prod --call --yes-i-mean-prod --file scripts/fix1356-revert-parallel-hash.sql"));
});

test("clone: both role rows carry the values, and a new postgres login reads them", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_URL });
  try {
    await c.connect();
  } catch {
    t.skip("local clone unreachable");
    return;
  }
  try {
    const rows = (await c.query<{ role: string; cfg: string[] }>(
      `SELECT r.rolname AS role, s.setconfig AS cfg FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = 'postgres' AND r.rolname = ANY ($1)`,
      [ROLES],
    )).rows;
    if (!rows.some((r) => r.cfg.includes("hash_mem_multiplier=1"))) {
      t.skip("FIX-1356 not applied on the clone");
      return;
    }
    for (const role of ROLES) {
      const cfg = rows.find((r) => r.role === role)?.cfg ?? [];
      for (const [p, v] of Object.entries(TARGET)) assert.ok(cfg.includes(`${p}=${v}`), `${role}: ${JSON.stringify(cfg)}`);
    }
    // c logged in as postgres after the apply, so it reads the role values.
    const s = (await c.query<{ h: string; p: string }>(
      "SELECT current_setting('hash_mem_multiplier') AS h, current_setting('max_parallel_workers_per_gather') AS p",
    )).rows[0];
    assert.deepEqual(s, { h: "1", p: "0" });
  } finally {
    await c.end();
  }
});
