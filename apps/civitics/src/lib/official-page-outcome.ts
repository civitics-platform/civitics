/**
 * The three things that can happen to `get_official_page` on a render, which
 * until now were TWO things the page could tell apart and one it could not.
 *
 * - `skipped` — FIX-683: the official has no votes / donations / connections, so
 *   the RPC was never called. Every section legitimately renders empty, and
 *   generateMetadata already noindexes the page.
 * - `ok` — the RPC answered.
 * - `failed` — the RPC was cancelled (57014 against `anon`'s 3 s bound), timed
 *   out client-side, or hit a PostgREST schema-cache miss.
 *
 * `failed` used to render IDENTICALLY to `skipped`. `withDbTimeout` returns
 * `{ data: null, error }`, the page destructured `{ data }` and shimmed
 * `data ?? {}`, and the result was a real official — right name, right party,
 * right photo — with an empty record: no votes, no spending, no career, no
 * promises. No error, no 500, nothing but a 57014 in the logs.
 *
 * cc-137 measured how often: **80 of 446 `get_official_page` calls over 3.5
 * days were cancelled — 17.9 %** (11.2 % excluding one 568-cancel event
 * window). Every visitor is `anon` — the page calls the RPC through
 * `createPublicClient()`, so there is no authenticated cohort with a longer
 * bound — and `withDbTimeout(…, 5000)` is a client-side `Promise.race` that
 * issues no SQL, so it loses to the server's 3 s every time and cannot even
 * report the cancel as a timeout.
 *
 * Two harms, and the second is the durable one: a visitor is told this official
 * has no record, and a crawler is told the same thing and may cache it.
 *
 * This module is deliberately pure and free of `next/*` and `@civitics/db`, so
 * it sits under `src/` where the test runner discovers it.
 */
export type OfficialPageOutcome = "skipped" | "ok" | "failed";

/** The `{ data, error }` envelope shape `withDbTimeout` resolves to. */
export interface PageEnvelope {
  data: unknown;
  error?: unknown;
}

/**
 * Pure classifier — the seam the unit test drives.
 *
 * Deliberately NOT keyed on `data == null`. A successful RPC for an official
 * with genuinely nothing to show can return null sections, and treating that as
 * a failure would put the degraded banner on pages that are simply quiet. Only
 * an explicit `error` is a failure, which is the one signal that cannot be
 * produced by real-but-empty data.
 */
export function classifyOfficialPage(
  contentBearing: boolean,
  res: PageEnvelope | null | undefined,
): OfficialPageOutcome {
  if (!contentBearing) return "skipped";
  if (res && res.error) return "failed";
  return "ok";
}
