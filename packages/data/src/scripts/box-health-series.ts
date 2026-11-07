/**
 * FIX-1125 — `pnpm --filter @civitics/data data:box-health:series [--hours 24] [--json]`
 *
 * Prints the OFF-box memory ring, one row per 2-minute sample, oldest first:
 * time, MemAvailable (MB and %), swap in use, load1, swap-in/out rates and
 * scrape wall. Summary on top: min / median / max over the window.
 *
 * WHY THIS IS THE INSTRUMENT FOR THE NEXT OUTAGE READ. It reads Upstash only,
 * with ONE LRANGE (one command), and opens no Postgres connection. When the box
 * is down or the snapshot route has stopped writing, as it had 15:30–22:00 on
 * 09-22, this still answers. The ring holds 30 h (900 samples, FIX-1289), so
 * run it inside a day of the event. `--json` rows carry the raw counters too
 * (FIX-1386); the printed table does not.
 *
 * Needs UPSTASH_REDIS_REST_URL / _TOKEN. All three .env.local files carry them,
 * and there is one Upstash database, so the ring is the same whichever file
 * this reads.
 */

import { readBoxHealthRing, upstashCredsFromEnv, BOX_HEALTH_RING_LEN } from "@civitics/db";
import { formatSeries, parseSeriesArgs, seriesRows, seriesStats } from "../lib/box-health-series";

async function main(): Promise<void> {
  const args = parseSeriesArgs(process.argv.slice(2));
  if (args.kind === "help") {
    console.info(args.usage);
    process.exit(0);
  }
  if (args.kind === "error") {
    console.error(`[box-health] ${args.error}`);
    process.exit(2);
  }
  const { hours, json, note } = args;
  if (note !== null) console.error(`[box-health] ${note}`);
  const creds = upstashCredsFromEnv(process.env);
  if (!creds) {
    console.error("[box-health] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — nothing to read.");
    process.exit(2);
  }
  const ring = await readBoxHealthRing(creds, fetch, BOX_HEALTH_RING_LEN);
  if (!ring.ok) {
    console.error(`[box-health] ring read failed: ${ring.error}`);
    process.exit(1);
  }
  const now = new Date();
  const rows = seriesRows(ring.samples, { hours, now });
  const stats = seriesStats(rows, ring.samples);
  if (json) {
    console.info(JSON.stringify({ read_at: now.toISOString(), hours, ring_len: ring.samples.length, unparseable: ring.unparseable, stats, rows }, null, 2));
    return;
  }
  console.info(formatSeries(rows, stats, hours));
  console.info(`[box-health] ring holds ${ring.samples.length} sample(s)${ring.unparseable > 0 ? `, ${ring.unparseable} unparseable` : ""}; read at ${now.toISOString()}`);
}

main().catch((err) => {
  console.error(`[box-health] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
