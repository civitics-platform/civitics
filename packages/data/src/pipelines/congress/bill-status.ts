/**
 * FIX-1257 — the status EVIDENCE the congress path reads: a bill's latest
 * action text (the recent-bills sync) and a passage roll (the vote path).
 * Whether that evidence may replace the stored status is `status-rank.ts`'s
 * rule, applied by `proposals_advance_status()`.
 */

import { mapVoteResult } from "./members";
import type { ProposalStatus } from "./status-rank";
import passageQuestions from "./passage-questions.json";

/**
 * Map a congress.gov `latestAction.text` to the stage it PROVES, or null when
 * it proves none.
 *
 * Before FIX-1257 every unmatched text fell to `introduced`, and the sync wrote
 * that over the stored status — so "Motion to reconsider laid on the table…",
 * "Received in the Senate.", "Held at the desk." and "Placed on the Union
 * Calendar…" each knocked a bill that had passed a chamber back to introduced.
 * Those texts carry no stage information; they now map to null, which the
 * sync's Step 3 skips (a new bill is minted as `introduced` instead).
 *
 * `introduced` is returned only for an "Introduced in …" text or a bill with
 * no action text at all (an introducedDate-only listing).
 */
export function mapBillStatus(latestActionText: string | null | undefined): ProposalStatus | null {
  if (!latestActionText || !latestActionText.trim()) return "introduced";
  const t = latestActionText.toLowerCase();
  if (t.includes("became public law") || t.includes("signed by president")) return "enacted";
  if (t.includes("signed") && t.includes("president")) return "signed";
  if (t.includes("vetoed")) return "vetoed";
  if (t.includes("passed") && (t.includes("senate") || t.includes("house"))) {
    if (t.includes("both") || (t.includes("senate") && t.includes("house"))) {
      return "passed_both_chambers";
    }
    return "passed_chamber";
  }
  if (t.includes("reported") || t.includes("ordered to be reported")) return "passed_committee";
  if (t.includes("referred to")) return "in_committee";
  if (/^introduced in (the )?(house|senate)\b/.test(t.trim())) return "introduced";
  return null;
}

/**
 * The roll-call questions that ARE a vote on a measure's passage (or a
 * resolution's adoption) in one chamber — `passage-questions.json`, picked by
 * meaning from prod's distinct values (cc-185 read 2, 2026-10-03). Not
 * cloture, not amendments, not "On Motion to Recommit", not "On Ordering the
 * Previous Question", and not either veto-override question (a different
 * stage). FIX-1261 added the resolution and concurrence questions. The cc-185
 * manifest scripts read the same file (scripts/lib/bill-status-evidence.mjs).
 */
const PASSAGE_QUESTIONS: ReadonlySet<string> = new Set([...passageQuestions.house, ...passageQuestions.senate]);

export function isPassageQuestion(voteQuestion: string | null | undefined): boolean {
  if (!voteQuestion) return false;
  return PASSAGE_QUESTIONS.has(voteQuestion.trim().toLowerCase().replace(/\s+/g, " "));
}

/**
 * FIX-1261 — the status a vote-path mint takes when no roll in the run proves
 * passage: the measure reached the floor, and that is all a roll proves. Never
 * `failed`: a failed roll is a failed MOTION — a recommit, an amendment, even a
 * passage vote (9 failed suspensions on prod later passed) — not a failed bill.
 * Before FIX-1261 the mint took mapVoteResult() of the bill's FIRST roll, so a
 * failed recommit motion minted `failed` (all 174 federal `failed` bills, cc-181)
 * and a passed previous-question vote minted `passed_chamber`.
 */
export const MINT_FLOOR: ProposalStatus = "floor_vote";

export interface RollEvidence {
  rollCallId: string;
  billKey: string | null;
  voteQuestion: string;
  resultStr: string;
}

export interface StatusPair {
  id: string;
  status: ProposalStatus;
  /** Where the evidence came from — a roll id, or "sync". */
  via: string;
}

/** A passage question whose result passed — the one thing a roll proves beyond "it reached the floor". */
function isPassedPassageRoll(r: Pick<RollEvidence, "voteQuestion" | "resultStr">): boolean {
  return isPassageQuestion(r.voteQuestion) && mapVoteResult(r.resultStr) === "passed_chamber";
}

/**
 * FIX-1261 — the mint status of every bill key in a run's roll buffer, decided
 * over ALL of that key's buffered rolls (not the first): `passed_chamber` if
 * any is a passed passage roll, else MINT_FLOOR. The vote path calls this at
 * flush, after Pass 1 has buffered every novel roll, and only a NOVEL bill is
 * minted with it — an existing bill is moved only by rollPassageAdvances().
 *
 * A nomination (PN) goes through the same rule and, since "On the Nomination"
 * is not a passage question, mints floor_vote — what all 696 PN proposals on
 * prod carry today (cc-185 read 2c).
 */
export function mintStatuses(rolls: readonly Pick<RollEvidence, "billKey" | "voteQuestion" | "resultStr">[]): Map<string, ProposalStatus> {
  const out = new Map<string, ProposalStatus>();
  for (const r of rolls) {
    if (!r.billKey) continue;
    if (isPassedPassageRoll(r)) out.set(r.billKey, "passed_chamber");
    else if (!out.has(r.billKey)) out.set(r.billKey, MINT_FLOOR);
  }
  return out;
}

/**
 * FIX-1261 — stamp each buffered bill's mint status from mintStatuses() over
 * the run's roll buffer. The vote path calls it once per chamber, after Pass 1
 * and before resolveBillsBatch() mints the novel bills.
 */
export function stampMintStatuses<A extends { status: ProposalStatus | null }>(
  args: Map<string, A>,
  rolls: readonly Pick<RollEvidence, "billKey" | "voteQuestion" | "resultStr">[],
): void {
  const mints = mintStatuses(rolls);
  for (const [key, a] of args) a.status = mints.get(key) ?? MINT_FLOOR;
}

/**
 * The vote path's status evidence: every landed roll that is a PASSAGE roll
 * with a passing result asks for `passed_chamber` on its bill — holder or
 * novel. `mapVoteResult` alone ignores the question (a passed cloture or
 * amendment roll also maps to passed_chamber); the question is what makes a
 * roll evidence here, and in mintStatuses().
 *
 * A FAILED roll writes nothing onto an existing bill: a failed procedural vote
 * is not a failed bill (FIX-1261 — the mint no longer records one either).
 *
 * One pair per proposal (the first passage roll wins; they all ask for the
 * same status).
 */
export function rollPassageAdvances(
  rolls: readonly RollEvidence[],
  proposalIdFor: (billKey: string | null) => string | null,
): StatusPair[] {
  const out = new Map<string, StatusPair>();
  for (const r of rolls) {
    if (!isPassedPassageRoll(r)) continue;
    const id = proposalIdFor(r.billKey);
    if (!id || out.has(id)) continue;
    out.set(id, { id, status: "passed_chamber", via: r.rollCallId });
  }
  return [...out.values()];
}
