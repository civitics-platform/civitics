/**
 * FIX-1449 (cc-325 D2–D4) — the words the officials page prints about votes.
 *
 * get_official_page (20261126001000) returns the official's last 500 votes,
 * newest first, each with its roll's `vote_question`, `chamber` and
 * `roll_class` (vote_roll_class: 'final' | 'advance' | 'other'). The body
 * before it returned 500 votes in NO order and none of those keys, so:
 *   - the breakdown says what it counts: "Last 500 votes", never "all" — the
 *     rows are a window, even when the window happens to hold every vote;
 *   - against the old body (no `voted_at` on a row) the caption says "a sample",
 *     because an unordered 500 is not the last 500;
 *   - a key the old body lacks reads as absent, never as a zero: no class line,
 *     no class word, no issue bars.
 * Procedural is the roll's class, never a pattern on the bill's title.
 *
 * Pure and free of next/* so the app test runner discovers it under src/.
 */

export type OfficialVoteRow = {
  vote: string;
  voted_at?: string | null;
  roll_call_id?: string | null;
  vote_question?: string | null;
  chamber?: string | null;
  roll_class?: string | null;
};

export type VoteBreakdown = {
  yes: number;
  no: number;
  abstain: number;
  total: number;
  /** "Last 500 votes" / "A sample of 500 votes"; null when there are no rows. */
  caption: string | null;
  /** "312 on passage · 101 to advance · 87 procedural"; null when the rows carry no class. */
  classes: string | null;
};

const has = (r: object, k: string) => Object.prototype.hasOwnProperty.call(r, k);
const n = (v: number) => v.toLocaleString("en-US");

/** Rows from the FIX-1449 body are ordered newest first; the old body's were not. */
const ordered = (rows: OfficialVoteRow[]) => rows.length > 0 && rows.every((r) => has(r, "voted_at"));
const classed = (rows: OfficialVoteRow[]) => rows.length > 0 && rows.every((r) => has(r, "roll_class"));

/** A class this page does not know reads as procedural (as on the proposal page). */
export function voteClass(rollClass: string | null | undefined): "final" | "advance" | "other" | null {
  if (rollClass == null) return null;
  return rollClass === "final" || rollClass === "advance" ? rollClass : "other";
}

/** What the breakdown counts. Never "all": the rows are a window of at most 500. */
export function breakdownCaption(rows: OfficialVoteRow[]): string | null {
  if (rows.length === 0) return null;
  const noun = rows.length === 1 ? "vote" : "votes";
  return ordered(rows) ? `Last ${n(rows.length)} ${noun}` : `A sample of ${n(rows.length)} ${noun}`;
}

/** "N on passage · N to advance · N procedural", from each row's roll class. */
export function breakdownClasses(rows: OfficialVoteRow[]): string | null {
  if (!classed(rows)) return null;
  let final = 0;
  let advance = 0;
  let other = 0;
  for (const r of rows) {
    const c = voteClass(r.roll_class);
    if (c === "final") final++;
    else if (c === "advance") advance++;
    else other++;
  }
  return `${n(final)} on passage · ${n(advance)} to advance · ${n(other)} procedural`;
}

/** The Votes tab's breakdown: the three cast boxes, the caption and the class line. */
export function officialVoteBreakdown(rows: OfficialVoteRow[]): VoteBreakdown {
  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const r of rows) {
    if (r.vote === "yes" || r.vote === "paired_yes") yes++;
    else if (r.vote === "no" || r.vote === "paired_no") no++;
    else if (r.vote === "abstain" || r.vote === "not_voting" || r.vote === "present") abstain++;
  }
  return { yes, no, abstain, total: rows.length, caption: breakdownCaption(rows), classes: breakdownClasses(rows) };
}

// ── The issue bars ───────────────────────────────────────────────────────────

/** The issue bars count only votes on passage (roll_class 'final'). Unclassed rows count for nothing. */
export function passageVotes<T extends OfficialVoteRow>(rows: T[]): T[] {
  return rows.filter((r) => r.roll_class === "final");
}

/** The issue bars' caption; null when the rows carry no class or no order (no bars are drawn). */
export function issueCaption(rows: OfficialVoteRow[]): string | null {
  if (!classed(rows) || !ordered(rows)) return null;
  return `On passage votes among the last ${n(rows.length)}`;
}

// ── One vote row ─────────────────────────────────────────────────────────────

export type VoteRowLine = {
  /** The proposal's title, else the roll's question, else "Recorded vote". */
  title: string;
  /** "<question> · <chamber>" under the title; the question is left out when it IS the title. */
  detail: string | null;
  /** "to advance" / "procedural" for a roll that is not a final vote; null for final or unknown. */
  classWord: string | null;
};

export function voteRowLine(v: {
  title?: string | null;
  vote_question?: string | null;
  chamber?: string | null;
  roll_class?: string | null;
}): VoteRowLine {
  const title = v.title?.trim() || null;
  const question = v.vote_question?.trim() || null;
  const chamber = v.chamber?.trim() || null;
  const detail = [title ? question : null, chamber].filter(Boolean).join(" · ");
  const c = voteClass(v.roll_class);
  return {
    title: title ?? question ?? "Recorded vote",
    detail: detail || null,
    classWord: c === "advance" ? "to advance" : c === "other" ? "procedural" : null,
  };
}
