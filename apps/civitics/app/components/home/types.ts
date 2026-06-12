/** The four homepage_stats_mv stats — shaped in app/page.tsx (FIX-223). */
export type HomeStats = {
  officials: number;
  proposals: number;
  donors: number;
  spending: number;
};

/** Compact display form: 4901224 → "4.9M", 26929 → "26,929". */
export function formatStatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return n.toLocaleString("en-US");
  return String(n);
}

/**
 * One row of the homepage officials ledger — shaped in app/page.tsx.
 * Lived in HomeOfficialCard.tsx until that card was retired (FIX-556);
 * OfficialsLedger is the surviving consumer.
 */
export type HomeOfficialCardData = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  photo_url: string | null;
  chamber: string | null;
  district_name: string | null;
  state_name: string | null;
  isFederal: boolean;
  /** Server-fetched stats — no client queries on the homepage. */
  voteCount: number;
  donorCount: number;
  totalDonationsCents: number;
};
