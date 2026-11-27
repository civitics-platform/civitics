/**
 * FIX-1462 (cc-332 B1–B7) — what the bill page prints from the bill-details
 * fill (cc-327 → cc-330): the sponsor, cosponsors, actions, short title and
 * policy area of a federal bill or resolution.
 *
 * The walker writes, per measure it stamps:
 *   - on the measure's congress_gov row of external_source_refs,
 *     `metadata.detail`: the source's sponsor {name, party, state, district,
 *     bioguide}, `sponsor_official_id` (the one officials row its bioguide
 *     resolved to, or null), `short_title`, `policy_area`, `cosponsor_count`
 *     (withdrawn excluded), `action_count`, `fetched_at`; a 404 is
 *     `{fetched_at, http_status, not_found: true}`;
 *   - proposal_cosponsors rows for the cosponsors that resolved to an official;
 *   - proposal_actions rows, source 'congress_gov', one per source action.
 * The counts printed are the SOURCE's; the rows are "on record here". A read
 * that failed prints nothing for its block — an empty answer from a failed
 * read is never "no cosponsors".
 */

/** The bill types the walker reads (bill-details-parse.ts BILL_TYPES). Nominations carry a ref too and are not read. */
export const CONGRESS_BILL_TYPES = ["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"] as const;

const BILL_NUMBER_RE = new RegExp(`^(${CONGRESS_BILL_TYPES.join("|")}) \\d+$`);
const BILL_REF_RE = new RegExp(`^\\d+-(${CONGRESS_BILL_TYPES.join("|")})-\\d+$`);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * B1: a federal bill or resolution — bill_details carries a Congress and a
 * number of a type the walker reads. Anything else (a regulation, a Legistar
 * or OpenStates measure, a nomination) makes none of the three reads.
 */
export function isCongressMeasure(
  bd: { bill_number: string | null; congress_number: number | null } | null | undefined,
): boolean {
  if (bd?.congress_number == null) return false;
  const number = text(bd.bill_number);
  return number !== null && BILL_NUMBER_RE.test(number);
}

// ── The ref's detail stamp ───────────────────────────────────────────────────

export type SourceSponsor = {
  bioguide?: string | null;
  name: string | null;
  party: string | null;
  state: string | null;
  district?: number | null;
};

export type CongressDetail = {
  fetched_at?: string | null;
  not_found?: boolean | null;
  sponsor?: SourceSponsor | null;
  sponsor_official_id?: string | null;
  short_title?: string | null;
  policy_area?: string | null;
  cosponsor_count?: number | null;
  action_count?: number | null;
};

export type CongressRefRow = { external_id: string; detail: CongressDetail | null };

export type DetailStatus =
  | { kind: "failed" }
  | { kind: "no_ref" }
  | { kind: "not_found" }
  | { kind: "not_collected" }
  | { kind: "collected"; detail: CongressDetail };

/**
 * The measure's bill ref, from the congress_gov refs of the proposal (null when
 * the read failed). A stamped ref wins over an unstamped one.
 */
export function detailStatus(rows: CongressRefRow[] | null): DetailStatus {
  if (rows === null) return { kind: "failed" };
  const bills = rows.filter((r) => BILL_REF_RE.test(r.external_id ?? ""));
  if (bills.length === 0) return { kind: "no_ref" };
  const stamped = bills.find((r) => text(r.detail?.fetched_at)) ?? bills[0]!;
  const d = stamped.detail;
  if (!d || !text(d.fetched_at)) return { kind: "not_collected" };
  if (d.not_found === true) return { kind: "not_found" };
  return { kind: "collected", detail: d };
}

/** B7: the line where the sponsor would be, for a measure the walker has not reached. A 404 stamp prints nothing. */
export const NOT_COLLECTED_LINE =
  "Sponsor, cosponsors and actions have not been collected from Congress.gov for this measure yet.";

export function notCollectedLine(s: DetailStatus): string | null {
  return s.kind === "not_collected" ? NOT_COLLECTED_LINE : null;
}

// ── B2: the heading ──────────────────────────────────────────────────────────

/** Letters and digits only: case, spaces and punctuation ignored (`America’s` = `America's`). */
const letters = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export type BillHeading = { heading: string; sub: { label: string; text: string } | null };

/**
 * B2. The shorter of the stored title and the source's short title is the
 * heading; the other sits under it — "Official title" when the stored title is
 * the longer, "Short title, per Congress.gov" when the short title is. Equal on
 * letters and digits, or no short title: the stored title, nothing added.
 */
export function billHeading(storedTitle: string, shortTitle: string | null | undefined): BillHeading {
  const stored = storedTitle.trim();
  const short = text(shortTitle);
  if (!short || letters(short) === letters(stored)) return { heading: storedTitle, sub: null };
  return short.length < stored.length
    ? { heading: short, sub: { label: "Official title", text: stored } }
    : { heading: storedTitle, sub: { label: "Short title, per Congress.gov", text: short } };
}

// ── B3: the sponsor line ─────────────────────────────────────────────────────

export type SponsorEmbed = { id: string; full_name: string } | null;

export type SponsorLine = { name: string; href: string | null; tag: string | null };

/** "R-AR-3"; a senator "R-AR"; district 0 is an at-large seat, as Congress.gov prints it. */
export function sponsorTag(s: SourceSponsor | null | undefined): string | null {
  const party = text(s?.party);
  const state = text(s?.state);
  const district = num(s?.district);
  const parts = [party, state, district === null ? null : district === 0 ? "At Large" : String(district)].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join("-") : null;
}

/**
 * B3. The sponsor's name linked to the official's page when the source's
 * sponsor resolved to the official bill_details names; the source's own name,
 * unlinked, otherwise. Null when the source names no single sponsor. The
 * source's name carries its own "[R-TX-19]", which the tag already prints.
 */
export function sponsorLine(detail: CongressDetail, embed: SponsorEmbed): SponsorLine | null {
  const s = detail.sponsor ?? null;
  const tag = sponsorTag(s);
  const resolved = text(detail.sponsor_official_id);
  if (embed && resolved && embed.id === resolved && text(embed.full_name)) {
    return { name: embed.full_name.trim(), href: `/officials/${embed.id}`, tag };
  }
  const raw = text(s?.name);
  const name = raw && tag ? text(raw.replace(/\s*\[[^\]]*\]\s*$/, "")) : raw;
  return name ? { name, href: null, tag } : null;
}

// ── B4: cosponsors ───────────────────────────────────────────────────────────

const n = (v: number) => v.toLocaleString("en-US");

/** B4: "302 cosponsors, per Congress.gov"; "No cosponsors, per Congress.gov" only when the source's count is 0. */
export function cosponsorCountLine(detail: CongressDetail | null | undefined): string | null {
  const c = num(detail?.cosponsor_count);
  if (c === null) return null;
  if (c === 0) return "No cosponsors, per Congress.gov";
  return `${n(c)} ${c === 1 ? "cosponsor" : "cosponsors"}, per Congress.gov`;
}

export type CosponsorRow = {
  official_id: string;
  is_original_cosponsor: boolean;
  date_added: string | null;
  date_withdrawn: string | null;
  official: {
    id: string;
    full_name: string;
    party: string | null;
    district_name: string | null;
    role_title: string | null;
  } | null;
};

const PARTY_ABBR: readonly [string, string][] = [
  ["democrat", "D"],
  ["republican", "R"],
  ["independent", "I"],
];

/** "D", "R", "I"; any other party "Other"; none null. */
export function partyAbbr(party: string | null | undefined): string | null {
  const p = text(party)?.toLowerCase();
  if (!p) return null;
  return PARTY_ABBR.find(([k]) => k === p)?.[1] ?? "Other";
}

/**
 * B4, the line under the count: the party split of the stored non-withdrawn
 * rows, and "297 of 302 on record here" when they are fewer than the source's
 * count. Stored above the source: no "of". Null when there is nothing to say.
 */
export function cosponsorRecordLine(sourceCount: number | null | undefined, rows: CosponsorRow[]): string | null {
  const active = rows.filter((r) => !r.date_withdrawn);
  const src = num(sourceCount);
  const counts = new Map<string, number>();
  for (const r of active) {
    const a = partyAbbr(r.official?.party) ?? "Other";
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const split = ["D", "R", "I", "Other"]
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .map((k) => `${k} ${n(counts.get(k)!)}`)
    .join(" · ");
  const fewer = src !== null && active.length < src;
  if (fewer) return split ? `${n(active.length)} of ${n(src)} on record here, by party: ${split}` : `${n(active.length)} of ${n(src)} on record here`;
  return split ? `On record here, by party: ${split}` : null;
}

/** B4: original cosponsors first, then by date added, then name; withdrawn rows last, by the date they withdrew. */
export function orderCosponsors(rows: CosponsorRow[]): { active: CosponsorRow[]; withdrawn: CosponsorRow[] } {
  const name = (r: CosponsorRow) => r.official?.full_name ?? "";
  const byDate = (a: string | null, b: string | null) => (a ?? "9999").localeCompare(b ?? "9999");
  const active = rows
    .filter((r) => !r.date_withdrawn)
    .sort(
      (a, b) =>
        Number(b.is_original_cosponsor) - Number(a.is_original_cosponsor) ||
        byDate(a.date_added, b.date_added) ||
        name(a).localeCompare(name(b)),
    );
  const withdrawn = rows
    .filter((r) => r.date_withdrawn)
    .sort((a, b) => byDate(a.date_withdrawn, b.date_withdrawn) || name(a).localeCompare(name(b)));
  return { active, withdrawn };
}

/** "March 4, 2025" from a stored date ("2025-03-04"); null when it is not one. */
export function recordDate(iso: string | null | undefined): string | null {
  const t = text(iso);
  if (!t || !/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(`${t.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "withdrew March 4, 2025". */
export function withdrawnLabel(r: Pick<CosponsorRow, "date_withdrawn">): string {
  const d = recordDate(r.date_withdrawn);
  return d ? `withdrew ${d}` : "withdrew";
}

// ── B5: actions ──────────────────────────────────────────────────────────────

export type ActionRow = {
  action_at: string;
  description: string | null;
  /** metadata->>action_date: the source's date, "YYYY-MM-DD" (Eastern). */
  action_date: string | null;
  /** metadata->>action_time: "HH:MM:SS", only when the source gives one. */
  action_time: string | null;
  /** metadata->source_system->>code. */
  system: string | null;
};

export type ActionLine = { date: string | null; text: string; times: number | null };

export const ACTIONS_VISIBLE = 8;

const canonical = (s: string) => s.replace(/\s+/g, " ").trim();

/** The source's date for an action: action_date, else action_at read in Eastern time. */
function actionDay(r: ActionRow): string | null {
  const d = text(r.action_date);
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const at = new Date(r.action_at);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * B5. One line per (date, description), newest first, in the rows' order.
 * Congress.gov lists one event under several source systems (a House floor
 * action and the Library of Congress's copy, the second often without a
 * time), under two action codes, or once per committee of a referral — each
 * of those prints once. cc-332 read 5: a repeat inside ONE source system at
 * distinct times is a real repetition (the House resolving into the Committee
 * of the Whole three times in a day) and carries "× N", N the most distinct
 * times one system gives it.
 */
export function actionLines(rows: ActionRow[]): ActionLine[] {
  const groups = new Map<string, { day: string | null; text: string; times: Map<string, Set<string>> }>();
  for (const r of rows) {
    const desc = text(r.description);
    if (!desc) continue;
    const day = actionDay(r);
    const key = `${day ?? ""}\u0000${canonical(desc)}`;
    let g = groups.get(key);
    if (!g) {
      g = { day, text: canonical(desc), times: new Map() };
      groups.set(key, g);
    }
    const t = text(r.action_time);
    if (t) {
      const sys = text(r.system) ?? "?";
      const set = g.times.get(sys) ?? new Set<string>();
      set.add(t);
      g.times.set(sys, set);
    }
  }
  return [...groups.values()].map((g) => {
    const most = Math.max(0, ...[...g.times.values()].map((s) => s.size));
    return { date: recordDate(g.day), text: g.text, times: most >= 2 ? most : null };
  });
}

/** "March 4, 2025 · Referred to the House Committee on …", with " × 3" for a real repetition. */
export function actionText(l: ActionLine): string {
  const body = l.times ? `${l.text} × ${l.times}` : l.text;
  return l.date ? `${l.date} · ${body}` : body;
}

/** B5: the section's count is the source's — "59 actions, per Congress.gov". */
export function actionsCountLine(detail: CongressDetail | null | undefined): string | null {
  const c = num(detail?.action_count);
  if (c === null) return null;
  return `${n(c)} ${c === 1 ? "action" : "actions"}, per Congress.gov`;
}

/** "N earlier actions" — the lines behind the <details>. */
export function earlierActionsLabel(hidden: number): string {
  return `${n(hidden)} earlier ${hidden === 1 ? "action" : "actions"}`;
}

// ── B6 ───────────────────────────────────────────────────────────────────────

export function policyArea(detail: CongressDetail | null | undefined): string | null {
  return text(detail?.policy_area);
}
