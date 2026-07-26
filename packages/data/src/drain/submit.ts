/**
 * Enrichment queue — submit a subagent's results back to the DB.
 *
 * Reads { results: [{queue_id, success, result?, error?}] } from --input FILE
 * (or stdin when --input is omitted). Delegates each item to applyResult(),
 * which upserts entity_tags / ai_summary_cache on success and routes failures
 * through record_enrichment_failure.
 *
 * Exit code: 0 if all ok; 1 if any failed; 2 on fatal (bad JSON etc).
 *
 *   pnpm --filter @civitics/data data:drain:submit --input /tmp/results-sub-1.json
 */

import { createAdminClient } from "@civitics/db";
import { readFileSync } from "node:fs";
import { parseFlags } from "./args";
import { applyResult, type SubmitResult } from "./apply";

async function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const inputPath = flags["input"] && flags["input"] !== "true" ? flags["input"] : undefined;

  const raw = inputPath ? readFileSync(inputPath, "utf8") : await readAllStdin();

  let body: { results?: SubmitResult[] };
  try {
    body = JSON.parse(raw) as { results?: SubmitResult[] };
  } catch (err) {
    console.error("[drain:submit] invalid JSON:", err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const results = Array.isArray(body.results) ? body.results : null;
  if (!results) {
    console.error("[drain:submit] body.results must be an array");
    process.exit(2);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  let ok = 0;
  let failed = 0;
  let missing = 0;
  // FIX-890: tags dropped by the write-boundary vocabulary guard. Surfaced in
  // the run summary so a prompt/vocabulary drift shows up as a number here
  // instead of as junk rows discovered in entity_tags weeks later.
  let rejected = 0;

  for (const r of results) {
    const outcome = await applyResult(db, r);
    if (outcome.kind === "missing_queue_row") {
      missing++;
      console.error(`[drain:submit] queue_id=${r.queue_id} not found`);
      continue;
    }
    rejected += outcome.rejected ?? 0;
    if (outcome.kind === "ok") ok++;
    else {
      failed++;
      console.error(`[drain:submit] queue_id=${r.queue_id} failed: ${outcome.error}`);
    }
  }

  const total = results.length;
  console.error(
    `[drain:submit] ${ok}/${total} ok` +
      (failed ? `, ${failed} failed` : "") +
      (missing ? `, ${missing} missing` : "") +
      (rejected ? `, ${rejected} tag(s) rejected by vocabulary guard` : ""),
  );

  // Orchestrator uses exit code to decide whether to halt a drain run.
  if (failed + missing === 0) {
    setTimeout(() => process.exit(0), 200);
  } else {
    setTimeout(() => process.exit(1), 200);
  }
}

main().catch((err) => {
  console.error("[drain:submit] fatal:", err instanceof Error ? err.message : err);
  setTimeout(() => process.exit(2), 200);
});
