/**
 * FIX-1201 — the deferred-tail banner reads owner schedules live.
 *
 * Runs via:  tsx --test src/scripts/deferred-tail-banner.test.ts
 *
 * WHY A SOURCE SCAN AND NOT ONLY A RENDER TEST. The defect was not that the
 * banner rendered badly — it rendered beautifully. It rendered
 * `fr-vacuum-analyze  financial_relationships  Mon 01:00` to an operator at
 * 18:5x on 2026-09-19, about forty minutes before the migration that moved that
 * job to daily 03:00 landed (cc-132 §9g). A hard-coded schedule is wrong
 * silently and looks authoritative while it is wrong, so the thing worth
 * asserting is that no such literal exists to go stale — which is a property of
 * the SOURCE, not of any one render.
 *
 * This is a wrong-but-green fixture per rule 105: run the scan against the
 * pre-FIX-1201 tree and it fails on the four TAIL_OWNERS vacuum lines.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TAIL_OWNERS, printDeferredTail } from "./fec-orphan-classify";
import type { OwnerSchedule } from "../lib/cron-job-pipelines";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A clock in operator-facing text: `Mon 01:00`, `daily 04:30`.
 *
 * Note it does NOT match a cron expression (`0 3 * * *`) — those are the live
 * values read out of `cron.job`, which is the whole point, and a test that
 * banned them would ban the fix.
 */
const HARDCODED_SCHEDULE = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d|daily \d\d:\d\d/;

/**
 * Strip comments so the scan only sees code.
 *
 * Deliberately crude — block comments, then line comments. It can be fooled by
 * a `//` inside a string literal, which would make the scan MISS a violation on
 * that line, never invent one. Prose in a comment that quotes an old schedule
 * (there are several, explaining why it used to be wrong) is documentation and
 * is meant to be exempt; a literal in code is not.
 */
function stripComments(src: string): string {
  return src
    // Blank the body but KEEP the newlines, or every reported line number after
    // the first block comment is wrong — which sent one reader to line 790 of a
    // file whose offending line was 2,696.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/.*$/gm, "");
}

test("no hard-coded owner schedule survives in packages/data/src/scripts/*.ts", () => {
  const dir = HERE;
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const code = stripComments(readFileSync(join(dir, f), "utf8"));
    code.split("\n").forEach((line, i) => {
      if (HARDCODED_SCHEDULE.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `hard-coded owner schedule(s) in code — read them from cron.job instead (FIX-1201):\n  ${offenders.join("\n  ")}`,
  );
});

test("TAIL_OWNERS carries job names and what they collect — never a schedule", () => {
  const all = [...TAIL_OWNERS.vacuum, ...TAIL_OWNERS.heavy, ...TAIL_OWNERS.mvs];
  assert.ok(all.length > 0, "TAIL_OWNERS is empty — the scan below would be vacuous");
  for (const o of all) {
    assert.equal(typeof o.job, "string", "every entry names a job");
    assert.equal(typeof o.collects, "string", "every entry says what that job collects");
    assert.ok(
      !HARDCODED_SCHEDULE.test(o.job) && !HARDCODED_SCHEDULE.test(o.collects),
      `TAIL_OWNERS entry still carries a schedule: ${o.job} / ${o.collects}`,
    );
  }
});

// ── rendering: the same stub shape the printTailTable unit test uses ─────────
function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

const OWNERS = new Map<string, OwnerSchedule>([
  // The exact case that caused FIX-1201: fr-vacuum-analyze is daily now.
  ["fr-vacuum-analyze", { schedule: "0 3 * * *", guarded: false, active: true }],
  ["officials-vacuum-analyze", { schedule: "30 1 * * 1", guarded: false, active: true }],
  ["ec-vacuum-analyze", { schedule: "30 4 * * *", guarded: false, active: true }],
  // An INACTIVE owner: on the books, collects nothing. Must not read as live.
  ["fe-vacuum-analyze", { schedule: "50 4 * * *", guarded: false, active: false }],
]);

test("the banner prints the LIVE schedule, not a literal", () => {
  const out = capture(() => printDeferredTail("vacuum", OWNERS));
  assert.match(out, /fr-vacuum-analyze\s+financial_relationships\s+0 3 \* \* \*/);
  assert.doesNotMatch(out, /Mon 01:00/, "the stale literal is gone from the render too");
});

test("an INACTIVE owner is marked, not shown as a live schedule", () => {
  const out = capture(() => printDeferredTail("vacuum", OWNERS));
  assert.match(out, /fe-vacuum-analyze\s+financial_entities\s+50 4 \* \* \* \[INACTIVE\]/);
});

test("an owner with no cron.job row reads NOT SCHEDULED", () => {
  // heavy's owners are absent from OWNERS entirely — deferring to a name nothing
  // schedules is deferring to nobody, and the banner has to say so.
  const out = capture(() => printDeferredTail("heavy", OWNERS));
  assert.match(out, /NOT SCHEDULED/);
});

test("no owners map at all reads `?` — 'nobody looked', not 'nothing owns it'", () => {
  const out = capture(() => printDeferredTail("vacuum"));
  assert.match(out, /\?/);
  assert.doesNotMatch(out, /NOT SCHEDULED/, "a missing map must not manufacture orphan signals");
  assert.match(out, /owner schedules NOT READ/);
});

test("guarded renders NO for the unguarded vacuum jobs — the FIX-1193 warning", () => {
  const out = capture(() => printDeferredTail("vacuum", OWNERS));
  assert.match(out, /guarded/);
  assert.match(out, /\bNO\b/);
});
