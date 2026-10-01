/**
 * Votes backfill — FIX-051.
 *
 * One-shot script to backfill roll-call votes for historical Congresses.
 * Current state: we've been ingesting only the 119th (the "current"
 * congress). This script walks 117 → 118 → 119 so the votes table has
 * ~227k rows instead of ~51k.
 *
 * How it works: the CURRENT_CONGRESS constant in members.ts is read from the
 * CONGRESS_OVERRIDE env var (falling back to 119). This script spawns a child
 * tsx process per target congress so the env is fresh each time — you can't
 * reset a module-level const after import.
 *
 * Run:
 *   pnpm --filter @civitics/data data:votes-backfill
 *
 * Expected runtime: ~2–3 hours end-to-end (Congress.gov caps us at 5k req/hr).
 * Safe to interrupt: each run is incremental, the next pass resumes from where
 * the last left off (votes.ts has a per-roll skip-if-exists guard).
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

const TARGET_CONGRESSES = [117, 118, 119];

async function runOneCongress(congress: number): Promise<number> {
  return new Promise((resolve) => {
    console.info(`\n── Backfilling ${congress}th Congress ─────────────────────`);
    // Forward our argv (e.g. --allow-prod) so the child's pipeline guard
    // sees the same flags. process.argv = [node, this-script, ...userArgs].
    const userArgs = process.argv.slice(2);
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        path.join(__dirname, "votes.ts"),
        ...userArgs,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CONGRESS_OVERRIDE: String(congress),
        },
      },
    );
    child.on("exit", (code) => {
      console.info(`── ${congress}th exit code: ${code ?? "null"} ─────────────`);
      resolve(code ?? 1);
    });
  });
}

async function main() {
  console.info("=== Votes backfill — FIX-051 ===");
  console.info(`Target congresses: ${TARGET_CONGRESSES.join(", ")}`);
  console.info("This may take 2–3 hours. Safe to interrupt and re-run.\n");

  for (const c of TARGET_CONGRESSES) {
    const code = await runOneCongress(c);
    if (code !== 0) {
      console.error(`\n❌ ${c}th failed (exit ${code}). Re-run to resume.`);
      process.exit(code);
    }
  }

  console.info("\n✓ Backfill complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
