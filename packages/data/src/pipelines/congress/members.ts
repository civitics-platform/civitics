/**
 * Congress.gov shared types and fetch utilities.
 *
 * All HTTP calls include a 200ms delay before each request to respect the
 * Congress.gov rate limit. fetchCongressApi handles both full URLs (from
 * pagination.next) and relative paths.
 */

// Default: 119th Congress (2025–2027). Overridable via CONGRESS_OVERRIDE env var
// so the backfill script can iterate 117, 118, 119 in a single run.
export const CURRENT_CONGRESS = Number(process.env["CONGRESS_OVERRIDE"] ?? 119);

const CONGRESS_API_BASE = "https://api.congress.gov/v3";

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface CongressMemberListResponse {
  members: CongressMember[];
  pagination: { count: number; next?: string };
}

export interface CongressMember {
  bioguideId: string;
  name: string; // "LastName, FirstName" format
  partyName: string;
  state: string; // full name e.g. "Ohio" (NOT two-letter abbr — use stateIds.get(name))
  district?: number | null;
  chamber: string; // "Senate" | "House of Representatives"
  terms?: {
    item: Array<{
      chamber: string;
      startYear?: number;
      endYear?: number;
    }>;
  };
  depiction?: {
    imageUrl?: string;
  };
  updateDate?: string;
}

export interface VoteListResponse {
  votes: VoteListItem[];
  pagination: { count: number; next?: string };
}

export interface VoteListItem {
  congress: number;
  chamber: string;
  rollNumber: number;
  date: string;
  question: string;
  result: string;
  url: string;
}

export interface VoteDetailResponse {
  vote: VoteDetail;
}

export interface VoteDetail {
  congress: number;
  chamber: string;
  rollNumber: number;
  date: string;
  question: string;
  result: string;
  totals?: {
    yeas?: number;
    nays?: number;
    notVoting?: number;
    present?: number;
  };
  // members can be array OR {item: array} — handle both shapes
  members?:
    | Array<{ bioguideId: string; vote: string }>
    | { item: Array<{ bioguideId: string; vote: string }> };
  legislation?: {
    congress: number;
    type: string; // "HR", "S", "HJRES", "SRES", etc.
    number: string;
    title?: string;
  };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch from the Congress.gov API.
 *
 * Accepts either a full URL (returned by pagination.next) or a path relative
 * to the v3 base, e.g. "/member?limit=250". Always appends api_key and
 * format=json query params. Sleeps 200ms before making the request.
 */
export async function fetchCongressApi<T>(
  pathOrUrl: string,
  apiKey: string
): Promise<T> {
  // Always sleep before the request to respect rate limits
  await sleep(200);

  let url: URL;
  if (pathOrUrl.startsWith("http")) {
    url = new URL(pathOrUrl);
  } else {
    // Strip leading slash if present so we can build cleanly
    const path = pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl;
    url = new URL(`${CONGRESS_API_BASE}/${path}`);
  }

  // Append required params (overwrite any existing values for safety)
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");

  const response = await fetch(url.toString());

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Congress.gov API error: ${response.status} ${response.statusText} — ${url.toString()}\n  Body: ${body.slice(0, 300)}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Paginate through all current members of Congress and return the full list.
 */
export async function fetchAllMembers(
  apiKey: string
): Promise<CongressMember[]> {
  const allMembers: CongressMember[] = [];
  let pageNum = 1;
  let nextUrl: string | undefined =
    `/member?currentMember=true&limit=250`;

  while (nextUrl) {
    console.info(`  Fetching page ${pageNum} of members...`);

    const data: CongressMemberListResponse = await fetchCongressApi<CongressMemberListResponse>(
      nextUrl,
      apiKey
    );

    const items = data.members ?? [];
    allMembers.push(...items);

    console.info(
      `  Got ${items.length} items (total: ${allMembers.length})`
    );

    nextUrl = data.pagination?.next;
    pageNum++;
  }

  return allMembers;
}

/**
 * Parse "LastName, FirstName M." into its component parts.
 * If no comma is present, the whole string becomes lastName.
 */
export function parseMemberName(nameStr: string): {
  firstName: string;
  lastName: string;
  fullName: string;
} {
  const commaIndex = nameStr.indexOf(",");
  if (commaIndex === -1) {
    return { firstName: "", lastName: nameStr.trim(), fullName: nameStr.trim() };
  }

  const lastName = nameStr.slice(0, commaIndex).trim();
  const firstName = nameStr.slice(commaIndex + 1).trim();
  const fullName = `${firstName} ${lastName}`.trim();

  return { firstName, lastName, fullName };
}

/**
 * Map Congress.gov party names to our party enum values.
 */
export function mapParty(partyName: string): string {
  const normalized = partyName.trim().toLowerCase();
  if (normalized === "democratic" || normalized === "democrat") return "democrat";
  if (normalized === "republican") return "republican";
  if (normalized === "independent") return "independent";
  if (normalized === "libertarian") return "libertarian";
  if (normalized === "green") return "green";
  return "other";
}

/**
 * Map Congress.gov vote strings to our internal vote values.
 */
export function mapVote(voteStr: string): string {
  const v = voteStr.trim().toLowerCase();
  if (v === "yea" || v === "aye") return "yes";
  if (v === "nay" || v === "no") return "no";
  if (v === "not voting" || v === "not_voting") return "not_voting";
  if (v === "present") return "present";
  return "not_voting";
}

/**
 * Map Congress.gov legislation type codes to our proposal type enum.
 */
export function mapLegislationType(typeStr: string): string {
  const t = typeStr.toUpperCase();
  if (t === "HR" || t === "S") return "bill";
  if (
    t === "HJRES" ||
    t === "SJRES" ||
    t === "HCONRES" ||
    t === "SCONRES" ||
    t === "HRES" ||
    t === "SRES"
  ) {
    return "resolution";
  }
  if (t === "HAMDT" || t === "SAMDT") return "amendment";
  if (t === "TREATY") return "treaty";
  return "other";
}

/**
 * Classify a roll-call result: passed-like → `passed_chamber`, failed-like →
 * `failed`, anything else → `floor_vote`. It classifies the MOTION's outcome,
 * not the bill's: the question decides whether that outcome is evidence about
 * the bill (bill-status.ts — a passed cloture motion is not a passed bill).
 *
 * FIX-1260: by SUFFIX, so the Senate LIS vocabulary ("Bill Passed", "Cloture
 * Motion Agreed to", "Motion to Table Failed", …) classifies like the House
 * Clerk's three values (Passed / Agreed to / Failed). Failed-like is tested
 * first, so "… Not Agreed to" is failed; "defeated" is the census's addition
 * (cc-185: "Bill Defeated", "Joint Resolution Defeated"). "Veto Sustained"
 * classes passed-like although it means the override failed — inert, since
 * the veto question is not a passage question. The old exact-match values all
 * keep their class. scripts/lib/bill-status-evidence.mjs carries the twin regexes;
 * bill-status.test.ts holds them equal.
 */
export const VOTE_RESULT_FAILED_SUFFIX = /(rejected|failed|defeated|not agreed to|not sustained|not well taken)$/;
export const VOTE_RESULT_PASSED_SUFFIX = /(^|\s)(passed|agreed to|confirmed|sustained)$/;
export function mapVoteResult(result: string): string {
  const r = result.trim().toLowerCase().replace(/\s+/g, " ");
  if (VOTE_RESULT_FAILED_SUFFIX.test(r)) return "failed";
  if (VOTE_RESULT_PASSED_SUFFIX.test(r)) return "passed_chamber";
  return "floor_vote";
}

/**
 * Fetch raw text (HTML/XML) from any URL. Used for House Clerk and Senate
 * LIS XML vote feeds — both static-file servers with no rate limit, so no
 * politeness delay. The previous 200ms sleep mirrored fetchCongressApi but
 * was unjustified for static XML and dominated backfill runtime
 * (5,000 rolls × 200ms ≈ 17 minutes of pure sleep per pass).
 */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}\n  Body: ${body.slice(0, 200)}`);
  }
  return res.text();
}

/**
 * Normalize the members field of a VoteDetail, which can be either:
 *   - an array directly, or
 *   - an object with an `item` array
 */
export function getMemberVotes(
  detail: VoteDetail
): Array<{ bioguideId: string; vote: string }> {
  if (!detail.members) return [];

  if (Array.isArray(detail.members)) {
    return detail.members;
  }

  // Shape: { item: [...] }
  const asObj = detail.members as { item: Array<{ bioguideId: string; vote: string }> };
  return asObj.item ?? [];
}
