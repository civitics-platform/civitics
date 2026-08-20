/**
 * FIX-1067 — cross-workflow serialization for `runFecBulkPipeline()`.
 *
 * OBSERVED 2026-08-19: the `fec-backfill` resume (run 32200957208, cycles=2020)
 * was writing 00:22 → 03:15:31 while the nightly-sync `fec-phase` (run
 * 32210358973) opened its OWN `fec_bulk` sync row at 03:02:27 — a 13-minute
 * overlap of two `runFecBulkPipeline()` invocations against the same prod
 * tables. The two workflows declare DIFFERENT GitHub Actions concurrency groups
 * (`nightly-sync` vs `fec-backfill`), so each is serialized only against itself.
 *
 * The writes are ON CONFLICT upserts, so the observed cost was wasted IO. The
 * sharp edge is elsewhere: both runs share ONE `pipeline_state` key,
 * `fec_bulk_run_state`, which holds the FIX-754 per-stage resume cursor. That is
 * NOT idempotent state — immediately after the backfill had completed all three
 * stages the key was back at `indiv-to-committee cursor=1060000 in-progress`,
 * because the nightly had re-established state for the same cycle. A crash
 * during an overlap can strand a cursor neither run owns.
 *
 * ── Why a DB advisory lock and NOT a shared GHA concurrency group ────────────
 * The bullet offered both. Only the lock is taken, deliberately:
 *
 *   - The lock covers ANY caller — a third workflow, a local `pnpm data:fec-bulk`
 *     against prod, a future cron. A concurrency group covers exactly the two
 *     workflow files that opt into it.
 *   - GHA job-level concurrency with `cancel-in-progress: false` QUEUES the
 *     second job. `nightly.yml` chains `enrichment-*-phase` off `needs:
 *     fec-phase`, so a queued fec-phase stalls the ENTIRE nightly behind a
 *     backfill that can legitimately run for three hours — and GHA keeps only
 *     one pending job per group, cancelling any others. That is a worse failure
 *     than the overlap it prevents.
 *   - With the lock, the losing run exits in seconds and its workflow carries
 *     on. The nightly's other phases are unaffected.
 *
 * So the concurrency group is NOT added; see the note in `.github/workflows/`.
 *
 * ── Semantics ────────────────────────────────────────────────────────────────
 * SESSION-level `pg_try_advisory_lock` on a dedicated connection held for the
 * pipeline's lifetime (the `reference_pgcron_procedure_pattern` precedent, and
 * the same shape `donor-rollup-bulk` / `treemap-global-sweep` use). Session
 * scope is the point: if the holder's process dies, its backend goes away and
 * the lock is released by Postgres — there is no stranded-lock failure mode and
 * no TTL to tune.
 *
 * TRY, never wait. A blocked FEC run would sit burning its GHA budget for hours
 * to then start a 2.5h write phase against a box already saturated by the run it
 * waited for. Exiting cleanly is correct: the FIX-193 watermark is untouched, so
 * the next nightly picks the drop up.
 *
 * FAIL OPEN on an infrastructure error (cannot connect, query throws). The lock
 * is a safety interlock, not a correctness gate — a pipeline that cannot reach
 * the DB cannot write anyway, and refusing to run on a transient lock-connection
 * blip would convert a nuisance into a missed weekly ingest. Logged loudly.
 */

import type { Client } from "pg";
import { buildDbUrl } from "../../lib/heavy-rebuild";

/**
 * Advisory-lock namespace. `hashtext()` is evaluated by Postgres so the value is
 * identical for every caller and every environment without a magic number
 * needing to be kept in sync by hand.
 */
export const FEC_PIPELINE_LOCK_NAME = "fec_bulk_pipeline";

/** Env escape hatch. `FEC_PIPELINE_LOCK=off` skips the interlock entirely —
 *  for tests and for the deliberate "I know the other run is dead" case. */
export function pipelineLockDisabled(
  raw: string | undefined = process.env.FEC_PIPELINE_LOCK,
): boolean {
  return (raw ?? "").trim().toLowerCase() === "off";
}

export interface FecPipelineLock {
  /** True when this process owns the interlock (or it was bypassed/failed open). */
  readonly acquired: boolean;
  /** Why the lock was not acquired — set only when `acquired` is false. */
  readonly blockedBy?: string;
  /** Release the lock and close its connection. Safe to call twice. */
  release(): Promise<void>;
}

const NOOP_LOCK: FecPipelineLock = { acquired: true, async release() { /* nothing held */ } };

/**
 * Try to take the FEC-pipeline interlock.
 *
 * Returns `{ acquired: true }` when this process may proceed (lock held,
 * bypassed via `FEC_PIPELINE_LOCK=off`, or failed open on an infra error), and
 * `{ acquired: false, blockedBy }` when another `runFecBulkPipeline()` is live.
 *
 * The caller MUST `release()` in a `finally`.
 */
export async function acquireFecPipelineLock(): Promise<FecPipelineLock> {
  if (pipelineLockDisabled()) {
    console.warn(
      "  [fec-lock] FEC_PIPELINE_LOCK=off — cross-run interlock BYPASSED (FIX-1067)",
    );
    return NOOP_LOCK;
  }

  let client: Client;
  try {
    const { Client: PgClient } = await import("pg");
    client = new PgClient({ connectionString: buildDbUrl() });
    await client.connect();
  } catch (err) {
    console.warn(
      `  [fec-lock] could not open the interlock connection (${errText(err)}) — ` +
        "FAILING OPEN, the pipeline will run unserialized (FIX-1067)",
    );
    return NOOP_LOCK;
  }

  try {
    // Keep the lock probe itself from ever inheriting a long ceiling.
    await client.query("SET statement_timeout = '30s'");
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [FEC_PIPELINE_LOCK_NAME],
    );
    if (res.rows[0]?.locked) {
      console.log(`  [fec-lock] interlock acquired (${FEC_PIPELINE_LOCK_NAME}) (FIX-1067)`);
      return makeHeldLock(client);
    }

    const holder = await describeHolder(client);
    await client.end().catch(() => { /* best effort */ });
    return {
      acquired: false,
      blockedBy: holder,
      async release() { /* nothing held */ },
    };
  } catch (err) {
    await client.end().catch(() => { /* best effort */ });
    console.warn(
      `  [fec-lock] interlock probe failed (${errText(err)}) — FAILING OPEN (FIX-1067)`,
    );
    return NOOP_LOCK;
  }
}

function makeHeldLock(client: Client): FecPipelineLock {
  let released = false;
  return {
    acquired: true,
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [
          FEC_PIPELINE_LOCK_NAME,
        ]);
      } catch { /* the session ending releases it anyway */ }
      try { await client.end(); } catch { /* best effort */ }
      console.log(`  [fec-lock] interlock released (${FEC_PIPELINE_LOCK_NAME}) (FIX-1067)`);
    },
  };
}

/**
 * Best-effort description of the run holding the lock, for the refusal log.
 *
 * Reads `data_sync_log` rather than `pg_locks`: the sync row names the run in
 * terms an operator can act on (when it started, how long it has been going),
 * whereas reconstructing the advisory key's (classid, objid) pair from a signed
 * `hashtext()` is fiddly and tells you only a pid. Advisory — any failure here
 * degrades the message, never the decision.
 */
async function describeHolder(client: Client): Promise<string> {
  try {
    const res = await client.query<{ started_at: Date; age: string }>(
      `SELECT started_at, age(now(), started_at)::text AS age
         FROM public.data_sync_log
        WHERE pipeline = 'fec_bulk'
          AND status   = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return "another runFecBulkPipeline() invocation (no open fec_bulk sync row)";
    return `fec_bulk run started ${row.started_at.toISOString()} (${row.age} ago)`;
  } catch {
    return "another runFecBulkPipeline() invocation";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
