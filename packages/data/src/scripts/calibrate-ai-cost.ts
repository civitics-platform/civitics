/**
 * FIX-893 — measured cost calibration.
 *
 * Design decision 5: verify the corrected pricing arithmetic with a bounded REAL
 * run, don't trust the estimate. Any per-item cost figure in the FIX-893 report
 * must come from measured `message.usage`, not from token arithmetic.
 *
 * WHAT IT DOES
 *   Takes N (default 20) real proposals that PASS the FIX-894 source-text gate,
 *   runs each through the actual production tag prompt on Haiku 4.5, and records
 *   `message.usage.input_tokens` / `output_tokens` per call. Then reports:
 *     - measured cost/item under the CORRECTED rates ($1.00/$5.00)
 *     - what the same measured tokens would have reported under the OLD wrong
 *       rates ($0.25/$1.25), i.e. the understatement factor
 *     - implied cost of a full pass over the remaining eligible backlog
 *
 * READ-ONLY against the database. It claims nothing from enrichment_queue,
 * writes no tags, no api_usage_logs rows, and no cache entries — so it cannot
 * corrupt queue state or double-count spend. The only side effect is the
 * Anthropic API spend itself, which at N=20 Haiku calls is ~$0.05.
 *
 * USAGE
 *   pnpm --filter @civitics/data data:calibrate-cost
 *   pnpm --filter @civitics/data data:calibrate-cost -- --n=20
 */

import { Client } from "pg";
import { createAiClient } from "@civitics/ai";
import { calculateCostUsd, DEFAULT_AI_MODEL } from "@civitics/db";
import { VALID_TOPICS } from "../pipelines/tags/topics";

const N = (() => {
  const arg = process.argv.find((a) => a.startsWith("--n="));
  return arg ? Math.max(1, parseInt(arg.split("=")[1]!, 10)) : 20;
})();

// The old (wrong) rates, kept ONLY so the report can quantify the delta.
const OLD_WRONG_INPUT_PER_M = 0.25;
const OLD_WRONG_OUTPUT_PER_M = 1.25;

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const password = process.env["SUPABASE_DB_PASSWORD"];
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

/** Mirrors the production tag prompt shape closely enough to measure tokens. */
function buildTagPrompt(title: string, summaryPlain: string): string {
  return (
    `Classify this legislative proposal into 1-3 topics from the allowed list.\n\n` +
    `Allowed topics: ${VALID_TOPICS.join(", ")}\n\n` +
    `Title: ${title}\n` +
    `Summary: ${summaryPlain.slice(0, 300)}\n\n` +
    `Respond with JSON only: {"topics":["..."],"primary_topic":"...","confidence":0.0,` +
    `"affects_individuals":true,"technical_complexity":"low"}`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const url = buildDbUrl();
  const isProd = /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");

  console.log(`# FIX-893 — measured AI cost calibration`);
  console.log(`Model:   ${DEFAULT_AI_MODEL}`);
  console.log(`Sample:  ${N} real proposals that pass the FIX-894 source-text gate`);
  console.log(`DB:      ${isProd ? "prod (read-only)" : "local Docker (read-only)"}`);
  console.log(`Writes:  NONE (no queue claim, no tags, no api_usage_logs)\n`);

  const client = new Client({ connectionString: url });
  await client.connect();

  let rows: Array<{ id: string; title: string; summary_plain: string }>;
  try {
    const res = await client.query(
      `SELECT p.id, p.title, p.summary_plain
         FROM public.proposals p
        WHERE length(trim(coalesce(p.summary_plain,''))) > 100
          AND lower(trim(coalesce(p.summary_plain,''))) <> lower(trim(coalesce(p.title,'')))
        ORDER BY p.id
        LIMIT $1`,
      [N],
    );
    rows = res.rows;
  } finally {
    await client.end();
  }

  if (rows.length === 0) {
    console.error("No qualifying proposals found — cannot calibrate.");
    process.exit(1);
  }
  console.log(`Fetched ${rows.length} qualifying proposal(s).\n`);

  const anthropic = createAiClient();

  let totalIn = 0;
  let totalOut = 0;
  const perItem: Array<{ in: number; out: number; usd: number }> = [];

  console.log(`  #   input_tok  output_tok   cost_usd   title`);
  console.log(`  --  ---------  ----------  ---------   -----`);

  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]!;
    const message = await anthropic.messages.create({
      model: DEFAULT_AI_MODEL,
      max_tokens: 200,
      system:
        "You classify civic legislative proposals into topics. Respond with JSON only.",
      messages: [{ role: "user", content: buildTagPrompt(p.title, p.summary_plain) }],
    });

    // MEASURED usage — the whole point of this script.
    const inTok = message.usage.input_tokens;
    const outTok = message.usage.output_tokens;
    const usd = calculateCostUsd(inTok, outTok, DEFAULT_AI_MODEL);

    totalIn += inTok;
    totalOut += outTok;
    perItem.push({ in: inTok, out: outTok, usd });

    console.log(
      `  ${String(i + 1).padStart(2)}  ${String(inTok).padStart(9)}  ` +
        `${String(outTok).padStart(10)}  ${usd.toFixed(6)}   ${p.title.slice(0, 46)}`,
    );

    await sleep(1300); // 50 req/min ceiling
  }

  const n = perItem.length;
  const totalUsd = calculateCostUsd(totalIn, totalOut, DEFAULT_AI_MODEL);
  const oldUsd =
    (totalIn * OLD_WRONG_INPUT_PER_M + totalOut * OLD_WRONG_OUTPUT_PER_M) / 1_000_000;

  const perItemUsd = totalUsd / n;
  const perItemOldUsd = oldUsd / n;

  const sorted = [...perItem].sort((a, b) => a.usd - b.usd);
  const median = sorted[Math.floor(n / 2)]!.usd;

  console.log(`\n── Measured totals (${n} items) ─────────────────────────────`);
  console.log(`  input tokens          ${totalIn}`);
  console.log(`  output tokens         ${totalOut}`);
  console.log(`  mean input/item       ${(totalIn / n).toFixed(1)}`);
  console.log(`  mean output/item      ${(totalOut / n).toFixed(1)}`);

  console.log(`\n── Cost at CORRECTED rates ($1.00/M in, $5.00/M out) ───────`);
  console.log(`  total                 $${totalUsd.toFixed(6)}`);
  console.log(`  per item (mean)       $${perItemUsd.toFixed(6)}`);
  console.log(`  per item (median)     $${median.toFixed(6)}`);
  console.log(`  min / max per item    $${sorted[0]!.usd.toFixed(6)} / $${sorted[n - 1]!.usd.toFixed(6)}`);

  console.log(`\n── Same measured tokens at OLD rates ($0.25/M, $1.25/M) ────`);
  console.log(`  total                 $${oldUsd.toFixed(6)}`);
  console.log(`  per item (mean)       $${perItemOldUsd.toFixed(6)}`);
  console.log(`  UNDERSTATEMENT        ${(totalUsd / oldUsd).toFixed(2)}x`);

  // Formula cross-check: the reported cost must equal the corrected formula
  // applied to the measured tokens, exactly.
  const recomputed = (totalIn * 1.0 + totalOut * 5.0) / 1_000_000;
  const agrees = Math.abs(recomputed - totalUsd) < 1e-12;
  console.log(
    `\n  formula cross-check    ${agrees ? "✓ agrees" : "✗ MISMATCH"} ` +
      `(hand-computed $${recomputed.toFixed(6)} vs helper $${totalUsd.toFixed(6)})`,
  );

  console.log(`\n── Implied full-pass cost at the measured per-item rate ────`);
  for (const [label, count] of [
    ["eligible proposal tag+summary backlog (prod, post-gate)", 3089],
    ["if the text-free backlog were drained anyway (prod)", 138807],
  ] as Array<[string, number]>) {
    const corrected = perItemUsd * count;
    const old = perItemOldUsd * count;
    console.log(
      `  ${label}\n` +
        `    ${count.toLocaleString()} items → $${corrected.toFixed(2)} ` +
        `(would have been reported as $${old.toFixed(2)})`,
    );
  }

  console.log(`\n── Effective headroom under COST_CONFIG ────────────────────`);
  for (const [label, limit] of [
    ["monthly_hard_limit_usd", 3.5],
    ["per_run_limits.ai_tagger", 0.5],
    ["autonomous.max_auto_approve_usd", 0.1],
  ] as Array<[string, number]>) {
    const itemsNow = Math.floor(limit / perItemUsd);
    const itemsBefore = Math.floor(limit / perItemOldUsd);
    console.log(
      `  ${label.padEnd(32)} $${limit.toFixed(2)} → ${itemsNow.toLocaleString()} items ` +
        `(was reported as ${itemsBefore.toLocaleString()})`,
    );
  }
}

main().catch((err) => {
  console.error("Calibration failed:", err);
  process.exit(1);
});
