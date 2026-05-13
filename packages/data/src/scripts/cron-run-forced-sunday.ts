/**
 * Forced-Sunday cron wrapper — one-shot, OPERATIONAL.
 *
 * Stubs Date.prototype.getDay → 0 so runNightlySync()'s isWeekly gate fires
 * outside the Sunday cron window. Sets FEC_CYCLES + FEC_INDIV_CYCLES to
 * exercise FIX-236 + FIX-240 against both 2024 (presidential) and 2026 cycles.
 *
 * RUN ONLY WITH --allow-prod AGAINST PROD. Halts on RSS > 7.5 GB.
 *
 * Cleanup expected after the audit doc is committed.
 */

// CRITICAL: stub Date.getDay BEFORE importing the orchestrator. The orchestrator
// reads `new Date().getDay() === 0` inside runNightlySync, but if any module-level
// initializer in its import graph ever reads getDay, we want the stub already
// in place. (Currently it doesn't, but cheap to be safe.)
const _realGetDay = Date.prototype.getDay;
Date.prototype.getDay = function (this: Date): number {
  return 0;
};

import { runNightlySync } from "../pipelines";

// Heap watchdog — halt at 12 GB RSS. Raised from 7.5 GB for Run #2 of
// 2026-05-12 to use the headroom FIX-254 added (NODE_OPTIONS=12288).
const HALT_RSS_BYTES = 12_000_000_000;
let peakRssMb = 0;
const rssInterval = setInterval(() => {
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (rssMb > peakRssMb) peakRssMb = rssMb;
  if (process.memoryUsage().rss > HALT_RSS_BYTES) {
    console.error(`\n[wrapper] HALT — RSS ${rssMb} MB exceeds 7.5 GB ceiling. Aborting run.`);
    clearInterval(rssInterval);
    process.exit(2);
  }
  // Heartbeat every iteration
  console.log(`[wrapper-heartbeat] rss=${rssMb}MB peak=${peakRssMb}MB elapsed=${Math.round((Date.now() - START) / 1000)}s`);
}, 30_000);

const START = Date.now();

// Force FEC scope: both cycles, full indiv re-stream.
process.env["FEC_CYCLES"] = process.env["FEC_CYCLES"] ?? "2024,2026";
process.env["FEC_INDIV_CYCLES"] = process.env["FEC_INDIV_CYCLES"] ?? "2024,2026";

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("FORCED-SUNDAY CRON RUN — PROD");
  console.log("=".repeat(72));
  console.log(`Started: ${new Date(START).toISOString()}`);
  console.log(`FEC_CYCLES:        ${process.env["FEC_CYCLES"]}`);
  console.log(`FEC_INDIV_CYCLES:  ${process.env["FEC_INDIV_CYCLES"]}`);
  console.log(`NODE_OPTIONS:      ${process.env["NODE_OPTIONS"] ?? "(unset — DEFAULT 4GB!)"}`);
  console.log(`Date.getDay stub:  ${new Date().getDay()} (expect 0)`);
  console.log("=".repeat(72));

  const results = await runNightlySync();

  clearInterval(rssInterval);
  const elapsedMin = ((Date.now() - START) / 1000 / 60).toFixed(2);
  console.log("=".repeat(72));
  console.log(`COMPLETED in ${elapsedMin} min (peak RSS ${peakRssMb} MB)`);
  console.log("=".repeat(72));
  console.log(JSON.stringify({
    started_at: results.started_at,
    completed_at: results.completed_at,
    duration_ms: results.duration_ms,
    is_weekly: results.is_weekly,
    pipelines: results.pipelines,
    ai: results.ai,
    total_ai_cost_usd: results.total_ai_cost_usd,
    errors: results.errors,
    wrapper_peak_rss_mb: peakRssMb,
  }, null, 2));

  // Restore real getDay (cosmetic — process exits next anyway)
  Date.prototype.getDay = _realGetDay;
  setTimeout(() => process.exit(results.errors.length === 0 ? 0 : 1), 500);
}

main().catch((e) => {
  clearInterval(rssInterval);
  console.error("[wrapper] runNightlySync threw:", e instanceof Error ? e.stack : String(e));
  console.error(`[wrapper] peak RSS ${peakRssMb} MB, elapsed ${((Date.now() - START) / 1000).toFixed(1)}s`);
  Date.prototype.getDay = _realGetDay;
  setTimeout(() => process.exit(1), 500);
});
