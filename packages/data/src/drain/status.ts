/**
 * Queue health snapshot. Prints counts by status × task_type and flags
 * stale 'processing' claims (claimed_at > 10 min ago) that a prior drain
 * session abandoned. Use --reclaim to flip those back to 'pending'.
 */

import { createAdminClient } from "@civitics/db";
import { parseFlags } from "./args";

type StatusRow = { status: string; task_type: string; count: number };

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const reclaim = flags["reclaim"] === "true";
  const staleMinutes = flags["stale-minutes"] && flags["stale-minutes"] !== "true"
    ? parseInt(flags["stale-minutes"], 10)
    : 10;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // Count by status × task_type via plain counted selects. (The prior
  // exec_sql_json RPC branch was dead — that function does not exist, so it
  // always errored and fell through to this path anyway; removed in FIX-696.)
  const summary: StatusRow[] = [];
  for (const status of ["pending", "processing", "done", "failed"]) {
    for (const task of ["tag", "summary"]) {
      const { count } = await db
        .from("enrichment_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", status)
        .eq("task_type", task);
      summary.push({ status, task_type: task, count: count ?? 0 });
    }
  }

  console.log("=== enrichment_queue status ===");
  for (const r of summary) {
    if (r.count > 0) {
      console.log(`  ${r.status.padEnd(12)} ${r.task_type.padEnd(8)} ${r.count}`);
    }
  }

  const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const { data: stale, error: staleErr } = await db
    .from("enrichment_queue")
    .select("id, task_type, claimed_by, claimed_at", { count: "exact" })
    .eq("status", "processing")
    .lt("claimed_at", staleCutoff)
    .limit(5);

  if (staleErr) {
    console.error("stale lookup failed:", staleErr.message);
  } else if (stale && stale.length > 0) {
    const { count: staleCount } = await db
      .from("enrichment_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "processing")
      .lt("claimed_at", staleCutoff);
    console.log(`\n=== STALE CLAIMS (>${staleMinutes} min, first 5 of ${staleCount}) ===`);
    for (const s of stale) {
      console.log(`  id=${s.id} task=${s.task_type} by=${s.claimed_by} at=${s.claimed_at}`);
    }

    if (reclaim) {
      const { error: updErr, count: updCount } = await db
        .from("enrichment_queue")
        .update(
          { status: "pending", claimed_at: null, claimed_by: null },
          { count: "exact" },
        )
        .eq("status", "processing")
        .lt("claimed_at", staleCutoff);
      if (updErr) {
        console.error("reclaim failed:", updErr.message);
        process.exit(1);
      }
      console.log(`\nReclaimed ${updCount ?? "?"} stale claim(s) → pending`);
    } else {
      console.log("\n(run with --reclaim to flip these back to pending)");
    }
  } else {
    console.log("\nNo stale claims.");
  }
}

main()
  .then(() => setTimeout(() => process.exit(0), 200))
  .catch((err) => {
    console.error("[drain:status] fatal:", err instanceof Error ? err.message : err);
    setTimeout(() => process.exit(1), 200);
  });
