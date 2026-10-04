/**
 * FIX-1189 D2 — the candidate → elected promotion, run by hand.
 *
 * The same plan the nightly congress phase makes (`planCandidateToElectedPromotion`
 * in pipelines/congress/promote-candidates.ts) and, with --apply, the same
 * execution (`runCandidateToElectedPromotion` with that plan), so what the dry
 * run prints is exactly what the apply promotes.
 *
 *   pnpm --filter @civitics/data data:promote:candidates -- [--dry-run | --apply]
 *        [--dataset-key] [--allow-prod] [--cap N]
 *
 *   --dry-run      the DEFAULT. Plan only (rule 141): reads the two populations
 *                  and, with --dataset-key, the congress-legislators listing;
 *                  prints the plan and the pass counters; writes NOTHING — not a
 *                  row, not a sync-log stamp, not a session claim.
 *   --apply        promote the planned pairs (FIX-248's row-deleting RPC, one
 *                  ~17 s autocommit call per pair). Claims the FIX-950
 *                  supervised-prod-session lock for the run, as every landing
 *                  script does.
 *   --dataset-key  run pass 2, the dataset key. The nightly runs it only under
 *                  CIVITICS_PROMOTION_DATASET_KEY=1; this runner never reads
 *                  that variable, so the flag is the one switch here.
 *   --allow-prod   required whenever the active env points at prod. With
 *                  --apply it also prints the target host and waits 5 s.
 *   --cap N        the per-run promotion cap (default 25, FIX-755).
 */

import { createAdminClient } from "@civitics/db";
import {
  PROMOTION_CAP,
  planCandidateToElectedPromotion,
  promotionCountersLine,
  runCandidateToElectedPromotion,
  type PromotionPlan,
} from "../pipelines/congress/promote-candidates";
import { runUnderProdSession } from "../lib/prod-session";

interface Args {
  apply:      boolean;
  datasetKey: boolean;
  allowProd:  boolean;
  cap:        number;
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--apply") && argv.includes("--dry-run")) {
    console.error("✗ --apply and --dry-run are exclusive.");
    process.exit(1);
  }
  let cap = PROMOTION_CAP;
  const i = argv.indexOf("--cap");
  if (i >= 0) {
    const n = Number(argv[i + 1]);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`✗ --cap needs a positive integer (got ${argv[i + 1] ?? "nothing"}).`);
      process.exit(1);
    }
    cap = n;
  }
  return {
    apply:      argv.includes("--apply"),
    datasetKey: argv.includes("--dataset-key"),
    allowProd:  argv.includes("--allow-prod"),
    cap,
  };
}

function targetHost(): string {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  try {
    return new URL(url).host;
  } catch {
    return url || "(NEXT_PUBLIC_SUPABASE_URL unset)";
  }
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

function printPlan(plan: PromotionPlan): void {
  const rows = plan.toPromote;
  console.info(`\n  ${"member".padEnd(32)} ${"state".padEnd(5)} ${"fam".padEnd(14)} ${"elected id".padEnd(36)} ${"stub id".padEnd(36)} reason`);
  for (const p of rows) {
    console.info(
      `  ${p.fullName.padEnd(32)} ${p.state.padEnd(5)} ${p.roleFamily.padEnd(14)} ${p.electedId.padEnd(36)} ${p.candidateId.padEnd(36)} ${p.reason}`,
    );
  }
  if (rows.length === 0) console.info("  (no pairs)");
  console.info(
    `\n  detected=${plan.selection.pairs.length} planned=${rows.length} skipped_bound=${plan.selection.skippedBound}` +
      (plan.deferred > 0 ? ` deferred=${plan.deferred} (cap ${plan.cap})` : ""),
  );
  console.info(promotionCountersLine(plan));
}

async function main(args: Args): Promise<void> {
  const db = createAdminClient();
  const plan = await planCandidateToElectedPromotion({ db, datasetKey: args.datasetKey, cap: args.cap });
  printPlan(plan);

  if (!args.apply) {
    console.info("\n  --dry-run: plan only. Nothing was written (rule 141). Re-run with --apply to promote these pairs.");
    return;
  }
  if (plan.toPromote.length === 0) {
    console.info("\n  --apply: nothing to promote.");
    return;
  }
  const r = await runCandidateToElectedPromotion({ db, plan });
  if (r.failed > 0) process.exitCode = 1;
}

async function entry(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prod = isProd();
  if (prod && !args.allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }
  console.info("\n=== FIX-1189 — candidate → elected promotion (standalone) ===");
  console.info(`  target:      ${targetHost()}${prod ? "  ← PROD" : ""}`);
  console.info(`  mode:        ${args.apply ? "APPLY — promotes the planned pairs" : "DRY RUN — plan only, writes nothing"}`);
  console.info(`  dataset key: ${args.datasetKey ? "ON (pass 2)" : "off (name key only; --dataset-key to enable)"}`);
  console.info(`  cap:         ${args.cap}`);

  if (!args.apply) {
    await main(args);
    return;
  }
  if (prod) {
    console.info(`\n  ⚠ --apply against PROD host ${targetHost()} — starting in 5 s (Ctrl-C to abort)`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  // FIX-950 — the apply claims the supervised-prod-session lock for its run
  // (~17 s a pair). The dry run does not: the claim writes a label row, and a
  // dry run writes nothing.
  await runUnderProdSession({ script: "promote-candidates-run", expectedMinutes: 15 }, () => main(args));
}

entry().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
