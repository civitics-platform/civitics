/**
 * FIX-1274 C7 — the supervised USASpending bulk entry.
 *
 *   cd packages/data && pnpm run data:usaspending-bulk:prod -- --category contracts --max-minutes 240
 *   cd packages/data && pnpm run data:usaspending-bulk                    # local, both categories
 *   cd packages/data && pnpm run data:usaspending-bulk-assistance         # local, assistance only
 *
 * Every invocation runs under the FIX-950 supervised-session claim
 * (runUnderProdSession) — local too, so the clone walk-through exercises the
 * path prod runs. One claim per INVOCATION: a multi-invocation catch-up takes
 * and releases it each time, and a nested claim is refused. While it is held,
 * the nightly's writer blocks and the guarded pg_cron procedures defer, and a
 * usaspending-bulk.yml dispatch writes `skipped` instead of landing on top
 * (runUsaSpendingBulkCi). The CI path never claims: an unattended run holding
 * the interlock would be a nightly refusing itself.
 *
 * `force: false` on the claim: this script's own `--force` means "ignore the
 * baseline and re-run the Full", and must not ALSO claim over live writers.
 * When writers are live the claim refuses (exit 2) — wait for them.
 *
 * The dials (`--category`, `--max-parts`, `--max-minutes`, `--gate-wait-s`,
 * `--breather-s`, `--keep-archive`, `--local-archive`) are parsed by
 * pipelines/usaspending-bulk/flags.ts — the same parser the CI entry uses.
 * `--keep-archive` defaults ON here. The pipeline itself is
 * pipelines/usaspending-bulk/index.ts.
 *
 * Exit codes: 0 complete or a dial stop (`partial`, resumable); 1 a category
 * failed; 2 a refused flag or a refused claim.
 */

import { createAdminClient } from "@civitics/db";
import { runUnderProdSession } from "../lib/prod-session";
import {
  parseUsaSpendingFlags,
  UsaSpendingFlagError,
  type UsaSpendingFlags,
} from "../pipelines/usaspending-bulk/flags";
import { runUsaSpendingBulkInvocation } from "../pipelines/usaspending-bulk";

/** The claim's estimate: the wall dial when there is one. */
export const DEFAULT_EXPECTED_MINUTES = 240;

if (require.main === module) {
  let flags: UsaSpendingFlags;
  try {
    flags = parseUsaSpendingFlags(process.argv.slice(2), "standalone");
  } catch (err) {
    if (!(err instanceof UsaSpendingFlagError)) throw err;
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  // FIX-158's target guard BEFORE the claim — the claim connects through
  // buildDbUrl(), which does not consult --allow-prod.
  createAdminClient();

  runUnderProdSession(
    {
      script:          "usaspending-bulk",
      expectedMinutes: Math.ceil(flags.maxMinutes ?? DEFAULT_EXPECTED_MINUTES),
      force:           false,
    },
    async () => {
      const outcomes = await runUsaSpendingBulkInvocation(flags);
      process.exitCode = outcomes.some((o) => o.status === "failed") ? 1 : 0;
    },
  )
    .then(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
