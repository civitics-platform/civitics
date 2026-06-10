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
