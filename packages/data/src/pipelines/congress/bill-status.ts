/**
 * FIX-1257 — the status EVIDENCE the congress path reads: a bill's latest
 * action text (the recent-bills sync) and a passage roll (the vote path).
 * Whether that evidence may replace the stored status is `status-rank.ts`'s
 * rule, applied by `proposals_advance_status()`.
 */

import { mapVoteResult } from "./members";
import type { ProposalStatus } from "./status-rank";

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
 * The roll-call questions that ARE a vote on a bill's passage in one chamber
 * (prod's distinct values, 2026-10-03). Not cloture, not amendments, not
 * "On Motion to Recommit", and not the veto-override question ("Passage,
 * Objections of the President To The Contrary Notwithstanding"), which is a
 * different stage.
 */
const PASSAGE_QUESTIONS: ReadonlySet<string> = new Set([
  "on passage",
  "on passage of the bill",
  "on motion to suspend the rules and pass",
  "on motion to suspend the rules and pass, as amended",
]);

export function isPassageQuestion(voteQuestion: string | null | undefined): boolean {
  if (!voteQuestion) return false;
  return PASSAGE_QUESTIONS.has(voteQuestion.trim().toLowerCase().replace(/\s+/g, " "));
}

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

/**
 * The vote path's status evidence: every landed roll that is a PASSAGE roll
 * with a passing result asks for `passed_chamber` on its bill — holder or
 * novel. `mapVoteResult` alone ignores the question (a passed cloture or
 * amendment roll also maps to passed_chamber), so it is only the mint status;
 * the question is what makes a roll evidence here.
 *
 * A FAILED roll writes nothing onto an existing bill: a failed procedural vote
 * is not a failed bill, and the mint already records `failed` far too eagerly
 * (FIX-1257 read 2: all 174 federal `failed` bills came from a failed first roll — FIX-1261).
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
    if (!isPassageQuestion(r.voteQuestion)) continue;
    if (mapVoteResult(r.resultStr) !== "passed_chamber") continue;
    const id = proposalIdFor(r.billKey);
    if (!id || out.has(id)) continue;
    out.set(id, { id, status: "passed_chamber", via: r.rollCallId });
  }
  return [...out.values()];
}
