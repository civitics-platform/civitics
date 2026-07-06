/**
 * FIX-749 — keyset pagination cursor codec.
 *
 * A cursor is the (sort_value, entity_id) tuple of the last row on the page,
 * base64url-encoded JSON. The /api/browse route turns it into a row-value
 * predicate over the (kind, <sort_col>, entity_id) btree (FIX-748) so paging is
 * O(1), not deep-offset. `sortValue` is null when the sort column is null for
 * that row (the NULLS-LAST tail of amount_desc / recent), which the route pages
 * over explicitly.
 *
 * Dependency-free (no next/*, Node's Buffer only) — unit-testable under tsx.
 */

export interface Cursor {
  /** The last row's value in the active sort column; null = NULLS-LAST tail. */
  sortValue: string | number | null;
  /** The last row's entity_id (the unique tie-breaker). */
  entityId: string;
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf-8");
}

/** Encode a keyset cursor. Timestamps must be pre-serialized to ISO strings. */
export function encodeCursor(c: Cursor): string {
  // Tuple form keeps the payload tiny; bigints (amount_cents) exceed JS safe
  // integer range only above ~9e15 cents ($90T) — out of range for our data —
  // so a JSON number is safe here.
  return toBase64Url(JSON.stringify([c.sortValue, c.entityId]));
}

/** Decode a keyset cursor. Returns null on any malformed input (fail-open to page 1). */
export function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(cursor));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortValue, entityId] = parsed as [unknown, unknown];
    if (typeof entityId !== "string" || entityId.length === 0) return null;
    if (sortValue !== null && typeof sortValue !== "string" && typeof sortValue !== "number") return null;
    return { sortValue: sortValue as string | number | null, entityId };
  } catch {
    return null;
  }
}
