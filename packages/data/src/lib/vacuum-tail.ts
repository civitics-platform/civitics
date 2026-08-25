/**
 * FIX-975 — vacuum ownership for the tables the heavy rebuilds mass-UPDATE.
 *
 * THE CONSTRAINT THAT SHAPES THIS MODULE. `VACUUM` cannot run inside a function
 * or a transaction block. The 13 live plpgsql functions that mass-UPDATE
 * `public.financial_entities` therefore *structurally cannot* own their own
 * vacuum tails — the FIX-943 standing rule ("any script that bulk-rewrites a
 * table ends by vacuuming what it rewrote") has to be discharged one layer up,
 * at the TypeScript driver that invokes them over a direct pg connection.
 * This module is that layer.
 *
 * WHY IT MATTERS MORE THAN THE DEAD-TUPLE COUNT SUGGESTS (playbook B1/B2). A
 * heap page loses its all-visible mark if ANY tuple on it is dead, so a
 * few-percent dead ratio can un-mark most of the heap and silently degrade
 * every index-only scan into a per-row heap fetch. The 2026-08-07 efficiency
 * audit measured exactly that on the covering index that exists specifically to
 * enable index-only scans, `financial_entities_nonindividual_id`:
 *
 *     Heap Fetches: 108419 / 226640 rows (47.8%)   Execution Time: 47,042 ms
 *
 * against 4.8% on `financial_relationships`, which has had a vacuum owner since
 * FIX-974. A 10x spread tracking vacuum ownership exactly. `financial_entities`
 * had `vacuum_count = 0` — no script, cron job or procedure had ever vacuumed
 * it — while `financial_entities_pkey` is the most-scanned index on the
 * instance (84,990,056 scans), so every donor rollup, graph query, tagger pass
 * and treemap build pays the heap-fetch tax.
 *
 * AUTOVACUUM IS NOT THE OWNER. Autovacuum does eventually fire — it did at
 * 2026-08-07 05:12 UTC, ~24 minutes after the audit's last reading, taking FE
 * back from 53.7% to 85.7% all-visible. That is precisely the point: the
 * trigger is `threshold + scale_factor x reltuples`, so the table is always
 * permitted a floor of dead tuples (~182k on FE today) before anything happens,
 * and a bulk rewrite lands its whole dead-tuple load inside that floor at once.
 * Ownership does not change FE's floor; it removes the window between the write
 * and the recovery, which is where readers actually live. Autovacuum tuning
 * narrows the window, it does not close it (FIX-943).
 *
 * Never `VACUUM FULL` — it takes ACCESS EXCLUSIVE and rewrites the whole heap.
 */

import type { Client } from "pg";

/**
 * Which tables each allow-listed heavy writer bulk-rewrites.
 *
 * Keyed by the exact function/procedure name passed to `runHeavyRebuild()` /
 * `callHeavyProcedure()`, so the tail is impossible to forget at a call site:
 * every caller of the hub inherits ownership for free. A writer absent from
 * this map runs with no tail, which is the correct default — most of the
 * allow-list rewrites `entity_tags`, which is DELETE-dominated and clears its
 * autovacuum trigger constantly (the one clean exception the audit found).
 *
 * Derived from prod `pg_proc`: the functions whose bodies contain a mass
 * `UPDATE public.financial_entities`.
 */
export const REWRITE_TARGETS: Readonly<Record<string, readonly string[]>> = {
  // FIX-586 — full-table UPDATE of total_donated_cents over ~2M FR donation rows.
  rebuild_financial_entity_donation_totals: ["public.financial_entities"],
  // FIX-666 — Schedule E independent-expenditure totals pivot.
  rebuild_financial_entity_ie_totals: ["public.financial_entities"],
  // FIX-675 — the to_id mirror: total_received_cents.
  rebuild_financial_entity_received_totals: ["public.financial_entities"],
  // FIX-651 — set-based UPDATE of contract+grant spending totals.
  refresh_spending_totals: ["public.financial_entities"],
};

/** Tables with no TypeScript driver on any write path — backstop-only.
 *  `reconcile_financial_entity_totals` (pg_cron jobid 14) and
 *  `refresh_financial_entity_totals_incremental` (jobid 13) are CALLed directly
 *  by pg_cron, so their tails live in the `derived-table-vacuum-analyze` job.
 *  Listed here so the split is documented in code, not just in the FIX. */
export const BACKSTOP_ONLY_WRITERS = [
  "reconcile_financial_entity_totals",
  "refresh_financial_entity_totals_incremental",
] as const;

/**
 * Issue `VACUUM (ANALYZE)` for every table the named writer rewrote.
 *
 * Runs on the caller's already-open connection, AFTER the rewrite has
 * committed (VACUUM cannot run in a transaction). No-op when the writer has no
 * mapped targets.
 *
 * FAILURE POLICY: a failed vacuum is logged loudly and does NOT throw. The
 * rewrite itself already succeeded and its row count is the caller's return
 * value — failing the pipeline here would turn a degraded visibility map into a
 * lost data refresh, which is strictly worse. The scheduled
 * `derived-table-vacuum-analyze` backstop is what makes that safe: a missed
 * tail is recovered on the next run rather than being silently permanent.
 */
export async function vacuumRewritten(
  client: Client,
  writer: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const targets = REWRITE_TARGETS[writer];
  if (!targets || targets.length === 0) return;
  await vacuumTables(client, targets, `after ${writer}`, log);
}

/**
 * `VACUUM (ANALYZE)` an explicit table list on an already-open connection.
 *
 * The same body `vacuumRewritten()` uses, exposed for the callers whose trigger
 * is not "a named writer just returned" — notably FIX-1100's compensating tail,
 * where the writer that owed the vacuum was SIGTERM'd by the GHA job timeout
 * and never reached its own tail at all. `reason` is free text for the log line
 * so a scan of a run log says WHY the vacuum happened.
 *
 * Failure policy is identical and deliberate: log loudly, never throw. A vacuum
 * is a repair, and failing the caller because a repair failed converts degraded
 * visibility into lost work.
 */
export async function vacuumTables(
  client: Client,
  tables: readonly string[],
  reason: string,
  log: (msg: string) => void = console.log,
): Promise<void> {
  for (const table of tables) {
    const t0 = Date.now();
    try {
      // Autocommit — node-postgres issues simple queries outside an explicit
      // transaction, which is the only reason this is legal at all.
      await client.query(`VACUUM (ANALYZE) ${table}`);
      log(`[vacuum-tail] ${table} — ${((Date.now() - t0) / 1000).toFixed(1)}s (${reason}, FIX-943 rule)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Greppable and unmissable: the backstop cron will catch it, but a tail
      // that fails every run is a real regression and must not read as silence.
      console.error(
        `[vacuum-tail] FAILED ${table} ${reason}: ${msg} — ` +
          `visibility map left to autovacuum + the derived-table-vacuum-analyze backstop`,
      );
    }
  }
}

/**
 * FIX-1100 — the compensating vacuum for a bulk writer that was KILLED before
 * its own FIX-943 tail could run.
 *
 * WHY THIS EXISTS. `fec_bulk`'s indiv stage bulk-rewrites
 * `financial_relationships` and `financial_entities` and owns a vacuum tail for
 * them. On 2026-08-24 the nightly's fec job hit `timeout-minutes: 150` partway
 * through the committee route — 780,150 of 998,823 records in — and SIGTERM
 * skipped the tail entirely. `financial_relationships` was measured at 80.66%
 * all-visible the next day with no `last_vacuum` recorded.
 *
 * A heap page loses its all-visible mark if ANY tuple on it is dead, so a
 * partial bulk rewrite un-marks far more of the heap than its dead-tuple ratio
 * suggests, and every index-only scan over the table silently degrades to a
 * per-row heap fetch until something vacuums. That is FIX-884 and FIX-943.
 *
 * WHERE IT FIRES, AND WHY NOT THE OBVIOUS PLACE. The obvious home is the killed
 * job's own `if: always()` post-step — but that step runs inside the SIGTERM
 * that just killed the job, on a runner being torn down, which is playbook C3:
 * a guard placed where it cannot fire. The reliable trigger is the NEXT run
 * finding `fec_bulk_run_state` present, which is exactly the FIX-754 resume
 * signal and is durable in the DB. So the tail is paid by the resume, before it
 * adds its own writes on top of the mess.
 *
 * Cost is real — minutes on prod for `financial_relationships` — which is part
 * of why FIX-1100 also raises the job budget. Never `VACUUM FULL`.
 */
export const KILLED_FEC_WRITER_TABLES = [
  "public.financial_relationships",
  "public.financial_entities",
] as const;

