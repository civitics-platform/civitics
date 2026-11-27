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
 *     recorded counts are never printed as a score ("211–212").
 * The rows come from public.proposal_vote_rolls(uuid), newest first.
 *
 * FIX-1461 (cc-332): beside them, each roll's own row in vote_rolls — the
 * chamber's result, official count, requirement and title, read from the roll
 * file or the Senate session list. Those are printed as the source's, and a
 * roll with no row prints exactly the lines above.
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

/**
 * FIX-1461 (cc-332 V1) — the roll's own row in public.vote_rolls (cc-331),
 * read by roll id beside the members read. NULL is a field the file read does
 * not carry: a Senate session list has yea / nay and no present / not voting,
 * and no requirement, tie-breaker or party totals. A NULL is never printed as 0.
 */
export type OfficialPartyTotals = {
  party: string | null;
  yea: number | null;
  nay: number | null;
  present: number | null;
  not_voting: number | null;
};

export type OfficialRoll = {
  roll_call_id: string;
  question: string | null;
  title: string | null;
  result: string | null;
  yea: number | null;
  nay: number | null;
  present: number | null;
  not_voting: number | null;
  /** House: the clerk's vote-type ("2/3 YEA-AND-NAY", "RECORDED VOTE"). Senate: "1/2", "3/5". */
  majority_requirement: string | null;
  tie_breaker: { by_whom: string; vote: string | null } | null;
  /** House only, in the clerk's order. */
  by_party: OfficialPartyTotals[] | null;
  /** 'clerk_xml' | 'lis_roll_xml' — the roll's own file was read; NULL — a session list only. */
  detail_source: string | null;
};

/** The columns the page reads from vote_rolls — only what the lines below print. */
export const OFFICIAL_ROLL_COLUMNS =
  "roll_call_id,question,title,result,yea,nay,present,not_voting,majority_requirement,tie_breaker,by_party,detail_source";

/** The measure a roll belongs to, for V6's "is the roll's title just the measure's name" test. */
export type RollContext = {
  measureTitle?: string | null;
  shortTitle?: string | null;
  number?: string | null;
};

/** One sentence under the section heading: what "on record" means. */
export const ON_RECORD_NOTE =
  "A member's vote is stored only when Civitics has that member's record, so a count here can be short of the official one; the official roll is the linked source.";

/** V9: the sentence once at least one roll on the page prints the chamber's own count. */
export const ON_RECORD_NOTE_OFFICIAL =
  "The result and the official count are the chamber's own, read from the linked roll. “Recorded here” counts only the members Civitics holds a record for, so it can be short of the official count.";

/** V9. */
export function onRecordNote(anyOfficialCount: boolean): string {
  return anyOfficialCount ? ON_RECORD_NOTE_OFFICIAL : ON_RECORD_NOTE;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "July 3, 2025". voted_at is a date stored at midnight UTC, so it is read in UTC. */
export function rollDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The roll's question, chamber and date, joined: "On Passage · House · July 3,
 * 2025". V10: the roll's own question when the stored one is empty.
 */
export function rollHeading(
  r: Pick<VoteRoll, "vote_question" | "chamber" | "voted_at">,
  o?: Pick<OfficialRoll, "question"> | null,
): string {
  return [text(r.vote_question) ?? text(o?.question) ?? "Recorded vote", text(r.chamber), rollDate(r.voted_at)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * V2: the source's result, never derived. A roll whose own file was read
 * prints that file's result. Otherwise the stored vote_result, which the
 * nightly read from the same per-roll file ("Amendment Rejected"), comes before
 * a session list's short form ("Rejected"): cc-332 read 15 found every stored
 * Senate result the long form or a synonym of its list's, never another
 * outcome, and a list-only roll would otherwise change its wording once the
 * walker reads its file.
 */
export function officialResult(
  r: Pick<VoteRoll, "vote_result">,
  o?: Pick<OfficialRoll, "result" | "detail_source"> | null,
): string | null {
  return (o?.detail_source ? text(o.result) : null) ?? text(r.vote_result) ?? text(o?.result);
}

/**
 * V4: only a leading fraction is a requirement. "2/3 YEA-AND-NAY" → "two-thirds
 * required", "3/5" → "three-fifths required", "1/2" → null (a simple majority
 * says nothing), any other fraction → "<n>/<m> required". "YEA-AND-NAY" and
 * "RECORDED VOTE" name a voting method, not a requirement → null.
 */
export function requirementPhrase(req: string | null | undefined): string | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(req ?? "");
  if (!m) return null;
  const [num, den] = [Number(m[1]), Number(m[2])];
  if (num * 2 === den) return null;
  if (num === 2 && den === 3) return "two-thirds required";
  if (num === 3 && den === 5) return "three-fifths required";
  return `${num}/${den} required`;
}

/**
 * "Result: Failed · two-thirds required" — the source's result (V2) with the
 * requirement (V4) after it; the requirement alone when no result is held;
 * null when neither is.
 */
export function rollResultLine(
  r: Pick<VoteRoll, "vote_result">,
  o?: Pick<OfficialRoll, "result" | "detail_source" | "majority_requirement"> | null,
): string | null {
  const res = officialResult(r, o);
  const req = requirementPhrase(o?.majority_requirement);
  if (res) return req ? `Result: ${res} · ${req}` : `Result: ${res}`;
  return req ? req.charAt(0).toUpperCase() + req.slice(1) : null;
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * V3: "Official count: 215 yea · 214 nay · 1 present · 2 not voting", when yea
 * and nay are both held. Present and not voting are printed only when held.
 */
export function officialCountLine(
  o: Pick<OfficialRoll, "yea" | "nay" | "present" | "not_voting"> | null | undefined,
): string | null {
  const yea = count(o?.yea);
  const nay = count(o?.nay);
  if (yea === null || nay === null) return null;
  const parts = [`${n(yea)} yea`, `${n(nay)} nay`];
  const present = count(o?.present);
  const notVoting = count(o?.not_voting);
  if (present !== null) parts.push(`${n(present)} present`);
  if (notVoting !== null) parts.push(`${n(notVoting)} not voting`);
  return `Official count: ${parts.join(" · ")}`;
}

/** The official total, only when all four counts are held. */
export function officialTotal(
  o: Pick<OfficialRoll, "yea" | "nay" | "present" | "not_voting"> | null | undefined,
): number | null {
  const parts = [count(o?.yea), count(o?.nay), count(o?.present), count(o?.not_voting)];
  return parts.every((c) => c !== null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
}

/**
 * "Recorded here: 214 yes · 212 no · 0 present · 0 not voting — 426 member
 * votes on record". Paired and abstain casts appear as "N other" only when
 * there are some, so the parts always sum to the total printed. V5: "— 426 of
 * 433 member votes on record" when the official total is held and the rows do
 * not exceed it; never a percentage, never "missing N".
 */
export function rollRecordedLine(
  r: Pick<VoteRoll, "yes" | "no" | "present" | "not_voting" | "other" | "rows_on_record">,
  o?: Pick<OfficialRoll, "yea" | "nay" | "present" | "not_voting"> | null,
): string {
  const parts = [`${n(r.yes)} yes`, `${n(r.no)} no`, `${n(r.present)} present`, `${n(r.not_voting)} not voting`];
  if (r.other > 0) parts.push(`${n(r.other)} other`);
  const of = officialTotal(o);
  const shown = of !== null && r.rows_on_record <= of ? `${n(r.rows_on_record)} of ${n(of)}` : n(r.rows_on_record);
  const plural = (of !== null && r.rows_on_record <= of ? of : r.rows_on_record) === 1 ? "vote" : "votes";
  return `Recorded here: ${parts.join(" · ")} — ${shown} member ${plural} on record`;
}

const sameName = (a: string, b: string) => a.replace(/[\s.]/g, "").toLowerCase() === b.replace(/[\s.]/g, "").toLowerCase();

/**
 * V6: the roll's own title. A session list's title is "<vote title>; <document
 * text>", so a list-only row is cut at the first "; ". Null when it is only
 * the measure's title, short title or number again.
 */
export function rollTitleLine(
  o: Pick<OfficialRoll, "title" | "detail_source"> | null | undefined,
  ctx: RollContext = {},
): string | null {
  const raw = text(o?.title);
  if (!raw) return null;
  const cut = o?.detail_source ? raw : text(raw.split("; ")[0]);
  if (!cut) return null;
  const known = [ctx.measureTitle, ctx.shortTitle, ctx.number].map(text).filter((s): s is string => s !== null);
  return known.some((k) => sameName(k, cut)) ? null : cut;
}

/** V7: "Tie-breaking vote: The Vice President — Yea". */
export function tieBreakerLine(o: Pick<OfficialRoll, "tie_breaker"> | null | undefined): string | null {
  const t = o?.tie_breaker;
  const by = text(t && typeof t === "object" ? t.by_whom : null);
  if (!by) return null;
  const vote = text(t?.vote);
  return vote ? `Tie-breaking vote: ${by} — ${vote}` : `Tie-breaking vote: ${by}`;
}

/**
 * V8: "By party (yea–nay): Republican 215–2 · Democratic 0–212" — the official
 * totals, parties as the clerk prints them and in its order, a party with no
 * yea and no nay left out. Final and advance rolls only.
 */
export function officialPartyLine(
  r: Pick<VoteRoll, "roll_class">,
  o: Pick<OfficialRoll, "by_party"> | null | undefined,
): string | null {
  if (r.roll_class !== "final" && r.roll_class !== "advance") return null;
  if (!Array.isArray(o?.by_party)) return null;
  const parts = o.by_party.flatMap((p) => {
    const party = text(p?.party);
    const yea = count(p?.yea) ?? 0;
    const nay = count(p?.nay) ?? 0;
    return party && (yea > 0 || nay > 0) ? [`${party} ${n(yea)}–${n(nay)}`] : [];
  });
  return parts.length > 0 ? `By party (yea–nay): ${parts.join(" · ")}` : null;
}

export type RollLines = {
  heading: string;
  title: string | null;
  result: string | null;
  official: string | null;
  byParty: string | null;
  tieBreaker: string | null;
  recorded: string;
};

/**
 * Everything the page prints for one roll, in order. With no official row (none
 * held, or the read failed) every line is what the page printed before
 * vote_rolls existed.
 */
export function rollLines(r: VoteRoll, o: OfficialRoll | null = null, ctx: RollContext = {}): RollLines {
  return {
    heading: rollHeading(r, o),
    title: rollTitleLine(o, ctx),
    result: rollResultLine(r, o),
    official: officialCountLine(o),
    byParty: officialPartyLine(r, o),
    tieBreaker: tieBreakerLine(o),
    recorded: rollRecordedLine(r, o),
  };
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
