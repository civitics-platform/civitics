/**
 * Supabase Prometheus self-metrics — for the Platform Costs card.
 *
 * Pulls a handful of node + Postgres metrics from
 *   https://<project-ref>.supabase.co/customer/v1/privileged/metrics
 * in a single HTTP round trip and exposes the three values the dashboard
 * cares about today:
 *
 *   egress_bytes_month_to_date   - delta of node_network_transmit_bytes_total
 *                                  vs a stored monthly baseline (the counter
 *                                  itself is monotonic; the helper does the
 *                                  bookkeeping in supabase_prometheus_state).
 *   db_connections_active        - pg_stat_database_num_backends, a gauge
 *                                  read straight through.
 *   disk_used_bytes              - node_filesystem_size_bytes minus
 *                                  node_filesystem_avail_bytes for the
 *                                  '/data' mount (the DB filesystem on
 *                                  Supabase compute — '/' is the OS image
 *                                  and not what the Management API was
 *                                  reporting). Replaces the Management API
 *                                  config/disk/util call.
 *   disk_size_bytes              - node_filesystem_size_bytes for the
 *                                  '/data' mount. Exposed so the snapshot
 *                                  can write the provisioned-disk size
 *                                  through to platform_limits.included_limit
 *                                  for disk_used_bytes (FIX-351). The 8 GB
 *                                  Pro plan included quota is the wrong
 *                                  denominator once the disk is manually
 *                                  resized above it.
 *                                  FIX-1104: this is the STABILIZED value,
 *                                  not the raw scrape — see "The disk
 *                                  denominator is pinned, not sampled".
 *   cpu_pct_current              - 0–100 CPU utilization for the current
 *                                  scrape interval. FIX-355. Derived from
 *                                  node_cpu_seconds_total counter deltas:
 *                                    busy_delta = sum over all (cpu, mode)
 *                                      where mode != 'idle'
 *                                    total_delta = sum over all (cpu, mode)
 *                                  cpu_pct = 100 * busy_delta / total_delta.
 *                                  num_cores cancels out of the ratio so the
 *                                  formula is robust across tier upgrades.
 *                                  First tick (no prior baseline) and counter
 *                                  resets (current < last) both return 0 to
 *                                  avoid wild values from a stale denominator.
 *   cpu_max_1h / cpu_max_24h     - windowed max of cpu_pct_current over the
 *                                  last 1h / 24h, including this tick's
 *                                  freshly computed value. FIX-356.
 *                                  Sourced from get_supabase_cpu_max RPC,
 *                                  which scans platform_usage_snapshot
 *                                  payload->'supabase_cpu'->>'current_pct'.
 *
 * Auth: HTTP basic auth, username 'service_role', password is the project's
 * SUPABASE_SECRET_KEY. No new env var.
 *
 * Cache: 5-minute in-memory wrapper (mirrors getSupabaseManagementMetrics
 * and getCloudflareR2Usage). The cron path and the debug route share the
 * cache so a force-refresh through the debug route's POST is the way to
 * bypass it.
 *
 * Failures (HTTP error, parse mismatch) return { error } - never throws.
 * computePlatformUsagePayload expects that shape and degrades gracefully.
 *
 * ── The disk denominator is pinned, not sampled (FIX-1104) ───────────────────
 *
 * `disk_size_bytes` is not just read out to a dashboard — the snapshot writer
 * puts it into `platform_limits`, which is DURABLE CONFIG. It is the
 * denominator under the public Disk Utilization row and under
 * db_size_bytes.display_limit. So one bad scrape does not cause one bad tick;
 * it causes a wrong public percentage that persists until some LATER tick
 * happens to overwrite it, plus a permanently wrong persisted snapshot row.
 *
 * That is not hypothetical. Measured on prod (30-day snapshot retention read
 * 2026-08-24): the /data size has had exactly two values, 37,930,876,928 and
 * 56,950,861,824. The step up at 2026-08-19 08:56 UTC is a real Supabase
 * auto-grow (40 GB → 60 GB nominal; the 1.5x is the auto-scale ratio). After
 * it, 160 of 161 ticks carried the new size and exactly one did not —
 * 2026-08-23 01:20:27 UTC reported the PRE-grow size, and the Disk row read
 * 87.26% instead of 58.12% for the 81 minutes until the next tick.
 *
 * Two things make a single divergent scrape able to do that, and both are
 * closed here:
 *
 *   1. AMBIGUITY. parsePrometheusText SUMS every row matching its label
 *      predicate. For a counter summed across NICs that is correct; for "how
 *      big is the filesystem" it is a fabrication path — two rows at the same
 *      mountpoint would silently yield their sum with nothing on the row to
 *      say so. selectDiskSeries refuses 0 or 2+ matches instead of summing.
 *      The live endpoint exposes exactly one /data row today (device
 *      /dev/nvme1n1), so this changes no current value.
 *
 *   2. NO CORROBORATION ON A SHRINK. A provisioned disk grows on auto-scale
 *      and effectively never shrinks. resolveProvisionedDiskSize therefore
 *      takes growth immediately but requires a shrink to be seen on two
 *      CONSECUTIVE scrapes before it is applied. A lone divergent reading is
 *      a no-op; a real downsize costs one extra tick of lag.
 *
 * Only the DENOMINATOR is pinned. `disk_used_bytes` stays whatever the scrape
 * measured — it is an observation, not config, nothing persists it as a limit,
 * and on the anomalous prod tick it was in fact correct (byte-identical to its
 * neighbours) while only the size/avail pair had moved.
 *
 * Counter-delta bookkeeping (applyCounterDelta below):
 *   - First scrape ever:  INSERT (baseline=current, last=current), return 0.
 *   - Counter reset:      current < last_raw_value (Supabase node restart) →
 *                         UPDATE (baseline=current, last=current), return 0.
 *   - Month rollover:     baseline_at < date_trunc('month', NOW()) →
 *                         UPDATE (baseline=current, baseline_at=NOW(),
 *                         last=current), return 0.
 *   - Normal tick:        UPDATE last_raw_value=current, return
 *                         current - baseline_value.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const METRICS_URL =
  `https://${PROJECT_REF}.supabase.co/customer/v1/privileged/metrics`;

const CACHE_TTL_MS = 5 * 60 * 1000;
const EGRESS_METRIC = "node_network_transmit_bytes_total";

// Virtual/loopback network interfaces to exclude from the egress counter sum.
// node_network_transmit_bytes_total is reported per `device=`; summing every
// device would fold loopback and container-bridge traffic into "egress".
// Matched as label substrings (open-ended for the numbered veth*/br*/cni* set).
export const NETWORK_VIRTUAL_DEVICES = [
  'device="lo"',
  'device="docker',
  'device="veth',
  'device="br',
  'device="cni',
];

// CPU counter state-table keys. These match the metric names used in
// supabase_prometheus_state — applyCounterDelta keys off them.
const CPU_BUSY_METRIC = "cpu_busy_seconds_total";
const CPU_TOTAL_METRIC = "cpu_total_seconds_total";
const CPU_METRIC_NAME = "node_cpu_seconds_total";

// Disk metric mount selection: '/data' is the DB filesystem on Supabase
// compute (~25 GB ext4 on nvme0n1). '/' is the OS image (~10 GB) and is
// not what the Management API's config/disk/util endpoint was reporting.
// Stick with '/data' so the metric semantics carry over cleanly.
const DISK_MOUNT = "/data";

// FIX-1104: state-table key holding the PINNED provisioned disk size.
// baseline_value = the accepted size (what gets written to platform_limits),
// last_raw_value = the previous scrape's raw observation, which is what a
// shrink has to agree with before it is believed.
const DISK_SIZE_METRIC = "disk_size_bytes";

// ── Public types ──────────────────────────────────────────────────────────────

export type SupabasePrometheusMetrics = {
  egress_bytes_month_to_date: number;
  db_connections_active: number;
  disk_used_bytes: number;
  /**
   * Provisioned filesystem size of the /data mount in bytes. Reported by
   * Prometheus regardless of plan; the snapshot writer uses this to keep
   * `platform_limits.included_limit` for disk_used_bytes in sync with the
   * actual disk size (which can be manually resized above the 8 GB Pro
   * included quota). FIX-351.
   *
   * FIX-1104: the ACCEPTED size, after the shrink-corroboration guard. This
   * is the value that may be written to durable config; see
   * `disk_size_observed_bytes` for what this particular scrape said.
   */
  disk_size_bytes: number;
  /**
   * What THIS scrape reported for the /data filesystem size, before the
   * guard. Equal to `disk_size_bytes` on every tick except one that is being
   * held — keeping both means a held tick is visible rather than silent.
   * FIX-1104.
   */
  disk_size_observed_bytes: number;
  /** What the guard did with this scrape's observation. FIX-1104. */
  disk_size_action: DiskSizeAction;
  /**
   * 0–100 CPU utilization for the current scrape interval. FIX-355. Zero on
   * the first ever tick (bootstrap) and on any tick following a counter
   * reset; real values start appearing on the second tick post-bootstrap.
   */
  cpu_pct_current: number;
  /**
   * 0–100 max cpu_pct observed in the rolling 1h window (includes this
   * tick). FIX-356. Sourced from get_supabase_cpu_max RPC over
   * platform_usage_snapshot.
   */
  cpu_max_1h: number;
  /** 0–100 max cpu_pct observed in the rolling 24h window. FIX-356. */
  cpu_max_24h: number;
  /** Number of CPU cores observed in the scrape — debug only. */
  cpu_core_count: number;
  /** Raw counter value at this scrape — exposed for debug / introspection. */
  raw_egress_counter: number;
  fetched_at: string;
};

export type SupabasePrometheusMetricsError = { error: string };

// ── Module cache ──────────────────────────────────────────────────────────────

let cached: SupabasePrometheusMetrics | null = null;
let cacheExpiresAt = 0;

export function clearSupabasePrometheusCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

// ── Prometheus text-format parser ─────────────────────────────────────────────
//
// Lines look like:
//   metric_name{label1="v1",label2="v2"} 12345.6
// Comments start with `#` and are ignored. For our use:
//   - counters with a single label set (egress: one device=ens5) → sum is fine
//   - gauges with no breakdown (num_backends) → single value
//   - per-mount metrics → caller passes a label-match predicate
//
// Returned map keys back to whatever the caller asked for via `wants`.

type PromMatch = {
  /** Metric base name (no labels). */
  name: string;
  /** Optional label-substring predicate to pick a specific mount/device row. */
  labelContains?: string;
  /**
   * Optional list of label substrings to EXCLUDE. A row whose label blob
   * contains any of these is skipped before summing. Used to keep virtual
   * interfaces (lo/docker/veth/br/cni) out of the network egress counter,
   * which would otherwise inflate it. Prefer this over hardcoding a single
   * `device="ens5"` match — the physical interface name varies by host/tier.
   */
  labelExcludes?: string[];
};

export function parsePrometheusText(
  body: string,
  wants: PromMatch[],
): Map<string, number> {
  const out = new Map<string, number>();
  const lines = body.split("\n");

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;

    const braceIdx = line.indexOf("{");
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;

    const name = braceIdx === -1
      ? line.slice(0, spaceIdx)
      : line.slice(0, braceIdx);

    const valueStr = line.slice(spaceIdx + 1).trim();
    const value = Number(valueStr);
    if (!Number.isFinite(value)) continue;

    const labelBlob = braceIdx === -1 ? "" : line.slice(braceIdx, spaceIdx);

    for (const w of wants) {
      if (w.name !== name) continue;
      if (w.labelContains && !labelBlob.includes(w.labelContains)) continue;
      if (w.labelExcludes && w.labelExcludes.some((ex) => labelBlob.includes(ex))) {
        continue;
      }
      // Sum across matching rows so multi-device counters aggregate cleanly.
      out.set(
        keyOf(w),
        (out.get(keyOf(w)) ?? 0) + value,
      );
    }
  }

  return out;
}

function keyOf(w: PromMatch): string {
  return w.labelContains ? `${w.name}|${w.labelContains}` : w.name;
}

// ── Disk series selection (FIX-1104) ─────────────────────────────────────────

export type DiskSeries = {
  size_bytes: number;
  avail_bytes: number;
  /** `device=` label of the matched row — provenance, not used in any math. */
  device: string | null;
};

export type DiskSeriesError = { error: string };

/**
 * The single filesystem series for a mountpoint, or an error explaining why
 * there isn't one.
 *
 * Deliberately NOT built on parsePrometheusText: that helper sums matching
 * rows, which is right for a counter spread across devices and wrong for a
 * size. If the endpoint ever reported two filesystems at the same mountpoint
 * — a leftover mount across a resize, a bind mount, a replica's exporter
 * folded into the same scrape — summing them yields a denominator that is
 * larger than any real disk and looks entirely plausible on the card. Refuse
 * instead: a missing reading degrades to "keep the last known good", a
 * fabricated one does not degrade at all.
 *
 * Matching is on the exact label token `mountpoint="<mount>"`, so "/data"
 * cannot match "/data-old".
 */
export function selectDiskSeries(body: string, mount: string): DiskSeries | DiskSeriesError {
  const token = `mountpoint="${mount}"`;
  const rows: Record<string, { value: number; device: string | null }[]> = {
    node_filesystem_size_bytes: [],
    node_filesystem_avail_bytes: [],
  };

  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const braceIdx = line.indexOf("{");
    if (braceIdx === -1) continue;
    const name = line.slice(0, braceIdx);
    const bucket = rows[name];
    if (!bucket) continue;

    const spaceIdx = line.indexOf(" ", braceIdx);
    if (spaceIdx === -1) continue;
    const labels = line.slice(braceIdx, spaceIdx);
    if (!labels.includes(token)) continue;

    const value = Number(line.slice(spaceIdx + 1).trim());
    if (!Number.isFinite(value)) continue;
    const deviceMatch = labels.match(/device="([^"]*)"/);
    bucket.push({ value, device: deviceMatch?.[1] ?? null });
  }

  for (const [name, bucket] of Object.entries(rows)) {
    if (bucket.length !== 1) {
      return {
        error:
          `${name} matched ${bucket.length} row(s) for ${token}, expected exactly 1` +
          (bucket.length > 1
            ? ` (devices: ${bucket.map((r) => r.device ?? "?").join(", ")})`
            : ""),
      };
    }
  }

  const size = rows["node_filesystem_size_bytes"]![0]!;
  const avail = rows["node_filesystem_avail_bytes"]![0]!;
  if (!(size.value > 0)) {
    return { error: `node_filesystem_size_bytes for ${token} is ${size.value}, expected > 0` };
  }
  return { size_bytes: size.value, avail_bytes: avail.value, device: size.device };
}

// ── Provisioned-disk-size guard (FIX-1104) ───────────────────────────────────

export type DiskSizeAction =
  /** No prior accepted value — take this scrape and start tracking. */
  | "bootstrap"
  /** Same as the accepted size. The overwhelmingly common case. */
  | "steady"
  /** Larger than accepted. Growth is taken immediately (auto-scale is real). */
  | "grow"
  /** Smaller, and the PREVIOUS scrape said the same thing. Believed. */
  | "shrink_confirmed"
  /** Smaller, uncorroborated. Ignored; the accepted size stands. */
  | "shrink_held";

export type DiskSizeDecision = { value: number; action: DiskSizeAction };

/**
 * Decide what provisioned-disk size to trust, given this scrape, the size
 * currently accepted, and what the previous scrape observed.
 *
 * Asymmetric on purpose. Growth is what a Supabase disk actually does — it
 * auto-scales up and never auto-scales down — so a larger reading is taken on
 * sight and the card is correct within one tick of a resize. A SMALLER reading
 * is the shape a bad scrape takes, so it has to be seen twice in a row before
 * it moves durable config. A genuine downsize (a support-ticket operation, not
 * something that happens on its own) costs exactly one extra tick of lag.
 *
 * Pure — no clock, no DB. `lastObserved` is the previous scrape's RAW value,
 * not the previously accepted one; corroboration must come from an independent
 * observation, otherwise a held value would confirm itself on the next tick.
 */
export function resolveProvisionedDiskSize(args: {
  observed: number;
  accepted: number | null;
  lastObserved: number | null;
}): DiskSizeDecision {
  const { observed, accepted, lastObserved } = args;

  if (accepted === null || !(accepted > 0)) {
    return { value: observed, action: "bootstrap" };
  }
  if (observed === accepted) return { value: observed, action: "steady" };
  if (observed > accepted) return { value: observed, action: "grow" };
  if (lastObserved === observed) return { value: observed, action: "shrink_confirmed" };
  return { value: accepted, action: "shrink_held" };
}

/**
 * `resolveProvisionedDiskSize` wired to `supabase_prometheus_state`, which
 * carries both halves of the guard's memory for the `disk_size_bytes` key:
 * `baseline_value` is the accepted size, `last_raw_value` is the previous
 * scrape's observation.
 *
 * Fail-soft on a state read error: fall back to trusting the observation, the
 * pre-FIX-1104 behaviour. A guard that cannot read its memory should not also
 * take the disk row offline.
 */
export async function resolveDiskSizeWithCorroboration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  observed: number,
): Promise<DiskSizeDecision> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  const { data: existing, error } = await anyDb
    .from("supabase_prometheus_state")
    .select("metric, baseline_value, baseline_at, last_raw_value")
    .eq("metric", DISK_SIZE_METRIC)
    .maybeSingle();
  if (error) return { value: observed, action: "bootstrap" };

  const row = existing as StateRow | null;
  const decision = resolveProvisionedDiskSize({
    observed,
    accepted: row ? Number(row.baseline_value) : null,
    lastObserved: row ? Number(row.last_raw_value) : null,
  });

  const now = new Date().toISOString();
  if (!row) {
    await anyDb.from("supabase_prometheus_state").insert({
      metric: DISK_SIZE_METRIC,
      baseline_value: decision.value,
      baseline_at: now,
      last_raw_value: observed,
      last_scraped_at: now,
    });
  } else {
    await anyDb
      .from("supabase_prometheus_state")
      .update({
        baseline_value: decision.value,
        // Only stamp baseline_at when the accepted size actually moved, so it
        // reads as "when the disk changed size", not "when we last scraped".
        ...(decision.value !== Number(row.baseline_value) ? { baseline_at: now } : {}),
        last_raw_value: observed,
        last_scraped_at: now,
      })
      .eq("metric", DISK_SIZE_METRIC);
  }

  return decision;
}

// ── Counter-delta state ───────────────────────────────────────────────────────

type StateRow = {
  metric: string;
  baseline_value: number;
  baseline_at: string;
  last_raw_value: number;
};

export async function applyCounterDelta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  metric: string,
  currentValue: number,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  // FIX-545: a silent read error here looked like "no prior state" and
  // re-bootstrapped the baseline (zeroing the month-to-date delta). Throw —
  // the caller's catch converts to the error-shape return.
  const { data: existing, error: stateErr } = await anyDb
    .from("supabase_prometheus_state")
    .select("metric, baseline_value, baseline_at, last_raw_value")
    .eq("metric", metric)
    .maybeSingle();
  if (stateErr) throw new Error(`prometheus counter-state read (${metric}): ${stateErr.message}`);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  if (!existing) {
    await anyDb.from("supabase_prometheus_state").insert({
      metric,
      baseline_value: currentValue,
      baseline_at: now.toISOString(),
      last_raw_value: currentValue,
      last_scraped_at: now.toISOString(),
    });
    return 0;
  }

  const row = existing as StateRow;
  const last = Number(row.last_raw_value);
  const baseline = Number(row.baseline_value);
  const baselineAt = new Date(row.baseline_at);

  const isReset = currentValue < last;
  const isMonthRollover = baselineAt < monthStart;

  if (isReset || isMonthRollover) {
    await anyDb
      .from("supabase_prometheus_state")
      .update({
        baseline_value: currentValue,
        baseline_at: now.toISOString(),
        last_raw_value: currentValue,
        last_scraped_at: now.toISOString(),
      })
      .eq("metric", metric);
    return 0;
  }

  await anyDb
    .from("supabase_prometheus_state")
    .update({
      last_raw_value: currentValue,
      last_scraped_at: now.toISOString(),
    })
    .eq("metric", metric);

  return Math.max(0, currentValue - baseline);
}

/**
 * Per-tick counter delta — for metrics where the meaningful unit is the
 * change between scrapes, not month-to-date. Used by CPU % (FIX-355):
 *   cpu_busy_delta_this_scrape / cpu_total_delta_this_scrape × 100
 *
 * Same state table as applyCounterDelta, same reset detection. Differs in
 * two ways:
 *   1. No month-rollover reset (CPU has no monthly accumulator semantic).
 *   2. Returns `current - last_raw` instead of `current - baseline`.
 *
 * Bootstrap and reset both return 0, write current to both baseline and
 * last so a follow-up tick computes a clean delta.
 */
export async function applyTickDelta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  metric: string,
  currentValue: number,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  // FIX-545: same throw-on-error as applyCounterDelta above.
  const { data: existing, error: stateErr } = await anyDb
    .from("supabase_prometheus_state")
    .select("metric, baseline_value, baseline_at, last_raw_value")
    .eq("metric", metric)
    .maybeSingle();
  if (stateErr) throw new Error(`prometheus tick-state read (${metric}): ${stateErr.message}`);

  const now = new Date();

  if (!existing) {
    await anyDb.from("supabase_prometheus_state").insert({
      metric,
      baseline_value: currentValue,
      baseline_at: now.toISOString(),
      last_raw_value: currentValue,
      last_scraped_at: now.toISOString(),
    });
    return 0;
  }

  const row = existing as StateRow;
  const last = Number(row.last_raw_value);

  if (currentValue < last) {
    await anyDb
      .from("supabase_prometheus_state")
      .update({
        baseline_value: currentValue,
        baseline_at: now.toISOString(),
        last_raw_value: currentValue,
        last_scraped_at: now.toISOString(),
      })
      .eq("metric", metric);
    return 0;
  }

  await anyDb
    .from("supabase_prometheus_state")
    .update({
      last_raw_value: currentValue,
      last_scraped_at: now.toISOString(),
    })
    .eq("metric", metric);

  return Math.max(0, currentValue - last);
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function getSupabasePrometheusMetrics(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<SupabasePrometheusMetrics | SupabasePrometheusMetricsError> {
  if (cached && Date.now() < cacheExpiresAt) {
    return cached;
  }

  const secret = process.env["SUPABASE_SECRET_KEY"];
  if (!secret) {
    return { error: "SUPABASE_SECRET_KEY not set" };
  }

  const authHeader =
    "Basic " + Buffer.from(`service_role:${secret}`).toString("base64");

  try {
    const res = await fetch(METRICS_URL, {
      headers: {
        Authorization: authHeader,
        Accept: "text/plain",
      },
      cache: "no-store",
    } as RequestInit & { cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload" });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const text = await res.text();

    const wants: PromMatch[] = [
      // Exclude virtual interfaces so only physical NIC transmit is summed.
      // Today prod exposes a single device="ens5", but the endpoint can expose
      // lo/docker/veth/br/cni on other tiers/hosts, which would inflate egress.
      { name: EGRESS_METRIC, labelExcludes: NETWORK_VIRTUAL_DEVICES },
      { name: "pg_stat_database_num_backends" },
    ];

    const parsed = parsePrometheusText(text, wants);
    const egressRaw = parsed.get(EGRESS_METRIC);
    const numBackends = parsed.get("pg_stat_database_num_backends");

    if (egressRaw === undefined || numBackends === undefined) {
      return {
        error:
          `Missing metric(s) in response: ` +
          [
            egressRaw === undefined ? EGRESS_METRIC : null,
            numBackends === undefined ? "pg_stat_database_num_backends" : null,
          ].filter(Boolean).join(", "),
      };
    }

    // FIX-1104: the filesystem pair goes through selectDiskSeries, which
    // refuses an ambiguous mount rather than summing it into a plausible-
    // looking lie. See the header note.
    const disk = selectDiskSeries(text, DISK_MOUNT);
    if ("error" in disk) {
      return { error: `disk series (${DISK_MOUNT}): ${disk.error}` };
    }
    const diskSize = disk.size_bytes;
    const diskAvail = disk.avail_bytes;

    const egressDelta = await applyCounterDelta(db, EGRESS_METRIC, egressRaw);

    // FIX-355: CPU % from counter deltas on node_cpu_seconds_total. Walk every
    // matching line (one row per (cpu, mode) combination), accumulate busy
    // (mode != 'idle') and total separately. cpu_pct = 100 * busy_delta /
    // total_delta — num_cores divides out of both and is plan-tier robust.
    let cpuBusyRaw = 0;
    let cpuTotalRaw = 0;
    const cpuCoreIds = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.startsWith(`${CPU_METRIC_NAME}{`)) continue;
      const braceIdx = line.indexOf("{");
      const spaceIdx = line.indexOf(" ", braceIdx);
      if (spaceIdx === -1) continue;
      const labels = line.slice(braceIdx, spaceIdx);
      const value = Number(line.slice(spaceIdx + 1).trim());
      if (!Number.isFinite(value)) continue;
      cpuTotalRaw += value;
      if (!labels.includes('mode="idle"')) cpuBusyRaw += value;
      const cpuMatch = labels.match(/cpu="([^"]+)"/);
      if (cpuMatch && cpuMatch[1]) cpuCoreIds.add(cpuMatch[1]);
    }

    const cpuBusyDelta = await applyTickDelta(
      db,
      CPU_BUSY_METRIC,
      Math.floor(cpuBusyRaw),
    );
    const cpuTotalDelta = await applyTickDelta(
      db,
      CPU_TOTAL_METRIC,
      Math.floor(cpuTotalRaw),
    );
    const cpuPctCurrent =
      cpuTotalDelta > 0
        ? Math.max(0, Math.min(100, (cpuBusyDelta / cpuTotalDelta) * 100))
        : 0;

    // FIX-356: max-1h and max-24h. RPC reads existing snapshot rows; the
    // current tick hasn't been written yet, so fold it in client-side.
    // Fail-soft: if the RPC errors (e.g., migration not applied), windowed
    // max falls back to the current value alone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;
    let cpuMax1h = cpuPctCurrent;
    let cpuMax24h = cpuPctCurrent;
    try {
      const [{ data: max1h }, { data: max24h }] = await Promise.all([
        anyDb.rpc("get_supabase_cpu_max", { window_minutes: 60 }),
        anyDb.rpc("get_supabase_cpu_max", { window_minutes: 1440 }),
      ]);
      cpuMax1h = Math.max(Number(max1h ?? 0), cpuPctCurrent);
      cpuMax24h = Math.max(Number(max24h ?? 0), cpuPctCurrent);
    } catch {
      // RPC unavailable — keep cpu_max_* equal to the current value.
    }

    // FIX-1104: pin the denominator. Growth lands immediately; a shrink has to
    // be corroborated by the previous scrape before it moves durable config.
    const observedDiskSize = Math.max(0, Math.round(diskSize));
    const diskDecision = await resolveDiskSizeWithCorroboration(db, observedDiskSize);

    const result: SupabasePrometheusMetrics = {
      egress_bytes_month_to_date: egressDelta,
      db_connections_active: Math.round(numBackends),
      disk_used_bytes: Math.max(0, Math.round(diskSize - diskAvail)),
      disk_size_bytes: diskDecision.value,
      disk_size_observed_bytes: observedDiskSize,
      disk_size_action: diskDecision.action,
      cpu_pct_current: Math.round(cpuPctCurrent * 100) / 100,
      cpu_max_1h: Math.round(cpuMax1h * 100) / 100,
      cpu_max_24h: Math.round(cpuMax24h * 100) / 100,
      cpu_core_count: cpuCoreIds.size,
      raw_egress_counter: egressRaw,
      fetched_at: new Date().toISOString(),
    };

    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
