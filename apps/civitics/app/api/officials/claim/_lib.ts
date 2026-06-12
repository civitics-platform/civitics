// FIX-558 decision 8: approved official grants expire at the end of the
// official's term when known and in the future, else 2 years out. Both term
// columns are sparsely populated (649 / 210 of ~28.6k), so the 2-year
// default is the common case. Shared by the claim route (fast path) and the
// /api/admin/grants approve route.
export function computeExpiry(
  termEnd: string | null,
  currentTermEnd: string | null,
  from: Date,
): Date {
  const term = termEnd ?? currentTermEnd;
  if (term) {
    const t = new Date(term);
    if (!Number.isNaN(t.getTime()) && t > from) return t;
  }
  const fallback = new Date(from);
  fallback.setFullYear(fallback.getFullYear() + 2);
  return fallback;
}
