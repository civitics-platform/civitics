// FIX-788 — viewer-key strip for CDN-cached public payloads.
//
// /api/statements and /api/questions are hot, anon-heavy entity-page reads that
// the Vercel edge caches (next.config.mjs cdnHot catch-all). The edge cache key
// does NOT vary by Cookie, so ANY viewer-dependent field in a cached payload is
// a cross-user disclosure: one signed-in user's response is served to everyone
// for the s-maxage window. That is the FIX-786 saved-views leak class; FIX-787
// found the same class on these two routes (per-viewer my_vote / can_answer)
// and pinned them CDN no-store — correct, but it pushed every anon/crawler hit
// to the cache-starved prod DB.
//
// FIX-788 restores edge caching by splitting the payload: the public list route
// is viewer-independent by construction (the RPC runs on createPublicClient, so
// auth.uid() is NULL and the viewer fields are null/false for everyone) and its
// body passes through stripViewerKeys() as belt-and-braces; the viewer's own
// state comes from the separate no-store /api/viewer/engagement overlay.
//
// NEVER re-add a personalized field to a payload returned by a cached route —
// add it to the overlay instead. public-payload.test.ts enforces the strip.

/** Field names that carry per-viewer state in the statements/questions RPC payloads. */
export const VIEWER_KEYED_FIELDS = ["my_vote", "can_answer"] as const;

/**
 * Deep-remove the given keys from a JSON-shaped value (plain objects + arrays).
 * Returns a new structure; the input is not mutated.
 */
export function stripViewerKeys<T>(
  value: T,
  keys: readonly string[] = VIEWER_KEYED_FIELDS,
): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripViewerKeys(v, keys)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k)) continue;
      out[k] = stripViewerKeys(v, keys);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Audit helper (used by the regression test): every path at which a
 * viewer-keyed field occurs anywhere in a JSON-shaped value.
 */
export function findViewerKeys(
  value: unknown,
  keys: readonly string[] = VIEWER_KEYED_FIELDS,
  path = "$",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findViewerKeys(v, keys, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const here = keys.includes(k) ? [`${path}.${k}`] : [];
      return [...here, ...findViewerKeys(v, keys, `${path}.${k}`)];
    });
  }
  return [];
}
