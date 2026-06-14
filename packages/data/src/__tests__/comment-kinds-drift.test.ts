/**
 * FIX-543 — drift guard for the duplicated comment-kind vocabulary + rate caps.
 *
 * Runs via:  tsx --test src/__tests__/comment-kinds-drift.test.ts
 *            (covered by the existing CI `@civitics/data test` invocation)
 *
 * The per-entity-type comment-kind allowlist and the per-day rate caps are
 * hand-duplicated in two places that MUST stay identical or submit_comment's
 * defense-in-depth diverges from the app-layer vocabulary (the vocab already
 * changed in FIX-526 and FIX-536 — same class as FIX-407's source_priority):
 *
 *   1. SQL — the v_allowed CASE arms + the rate-limit guards in the latest
 *            migration that (re)defines public.submit_comment (currently
 *            20260610000100_comment_answer_rate_limit.sql, FIX-542).
 *   2. TS  — ALLOWED_KINDS / ALL_KINDS and RATE_LIMITS.comments/.answers in
 *            packages/db/src/comment-kinds.ts.
 *
 * Mirrors the FIX-407 drift test exactly: parse both source files as TEXT from
 * disk (no shared module, no codegen — this test is the safety net), and scan
 * every migration so a future submit_comment redefinition keeps the guard
 * pointed at the live definition instead of going stale.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Walk up from this file until we find the repo root (the dir that holds
// supabase/migrations). Robust against the test file being relocated.
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "supabase", "migrations"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (no supabase/migrations ancestor)");
}

const REPO_ROOT = findRepoRoot();
const TS_REL = join("packages", "db", "src", "comment-kinds.ts");

/** The LAST migration that (re)defines public.<fnName>, sliced to its LAST
 *  definition within that file. Generalized (FIX-569) so the guard follows
 *  set_entity_position / set_statement_vote as well as submit_comment — each to
 *  whichever migration last (re)defines it. */
function latestMigrationDefining(fnName: string): { file: string; text: string } {
  const migrationsDir = join(REPO_ROOT, "supabase", "migrations");
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // timestamp-prefixed → lexical sort is chronological

  const defRe = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\b`,
    "gi",
  );
  for (const file of [...sqlFiles].reverse()) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    let defIdx = -1;
    for (let m = defRe.exec(text); m; m = defRe.exec(text)) defIdx = m.index;
    defRe.lastIndex = 0;
    if (defIdx >= 0) return { file, text: text.slice(defIdx) };
  }
  throw new Error(`no migration defines public.${fnName}()`);
}

function latestSubmitCommentSql(): { file: string; text: string } {
  return latestMigrationDefining("submit_comment");
}

/** Parse the SQL v_allowed CASE arms into entity_type → ordered kind list. */
function parseSqlKinds(sql: string, file: string): Record<string, string[]> {
  const caseBlock = sql.match(/v_allowed\s*:=\s*CASE\s+p_entity_type([\s\S]*?)\bEND\s*;/i);
  assert.ok(caseBlock, `no "v_allowed := CASE p_entity_type ... END;" block in ${file}`);

  const kinds: Record<string, string[]> = {};
  const armRe = /WHEN\s+'([^']+)'\s+THEN\s+ARRAY\[([\s\S]*?)\]/gi;
  for (let m = armRe.exec(caseBlock[1]); m; m = armRe.exec(caseBlock[1])) {
    kinds[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1]);
  }
  return kinds;
}

/** Parse the SQL rate-limit guards. The cap number is taken from the IF guard
 *  itself, anchored to which limit it is by the RAISE message that follows. */
function parseSqlCaps(sql: string, file: string): { comments: number; answers: number } {
  const answer = sql.match(
    /IF\s+v_today\s*>=\s*(\d+)\s+THEN\s*RAISE\s+EXCEPTION\s+'daily answer limit reached/i,
  );
  const comment = sql.match(
    /IF\s+v_today\s*>=\s*(\d+)\s+THEN\s*RAISE\s+EXCEPTION\s+'daily comment limit reached/i,
  );
  assert.ok(answer, `no answer rate-limit guard found in ${file}`);
  assert.ok(comment, `no comment rate-limit guard found in ${file}`);
  return { comments: Number(comment[1]), answers: Number(answer[1]) };
}

/** Parse a `<var> := <n>;` cap assignment. The FIX-569 caps live in a local
 *  variable (halved later), not in the IF guard, so the cap value is the FIRST
 *  numeric assignment — the `<var> := <var> / 2;` halving line has no digit
 *  immediately after `:=`, so it never matches. */
function parseAssignedCap(sql: string, varName: string, file: string): number {
  const m = sql.match(new RegExp(`${varName}\\s*:=\\s*(\\d+)\\s*;`));
  assert.ok(m, `no \`${varName} := <n>;\` assignment found in ${file}`);
  return Number(m[1]);
}

/** Parse RATE_LIMITS.positions / .statement_votes out of comment-kinds.ts (the
 *  FIX-569 caps). Line comments are stripped first so prose can't false-match. */
function parseTsBotCaps(): { positions: number; statement_votes: number } {
  const text = readFileSync(join(REPO_ROOT, TS_REL), "utf8").replace(/\/\/[^\n]*/g, "");
  const rateBlock = text.match(/export\s+const\s+RATE_LIMITS\s*=\s*\{([\s\S]*?)\}\s*as\s+const/);
  assert.ok(rateBlock, `could not locate RATE_LIMITS in ${TS_REL}`);
  const positions = rateBlock[1].match(/positions:\s*(\d+)/);
  const statementVotes = rateBlock[1].match(/statement_votes:\s*(\d+)/);
  assert.ok(positions, `RATE_LIMITS.positions missing in ${TS_REL}`);
  assert.ok(statementVotes, `RATE_LIMITS.statement_votes missing in ${TS_REL}`);
  return { positions: Number(positions[1]), statement_votes: Number(statementVotes[1]) };
}

/** Parse ALL_KINDS + ALLOWED_KINDS + RATE_LIMITS out of comment-kinds.ts as
 *  text. Line comments are stripped first so prose can't false-match. */
function parseTs(): {
  kinds: Record<string, string[]>;
  caps: { comments: number; answers: number };
} {
  const text = readFileSync(join(REPO_ROOT, TS_REL), "utf8").replace(/\/\/[^\n]*/g, "");

  const allKindsBlock = text.match(/const\s+ALL_KINDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  assert.ok(allKindsBlock, `could not locate ALL_KINDS in ${TS_REL}`);
  const allKinds = [...allKindsBlock[1].matchAll(/"([^"]+)"/g)].map((k) => k[1]);

  const allowedBlock = text.match(
    /export\s+const\s+ALLOWED_KINDS[^=]*=\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(allowedBlock, `could not locate ALLOWED_KINDS in ${TS_REL}`);

  const kinds: Record<string, string[]> = {};
  const entryRe = /(\w+):\s*(ALL_KINDS|\[[^\]]*\])/g;
  for (let m = entryRe.exec(allowedBlock[1]); m; m = entryRe.exec(allowedBlock[1])) {
    kinds[m[1]] =
      m[2] === "ALL_KINDS" ? allKinds : [...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]);
  }

  const rateBlock = text.match(/export\s+const\s+RATE_LIMITS\s*=\s*\{([\s\S]*?)\}\s*as\s+const/);
  assert.ok(rateBlock, `could not locate RATE_LIMITS in ${TS_REL}`);
  const comments = rateBlock[1].match(/comments:\s*(\d+)/);
  const answers = rateBlock[1].match(/answers:\s*(\d+)/);
  assert.ok(comments, `RATE_LIMITS.comments missing in ${TS_REL}`);
  assert.ok(answers, `RATE_LIMITS.answers missing in ${TS_REL}`);

  return { kinds, caps: { comments: Number(comments[1]), answers: Number(answers[1]) } };
}

test("FIX-543 submit_comment SQL kind vocab matches ALLOWED_KINDS", () => {
  const sql = latestSubmitCommentSql();
  const sqlKinds = parseSqlKinds(sql.text, sql.file);
  const ts = parseTs();

  // Guard against a broken parser silently producing two empty maps that would
  // deep-equal each other and pass vacuously.
  assert.ok(
    Object.keys(sqlKinds).length >= 6,
    `SQL parse produced too few entity types (${Object.keys(sqlKinds).length}) from ${sql.file} — parser likely broke`,
  );
  assert.ok(
    Object.keys(ts.kinds).length >= 6,
    `TS parse produced too few entity types (${Object.keys(ts.kinds).length}) from ${TS_REL} — parser likely broke`,
  );
  assert.ok(
    (ts.kinds.proposal ?? []).length >= 8,
    `TS proposal vocab suspiciously small — ALL_KINDS parse likely broke`,
  );
  for (const [entityType, list] of Object.entries(sqlKinds)) {
    assert.ok(list.length > 0, `SQL vocab for ${entityType} parsed empty (${sql.file})`);
  }

  assert.deepEqual(
    sqlKinds,
    ts.kinds,
    `comment-kind drift: SQL v_allowed (${sql.file}) and ALLOWED_KINDS (${TS_REL}) disagree.\n` +
      `  SQL: ${JSON.stringify(sqlKinds)}\n` +
      `  TS:  ${JSON.stringify(ts.kinds)}`,
  );
});

test("FIX-543 submit_comment SQL rate caps match RATE_LIMITS", () => {
  const sql = latestSubmitCommentSql();
  const sqlCaps = parseSqlCaps(sql.text, sql.file);
  const ts = parseTs();

  assert.deepEqual(
    sqlCaps,
    ts.caps,
    `rate-cap drift: SQL guards (${sql.file}) and RATE_LIMITS (${TS_REL}) disagree.\n` +
      `  SQL: ${JSON.stringify(sqlCaps)}\n` +
      `  TS:  ${JSON.stringify(ts.caps)}`,
  );
});

test("FIX-569 bot-protection caps (set_entity_position / set_statement_vote) match RATE_LIMITS", () => {
  // The two caps live in DIFFERENT functions than submit_comment, each in its
  // own latest-defining migration (20260613000000 today). Follow each by name so
  // a future redefinition keeps the guard pointed at the live definition.
  const posSql = latestMigrationDefining("set_entity_position");
  const voteSql = latestMigrationDefining("set_statement_vote");
  const ts = parseTsBotCaps();

  const positions = parseAssignedCap(posSql.text, "v_pos_cap", posSql.file);
  const statementVotes = parseAssignedCap(voteSql.text, "v_vote_cap", voteSql.file);

  assert.equal(
    positions,
    ts.positions,
    `positions-cap drift: set_entity_position (${posSql.file}) v_pos_cap=${positions} ` +
      `vs RATE_LIMITS.positions=${ts.positions} (${TS_REL}).`,
  );
  assert.equal(
    statementVotes,
    ts.statement_votes,
    `statement_votes-cap drift: set_statement_vote (${voteSql.file}) v_vote_cap=${statementVotes} ` +
      `vs RATE_LIMITS.statement_votes=${ts.statement_votes} (${TS_REL}).`,
  );
});

/** Parse RATE_LIMITS.investigations / .evidence_cards + the
 *  MAX_OPEN_INVESTIGATIONS_PER_USER const out of comment-kinds.ts (FIX-577).
 *  Line comments are stripped first so prose can't false-match. */
function parseTsInvestigationCaps(): {
  investigations: number;
  evidence_cards: number;
  open: number;
} {
  const text = readFileSync(join(REPO_ROOT, TS_REL), "utf8").replace(/\/\/[^\n]*/g, "");
  const rateBlock = text.match(/export\s+const\s+RATE_LIMITS\s*=\s*\{([\s\S]*?)\}\s*as\s+const/);
  assert.ok(rateBlock, `could not locate RATE_LIMITS in ${TS_REL}`);
  const inv = rateBlock[1].match(/investigations:\s*(\d+)/);
  const card = rateBlock[1].match(/evidence_cards:\s*(\d+)/);
  const open = text.match(/MAX_OPEN_INVESTIGATIONS_PER_USER\s*=\s*(\d+)/);
  assert.ok(inv, `RATE_LIMITS.investigations missing in ${TS_REL}`);
  assert.ok(card, `RATE_LIMITS.evidence_cards missing in ${TS_REL}`);
  assert.ok(open, `MAX_OPEN_INVESTIGATIONS_PER_USER missing in ${TS_REL}`);
  return { investigations: Number(inv[1]), evidence_cards: Number(card[1]), open: Number(open[1]) };
}

test("FIX-577 investigations caps (create_investigation / add_evidence_card) match comment-kinds.ts", () => {
  // The investigation caps live in their own latest-defining migrations
  // (20260614000100 today). Follow each RPC by name so a future redefinition keeps
  // the guard on the live definition. v_open_cap / v_daily_cap live in
  // create_investigation; v_card_daily_cap in add_evidence_card — parseAssignedCap
  // takes the FIRST `<var> := <n>;` so the `v_open_cap := v_open_cap / 2;` halving
  // line (no digit after :=) never matches.
  const invSql = latestMigrationDefining("create_investigation");
  const cardSql = latestMigrationDefining("add_evidence_card");
  const ts = parseTsInvestigationCaps();

  const sqlOpen = parseAssignedCap(invSql.text, "v_open_cap", invSql.file);
  const sqlInvDaily = parseAssignedCap(invSql.text, "v_daily_cap", invSql.file);
  const sqlCardDaily = parseAssignedCap(cardSql.text, "v_card_daily_cap", cardSql.file);

  assert.equal(
    sqlOpen,
    ts.open,
    `open-investigation cap drift: create_investigation (${invSql.file}) v_open_cap=${sqlOpen} ` +
      `vs MAX_OPEN_INVESTIGATIONS_PER_USER=${ts.open} (${TS_REL}).`,
  );
  assert.equal(
    sqlInvDaily,
    ts.investigations,
    `investigations daily-cap drift: create_investigation (${invSql.file}) v_daily_cap=${sqlInvDaily} ` +
      `vs RATE_LIMITS.investigations=${ts.investigations} (${TS_REL}).`,
  );
  assert.equal(
    sqlCardDaily,
    ts.evidence_cards,
    `evidence_cards daily-cap drift: add_evidence_card (${cardSql.file}) v_card_daily_cap=${sqlCardDaily} ` +
      `vs RATE_LIMITS.evidence_cards=${ts.evidence_cards} (${TS_REL}).`,
  );
});
