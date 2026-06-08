/**
 * FIX-527 (C1 Wave B) — comment bridge scorer driver.
 *
 * Runs recompute_comment_bridge_scores() (full sweep) over the direct-pg
 * heavy-rebuild path — the scorer is a set-based UPDATE that aggregates
 * comment_ratings + entity_positions into entity_comments.bridge_score/map_x/
 * map_y, so it stays server-side (rating data never leaves the DB) and routes
 * around the ~100s PostgREST gateway cap like the other heavy rebuilds.
 *
 * After scoring, records a `comment_scorer` watermark in pipeline_state so a
 * future incremental mode (only entities with rating/position activity since
 * last_run) is a drop-in. The nightly orchestrator calls scoreComments()
 * directly (packages/data/src/pipelines/index.ts); this file is also the
 * `data:score-comments` CLI entry.
 *
 * Throws (non-zero exit) on any error — never log-and-continue. A silent failure
 * would leave bridge_score stale and the debate map wrong with no signal.
 */

import { runHeavyRebuild } from "../lib/heavy-rebuild";
import { withDirectClient } from "../lib/direct-pg-upsert";

export interface ScoreCommentsResult {
  scored: number;
  ran_at: string;
}

/**
 * Full-sweep recompute + watermark upsert. Returns the number of comments that
 * now carry a non-NULL bridge_score. Throws on failure.
 *
 * Both the scoring call and the watermark write go over direct pg.Client — the
 * scorer is already a server-side set-based aggregation, so routing the
 * watermark the same way keeps the whole step on one mechanism and free of any
 * PostgREST/gateway dependency (the nightly enrichment phase calls this inline).
 */
export async function scoreComments(): Promise<ScoreCommentsResult> {
  const scored = await runHeavyRebuild("recompute_comment_bridge_scores");
  const ranAt = new Date().toISOString();

  await withDirectClient(async (client) => {
    await client.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('comment_scorer', $1::jsonb, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ last_run: ranAt, scored_count: scored }), ranAt],
    );
  });

  return { scored, ran_at: ranAt };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
async function main() {
  console.log("[score-comments] recomputing comment bridge scores (full sweep)…");
  const { scored, ran_at } = await scoreComments();
  console.log(`[score-comments] done — ${scored} comment(s) scored; watermark @ ${ran_at}`);
}

// Run only when invoked directly (not when imported by the orchestrator).
const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /score-comments(\.ts|\.js)?$/.test(process.argv[1] ?? "");

if (isDirect) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[score-comments] failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
