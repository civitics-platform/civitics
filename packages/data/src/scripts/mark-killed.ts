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
 *   2. AND THIS JOB'S OWN run did not reach a terminal status ('complete',
 *      'partial','failed','skipped') — proves the run did not finish naturally.
 *
 * FIX-963 — (2) used to read "AND no `<pipeline>` row finished anywhere in the
 * window", which is a different and wrong question. Measured 2026-08-05: the
 * 01:03 UTC fec-backfill dispatch OOM'd at 01:17, and its mark-killed step
 * no-op'd because the PREVIOUS dispatch's 22:43 success was still inside the
 * (FIX-962-widened) 7h window. Any success-then-crash sequence inside one
 * window stranded the crashed row at status='running'. Widening or narrowing
 * the window cannot fix this — it has already failed twice (FIX-962, FIX-963)
 * — because the window is not the predicate that is wrong. The guard is now
 * bound to the job's own run:
 *
 *   - preferred: the row's `metadata.github_run_id` (FIX-971a, written by
 *     startSync() and by the nightly's own start-row) equals this job's
 *     GITHUB_RUN_ID, with GITHUB_RUN_ATTEMPT tie-breaking a re-run;
 *   - fallback for pre-971a rows that carry no run id: the row's `started_at`
 *     is at or after this job's start (`--job-started-at` /
 *     MARK_KILLED_JOB_STARTED_AT, set by a first step in each workflow job);
 *   - with neither available (a local `pnpm data:mark-killed`), the legacy
 *     any-terminal-row-in-window behavior is kept, unchanged.
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
 *   pnpm data:mark-killed -- --job-started-at 2026-08-05T01:03:00Z
 */

import { createAdminClient } from "@civitics/db";
import { captureRssMb, githubRunIdentity } from "../pipelines/sync-log";
import { constructDbUrlFromEnv } from "./fec-orphan-classify";

const KILLED_PIPELINE = "nightly_killed";

/**
 * FIX-1065 — the two data_sync_log operations mark-killed needs, over whichever
 * route is actually available.
 *
 * `direct` is preferred: pg.Client speaks to Postgres itself and needs no
 * schema cache, so it keeps working in the exact condition this backstop exists
 * for — a box too loaded for PostgREST to answer. `postgrest` is the fallback
 * for environments with no direct URL (no SUPABASE_DB_URL and no
 * SUPABASE_DB_PASSWORD to build a pooler URL from).
 *
 * Nothing here throws on connect: a failed direct connect falls back rather
 * than taking down a step whose entire contract is "observability, never a
 * gate, always exit 0".
 */
interface KillDb {
  route: "direct" | "postgrest";
  selectRecent(pipeline: string, since: string): Promise<SyncRow[]>;
  insertKilled(row: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function openDb(): Promise<KillDb> {
  const url = constructDbUrlFromEnv();
  if (url) {
    try {
      const { Client } = await import("pg");
      // Short connect/statement bounds: this runs as a post-timeout backstop
      // step, so it must fail over fast rather than hang the job.
      const client = new Client({ connectionString: url, statement_timeout: 30_000 });
      await client.connect();
      return {
        route: "direct",
        async selectRecent(pipeline, since) {
          const res = await client.query<SyncRow>(
            `SELECT id, status, started_at, completed_at, metadata
               FROM public.data_sync_log
              WHERE pipeline = $1 AND started_at >= $2
              ORDER BY started_at DESC
              LIMIT 50`,
            [pipeline, since],
          );
          return res.rows;
        },
        async insertKilled(row) {
          await client.query(
            `INSERT INTO public.data_sync_log
               (pipeline, status, started_at, completed_at, error_message, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              row["pipeline"], row["status"], row["started_at"],
              row["completed_at"], row["error_message"], JSON.stringify(row["metadata"]),
            ],
          );
        },
        async close() {
          await client.end().catch(() => {});
        },
      };
    } catch (err) {
      console.warn(
        `[mark-killed] direct pg connect failed (${(err as Error).message}) — falling back to PostgREST`,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  return {
    route: "postgrest",
    async selectRecent(pipeline, since) {
      const { data, error } = await db
        .from("data_sync_log")
        .select("id, status, started_at, completed_at, metadata")
        .eq("pipeline", pipeline)
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as SyncRow[];
    },
    async insertKilled(row) {
      const { error } = await db.from("data_sync_log").insert(row);
      if (error) throw new Error(error.message);
    },
    async close() {},
  };
}

export interface OwnRun {
  /** GITHUB_RUN_ID for this job's workflow run. */
  runId?: string;
  /** GITHUB_RUN_ATTEMPT — distinguishes a re-run of the same run id. */
  runAttempt?: string;
  /** ISO timestamp of this GHA job's start (`--job-started-at`). */
  jobStartedAt?: string;
}

interface ParsedArgs {
  pipeline: string;
  windowHours: number;
  phase?: string;
  jobStartedAt?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let pipeline = "nightly_cron";
  let windowHours = 4;
  let phase: string | undefined;
  let jobStartedAt: string | undefined;
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
    } else if (a.startsWith("--job-started-at=")) {
      jobStartedAt = a.slice("--job-started-at=".length);
    } else if (a === "--job-started-at" && argv[i + 1]) {
      jobStartedAt = argv[i + 1];
      i++;
    }
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 4;
  return { pipeline, windowHours, phase, jobStartedAt };
}

/** Reject a garbage `--job-started-at` rather than silently binding to NaN. */
export function normalizeJobStartedAt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

interface SyncRow {
  id: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  metadata?: {
    phase?: string;
    github_run_id?: string;
    github_run_attempt?: string;
  } | null;
}

const TERMINAL_STATUSES = ["complete", "partial", "failed", "skipped"];

/** How a row relates to the run that is asking. */
export type OwnRunMatch = "own" | "foreign" | "unknown";

/** Which evidence the binding used — recorded on the marker for later audits. */
export type BindingSource = "run-id" | "job-start" | "none";

export function bindingSource(ownRun?: OwnRun): BindingSource {
  if (ownRun?.runId) return "run-id";
  if (ownRun?.jobStartedAt) return "job-start";
  return "none";
}

/**
 * FIX-963 — is this row the asking job's own run?
 *
 * `unknown` is deliberately distinct from `foreign`: it means the row predates
 * FIX-971a (no run id) and no job-start clock was supplied, so nothing can be
 * proven either way. Callers treat `unknown` as "not mine" only when some
 * binding evidence exists; with no evidence at all the legacy behavior stands.
 */
export function matchOwnRun(row: SyncRow, ownRun?: OwnRun): OwnRunMatch {
  const rowRunId = row.metadata?.github_run_id;
  if (ownRun?.runId && rowRunId) {
    if (rowRunId !== ownRun.runId) return "foreign";
    const rowAttempt = row.metadata?.github_run_attempt;
    // A re-run of the same run id is a different job with a different budget.
    if (ownRun.runAttempt && rowAttempt && rowAttempt !== ownRun.runAttempt) return "foreign";
    return "own";
  }
  if (ownRun?.jobStartedAt && row.started_at) {
    const rowT = Date.parse(row.started_at);
    const jobT = Date.parse(ownRun.jobStartedAt);
    if (!Number.isFinite(rowT) || !Number.isFinite(jobT)) return "unknown";
    return rowT >= jobT ? "own" : "foreign";
  }
  return "unknown";
}

export interface KillTarget {
  finished?: SyncRow;
  orphan?: SyncRow;
  /** True when the chosen orphan was positively bound to this job's own run. */
  orphanIsOwnRun?: boolean;
  /** Terminal same-phase rows that belong to some OTHER run (FIX-963 evidence). */
  foreignFinished: SyncRow[];
  binding: BindingSource;
}

/**
 * FIX-462: pure kill-target selection so it can be unit-tested without a live
 * DB. When `phase` is given, only rows whose `metadata.phase` matches are
 * considered — once enrichment-phase is decoupled from fec-phase
 * (.github/workflows/nightly.yml), both phases write nightly_cron rows for the
 * same date, so an unscoped scan would see enrichment's terminal row and
 * wrongly conclude a timed-out fec-phase had finished.
 *
 * FIX-963: phase scoping was necessary but not sufficient — two runs of the
 * SAME phase inside one window still confused each other. The terminal row now
 * has to be THIS run's terminal row to count as "finished".
 *
 * Returns `{ finished }` if this job's own run reached a terminal status
 * (no-op), else `{ orphan }` if a same-phase `running` row was orphaned (write
 * a marker), else neither (nothing ran).
 */
export function selectKillTarget(
  rows: SyncRow[],
  phase?: string,
  ownRun?: OwnRun,
): KillTarget {
  const binding = bindingSource(ownRun);
  const scoped = phase
    ? rows.filter((r) => (r.metadata?.phase ?? undefined) === phase)
    : rows;

  const terminal = scoped.filter((r) => TERMINAL_STATUSES.includes((r.status ?? "").toString()));

  if (binding === "none") {
    // No evidence to bind with (local/manual invocation). Legacy behavior.
    const finished = terminal[0];
    if (finished) return { finished, foreignFinished: [], binding };
    const orphan = scoped.find((r) => r.status === "running");
    return orphan
      ? { orphan, orphanIsOwnRun: false, foreignFinished: [], binding }
      : { foreignFinished: [], binding };
  }

  const own = terminal.find((r) => matchOwnRun(r, ownRun) === "own");
  const foreignFinished = terminal.filter((r) => matchOwnRun(r, ownRun) !== "own");
  if (own) return { finished: own, foreignFinished, binding };

  // Prefer a `running` row positively bound to this run; fall back to the
  // newest one (rows arrive started_at DESC) so a pre-971a orphan is still
  // reaped rather than left stranded.
  const running = scoped.filter((r) => r.status === "running");
  const ownRunning = running.find((r) => matchOwnRun(r, ownRun) === "own");
  const orphan = ownRunning ?? running[0];
  return orphan
    ? { orphan, orphanIsOwnRun: Boolean(ownRunning), foreignFinished, binding }
    : { foreignFinished, binding };
}

async function main(): Promise<void> {
  const { pipeline, windowHours, phase, jobStartedAt } = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const phaseLabel = phase ? `${pipeline} phase=${phase}` : pipeline;

  const ownRun: OwnRun = {
    runId: process.env["GITHUB_RUN_ID"] || undefined,
    runAttempt: process.env["GITHUB_RUN_ATTEMPT"] || undefined,
    jobStartedAt:
      normalizeJobStartedAt(jobStartedAt) ??
      normalizeJobStartedAt(process.env["MARK_KILLED_JOB_STARTED_AT"]),
  };
  if (jobStartedAt && !normalizeJobStartedAt(jobStartedAt)) {
    console.warn(`[mark-killed] ignoring unparseable --job-started-at '${jobStartedAt}'`);
  }

  // FIX-1065 — direct pg.Client FIRST, PostgREST only as fallback.
  //
  // This backstop exists for the case "the run was killed", and a run is most
  // likely to be killed precisely when the database is overloaded — which is
  // precisely when PostgREST is least likely to be answering. Measured
  // 2026-08-18: fec-backfill run 32097136492 was SIGTERMd at its 350-minute cap,
  // and mark-killed then failed with "Could not query the database for the
  // schema cache" because PostgREST was returning 503 PGRST002 (FIX-1063). The
  // marker was only written after the project restart. Routing the backstop
  // through the component most likely to be down in the situation it exists for
  // is a structural coupling, not bad luck.
  //
  // pg.Client needs no schema cache, so it survives exactly that condition.
  // FIX-444 set the precedent for going direct when PostgREST is unsuitable.
  const conn = await openDb();
  console.log(`[mark-killed] db route: ${conn.route}`);

  let rows: SyncRow[];
  try {
    rows = await conn.selectRecent(pipeline, since);
  } catch (err) {
    console.warn(`[mark-killed] data_sync_log query failed: ${(err as Error).message}`);
    // Observability, not a gate — always exit 0.
    await conn.close();
    return;
  }

  const { finished, orphan, orphanIsOwnRun, foreignFinished, binding } = selectKillTarget(
    rows,
    phase,
    ownRun,
  );
  console.log(
    `[mark-killed] ${phaseLabel} — ${rows.length} row(s) in last ${windowHours}h; ` +
      `own-run binding: ${binding}` +
      (binding === "run-id" ? ` (GITHUB_RUN_ID=${ownRun.runId} attempt=${ownRun.runAttempt ?? "?"})` : "") +
      (binding === "job-start" ? ` (job started ${ownRun.jobStartedAt})` : ""),
  );
  if (finished) {
    console.log(
      `[mark-killed] ${phaseLabel} own run finished (status=${finished.status}, id=${finished.id}) — no-op`,
    );
    await conn.close();
    return;
  }
  // FIX-963: this is the line that used to be a no-op. Terminal rows from an
  // EARLIER run in the same window no longer suppress the marker.
  if (foreignFinished.length > 0) {
    console.log(
      `[mark-killed] ${foreignFinished.length} terminal ${phaseLabel} row(s) in window belong to other run(s) ` +
        `(${foreignFinished.map((r) => `${r.id}:${r.status}`).join(", ")}) — NOT treated as this run finishing (FIX-963)`,
    );
  }
  if (!orphan) {
    console.log(
      `[mark-killed] no '${phaseLabel}' running row in last ${windowHours}h — no-op (workflow may not have started)`,
    );
    await conn.close();
    return;
  }

  const now = new Date().toISOString();
  const killedRow = {
    pipeline:      KILLED_PIPELINE,
    status:        "failed",
    started_at:    orphan.started_at ?? now,
    // FIX-971b: NO completed_at. Nothing observed the orphaned run stop, so any
    // value here would be the time the REAPER ran, and `started_at`..that gap
    // renders as a runtime on /admin/pipeline-health and in
    // pipeline_runtime_stats_mv (whose WHERE clause now skips this row
    // entirely). This is the same correction FIX-944 made to
    // reap_stale_sync_log(); mark-killed was the other writer and was missed.
    // The reap time lives in metadata, where it cannot be mistaken for a span.
    completed_at:  null,
    error_message: "workflow-timeout-or-sigterm",
    metadata: {
      source_pipeline: pipeline,
      phase:           phase ?? orphan.metadata?.phase ?? null,
      orphan_row_id:   orphan.id,
      window_hours:    windowHours,
      reaped:          true,
      reaped_at:       now,
      reap_note:
        "started_at is the ORPHANED run's start. There is no completed_at because nothing " +
        "observed the stop; reaped_at bounds REAPER LATENCY, not runtime. Authoritative end: " +
        "the GHA API for workflow runs (join on metadata.github_run_id, FIX-971a), " +
        "cron.job_run_details for pg_cron work.",
      orphan_own_run:  orphanIsOwnRun ?? false,
      own_run_binding: binding,
      ...githubRunIdentity(),
      peak_rss_mb:     captureRssMb(),
    },
  };

  try {
    await conn.insertKilled(killedRow);
  } catch (err) {
    console.warn(`[mark-killed] insert failed (non-fatal): ${(err as Error).message}`);
    await conn.close();
    return;
  }
  await conn.close();
  console.log(
    `[mark-killed] wrote '${KILLED_PIPELINE}' row for orphan ${pipeline} run ` +
      `(id=${orphan.id}, started_at=${orphan.started_at}, own_run=${orphanIsOwnRun ?? false}, completed_at=NULL)`,
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
