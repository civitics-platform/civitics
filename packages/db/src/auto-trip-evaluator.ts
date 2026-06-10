/**
 * Auto-trip evaluator for runtime kill switches.
 *
 * Runs inside computePlatformUsagePayload (the 10-min snapshot cron), after
 * all vendor APIs have written their fresh numbers through to platform_usage
 * but before the snapshot row is inserted. Iterates every switch in
 * pipeline_state.kill_switches and checks each metric mapped to that switch:
 *
 *   1. Look up the corresponding PlatformMetric in the freshly computed
 *      metrics array. Skip if missing.
 *   2. FRESHNESS GATE — auto-trip only fires when source='api' AND the row
 *      was recorded within the last 30 min (3x the 10-min cron cadence; robust
 *      to one missed cycle). Manual rows, estimated rows, and stale API rows
 *      are silently skipped. This is what stops Vercel's manual 2026-04-22
 *      seed rows from auto-tripping origin_transfer_bytes at ~93%.
 *   3. If pct >= auto_trip_threshold_pct AND the switch is currently ON,
 *      flip it OFF via flipSwitch (which logs to kill_switch_events).
 *   4. Auto-trip is ONE-WAY — pct dropping back below threshold does NOT
 *      flip the switch back on. Re-enable is a manual decision via the
 *      admin POST route. Prevents log spam on sustained-overage cycles.
 *
 * Returns the full decision list (one entry per switch examined) so the
 * cron can surface it in the snapshot payload + the route response for
 * observability without us having to query kill_switch_events to confirm
 * what was considered vs. what fired.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { flipSwitch, type KillSwitchName, type KillSwitchesMap } from "./kill-switches";
import type { PlatformMetric } from "./platform-usage";

export type AutoTripAction =
  | "flip"
  | "skip_stale"
  | "skip_already_off"
  | "skip_no_metrics"
  | "skip_no_threshold"
  | "skip_metric_missing"
  | "skip_below_threshold";

export type AutoTripDecision = {
  switch_name: KillSwitchName;
  trigger_metric: string | null;
  trigger_value: number | null;
  threshold_pct: number | null;
  current_pct: number | null;
  action: AutoTripAction;
  event_id?: number | null;
};

const FRESHNESS_WINDOW_MS = 30 * 60 * 1000; // 30 min, 3x the 10-min cron cadence

function metricKey(m: PlatformMetric): string {
  return `${m.service}.${m.metric}`;
}

function isFresh(m: PlatformMetric): boolean {
  if (m.source !== "api") return false;
  if (!m.recorded_at) return false;
  const recordedMs = new Date(m.recorded_at).getTime();
  if (!Number.isFinite(recordedMs)) return false;
  return Date.now() - recordedMs <= FRESHNESS_WINDOW_MS;
}

export async function evaluateAutoTrips(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  freshSnapshotMetrics: PlatformMetric[],
): Promise<AutoTripDecision[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  // Load the switch map fresh — don't trust the 30s module cache here because
  // we might have just flipped on a previous wave's tick and the cache could
  // be lying.
  // FIX-545: a silent read error here looked like "no switches configured"
  // and the auto-trip safety pass silently skipped the whole tick. Throw —
  // the cron caller records the failure instead.
  const { data: row, error: switchErr } = await anyDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "kill_switches")
    .maybeSingle();
  if (switchErr) throw new Error(`auto-trip kill-switch state read: ${switchErr.message}`);

  const switches = (row?.value as Partial<KillSwitchesMap> | null) ?? {};

  const metricsByKey = new Map<string, PlatformMetric>();
  for (const m of freshSnapshotMetrics) metricsByKey.set(metricKey(m), m);

  const decisions: AutoTripDecision[] = [];

  for (const [name, state] of Object.entries(switches) as [
    KillSwitchName,
    KillSwitchesMap[KillSwitchName],
  ][]) {
    const threshold = state?.auto_trip_threshold_pct ?? null;
    const watched = state?.metrics ?? [];

    if (watched.length === 0) {
      decisions.push({
        switch_name: name,
        trigger_metric: null,
        trigger_value: null,
        threshold_pct: threshold,
        current_pct: null,
        action: "skip_no_metrics",
      });
      continue;
    }

    if (threshold === null) {
      decisions.push({
        switch_name: name,
        trigger_metric: null,
        trigger_value: null,
        threshold_pct: null,
        current_pct: null,
        action: "skip_no_threshold",
      });
      continue;
    }

    // Per-metric evaluation. First metric to cross threshold wins (we don't
    // need to check the rest — auto-trip is one-way; switch is already off
    // after the first flip and re-evaluating remaining metrics would just
    // produce redundant decisions).
    let recorded = false;
    for (const key of watched) {
      const metric = metricsByKey.get(key);
      if (!metric) {
        decisions.push({
          switch_name: name,
          trigger_metric: key,
          trigger_value: null,
          threshold_pct: threshold,
          current_pct: null,
          action: "skip_metric_missing",
        });
        recorded = true;
        break;
      }

      if (!isFresh(metric)) {
        decisions.push({
          switch_name: name,
          trigger_metric: key,
          trigger_value: metric.value,
          threshold_pct: threshold,
          current_pct: metric.pct,
          action: "skip_stale",
        });
        recorded = true;
        break;
      }

      if (metric.pct < threshold) {
        decisions.push({
          switch_name: name,
          trigger_metric: key,
          trigger_value: metric.value,
          threshold_pct: threshold,
          current_pct: metric.pct,
          action: "skip_below_threshold",
        });
        recorded = true;
        break;
      }

      // Threshold crossed. Only flip if the switch is currently ON —
      // re-flipping a switch that's already off would spam kill_switch_events
      // on every cron tick for the duration of the overage.
      if (state.enabled === false) {
        decisions.push({
          switch_name: name,
          trigger_metric: key,
          trigger_value: metric.value,
          threshold_pct: threshold,
          current_pct: metric.pct,
          action: "skip_already_off",
        });
        recorded = true;
        break;
      }

      const { event_id } = await flipSwitch(db, name, false, {
        source: "auto",
        trigger_metric: key,
        trigger_value: metric.value,
        threshold_pct: threshold,
      });

      decisions.push({
        switch_name: name,
        trigger_metric: key,
        trigger_value: metric.value,
        threshold_pct: threshold,
        current_pct: metric.pct,
        action: "flip",
        event_id,
      });
      recorded = true;
      break;
    }

    if (!recorded) {
      // Shouldn't be reachable — every branch above records — but keeps the
      // decision count == switch count contract that callers may rely on.
      decisions.push({
        switch_name: name,
        trigger_metric: null,
        trigger_value: null,
        threshold_pct: threshold,
        current_pct: null,
        action: "skip_no_metrics",
      });
    }
  }

  return decisions;
}
