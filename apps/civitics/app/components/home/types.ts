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
 * One Commons thread row — the homepage "discussion ledger" (FIX-595).
 * Shaped in app/page.tsx from commons_active_threads (FIX-594) + a per-type
 * entity resolution. `chip` is the entity-type label (PROPOSAL/OFFICIAL/…);
 * `href` already carries the #comment-<id> anchor.
 */
export type CommonsThread = {
  commentId: string;
  excerpt: string;
  chip: string;
  href: string;
  label: string;
  isQuestion: boolean;
  isAnswered: boolean;
  replyCount: number;
  raterCount: number;
  lastActivityAt: string;
  // SF-P2 (FIX-599): thread author's users.is_synthetic. Commons surfaces
  // synthetic exemplars (Option 2) WITH the persistent SYNTHETIC mark.
  authorIsSynthetic: boolean;
};

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
