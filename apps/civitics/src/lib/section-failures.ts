/**
 * FIX-1121 — per-metric failure reporting for status-payload sections.
 *
 * A status section fans out many independent counts and returns them as one
 * object. Before this module, a single failed count set `partial: true` on the
 * whole object, and every consumer read that as "this section is unusable":
 * one failed `votes` count blanked all four public stat cards, the five lines
 * of "What Civitics Tracks", and every pipeline row's totals. Measured on prod
 * 2026-08-29, 9 of the 10 retained `status_snapshot` ticks carried
 * `database.error = 'count failed for: votes'`, so that blackout was the
 * NORMAL state of the transparency dashboard, not an edge case.
 *
 * The contract this module defines:
 *
 *   - The producer keeps `partial` + `error` exactly as before (the aggregate
 *     `failedSections` list and the `status_snapshot.error` column both key off
 *     `partial`, and neither should change meaning) and ADDS `failed: string[]`
 *     naming the metrics that actually failed.
 *   - A consumer never renders a failed metric as a number. The payload value
 *     for a failed count is `0` — a lying zero, since the count never returned —
 *     so `isMetricAvailable` is what stands between that zero and the page.
 *   - A consumer always renders a metric that is NOT in `failed`. That number
 *     was measured; withholding it is its own kind of dishonesty.
 *
 * BACKWARD COMPATIBILITY IS THE REASON `failed` IS ADDITIVE. `status_snapshot`
 * persists whole payloads and retains them for days, so rows written before
 * this shipped are read back by this code. Those rows carry `partial` with no
 * `failed` key, and "which metrics failed" is genuinely unknown for them — so
 * `isMetricAvailable` returns false for every metric, reproducing exactly
 * today's blanking behaviour rather than guessing.
 *
 * Pure and import-free on purpose: `getDatabase` (server) and DashboardClient
 * (client bundle) both import it, so producer and consumer cannot drift apart.
 * Same reasoning as `@/lib/snapshot-freshness` (FIX-1094).
 */

/** The extra fields a section carries when one or more of its metrics failed. */
export type MetricFailureFields =
  | Record<string, never>
  | { error: string; partial: true; failed: string[] };

/**
 * Producer side. Given the list of metric names whose queries errored, return
 * the fields to spread onto the section result. Empty object when nothing
 * failed, so the healthy shape stays free of failure keys.
 */
export function countFailureFields(errored: string[]): MetricFailureFields {
  if (errored.length === 0) return {};
  return {
    error: `count failed for: ${errored.join(", ")}`,
    partial: true as const,
    failed: errored,
  };
}

/**
 * The metric names a section reports as failed, or `null` when the section is
 * healthy. An EMPTY array means "partial, but the payload doesn't say which" —
 * a pre-FIX-1121 snapshot, or a section that threw outright and was wrapped by
 * `section()`. Callers must treat that as "nothing is trustworthy", which is
 * what `isMetricAvailable` does.
 */
export function failedMetrics(section: unknown): string[] | null {
  if (!section || typeof section !== "object") return [];
  if (!("partial" in section)) return null;
  const failed = (section as { failed?: unknown }).failed;
  if (!Array.isArray(failed)) return [];
  return failed.filter((f): f is string => typeof f === "string");
}

/**
 * Consumer side. True when this section resolved and this specific metric's
 * value can be believed.
 */
export function isMetricAvailable(section: unknown, metric: string): boolean {
  const failed = failedMetrics(section);
  if (failed === null) return true;
  return failed.length > 0 && !failed.includes(metric);
}

/**
 * Consumer side, value form. The metric's number, or `null` when the metric is
 * unavailable (section missing, section wholly partial, or this metric failed).
 * Prefer this over reading the field directly — a failed count's stored value
 * is a zero that was never measured.
 */
export function metricValue(section: unknown, metric: string): number | null {
  if (!isMetricAvailable(section, metric)) return null;
  const v = (section as Record<string, unknown>)[metric];
  return typeof v === "number" ? v : null;
}
