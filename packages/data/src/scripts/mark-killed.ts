/**
 * FIX-290 — Write a synthetic `nightly_killed` row to data_sync_log when the
 * workflow ran out of wall-clock budget before runNightlySync wrote its own
 * completion row.
 *
 * Invoked from .github/workflows/nightly.yml (and rebuild-entity-connections.yml,
 * FIX-291) as an `if: always()` post-step. The step always runs, but we only
 * INSERT a synthetic row when:
 *
 *   1. There IS a recent `<pipeline>` row with `status='running'` within the
 *      last `--window-hours` (default 4h) — proves the workflow actually
 *      started and orphaned a row.
 *   2. AND there is NO matching `<pipeline>` row with status IN ('complete',
 *      'partial','failed','skipped') in the same window — proves the run did
 *      not finish naturally.
 *
 * Pipeline name defaults to `nightly_cron` to match the daily workflow's
 * completion-write at packages/data/src/pipelines/index.ts. Override with
 * `--pipeline=<name>` (e.g. `entity_connections_rebuild` for the rebuild
 * workflow).
 *
 * The synthetic row is always written with pipeline='nightly_killed' (a
 * distinct signal-only stream) regardless of the source pipeline, so the
 * canary's existing query separates "ran" from "killed" cleanly. The
 * triggering pipeline name and orphan row id are preserved in metadata.
 *
 * This step is observability, not a gate — it always exits 0 even if the
 * write fails. Failure to write a marker is strictly worse signal than the
 * marker itself was, but it's still strictly worse than aborting the job.
 *
 *   pnpm data:mark-killed
 *   pnpm data:mark-killed:ci                                     # adds --allow-prod
 *   pnpm data:mark-killed:ci -- --pipeline=entity_connections_rebuild
 *   pnpm data:mark-killed -- --window-hours 6
 */

import { createAdminClient } from "@civitics/db";
import { captureRssMb } from "../pipelines/sync-log";

const KILLED_PIPELINE = "nightly_killed";

function parseArgs(argv: string[]): { pipeline: string; windowHours: number; phase?: string } {
  let pipeline = "nightly_cron";
  let windowHours = 4;
  let phase: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--pipeline=")) {
      pipeline = a.slice("--pipeline=".length);
    } else if (a === "--pipeline" && argv[i + 1]) {
      pipeline = argv[i + 1];
      i++;
    } else if (a.startsWith("--window-hours=")) {
      windowHours = Number.parseFloat(a.slice("--window-hours=".length));
    } else if (a === "--window-hours" && argv[i + 1]) {
      windowHours = Number.parseFloat(argv[i + 1]);
      i++;
    } else if (a.startsWith("--phase=")) {
      phase = a.slice("--phase=".length);
    } else if (a === "--phase" && argv[i + 1]) {
      phase = argv[i + 1];
      i++;
    }
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 4;
  return { pipeline, windowHours, phase };
}

interface SyncRow {
  id: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  metadata?: { phase?: string } | null;
}

const TERMINAL_STATUSES = ["complete", "partial", "failed", "skipped"];

/**
 * FIX-462: pure kill-target selection so it can be unit-tested without a live
 * DB. When `phase` is given, only rows whose `metadata.phase` matches are
 * considered — once enrichment-phase is decoupled from fec-phase
 * (.github/workflows/nightly.yml), both phases write nightly_cron rows for the
 * same date, so an unscoped scan would see enrichment's terminal row and
 * wrongly conclude a timed-out fec-phase had finished.
 *
 * Returns `{ finished }` if a same-phase run completed in the window (no-op),
 * else `{ orphan }` if a same-phase `running` row was orphaned (write a marker),
 * else `{}` (nothing ran).
 */
export function selectKillTarget(
  rows: SyncRow[],
  phase?: string,
): { finished?: SyncRow; orphan?: SyncRow } {
  const scoped = phase
    ? rows.filter((r) => (r.metadata?.phase ?? undefined) === phase)
    : rows;
  const finished = scoped.find((r) => TERMINAL_STATUSES.includes((r.status ?? "").toString()));
  if (finished) return { finished };
  const orphan = scoped.find((r) => r.status === "running");
  return orphan ? { orphan } : {};
}

async function main(): Promise<void> {
  const { pipeline, windowHours, phase } = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const phaseLabel = phase ? `${pipeline} phase=${phase}` : pipeline;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  const { data, error } = await db
    .from("data_sync_log")
    .select("id, status, started_at, completed_at, metadata")
    .eq("pipeline", pipeline)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    console.warn(`[mark-killed] data_sync_log query failed: ${error.message}`);
    // Observability, not a gate — always exit 0.
    return;
  }

  const rows = (data ?? []) as SyncRow[];
  const { finished, orphan } = selectKillTarget(rows, phase);
  if (finished) {
    console.log(
      `[mark-killed] ${phaseLabel} finished in window (status=${finished.status}, id=${finished.id}) — no-op`,
    );
    return;
  }
  if (!orphan) {
    console.log(
      `[mark-killed] no '${phaseLabel}' row in last ${windowHours}h — no-op (workflow may not have started)`,
    );
    return;
  }

  const now = new Date().toISOString();
  const { error: insErr } = await db.from("data_sync_log").insert({
    pipeline:      KILLED_PIPELINE,
    status:        "failed",
    started_at:    orphan.started_at ?? now,
    completed_at:  now,
    error_message: "workflow-timeout-or-sigterm",
    metadata: {
      source_pipeline: pipeline,
      phase:           phase ?? orphan.metadata?.phase ?? null,
      orphan_row_id:   orphan.id,
      window_hours:    windowHours,
      peak_rss_mb:     captureRssMb(),
    },
  });

  if (insErr) {
    console.warn(`[mark-killed] insert failed (non-fatal): ${insErr.message}`);
    return;
  }
  console.log(
    `[mark-killed] wrote '${KILLED_PIPELINE}' row for orphan ${pipeline} run (id=${orphan.id}, started_at=${orphan.started_at})`,
  );
}

// FIX-462: only run when invoked as a script, not when imported by the unit
// test (mirrors the require.main guard in pipelines/index.ts). Importing this
// module to test selectKillTarget must not trigger the DB query or exit.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // Best-effort: never block CI on this observability step.
      console.warn("[mark-killed] unexpected error (non-fatal):", err instanceof Error ? err.message : err);
      process.exit(0);
    });
}
