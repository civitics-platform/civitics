/**
 * FIX-255 — Manual invocation of reap_stale_sync_log(stale_minutes).
 *
 * Flips any data_sync_log rows older than `--stale-minutes N` (default 60)
 * from status='running' to status='failed' with error_message='reaped_orphan'.
 *
 * Targets whichever DB the active .env.local points at. CLAUDE.md requires
 * confirming the active env before invocation against prod — this script
 * does NOT itself prompt; that's the operator's job.
 *
 *   pnpm --filter @civitics/data data:reap-sync-log
 *   pnpm --filter @civitics/data data:reap-sync-log -- --stale-minutes 30
 */

import { createAdminClient } from "@civitics/db";

function parseStaleMinutes(argv: string[]): number {
  const i = argv.findIndex((a) => a === "--stale-minutes" || a === "-m");
  if (i >= 0 && argv[i + 1]) {
    const n = Number.parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 60;
}

async function main(): Promise<void> {
  const staleMinutes = parseStaleMinutes(process.argv.slice(2));
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "<unknown>";
  console.log(`[reap] target: ${url}`);
  console.log(`[reap] stale_minutes: ${staleMinutes}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("reap_stale_sync_log", { stale_minutes: staleMinutes });
  if (error) {
    console.error("[reap] RPC error:", error.message ?? error);
    process.exit(1);
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    console.log("[reap] nothing to reap");
    return;
  }
  console.log(`[reap] reaped ${rows.length} row(s):`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows as any[]) {
    console.log(`  ${r.pipeline.padEnd(32)} ${r.id}  ${r.reaped_at}`);
  }
}

main().catch((err) => {
  console.error("[reap] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
