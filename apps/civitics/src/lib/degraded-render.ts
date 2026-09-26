/**
 * FIX-1227 — a render whose reads degraded must not be the cached one.
 *
 * `withDbTimeout` resolves `{ data: null, error }` when a read runs out of
 * time — it never throws — and every page folds that into `.data ?? []`. On a
 * `revalidate = 300` page that render used to be cached and served for five
 * minutes as empty lists and zero stats, indistinguishable from a real empty
 * record (cc-161 read 5: a locked donor page rendered MISS with Donors=0, then
 * HIT with the same zeros after the lock was gone). So `withDbTimeout` records
 * each read that did not complete into this request's sink, and each
 * `revalidate` page calls `assertRenderNotDegraded()` once, after its reads.
 *
 * ── What the helper's `noStore()` does on these pages (measured, cc-161 read 6)
 *
 * `unstable_noStore()` inside an ISR render throws DynamicServerError, and
 * next@14.2.35 answers that render with "Page changed from static to dynamic
 * at runtime":
 *   - FIRST render of a path (nothing cached yet): HTTP 500, Next's bare
 *     "500: Internal Server Error" page, `Cache-Control: private, no-cache,
 *     no-store, max-age=0, must-revalidate`, not cached. The next request
 *     re-renders.
 *   - BACKGROUND revalidation of a cached path: the visitor gets the last good
 *     page (`x-nextjs-cache: STALE`); the failed revalidation shortens the entry
 *     to `s-maxage=3`, and the next request retries.
 * A `loading.tsx` above the page changes neither: an ISR render is buffered
 * whole before it is cached, so the Suspense boundary never streams a 200.
 * A plain `throw` measured identical (500, private no-store, uncached) with and
 * without one, so the helper does not ALSO throw — one mechanism.
 *
 * The CDN layers are not covered: next.config.mjs stamps `CDN-Cache-Control:
 * public, s-maxage=300` on these prefixes whatever the status (the 500 above
 * carried it). That is a separate decision (cc-161 item 6).
 *
 * ── Why the sink is request-scoped (and only inside a render)
 *
 * `requestDegradedSink` is React `cache()`. Next's vendored react-server
 * installs its cache dispatcher once per process and runs every render inside
 * `requestStorage.run(request, …)` (AsyncLocalStorage), so within a page render
 * — across awaits and the timers `withDbTimeout` sets — it returns that
 * request's own sink. Outside a render (a Route Handler, a build step, a unit
 * test) there is no request in that storage, `resolveCache()` hands back a new
 * Map, and every call gets a fresh throwaway sink: nothing is shared, and
 * nothing is recorded that anyone reads. So this is page-only by construction;
 * code outside a render passes a sink explicitly. There is no module-level
 * mutable state.
 */

import { cache } from "react";
import { unstable_noStore } from "next/cache";

export interface DegradedRead {
  label: string;
  reason: string;
}

export interface DegradedSink {
  reads: DegradedRead[];
}

export function createDegradedSink(): DegradedSink {
  return { reads: [] };
}

// Stable react@18.3.1 — what the plain-node unit tests load — exports no
// `cache`; only Next's vendored react-server build does. The fallback is the
// same call-through React itself does when there is no request.
const requestScoped: <F extends (...args: never[]) => unknown>(fn: F) => F =
  typeof cache === "function" ? cache : (fn) => fn;

/** This request's sink inside a page render; a fresh one per call outside it. */
export const requestDegradedSink = requestScoped(createDegradedSink);

export function recordDegradedRead(
  label: string | undefined,
  reason: string,
  sink: DegradedSink = requestDegradedSink(),
): void {
  sink.reads.push({ label: label ?? "(unlabelled)", reason });
}

/**
 * Call ONCE per `revalidate` page, after its data phase. If any read recorded a
 * degradation, log it and opt this render out of Next's cache with
 * `noStore()` — which, on an ISR render, ends it (see the header). Returns the
 * degraded reads (empty on a healthy render).
 */
export function assertRenderNotDegraded(
  options: { sink?: DegradedSink; noStore?: () => void } = {},
): readonly DegradedRead[] {
  const sink = options.sink ?? requestDegradedSink();
  if (sink.reads.length === 0) return [];
  const what = sink.reads.map((r) => `${r.label} (${r.reason})`).join(", ");
  console.error(`[degraded-render] ${sink.reads.length} read(s) did not complete: ${what} — this render is not cached`);
  (options.noStore ?? unstable_noStore)();
  return sink.reads;
}
