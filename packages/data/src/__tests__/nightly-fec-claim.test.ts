/**
 * FIX-1310 — the nightly's fec_bulk writer runs under the FIX-950 claim.
 *
 * Runs via:  tsx --test src/__tests__/nightly-fec-claim.test.ts
 *
 * TWO HALVES, neither touching a database.
 *
 * Pure: the three helpers index.ts calls at the claim — which trigger fired,
 * the reason string, and what a claim error turns into. The reason is asserted
 * as a STRING because it is what every consumer keys on: the 17 guarded
 * procedures interpolate it into `skip_reason 'prod session held: …'`, and the
 * receipts' interlock section and FIX-1137's re-fire read it back.
 *
 * Structural, against index.ts's SOURCE (it cannot be imported here: it pulls
 * createAdminClient and the ai-tagger's module-level client): the nightly's one
 * `runFecBulkPipeline(` call sits lexically inside the one `withProdSession(`
 * call in runNightlySync, whose options carry the self-row exemption and the
 * 150-minute estimate; the FIX-1163 probe after it stays outside the claim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ProdSessionRefused } from "../lib/prod-session";
import {
  classifyFecClaimError,
  fecBulkTrigger,
  nightlyFecClaimReason,
  prodSessionHoldReason,
} from "../pipelines/nightly-hold";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS.
const INDEX = path.join(__dirname, "..", "pipelines", "index.ts");

// ---------------------------------------------------------------------------
// Pure — the trigger word
// ---------------------------------------------------------------------------

test("fecBulkTrigger: weekly outranks a resume state, resume outranks a drop", () => {
  const base = { runFec: true, held: false };
  assert.equal(fecBulkTrigger({ ...base, isWeekly: true }, false), "weekly");
  assert.equal(fecBulkTrigger({ ...base, isWeekly: true }, true), "weekly");
  assert.equal(fecBulkTrigger({ ...base, isWeekly: false }, true), "resume");
  assert.equal(fecBulkTrigger({ ...base, isWeekly: false }, false), "drop");
});

// ---------------------------------------------------------------------------
// Pure — the reason string
// ---------------------------------------------------------------------------

test("reason: names the trigger, the GHA run and the cycles", () => {
  assert.equal(
    nightlyFecClaimReason({
      trigger: "weekly",
      runId: "18431234567",
      cycles: "2024,2026",
      indivCycles: "2026",
    }),
    "nightly fec_bulk weekly run 18431234567 cycles=2024,2026 indiv=2026",
  );
});

test("reason: a run outside GHA says local, and an unset cycle list says so", () => {
  const r = nightlyFecClaimReason({
    trigger: "resume",
    runId: undefined,
    cycles: undefined,
    indivCycles: "",
  });
  assert.equal(r, "nightly fec_bulk resume run local cycles=(default) indiv=(default)");
});

test("reason: starts with the prefix every reader matches, and lands in skip_reason with it", () => {
  for (const trigger of ["weekly", "resume", "drop"] as const) {
    const r = nightlyFecClaimReason({ trigger, runId: "1", cycles: "2026", indivCycles: "2026" });
    assert.ok(r.startsWith("nightly fec_bulk "), r);
    // The guarded procedures write 'prod session held: ' || reason — the same
    // spelling prodSessionHoldReason produces on the TS side.
    assert.ok(prodSessionHoldReason(r).startsWith("prod session held: nightly fec_bulk "));
  }
});

test("reason: capped at 300 characters", () => {
  const r = nightlyFecClaimReason({
    trigger: "drop",
    runId: "1",
    cycles: Array.from({ length: 200 }, (_, i) => String(1800 + 2 * i)).join(","),
    indivCycles: "2026",
  });
  assert.equal(r.length, 300);
  assert.ok(r.startsWith("nightly fec_bulk drop run 1 cycles="));
});

// ---------------------------------------------------------------------------
// Pure — what a claim error becomes
// ---------------------------------------------------------------------------

test("claim error: a held session becomes a skipped fec_bulk naming the holder", () => {
  const err = new ProdSessionRefused({
    ok: false,
    code: "session-held",
    detail: "a supervised prod session is already held by craig@box (12m00s ago): FIX-954 set 3",
  });
  assert.deepEqual(classifyFecClaimError(err), {
    kind: "skipped",
    error:
      "prod session claim refused: a supervised prod session is already held by " +
      "craig@box (12m00s ago): FIX-954 set 3",
  });
});

test("claim error: another live writer becomes a skipped fec_bulk naming it", () => {
  const err = new ProdSessionRefused({
    ok: false,
    code: "writers-live",
    writers: ["usaspending_bulk"],
    detail: "1 heavy writer(s) are live: usaspending_bulk. …",
  });
  const c = classifyFecClaimError(err);
  assert.equal(c.kind, "skipped");
  assert.match(c.kind === "skipped" ? c.error : "", /^prod session claim refused: 1 heavy writer\(s\) are live: usaspending_bulk/);
});

test("claim error: anything else is rethrown, never swallowed into a skip", () => {
  assert.deepEqual(classifyFecClaimError(new Error("connection reset")), { kind: "rethrow" });
  assert.deepEqual(classifyFecClaimError("a string"), { kind: "rethrow" });
  assert.deepEqual(classifyFecClaimError(null), { kind: "rethrow" });
});

// ---------------------------------------------------------------------------
// Structural — index.ts
// ---------------------------------------------------------------------------

/**
 * Blank out comments and string/template literals, keeping every offset, so a
 * paren inside a log line or a `// (FIX-…)` comment cannot unbalance the scan.
 * Template literals are blanked whole, `${…}` included — the parens inside an
 * interpolation are balanced, so nothing the scan needs is lost.
 */
function codeOnly(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Offset of the `)` that closes the `(` at `open`, in comment/string-free code. */
function matchingParen(code: string, open: number): number {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === "(") depth++;
    else if (code[k] === ")" && --depth === 0) return k;
  }
  return -1;
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let k = hay.indexOf(needle); k !== -1; k = hay.indexOf(needle, k + 1)) out.push(k);
  return out;
}

function nightlyBody(): { src: string; code: string } {
  const src = fs.readFileSync(INDEX, "utf8");
  const start = src.indexOf("export async function runNightlySync(");
  assert.notEqual(start, -1, "runNightlySync not found in index.ts");
  const next = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, next === -1 ? src.length : next);
  return { src: body, code: codeOnly(body) };
}

test("index.ts: runFecBulkPipeline is called twice in the file, once in the nightly", () => {
  const code = codeOnly(fs.readFileSync(INDEX, "utf8"));
  assert.equal(allIndexes(code, "runFecBulkPipeline(").length, 2, "runPipelines' call + the nightly's");
  assert.equal(allIndexes(nightlyBody().code, "runFecBulkPipeline(").length, 1);
});

test("index.ts: the nightly's runFecBulkPipeline is inside its one withProdSession call", () => {
  const { code } = nightlyBody();
  const claims = allIndexes(code, "withProdSession(");
  assert.equal(claims.length, 1, "the nightly takes exactly one claim");
  const open = claims[0]! + "withProdSession".length;
  const close = matchingParen(code, open);
  assert.ok(close > open, "withProdSession( is never closed");

  const run = code.indexOf("runFecBulkPipeline(");
  assert.ok(run > open && run < close, "runFecBulkPipeline() must run under the claim");

  // The FIX-1100 resume vacuum is part of the writer block (D6); the FIX-1163
  // probe after it records, never writes, and stays outside.
  const vac = code.indexOf("vacuumAfterKilledFecWriter(");
  assert.ok(vac > open && vac < close, "the resume vacuum must run under the claim");
  const probe = code.indexOf("probeRecords(");
  assert.ok(probe > close, "the FIX-1163 drop probe must stay outside the claim");
});

test("index.ts: the claim's options exempt the run's own row, 150 minutes, never force", () => {
  const { src, code } = nightlyBody();
  const at = code.indexOf("withProdSession(");
  const open = at + "withProdSession".length;
  // The options literal is the first `{ … }` argument; read it from the SOURCE
  // (the stripped copy has blanked the template literal being asserted).
  const lb = code.indexOf("{", open);
  let depth = 0;
  let rb = -1;
  for (let k = lb; k < code.length; k++) {
    if (code[k] === "{") depth++;
    else if (code[k] === "}" && --depth === 0) { rb = k; break; }
  }
  const options = src.slice(lb, rb + 1);
  assert.match(options, /exemptWriters:\s*\[`nightly_cron:\$\{phase\}`\]/);
  assert.match(options, /expectedMinutes:\s*150\b/);
  assert.match(options, /force:\s*false\b/);
  assert.match(options, /reason:\s*fecClaimReason\b/);
  assert.match(src, /const fecClaimReason = nightlyFecClaimReason\(/);
});

test("index.ts: a refused claim is classified, not caught wholesale", () => {
  const { code } = nightlyBody();
  const at = code.indexOf("withProdSession(");
  const close = matchingParen(code, at + "withProdSession".length);
  const after = code.slice(close, close + 400);
  assert.match(after, /catch\s*\(\s*err\s*\)\s*\{\s*const \w+ = classifyFecClaimError\(err\)/);
});
