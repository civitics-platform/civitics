/**
 * FIX-1218 — `data:nightly:preflight`: "already ran for this nominal day?"
 *
 * nightly.yml's fec-phase runs this before the FEC phase. It reads
 * `data_sync_log` for the `nightly_cron` rows stamped with this run's nominal
 * day and writes ONE verdict PER PHASE to `$GITHUB_OUTPUT` (FIX-1281):
 * `already_ran` (the FEC phase — the FEC step and mark-killed gate on it) and
 * `already_ran_enrichment_heavy` / `_light` / `_tail`, each read by its own
 * enrichment job. The decision itself is pipelines/nightly-preflight.ts — see
 * its header for what counts, per phase, and whom it guards.
 *
 * NEVER FAILS THE JOB. It exits 0 on every path. A read that still fails after
 * three tries (20 s, 40 s apart) asks GitHub whether the night's dispatched run
 * exists. If one does, every phase stands down (FIX-1418). If none does, or
 * GitHub cannot be read either, it answers `false` for EVERY phase: FAIL OPEN,
 * the FIX-950 reader's rule. A preflight that crashed must not cost the night.
 * A duplicate nightly is idempotent upserts and a second pass of load; a
 * missing one is a lost day. The workflow step also carries
 * `continue-on-error: true`, so even an uncatchable crash here leaves the
 * outputs unset, which the gates read as "not already ran".
 *
 *   pnpm data:nightly:preflight                           # local (.env.local)
 *   pnpm data:nightly:preflight:ci                        # GHA, adds --allow-prod
 *   pnpm data:nightly:preflight -- --now 2026-09-24T21:00:05Z   # a fixed clock, for proofs
 *
 * Inputs (env): NIGHTLY_SLOT_OFFSET_HOURS, NIGHTLY_DISPATCHED_BY, GITHUB_RUN_ID,
 * GITHUB_OUTPUT, GITHUB_REPOSITORY, GH_TOKEN. All optional; absent
 * dispatched_by means "not guarded", and absent GITHUB_REPOSITORY means GitHub
 * is not asked (the unreadable branch fails open).
 */

import { appendFileSync } from "node:fs";
import { createAdminClient } from "@civitics/db";
import { readSlotOffsetHours, SLOT_OFFSET_ENV } from "../pipelines/weekly-gate";
import {
  DISPATCHED_BY_ENV,
  failOpenOutputs,
  nominalDay,
  parseWorkflowRuns,
  readDispatchedBy,
  resolvePreflight,
  type DispatchedNightlyRun,
  type PriorNightlyRow,
} from "../pipelines/nightly-preflight";

/** D4: the GitHub read is bounded, and it never throws out of main(). */
const GITHUB_READ_TIMEOUT_MS = 10_000;

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
  for (const l of lines) console.info(`[preflight] output ${l}`);
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

/**
 * FIX-1418 D2/D4 — nightly.yml's `workflow_dispatch` runs, newest 20, through
 * the job's own `GH_TOKEN` (`actions: read`). `null` on any failure: no repo,
 * a non-2xx, a timeout, a body of another shape. Never throws.
 */
async function listDispatchedRuns(): Promise<DispatchedNightlyRun[] | null> {
  const repo = process.env["GITHUB_REPOSITORY"];
  if (!repo) {
    console.warn("[preflight] GITHUB_REPOSITORY unset — cannot ask GitHub for the dispatched run");
    return null;
  }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/nightly.yml/runs?event=workflow_dispatch&per_page=20`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "civitics-nightly-preflight",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GH_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(GITHUB_READ_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[preflight] GitHub run list answered ${res.status} ${res.statusText}`);
      return null;
    }
    const runs = parseWorkflowRuns(await res.json());
    if (runs === null) console.warn("[preflight] GitHub run list was not the expected shape");
    else console.info(`[preflight] GitHub lists ${runs.length} workflow_dispatch run(s) of nightly.yml`);
    return runs;
  } catch (err) {
    console.warn(`[preflight] GitHub run list unreadable (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

async function main(): Promise<void> {
  const now = parseNow(process.argv.slice(2));
  const slotOffsetHours = readSlotOffsetHours(process.env[SLOT_OFFSET_ENV]);
  const dispatchedBy = readDispatchedBy(process.env[DISPATCHED_BY_ENV]);
  const runId = process.env["GITHUB_RUN_ID"] || null;
  const day = nominalDay(now, slotOffsetHours);
  console.info(
    `[preflight] nominal day ${day} (${SLOT_OFFSET_ENV}=${slotOffsetHours}, now ${now.toISOString()}) ` +
      `dispatched_by=${dispatchedBy ?? "(unset)"} run=${runId ?? "(none)"}`,
  );

  // Unguarded triggers read neither the DB nor GitHub: nothing the answer could change.
  const outputs = await resolvePreflight({ day, dispatchedBy, runId }, {
    readRows,
    listDispatchedRuns,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    info: (line) => console.info(line),
    warn: (line) => console.warn(line),
  });
  writeOutputs(outputs);
}

main().catch((err: unknown) => {
  console.warn(`[preflight] unexpected failure (${err instanceof Error ? err.message : String(err)}) — FAIL OPEN`);
  writeOutputs(failOpenOutputs(null));
});
