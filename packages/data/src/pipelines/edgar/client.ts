/**
 * FIX-253 · SEC EDGAR HTTP client.
 *
 * SEC fair-access policy requires a real contact User-Agent and a 10 req/sec
 * ceiling shared across all callers from the same IP. This module is the
 * single chokepoint that enforces both.
 *
 * Refs:
 *   https://www.sec.gov/os/accessing-edgar-data
 *   https://www.sec.gov/edgar/sec-api-documentation
 */

/** Per CLAUDE.md git identity + SEC's fair-access policy. */
const USER_AGENT = "Civitics Platform civitics.platform@gmail.com";
const RATE_LIMIT_PER_SEC = 10;
const RATE_LIMIT_WINDOW_MS = 1_000;

/**
 * Sliding-window rate limiter shared across every call into this module.
 * Tracks the most recent N request timestamps; before each call we drop any
 * older than the window, then sleep just long enough to ensure the bucket
 * stays at N. Process-local — concurrent stages in the same run share it,
 * but a separately-spawned pipeline would have its own bucket.
 */
const recentRequests: number[] = [];

async function waitForRateLimit(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (recentRequests.length > 0 && now - recentRequests[0]! > RATE_LIMIT_WINDOW_MS) {
      recentRequests.shift();
    }
    if (recentRequests.length < RATE_LIMIT_PER_SEC) {
      recentRequests.push(now);
      return;
    }
    const oldest = recentRequests[0]!;
    const waitMs = Math.max(1, oldest + RATE_LIMIT_WINDOW_MS - now);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export interface EdgarFetchOptions {
  /** Override the default Accept header. */
  accept?: string;
  /** Read timeout (ms). Defaults to 30s. */
  timeoutMs?: number;
}

export interface EdgarResponse {
  status: number;
  ok: boolean;
  body: string;
  finalUrl: string;
  contentLength: number;
}

/**
 * Fetch a URL from EDGAR with the required UA and rate-limiting. Retries
 * 429 and 503 with exponential backoff (3 attempts total). Non-retried 4xx
 * surfaces as `{ok: false}` for the caller to handle (404 is common for
 * absent filings).
 */
export async function edgarFetch(url: string, opts: EdgarFetchOptions = {}): Promise<EdgarResponse> {
  const accept = opts.accept ?? "application/json, text/html, */*";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitForRateLimit();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":      USER_AGENT,
          "Accept":          accept,
          "Accept-Encoding": "gzip",
          "Host":            new URL(url).host,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429 || res.status === 503) {
        const backoffMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      const body = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        body,
        finalUrl: res.url,
        contentLength: body.length,
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const backoffMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`edgarFetch failed after 3 attempts: ${url} — ${errMsg}`);
}

/**
 * HEAD request for size / freshness probes. Same UA + rate limit. Returns
 * { contentLength, lastModified } where either may be null.
 */
export async function edgarHead(url: string, timeoutMs = 15_000):
  Promise<{ status: number; contentLength: number | null; lastModified: string | null }>
{
  await waitForRateLimit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT, "Host": new URL(url).host },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const cl = res.headers.get("content-length");
    return {
      status: res.status,
      contentLength: cl ? Number(cl) : null,
      lastModified: res.headers.get("last-modified"),
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`edgarHead failed: ${url} — ${msg}`);
  }
}

export function userAgentForLogging(): string {
  return USER_AGENT;
}
