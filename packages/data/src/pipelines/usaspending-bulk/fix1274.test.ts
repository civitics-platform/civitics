/**
 * FIX-1274 — the USASpending pipeline made survivable (cc-214).
 *
 *   C1  the FR upsert passes skipUnchangedRows — and the helper's predicate
 *       then covers EVERY column the statement SETs (a source-text case plus
 *       the built statement).
 *   C3  delta mode never lists the Fulls; fiscal_year_* is null on a delta run;
 *       every failSync in the pipeline stamps the run's metadata (FIX-1268).
 *   C4  one invocation, one budget: --max-parts counts across categories, a
 *       dial stop ends the invocation, a failure does not.
 *   C7  the CI path claims nothing: a held prod session → a `skipped` row per
 *       category and no work, spelled `prod session held: …`.
 *
 * Runs via:  tsx --test src/pipelines/usaspending-bulk/fix1274.test.ts
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import fs       from "node:fs";
import path     from "node:path";
import { buildUpsertStatement } from "../../lib/direct-pg-upsert";
import type { ProdSessionState } from "../../lib/prod-session";
import {
  planRun,
  runUsaSpendingBulkCi,
  runUsaSpendingBulkInvocation,
  usaSpendingCiPreflight,
  type BulkPipelineOpts,
  type BulkPipelineResult,
} from "./index";
import { parseUsaSpendingFlags } from "./flags";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// C1 — skip unchanged FR rows
// ---------------------------------------------------------------------------

test("C1 the financial_relationships bulkUpsert passes skipUnchangedRows: true", () => {
  const src  = stripComments(read("writer.ts"));
  const at   = src.indexOf(`table: "financial_relationships"`);
  assert.notEqual(at, -1, "the FR bulkUpsert call");
  const call = src.slice(src.lastIndexOf("bulkUpsert(", at), src.indexOf("});", at));
  assert.match(call, /skipUnchangedRows:\s*true/, "FR upsert must skip byte-identical rows (FIX-1274 C1)");
  assert.doesNotMatch(call, /updateColumns:/, "no SET subset — the predicate must cover every SET column");
});

test("C1 the predicate covers every column the statement SETs (a genuine amendment still lands)", () => {
  const columns = [
    "relationship_type", "from_type", "from_id", "to_type", "to_id", "amount_cents",
    "occurred_at", "started_at", "ended_at", "usaspending_award_id", "source_url", "metadata",
  ];
  const sql = buildUpsertStatement({
    table: "financial_relationships", columns, conflictColumns: ["usaspending_award_id"],
    skipUnchangedRows: true, jsonbColumns: ["metadata"], rowCount: 1,
  });
  const set   = sql.slice(sql.indexOf("DO UPDATE SET"), sql.indexOf(" WHERE "));
  const where = sql.slice(sql.indexOf(" WHERE "));
  const updated = columns.filter((c) => c !== "usaspending_award_id");
  for (const c of updated) {
    assert.ok(set.includes(`"${c}" = EXCLUDED."${c}"`), `SET ${c}`);
    assert.ok(where.includes(`"financial_relationships"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`), `WHERE covers ${c}`);
  }
  assert.equal(where.split("IS DISTINCT FROM").length - 1, updated.length, "exactly the SET list, OR-ed");
});

// ---------------------------------------------------------------------------
// C3 — the Full listing lives in the no-baseline arm
// ---------------------------------------------------------------------------

function bucket(keys: Record<string, number>) {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<string> => {
    const prefix = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
    asked.push(prefix);
    const hits = Object.entries(keys).filter(([k]) => k.startsWith(prefix));
    return (
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Prefix>${prefix}</Prefix>` +
      hits.map(([k, size]) => `<Contents><Key>${k}</Key><LastModified>x</LastModified><Size>${size}</Size></Contents>`).join("") +
      `</ListBucketResult>`
    );
  };
  return { fetch, asked };
}

const LISTING = {
  "FY2026_All_Contracts_Full_20260906.zip": 2_000_000_000,
  "FY(All)_All_Contracts_Delta_20260924.zip": 1_524_399_293,
};
const BASELINE = { lastArchiveDate: "20260806", lastRunType: "delta" as const, lastRunAt: "t" };

test("C3 a delta run lists ONLY the deltas — never the Fulls — and carries no fiscal_year_*", async () => {
  // FY2027 has no Full yet: pre-FIX-1274 the delta run listed it first and
  // could fail on it; now it is never asked.
  const b = bucket(LISTING);
  const plan = await planRun("contracts", BASELINE, 2027, { fetch: b.fetch });
  assert.deepEqual(b.asked, ["FY(All)_All_Contracts_Delta"]);
  assert.equal(plan.mode, "delta");
  assert.equal(plan.fyMeta, null);
  assert.deepEqual(plan.files.map((f) => [f.name, f.size]), [["FY(All)_All_Contracts_Delta_20260924.zip", 1_524_399_293]],
    "the listing's <Size> rides along for the --keep-archive reuse check");
});

test("C3 no baseline → the Full listing (with the FIX-1268 fallback); a delta with nothing new → nothingToDo", async () => {
  const b = bucket(LISTING);
  const plan = await planRun("contracts", null, 2027, { fetch: b.fetch });
  assert.deepEqual(b.asked, ["FY2027_All_Contracts_Full", "FY2026_All_Contracts_Full"]);
  assert.equal(plan.mode, "full");
  assert.deepEqual(plan.fyMeta, { fiscal_year_requested: 2027, fiscal_year_used: 2026, fiscal_year_fallback: true });

  const none = await planRun("contracts", null, 2027, { fetch: bucket({}).fetch });
  assert.match(none.error ?? "", /No Full Contracts archive found for FY2027 or FY2026/);
  assert.ok(none.fyMeta, "a failed plan still carries the FY facts for failSync");

  const caughtUp = await planRun("contracts", { ...BASELINE, lastArchiveDate: "20260924" }, 2027, { fetch: bucket(LISTING).fetch });
  assert.equal(caughtUp.nothingToDo, true);
});

test("C3 / FIX-1268 every failSync in the pipeline stamps the run's metadata", () => {
  const src   = stripComments(read("index.ts"));
  const calls = [...src.matchAll(/failSync\(([^;]*?)\);/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 3, `expected the plan, agency and catch failSyncs, found ${calls.length}`);
  for (const args of calls) {
    assert.match(args, /,\s*rowMeta\(\)\s*$/, `failSync(${args}) must pass rowMeta() — a failed row with no fiscal_year_* is FIX-1268's hole`);
  }
});

// ---------------------------------------------------------------------------
// C4 — one invocation, one budget
// ---------------------------------------------------------------------------

function fakeRun(script: Record<string, Partial<BulkPipelineResult>>) {
  const calls: BulkPipelineOpts[] = [];
  const runCategory = async (opts: BulkPipelineOpts): Promise<BulkPipelineResult> => {
    calls.push(opts);
    return {
      inserted: 0, updated: 0, failed: 0, estimatedMb: 0,
      status: "complete", stopReason: null, partsThisInvocation: 0,
      ...script[opts.category!],
    };
  };
  return { calls, runCategory };
}

test("C4 --max-parts is one budget across categories; --max-minutes is one wall from the start", async () => {
  const f = fakeRun({ contracts: { partsThisInvocation: 2 } });
  const flags = parseUsaSpendingFlags(["--max-parts", "3", "--max-minutes", "10", "--gate-wait-s", "0"], "standalone");
  await runUsaSpendingBulkInvocation(flags, { runCategory: f.runCategory, nowMs: () => 1_000_000 });
  assert.deepEqual(f.calls.map((c) => [c.category, c.maxParts, c.deadlineMs]), [
    ["contracts", 3, 1_000_000 + 600_000],
    ["assistance", 1, 1_000_000 + 600_000],
  ]);
  assert.equal(f.calls[0]!.gateWaitS, 0);
  assert.equal(f.calls[0]!.keepArchive, true);
});

test("C4 a dial stop ends the invocation; a FAILED category does not", async () => {
  const stopped = fakeRun({ contracts: { status: "partial", stopReason: "gate" } });
  const out = await runUsaSpendingBulkInvocation(parseUsaSpendingFlags([], "standalone"), { runCategory: stopped.runCategory });
  assert.deepEqual(stopped.calls.map((c) => c.category), ["contracts"], "assistance is not started after a stop");
  assert.equal(out[0]!.stopReason, "gate");

  const failed = fakeRun({ contracts: { status: "failed", failed: 1 } });
  await runUsaSpendingBulkInvocation(parseUsaSpendingFlags([], "standalone"), { runCategory: failed.runCategory });
  assert.deepEqual(failed.calls.map((c) => c.category), ["contracts", "assistance"]);
});

// ---------------------------------------------------------------------------
// C7 — the CI preflight
// ---------------------------------------------------------------------------

const HELD: ProdSessionState = {
  held: true, defer: true, label_present: true, label_stale: false,
  reason: "usaspending-bulk --category contracts --max-minutes 240", claimed_by: "craig@desk",
  claimed_at: "2026-10-10T20:00:00Z", age_seconds: 120, expected_minutes: 240, pid: 4242,
  live_writers: [], live_writer_detail: [], reason_text: "held",
};
const CLEAR: ProdSessionState = {
  ...HELD, held: false, defer: false, label_present: false, reason: null, claimed_by: null, reason_text: "clear",
};

test("C7 preflight: held → skip, spelled `prod session held: …`; clear or unreadable → run", () => {
  const d = usaSpendingCiPreflight(HELD);
  assert.equal(d.skip, true);
  assert.equal(
    d.skip && d.reason,
    "prod session held: usaspending-bulk --category contracts --max-minutes 240 (claimed by craig@desk)",
  );
  assert.ok(d.skip && d.reason.startsWith("prod session held"), "FIX-1137 keys on this prefix");
  assert.deepEqual(usaSpendingCiPreflight(CLEAR), { skip: false });
  assert.deepEqual(usaSpendingCiPreflight(null), { skip: false }, "fail open, like every FIX-950 reader");
});

test("C7 the CI path with a held session writes a skipped row per category and runs nothing", async () => {
  const skipped: Array<[string, string]> = [];
  let invoked = 0;
  const r = await runUsaSpendingBulkCi(parseUsaSpendingFlags(["--allow-prod"], "ci"), {
    readState:    async () => HELD,
    writeSkipped: async (p, reason) => { skipped.push([p, reason]); },
    invoke:       async () => { invoked++; return []; },
  });
  assert.equal(invoked, 0, "a GHA run never lands on a supervised op");
  assert.deepEqual(skipped.map(([p]) => p), ["usaspending_bulk", "usaspending_bulk_assistance"]);
  assert.match(r.skipped ?? "", /^prod session held: /);

  const ran = await runUsaSpendingBulkCi(parseUsaSpendingFlags(["--allow-prod"], "ci"), {
    readState:    async () => CLEAR,
    writeSkipped: async () => { throw new Error("must not skip"); },
    invoke:       async () => { invoked++; return []; },
  });
  assert.equal(invoked, 1);
  assert.equal(ran.skipped, null);
});
