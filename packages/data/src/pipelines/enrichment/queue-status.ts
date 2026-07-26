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

/**
 * `enrichment_queue.status` value for a task whose FEATURE was retired
 * (FIX-896 / FIX-898) — today, official `tag` tasks.
 *
 * DELIBERATELY DISTINCT from NO_SOURCE_TEXT_STATUS, and not merged with it. The
 * two look similar ("we're not going to process this") but mean opposite things
 * about the future:
 *
 *  - `skipped_no_source_text` says "the ENTITY isn't ready" — the task is still
 *    valid and FIX-895's `--reverse` sweep re-enters it the moment the entity
 *    acquires text. That reverse sweep re-derives eligibility from the text and
 *    knows nothing about which features exist.
 *  - `skipped_feature_retired` says "the TASK isn't valid" — no change to the
 *    entity can make it worth draining, because there is nothing left to drain
 *    it into. Collapsing the two would let the source-text reverse sweep
 *    resurrect a retired feature's backlog the first time an official's data
 *    changed shape.
 *
 * Same reader audit as NO_SOURCE_TEXT_STATUS applies (status is plain text with
 * no CHECK constraint, `claim_enrichment_batch` and the FIX-820/822 partial
 * indexes are all `WHERE status='pending'`, `enqueue_enrichment` won't overwrite
 * a non-done/non-failed status, `--reclaim` only moves 'processing').
 *
 * Rows are MARKED, never deleted: `data:sweep-official-tags --reverse` returns
 * them to 'pending' if the decision is ever reversed.
 */
export const FEATURE_RETIRED_STATUS = "skipped_feature_retired";
