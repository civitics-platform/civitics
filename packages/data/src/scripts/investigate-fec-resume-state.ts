/**
 * Read-only probe of the nightly fec-phase's two off-Sunday trigger inputs:
 * the FIX-754 resume state and the FIX-193 indiv watermark that FIX-903's
 * drop-check compares against.
 *
 * Originally written to answer "did the 2026-07-26 (Sunday) fec-phase leave a
 * valid resume state behind?" after that job was cancelled at its 2h30m GHA
 * budget. FIX-754's contract is that a SIGTERMed heavy Sunday leaves
 * `pipeline_state.fec_bulk_run_state` behind and the next weekday nightly picks
 * it up via the `runFec && !isWeekly` branch in ../pipelines/index.ts. The
 * answer was "no state, and the watermark was two weeks stale" — which is what
 * surfaced FIX-903.
 *
 * Kept and wired up as a repeatable probe rather than a one-shot: it is the
 * fastest way to answer "why did (or didn't) fec_bulk fire last night?" and it
 * is how FIX-903's durable proof gets measured — `fec_indiv_watermark['2026']`
 * advancing to the current FEC Last-Modified within the same week it was
 * published.
 *
 * SELECT only. No writes, no RPCs with side effects.
 *
 *   pnpm --filter @civitics/data data:fec:resume-status         # local
 *   pnpm --filter @civitics/data data:fec:resume-status:prod    # prod (read-only)
 */

import { createAdminClient } from "@civitics/db";
import {
  FEC_RUN_STATE_KEY,
  TRACKED_STAGES,
  parseRunState,
  describeRunState,
  allIndivWriterStagesComplete,
} from "../pipelines/fec-bulk/run-state";

const WATERMARK_KEY = "fec_indiv_watermark";

function hr(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // -------------------------------------------------------------------------
  // (a) pipeline_state rows
  // -------------------------------------------------------------------------
  hr("(a) pipeline_state — fec_bulk_run_state + fec_indiv_watermark");

  const { data: stateRows, error: stateErr } = await db
    .from("pipeline_state")
    .select("key, value, updated_at")
    .in("key", [FEC_RUN_STATE_KEY, WATERMARK_KEY]);

  if (stateErr) {
    console.error(`pipeline_state query failed: ${stateErr.message}`);
  } else {
    const rows = (stateRows ?? []) as Array<{
      key: string;
      value: unknown;
      updated_at: string | null;
    }>;
    for (const key of [FEC_RUN_STATE_KEY, WATERMARK_KEY]) {
      const row = rows.find((r) => r.key === key);
      console.log(`\n--- ${key} ---`);
      if (!row) {
        console.log("  (row ABSENT)");
        continue;
      }
      console.log(`  updated_at: ${row.updated_at}`);
      console.log(`  value: ${JSON.stringify(row.value, null, 2)}`);
    }

    // Interpreted view of the run state.
    const raw = rows.find((r) => r.key === FEC_RUN_STATE_KEY)?.value ?? null;
    const parsed = parseRunState(raw);
    console.log(`\n--- interpreted run state ---`);
    if (!raw) {
      console.log("  no fec_bulk_run_state row → next nightly resumes NOTHING (plan=none)");
    } else if (!parsed) {
      console.log("  row present but FAILS parseRunState() shape validation → treated as none");
    } else {
      console.log(`  describeRunState(): ${describeRunState(parsed)}`);
      console.log(`  version: ${parsed.version}  cycle: ${parsed.cycle}`);
      console.log(`  fec_last_modified: "${parsed.fec_last_modified}"`);
      console.log(`  fec_etag: ${parsed.fec_etag ?? "(null)"}`);
      console.log(`  started_at: ${parsed.started_at}`);
      console.log(`  updated_at: ${parsed.updated_at}`);
      console.log(`  per-stage:`);
      for (const s of TRACKED_STAGES) {
        const p = parsed.stages[s];
        if (!p) console.log(`    ${s.padEnd(26)} pending`);
        else if (p.status === "complete") console.log(`    ${s.padEnd(26)} complete`);
        else
          console.log(
            `    ${s.padEnd(26)} in-progress cursor=${p.cursor ?? 0} total_rows=${
              p.total_rows ?? "?"
            }` +
              (p.total_rows
                ? ` (${(((p.cursor ?? 0) / p.total_rows) * 100).toFixed(1)}%)`
                : ""),
          );
      }
      console.log(
        `  allIndivWriterStagesComplete: ${allIndivWriterStagesComplete(parsed)} → ` +
          `identity-valid plan would be "${
            allIndivWriterStagesComplete(parsed) ? "skip-indiv" : "resume"
          }"`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // (b) data_sync_log — nightly_cron + nightly_killed, last 3 days
  // -------------------------------------------------------------------------
  hr("(b) data_sync_log — nightly_cron / nightly_killed, last 3 days");

  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: logRows, error: logErr } = await db
    .from("data_sync_log")
    .select("id, pipeline, status, started_at, completed_at, error_message, metadata")
    .in("pipeline", ["nightly_cron", "nightly_killed"])
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(100);

  if (logErr) {
    console.error(`data_sync_log query failed: ${logErr.message}`);
  } else {
    const rows = (logRows ?? []) as Array<{
      id: string;
      pipeline: string;
      status: string | null;
      started_at: string | null;
      completed_at: string | null;
      error_message: string | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: any;
    }>;
    console.log(`\n${rows.length} row(s) since ${since}\n`);
    for (const r of rows) {
      const phase = r.metadata?.phase ?? null;
      console.log(
        `id=${r.id}\n` +
          `  pipeline=${r.pipeline} status=${r.status} phase=${phase}\n` +
          `  started_at=${r.started_at} completed_at=${r.completed_at}\n` +
          (r.error_message ? `  error_message=${r.error_message}\n` : "") +
          `  metadata.pipelines.fec_bulk=${JSON.stringify(
            r.metadata?.pipelines?.fec_bulk ?? null,
          )}`,
      );
      if (r.pipeline === "nightly_killed") {
        console.log(
          `  metadata (killed row, full)=${JSON.stringify(r.metadata ?? null)}`,
        );
      }
      console.log("");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[investigate-fec-resume-state] failed:", err);
    process.exit(1);
  });
