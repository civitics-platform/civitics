/**
 * FIX-1218 — `data:nightly:preflight`: "already ran for this nominal day?"
 *
 * nightly.yml's fec-phase runs this before the FEC phase. It reads
 * `data_sync_log` for a `nightly_cron` row stamped with this run's nominal day
 * and writes `already_ran=true|false` to `$GITHUB_OUTPUT`; the FEC step and
 * every downstream phase job gate on it. The decision itself is
 * pipelines/nightly-preflight.ts — see its header for what counts and whom it
 * guards.
 *
 * NEVER FAILS THE JOB. It exits 0 on every path, and on any failure to read it
 * answers `already_ran=false` — FAIL OPEN, the FIX-950 reader's rule: a
 * preflight that crashed must not cost the night. A duplicate nightly is
 * idempotent upserts and a second pass of load; a missing one is a lost day.
 * The workflow step also carries `continue-on-error: true`, so even an
 * uncatchable crash here leaves the output unset, which the gates read as
 * "not already ran".
 *
 *   pnpm data:nightly:preflight                           # local (.env.local)
 *   pnpm data:nightly:preflight:ci                        # GHA, adds --allow-prod
 *   pnpm data:nightly:preflight -- --now 2026-09-24T21:00:05Z   # a fixed clock, for proofs
 *
 * Inputs (env): NIGHTLY_SLOT_OFFSET_HOURS, NIGHTLY_DISPATCHED_BY, GITHUB_RUN_ID,
 * GITHUB_OUTPUT. All optional; absent dispatched_by means "not guarded".
 */

import { appendFileSync } from "node:fs";
import { createAdminClient } from "@civitics/db";
import { readSlotOffsetHours, SLOT_OFFSET_ENV } from "../pipelines/weekly-gate";
import {
  DISPATCHED_BY_ENV,
  GUARDED_TRIGGERS,
  decidePreflight,
  nominalDay,
  readDispatchedBy,
  type PriorNightlyRow,
} from "../pipelines/nightly-preflight";

function parseNow(argv: string[]): Date {
  const i = argv.indexOf("--now");
  if (i === -1) return new Date();
  const raw = argv[i + 1] ?? "";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    console.warn(`[preflight] --now ${JSON.stringify(raw)} is not a timestamp — using the wall clock`);
    return new Date();
  }
  return new Date(t);
}

/** `$GITHUB_OUTPUT` when set (GHA); stdout otherwise. Never throws. */
function writeOutputs(outputs: Record<string, string>): void {
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  const file = process.env["GITHUB_OUTPUT"];
  if (file !== undefined && file !== "") {
    try {
      appendFileSync(file, lines.join("\n") + "\n", "utf8");
      return;
    } catch (err) {
      console.warn(`[preflight] could not write $GITHUB_OUTPUT (${String(err)}) — the gates will read unset`);
    }
  }
  for (const l of lines) console.log(`[preflight] output ${l}`);
}

async function readRows(day: string): Promise<PriorNightlyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db
    .from("data_sync_log")
    .select("id, status, started_at, metadata")
    .eq("pipeline", "nightly_cron")
    .eq("metadata->>nominal_day", day)
    .order("started_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    status: r.status ?? null,
    started_at: r.started_at ?? null,
    phase: r.metadata?.phase ?? null,
    github_run_id: r.metadata?.github_run_id ?? null,
    dispatched_by: r.metadata?.dispatched_by ?? null,
  }));
}

async function main(): Promise<void> {
  const now = parseNow(process.argv.slice(2));
  const slotOffsetHours = readSlotOffsetHours(process.env[SLOT_OFFSET_ENV]);
  const dispatchedBy = readDispatchedBy(process.env[DISPATCHED_BY_ENV]);
  const runId = process.env["GITHUB_RUN_ID"] || null;
  const day = nominalDay(now, slotOffsetHours);
  console.log(
    `[preflight] nominal day ${day} (${SLOT_OFFSET_ENV}=${slotOffsetHours}, now ${now.toISOString()}) ` +
      `dispatched_by=${dispatchedBy ?? "(unset)"} run=${runId ?? "(none)"}`,
  );

  // Unguarded triggers never read the DB: there is nothing the answer could change.
  let rows: PriorNightlyRow[] = [];
  if (dispatchedBy !== null && GUARDED_TRIGGERS.includes(dispatchedBy)) {
    try {
      rows = await readRows(day);
    } catch (err) {
      console.warn(
        `[preflight] could not read data_sync_log (${err instanceof Error ? err.message : String(err)}) — ` +
          "FAIL OPEN: already_ran=false, this run does the night's work",
      );
      writeOutputs({ already_ran: "false", nominal_day: day });
      return;
    }
  }

  const verdict = decidePreflight({ nominalDay: day, dispatchedBy, runId, rows });
  for (const r of verdict.matched) {
    console.log(
      `[preflight]   row ${r.id} phase=${r.phase ?? "all"} status=${r.status} started=${r.started_at} ` +
        `run=${r.github_run_id ?? "—"} dispatched_by=${r.dispatched_by ?? "—"}`,
    );
  }
  // `::notice::` renders as an annotation on the run page, so a fallback that
  // stood down says why without anyone opening the log.
  console.log(`${verdict.alreadyRan ? "::notice::" : ""}[preflight] ${verdict.reason}`);
  writeOutputs({ already_ran: verdict.alreadyRan ? "true" : "false", nominal_day: day });
}

main().catch((err: unknown) => {
  console.warn(`[preflight] unexpected failure (${err instanceof Error ? err.message : String(err)}) — FAIL OPEN`);
  writeOutputs({ already_ran: "false" });
});
