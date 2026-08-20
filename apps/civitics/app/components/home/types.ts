/**
 * The four homepage_stats_mv stats — shaped in app/page.tsx (FIX-223).
 *
 * FIX-1070 — each stat is `number | null`, and the distinction is load-bearing:
 *
 *   null    we did not measure this. The MV read timed out, errored, or the row
 *           is absent. Renders as "—".
 *   number  we measured this, and the answer is that number — INCLUDING 0.
 *
 * Before this, the type was `number` and page.tsx coerced a failed read with
 * `?? 0`. Both consumers then rendered `n > 0 ? … : "—"`, so the fabricated
 * zero did display as "—" and the lie never reached the screen. It reached
 * everything else: a genuinely measured 0 was indistinguishable from an
 * unmeasured stat, and FIX-431's deliberately-preserved `null` for the donor
 * count was re-collapsed to 0 one line before render. Encoding "not measured"
 * in the type is what keeps that distinction from being re-lost by the next
 * `?? 0` someone adds.
 */
export type HomeStats = {
  officials: number | null;
  proposals: number | null;
  donors: number | null;
  spending: number | null;
};

/** Compact display form: 4901224 → "4.9M", 26929 → "26,929". */
export function formatStatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return n.toLocaleString("en-US");
  return String(n);
}

/**
 * FIX-1070 — render a possibly-unmeasured stat. Only `null` becomes "—";
 * a measured 0 renders as "0", because "we counted and there are none" and
 * "we could not count" are different claims and the homepage should not make
 * the second one look like the first.
 */
export function formatStatOrDash(n: number | null): string {
  return n === null ? "—" : formatStatCompact(n);
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
