/**
 * Reading routine text out of a migration file, for source-anchor tests.
 *
 * `body()` and `header()` are copied verbatim from work-mem-allowances.test.ts
 * (FIX-1307 / cc-223), where they are not exported. Only job-registry-seed.test.ts
 * imports this today; moving the existing tests onto it is a later hygiene line.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

export const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

/** A routine's body, between its opening and closing dollar-quote (`$function$`, `$procedure$` or `$$`). */
export function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `no dollar-quoted body after ${signature}`);
  return m[2] as string;
}

/** The header between the signature and `AS $…$` — where a SET clause would sit. */
export function header(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  return src.slice(i, src.indexOf("AS $", i));
}

/** `--` comments removed, so an anchor never matches prose. */
export const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

/**
 * The pins that moved after files already asserted them: old md5 → the live body.
 * cc-264: box_is_saturated (fix1354 → the io: rung) and prod_op_gate (fix1342 → the
 * (d) re-cut). A migration's read-back is history and is never edited, but a clone
 * test re-applies that file against the clone's CURRENT bodies, so its read-back
 * must assert them. Add a line when a pin moves.
 */
export const PIN_LINEAGE: Readonly<Record<string, string>> = {
  ac8dbcddf71978e73d28c999433156b7: "aaf6cc6552df532eff4a9b21e9780670",
  "1d3507cd4b71439f0cfff51cde49b9d8": "6488601cf8c09287d540989c0e0fd074",
  // cc-267: get_dispatcher_status gains the io block (FIX-1398, 20261111001000);
  // box_is_saturated and prod_op_gate read a standing hold at any mirror age
  // (FIX-1392, 20261111003000).
  "4c30523742e280a4b48ea2ec390654d6": "d6bb02aab3eb8c9625275227f564c5c9",
  aaf6cc6552df532eff4a9b21e9780670: "b05961ca6d1cf7e56874071bfe334da1",
  "6488601cf8c09287d540989c0e0fd074": "70a799ab3df2484fc424fe2762ffa797",
};

/** A pin's live md5: its lineage followed to the end (a pin can move more than once). */
function currentPin(md5: string): string {
  let now = md5;
  for (let i = 0; PIN_LINEAGE[now] !== undefined && i < 16; i++) now = PIN_LINEAGE[now]!;
  return now;
}

export const atCurrentPins = (sql: string): string =>
  Object.keys(PIN_LINEAGE).reduce((s, was) => s.split(was).join(currentPin(was)), sql);

/**
 * The cron MOVEs that landed after older files asserted the job on its `at`
 * rule with an active cron (cc-267 D5, rule 441's shape for cron state). Those
 * read-backs are history and are never edited. A clone test that READS the old
 * expectation asks movedState(); one that RE-APPLIES such a file first runs the
 * move's revert inside its rolled-back transaction. Add a line per MOVE.
 */
export const MOVED_LINEAGE: Readonly<Record<string, { fix: string; at: string; rule: string; revert: string }>> = {
  "dpr-vacuum-analyze": {
    fix: "FIX-1366", at: "at 0 2 * * 0,3", rule: "dead_tuples > 60% of trigger + floor 7 days",
    revert: "fix1366-revert-move-dpr-vacuum.sql",
  },
  "officials-vacuum-analyze": {
    fix: "FIX-1396", at: "at 30 1 * * 1", rule: "dead_tuples > 60% of trigger + floor 7 days",
    revert: "fix1396-revert-move-officials-mv-vacuums.sql",
  },
};

/** What a clone row should read: its moved rule and a parked cron once its note carries the MOVE. */
export function movedState(job: string, note: string | null | undefined): { rule: string; active: boolean } {
  const m = MOVED_LINEAGE[job];
  assert.ok(m, `no MOVED_LINEAGE line for ${job}`);
  const moved = new RegExp(`MOVED \\S+ \\(${m.fix}[,)]`).test(note ?? "");
  return moved ? { rule: m.rule, active: false } : { rule: m.at, active: true };
}

/** A pg client whose every SQL string runs at the current pins (see PIN_LINEAGE). */
export function withCurrentPins<T extends { query: unknown }>(client: T): T {
  const query = (client.query as (...a: unknown[]) => unknown).bind(client);
  client.query = (sql: unknown, ...rest: unknown[]) =>
    query(typeof sql === "string" ? atCurrentPins(sql) : sql, ...rest);
  return client;
}
