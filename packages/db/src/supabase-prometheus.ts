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
   */
  disk_size_bytes: number;
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

  const { data: existing } = await anyDb
    .from("supabase_prometheus_state")
    .select("metric, baseline_value, baseline_at, last_raw_value")
    .eq("metric", metric)
    .maybeSingle();

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

  const { data: existing } = await anyDb
    .from("supabase_prometheus_state")
    .select("metric, baseline_value, baseline_at, last_raw_value")
    .eq("metric", metric)
    .maybeSingle();

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
      { name: EGRESS_METRIC },
      { name: "pg_stat_database_num_backends" },
      {
        name: "node_filesystem_size_bytes",
        labelContains: `mountpoint="${DISK_MOUNT}"`,
      },
      {
        name: "node_filesystem_avail_bytes",
        labelContains: `mountpoint="${DISK_MOUNT}"`,
      },
    ];

    const parsed = parsePrometheusText(text, wants);
    const egressRaw = parsed.get(EGRESS_METRIC);
    const numBackends = parsed.get("pg_stat_database_num_backends");
    const diskSize = parsed.get(
      `node_filesystem_size_bytes|mountpoint="${DISK_MOUNT}"`,
    );
    const diskAvail = parsed.get(
      `node_filesystem_avail_bytes|mountpoint="${DISK_MOUNT}"`,
    );

    if (
      egressRaw === undefined ||
      numBackends === undefined ||
      diskSize === undefined ||
      diskAvail === undefined
    ) {
      return {
        error:
          `Missing metric(s) in response: ` +
          [
            egressRaw === undefined ? EGRESS_METRIC : null,
            numBackends === undefined ? "pg_stat_database_num_backends" : null,
            diskSize === undefined ? `node_filesystem_size_bytes(${DISK_MOUNT})` : null,
            diskAvail === undefined ? `node_filesystem_avail_bytes(${DISK_MOUNT})` : null,
          ].filter(Boolean).join(", "),
      };
    }

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

    const result: SupabasePrometheusMetrics = {
      egress_bytes_month_to_date: egressDelta,
      db_connections_active: Math.round(numBackends),
      disk_used_bytes: Math.max(0, Math.round(diskSize - diskAvail)),
      disk_size_bytes: Math.max(0, Math.round(diskSize)),
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
