/**
 * FIX-1447 (cc-317 D2, D4) — the words the proposal page prints for a roll.
 *
 * A roll's STORED rows are short of the roll: votes holds a row only for a
 * member Civitics has an officials row for (FIX-1448; prod 2026-11-26: the
 * median House roll stores 323 rows, the Senate 84, and 170 House rolls read
 * Passed with stored yes <= stored no). So the counts here are "recorded
 * here", never a result:
 *   - the source's result is printed only when the roll stored one
 *     (`vote_result`), as "Result: <it>";
 *   - nothing here derives passed / failed / tied from the counts, and the
 *     counts are never printed as a score ("211–212").
 * The rows come from public.proposal_vote_rolls(uuid), newest first.
 */

export type PartyCounts = { yes: number; no: number; present: number; not_voting: number };

export type VoteRoll = {
  roll_call_id: string;
  chamber: string;
  vote_question: string | null;
  roll_class: string;
  voted_at: string;
  source_url: string | null;
  vote_result: string | null;
  rows_on_record: number;
  yes: number;
  no: number;
  present: number;
  not_voting: number;
  other: number;
  by_party: Record<string, PartyCounts> | null;
};

/** One sentence under the section heading: what "on record" means. */
export const ON_RECORD_NOTE =
  "A member's vote is stored only when Civitics has that member's record, so a count here can be short of the official one; the official roll is the linked source.";

/** "July 3, 2025". voted_at is a date stored at midnight UTC, so it is read in UTC. */
export function rollDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The roll's question, chamber and date, joined: "On Passage · House · July 3, 2025". */
export function rollHeading(r: Pick<VoteRoll, "vote_question" | "chamber" | "voted_at">): string {
  return [r.vote_question?.trim() || "Recorded vote", r.chamber?.trim() || null, rollDate(r.voted_at)]
    .filter(Boolean)
    .join(" · ");
}

/** "Result: Passed" — the source's own result, or null when none is stored. Never derived. */
export function rollResultLine(r: Pick<VoteRoll, "vote_result">): string | null {
  const res = r.vote_result?.trim();
  return res ? `Result: ${res}` : null;
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * "Recorded here: 214 yes · 212 no · 0 present · 0 not voting — 426 member
 * votes on record". Paired and abstain casts appear as "N other" only when
 * there are some, so the parts always sum to the total printed.
 */
export function rollRecordedLine(
  r: Pick<VoteRoll, "yes" | "no" | "present" | "not_voting" | "other" | "rows_on_record">,
): string {
  const parts = [`${n(r.yes)} yes`, `${n(r.no)} no`, `${n(r.present)} present`, `${n(r.not_voting)} not voting`];
  if (r.other > 0) parts.push(`${n(r.other)} other`);
  const total = `${n(r.rows_on_record)} member ${r.rows_on_record === 1 ? "vote" : "votes"} on record`;
  return `Recorded here: ${parts.join(" · ")} — ${total}`;
}

/** Everything the page prints for one roll, in order. */
export function rollLines(r: VoteRoll): { heading: string; result: string | null; recorded: string } {
  return { heading: rollHeading(r), result: rollResultLine(r), recorded: rollRecordedLine(r) };
}

// ── D4: groups and the headline roll ─────────────────────────────────────────

export const ROLL_GROUPS = [
  { cls: "final",   title: "Votes on passage or confirmation" },
  { cls: "advance", title: "Votes to advance" },
  { cls: "other",   title: "Procedural votes" },
] as const;

export type RollGroup = {
  cls: (typeof ROLL_GROUPS)[number]["cls"];
  title: string;
  shown: VoteRoll[];
  more: VoteRoll[];
};

/** A class this page does not know reads as procedural. */
const groupOf = (r: VoteRoll) => (r.roll_class === "final" || r.roll_class === "advance" ? r.roll_class : "other");

/**
 * The rolls in three groups — final, advance, other — each keeping the input's
 * newest-first order, `visible` shown and the rest behind a <details>. Empty
 * groups are dropped.
 */
export function groupRolls(rolls: VoteRoll[], visible = 5): RollGroup[] {
  return ROLL_GROUPS.map(({ cls, title }) => {
    const all = rolls.filter((r) => groupOf(r) === cls);
    return { cls, title, shown: all.slice(0, visible), more: all.slice(visible) };
  }).filter((g) => g.shown.length > 0);
}

/** The roll whose members are listed: the newest final roll, else the newest roll. */
export function headlineRoll(rolls: VoteRoll[]): VoteRoll | null {
  return rolls.find((r) => r.roll_class === "final") ?? rolls[0] ?? null;
}

const PARTY_ABBR: readonly [string, string][] = [
  ["democrat", "D"],
  ["republican", "R"],
  ["independent", "I"],
  ["other", "Other"],
];

/**
 * One cast's recorded count by party, from by_party: "D 210 · R 2". Parties
 * with none are left out; null for a cast by_party does not carry (paired,
 * abstain) or when no party recorded one.
 */
export function partySplit(byParty: VoteRoll["by_party"], cast: string): string | null {
  if (!byParty || !["yes", "no", "present", "not_voting"].includes(cast)) return null;
  const parts = PARTY_ABBR.flatMap(([key, abbr]) => {
    const c = byParty[key]?.[cast as keyof PartyCounts] ?? 0;
    return c > 0 ? [`${abbr} ${n(c)}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── The headline roll's members, grouped by cast ─────────────────────────────

export type MemberVote = {
  id: string;
  vote: string;
  official: {
    id: string;
    full_name: string;
    party: string | null;
    district_name: string | null;
    role_title: string;
  } | null;
};

export const CAST_ORDER = ["yes", "no", "present", "not_voting", "paired_yes", "paired_no", "abstain"] as const;

export const CAST_LABEL: Readonly<Record<string, string>> = {
  yes: "Yes",
  no: "No",
  present: "Present",
  not_voting: "Not Voting",
  paired_yes: "Paired Yes",
  paired_no: "Paired No",
  abstain: "Abstain",
};

/** Members grouped by cast in CAST_ORDER (unknown casts last), each group by name. */
export function groupMembers(votes: MemberVote[]): { vote: string; label: string; members: MemberVote[] }[] {
  const by = new Map<string, MemberVote[]>();
  for (const v of votes) {
    const list = by.get(v.vote) ?? [];
    list.push(v);
    by.set(v.vote, list);
  }
  const order = [...CAST_ORDER, ...[...by.keys()].filter((k) => !(CAST_ORDER as readonly string[]).includes(k)).sort()];
  return order
    .filter((k) => by.has(k))
    .map((k) => ({
      vote: k,
      label: CAST_LABEL[k] ?? k,
      members: (by.get(k) ?? []).sort((a, b) =>
        (a.official?.full_name ?? "").localeCompare(b.official?.full_name ?? ""),
      ),
    }));
}
