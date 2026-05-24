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

    const result: SupabasePrometheusMetrics = {
      egress_bytes_month_to_date: egressDelta,
      db_connections_active: Math.round(numBackends),
      disk_used_bytes: Math.max(0, Math.round(diskSize - diskAvail)),
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
