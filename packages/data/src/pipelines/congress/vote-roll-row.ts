/**
 * FIX-1448 (cc-331 D2) — a roll's `vote_rolls` row, from whatever source
 * printed it: a House Clerk roll file, a Senate LIS roll file, or one `<vote>`
 * of a Senate session list. One parser, two callers: the nightly (votes.ts,
 * D3) builds the row from the XML it already parsed; the vote-rolls walker
 * (vote-rolls.ts, D5) from the files it fetches. Pure: no network, no database.
 *
 * WHAT EACH SOURCE PRINTS (cc-331 read 1, 2026-11-27)
 *   House <vote-metadata>: vote-question, vote-type ("2/3 YEA-AND-NAY" — the
 *     majority requirement), vote-result, action-date ("15-Dec-2025"),
 *     action-time with time-etz ("19:02", Eastern), vote-desc (the title), and
 *     vote-totals: totals-by-party rows and the totals-by-vote row, each
 *     yea-total / nay-total / present-total / not-voting-total.
 *   Senate <roll_call_vote>: question, vote_title, vote_document_text,
 *     vote_result, vote_result_text, majority_requirement ("1/2", "3/5"),
 *     vote_date and modify_date ("September 24, 2026,  11:46 AM", Eastern),
 *     <count> yeas / nays / present / absent (an empty <present/> is 0), and
 *     <tie_breaker> by_whom / tie_breaker_vote (empty unless cast).
 *   Senate session list <vote_summary> (vote_menu_<congress>_<session>.xml):
 *     congress, session, congress_year, and one <vote> a roll: vote_number
 *     ("00243"), vote_date ("24-Sep", the year is congress_year), question
 *     (sometimes with a nested <measure>), result (the short form, "Agreed
 *     to"), vote_tally yeas / nays, title ("<vote_title>; <document text>").
 *
 * NULL means the file that was read does not carry the field. An empty
 * element inside a present totals block is 0. An empty text element is NULL.
 *
 * THE MERGE (mergeVoteRoll): a per-roll file's fields are never overwritten by
 * a list's; a list fills only what is NULL; a later per-roll read replaces an
 * earlier one, every field it owns.
 */

import { XMLParser } from "fast-xml-parser";

export type Chamber = "House" | "Senate";
export type DetailSource = "clerk_xml" | "lis_roll_xml";

/** What a roll_call_id says about its roll. */
export interface RollIdentity {
  roll_call_id: string;
  chamber: Chamber;
  congress: number;
  session: 1 | 2;
  roll_number: number;
  source_url: string;
}

/** Type aliases, not interfaces: they must assign to the jsonb columns' Json. */
export type PartyTotals = {
  party: string | null;
  yea: number | null;
  nay: number | null;
  present: number | null;
  not_voting: number | null;
};

export type TieBreaker = {
  by_whom: string;
  vote: string | null;
};

/** The columns a source fills. */
export interface RollFields {
  vote_date: string | null;
  voted_at: string | null;
  question: string | null;
  title: string | null;
  document_text: string | null;
  result: string | null;
  result_text: string | null;
  yea: number | null;
  nay: number | null;
  present: number | null;
  not_voting: number | null;
  majority_requirement: string | null;
  tie_breaker: TieBreaker | null;
  by_party: PartyTotals[] | null;
  source_modified_at: string | null;
}

export interface VoteRollRow extends RollIdentity, RollFields {
  detail_source: DetailSource | null;
  detail_fetched_at: string | null;
  detail_error: string | null;
  detail_error_at: string | null;
  list_fetched_at: string | null;
}

/** Every column a per-roll file owns. A per-roll read writes all of them. */
export const FIELD_COLUMNS = [
  "vote_date", "voted_at", "question", "title", "document_text", "result", "result_text",
  "yea", "nay", "present", "not_voting", "majority_requirement", "tie_breaker", "by_party",
  "source_modified_at",
] as const satisfies readonly (keyof RollFields)[];

/** The columns a session list carries. It fills them only where NULL. */
export const LIST_COLUMNS = ["vote_date", "question", "title", "result", "yea", "nay"] as const satisfies readonly (keyof RollFields)[];
export type ListFields = Pick<RollFields, (typeof LIST_COLUMNS)[number]>;

export const IDENTITY_COLUMNS = ["roll_call_id", "chamber", "congress", "session", "roll_number", "source_url"] as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const HOUSE_ID = /^(\d{4})-house-(\d{3,4})$/;
const SENATE_ID = /^senate-(\d{3})-([12])-(\d{5})$/;

/** The Senate LIS roll file a roll lives at (votes.ts's walk builds the same URL). */
export function senateRollUrl(congress: number, session: number, rollNumber: number): string {
  const padded = String(rollNumber).padStart(5, "0");
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
}

/** A session's list file. */
export function senateListUrl(congress: number, session: number): string {
  return `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
}

/**
 * `2025-house-336` → the 119th, session 1, roll 336 at clerk.house.gov/evs/2025/roll336.xml;
 * `senate-119-2-00243` → the LIS file. Null for any other shape (Legistar, the
 * synthetic chambers): the walker counts those and seeds nothing.
 */
export function rollIdentity(rollCallId: string): RollIdentity | null {
  const h = HOUSE_ID.exec(rollCallId);
  if (h) {
    const year = Number(h[1]);
    if (year < 1789) return null;
    return {
      roll_call_id: rollCallId,
      chamber: "House",
      congress: Math.floor((year - 1789) / 2) + 1,
      session: year % 2 === 1 ? 1 : 2,
      roll_number: Number(h[2]),
      source_url: `https://clerk.house.gov/evs/${year}/roll${h[2]}.xml`,
    };
  }
  const s = SENATE_ID.exec(rollCallId);
  if (s) {
    const congress = Number(s[1]);
    const session = Number(s[2]) as 1 | 2;
    const rollNumber = Number(s[3]);
    return {
      roll_call_id: rollCallId,
      chamber: "Senate",
      congress,
      session,
      roll_number: rollNumber,
      source_url: senateRollUrl(congress, session, rollNumber),
    };
  }
  return null;
}

/** The roll_call_id a Senate roll is stored under. */
export function senateRollCallId(congress: number, session: number, rollNumber: number): string {
  return `senate-${congress}-${session}-${String(rollNumber).padStart(5, "0")}`;
}

// ---------------------------------------------------------------------------
// Reading parsed XML
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

/** A parsed element's text: a string, a number, an attributed element's `#text`. */
function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node && typeof node === "object" && "#text" in node) return nodeText((node as Node)["#text"]);
  return "";
}

/** Trimmed, inner whitespace collapsed; an empty element is NULL. */
function text(node: unknown): string | null {
  const s = nodeText(node).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

function obj(node: unknown): Node | null {
  return node && typeof node === "object" && !Array.isArray(node) ? (node as Node) : null;
}

/**
 * A total inside a totals block the file carries: an empty element is 0; an
 * element the block does not have is NULL; text that is not a count is NULL.
 */
function total(block: Node, key: string): number | null {
  if (!(key in block)) return null;
  const s = nodeText(block[key]).trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
};

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Minutes America/New_York is ahead of UTC at an instant (−300 or −240). */
function easternOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - utcMs) / 60_000;
}

/** An Eastern wall-clock time as a UTC ISO instant. */
export function easternInstant(date: string, hour: number, minute: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let utc = wall + 5 * 3_600_000;
  for (let i = 0; i < 2; i++) utc = wall - easternOffsetMinutes(utc) * 60_000;
  return new Date(utc).toISOString();
}

/** "7:02 PM" → [19, 2]. */
function clock12(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === "P") h += 12;
  return [h, Number(m[2])];
}

/** "15-Dec-2025" → 2025-12-15. */
function houseDate(s: string | null): string | null {
  const m = s ? /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s) : null;
  const mon = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  return m && mon ? ymd(Number(m[3]), mon, Number(m[1])) : null;
}

/** "September 24, 2026,  11:46 AM" → the date, and the instant when a time is printed. */
function senateDateTime(s: string | null): { date: string | null; at: string | null } {
  const m = s ? /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:,?\s+(\d{1,2}:\d{2}\s*[AP]M))?/i.exec(s) : null;
  const mon = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
  if (!m || !mon) return { date: null, at: null };
  const date = ymd(Number(m[3]), mon, Number(m[2]));
  const hm = m[4] ? clock12(m[4]) : null;
  return { date, at: hm ? easternInstant(date, hm[0], hm[1]) : null };
}

// ---------------------------------------------------------------------------
// The three sources
// ---------------------------------------------------------------------------

function emptyFields(): RollFields {
  return {
    vote_date: null, voted_at: null, question: null, title: null, document_text: null,
    result: null, result_text: null, yea: null, nay: null, present: null, not_voting: null,
    majority_requirement: null, tie_breaker: null, by_party: null, source_modified_at: null,
  };
}

/** A House Clerk roll's fields, from parseHouseRoll()'s `meta` (<vote-metadata>). */
export function houseRollFields(meta: Node): RollFields {
  const f = emptyFields();
  f.question = text(meta["vote-question"]);
  f.title = text(meta["vote-desc"]);
  f.result = text(meta["vote-result"]);
  f.majority_requirement = text(meta["vote-type"]);
  f.vote_date = houseDate(text(meta["action-date"]));

  const timeNode = meta["action-time"];
  const etz = text(obj(timeNode)?.["@_time-etz"]);
  const hm = etz && /^\d{1,2}:\d{2}$/.test(etz)
    ? (etz.split(":").map(Number) as [number, number])
    : clock12(nodeText(timeNode));
  if (f.vote_date && hm) f.voted_at = easternInstant(f.vote_date, hm[0], hm[1]);

  const totals = obj(meta["vote-totals"]);
  const byVote = obj(totals?.["totals-by-vote"]);
  if (byVote) {
    f.yea = total(byVote, "yea-total");
    f.nay = total(byVote, "nay-total");
    f.present = total(byVote, "present-total");
    f.not_voting = total(byVote, "not-voting-total");
  }
  const rawParty = totals?.["totals-by-party"];
  const partyRows = (Array.isArray(rawParty) ? rawParty : rawParty ? [rawParty] : []).map(obj).filter((p): p is Node => p !== null);
  if (partyRows.length > 0) {
    f.by_party = partyRows.map((p) => ({
      party: text(p["party"]),
      yea: total(p, "yea-total"),
      nay: total(p, "nay-total"),
      present: total(p, "present-total"),
      not_voting: total(p, "not-voting-total"),
    }));
  }
  return f;
}

/** A Senate LIS roll's fields, from parseSenateRoll()'s `<roll_call_vote>` root. */
export function senateRollFields(root: Node): RollFields {
  const f = emptyFields();
  f.question = text(root["question"]);
  f.title = text(root["vote_title"]);
  f.document_text = text(root["vote_document_text"]);
  f.result = text(root["vote_result"]);
  f.result_text = text(root["vote_result_text"]);
  f.majority_requirement = text(root["majority_requirement"]);
  const when = senateDateTime(text(root["vote_date"]));
  f.vote_date = when.date;
  f.voted_at = when.at;
  f.source_modified_at = senateDateTime(text(root["modify_date"])).at;

  const count = obj(root["count"]);
  if (count) {
    f.yea = total(count, "yeas");
    f.nay = total(count, "nays");
    f.present = total(count, "present");
    f.not_voting = total(count, "absent");
  }
  const tie = obj(root["tie_breaker"]);
  const byWhom = text(tie?.["by_whom"]);
  if (byWhom) f.tie_breaker = { by_whom: byWhom, vote: text(tie?.["tie_breaker_vote"]) };
  return f;
}

export interface ListEntry {
  roll_call_id: string;
  fields: ListFields;
}

export interface SessionList {
  congress: number;
  session: 1 | 2;
  year: number;
  entries: ListEntry[];
}

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "vote",
});

/** A Senate session list, or null when the body is not one. */
export function parseSenateVoteMenu(xml: string): SessionList | null {
  if (!xml.includes("<vote_summary")) return null;
  let root: Node | null;
  try {
    root = obj(listParser.parse(xml)?.["vote_summary"]);
  } catch {
    return null;
  }
  if (!root) return null;
  const congress = Number(text(root["congress"]));
  const session = Number(text(root["session"]));
  const year = Number(text(root["congress_year"]));
  if (!Number.isInteger(congress) || (session !== 1 && session !== 2) || !Number.isInteger(year)) return null;
  const votes = (obj(root["votes"])?.["vote"] as unknown[] | undefined) ?? [];
  const entries: ListEntry[] = [];
  for (const raw of votes) {
    const v = obj(raw);
    const num = Number(text(v?.["vote_number"]));
    if (!v || !Number.isInteger(num) || num <= 0) continue;
    const d = /^(\d{1,2})-([A-Za-z]{3})$/.exec(text(v["vote_date"]) ?? "");
    const mon = d ? MONTHS[d[2]!.toLowerCase()] : undefined;
    const tally = obj(v["vote_tally"]);
    entries.push({
      roll_call_id: senateRollCallId(congress, session, num),
      fields: {
        vote_date: d && mon ? ymd(year, mon, Number(d[1])) : null,
        question: text(v["question"]),
        title: text(v["title"]),
        result: text(v["result"]),
        yea: tally ? total(tally, "yeas") : null,
        nay: tally ? total(tally, "nays") : null,
      },
    });
  }
  return { congress, session: session as 1 | 2, year, entries };
}

// ---------------------------------------------------------------------------
// Rows and the merge
// ---------------------------------------------------------------------------

/** A seeded row: what the id gives, nothing read yet. */
export function seedRow(id: RollIdentity): VoteRollRow {
  return {
    ...id, ...emptyFields(),
    detail_source: null, detail_fetched_at: null, detail_error: null, detail_error_at: null, list_fetched_at: null,
  };
}

export type Incoming =
  | { kind: "detail"; source: DetailSource; at: string; fields: RollFields }
  | { kind: "list"; at: string; fields: ListFields | null }
  | { kind: "detail_error"; at: string; reason: string };

/**
 * D2's three rules. `list` with null fields is a list that does not carry the
 * roll: it stamps list_fetched_at and fills nothing.
 */
export function mergeVoteRoll(current: VoteRollRow, incoming: Incoming): VoteRollRow {
  if (incoming.kind === "detail") {
    return {
      ...current,
      ...incoming.fields,
      detail_source: incoming.source,
      detail_fetched_at: incoming.at,
      detail_error: null,
      detail_error_at: null,
    };
  }
  if (incoming.kind === "detail_error") {
    return { ...current, detail_error: incoming.reason, detail_error_at: incoming.at };
  }
  const next: VoteRollRow = { ...current, list_fetched_at: incoming.at };
  if (current.detail_fetched_at !== null || incoming.fields === null) return next;
  for (const col of LIST_COLUMNS) {
    if (next[col] === null) (next as unknown as Record<string, unknown>)[col] = incoming.fields[col];
  }
  return next;
}

/**
 * What a per-roll read upserts: the identity, every field it owns, the stamp.
 * Upserting it is mergeVoteRoll(current, detail) for any current row, because
 * a detail replaces every column it sends and sends none of the list's stamp.
 */
export type DetailUpsert = Omit<VoteRollRow, "list_fetched_at">;

export function detailUpsertRow(id: RollIdentity, source: DetailSource, at: string, fields: RollFields): DetailUpsert {
  const merged = mergeVoteRoll(seedRow(id), { kind: "detail", source, at, fields });
  const row: Partial<VoteRollRow> = { ...merged };
  delete row.list_fetched_at;
  return row as DetailUpsert;
}

// ---------------------------------------------------------------------------
// The nightly's write (D3)
// ---------------------------------------------------------------------------

export interface RollRowWrite {
  written: number;
  failed: number;
  failures: Array<{ roll: string; why: string }>;
}

const ROW_CHUNK = 200;
const FAILURES_KEPT = 25;

/**
 * Upsert the nightly's roll rows. Never throws: a failed write is logged and
 * counted, and the votes write it follows is already done. The walker is the
 * net for any roll whose row did not land.
 */
export async function writeVoteRollRows<R extends { roll_call_id: string }>(
  rows: readonly R[],
  upsert: (chunk: R[]) => PromiseLike<{ error: { message: string } | null }>,
  log: (line: string) => void,
): Promise<RollRowWrite> {
  const out: RollRowWrite = { written: 0, failed: 0, failures: [] };
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    const chunk = rows.slice(i, i + ROW_CHUNK);
    let why: string | null = null;
    try {
      const { error } = await upsert(chunk);
      if (error) why = error.message;
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (why === null) {
      out.written += chunk.length;
      continue;
    }
    out.failed += chunk.length;
    for (const r of chunk) if (out.failures.length < FAILURES_KEPT) out.failures.push({ roll: r.roll_call_id, why: why.slice(0, 200) });
    log(`  ⚠ FIX-1448: ${chunk.length} vote_rolls row(s) not written (the votes rows are) — ${why.slice(0, 200)}`);
  }
  return out;
}
