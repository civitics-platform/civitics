/**
 * FIX-1125 — the off-box series, as rows. Pure; no network.
 *
 * The anchor sample is cc-149 read 2's real scrape (01:34 UTC 09-24):
 * MemAvailable 418,258,944 of 948,195,328, swap 1,073,737,728 / 502,247,424
 * free, load1 0.14, pswpin 4,980,534, pswpout 5,071,728.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoxHealthSample } from "@civitics/db";
import { IO_BUSY_PCT, MAX_RATE_GAP_S, formatSeries, ioDay, memoryDay, seriesRows, seriesStats } from "./box-health-series";

const MB = 1024 * 1024;
const REAL: BoxHealthSample = {
  route_at: "2026-09-24T01:34:00.000Z",
  scrape_ms: 493,
  mem_available_bytes: 418258944,
  mem_total_bytes: 948195328,
  swap_total_bytes: 1073737728,
  swap_free_bytes: 502247424,
  load1: 0.14,
  pswpin: 4980534,
  pswpout: 5071728,
};

const at = (minutes: number) => new Date(Date.parse(REAL.route_at) + minutes * 60_000).toISOString();
const s = (minutes: number, over: Partial<BoxHealthSample> = {}): BoxHealthSample => ({ ...REAL, route_at: at(minutes), ...over });

test("FIX-1125: rows are oldest-first, windowed, with the real sample's derived numbers", () => {
  const newestFirst = [s(4), s(2), REAL, s(-60 * 25)];
  const rows = seriesRows(newestFirst, { hours: 24, now: new Date(at(5)) });
  assert.deepEqual(rows.map((r) => r.at), [at(0), at(2), at(4)], "the 25 h-old sample is outside --hours 24");
  assert.equal(rows[0]!.mem_avail_mb, 399);
  assert.equal(rows[0]!.avail_pct, 44.1);
  assert.equal(rows[0]!.swap_used_mb, 545);
  assert.equal(rows[0]!.load1, 0.14);
  assert.equal(rows[0]!.swapin_per_s, null, "the first row has no predecessor");
});

test("FIX-1125: swap rates come from consecutive counters; a reset or a gap gives null, never a rate across a hole", () => {
  const rows = seriesRows(
    [
      s(12, { pswpin: 10, pswpout: 10 }), // counter went backwards from s(10): a restart
      s(10, { pswpin: REAL.pswpin! + 2400 + 999, pswpout: REAL.pswpout! + 1200 + 5 }),
      s(2, { pswpin: REAL.pswpin! + 2400, pswpout: REAL.pswpout! + 1200 }),
      REAL,
    ],
    { hours: 1, now: new Date(at(13)) },
  );
  assert.equal(rows[1]!.swapin_per_s, 20, "2400 pages over 120 s");
  assert.equal(rows[1]!.swapout_per_s, 10);
  assert.equal(8 * 60 > MAX_RATE_GAP_S, true);
  assert.equal(rows[2]!.swapin_per_s, null, "an 8-minute gap is not consecutive");
  assert.equal(rows[3]!.swapin_per_s, null, "a counter reset is not a negative rate");
});

test("FIX-1125: stats — min (with its time), median, max, total", () => {
  const newestFirst = [
    s(6, { mem_available_bytes: 300 * MB }),
    s(4, { mem_available_bytes: 100 * MB }),
    s(2, { mem_available_bytes: 500 * MB }),
    s(0, { mem_available_bytes: 200 * MB }),
  ];
  const rows = seriesRows(newestFirst, { hours: 1, now: new Date(at(7)) });
  const st = seriesStats(rows, newestFirst);
  assert.deepEqual(st, {
    n: 4, first_at: at(0), last_at: at(6), min_mb: 100, min_at: at(4), median_mb: 250, max_mb: 500, mem_total_mb: 904,
  });
  assert.equal(seriesStats([]).n, 0);
  assert.equal(seriesStats([]).median_mb, null);
});

test("FIX-1125: the printout — a summary line, then a table", () => {
  const rows = seriesRows([s(2), REAL], { hours: 1, now: new Date(at(3)) });
  const text = formatSeries(rows, seriesStats(rows, [s(2), REAL]), 1);
  const lines = text.split("\n");
  assert.match(lines[0]!, /^\[box-health\] 2 samples .* mem_avail_mb min 399 .* median 399 \/ max 399 of 904$/);
  assert.match(lines[1]!, /^at \(UTC\)\s+avail_mb\s+avail%\s+swap_mb\s+load1\s+swpin\/s\s+swpout\/s\s+rd_MB\/s\s+wr_MB\/s\s+io%\s+scrape_ms$/);
  assert.match(lines[2]!, /^2026-09-24 01:34:00Z\s+399\s+44\.1\s+545\s+0\.14\s+—\s+—\s+—\s+—\s+—\s+493$/);
  assert.equal(formatSeries([], seriesStats([]), 6), "[box-health] no samples in the last 6 h");
});

test("FIX-1194 / FIX-1125 (cc-183): memoryDay — swap rates p50/p95/max, MemAvailable min/median, swap peak, gaps", () => {
  // Twenty-one samples 2 min apart, then an 8-minute hole, then one more.
  // Swap-in: +240 pages per 120 s for 19 intervals (2/s), one +24,000 burst
  // (200/s); the post-hole interval has no rate. Swap-out: +120 per interval.
  const newestFirst: BoxHealthSample[] = [];
  let pin = REAL.pswpin!;
  let pout = REAL.pswpout!;
  for (let i = 0; i <= 20; i++) {
    if (i > 0) { pin += i === 10 ? 24_000 : 240; pout += 120; }
    newestFirst.unshift(s(2 * i, {
      pswpin: pin, pswpout: pout,
      mem_available_bytes: (i === 10 ? 176 : 400 + i) * MB,
      swap_free_bytes: REAL.swap_free_bytes! - (i === 10 ? 469 : 0) * MB,
    }));
  }
  newestFirst.unshift(s(48, { pswpin: pin + 240, pswpout: pout + 120, mem_available_bytes: 450 * MB }));
  const rows = seriesRows(newestFirst, { hours: 2, now: new Date(at(49)) });
  const day = memoryDay(rows, seriesStats(rows, newestFirst));
  assert.equal(day.samples, 22);
  assert.equal(day.first_at, at(0));
  assert.equal(day.last_at, at(48));
  assert.equal(day.gaps, 1, "the 8-minute hole");
  // 20 rated intervals: nineteen at 2/s and one at 200/s; the post-hole one is null.
  assert.deepEqual(day.swapin_per_s, { p50: 2, p95: 2, max: 200 });
  assert.deepEqual(day.swapout_per_s, { p50: 1, p95: 1, max: 1 });
  assert.deepEqual(day.mem_available_mb, { min: 176, p50: 410 }, "min is the burst sample; the median is seriesStats'");
  assert.deepEqual(day.swap_used_mb, { max: 545 + 469 });

  const empty = memoryDay([], seriesStats([]));
  assert.deepEqual(empty, {
    samples: 0, first_at: null, last_at: null,
    swapin_per_s: { p50: null, p95: null, max: null }, swapout_per_s: { p50: null, p95: null, max: null },
    mem_available_mb: { min: null, p50: null }, swap_used_mb: { max: null }, gaps: 0,
    io: {
      rated: 0, read_mbps: { p50: null, p95: null, max: null }, write_mbps: { p50: null, p95: null, max: null },
      all_mbps: { p50: null, p95: null, max: null }, io_time_pct: { p95: null, max: null }, minutes_busy: 0,
    },
  });
});

// ── FIX-1375: the disk columns ───────────────────────────────────────────────

test("FIX-1375: rows carry the route's disk rates; a pre-sampler row reads null; ioDay sums busy minutes", () => {
  const disk = (pct: number, rd: number): Partial<BoxHealthSample> => ({
    disk_read_mbps: rd, disk_write_mbps: 0.3, io_time_pct: pct, disk_all_read_mbps: rd + 4, disk_all_write_mbps: 0.5,
  });
  // Oldest → newest: a pre-sampler sample, then 2-min samples, one after a 10-min gap.
  const newestFirst = [s(16, disk(99, 28.2)), s(6, disk(97.9, 25.8)), s(4, disk(100, 28.7)), s(2, disk(1.2, 0.98)), REAL];
  const rows = seriesRows(newestFirst, { hours: 24, now: new Date(at(17)) });
  assert.equal(rows[0]!.io_time_pct, null, "a sample before FIX-1375 carries no rates");
  assert.equal(rows[0]!.read_mbps, null);
  assert.equal(rows[1]!.read_mbps, 0.98);
  assert.equal(rows[2]!.all_mbps, 33.2, "every disk's read + write");
  const io = ioDay(rows);
  assert.equal(io.rated, 4);
  // 4 min and 6 min each count their 2-min interval; 16 min sits after a 10-min gap and counts nothing.
  assert.equal(io.minutes_busy, 4);
  assert.deepEqual(io.io_time_pct, { p95: 100, max: 100 });
  assert.equal(io.read_mbps.max, 28.7);
  assert.ok(IO_BUSY_PCT === 90);
  assert.deepEqual(memoryDay(rows, seriesStats(rows, newestFirst)).io, io, "banked inside memory_day");
  assert.match(formatSeries(rows, seriesStats(rows, newestFirst), 24), /rd_MB\/s +wr_MB\/s +io%/);
});
