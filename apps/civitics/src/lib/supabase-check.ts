import { NextResponse } from "next/server";

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
  label?: string
): Promise<T> {
  const timeoutResult = { data: null, error: new Error(`Supabase query timed out after ${ms}ms`) };
  const wrapped = Promise.resolve(query).then((result) => {
    const code = (result as { error?: { code?: unknown; message?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && STRUCTURAL_ERROR_CODES.has(code)) {
      const message = (result as { error?: { message?: unknown } } | null)?.error?.message;
      const msgStr = typeof message === "string" ? message : "(no message)";
      const labelSeg = label ? ` [label=${label}]` : "";
      console.error(
        `[withDbTimeout] PostgREST structural error ${code}${labelSeg}: ${msgStr} — likely a dropped column or stale schema reference`
      );
    }
    return result;
  });
  return Promise.race([
    wrapped,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(timeoutResult as unknown as T), ms)
    ),
  ]);
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
 * a greppable line behind it.
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
  label?: string
): Promise<T | null> {
  const TIMED_OUT = Symbol("withDbTimeoutValue");
  const result = await Promise.race<T | typeof TIMED_OUT>([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
  if (result === TIMED_OUT) {
    const labelSeg = label ? ` [label=${label}]` : "";
    console.error(`[withDbTimeoutValue] timed out after ${ms}ms${labelSeg} — resolving null`);
    return null;
  }
  return result;
}
