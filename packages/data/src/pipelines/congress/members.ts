/**
 * Congress.gov shared types and fetch utilities.
 *
 * All HTTP calls include a 200ms delay before each request to respect the
 * Congress.gov rate limit. fetchCongressApi handles both full URLs (from
 * pagination.next) and relative paths.
 */

export const CURRENT_CONGRESS = 119;

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
  state: string; // two-letter abbr e.g. "OH"
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
    console.log(`  Fetching page ${pageNum} of members...`);

    const data = await fetchCongressApi<CongressMemberListResponse>(
      nextUrl,
      apiKey
    );

    const items = data.members ?? [];
    allMembers.push(...items);

    console.log(
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
 * Map a roll-call result string to our proposal status enum.
 */
export function mapVoteResult(result: string): string {
  const r = result.trim().toLowerCase();
  if (
    r === "passed" ||
    r === "agreed to" ||
    r === "amendment agreed to" ||
    r === "nomination confirmed" ||
    r === "resolution agreed to"
  ) {
    return "passed_chamber";
  }
  if (
    r === "failed" ||
    r === "rejected" ||
    r === "amendment rejected" ||
    r === "motion rejected" ||
    r === "nomination rejected"
  ) {
    return "failed";
  }
  return "floor_vote";
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
