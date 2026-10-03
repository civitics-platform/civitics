/**
 * FIX-1257 — the status rank and advance rule, pinned to the SQL they mirror.
 *
 * status-rank.ts is a TS copy of `public.proposal_status_rank()` and
 * `public.proposal_status_advances()`. The migrations are read as text from
 * disk (the FIX-1247 naics-sector-label drift-test pattern): the LAST migration
 * that defines each function is the live definition, and the TS rank table and
 * the rule's three status sets must equal it. A rank changed in SQL without TS
 * — or the reverse — fails here instead of the sync counting one thing and the
 * database doing another.
 *
 * Then the rule itself, as a table (rule 105: the wrong-but-green shapes are
 * named — a LOWER rank is a no-op; a terminal is accepted from any stage; an
 * introduced after failed is noise; law beats a minted failed).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPOSAL_STATUS_RANK,
  TERMINAL_STATUSES,
  NEGATIVE_FINAL_STATUSES,
  LAW_OUTCOMES,
  statusAdvances,
  type ProposalStatus,
} from "./status-rank";

const REPO = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATIONS = join(REPO, "supabase", "migrations");
const RANK_FN = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.proposal_status_rank\s*\(/i;
const RULE_FN = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.proposal_status_advances\s*\(/i;

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** The newest migration whose text defines `fn`, comment-stripped. */
function latestDefining(fn: RegExp): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, files[i]!), "utf8"));
    if (fn.test(sql)) return { file: files[i]!, sql };
  }
  throw new Error(`no migration defines ${fn}`);
}

/** The function's body: from the CREATE to the closing `$$;`. */
function body(sql: string, fn: RegExp): string {
  const start = sql.search(fn);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  assert.ok(start >= 0 && open > start && close > open, `could not find the body of ${fn}`);
  return sql.slice(open + 2, close);
}

function parseRank(sql: string): Record<string, number> {
  const arms: Record<string, number> = {};
  for (const m of body(sql, RANK_FN).matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+(\d+)/g)) {
    arms[m[1]!] = Number(m[2]);
  }
  return arms;
}

/** The rule's three IN-lists, in the order the body states them. */
function parseRuleSets(sql: string): { terminal: string[]; negativeFinal: string[]; law: string[] } {
  const lists = [...body(sql, RULE_FN).matchAll(/\bIN\s*\(([^)]*)\)/g)].map((m) =>
    [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort(),
  );
  // (b) twice (to IN terminal, from IN terminal), then (c) (from IN negative-final, to IN law).
  assert.equal(lists.length, 4, `expected 4 IN-lists in proposal_status_advances, parsed ${lists.length}`);
  assert.deepEqual(lists[0], lists[1], "rule (b) names two different terminal sets");
  return { terminal: lists[0]!, negativeFinal: lists[2]!, law: lists[3]! };
}

const sorted = (s: ReadonlySet<string>) => [...s].sort();

test("FIX-1257 the TS rank equals the SQL CASE in the latest migration", () => {
  const { file, sql } = latestDefining(RANK_FN);
  const arms = parseRank(sql);
  assert.equal(Object.keys(arms).length, 16, `${file}: expected 16 arms, parsed ${Object.keys(arms).length}`);
  assert.deepEqual(arms, { ...PROPOSAL_STATUS_RANK }, `${file}: proposal_status_rank() differs from status-rank.ts`);
});

test("FIX-1257 the TS rule's status sets equal the SQL rule's", () => {
  const { file, sql } = latestDefining(RULE_FN);
  const sets = parseRuleSets(sql);
  assert.deepEqual(sets.terminal, sorted(TERMINAL_STATUSES), `${file}: terminal set differs`);
  assert.deepEqual(sets.negativeFinal, sorted(NEGATIVE_FINAL_STATUSES), `${file}: negative-final set differs`);
  assert.deepEqual(sets.law, sorted(LAW_OUTCOMES), `${file}: law-outcome set differs`);
});

test("FIX-1257 the parser sees a one-arm edit (the drift test can go red)", () => {
  const { sql } = latestDefining(RANK_FN);
  const edited = sql.replace("WHEN 'passed_chamber'       THEN 50", "WHEN 'passed_chamber'       THEN 55");
  assert.notEqual(edited, sql, "the fixture edit did not apply — the migration's spacing changed");
  assert.notDeepEqual(parseRank(edited), { ...PROPOSAL_STATUS_RANK });
});

test("FIX-1257 every enum value has a rank (the TS table is total)", () => {
  // The Record type forces the keys at compile time; this pins the count so a
  // regenerated enum with a 17th value is noticed here as well as in tsc.
  assert.equal(Object.keys(PROPOSAL_STATUS_RANK).length, 16);
});

// ── The rule, as a table ────────────────────────────────────────────────────
const CASES: Array<[ProposalStatus | null, ProposalStatus | null, boolean, string]> = [
  // forward by rank
  ["introduced", "in_committee", true, "forward"],
  ["in_committee", "passed_chamber", true, "forward — the FIX-1257 class"],
  ["introduced", "passed_chamber", true, "forward — HR 4795"],
  ["passed_chamber", "passed_both_chambers", true, "forward"],
  ["passed_both_chambers", "enacted", true, "forward"],
  ["vetoed", "veto_overridden", true, "an override follows a veto"],
  ["veto_overridden", "enacted", true, "and precedes enactment"],
  // a LOWER rank is a no-op (the regression this exists to stop)
  ["passed_chamber", "introduced", false, "the stage-less 'Motion to reconsider' default"],
  ["passed_chamber", "in_committee", false, "'Received in the Senate and … referred to' after passage"],
  ["enacted", "passed_chamber", false, "lower"],
  ["passed_both_chambers", "passed_chamber", false, "lower"],
  ["vetoed", "passed_both_chambers", false, "a veto is not undone by older evidence"],
  // same status: nothing to do
  ["passed_chamber", "passed_chamber", false, "same"],
  ["failed", "failed", false, "same"],
  // a terminal is accepted from any stage
  ["passed_chamber", "failed", true, "a failed after passage is news"],
  ["introduced", "withdrawn", true, "terminal from the start"],
  ["in_committee", "tabled", true, "terminal"],
  ["passed_both_chambers", "vetoed", true, "terminal"],
  ["enacted", "failed", true, "terminal from ANY stage (rule (b) as written; nothing writes this today)"],
  ["vetoed", "failed", true, "a higher terminal"],
  ["failed", "withdrawn", true, "an equal terminal is not a HIGHER one"],
  // … unless the current status is a higher terminal
  ["failed", "vetoed", false, "vetoed (65) does not replace failed (90)"],
  ["tabled", "vetoed", false, "same"],
  // an introduced after failed is noise
  ["failed", "introduced", false, "noise"],
  ["failed", "passed_chamber", false, "a passage does not undo a minted failed (FIX-1261)"],
  ["withdrawn", "in_committee", false, "noise"],
  // law beats a negative terminal (rule (c))
  ["failed", "enacted", true, "the 6-bill class the old overwrite rescued"],
  ["failed", "signed", true, "law"],
  ["tabled", "veto_overridden", true, "law"],
  ["withdrawn", "enacted", true, "law"],
  ["vetoed", "signed", true, "rank 70 > 65 (forward, not rule (c))"],
  // nulls
  ["passed_chamber", null, false, "a null target is stage-less evidence"],
  [null, "introduced", true, "no stored status"],
];

for (const [from, to, want, why] of CASES) {
  test(`FIX-1257 rule: ${from} → ${to} ${want ? "advances" : "holds"} (${why})`, () => {
    assert.equal(statusAdvances(from, to), want);
  });
}

test("FIX-1257 rule properties over all 256 pairs", () => {
  const all = Object.keys(PROPOSAL_STATUS_RANK) as ProposalStatus[];
  for (const from of all) {
    for (const to of all) {
      const got = statusAdvances(from, to);
      const rf = PROPOSAL_STATUS_RANK[from];
      const rt = PROPOSAL_STATUS_RANK[to];
      if (from === to) assert.equal(got, false, `${from}→${to}: same status`);
      else if (rt > rf) assert.equal(got, true, `${from}→${to}: higher rank always advances`);
      if (got && rt < rf) {
        // A lower rank moves only as a terminal outcome or as law over a negative terminal.
        assert.ok(
          TERMINAL_STATUSES.has(to) || (NEGATIVE_FINAL_STATUSES.has(from) && LAW_OUTCOMES.has(to)),
          `${from}→${to}: a lower rank advanced without a terminal or law reason`,
        );
      }
      if (!TERMINAL_STATUSES.has(to) && !LAW_OUTCOMES.has(to)) {
        if (rt <= rf) assert.equal(got, false, `${from}→${to}: a non-terminal, non-law status never moves sideways or down`);
      }
    }
  }
});
