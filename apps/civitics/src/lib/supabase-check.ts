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
