/**
 * FIX-1104 — the flapping disk denominator.
 *
 * WHAT HAPPENED, in prod numbers. `platform_usage_snapshot` retains 30 days;
 * read on 2026-08-24, the /data provisioned size had exactly two values ever:
 * 37,930,876,928 and 56,950,861,824. The step up at 2026-08-19 08:56 UTC is a
 * real Supabase auto-grow (40 GB → 60 GB nominal). After it, 160 of 161 ticks
 * carried the new size and exactly one did not — 2026-08-23 01:20:27 UTC
 * reported the PRE-grow size.
 *
 * That single scrape was not a single bad tick, because the writer puts this
 * number into `platform_limits`, which is durable config: the public Disk
 * Utilization row read 87.26% instead of 58.12% until the 02:41 tick happened
 * to overwrite it, 81 minutes later, and the persisted snapshot row is wrong
 * forever.
 *
 * The fixture below is the real endpoint's line shape, and the flap sequence is
 * the real tick sequence. Two properties are pinned:
 *
 *   1. An ambiguous mount is REFUSED, not summed. parsePrometheusText sums
 *      matching rows — correct for a counter across NICs, a fabrication path
 *      for a filesystem size. Note the two sizes here sum to 56,950,861,824
 *      exactly, which is how convincing that fabrication would look.
 *   2. A lone shrink is HELD; a corroborated one is taken. Growth is immediate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectDiskSeries,
  resolveProvisionedDiskSize,
  type DiskSizeDecision,
} from "./supabase-prometheus";

const LABELS =
  'supabase_project_ref="xsazcoxinpgttgquwvuf",supabase_identifier="xsazcoxinpgttgquwvuf",' +
  'service_type="db",device_error="",fstype="ext4"';

/** One scrape body, in the real endpoint's format. */
function scrape(
  rows: { device: string; mount: string; size: number; avail: number }[],
): string {
  const lines = ["# HELP node_filesystem_size_bytes Filesystem size in bytes."];
  for (const r of rows) {
    lines.push(
      `node_filesystem_size_bytes{${LABELS},device="${r.device}",mountpoint="${r.mount}"} ${r.size}`,
    );
    lines.push(
      `node_filesystem_avail_bytes{${LABELS},device="${r.device}",mountpoint="${r.mount}"} ${r.avail}`,
    );
  }
  return lines.join("\n") + "\n";
}

const DISK_60GB = 56950861824; // what /data reports today
const DISK_40GB = 37930876928; // what it reported before the 2026-08-19 grow
const USED = 33098301440; //     disk_used at the anomalous tick, both ticks

const PROD_TODAY = scrape([
  { device: "/dev/nvme0n1p2", mount: "/", size: 15641890816, avail: 7217680384 },
  { device: "/dev/nvme1n1", mount: "/data", size: DISK_60GB, avail: DISK_60GB - USED },
]);

// ── selectDiskSeries ─────────────────────────────────────────────────────────

test("the live prod scrape resolves to the one /data row, not the OS image", () => {
  const disk = selectDiskSeries(PROD_TODAY, "/data");
  assert.ok(!("error" in disk));
  assert.equal(disk.size_bytes, DISK_60GB);
  assert.equal(disk.size_bytes - disk.avail_bytes, USED);
  assert.equal(disk.device, "/dev/nvme1n1");
});

test("two filesystems at one mountpoint are refused, not summed", () => {
  // 37,930,876,928 + 19,019,984,896 = 56,950,861,824 exactly. A summed
  // denominator would be indistinguishable from a real 60 GB disk on the card.
  const ambiguous = scrape([
    { device: "/dev/nvme1n1", mount: "/data", size: DISK_40GB, avail: 1 },
    { device: "/dev/nvme2n1", mount: "/data", size: 19019984896, avail: 1 },
  ]);
  const disk = selectDiskSeries(ambiguous, "/data");
  assert.ok("error" in disk, "an ambiguous mount must not produce a number");
  assert.match(disk.error, /matched 2 row\(s\)/);
  assert.match(disk.error, /nvme1n1, \/dev\/nvme2n1/);
});

test("a missing mount is an error, not a zero denominator", () => {
  const disk = selectDiskSeries(PROD_TODAY, "/nope");
  assert.ok("error" in disk);
  assert.match(disk.error, /matched 0 row\(s\)/);
});

test("mountpoint matching is exact — /data does not match /data-old", () => {
  const other = scrape([
    { device: "/dev/nvme1n1", mount: "/data-old", size: DISK_40GB, avail: 1 },
  ]);
  assert.ok("error" in selectDiskSeries(other, "/data"));
  const hit = selectDiskSeries(other, "/data-old");
  assert.ok(!("error" in hit));
  assert.equal(hit.size_bytes, DISK_40GB);
});

test("a zero-sized filesystem is refused — it would divide the card by zero", () => {
  const zero = scrape([{ device: "/dev/nvme1n1", mount: "/data", size: 0, avail: 0 }]);
  const disk = selectDiskSeries(zero, "/data");
  assert.ok("error" in disk);
  assert.match(disk.error, /expected > 0/);
});

// ── resolveProvisionedDiskSize ───────────────────────────────────────────────

test("first ever scrape bootstraps", () => {
  assert.deepEqual(
    resolveProvisionedDiskSize({ observed: DISK_40GB, accepted: null, lastObserved: null }),
    { value: DISK_40GB, action: "bootstrap" },
  );
});

test("growth is taken on sight — auto-scale is what a Supabase disk does", () => {
  assert.deepEqual(
    resolveProvisionedDiskSize({
      observed: DISK_60GB,
      accepted: DISK_40GB,
      lastObserved: DISK_40GB,
    }),
    { value: DISK_60GB, action: "grow" },
  );
});

/**
 * THE REGRESSION TEST. The real 2026-08-19 → 2026-08-23 tick sequence, replayed
 * through the guard. Before FIX-1104 the denominator this produced was
 * [40, 60, 60, 40, 60] and the Disk row wobbled 58 ↔ 87%.
 */
test("the prod flap sequence produces a stable denominator", () => {
  const observations = [
    DISK_40GB, // …08-19 08:16 — pre-grow, steady for weeks before this
    DISK_60GB, //  08-19 08:56 — the real grow
    DISK_60GB, //  …154 ticks…
    DISK_40GB, //  08-23 01:20 — THE DIVERGENT SCRAPE
    DISK_60GB, //  08-23 02:41 — back to reality
  ];

  let accepted: number | null = null;
  let lastObserved: number | null = null;
  const applied: number[] = [];
  const actions: DiskSizeDecision["action"][] = [];

  for (const observed of observations) {
    const decision = resolveProvisionedDiskSize({ observed, accepted, lastObserved });
    accepted = decision.value;
    lastObserved = observed;
    applied.push(decision.value);
    actions.push(decision.action);
  }

  assert.deepEqual(applied, [DISK_40GB, DISK_60GB, DISK_60GB, DISK_60GB, DISK_60GB]);
  assert.deepEqual(actions, ["bootstrap", "grow", "steady", "shrink_held", "steady"]);

  // What the card would have shown at the anomalous tick, then and now.
  const pctAt = (denom: number) => Math.round((USED / denom) * 10000) / 100;
  assert.equal(pctAt(DISK_40GB), 87.26, "the wobble the public Disk row showed");
  assert.equal(pctAt(applied[3]!), 58.12, "what it shows with the guard");
});

test("a real downsize is believed on the second consecutive agreeing scrape", () => {
  // Costs one tick of lag, which is the whole price of the guard. A downsize is
  // a support-ticket operation; a bad scrape is not.
  const first = resolveProvisionedDiskSize({
    observed: DISK_40GB,
    accepted: DISK_60GB,
    lastObserved: DISK_60GB,
  });
  assert.deepEqual(first, { value: DISK_60GB, action: "shrink_held" });

  const second = resolveProvisionedDiskSize({
    observed: DISK_40GB,
    accepted: first.value,
    lastObserved: DISK_40GB, // the held tick's raw observation
  });
  assert.deepEqual(second, { value: DISK_40GB, action: "shrink_confirmed" });
});

test("corroboration reads the previous RAW observation, not the accepted value", () => {
  // If it read `accepted`, a held value would confirm itself on the next tick
  // and the guard would be a one-tick delay instead of a guard.
  const held = resolveProvisionedDiskSize({
    observed: DISK_40GB,
    accepted: DISK_60GB,
    lastObserved: DISK_60GB,
  });
  const nextIsFine = resolveProvisionedDiskSize({
    observed: DISK_60GB,
    accepted: held.value,
    lastObserved: DISK_40GB,
  });
  assert.deepEqual(nextIsFine, { value: DISK_60GB, action: "steady" });
});
