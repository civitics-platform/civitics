/**
 * FIX-1106 — anchors for the emit set.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/emit-set.test.ts
 *
 * What is pinned here is what an emit set has to be true for a DELETE to be
 * authorised by it:
 *
 *   * a key is recorded for every row SENT, not for every row CHANGED — because
 *     FIX-1008's skipUnchangedRows means a byte-identical re-upsert is never
 *     rewritten, and keying off `changed` would mark every unchanged recipient
 *     as residue. That is the exact inversion of the bug.
 *   * a resumed run continues the SAME run's set, and a new FEC drop starts a
 *     fresh one, because run identity is (cycle, FEC Last-Modified) — the pair
 *     run-state.ts already resumes on.
 *   * complete_at is stamped on ONE code path, the FIX-754 clear, and never by a
 *     killed or mid-resume run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { createEmitSink, emitRunId, type EmitKey } from "./emit-set";

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

test("run identity is (cycle, Last-Modified) — a resume continues, a new drop restarts", () => {
  const lm = "Sun, 06 Sep 2026 15:54:54 GMT";

  // A resumed run recomputes the same id from the same pair. This is what makes
  // "a resumed run continues the same run's set" true without persisting a
  // column: nothing is handed between the two processes.
  assert.equal(emitRunId(2026, lm), emitRunId(2026, lm));

  // A new FEC drop moves the pair, so the set restarts — at exactly the moment
  // run-state.ts discards the resume state, and for the same reason.
  assert.notEqual(emitRunId(2026, lm), emitRunId(2026, "Sun, 13 Sep 2026 15:54:54 GMT"));

  // Cycles never share a set.
  assert.notEqual(emitRunId(2026, lm), emitRunId(2024, lm));

  // A missing Last-Modified is a value, not a crash — the writers still run.
  assert.match(emitRunId(2026, null), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

interface FakeCall {
  sql: string;
  params: unknown[];
}

function fakeClient(): { calls: FakeCall[]; query: (sql: string, params?: unknown[]) => Promise<unknown> } {
  const calls: FakeCall[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

const KEYS = (n: number): EmitKey[] =>
  Array.from({ length: n }, (_, i) => ({
    relationshipType: "donation",
    toType: "official",
    toId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    fromId: `11111111-0000-0000-0000-${String(i).padStart(12, "0")}`,
  }));

test("a batch's keys are appended in ONE statement, not one per row", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2026, "x"), cycleYear: 2026, source: "fec_bulk_indiv" });

  await sink.record(c as never, KEYS(500));

  // 500 keys, one round trip. The unnest() shape is what makes the emit set
  // affordable on the write path: a per-row insert here would add 500 round
  // trips to every batch of a 30M-line file.
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0]!.sql, /unnest\(\$4::text\[\], \$5::text\[\], \$6::uuid\[\], \$7::uuid\[\]\)/);
  assert.equal((c.calls[0]!.params[5] as string[]).length, 500);
});

test("count equality: keys recorded == rows sent, across batches", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2026, "x"), cycleYear: 2026, source: "fec_bulk_indiv" });

  // Three batches, as the streamed writers produce them.
  await sink.record(c as never, KEYS(60));
  await sink.record(c as never, KEYS(60));
  await sink.record(c as never, KEYS(17));

  assert.equal(sink.count, 137);
  assert.equal(c.calls.length, 3);
});

test("an empty batch costs no statement", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2026, "x"), cycleYear: 2026, source: "fec_bulk_pac" });
  await sink.record(c as never, []);
  assert.equal(c.calls.length, 0);
  assert.equal(sink.count, 0);
});

test("begin() TRUNCATEs this slice and re-opens the ledger with complete_at NULL", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2026, "x"), cycleYear: 2026, source: "fec_bulk_indiv" });
  await sink.record(c as never, KEYS(5));
  await sink.begin(c as never);

  // The counter resets with the rows — a stale counter over a truncated set is
  // the same class of lie as a stamped ledger over a truncated key set.
  assert.equal(sink.count, 0);

  const [sup, del, ins] = c.calls.slice(1);
  // FIX-1184 added a first statement: supersede any older never-completed run
  // for this slice. It must come BEFORE the truncate of this run's own keys.
  assert.match(sup!.sql, /UPDATE public\.fec_emit_runs/);
  assert.match(sup!.sql, /superseded_at = now\(\)/);
  assert.match(del!.sql, /^\s*DELETE FROM public\.fec_emit_keys/);
  assert.match(ins!.sql, /INSERT INTO public\.fec_emit_runs/);
  // complete_at must be cleared, not left standing from a prior run.
  assert.match(ins!.sql, /complete_at = NULL/);
});

// ---------------------------------------------------------------------------
// FIX-1184 — supersession
// ---------------------------------------------------------------------------

test("begin() supersedes only OLDER incomplete runs for the same slice", async () => {
  const c = fakeClient();
  const runId = emitRunId(2026, "lm-b");
  const sink = createEmitSink({ runId, cycleYear: 2026, source: "fec_bulk_pac" });
  await sink.begin(c as never);

  const sup = c.calls[0]!;
  // A RESUMED run must not supersede itself: identity is deterministic over
  // (cycle, Last-Modified), so a resume arrives with the same run_id.
  assert.match(sup.sql, /r\.run_id\s+<>\s+\$1/);
  // Only never-completed rows, and never one already superseded (idempotent).
  assert.match(sup.sql, /r\.complete_at\s+IS NULL/);
  assert.match(sup.sql, /r\.superseded_at IS NULL/);
  // Scoped to ONE slice — two cycles' rows are independent.
  assert.match(sup.sql, /r\.cycle_year\s+= \$2/);
  assert.match(sup.sql, /r\.source\s+= \$3/);
  assert.deepEqual(sup.params, [runId, 2026, "fec_bulk_pac"]);
});

test("a superseded run's keys are COUNTED onto its row and then deleted", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2024, "lm"), cycleYear: 2024, source: "fec_bulk_pac" });
  await sink.begin(c as never);

  const sup = c.calls[0]!.sql;
  // The count is taken in the same statement as the delete, so it is read from
  // the pre-delete snapshot. keys > 0 on a superseded row is what makes Guard 1
  // refuse rather than skip: a PREFIX was written after the last complete set.
  assert.match(sup, /keys = \(SELECT count\(\*\) FROM public\.fec_emit_keys/);
  assert.match(sup, /DELETE FROM public\.fec_emit_keys k\s*\n\s*USING superseded s/);
  // One statement, not a read-then-write race.
  assert.equal([...sup.matchAll(/;/g)].length, 0, "supersession must be a single statement");
});

test("reopening a run un-supersedes its own row", async () => {
  const c = fakeClient();
  const sink = createEmitSink({ runId: emitRunId(2026, "lm"), cycleYear: 2026, source: "fec_bulk_indiv" });
  await sink.begin(c as never);

  const ins = c.calls[2]!.sql;
  // Reachable when a run was superseded by a DIFFERENT run and then resumed.
  // The set is being re-emitted from scratch, so the supersession no longer
  // describes it and must not survive into Guard 1's walk.
  assert.match(ins, /superseded_at = NULL, superseded_by = NULL/);
});

// ---------------------------------------------------------------------------
// Where completion is stamped — source-read, because that is the property
// ---------------------------------------------------------------------------

test("complete_at is stamped from exactly one place, and it is the FIX-754 clear", () => {
  const idx = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");

  const stampCalls = [...idx.matchAll(/stampEmitRunsComplete\(/g)];
  assert.equal(
    stampCalls.length,
    2,
    `stampEmitRunsComplete is called ${stampCalls.length} times in index.ts. It must be ` +
      `called exactly twice: the FIX-754 clear (the INDIV arms' only stamp) and the ` +
      `FIX-1184 pas2-arm stamp. A THIRD call site — another stage end, a finally block, ` +
      `an exit handler — would stamp a killed run's PREFIX as complete, and the audit's ` +
      `whole safety rests on the stamp meaning what clearRunState means.`,
  );

  // FIX-1184's second site is admissible ONLY for fec_bulk_pac, and only because
  // that arm is one un-cursored batch that throws rather than returning short.
  // The guard on it is that the end-of-run stamp excludes pac (so it is not
  // stamped twice) and that the pas2 stamp names its single sink.
  assert.match(
    idx,
    /stampEmitRunsComplete\(client, \[pacSink\]\)/,
    "the FIX-1184 stamp must stamp exactly the pas2 sink, never a cycle's whole set",
  );
  assert.match(
    idx,
    /sk\.source !== "fec_bulk_pac"/,
    "cycleSinks must exclude fec_bulk_pac — the pas2 arm already stamped itself",
  );

  // ...and that one call must sit inside the watermarkPersisted branch, ABOVE
  // clearRunState. FIX-754's ordering is final stage -> watermark -> clear; the
  // stamp belongs on the same side of it.
  const branchAt = idx.indexOf("if (watermarkPersisted) {");
  const stampAt = idx.indexOf("stampEmitRunsComplete(", branchAt);
  // The COMPLETION clear, not the three earlier ones. Those discard the run
  // state when the FEC drop moved out from under a resume — a discarded run
  // never completed, so it must not stamp, and it does not.
  const clearAt = idx.indexOf("await clearRunState(db)", branchAt);
  assert.ok(branchAt > 0 && stampAt > branchAt, "the stamp must be inside the watermarkPersisted branch");
  assert.ok(stampAt < clearAt, "the stamp must precede clearRunState — same transaction of meaning");

  // And the drop-moved clears above must remain unstamped. The only stamp
  // allowed before this branch is FIX-1184's pas2 one, which is scoped to the
  // pac sink alone and whose arm cannot leave a prefix.
  const earlyStamps = [...idx.slice(0, branchAt).matchAll(/stampEmitRunsComplete\(([^)]*)\)/g)];
  assert.equal(earlyStamps.length, 1, "only the FIX-1184 pas2 stamp may precede the FIX-754 branch");
  assert.match(
    earlyStamps[0]![1]!,
    /\[pacSink\]/,
    "a run whose FEC drop moved discards its state; it must not stamp an emit set",
  );

  // No other module may stamp it either.
  const emitSrc = fs.readFileSync(path.join(__dirname, "emit-set.ts"), "utf8");
  assert.equal(
    [...emitSrc.matchAll(/complete_at = now\(\)/g)].length,
    1,
    "emit-set.ts must contain exactly one complete_at write",
  );
});

test("the stamp counts keys FROM THE TABLE, so a resumed run does not fail its own guard", () => {
  const src = fs.readFileSync(path.join(__dirname, "emit-set.ts"), "utf8");
  // A resumed run legitimately skips stages a prior process emitted, so its
  // in-process counter is 0 for those while the rows are all present. Stamping
  // the counter would make the audit's count cross-check fail every resume.
  assert.match(src, /keys = \(SELECT count\(\*\) FROM public\.fec_emit_keys/);
  assert.doesNotMatch(src, /keys = \$4/);
});

// ---------------------------------------------------------------------------
// The writer wiring — the paths that are actually on the pipeline
// ---------------------------------------------------------------------------

test("the sink is wired to the THREE writers the pipeline calls, not the array ones", () => {
  const idx = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");

  // FIX-1061 replaced upsertIndividualDonationsBatch and
  // upsertIndividualToCommitteeDonationsBatch with the streamed writers on the
  // pipeline path. Instrumenting the array writers would record nothing.
  for (const call of [
    "upsertDonationRelationshipsBatch(",
    "streamIndividualDonations({",
    "streamIndividualToCommitteeDonations({",
  ]) {
    assert.ok(idx.includes(call), `index.ts no longer calls ${call} — re-check the emit wiring`);
  }

  assert.ok(idx.includes("const openEmitSink = ("), "the sink registry must exist");
  assert.equal(
    [...idx.matchAll(/openEmitSink\(CYCLE, /g)].length,
    3,
    "each of the three pipeline donation writers must open an emit sink",
  );
  for (const source of ["fec_bulk_pac", "fec_bulk_indiv", "fec_bulk_indiv_to_committee"]) {
    assert.ok(idx.includes(`"${source}"`), `no emit sink opened for ${source}`);
  }
});

test("the emit set records rows SENT, never rows CHANGED", () => {
  const writer = fs.readFileSync(path.join(__dirname, "writer.ts"), "utf8");
  // `rows` is the array handed to bulkUpsert. `changed` is the server's count of
  // what it actually rewrote after FIX-1008 skipping. Recording `changed` would
  // classify every unchanged recipient as residue.
  assert.ok(writer.includes("rows.map(relEmitKey)"), "the PAC writer must record its sent rows");
  assert.ok(writer.includes("rows.map(spec.emitKeyOf)"), "upsertStreamed must record its sent rows");
  assert.doesNotMatch(writer, /record\([^)]*changed/);
});

test("upsertStreamed only records when a spec opts in — the donor-entities stage must not", () => {
  const writer = fs.readFileSync(path.join(__dirname, "writer.ts"), "utf8");
  // writer.ts:763 drives the donor ENTITIES stage through upsertStreamed. Its
  // rows are financial_entities and carry no relationship arbiter, so an
  // automatic sink there would record entity ids into a donation emit set.
  assert.match(writer, /if \(spec\.emitSink && spec\.emitKeyOf\) \{/);
});
