/**
 * FIX-1125 — the off-box memory series, as rows a human reads.
 *
 * The ring (`civitics:box_health:mem`, packages/db/src/box-health-store.ts)
 * holds up to 720 samples, newest first, one every 2 minutes. This turns them
 * into oldest-first rows with the derived numbers, plus the day's
 * min / median / max. It is shared by `data:box-health:series` (the instrument
 * the next outage read uses, because it does not need this database) and by
 * receipts §9.
 *
 * Swap-in / swap-out are RATES from consecutive vmstat counters (pages/s). A
 * counter that went backwards (a node restart) or a gap longer than
 * MAX_RATE_GAP_S gives null rather than a rate across the hole: a rate
 * spanning an outage would average the ramp away.
 *
 * Pure. No network, no DB.
 */

import type { BoxHealthSample } from "@civitics/db";

const MB = 1024 * 1024;
/** Three missed 2-minute firings. Past this, adjacent samples are not "consecutive". */
export const MAX_RATE_GAP_S = 6 * 60;

export type SeriesRow = {
  at: string;
  mem_avail_mb: number;
  avail_pct: number;
  swap_used_mb: number | null;
  load1: number | null;
  swapin_per_s: number | null;
  swapout_per_s: number | null;
  scrape_ms: number;
};

export type SeriesStats = {
  n: number;
  first_at: string | null;
  last_at: string | null;
  min_mb: number | null;
  min_at: string | null;
  median_mb: number | null;
  max_mb: number | null;
  mem_total_mb: number | null;
};

function rate(prev: number | undefined, cur: number | undefined, seconds: number): number | null {
  if (prev === undefined || cur === undefined || seconds <= 0 || seconds > MAX_RATE_GAP_S) return null;
  const d = cur - prev;
  if (d < 0) return null;
  return Math.round((d / seconds) * 10) / 10;
}

/** Newest-first samples → oldest-first rows inside the last `hours`. */
export function seriesRows(newestFirst: BoxHealthSample[], opts: { hours: number; now: Date }): SeriesRow[] {
  const since = opts.now.getTime() - opts.hours * 3_600_000;
  const inWindow = newestFirst
    .filter((s) => Date.parse(s.route_at) >= since)
    .sort((a, b) => Date.parse(a.route_at) - Date.parse(b.route_at));
  return inWindow.map((s, i) => {
    const prev = i > 0 ? inWindow[i - 1] : undefined;
    const dt = prev ? (Date.parse(s.route_at) - Date.parse(prev.route_at)) / 1000 : 0;
    return {
      at: s.route_at,
      mem_avail_mb: Math.round(s.mem_available_bytes / MB),
      avail_pct: Math.round((1000 * s.mem_available_bytes) / s.mem_total_bytes) / 10,
      swap_used_mb:
        s.swap_total_bytes !== undefined && s.swap_free_bytes !== undefined
          ? Math.round((s.swap_total_bytes - s.swap_free_bytes) / MB)
          : null,
      load1: s.load1 ?? null,
      swapin_per_s: rate(prev?.pswpin, s.pswpin, dt),
      swapout_per_s: rate(prev?.pswpout, s.pswpout, dt),
      scrape_ms: s.scrape_ms,
    };
  });
}

export function seriesStats(rows: SeriesRow[], newestFirst: BoxHealthSample[] = []): SeriesStats {
  if (rows.length === 0) {
    return { n: 0, first_at: null, last_at: null, min_mb: null, min_at: null, median_mb: null, max_mb: null, mem_total_mb: null };
  }
  const sorted = [...rows].sort((a, b) => a.mem_avail_mb - b.mem_avail_mb);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]!.mem_avail_mb : Math.round((sorted[mid - 1]!.mem_avail_mb + sorted[mid]!.mem_avail_mb) / 2);
  const total = newestFirst[0]?.mem_total_bytes;
  return {
    n: rows.length,
    first_at: rows[0]!.at,
    last_at: rows[rows.length - 1]!.at,
    min_mb: sorted[0]!.mem_avail_mb,
    min_at: sorted[0]!.at,
    median_mb: median,
    max_mb: sorted[sorted.length - 1]!.mem_avail_mb,
    mem_total_mb: total === undefined ? null : Math.round(total / MB),
  };
}

const dash = (v: number | null) => (v === null ? "—" : String(v));

/** A fixed-width table, oldest first, with a one-line summary on top. */
export function formatSeries(rows: SeriesRow[], stats: SeriesStats, hours: number): string {
  const out: string[] = [];
  out.push(
    stats.n === 0
      ? `[box-health] no samples in the last ${hours} h`
      : `[box-health] ${stats.n} samples ${stats.first_at} → ${stats.last_at} (last ${hours} h); ` +
          `mem_avail_mb min ${stats.min_mb} (at ${stats.min_at}) / median ${stats.median_mb} / max ${stats.max_mb}` +
          (stats.mem_total_mb !== null ? ` of ${stats.mem_total_mb}` : ""),
  );
  if (rows.length === 0) return out.join("\n");
  const head = ["at (UTC)", "avail_mb", "avail%", "swap_mb", "load1", "swpin/s", "swpout/s", "scrape_ms"];
  const body = rows.map((r) => [
    r.at.replace("T", " ").replace(/\.\d+Z$/, "Z"),
    String(r.mem_avail_mb),
    r.avail_pct.toFixed(1),
    dash(r.swap_used_mb),
    dash(r.load1),
    dash(r.swapin_per_s),
    dash(r.swapout_per_s),
    String(r.scrape_ms),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  out.push(line(head));
  for (const b of body) out.push(line(b));
  return out.join("\n");
}
