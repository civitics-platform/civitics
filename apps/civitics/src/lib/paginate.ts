/**
 * FIX-476 — page through a row-capped PostgREST query so the full set is
 * assembled rather than silently truncated at the server max_rows ceiling
 * (1000). An explicit `.limit(N>1000)` does NOT raise the ceiling, so any query
 * whose result feeds a SUM / count / complete roster must page instead.
 *
 * `build(from, to)` must return a FRESH query each call with `.range(from, to)`
 * applied AND a stable, total `.order()` (a unique tiebreaker such as `id`) —
 * `.range()` over a non-total order double-counts or skips rows across pages.
 *
 * Mirrors the local helper in app/api/graph/connections/route.ts (FIX-428);
 * shared here so the FIX-476 sweep doesn't re-implement it per call site.
 */
const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { maxRows?: number } = {},
): Promise<{ rows: T[]; error: { message: string } | null; truncated: boolean }> {
  const ceiling = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error, truncated: false };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;       // short page → exhausted
    from += PAGE_SIZE;
    if (rows.length >= ceiling) return { rows, error: null, truncated: true };
  }
  return { rows, error: null, truncated: false };
}

// ── Chunked reads by id list (FIX-901) ────────────────────────────────────────

/**
 * Max ids per `.in()` filter. This is a URL-LENGTH bound, not a row bound.
 *
 * supabase-js encodes `.in()` into the request URL, so the id list rides the
 * request line. Past roughly 200 uuids the URL exceeds the gateway's header
 * limit and Kong answers 414 "URI too long" BEFORE PostgREST sees the query
 * (414 verified at ~234 uuids in FIX-772 and ~356 in FIX-509).
 *
 * Do NOT reason about this in terms of PostgREST's 1,000-row `max_rows` cap —
 * that is a different, larger ceiling handled by `fetchAllRows` above. A list
 * of 400 ids is well under the row cap and still dies here.
 */
export const ID_CHUNK_SIZE = 200;

export type ChunkedFetchResult<T> = {
  /** Rows from every chunk that succeeded, in chunk order. */
  rows: T[];
  /**
   * Chunks that failed, in issue order. EMPTY does not mean "no rows" — it
   * means every request came back. Check this before treating `rows` as whole.
   */
  failed: Array<{ index: number; ids: string[]; error: { message: string } }>;
  /** `failed.length === 0` — the only safe basis for "this read is complete". */
  complete: boolean;
  /** Requests issued. 0 for an empty id list (no `.in("id", [])` is sent). */
  chunkCount: number;
};

/**
 * Read rows by a list of ids, chunked so the request URL never outgrows the
 * gateway (see `ID_CHUNK_SIZE`). Chunks are issued in parallel.
 *
 * ── The failure mode this exists to prevent ──────────────────────────────────
 *
 * An `.in()` over an unbounded id list is the most-repeated bug in this
 * codebase — four independent instances (FIX-509, FIX-514, FIX-774, FIX-899).
 * The mechanism is always the same and always SILENT: the oversized URL is
 * rejected by the gateway, `withDbTimeout` turns that into `{ data: null }`,
 * and the call site's `?? []` renders the failure as an empty result on an
 * HTTP 200. Nothing logs. Nothing 500s. The data is just gone.
 *
 * FIX-899 is the case that justified a shared helper: `app/officials/page.tsx`
 * fetched tags with one `.in()` over ~1,000 officials (~40 KB URL), so EVERY
 * official card rendered zero tag pills, silently, for months. It surfaced only
 * because FIX-897 added industry pills to that surface and they didn't appear.
 * A comment fifteen lines above that read already warned about this exact trap
 * for a different fetch — comments don't enforce, so this does.
 *
 * ── Why the return type is an object and not `T[]` ───────────────────────────
 *
 * A helper that returned a bare array and dropped a failed chunk would
 * reproduce the exact bug class one layer down — the caller could not tell a
 * short read from a complete one. So partial failure is REPORTED and the caller
 * decides what it means for its surface:
 *
 *   - default (`strict` off): failed chunks are recorded in `failed`, the rows
 *     that did come back are returned, and `complete` is false. Correct where
 *     partial beats nothing (FIX-899's tag pills degrade to partial tags).
 *   - `strict: true`: the first chunk error is thrown. Correct where a short
 *     read is worse than an error — e.g. graph name lookups, where missing rows
 *     render as "Unknown"-labeled nodes on an HTTP 200 (FIX-431/FIX-732).
 *
 * Ids are deduped and empty/nullish entries dropped before chunking; an empty
 * list short-circuits to zero requests.
 *
 * `build` receives the chunk plus a `ctx` carrying the chunk index and a
 * ready-made per-chunk label, so it composes with `withDbTimeout` directly:
 *
 *   const { rows, complete } = await fetchChunkedByIds<TagRow>(
 *     officialIds,
 *     (ids, { label }) => withDbTimeout(
 *       supabase.from("entity_tags").select("...").in("entity_id", ids), 3000, label),
 *     { label: "officials:directory-tags" },
 *   );
 */
export async function fetchChunkedByIds<T>(
  ids: ReadonlyArray<string | null | undefined>,
  build: (
    chunk: string[],
    ctx: { index: number; label: string },
  ) => PromiseLike<{ data: unknown; error?: { message: string } | null }>,
  opts: { chunkSize?: number; strict?: boolean; label?: string } = {},
): Promise<ChunkedFetchResult<T>> {
  const size = Math.max(1, opts.chunkSize ?? ID_CHUNK_SIZE);
  const base = opts.label ?? "chunked-in";

  // Dedupe + drop empty/nullish. Deduping ids is row-preserving (PostgREST
  // returns a matching row once regardless of how often its id is listed) and
  // keeps a caller's repeated ids from inflating the chunk count.
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  if (clean.length === 0) return { rows: [], failed: [], complete: true, chunkCount: 0 };

  const chunks: string[][] = [];
  for (let i = 0; i < clean.length; i += size) chunks.push(clean.slice(i, i + size));

  const results = await Promise.all(
    chunks.map((chunk, index) => build(chunk, { index, label: `${base}:${index}` })),
  );

  const rows: T[] = [];
  const failed: ChunkedFetchResult<T>["failed"] = [];
  for (let index = 0; index < results.length; index++) {
    const r = results[index]!;
    if (r.error) {
      if (opts.strict) throw r.error;
      console.error(
        `[fetchChunkedByIds] ${base} chunk ${index}/${chunks.length} failed ` +
          `(${chunks[index]!.length} ids) — partial result:`,
        r.error.message,
      );
      failed.push({ index, ids: chunks[index]!, error: r.error });
      continue;
    }
    rows.push(...((r.data ?? []) as T[]));
  }

  return { rows, failed, complete: failed.length === 0, chunkCount: chunks.length };
}
