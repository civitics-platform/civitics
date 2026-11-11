/**
 * FIX-1125 — the off-box memory series, as rows a human reads.
 *
 * The ring (`civitics:box_health:mem`, packages/db/src/box-health-store.ts)
 * holds up to 900 samples (30 h, FIX-1289), newest first, one every 2 minutes. This turns them
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
 * The disk columns (FIX-1375, cc-262) are NOT re-derived here: the route rates
 * them at write time on the exporter's clock (box-health-store.ts says why the
 * route's clock is wrong for them), so each sample carries its own. A sample
 * before the deploy, or one the route could not rate, reads null.
 *
 * FIX-1386 (cc-265) — the ring is 30 h and a banked day keeps counts, so a
 * count could not be placed once its samples aged out (cc-263's 728 MB and its
 * 12 busy minutes). `ioDay()` now banks the instants, and `rootDay()` the day's
 * root reads. The per-sample rates stay on the exporter's clock; `rootDay()` is
 * a day-long DELTA between two samples, so its `hours` is on their `route_at`.
 * Over read 2's day the two clocks differed by 0.15 h in 24.
 *
 * ROOT IS ALL DISKS MINUS /data. `disk_all_read_bytes` sums every whole disk,
 * and the Micro has two: nvme0n1 root and nvme1n1 /data (rule 415). A third
 * device would make `root_read_gb` "every disk but /data".
 *
 * MAJOR FAULTS ARE COUNTED, NOT MEASURED. `majfault_gb` is Δpgmajfault × 4,096 B
 * (the x86_64 page), the same conversion as `swap_in_gb`, but pgmajfault counts
 * FAULTS and pswpin counts PAGES. A file fault reads around the faulting page
 * and a swap fault reads a cluster, so bytes per fault is ≥ one page and
 * `majfault_gb` is a FLOOR on what faults read. pgmajfault also counts swap-in
 * faults, so it overlaps `swap_in_gb` and is not a file-only number. On read
 * 2's day pswpin ran 1.84× pgmajfault, which one page per fault cannot do.
 *
 * Pure. No network, no DB.
 */

import type { BoxHealthSample } from "@civitics/db";

const MB = 1024 * 1024;
/** The same 10^n scale as the route's MB/s: 1 GB here is 1,000 of those MB. */
const GB = 1e9;
/** x86_64. pswpin and pgmajfault are in pages / faults; the budget is in bytes. */
const PAGE_BYTES = 4096;
/** Three missed 2-minute firings. Past this, adjacent samples are not "consecutive". */
export const MAX_RATE_GAP_S = 6 * 60;

/** FIX-1386 — the raw counters the root budget differences. */
export type RootCounters = {
  pswpin: number;
  pgmajfault: number;
  disk_device: string;
  disk_read_bytes: number;
  disk_all_read_bytes: number;
  /** FIX-1397 — the read counts, on samples from cc-267's sampler on (absent before). */
  disk_reads?: number;
  disk_all_reads?: number;
};

export type SeriesRow = {
  at: string;
  mem_avail_mb: number;
  avail_pct: number;
  swap_used_mb: number | null;
  load1: number | null;
  swapin_per_s: number | null;
  swapout_per_s: number | null;
  /** FIX-1375 — the /data device's MB/s (10^6) and busy %, as the route rated them. */
  read_mbps: number | null;
  write_mbps: number | null;
  io_time_pct: number | null;
  /** FIX-1375 — every whole disk's read + write MB/s: the instance's burst budget is shared. */
  all_mbps: number | null;
  /** FIX-1386 — the /data device's reads/s, and the counters. Banked and in --json; not in the table. */
  reads_ps: number | null;
  counters: RootCounters | null;
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

function rootCounters(s: BoxHealthSample): RootCounters | null {
  const { pswpin, pgmajfault, disk_device, disk_read_bytes, disk_all_read_bytes, disk_reads, disk_all_reads } = s;
  if (
    pswpin === undefined ||
    pgmajfault === undefined ||
    disk_device === undefined ||
    disk_read_bytes === undefined ||
    disk_all_read_bytes === undefined
  ) {
    return null;
  }
  return {
    pswpin, pgmajfault, disk_device, disk_read_bytes, disk_all_read_bytes,
    ...(disk_reads !== undefined && disk_all_reads !== undefined ? { disk_reads, disk_all_reads } : {}),
  };
}

/** Newest-first samples → oldest-first rows inside the last `hours`. */
export function seriesRows(newestFirst: BoxHealthSample[], opts: { hours: number; now: Date }): SeriesRow[] {
  return rowsBetween(newestFirst, opts.now.getTime() - opts.hours * 3_600_000, Infinity);
}

/** FIX-1289 — oldest-first rows with `route_at` in `[from, to)`: a receipts window, both ends fixed. */
export function windowRows(newestFirst: BoxHealthSample[], w: { from: string; to: string }): SeriesRow[] {
  return rowsBetween(newestFirst, Date.parse(w.from), Date.parse(w.to));
}

function rowsBetween(newestFirst: BoxHealthSample[], since: number, until: number): SeriesRow[] {
  const inWindow = newestFirst
    .filter((s) => {
      const t = Date.parse(s.route_at);
      return t >= since && t < until;
    })
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
      read_mbps: s.disk_read_mbps ?? null,
      write_mbps: s.disk_write_mbps ?? null,
      io_time_pct: s.io_time_pct ?? null,
      all_mbps:
        s.disk_all_read_mbps !== undefined && s.disk_all_write_mbps !== undefined
          ? Math.round((s.disk_all_read_mbps + s.disk_all_write_mbps) * 100) / 100
          : null,
      reads_ps: s.disk_reads_ps ?? null,
      counters: rootCounters(s),
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

/** p50 / p95 / max of a rate column, nearest-rank, over its non-null values. */
export type RateSummary = { p50: number | null; p95: number | null; max: number | null };

/**
 * FIX-1194 / FIX-1125 (cc-183) — the day's series, summarised for banking in
 * `docs/receipts/<day>.json` as `forker.memory_day`. A memory threshold is sized
 * from seven of these, so every number is one a threshold could be written on:
 * swap-in / swap-out rates (pages/s), MemAvailable's min and median, swap in use
 * at its worst, and how many consecutive-sample intervals were too long to rate
 * (> MAX_RATE_GAP_S). The median is seriesStats' — one median per file.
 */
export type MemoryDay = {
  samples: number;
  first_at: string | null;
  last_at: string | null;
  swapin_per_s: RateSummary;
  swapout_per_s: RateSummary;
  mem_available_mb: { min: number | null; p50: number | null };
  swap_used_mb: { max: number | null };
  gaps: number;
  /** FIX-1375 — the day's disk rates. Optional so a pre-FIX-1375 banked day still parses. */
  io?: IoDay;
};

/**
 * FIX-1375 (cc-262) — the day's disk series, banked beside the memory one. The
 * `io:` rung's thresholds are sized from these, so each number is one a dial
 * could be written on: the /data device's read / write MB/s, every disk's MB/s
 * (the burst budget's numerator), busy % at p95 / max, and the minutes the
 * device was ≥ IO_BUSY_PCT busy. `rated` is how many samples carried a rate:
 * 0 until the sampler's first day, and the line says "missing" then.
 *
 * FIX-1386 — the instants, so a line can be placed after the ring has moved on.
 * All optional: a day banked before cc-265 has none and FIX-1289 keeps it so.
 */
export type IoDay = {
  rated: number;
  read_mbps: RateSummary;
  write_mbps: RateSummary;
  all_mbps: RateSummary;
  io_time_pct: { p95: number | null; max: number | null };
  minutes_busy: number;
  /** Every sample at IO_BUSY_PCT or over, oldest first, at most BUSY_INSTANTS_CAP. */
  busy_instants?: BusyInstant[];
  /** How many were dropped from the middle to fit the cap. */
  busy_instants_truncated?: number;
  /** The earliest sample at the day's swap peak / MemAvailable floor. */
  swap_max_at?: string | null;
  mem_available_min_at?: string | null;
  root?: RootDay;
};

export type BusyInstant = {
  at: string;
  io_time_pct: number;
  read_mbps: number | null;
  all_mbps: number | null;
  reads_ps: number | null;
};

/**
 * FIX-1386 — where the day's root reads went, in GB (10^9), from the window's
 * first and last counter-carrying samples. `rated` counts those samples. A
 * counter that went backwards anywhere in the window nulls its numbers and
 * `reason` says where: the two ends alone would hide a reset the counter has
 * since climbed past. The header above says what each number can claim.
 */
export type RootDay = {
  hours: number | null;
  root_read_gb: number | null;
  data_read_gb: number | null;
  swap_in_gb: number | null;
  majfault_gb: number | null;
  swap_in_share_pct: number | null;
  rated: number;
  reason: string | null;
  /**
   * FIX-1397 — root's reads COMPLETED and their mean size (KiB, 1,024 B), from
   * the samples that carry the counts: a window that spans the sampler's deploy
   * starts at its first such sample, and `reads_hours` says how much of the day
   * that is. The bytes are re-differenced over the same samples, so the mean
   * never divides one window's bytes by another's reads. ~4–8 KiB reads as
   * page-sized (faults, swap); 64 KiB and up as file-backed sequential.
   */
  root_reads: number | null;
  mean_read_kib: number | null;
  reads_hours: number | null;
};

/** FIX-1375 — "busy" for minutes_busy: the gp3 IOPS ceiling reads 97–101 % (cc-262 calibration). */
export const IO_BUSY_PCT = 90;
/** FIX-1386 — a 3-h throttle at the 2-minute cadence. */
export const BUSY_INSTANTS_CAP = 90;

function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function summarise(values: Array<number | null>): RateSummary {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return { p50: nearestRank(v, 50), p95: nearestRank(v, 95), max: v.length === 0 ? null : v[v.length - 1]! };
}

export function memoryDay(rows: SeriesRow[], stats: SeriesStats): MemoryDay {
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    if ((Date.parse(rows[i]!.at) - Date.parse(rows[i - 1]!.at)) / 1000 > MAX_RATE_GAP_S) gaps++;
  }
  const swapUsed = rows.map((r) => r.swap_used_mb).filter((x): x is number => x !== null);
  return {
    samples: rows.length,
    first_at: stats.first_at,
    last_at: stats.last_at,
    swapin_per_s: summarise(rows.map((r) => r.swapin_per_s)),
    swapout_per_s: summarise(rows.map((r) => r.swapout_per_s)),
    mem_available_mb: { min: stats.min_mb, p50: stats.median_mb },
    swap_used_mb: { max: swapUsed.length === 0 ? null : Math.max(...swapUsed) },
    gaps,
    io: ioDay(rows),
  };
}

/** FIX-1375 — each busy sample counts the interval since the previous one, capped like a rate. */
export function ioDay(rows: SeriesRow[]): IoDay {
  let busyS = 0;
  for (let i = 1; i < rows.length; i++) {
    const pct = rows[i]!.io_time_pct;
    const dt = (Date.parse(rows[i]!.at) - Date.parse(rows[i - 1]!.at)) / 1000;
    if (pct !== null && pct >= IO_BUSY_PCT && dt > 0 && dt <= MAX_RATE_GAP_S) busyS += dt;
  }
  const io = summarise(rows.map((r) => r.io_time_pct));
  const instants = busyInstants(rows);
  return {
    rated: rows.filter((r) => r.io_time_pct !== null).length,
    read_mbps: summarise(rows.map((r) => r.read_mbps)),
    write_mbps: summarise(rows.map((r) => r.write_mbps)),
    all_mbps: summarise(rows.map((r) => r.all_mbps)),
    io_time_pct: { p95: io.p95, max: io.max },
    minutes_busy: Math.round(busyS / 60),
    busy_instants: instants.kept,
    busy_instants_truncated: instants.dropped,
    swap_max_at: earliestExtreme(rows, (r) => r.swap_used_mb),
    mem_available_min_at: earliestExtreme(rows, (r) => -r.mem_avail_mb),
    root: rootDay(rows),
  };
}

/** Past the cap the middle goes: the first and last instants bound the episode. */
function busyInstants(rows: SeriesRow[]): { kept: BusyInstant[]; dropped: number } {
  const all = rows.flatMap((r) =>
    r.io_time_pct !== null && r.io_time_pct >= IO_BUSY_PCT
      ? [{ at: r.at, io_time_pct: r.io_time_pct, read_mbps: r.read_mbps, all_mbps: r.all_mbps, reads_ps: r.reads_ps }]
      : [],
  );
  if (all.length <= BUSY_INSTANTS_CAP) return { kept: all, dropped: 0 };
  const head = Math.ceil(BUSY_INSTANTS_CAP / 2);
  return {
    kept: [...all.slice(0, head), ...all.slice(all.length - (BUSY_INSTANTS_CAP - head))],
    dropped: all.length - BUSY_INSTANTS_CAP,
  };
}

/** The first row at `value`'s maximum, or null when no row has one. */
function earliestExtreme(rows: SeriesRow[], value: (r: SeriesRow) => number | null): string | null {
  let at: string | null = null;
  let best = -Infinity;
  for (const r of rows) {
    const v = value(r);
    if (v !== null && v > best) {
      best = v;
      at = r.at;
    }
  }
  return at;
}

/** FIX-1386 — the day's root reads. Pure; see RootDay and the file header. */
export function rootDay(rows: SeriesRow[]): RootDay {
  const carrying = rows.flatMap((r) => (r.counters === null ? [] : [{ at: r.at, c: r.counters }]));
  const unrated = (reason: string): RootDay => ({
    hours: null,
    root_read_gb: null,
    data_read_gb: null,
    swap_in_gb: null,
    majfault_gb: null,
    swap_in_share_pct: null,
    rated: carrying.length,
    reason,
    root_reads: null,
    mean_read_kib: null,
    reads_hours: null,
  });
  if (carrying.length === 0) return unrated("no sample in the window carries the raw counters");
  if (carrying.length === 1) return unrated("one sample in the window carries the raw counters; nothing to difference");

  const first = carrying[0]!;
  const last = carrying[carrying.length - 1]!;
  const reasons: string[] = [];
  const deltaOver = (
    list: { at: string; c: RootCounters }[],
    name: string,
    read: (c: RootCounters) => number,
  ): number | null => {
    for (let i = 1; i < list.length; i++) {
      if (read(list[i]!.c) < read(list[i - 1]!.c)) {
        reasons.push(`${name} went backwards at ${list[i]!.at}`);
        return null;
      }
    }
    return read(list[list.length - 1]!.c) - read(list[0]!.c);
  };
  const delta = (name: string, read: (c: RootCounters) => number): number | null => deltaOver(carrying, name, read);

  const moved = carrying.find((x) => x.c.disk_device !== first.c.disk_device);
  if (moved) reasons.push(`the /data device changed ${first.c.disk_device} → ${moved.c.disk_device} at ${moved.at}`);
  const rootBytes = moved ? null : delta("root reads", (c) => c.disk_all_read_bytes - c.disk_read_bytes);
  const dataBytes = moved ? null : delta("/data reads", (c) => c.disk_read_bytes);
  const swapPages = delta("pswpin", (c) => c.pswpin);
  const faults = delta("pgmajfault", (c) => c.pgmajfault);

  // FIX-1397: the read count, over the samples that carry it.
  const counting = carrying.filter((x) => x.c.disk_reads !== undefined && x.c.disk_all_reads !== undefined);
  let rootReads: number | null = null;
  let meanKib: number | null = null;
  let readsHours: number | null = null;
  if (!moved && counting.length >= 2) {
    rootReads = deltaOver(counting, "root read count", (c) => c.disk_all_reads! - c.disk_reads!);
    const countedBytes = deltaOver(counting, "root reads (counted window)", (c) => c.disk_all_read_bytes - c.disk_read_bytes);
    meanKib = rootReads === null || countedBytes === null || rootReads === 0
      ? null
      : Math.round((countedBytes / 1024 / rootReads) * 10) / 10;
    readsHours = Math.round((Date.parse(counting[counting.length - 1]!.at) - Date.parse(counting[0]!.at)) / 36_000) / 100;
  }

  const gb = (bytes: number | null) => (bytes === null ? null : Math.round((bytes / GB) * 10) / 10);
  const swapBytes = swapPages === null ? null : swapPages * PAGE_BYTES;
  return {
    hours: Math.round((Date.parse(last.at) - Date.parse(first.at)) / 36_000) / 100,
    root_read_gb: gb(rootBytes),
    data_read_gb: gb(dataBytes),
    swap_in_gb: gb(swapBytes),
    majfault_gb: gb(faults === null ? null : faults * PAGE_BYTES),
    swap_in_share_pct:
      swapBytes === null || rootBytes === null || rootBytes === 0 ? null : Math.round((1000 * swapBytes) / rootBytes) / 10,
    rated: carrying.length,
    reason: reasons.length === 0 ? null : reasons.join("; "),
    root_reads: rootReads,
    mean_read_kib: meanKib,
    reads_hours: readsHours,
  };
}

export const SERIES_RING_NOTE = "the ring holds ~30 h (900 samples at ~2 min); a larger value reads what is there";
export const SERIES_USAGE = `usage: data:box-health:series [--hours N (default 24; ${SERIES_RING_NOTE})] [--json]`;

export type SeriesArgs =
  | { kind: "run"; hours: number; json: boolean; note: string | null }
  | { kind: "help"; usage: string }
  | { kind: "error"; error: string };

/** The script's argv. A bare `--` is what `pnpm run <script> -- --hours 3` passes through. Pure. */
export function parseSeriesArgs(argv: string[]): SeriesArgs {
  let hours = 24;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--json") json = true;
    else if (a === "--hours") hours = Number(argv[++i]);
    else if (a.startsWith("--hours=")) hours = Number(a.slice("--hours=".length));
    else if (a === "--help" || a === "-h") return { kind: "help", usage: SERIES_USAGE };
    else return { kind: "error", error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (!Number.isFinite(hours) || hours <= 0) return { kind: "error", error: "--hours must be a positive number" };
  return { kind: "run", hours, json, note: hours > 30 ? SERIES_RING_NOTE : null };
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
  const head = ["at (UTC)", "avail_mb", "avail%", "swap_mb", "load1", "swpin/s", "swpout/s", "rd_MB/s", "wr_MB/s", "io%", "scrape_ms"];
  const body = rows.map((r) => [
    r.at.replace("T", " ").replace(/\.\d+Z$/, "Z"),
    String(r.mem_avail_mb),
    r.avail_pct.toFixed(1),
    dash(r.swap_used_mb),
    dash(r.load1),
    dash(r.swapin_per_s),
    dash(r.swapout_per_s),
    dash(r.read_mbps),
    dash(r.write_mbps),
    dash(r.io_time_pct),
    String(r.scrape_ms),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  out.push(line(head));
  for (const b of body) out.push(line(b));
  return out.join("\n");
}
