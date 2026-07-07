/**
 * Shared fetch utilities for all data pipelines.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when an API returns a daily/monthly quota-exhausted signal.
 * Callers should catch this and abort gracefully rather than retry —
 * continued requests will keep failing until the quota resets.
 */
export class QuotaExhaustedError extends Error {
  readonly url: string;
  readonly body: string;
  constructor(url: string, body: string) {
    super(`Daily quota exhausted — ${url}\n  ${body.slice(0, 200)}`);
    this.name = "QuotaExhaustedError";
    this.url  = url;
    this.body = body;
  }
}

/** Detect daily-quota signals in a 429 body. Per-minute limits do NOT match. */
function isDailyQuotaBody(body: string): boolean {
  const b = body.toLowerCase();
  // OpenStates: "exceeded limit of 250/day: 256"
  if (/\/day\b/.test(b) && b.includes("exceeded")) return true;
  // Generic monthly/hour caps — treat as unrecoverable for the session
  if (/\/month\b/.test(b) && b.includes("exceeded")) return true;
  // Common patterns
  if (b.includes("daily limit"))   return true;
  if (b.includes("quota exceeded")) return true;
  return false;
}

/** GET JSON with retry on failure and adaptive back-off on 429 rate-limits. */
export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  retries = 1
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`  Retrying in 30s (attempt ${attempt + 1})...`);
      await sleep(30_000);
    }
    // Inner loop handles per-minute 429s via adaptive back-off (outside retry budget).
    let rateLimitCount = 0;
    while (true) {
      try {
        const res = await fetch(url, options);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (res.status === 429) {
            if (isDailyQuotaBody(body)) throw new QuotaExhaustedError(url, body);
            if (rateLimitCount < 4) {
              const backoffMs = Math.min(30_000 * Math.pow(2, rateLimitCount), 120_000);
              console.warn(`  Rate limited (429) — backing off ${backoffMs / 1000}s...`);
              await sleep(backoffMs);
              rateLimitCount++;
              continue;
            }
          }
          throw new Error(`HTTP ${res.status} — ${url}\n  ${body.slice(0, 200)}`);
        }
        return res.json() as Promise<T>;
      } catch (err) {
        if (err instanceof QuotaExhaustedError) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) console.error(`  Request failed: ${lastErr.message}`);
        break;
      }
    }
  }
  throw lastErr ?? new Error("Request failed");
}

/** POST JSON body, return parsed JSON response. */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  retries = 1
): Promise<T> {
  return fetchJson<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    retries
  );
}

/**
 * Run `fn`, retrying on any thrown error with exponential backoff. THROWS the
 * last error once `attempts` is exhausted — callers get either a successful
 * result or a thrown error, never a silent partial.
 *
 * Intended for transient DB-write failures (IO / autovacuum contention on Pro
 * Small times a chunk out mid-write) where a short backoff recovers the chunk.
 * `fn` must throw to signal a retry — Supabase's `{ data, error }` shape returns
 * errors instead of throwing, so wrap such calls to `throw new Error(error.message)`.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    onRetry?: (attempt: number, err: Error) => void;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8_000;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < attempts - 1) {
        const backoffMs = Math.min(baseMs * Math.pow(2, attempt), maxMs);
        opts.onRetry?.(attempt + 1, lastErr);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr ?? new Error("retryWithBackoff: exhausted with no error");
}

/** Chunk an array into batches of size n. */
export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Supabase RPC errors come back as plain objects ({ code, message, details, hint })
// — not Error instances — so String(err) → "[object Object]". Unwrap them so
// catch sites get a useful message. (Lived in pipelines/index.ts pre-FIX-756;
// shared here so fec-bulk's catch sites can use it without an import cycle.)
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const parts: string[] = [obj.message];
      if (obj.code)    parts.push(`(${String(obj.code)})`);
      if (obj.details) parts.push(`details=${String(obj.details)}`);
      if (obj.hint)    parts.push(`hint=${String(obj.hint)}`);
      return parts.join(" ");
    }
    try { return JSON.stringify(err); } catch { return "<unserializable error>"; }
  }
  return String(err);
}
