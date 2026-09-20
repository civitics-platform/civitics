/**
 * FIX-938 — the drain prompt files and the version constants move together.
 *
 * The drain's prompt .md files are read by the drain-worker SUBAGENT, not by any
 * TypeScript loader — the orchestrator hands the worker a path. So nothing at
 * runtime can notice that summary.md was reworded while
 * SUMMARY_PROMPT_VERSIONS still says 2026-09-20, and the consequence of not
 * noticing is silent: every entity already in ai_summary_cache keeps the old
 * framing forever, under a version that claims to be current. That is exactly
 * the failure FIX-938 exists to remove, reintroduced one layer up.
 *
 * This test is the alarm. The `<!-- prompt-version: … -->` header is
 * documentation; this is what makes it load-bearing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUMMARY_PROMPT_VERSIONS,
  LEGACY_PROMPT_VERSION,
  UNREGISTERED_PROMPT_VERSION,
  summaryPromptVersion,
} from "@civitics/db";

const PROMPTS = join(__dirname, "prompts");

const HEADER_RE = /^<!--\s*prompt-version:\s*([^\s>]+)\s*-->/;

function headerVersion(file: string): string {
  const first = readFileSync(join(PROMPTS, file), "utf8").split(/\r?\n/)[0] ?? "";
  const m = HEADER_RE.exec(first);
  assert.ok(m, `${file} must open with a <!-- prompt-version: … --> header (got: ${first.slice(0, 80)})`);
  return m![1]!;
}

// ---------------------------------------------------------------------------
// The headers match the constants for every pair each file writes
// ---------------------------------------------------------------------------

test("summary.md's header matches BOTH pairs it writes", () => {
  // drain/apply.ts: summary_type is 'plain_language' for a proposal and
  // 'profile' for anything else, so this one file feeds two cache keys. They
  // must share a version or the two entity types would drift apart.
  const v = headerVersion("summary.md");
  assert.equal(v, summaryPromptVersion("proposal", "plain_language"));
  assert.equal(v, summaryPromptVersion("official", "profile"));
});

test("agency-summary.md's header matches the agency pair", () => {
  assert.equal(headerVersion("agency-summary.md"), summaryPromptVersion("agency", "profile"));
});

// ---------------------------------------------------------------------------
// The reserved values stay reserved
// ---------------------------------------------------------------------------

test("no registered pair uses a reserved version value", () => {
  for (const [pair, version] of Object.entries(SUMMARY_PROMPT_VERSIONS)) {
    assert.notEqual(
      version,
      LEGACY_PROMPT_VERSION,
      `${pair} is stamped '${LEGACY_PROMPT_VERSION}', which means "written before FIX-938"`,
    );
    assert.notEqual(
      version,
      UNREGISTERED_PROMPT_VERSION,
      `${pair} is stamped '${UNREGISTERED_PROMPT_VERSION}', which means "no pair claimed this key"`,
    );
  }
});

test("an unregistered pair falls back rather than colliding with a real version", () => {
  const v = summaryPromptVersion("proposal", "no_such_summary_type");
  assert.equal(v, UNREGISTERED_PROMPT_VERSION);
  assert.ok(
    !Object.values(SUMMARY_PROMPT_VERSIONS).includes(v),
    "the fallback must not equal any registered pair's version, or an unregistered " +
      "row would silently share a registered pair's cache generation",
  );
});

// ---------------------------------------------------------------------------
// The pairs the live producers actually write are all registered
// ---------------------------------------------------------------------------

test("every (entity_type, summary_type) a producer writes today is registered", () => {
  // drain/apply.ts and the enrichment submit route derive summary_type from
  // entity_type; ai-summaries and the two on-demand routes hard-code theirs.
  const WRITTEN: Array<[string, string]> = [
    ["proposal", "plain_language"],
    ["official", "profile"],
    ["agency", "profile"],
  ];
  for (const [entityType, summaryType] of WRITTEN) {
    assert.notEqual(
      summaryPromptVersion(entityType, summaryType),
      UNREGISTERED_PROMPT_VERSION,
      `${entityType}:${summaryType} is written by a live producer but is not in ` +
        "SUMMARY_PROMPT_VERSIONS — a prompt bump could never invalidate its rows",
    );
  }
});

// ---------------------------------------------------------------------------
// The migration's backfill agrees with the constants
// ---------------------------------------------------------------------------

test("the FIX-938 migration backfills to the version the code stamps", () => {
  // If these drift, the 6,888 backfilled rows are stamped with a version no
  // producer will ever read back, and the entire table becomes a permanent miss
  // — the ~$11 regeneration the migration header exists to avoid.
  const sql = readFileSync(
    join(__dirname, "..", "..", "..", "..", "supabase", "migrations",
         "20260920050000_fix938_ai_summary_prompt_version.sql"),
    "utf8",
  );
  const m = /SET prompt_version = '([^']+)'/.exec(sql);
  assert.ok(m, "could not find the backfill's version literal in the migration");
  assert.equal(m![1], summaryPromptVersion("proposal", "plain_language"));
});
