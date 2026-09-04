/**
 * FIX-545 — fail-loud read helpers for PostgREST SELECTs.
 *
 * The silent-zero class: `const { data } = await db.from(...).select(...)`
 * with no `error` check turns any transient gateway/PostgREST failure into
 * an empty result set. When that result feeds a preload Map/Set, downstream
 * matching sees "nothing exists yet" and re-does work from scratch while the
 * run looks clean (FIX-422 county skips; the FIX-294 LittleSis rerun where a
 * dead local Kong zeroed the known-ids preload and re-matched all 440k
 * entities). These helpers make the safe shape — throw on error, paginate
 * past PostgREST's 1,000-row cap — the importable default.
 *
 * Both are client-agnostic on purpose: they take a result / page factory,
 * not a db handle, so they compose with admin, server, and browser clients
 * (and with the `db as any` shims some pipelines use).
 */

export interface ReadResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Single-page read: throw on error, else return rows (never null).
 * Generalizes the FIX-422 local helper from
 * jurisdictions-boundary-backfill/index.ts.
 */
export function rowsOrThrow<T>(res: ReadResult<T>, label: string): T[] {
  if (res.error) throw new Error(`${label} read failed: ${res.error.message}`);
  return res.data ?? [];
}

export interface SelectAllOptions {
  /** Rows per page. Default 1000 (PostgREST's default max_rows). */
  pageSize?: number;
  /**
   * Floor assertion: throw if the total row count comes back below a known
   * minimum. Use when "fewer than N rows" can only mean a degraded read
   * (e.g. the 50 states), not a legitimately small table.
   */
  minRows?: number;
  /**
   * Per-page retries before throwing. Default 2 (3 attempts total, 250ms →
   * 1s backoff). Long pagination runs reliably hit one dropped connection
   * (local Kong drops one somewhere past ~200 sequential fetches); a bounded
   * retry keeps the read usable without ever returning a partial set — the
   * fail-loud contract is unchanged, it just survives a single blip.
   */
  retries?: number;
}

/**
 * Auto-paginating read: fetch pages of `pageSize` until a short page, throw
 * on ANY page error (never return a partial set), return all rows.
 *
 * OFFSET pagination — prefer `selectAllKeyset` (FIX-984) and use this ONLY
 * where the query has no unique, non-null, indexed column to key on (a
 * multi-column MV grain, a `.in()` over several values of the would-be key),
 * or where a measured plan showed keyset could not be served by an index
 * range scan. Page k of an OFFSET walk produces and discards k x pageSize
 * rows server-side, so a full walk is quadratic and the deep pages are the
 * expensive ones. Whatever the reason for staying here, the query MUST carry
 * a TOTAL `.order()` (a unique tiebreaker): `.range()` over a non-total order
 * double-counts or skips rows across pages regardless of cost.
 *
 * `page(from, to)` should apply `.range(from, to)` to the query, e.g.:
 *
 *   const refs = await selectAllOrThrow("littlesis refs", (from, to) =>
 *     db.from("external_source_refs")
 *       .select("external_id, entity_id")
 *       .eq("source", "littlesis")
 *       .range(from, to));
 */
export async function selectAllOrThrow<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<ReadResult<T>>,
  opts?: SelectAllOptions,
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const retries = opts?.retries ?? 2;
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let rows: T[] | null = null;
    for (let attempt = 0; ; attempt++) {
      const res = await page(from, from + pageSize - 1);
      if (!res.error) {
        rows = res.data ?? [];
        break;
      }
      if (attempt >= retries) {
        throw new Error(
          `${label} read failed (rows ${from}-${from + pageSize - 1}, ${attempt + 1} attempts): ${res.error.message}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  if (opts?.minRows !== undefined && out.length < opts.minRows) {
    throw new Error(`${label} read returned ${out.length} rows, expected at least ${opts.minRows}`);
  }
  return out;
}

// ── Keyset pagination (FIX-984) ──────────────────────────────────────────────

/**
 * A keyset cursor value. Must be a type whose JS `>` ordering agrees with the
 * ORDER BY the page query applies — `string` (uuid / text, btree default
 * collation) or `number`. Timestamps are safe only as ISO-8601 strings.
 */
export type KeysetCursor = string | number;

export interface KeysetOptions<T, K extends KeysetCursor> {
  /**
   * Extracts the cursor from a row. THE KEY MUST BE UNIQUE, NON-NULL AND
   * INDEXED within the page query's filter — the loop asks for
   * `key > <last seen>`, so two rows sharing a key means the second is SKIPPED,
   * silently. Uniqueness may come from the column itself (a pkey `id`) or from
   * the filter (`entity_id` is unique once `entity_type`, `tag_category` and
   * `tag` are all pinned by `.eq()` under the
   * `entity_tags_entity_type_entity_id_tag_tag_category_key` constraint).
   */
  key: (row: T) => K;
  /**
   * Rows per page. Default 1000 (PostgREST's `max_rows`).
   *
   * NEVER set this above 1000 for a PostgREST walk. PostgREST silently caps the
   * response at `max_rows` regardless of the `.limit()` you send, so a
   * pageSize of, say, 5000 would return 1000 rows, the loop would read that as
   * a short page, and the walk would stop after the FIRST page having returned
   * a fifth of the table with no error. (The same trap existed for `.range()`
   * spans wider than 1000.) Larger values are only correct when `page` goes to
   * a direct pg connection, which is not the case for any caller in this repo
   * today -- the direct-pg walks hand-roll their own loops.
   */
  pageSize?: number;
  /** Floor assertion — `selectAllKeyset` only. See `SelectAllOptions.minRows`. */
  minRows?: number;
  /**
   * Safety ceiling. Once the accumulated row count reaches it the walk stops
   * early and reports `truncated: true` (`fetchAllKeyset`) — the
   * `fetchAllRows`/`fetchAllPaged` contract this replaces.
   */
  maxRows?: number;
  /**
   * Per-page retries before giving up. Defaults differ by wrapper so each
   * preserves the contract it replaces: `selectAllKeyset` → 2 (three attempts,
   * 250ms → 1s backoff, as `selectAllOrThrow`), `fetchAllKeyset` → 0 (return on
   * the first page error, as `fetchAllRows`).
   */
  retries?: number;
}

export interface KeysetResult<T> {
  rows: T[];
  /** First failing page's error, or null. Never swallowed. */
  error: { message: string } | null;
  /** `maxRows` was reached before the walk exhausted. */
  truncated: boolean;
}

/**
 * Keyset ("seek") pagination — the O(n) replacement for `.range()` walks.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * `.range(from, to)` is OFFSET pagination. Page k makes the server produce and
 * DISCARD k × pageSize rows before returning any, so a full walk is O(n²) in
 * pages and the deep pages are the expensive ones. Measured on prod
 * (2026-09-04), one page at the tail of a walk:
 *
 *   external_source_refs (source='littlesis', 353,995 rows)
 *     OFFSET 353000 → cost 29,110 · 590,581 buffers · 10,761 ms
 *     keyset        → cost    181 ·       757 buffers ·     99 ms
 *   financial_entities (5,204,854 rows)
 *     OFFSET 5200000 → cost 1,005,602 · 245,569 buffers + 374 MB temp · 36,420 ms
 *     keyset         → cost     1,065 ·       949 buffers ·                893 ms
 *
 * The OFFSET plans are not merely slower — the second one seq-scans and
 * external-merge-sorts the whole table ONCE PER PAGE, for 5,205 pages.
 *
 * ── The trap ────────────────────────────────────────────────────────────────
 *
 * Keyset is O(n) only when ONE index range scan serves the page predicate. If
 * the planner instead fetches every row matching the filter and top-N sorts it
 * by the key, each page is O(matches) again and nothing was gained. Check the
 * plan of any walk that matters: the `key > $1` must appear as an *Index Cond*,
 * not as a *Filter* under a *Sort*.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const refs = await selectAllKeyset<RefRow, string>(
 *     "littlesis refs",
 *     (after, limit) => {
 *       let q = db.from("external_source_refs")
 *         .select("external_id, entity_id")
 *         .eq("source", "littlesis")
 *         .order("external_id")
 *         .limit(limit);
 *       if (after !== null) q = q.gt("external_id", after);
 *       return q;
 *     },
 *     { key: (r) => r.external_id },
 *   );
 *
 * `page` receives the cursor (null on the first page) and the page size, so the
 * caller never has to keep a `pageSize` constant in sync with the helper's.
 *
 * This is the soft variant: a page error is RETURNED, not thrown, and the rows
 * that did arrive come back alongside it. `complete` is `error === null &&
 * !truncated`. For the fail-loud contract use `selectAllKeyset`.
 */
export async function fetchAllKeyset<T, K extends KeysetCursor>(
  label: string,
  page: (after: K | null, limit: number) => PromiseLike<ReadResult<T>>,
  opts: KeysetOptions<T, K>,
): Promise<KeysetResult<T>> {
  const pageSize = opts.pageSize ?? 1000;
  const retries = opts.retries ?? 0;
  const ceiling = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const out: T[] = [];
  let after: K | null = null;

  for (;;) {
    let rows: T[];
    for (let attempt = 0; ; attempt++) {
      const res = await page(after, pageSize);
      if (!res.error) {
        rows = res.data ?? [];
        break;
      }
      if (attempt >= retries) {
        return {
          rows: out,
          error: {
            message: `${label} read failed (after=${after === null ? "<start>" : String(after)}, ${attempt + 1} attempt${attempt ? "s" : ""}): ${res.error.message}`,
          },
          truncated: false,
        };
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }

    out.push(...rows);
    if (rows.length < pageSize) break; // short page → exhausted

    const next = opts.key(rows[rows.length - 1]!);
    // A cursor that fails to advance is a BUG, not a transient read failure —
    // a non-unique key, a missing/mismatched ORDER BY, or a `key` extractor
    // reading the wrong column. Left unchecked it either loops forever or
    // silently skips every row sharing the repeated key. Throw in both
    // variants: there is no partial result worth returning from a walk whose
    // pagination is unsound.
    if (next === null || next === undefined) {
      throw new Error(`${label}: keyset key is null/undefined on the last row of a full page`);
    }
    if (after !== null && !(next > after)) {
      throw new Error(
        `${label}: keyset cursor did not advance (${String(after)} → ${String(next)}) — ` +
          `the key must be unique and non-null under this query's filter, and the query must ORDER BY it ascending`,
      );
    }
    after = next;

    if (out.length >= ceiling) return { rows: out, error: null, truncated: true };
  }

  return { rows: out, error: null, truncated: false };
}

/**
 * Applies a keyset cursor to a PostgREST filter builder: `q.gt(column, after)`
 * when there is a cursor, `q` untouched on the first page.
 *
 * Exists purely so a call site stays ONE expression. Without it every converted
 * walk grows a `let q = …; if (after !== null) q = q.gt(…); return q;` block,
 * and forty of those is forty chances to write the wrong column name into the
 * `.gt()` while the `.order()` above it says something else — the exact
 * mismatch that makes a keyset walk skip rows. Pass the same column to
 * `.order()` and to this, and read the `key` extractor against both.
 *
 * The builder is only required to have `.gt`; every PostgREST filter builder
 * does, including the `as any` shims several pipelines use.
 */
export function afterKey<Q>(q: Q, column: string, after: KeysetCursor | null): Q {
  if (after === null) return q;
  return (q as unknown as { gt: (c: string, v: KeysetCursor) => Q }).gt(column, after);
}

/**
 * Fail-loud keyset walk — the FIX-545 contract (`selectAllOrThrow`) on FIX-984
 * pagination. Throws on ANY page error rather than ever returning a partial
 * set, honours `minRows`, and retries a page twice by default.
 *
 * See `fetchAllKeyset` for the mechanism, the measured OFFSET-vs-keyset costs,
 * and the plan-shape trap. Use this everywhere a short read would be consumed
 * as if complete (preload Maps/Sets, DELETE-then-reinsert rebuilds); use
 * `fetchAllKeyset` where the caller degrades gracefully and needs `truncated`.
 */
export async function selectAllKeyset<T, K extends KeysetCursor>(
  label: string,
  page: (after: K | null, limit: number) => PromiseLike<ReadResult<T>>,
  opts: KeysetOptions<T, K>,
): Promise<T[]> {
  const res = await fetchAllKeyset<T, K>(label, page, { retries: 2, ...opts });
  if (res.error) throw new Error(res.error.message);
  if (opts.minRows !== undefined && res.rows.length < opts.minRows) {
    throw new Error(
      `${label} read returned ${res.rows.length} rows, expected at least ${opts.minRows}`,
    );
  }
  return res.rows;
}


// ---------------------------------------------------------------------------
// Relocated from apps/civitics/src/lib/paginate.ts by FIX-1037. It lived in
// apps/ because FIX-901 was an apps/ fix; packages cannot import from apps, so
// every growth-prone `.in()` id list under packages/ was structurally unable to
// use it (the FIX-902 audit's stated reason for scoping itself to apps/ only).
// `@/lib/paginate` re-exports these names, so apps/ import paths are unchanged.
// ---------------------------------------------------------------------------

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

/**
 * Max chunks in flight per `fetchChunkedByIds` call (FIX-926).
 *
 * This bounds ONE call site's share of the shared connection/socket budget —
 * the sockets, the PostgREST worker pool, and the gateway's per-origin
 * concurrency. It is NOT a latency budget (nothing here times anything; that is
 * `withDbTimeout`'s job at the call site) and it is NOT a row bound. The two
 * constants in this file guard two entirely different ceilings and conflating
 * them is the whole history of this bug class:
 *
 *   ID_CHUNK_SIZE        → how WIDE one request may be   (URL length, 414)
 *   ID_CHUNK_CONCURRENCY → how MANY may be open at once  (connection budget)
 *
 * Sized so real call sites are unaffected and only pathological lists throttle.
 * The largest plausible input as FIX-902 migrates the remaining `.in()` sites is
 * the full active-officials set — 27,193 ids → 136 chunks → 136 simultaneous
 * PostgREST requests from a single request handler under the old unbounded
 * `Promise.all`. Six keeps that to a queue instead of a stampede.
 *
 * KNOWN LIMIT — the cap is PER CALL, not global. A route issuing N concurrent
 * `fetchChunkedByIds` calls can still have up to N × maxConcurrency requests in
 * flight; `app/api/graph/connections/route.ts` does exactly that with seven
 * concurrent calls inside one `Promise.all`. A shared module-level limiter
 * would bound the route-wide total and is deliberately OUT of scope here — it
 * was considered, not missed. Per-call is the right granularity for a helper
 * that has no idea what else the handler is doing.
 */
export const ID_CHUNK_CONCURRENCY = 6;

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
 * gateway (see `ID_CHUNK_SIZE`). Chunks are issued in parallel, at most
 * `maxConcurrency` (default `ID_CHUNK_CONCURRENCY`) in flight at a time.
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
 * ── Concurrency (FIX-926) ──────────────────────────────────────────────────────
 *
 * `maxConcurrency` (default `ID_CHUNK_CONCURRENCY`, clamped to ≥ 1) bounds how
 * many chunks are open at once. It is purely a SCHEDULING concern and is
 * invisible in the output for any input: `rows` stay in chunk order, `failed`
 * stays in chunk-index order, `chunkCount` is unaffected, and — importantly —
 * `strict` still issues EVERY chunk before throwing. A pool that cancelled the
 * queue on the first error would change the failure semantics, not just the
 * pacing; `paginate.test.ts` pins that.
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
  opts: {
    chunkSize?: number;
    strict?: boolean;
    label?: string;
    maxConcurrency?: number;
  } = {},
): Promise<ChunkedFetchResult<T>> {
  const size = Math.max(1, opts.chunkSize ?? ID_CHUNK_SIZE);
  const concurrency = Math.max(1, opts.maxConcurrency ?? ID_CHUNK_CONCURRENCY);
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

  // Bounded worker pool. `concurrency` workers pull from a shared cursor and
  // write into `results` BY CHUNK INDEX, so ordering is a property of the array
  // slot rather than of completion order — out-of-order completion (the normal
  // case under a cap) can't reshuffle `rows` or `failed`.
  //
  // No worker abandons the queue on a failure of any kind — every chunk is
  // issued before this function throws, whether the trigger is `strict` on an
  // `{error}` result or a rejected build(). Hand-rolled: a dependency for
  // twenty lines would be the more surprising choice.
  type ChunkResult = { data: unknown; error?: { message: string } | null };
  const results: ChunkResult[] = new Array(chunks.length);
  const rejections: unknown[] = new Array(chunks.length);
  let rejected = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= chunks.length) return;
      try {
        results[index] = await build(chunks[index]!, {
          index,
          label: `${base}:${index}`,
        });
      } catch (err) {
        // A REJECTED build() is not a failed chunk — a failed chunk is the
        // `{error}` result shape below. Park it and keep draining, so the
        // "every chunk is issued" property holds, then rethrow once the pool is
        // empty. That is what the old `Promise.all(chunks.map(build))` did:
        // issue everything, then propagate. Swallowing it into `failed` would
        // hide a thrown builder behind a soft partial result.
        rejections[index] = err;
        rejected = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );
  if (rejected) {
    for (let i = 0; i < rejections.length; i++) {
      if (i in rejections) throw rejections[i];
    }
  }

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
