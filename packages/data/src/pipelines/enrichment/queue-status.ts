/**
 * Enrichment-queue status vocabulary — deliberately dependency-free.
 *
 * Why its own module (FIX-895): `queue.ts` transitively imports `pg` (via
 * `../../lib/heavy-rebuild` → `rollupJsonbDirect`), and the drain-side scripts
 * must not pull a native database driver in just to name a status string. This
 * is the same seam FIX-890 established when it moved the tag vocabulary out of
 * `queue.ts` into `tags/topics.ts`. `queue.ts` re-exports from here, so pipeline
 * code can keep importing from the module it already uses.
 */

/**
 * `enrichment_queue.status` value for a row whose entity holds no usable source
 * text (FIX-894 / FIX-895).
 *
 * `status` is plain `text NOT NULL DEFAULT 'pending'` with no CHECK constraint
 * and no enum (supabase/migrations/20260420030000_enrichment_queue.sql), so
 * introducing this value needs no migration. Every reader was audited first:
 *
 *  - `claim_enrichment_batch` filters `WHERE status = 'pending'`, so marked rows
 *    are never claimed by a drain worker. The FIX-820/822 partial claim indexes
 *    are likewise `WHERE status='pending'`, so marked rows drop out of them.
 *  - `enqueue_enrichment` returns 'skipped_pending' WITHOUT touching a row whose
 *    status is neither 'done' nor ('failed' AND retry_count < 3) — so a mark
 *    survives a pipeline re-enqueue.
 *  - `record_enrichment_failure` only ever acts on an already-claimed row id.
 *  - Backlog counts (`/api/claude/status`, `data:drain:status`) count
 *    `status='pending'` per task_type, so backlog depth correctly drops.
 *  - `data:drain:status --reclaim` only ever moves 'processing' → 'pending'.
 *
 * Rows are MARKED, never deleted: `data:sweep-no-text --reverse` returns them to
 * 'pending' once text actually arrives.
 */
export const NO_SOURCE_TEXT_STATUS = "skipped_no_source_text";
