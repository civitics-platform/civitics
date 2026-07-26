/**
 * FIX-894 — regression tests for the source-text enqueue gate.
 *
 * The gate's whole job is to stop the platform paying a model to invent topics
 * and summaries for proposals whose text we do not hold. These tests lock down
 * the boundary against the real prod data shapes that motivated it (measured
 * 2026-07-25), so a future "let's loosen the floor" change has to break a test
 * rather than silently re-open a $74 hole.
 *
 * Pure predicate tests — no DB, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasUsableSourceText,
  SOURCE_TEXT_MIN_CHARS,
  classifyProposalContext,
  NO_SOURCE_TEXT_STATUS,
} from "./queue";

// A realistic 100+ char summary, of the kind congress_gov / openstates supply.
const REAL_SUMMARY =
  "This bill establishes extended producer responsibility requirements for " +
  "mattress manufacturers, requiring them to fund and operate a statewide " +
  "collection and recycling program for discarded mattresses.";

const TITLE = "An Act relating to mattress recycling";

test("the floor is 100 chars and is the same boundary classifyProposalContext uses", () => {
  assert.equal(SOURCE_TEXT_MIN_CHARS, 100);
  // The gate must BE the full_summary boundary, not a parallel number that can
  // drift from it. If these two ever disagree the gate admits rows the worker
  // grades as title_only, which is what it exists to prevent.
  const justOver = "x".repeat(101);
  assert.equal(classifyProposalContext(justOver, TITLE), "full_summary");
  assert.equal(hasUsableSourceText(justOver, TITLE), true);

  const justUnder = "x".repeat(100);
  assert.notEqual(classifyProposalContext(justUnder, TITLE), "full_summary");
  assert.equal(hasUsableSourceText(justUnder, TITLE), false);
});

test("a proposal with real source text passes the gate", () => {
  assert.ok(REAL_SUMMARY.length > 100, "fixture must exceed the floor");
  assert.equal(hasUsableSourceText(REAL_SUMMARY, TITLE), true);
});

test("a proposal with NO text is refused (the Legistar case: 127,260 prod rows)", () => {
  // Legistar municipal matters carry summary_plain IS NULL. Their source API
  // supplies no abstract, so they never acquire text by waiting.
  for (const empty of [null, "", "   ", "\n\t "]) {
    assert.equal(
      hasUsableSourceText(empty, "Resolution authorizing the Director of Public Works to execute a contract"),
      false,
      `expected refusal for summary_plain=${JSON.stringify(empty)}`,
    );
  }
});

test("bare subject labels leaked into summary_plain are refused", () => {
  // Real prod values from openstates. These are category labels, not summaries;
  // a 40-char floor admits ~90 of them. Summarizing "Education" is invention.
  const LABELS = [
    "Health",
    "Military",
    "Education",
    "Insurance",
    "Retirement",
    "Family Law",
    "Resolutions",
    "Counties & Municipalities",
    "Government Administration",
    "Public Safety & Emergencies",
    "Occupational Licensing Boards",
    "Alcoholic Beverages & Tobacco",
    "Conservation & Natural Resources",
    "Authorities, Boards, & Commissions",
    "Constitutional Amendments Statewide",
    "Businesses & Financial Institutions",
    "Elections, Voting, & Campaigns",
  ];
  for (const label of LABELS) {
    assert.ok(label.length <= 40, `${label} (${label.length}) should be within the old 40 floor`);
    assert.equal(
      hasUsableSourceText(label, TITLE),
      false,
      `bare subject label "${label}" must not pass the gate`,
    );
  }
});

test("title restatements are refused — they add no signal a title lacks", () => {
  // Real prod values. All under 100 chars, all essentially the title again.
  const RESTATEMENTS = [
    "Relating to judicial deference.",
    "Relating to inspection fees.",
    "Relating to real estate licensing.",
    "Relating to maternal care services.",
    "Amend KRS 6.922 to make technical corrections.",
    "Mourns the passing of Opal Delores Rice.",
    "Establishes extended producer responsibility for mattresses.",
    "This resolution condemns the Biden Administration's border policies.",
  ];
  for (const s of RESTATEMENTS) {
    assert.equal(hasUsableSourceText(s, TITLE), false, `"${s}" must not pass the gate`);
  }
});

test("summary_plain that is merely a copy of the title is refused even when long", () => {
  // The title-masquerade guard. On prod this removed 40 openstates tag rows that
  // a pure length check would have admitted (1,416 -> 1,376).
  const longTitle =
    "An Act relating to the establishment of a statewide program for the " +
    "collection, transportation, and recycling of discarded mattress materials";
  assert.ok(longTitle.length > 100);
  assert.equal(hasUsableSourceText(longTitle, longTitle), false, "exact copy");
  assert.equal(
    hasUsableSourceText(`  ${longTitle.toUpperCase()}  `, longTitle),
    false,
    "case- and whitespace-insensitive copy",
  );
});

test("the gate is symmetric across both task types", () => {
  // Same bar for tag and summary: a summary of a title is not a summary, and a
  // topic classified from a title is the model supplying the knowledge. The
  // predicate takes no task_type, which is what enforces this structurally.
  assert.equal(hasUsableSourceText.length, 2, "predicate takes (summaryPlain, title) only");
});

test("a refused proposal becomes eligible automatically once text arrives", () => {
  // This is why the gate keys on text presence rather than a source-name
  // blocklist: a blocklist goes stale the moment a source starts supplying
  // abstracts. Same entity, text added -> now passes. No code change, no
  // allowlist edit.
  const legistarTitle = "Resolution authorizing an agreement with the Department of Public Health";
  assert.equal(hasUsableSourceText(null, legistarTitle), false);
  assert.equal(hasUsableSourceText(REAL_SUMMARY, legistarTitle), true);
});

test("the marked status value is stable", () => {
  // The sweep SQL, the seeder's classifyAction, and the drain status snapshot
  // all key on this exact string.
  assert.equal(NO_SOURCE_TEXT_STATUS, "skipped_no_source_text");
});
