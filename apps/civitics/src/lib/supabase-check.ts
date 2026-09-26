import { NextResponse } from "next/server";
import { type DegradedSink, recordDegradedRead, requestDegradedSink } from "./degraded-render";

export function supabaseUnavailable(): boolean {
  return process.env.SUPABASE_AVAILABLE === "false";
}

export function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Service temporarily unavailable", retry_after: 3600 },
    {
      status: 503,
      headers: {
        "Retry-After": "3600",
        "Cache-Control": "no-store",
      },
    }
  );
}

/**
 * PostgREST error codes that signal a schema/structure problem in the query —
 * a dropped column, a renamed table, a missing function. Every call site of
 * `withDbTimeout` destructures `{ data }` only, so these errors otherwise
 * vanish into a silent `data: null` return. The wrapper logs them to make
 * silent-zero card regressions (FIX-308 / FIX-334 / FIX-344 / FIX-374) visible.
 */
const STRUCTURAL_ERROR_CODES = new Set([
  "42703", // undefined_column
  "42P01", // undefined_table
  "42883", // undefined_function
  "42704", // undefined_object (enum value, etc.)
  "42P02", // undefined_parameter
]);

/**
 * FIX-1227 — error codes that mean "this read ran out of time", as opposed to
 * "this read is wrong". See `withDbTimeout`.
 */
const READ_TIMEOUT_CODES = new Set([
  "57014", // query_canceled — statement_timeout (anon: 3 s)
  "PGRST003", // PostgREST timed out acquiring a pool connection
]);

/**
 * Wraps a Supabase query in a 5-second timeout.
 * On timeout, resolves with { data: null, error: Error } instead of hanging.
 * Preserves the full return type (including count, status, etc.) via generic T.
 *
 * USE THIS ONLY FOR POSTGREST BUILDERS — anything whose resolved value is a
 * `{ data, error }` envelope. The timeout branch fabricates that envelope and
 * casts it `as unknown as T`, which is the right shape for a builder and the
 * WRONG shape for anything else. Passing an already-unwrapped promise (e.g.
 * `readStatusSnapshot(db)`, which resolves to a row or null) makes the timeout
 * hand back a truthy object with none of the fields the type promises, and
 * every `if (!value)` guard downstream silently takes the wrong branch — that
 * was FIX-1120, which turned a written-on-purpose 503 into a 500. For those,
 * use `withDbTimeoutValue` below.
 *
 * Also inspects resolved results for PostgREST structural errors (see
 * STRUCTURAL_ERROR_CODES above) and logs a single-line, prefixed message
 * via console.error. The return shape is unchanged — callers that only
 * destructure `{ data }` still get `data: null` on a structural error,
 * but the failure is now visible in Vercel function logs.
 *
 * Pass an optional `label` to disambiguate log lines when grepping across
 * many call sites (e.g. "sunburst:donations").
 *
 * FIX-1227 — a read that does not complete in time is also RECORDED as
 * degraded, into this request's sink (`degraded-render.ts`), so a `revalidate`
 * page can refuse to be cached from it (`assertRenderNotDegraded()`). Two
 * shapes count, and both are logged:
 *   - this wrapper's own timer fires;
 *   - the database cancels the statement first (SQLSTATE 57014) or PostgREST
 *     cannot get a connection in time (PGRST003). The anon role's 3 s
 *     statement_timeout beats a 5 s timer outright and races a 3 s one — the
 *     officials page-RPC failed as 57014 in cc-161 read 6, not as a timeout.
 * Any other error is not a timeout and is not recorded: a permanent error
 * would otherwise make that page uncacheable for good. `sink` is for callers
 * outside a page render and for tests; a page never passes it.
 *
 * Usage:
 *   const { data, error } = await withDbTimeout(
 *     supabase.from("table").select("col").limit(100),
 *     5000,
 *     "route:label"
 *   );
 */
export async function withDbTimeout<T>(
  query: PromiseLike<T>,
  ms = 5000,
  label?: string,
  sink: DegradedSink = requestDegradedSink(),
): Promise<T> {
  const labelSeg = label ? ` [label=${label}]` : "";
  const timeoutResult = { data: null, error: new Error(`Supabase query timed out after ${ms}ms`) };
  const wrapped = Promise.resolve(query).then((result) => {
    const code = (result as { error?: { code?: unknown; message?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && STRUCTURAL_ERROR_CODES.has(code)) {
      const message = (result as { error?: { message?: unknown } } | null)?.error?.message;
      const msgStr = typeof message === "string" ? message : "(no message)";
      console.error(
        `[withDbTimeout] PostgREST structural error ${code}${labelSeg}: ${msgStr} — likely a dropped column or stale schema reference`
      );
    } else if (typeof code === "string" && READ_TIMEOUT_CODES.has(code)) {
      console.error(`[withDbTimeout] read timed out server-side (${code})${labelSeg}`);
      recordDegradedRead(label, code, sink);
    }
    return result;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[withDbTimeout] timed out after ${ms}ms${labelSeg}`);
      recordDegradedRead(label, `timed out after ${ms}ms`, sink);
      resolve(timeoutResult as unknown as T);
    }, ms);
  });
  // A read that settles first must not later log or record a timeout.
  return Promise.race([wrapped, timeout]).finally(() => clearTimeout(timer));
}

/**
 * FIX-1120 — the plain-promise counterpart to `withDbTimeout`.
 *
 * For call sites whose promise has ALREADY unwrapped the PostgREST envelope
 * and resolves to a domain value (a row, a row-or-null, an array). On timeout
 * this resolves to `null` — a value the caller's own `if (!x)` guard is
 * already written to handle — instead of a fabricated `{data,error}` object
 * that satisfies the type checker while being structurally wrong.
 *
 * Why a separate function rather than defensive checks at each call site: the
 * misuse is invisible at the call site. `withDbTimeout<StatusSnapshotRow|null>`
 * reads as if it returns a row or null, and the `as unknown as T` cast inside
 * makes that annotation a lie the compiler will not question. Three call sites
 * shared the bug for three months (core/route.ts, quality/route.ts,
 * dashboard/page.tsx), and each of the three guards downstream of it looked
 * correct in isolation. A distinct name is the only thing that makes the two
 * contracts distinguishable at the point of use.
 *
 * The timeout is logged (never silent) so a route serving degraded output has
 * a greppable line behind it, and recorded as degraded (FIX-1227) exactly as
 * `withDbTimeout`'s is.
 *
 * Usage:
 *   const snapshot = await withDbTimeoutValue(
 *     readStatusSnapshot(db),
 *     2000,
 *     "status/core:snapshot",
 *   );
 *   if (!snapshot) { ... }   // now actually reachable on timeout
 */
export async function withDbTimeoutValue<T>(
  promise: PromiseLike<T>,
  ms = 5000,
  label?: string,
  sink: DegradedSink = requestDegradedSink(),
): Promise<T | null> {
  const TIMED_OUT = Symbol("withDbTimeoutValue");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<T | typeof TIMED_OUT>([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
  if (result === TIMED_OUT) {
    const labelSeg = label ? ` [label=${label}]` : "";
    console.error(`[withDbTimeoutValue] timed out after ${ms}ms${labelSeg} — resolving null`);
    recordDegradedRead(label, `timed out after ${ms}ms`, sink);
    return null;
  }
  return result;
}
