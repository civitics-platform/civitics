/**
 * FIX-1452 (cc-327) — pure parsers for the congress.gov bill-details walker
 * (./bill-details.ts). Rows in, rows out: no network, no database, so every
 * rule below is pinned by ./bill-details-parse.test.ts over the real responses
 * saved in ./__fixtures__/bill-*.json (cc-327 read 2, 2026-11-26).
 *
 * THE SHAPES, AS READ (read 2 — the API won over the prompt's guesses)
 *   /bill/{c}/{t}/{n}       bill.sponsors[] {bioguideId, fullName, party, state,
 *                           district?}, bill.introducedDate, bill.title,
 *                           bill.policyArea.name, bill.updateDate, and
 *                           bill.cosponsors {count, countIncludingWithdrawnCosponsors}
 *                           — the cosponsors KEY IS ABSENT when there are none
 *                           (HR 1 of the 119th), so absence is a count of 0.
 *   …/cosponsors            cosponsors[] {bioguideId, fullName, party, state,
 *                           isOriginalCosponsor, sponsorshipDate,
 *                           sponsorshipWithdrawnDate?}; pagination {count,
 *                           countIncludingWithdrawnCosponsors, next?}. `count`
 *                           EXCLUDES withdrawn cosponsors. The withdrawn date was
 *                           not seen in the five measures read; the name is
 *                           congress.gov's documented one.
 *   …/actions               actions[] {actionDate, actionTime?, text, type,
 *                           actionCode?, sourceSystem {code?, name},
 *                           recordedVotes?, committees?, calendarNumber?};
 *                           pagination {count, next?}. actionTime is Eastern
 *                           wall time (16:26:08 against a roll stamped
 *                           20:26:08Z). Senate actions carry NO sourceSystem.code,
 *                           NO actionCode and NO actionTime.
 *   …/titles                titles[] {title, titleType, titleTypeCode, updateDate}.
 *
 * THE ACTION KEY (D4, read 3)
 * `(proposal_id, action_type, action_at)` merged real rows on all four lists
 * read (HR 1: 35 rows in 6 groups; 118-HR-21: 5 in 2). The same day's Senate
 * floor actions differ ONLY by text — no code, no time — so the key has to
 * carry the text. `actionSourceKey` hashes (source system, action code, date,
 * time, whitespace-collapsed text, committee codes): zero collisions on the
 * same four lists, and the committees keep a two-committee referral's two
 * listings apart (found by the first live local run).
 * The type is left out (it is the `action_type` column) so a re-categorised
 * action keeps its key; two actions that differ ONLY by type collide and the
 * walker counts the second as a duplicate rather than storing it.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Response shapes (only the fields read)
// ---------------------------------------------------------------------------

export interface SourceMemberRaw {
  bioguideId?: string;
  fullName?: string;
  party?: string;
  state?: string;
  district?: number | null;
}

export interface BillDetailResponse {
  bill?: {
    congress?: number;
    type?: string;
    number?: string;
    title?: string;
    introducedDate?: string;
    updateDate?: string;
    policyArea?: { name?: string } | null;
    sponsors?: SourceMemberRaw[];
    cosponsors?: { count?: number; countIncludingWithdrawnCosponsors?: number };
    actions?: { count?: number };
    titles?: { count?: number };
  };
}

export interface CosponsorsPage {
  cosponsors?: Array<SourceMemberRaw & {
    isOriginalCosponsor?: boolean;
    sponsorshipDate?: string;
    sponsorshipWithdrawnDate?: string;
  }>;
  pagination?: { count?: number; countIncludingWithdrawnCosponsors?: number; next?: string };
}

export interface ActionsPage {
  actions?: Array<{
    actionDate?: string;
    actionTime?: string;
    text?: string;
    type?: string;
    actionCode?: string;
    sourceSystem?: { code?: number; name?: string };
    recordedVotes?: Array<{ chamber?: string; rollNumber?: number; sessionNumber?: number; date?: string }>;
    committees?: Array<{ name?: string; systemCode?: string }>;
    calendarNumber?: { calendar?: string; number?: string };
  }>;
  pagination?: { count?: number; next?: string };
}

export interface TitlesPage {
  titles?: Array<{ title?: string; titleType?: string; titleTypeCode?: number; updateDate?: string }>;
  pagination?: { count?: number; next?: string };
}

// ---------------------------------------------------------------------------
// The measure key
// ---------------------------------------------------------------------------

/**
 * The bill types `/bill/{congress}/{type}/{number}` serves. A `congress_gov`
 * proposal ref also exists for every nomination (`119-PN-11-11`, prod: 736 of
 * 9,719, read 5) — those are not bills and are never selected.
 */
export const BILL_TYPES = ["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"] as const;

/** `119-HJRES-141` → the lowercased API path parts; null for anything else. */
export function parseBillKey(billKey: string): { congress: number; type: string; number: string } | null {
  const parts = billKey.split("-");
  if (parts.length !== 3) return null;
  const [congress, type, number] = parts as [string, string, string];
  if (!/^\d+$/.test(congress) || !/^\d+$/.test(number)) return null;
  if (!(BILL_TYPES as readonly string[]).includes(type)) return null;
  return { congress: Number(congress), type: type.toLowerCase(), number };
}

/** `bill/119/hr/1`, `bill/119/hr/1/actions`, … */
export function billPath(key: { congress: number; type: string; number: string }, sub?: "cosponsors" | "actions" | "titles"): string {
  const base = `bill/${key.congress}/${key.type}/${key.number}`;
  return sub ? `${base}/${sub}?limit=250` : base;
}

// ---------------------------------------------------------------------------
// HTTP outcomes
// ---------------------------------------------------------------------------

/** The status `fetchCongressApi`'s error carries ("Congress.gov API error: 429 …"); null for a network error. */
export function httpStatusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/Congress\.gov API error: (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** A response the next request may not see: rate-limited, the server's fault, or no response at all. */
export function isTransient(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** The sponsor as the source gives it — what a page prints when no officials row matches (D3). */
export interface SourceMember {
  bioguide: string;
  name: string | null;
  party: string | null;
  state: string | null;
  district?: number;
}

export interface ParsedDetail {
  /** Null when the source lists no sponsor or more than one. */
  sponsor: SourceMember | null;
  sponsorsListed: number;
  title: string | null;
  introducedDate: string | null;
  policyArea: string | null;
  /** The source's count, withdrawn cosponsors excluded. 0 when the key is absent. */
  cosponsorCount: number;
  cosponsorCountIncludingWithdrawn: number;
  actionCount: number | null;
  titleCount: number | null;
  updateDate: string | null;
}

function trimmed(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function isoDate(s: string | null | undefined): string | null {
  const t = trimmed(s);
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function member(raw: SourceMemberRaw): SourceMember | null {
  const bioguide = trimmed(raw.bioguideId);
  if (!bioguide) return null;
  const out: SourceMember = {
    bioguide,
    name: trimmed(raw.fullName),
    party: trimmed(raw.party),
    state: trimmed(raw.state),
  };
  if (typeof raw.district === "number") out.district = raw.district;
  return out;
}

export function parseBillDetail(resp: BillDetailResponse): ParsedDetail {
  const b = resp.bill ?? {};
  const sponsors = b.sponsors ?? [];
  return {
    sponsor: sponsors.length === 1 ? member(sponsors[0]!) : null,
    sponsorsListed: sponsors.length,
    title: trimmed(b.title),
    introducedDate: isoDate(b.introducedDate),
    policyArea: trimmed(b.policyArea?.name),
    cosponsorCount: b.cosponsors?.count ?? 0,
    cosponsorCountIncludingWithdrawn: b.cosponsors?.countIncludingWithdrawnCosponsors ?? b.cosponsors?.count ?? 0,
    actionCount: b.actions?.count ?? null,
    titleCount: b.titles?.count ?? null,
    updateDate: trimmed(b.updateDate),
  };
}

/** Skip the request when the detail says the list is empty; saves one of four requests on most measures. */
export function needsCosponsors(d: ParsedDetail): boolean {
  return d.cosponsorCountIncludingWithdrawn > 0;
}

export function needsTitles(d: ParsedDetail): boolean {
  return d.titleCount === null || d.titleCount > 0;
}

export function nextPage(p: { pagination?: { next?: string } }): string | null {
  return trimmed(p.pagination?.next);
}

// ---------------------------------------------------------------------------
// Cosponsors (D5)
// ---------------------------------------------------------------------------

export interface SourceCosponsor extends SourceMember {
  isOriginal: boolean;
  dateAdded: string | null;
  dateWithdrawn: string | null;
}

export interface ParsedCosponsors {
  items: SourceCosponsor[];
  /** The source's count from the first page — withdrawn excluded. */
  count: number;
  countIncludingWithdrawn: number;
  /** Listed entries with no bioguide: nothing can resolve them. */
  noBioguide: number;
}

export function parseCosponsorPages(pages: readonly CosponsorsPage[]): ParsedCosponsors {
  const items: SourceCosponsor[] = [];
  let noBioguide = 0;
  for (const p of pages) {
    for (const raw of p.cosponsors ?? []) {
      const m = member(raw);
      if (!m) { noBioguide += 1; continue; }
      items.push({
        ...m,
        isOriginal: raw.isOriginalCosponsor === true,
        dateAdded: isoDate(raw.sponsorshipDate),
        dateWithdrawn: isoDate(raw.sponsorshipWithdrawnDate),
      });
    }
  }
  const first = pages[0]?.pagination;
  const count = first?.count ?? items.filter((c) => !c.dateWithdrawn).length;
  return {
    items,
    count,
    countIncludingWithdrawn: first?.countIncludingWithdrawnCosponsors ?? count,
    noBioguide,
  };
}

// ---------------------------------------------------------------------------
// The bioguide resolver (D3, D5 — ENGINEERING_PLAYBOOK §E13)
// ---------------------------------------------------------------------------

export interface OfficialBioguideRow {
  id: string;
  source_ids: Record<string, unknown> | null;
}

export type BioguideResolution =
  | { kind: "one"; id: string }
  | { kind: "none" }
  | { kind: "many"; ids: string[] };

/**
 * bioguide (`officials.source_ids->>'congress_gov'`) → EXACTLY one official.
 * Unlike votes-maps' `buildBioguideMap`, which keeps the first holder of a
 * contested key for the vote writer, a contested bioguide here resolves to
 * nobody: a sponsor or cosponsor is never guessed (§E13). Prod read 5: 542
 * bioguides, none on two rows.
 */
export function buildBioguideResolver(rows: readonly OfficialBioguideRow[]): (bioguide: string) => BioguideResolution {
  const byBioguide = new Map<string, string[]>();
  for (const r of rows) {
    const raw = r.source_ids?.["congress_gov"];
    const bioguide = typeof raw === "string" ? raw.trim() : "";
    if (!bioguide) continue;
    const ids = byBioguide.get(bioguide) ?? [];
    if (!ids.includes(r.id)) ids.push(r.id);
    byBioguide.set(bioguide, ids);
  }
  return (bioguide: string) => {
    const ids = byBioguide.get(bioguide.trim());
    if (!ids || ids.length === 0) return { kind: "none" };
    if (ids.length === 1) return { kind: "one", id: ids[0]! };
    return { kind: "many", ids: [...ids].sort() };
  };
}

export interface CosponsorRow {
  official_id: string;
  is_original_cosponsor: boolean;
  date_added: string | null;
  date_withdrawn: string | null;
}

export interface UnresolvedMember {
  bioguide: string;
  name: string | null;
  /** `none` — no officials row; `many` — more than one. */
  why: "none" | "many";
}

/**
 * One row per cosponsor that resolves to exactly one official. A second entry
 * for the same official (the source listing a member twice) keeps the first,
 * since `(proposal_id, official_id)` is the table's key.
 */
export function resolveCosponsors(
  items: readonly SourceCosponsor[],
  resolve: (bioguide: string) => BioguideResolution,
): { rows: CosponsorRow[]; unresolved: UnresolvedMember[]; repeated: number } {
  const rows: CosponsorRow[] = [];
  const unresolved: UnresolvedMember[] = [];
  const seen = new Set<string>();
  let repeated = 0;
  for (const c of items) {
    const r = resolve(c.bioguide);
    if (r.kind !== "one") {
      unresolved.push({ bioguide: c.bioguide, name: c.name, why: r.kind });
      continue;
    }
    if (seen.has(r.id)) { repeated += 1; continue; }
    seen.add(r.id);
    rows.push({
      official_id: r.id,
      is_original_cosponsor: c.isOriginal,
      date_added: c.dateAdded,
      date_withdrawn: c.dateWithdrawn,
    });
  }
  return { rows, unresolved, repeated };
}

// ---------------------------------------------------------------------------
// Actions (D4)
// ---------------------------------------------------------------------------

export interface ActionRow {
  action_type: string;
  /**
   * Eastern wall time, `YYYY-MM-DD HH:MM:SS` — midnight when the source gives
   * a date only. The writer converts it with `AT TIME ZONE 'America/New_York'`,
   * so a timed and an untimed action on one day keep their order and
   * `action_at AT TIME ZONE 'America/New_York'` is always the source's date.
   */
  action_at_eastern: string;
  description: string | null;
  source_key: string;
  metadata: Record<string, unknown>;
}

export interface ParsedActions {
  rows: ActionRow[];
  /** The source's count from the first page. */
  count: number;
  /** Listed actions with no usable date (`action_at` is NOT NULL). */
  undated: number;
  /** Actions whose source_key repeated one already in `rows`. */
  duplicateKey: number;
}

/** Whitespace-collapsed, so a re-spaced text keeps its key. */
function canonicalText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The action's own fields, hashed. Stable across re-fetches of an unchanged
 * action. The committees are part of it: a referral to two committees is
 * listed once per committee with the same code, date and text (119-HR-4646,
 * 119-HRES-1490 — the first live local run's two `dup_key`s).
 */
export function actionSourceKey(a: NonNullable<ActionsPage["actions"]>[number]): string {
  const committees = (a.committees ?? [])
    .map((c) => trimmed(c.systemCode) ?? trimmed(c.name) ?? "")
    .filter((c) => c !== "")
    .sort();
  const canonical = JSON.stringify([
    a.sourceSystem?.code ?? null,
    trimmed(a.sourceSystem?.name),
    trimmed(a.actionCode),
    trimmed(a.actionDate),
    trimmed(a.actionTime),
    canonicalText(a.text),
    committees,
  ]);
  return createHash("md5").update(canonical).digest("hex");
}

export function parseActionPages(pages: readonly ActionsPage[]): ParsedActions {
  const rows: ActionRow[] = [];
  const keys = new Set<string>();
  let undated = 0;
  let duplicateKey = 0;
  for (const p of pages) {
    for (const a of p.actions ?? []) {
      const date = isoDate(a.actionDate);
      if (!date) { undated += 1; continue; }
      const time = trimmed(a.actionTime);
      const hhmmss = time && /^\d{2}:\d{2}(:\d{2})?$/.test(time) ? (time.length === 5 ? `${time}:00` : time) : null;
      const key = actionSourceKey(a);
      if (keys.has(key)) { duplicateKey += 1; continue; }
      keys.add(key);
      const metadata: Record<string, unknown> = {
        action_date: date,
        source_system: { code: a.sourceSystem?.code ?? null, name: trimmed(a.sourceSystem?.name) },
      };
      if (hhmmss) metadata["action_time"] = hhmmss;
      const code = trimmed(a.actionCode);
      if (code) metadata["action_code"] = code;
      const votes = (a.recordedVotes ?? [])
        .filter((v) => typeof v.rollNumber === "number")
        .map((v) => ({ chamber: v.chamber ?? null, roll_number: v.rollNumber, session_number: v.sessionNumber ?? null, date: v.date ?? null }));
      if (votes.length > 0) metadata["recorded_votes"] = votes;
      const committees = (a.committees ?? []).map((c) => trimmed(c.name)).filter((n): n is string => n !== null);
      if (committees.length > 0) metadata["committees"] = committees;
      rows.push({
        action_type: trimmed(a.type) ?? "Unknown",
        action_at_eastern: `${date} ${hhmmss ?? "00:00:00"}`,
        description: trimmed(a.text),
        source_key: key,
        metadata,
      });
    }
  }
  return { rows, count: pages[0]?.pagination?.count ?? rows.length + undated + duplicateKey, undated, duplicateKey };
}

// ---------------------------------------------------------------------------
// Titles and the introduced date (D6 — fill, never overwrite)
// ---------------------------------------------------------------------------

/**
 * The measure's short title, when `/titles` has one for the whole measure: the
 * newest `Short Title…` that is not "for portions of this bill". HR 1 of the
 * 119th → "One Big Beautiful Bill Act" (its enacted short titles name portions).
 */
export function pickShortTitle(pages: readonly TitlesPage[]): string | null {
  const shorts = pages
    .flatMap((p) => p.titles ?? [])
    .filter((t) => /^short title/i.test(t.titleType ?? "") && !/portion/i.test(t.titleType ?? "") && trimmed(t.title));
  shorts.sort((a, b) => ((a.updateDate ?? "") < (b.updateDate ?? "") ? 1 : (a.updateDate ?? "") > (b.updateDate ?? "") ? -1 : 0));
  return trimmed(shorts[0]?.title);
}

export type FillOutcome = "filled" | "replaced_placeholder" | "same" | "kept_differs" | "no_source";

/** The `proposals.title` column is trimmed to 500 by the bills sync; the same here. */
export function titleForColumn(source: string): string {
  return source.slice(0, 500);
}

/**
 * `proposals.title` takes the source's title only when the stored one is empty
 * or is just the bill number (`bill_details.bill_number`, e.g. "HR 1234"). A
 * stored title that differs is kept and counted.
 */
export function decideTitle(stored: string | null, billNumber: string | null, source: string | null): FillOutcome {
  if (!source) return "no_source";
  const s = (stored ?? "").trim();
  if (s === titleForColumn(source)) return "same";
  if (s === "" || (billNumber !== null && s === billNumber.trim())) return "filled";
  return "kept_differs";
}

/**
 * `proposals.introduced_at` (a date) is set when NULL — and, the one deviation
 * from D6 (cc-327, with evidence), when it is the vote path's PLACEHOLDER: a
 * measure minted by a roll call carries the bill number as its title and the
 * roll's date as its introduced date (bills.ts, "the vote path's args are
 * placeholders"). On the clone 1,383 of the 1,390 number-titled measures have
 * introduced_at equal to their first vote's date, and all three the first live
 * run filled a title on had a source date that differed. `placeholderDate` is
 * that first vote's date, passed only while the title is still the number; a
 * stored date that matches it is replaced. Any other stored date is kept.
 */
export function decideIntroduced(stored: string | null, source: string | null, placeholderDate: string | null = null): FillOutcome {
  if (!source) return "no_source";
  if (stored === null) return "filled";
  const s = stored.slice(0, 10);
  if (s === source) return "same";
  if (placeholderDate !== null && s === placeholderDate.slice(0, 10)) return "replaced_placeholder";
  return "kept_differs";
}

/** The stored title is the bill number itself — the vote path's placeholder. */
export function isNumberTitle(stored: string | null, billNumber: string | null): boolean {
  return billNumber !== null && (stored ?? "").trim() === billNumber.trim() && billNumber.trim() !== "";
}
