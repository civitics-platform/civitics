/**
 * FIX-743: weekly/Sunday day-gate for the nightly orchestrator's heavy ingest
 * block (FEC bulk, IRS-990, LittleSis, EDGAR-weekly, OpenStates API,
 * agencies/OPM/PLUM/elections/committees/agency-*, tag-industry). Normally these
 * run only on Sunday (`getDay() === 0`). A `workflow_dispatch` on nightly.yml
 * with `force_weekly=true` sets NIGHTLY_FORCE_WEEKLY=true (forwarded to all three
 * phase jobs) so the whole heavy path can be run SUPERVISED in a low-traffic
 * window without waiting for the calendar. This is a heavy, prod-writing run when
 * forced — idempotent upserts, but IOWait-heavy on the Pro Micro — intended for
 * off-peak/supervised use only.
 *
 * With the flag unset/anything-but-"true" the gate is identical to the pre-FIX-743
 * `getDay() === 0` behavior, so scheduled cron runs and plain dispatches are
 * unchanged.
 *
 * This lives in its own module (not inline in index.ts) so it stays pure and
 * unit-testable without dragging in index.ts's heavy import graph (createAdminClient,
 * ai-tagger's module-level createAiClient(), etc.) — mirrors selectKillTarget.
 */
export type WeeklyMode = "forced" | "sunday" | "skipped";

export function computeRunWeekly(
  now: Date,
  forceEnv: string | undefined,
): { runWeekly: boolean; mode: WeeklyMode } {
  const isSunday = now.getDay() === 0;
  const forced = forceEnv === "true";
  if (forced) return { runWeekly: true, mode: "forced" };
  return { runWeekly: isSunday, mode: isSunday ? "sunday" : "skipped" };
}
