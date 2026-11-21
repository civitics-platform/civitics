/**
 * FIX-1436 — a lookup ahead of an insert has three outcomes, not two
 * (ENGINEERING_PLAYBOOK §E13): found, absent, failed. Only `absent` inserts.
 *
 * The shape this replaces: `const { data } = await q.maybeSingle()`, error
 * discarded, then insert on `!data`. A timeout read as "not found", and so did
 * two matching rows (`.maybeSingle()` errors on them). Once a key matched twice
 * every run errored and inserted again: the executive seed's 43 Vice Presidents
 * (FIX-1428). The executive seed's fix (`pipelines/executive/seed.ts`) is the
 * model; these are its decision rules as pure functions over a query result, so
 * each site's choice is testable without a database.
 *
 *   resolveByKey   every match is the same entity (a source id, a name scoped
 *                  to a jurisdiction): the oldest by (created_at, id) wins and
 *                  the rest are counted as duplicates for a supervised cleanup.
 *   resolveByName  a name is not a key (§E6): exactly one match is adopted;
 *                  two or more adopt nothing and come back `absent` with the
 *                  matched ids, so the caller counts `ambiguous_name`.
 *
 * Neither deletes or merges anything.
 */

export interface LookupRow {
  id: string;
  created_at: string | null;
}

/** The supabase-js result of a multi-row select, as the sites receive it. */
export interface LookupResult<R> {
  data: R[] | null;
  error: { message: string } | null;
}

export type LookupOutcome<R> =
  | { kind: "found"; row: R; duplicates: string[] }
  | { kind: "absent"; ambiguous: string[] }
  | { kind: "failed"; error: string };

/** created_at ascending (a null sorts last), then id: the order the reads ask for. */
function oldestFirst<R extends LookupRow>(rows: readonly R[]): R[] {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      if (a.created_at === null) return 1;
      if (b.created_at === null) return -1;
      return Date.parse(a.created_at) - Date.parse(b.created_at) || (a.created_at < b.created_at ? -1 : 1);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function resolveByKey<R extends LookupRow>(res: LookupResult<R>): LookupOutcome<R> {
  if (res.error) return { kind: "failed", error: res.error.message };
  const rows = oldestFirst(res.data ?? []);
  const oldest = rows[0];
  if (!oldest) return { kind: "absent", ambiguous: [] };
  return { kind: "found", row: oldest, duplicates: rows.slice(1).map((r) => r.id) };
}

export function resolveByName<R extends LookupRow>(res: LookupResult<R>): LookupOutcome<R> {
  if (res.error) return { kind: "failed", error: res.error.message };
  const rows = oldestFirst(res.data ?? []);
  if (rows.length === 1) return { kind: "found", row: rows[0]!, duplicates: [] };
  return { kind: "absent", ambiguous: rows.map((r) => r.id) };
}
