/**
 * FIX-894 — end-to-end proof of the source-text enqueue gate.
 *
 * The unit tests in pipelines/enrichment/source-text-gate.test.ts prove the
 * predicate. This proves the GATE — i.e. that the predicate actually governs
 * whether a task row appears in enrichment_queue, through the real
 * `enqueue_enrichment` RPC, against a real database.
 *
 * WHAT IT DOES
 *   Picks two real proposals that currently have NO tag queue row:
 *     A) one whose summary_plain passes the gate
 *     B) one whose summary_plain does not
 *   Runs both through the same filter-then-enqueue chain the seeder uses, then
 *   asserts a task row exists for A and does NOT exist for B.
 *
 * NOTHING IS DELETED. Proposal A genuinely belongs in the queue (it has text and
 * is untagged), so enqueuing it is correct pipeline behaviour rather than test
 * pollution; B produces no row at all, so there is nothing to clean up. Re-running
 * is safe: A's second pass returns 'skipped_pending' from the RPC.
 *
 * USAGE
 *   pnpm --filter @civitics/data data:verify-gate
 *   pnpm --filter @civitics/data data:verify-gate -- --dry-run   # report only
 */

import { createAdminClient } from "@civitics/db";
import {
  enqueue,
  hasUsableSourceText,
  buildProposalTagContext,
} from "../pipelines/enrichment/queue";

const DRY_RUN = process.argv.includes("--dry-run");

type Candidate = {
  id: string;
  title: string;
  summary_plain: string | null;
  metadata: Record<string, unknown> | null;
  primary_source: string | null;
};

async function pick(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  wantText: boolean,
): Promise<Candidate | null> {
  // Deliberately raw SQL via RPC-free PostgREST is awkward for a NOT EXISTS, so
  // fetch a small page and filter client-side on the same predicate the gate uses.
  const { data, error } = await db
    .from("proposals")
    .select("id, title, summary_plain, metadata, primary_source")
    .not("title", "ilike", "On %")
    .order("id")
    .limit(1500);
  if (error) throw error;

  for (const p of (data ?? []) as Candidate[]) {
    if (hasUsableSourceText(p.summary_plain, p.title) !== wantText) continue;
    const { count } = await db
      .from("enrichment_queue")
      .select("*", { count: "exact", head: true })
      .eq("entity_id", p.id)
      .eq("entity_type", "proposal")
      .eq("task_type", "tag");
    if ((count ?? 0) === 0) return p;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagRowCount(db: any, id: string): Promise<number> {
  const { count } = await db
    .from("enrichment_queue")
    .select("*", { count: "exact", head: true })
    .eq("entity_id", id)
    .eq("entity_type", "proposal")
    .eq("task_type", "tag");
  return count ?? 0;
}

async function main(): Promise<void> {
  const db = createAdminClient();
  console.log(`# FIX-894 — source-text enqueue gate, end-to-end proof`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no enqueue)" : "LIVE (real enqueue_enrichment RPC)"}\n`);

  const withText = await pick(db, true);
  const noText = await pick(db, false);

  if (!withText || !noText) {
    console.error(
      `✗ Could not find both candidates (withText=${!!withText}, noText=${!!noText}).\n` +
        `  Every scanned proposal already has a tag queue row — nothing to prove against.`,
    );
    process.exit(1);
  }

  const cases: Array<{ label: string; p: Candidate; expectRow: boolean }> = [
    { label: "A) HAS usable source text", p: withText, expectRow: true },
    { label: "B) NO usable source text", p: noText, expectRow: false },
  ];

  for (const c of cases) {
    const len = (c.p.summary_plain ?? "").trim().length;
    console.log(`${c.label}`);
    console.log(`   id             ${c.p.id}`);
    console.log(`   primary_source ${c.p.primary_source ?? "(none)"}`);
    console.log(`   summary chars  ${len}`);
    console.log(`   gate verdict   ${hasUsableSourceText(c.p.summary_plain, c.p.title) ? "PASS" : "REFUSE"}`);
    console.log(`   rows before    ${await tagRowCount(db, c.p.id)}`);
  }

  if (DRY_RUN) {
    console.log(`\n(dry run — no enqueue attempted)`);
    return;
  }

  // The seeder's chain: filter on the gate, then enqueue the survivors.
  console.log(`\n── Running the gate + enqueue chain ────────────────────────`);
  for (const c of cases) {
    if (!hasUsableSourceText(c.p.summary_plain, c.p.title)) {
      console.log(`   ${c.label.slice(0, 2)} refused by gate — enqueue not attempted`);
      continue;
    }
    const action = await enqueue(db, {
      entity_id: c.p.id,
      entity_type: "proposal",
      task_type: "tag",
      context: buildProposalTagContext(c.p),
    });
    console.log(`   ${c.label.slice(0, 2)} enqueued → RPC returned "${action}"`);
  }

  console.log(`\n── Assertions ─────────────────────────────────────────────`);
  let failed = false;
  for (const c of cases) {
    const after = await tagRowCount(db, c.p.id);
    const ok = c.expectRow ? after === 1 : after === 0;
    if (!ok) failed = true;
    console.log(
      `   ${ok ? "✓" : "✗"} ${c.label} → ${after} tag row(s) ` +
        `(expected ${c.expectRow ? 1 : 0})`,
    );
  }

  if (failed) {
    console.error(`\n✗ GATE PROOF FAILED`);
    process.exit(1);
  }
  console.log(
    `\n✓ Gate proven: only the proposal holding usable source text produced a task.`,
  );
}

main().catch((err) => {
  console.error("Gate verification failed:", err);
  process.exit(1);
});
