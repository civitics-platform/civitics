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
