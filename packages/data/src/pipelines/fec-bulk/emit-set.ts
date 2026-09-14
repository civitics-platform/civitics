/**
 * FIX-1106 — the emit set: what the FEC donation writers actually emitted.
 *
 * An upsert-only replay cannot shrink a set. When a run stops emitting to a
 * recipient it emitted to last week, the recipient's prior rows stand forever
 * and every surface that sums the slice double-counts them. Measured on prod
 * 2026-08-25: 3,416 cycle-2026 recipients, 209,017 rows, $1,481,928,516.
 *
 * The only exact answer to "did this run emit to X" is a record the writer
 * wrote at emit time, which is what this module is. The two instruments that
 * were available before are both partial, and both for structural reasons:
 * `updated_at` cannot see a FIX-1008 skipped re-upsert, and bracket-row
 * membership carries a measured ~2% false-positive rate.
 *
 * RUN IDENTITY IS NOT NEW. run-state.ts already defines it: "(cycle, FEC indiv
 * Last-Modified)", and a new FEC drop discards the resume state. So the run id
 * here is DERIVED from that same pair rather than minted per process. Three
 * consequences fall out for free, none of which needed a schema column:
 *   * a resumed run continues the same run's set, because the pair is unchanged;
 *   * a new FEC drop starts a fresh set, because the pair moved — exactly when
 *     the resume state is discarded, and for the same reason;
 *   * nothing has to be persisted or handed between processes.
 */

import { createHash } from "node:crypto";
import type { Client } from "pg";

/** The three donation sources the pipeline writers emit under. */
export type EmitSource = "fec_bulk_pac" | "fec_bulk_indiv" | "fec_bulk_indiv_to_committee";

/**
 * Deterministic run id for (cycle, FEC Last-Modified).
 *
 * A v5-shaped UUID over a namespaced digest. Deterministic is the requirement,
 * not cryptographic strength: two processes resuming the same run must compute
 * the same id without consulting each other.
 */
export function emitRunId(cycleYear: number, lastModified: string | null): string {
  const h = createHash("sha1")
    .update(`fix1106-fec-emit:${cycleYear}:${lastModified ?? "unknown"}`)
    .digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + h.slice(18, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * Where a batch's emitted keys go.
 *
 * `record` is called by the writer with the rows it just upserted, on the SAME
 * client and inside the same batch loop — one extra statement per batch, never
 * a per-row round trip and never a second pass over the file. Column indices
 * are resolved once by the caller so the hot path is an array read.
 */
export interface EmitSink {
  readonly runId: string;
  readonly cycleYear: number;
  readonly source: EmitSource;
  /** Rows appended so far. The ledger's `keys` at completion. */
  readonly count: number;
  begin(client: Client): Promise<void>;
  record(client: Client, keys: readonly EmitKey[]): Promise<void>;
}

export interface EmitKey {
  relationshipType: string;
  toType: string;
  toId: string;
  fromId: string;
}

/**
 * Open a sink for one (run, cycle, source).
 *
 * `begin` TRUNCATEs this slice's prior keys and (re)opens its ledger row with
 * complete_at NULL. It runs at STAGE START, so a resumed run re-emits its whole
 * cycle into a clean set rather than appending to a prefix — which is correct
 * because the upserts are idempotent and re-streaming is deterministic (the
 * same property FIX-754's cursor reset already relies on).
 */
export function createEmitSink(opts: {
  runId: string;
  cycleYear: number;
  source: EmitSource;
}): EmitSink {
  let count = 0;
  return {
    runId: opts.runId,
    cycleYear: opts.cycleYear,
    source: opts.source,
    get count() {
      return count;
    },
    async begin(client: Client): Promise<void> {
      count = 0;
      // FIX-1184 — supersede any OLDER never-completed run for this slice, and
      // take its keys with it.
      //
      // The pas2 arm opens a row per (cycle, source) on every fec phase and only
      // ever gets stamped for the ONE cycle FIX-754's clear names, so a run row
      // with complete_at NULL accumulates per nightly per un-stamped cycle. Guard
      // 1 takes the NEWEST row for a slice, so one orphan makes the whole slice
      // unauditable — which is what (2024, fec_bulk_pac) is today.
      //
      // The count is written to `keys` BEFORE the delete and from the same
      // snapshot, so a superseded row still says how much it had emitted. That
      // distinction is the whole safety of the new guard: keys = 0 is "nothing
      // was written, skip me", keys > 0 is "a PREFIX was written after the last
      // complete set, refuse". The keys themselves go because they are
      // scaffolding and nothing may anti-join against a prefix.
      //
      // `run_id <> $1` is what leaves a RESUMED run alone: a resume recomputes
      // the same deterministic id from (cycle, FEC Last-Modified), so it
      // supersedes nothing of its own.
      await client.query(
        `WITH superseded AS (
           UPDATE public.fec_emit_runs r
              SET superseded_at = now(),
                  superseded_by = $1,
                  keys = (SELECT count(*) FROM public.fec_emit_keys k
                           WHERE k.run_id     = r.run_id
                             AND k.cycle_year = r.cycle_year
                             AND k.source     = r.source)
            WHERE r.cycle_year    = $2
              AND r.source        = $3
              AND r.run_id       <> $1
              AND r.complete_at   IS NULL
              AND r.superseded_at IS NULL
            RETURNING r.run_id
         )
         DELETE FROM public.fec_emit_keys k
          USING superseded s
          WHERE k.run_id = s.run_id AND k.cycle_year = $2 AND k.source = $3`,
        [opts.runId, opts.cycleYear, opts.source],
      );
      await client.query(
        `DELETE FROM public.fec_emit_keys
          WHERE run_id = $1 AND cycle_year = $2 AND source = $3`,
        [opts.runId, opts.cycleYear, opts.source],
      );
      await client.query(
        `INSERT INTO public.fec_emit_runs (run_id, cycle_year, source, started_at, complete_at, keys)
         VALUES ($1, $2, $3, now(), NULL, 0)
         ON CONFLICT (run_id, cycle_year, source)
         DO UPDATE SET started_at = now(), complete_at = NULL, keys = 0,
                       -- FIX-1184: reopening a row un-supersedes it. Reachable
                       -- when a run was superseded by a different run and then
                       -- resumed; this set is being re-emitted from scratch, so
                       -- the supersession no longer describes it.
                       superseded_at = NULL, superseded_by = NULL`,
        [opts.runId, opts.cycleYear, opts.source],
      );
    },
    async record(client: Client, keys: readonly EmitKey[]): Promise<void> {
      if (keys.length === 0) return;
      // One statement per batch. unnest() of four parallel arrays is the same
      // shape bulkUpsert uses and costs one round trip regardless of batch size.
      await client.query(
        `INSERT INTO public.fec_emit_keys
           (run_id, cycle_year, source, relationship_type, to_type, to_id, from_id)
         SELECT $1, $2, $3, t.rt::public.financial_relationship_type, t.tt, t.ti, t.fi
           FROM unnest($4::text[], $5::text[], $6::uuid[], $7::uuid[]) AS t(rt, tt, ti, fi)`,
        [
          opts.runId,
          opts.cycleYear,
          opts.source,
          keys.map((k) => k.relationshipType),
          keys.map((k) => k.toType),
          keys.map((k) => k.toId),
          keys.map((k) => k.fromId),
        ],
      );
      count += keys.length;
    },
  };
}

/**
 * Stamp a cycle's emit sets complete.
 *
 * CALLED FROM EXACTLY TWO PLACES, and the second one (FIX-1184) is sound for a
 * reason the first does not need.
 *
 *   1. Beside FIX-754's clearRunState(), on the path that already means "cycle
 *      complete". This is the INDIV arms' only stamp. Not from the end of a
 *      stage, not from a finally block, not from the pipeline's exit handler:
 *      any of those would stamp a killed run's PREFIX as complete, and the
 *      audit's whole safety rests on the stamp meaning what clearRunState means.
 *
 *   2. At the END OF THE PAS2 ARM, per cycle, for `fec_bulk_pac` only. The
 *      objection above does not apply to it, because the pas2 arm has no prefix
 *      to stamp: it is a SINGLE un-cursored batch with no resume
 *      (upsertDonationRelationshipsBatch brackets one bulkUpsert between begin()
 *      and record()), and FIX-686's loud-abort contract THROWS on any failed
 *      chunk rather than returning a short count. So the arm returning normally
 *      for a cycle IS that (cycle, fec_bulk_pac) set's completion — there is no
 *      state in which it has emitted some of the cycle and stopped.
 *
 *      Measured, not assumed: on prod 2026-09-14 the three never-stamped pac
 *      rows held FULL key sets (135,192 / 111,729 / 135,192), and the two 2024
 *      rows from consecutive nightlies held byte-identical counts. They were
 *      complete in substance and only ever missing their stamp, because
 *      cycleSinks stamps the one cycle whose INDIV work completed and the pas2
 *      arm runs for every cycle regardless.
 *
 * `keys` is counted FROM THE TABLE rather than from the in-process sink, because
 * a resumed run legitimately skips stages that a prior process already emitted
 * ("complete in prior run — skipping (FIX-754)"). That process's counter is 0
 * for those stages while the rows are all present, and the audit cross-checks
 * the recorded count against the rows it can see — so an in-process counter
 * would make every resumed run fail its own guard.
 */
export async function stampEmitRunsComplete(
  client: Client,
  sinks: ReadonlyArray<{ runId: string; cycleYear: number; source: EmitSource }>,
): Promise<Array<{ source: EmitSource; keys: number }>> {
  const out: Array<{ source: EmitSource; keys: number }> = [];
  for (const sink of sinks) {
    const res = await client.query<{ keys: string }>(
      `UPDATE public.fec_emit_runs r
          SET complete_at = now(),
              keys = (SELECT count(*) FROM public.fec_emit_keys k
                       WHERE k.run_id = r.run_id
                         AND k.cycle_year = r.cycle_year
                         AND k.source = r.source)
        WHERE r.run_id = $1 AND r.cycle_year = $2 AND r.source = $3
        RETURNING r.keys::text AS keys`,
      [sink.runId, sink.cycleYear, sink.source],
    );
    if (res.rows.length > 0) {
      out.push({ source: sink.source, keys: Number(res.rows[0]!.keys) });
    }
  }
  return out;
}
