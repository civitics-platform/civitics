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
