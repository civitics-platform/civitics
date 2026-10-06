// FIX-1278 — retired official UUIDs answer 308 to their survivor.
//
// promote_candidate_to_elected() deletes the elected row and records
// (old_id → new_id) in public.official_redirects (migration 20261006010000).
// middleware.ts asks this resolver before the page renders, because the page
// can't answer a real 308: officials/[id]/loading.tsx puts it under Suspense,
// and a page-level permanentRedirect()/notFound() then degrades to a 200 (the
// FIX-418/433/439 root cause).
//
// ONE list read per isolate per `ttlMs`, not one per request. The table is
// small (11 rows at landing) and single-hop — the RPC collapses chains at write
// time — so `resolve` is one Map lookup and never walks.
//
// Read straight from PostgREST with the publishable key the middleware already
// holds (anon role, 3 s statement_timeout, 1,000-row cap). NOT via a
// self-fetched /api route: Cloudflare Under Attack mode (FIX-1039) answers an
// edge fetch of civitics.com with the JS challenge, not JSON.
//
// FAILS OPEN. A non-2xx, a throw, a timeout or a non-array body caches an EMPTY
// map for `failTtlMs` and logs one `[official-redirects]` line, so the page
// renders exactly as it did before this module existed and a PostgREST outage
// costs one fetch per isolate per minute, not one per request.
//
// Edge-runtime safe: fetch + AbortController only, no Node API.

export interface RedirectResolverOptions {
  supabaseUrl: string | undefined;
  publishableKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** How long a successfully loaded list is served before the next read. */
  ttlMs?: number;
  /** How long an empty (failed) list is served before retrying. */
  failTtlMs?: number;
  now?: () => number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface RedirectResolver {
  /** The survivor id for a retired official id, or null. */
  resolve(id: string): Promise<string | null>;
}

/** PostgREST's max-rows on this project. A list this long may be truncated. */
export const ROW_CAP = 1_000;

type Loaded = { expiresAt: number; map: Map<string, string> };

function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function createRedirectResolver(opts: RedirectResolverOptions): RedirectResolver {
  const {
    supabaseUrl,
    publishableKey,
    fetchImpl = fetch,
    ttlMs = 3_600_000,
    failTtlMs = 60_000,
    now = Date.now,
    timeoutMs = 1_500,
    log = (m: string) => console.warn(m),
  } = opts;

  let cache: Loaded | null = null;
  let inflight: Promise<Loaded> | null = null;
  let warnedEnv = false;

  async function load(): Promise<Loaded> {
    const fail = (why: string): Loaded => {
      log(`[official-redirects] list read failed (${why}) — serving no redirects for ${failTtlMs / 1000}s`);
      return { expiresAt: now() + failTtlMs, map: new Map() };
    };

    const url = `${supabaseUrl}/rest/v1/official_redirects?select=old_id,new_id&limit=${ROW_CAP}`;
    const t = timeoutSignal(timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          apikey: publishableKey!,
          Authorization: `Bearer ${publishableKey}`,
          Accept: "application/json",
        },
        signal: t.signal,
      });
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return fail("non-array body");

      const map = new Map<string, string>();
      for (const row of body) {
        const oldId = (row as { old_id?: unknown })?.old_id;
        const newId = (row as { new_id?: unknown })?.new_id;
        if (typeof oldId === "string" && typeof newId === "string") {
          map.set(oldId.toLowerCase(), newId);
        }
      }
      if (body.length >= ROW_CAP) {
        log(`[official-redirects] list at the ${ROW_CAP.toLocaleString("en-US")}-row cap — later rows may be missing`);
      }
      return { expiresAt: now() + ttlMs, map };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return fail(name === "AbortError" || name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : String(err));
    } finally {
      t.clear();
    }
  }

  async function current(): Promise<Map<string, string>> {
    if (cache && now() < cache.expiresAt) return cache.map;
    // A cold isolate takes a burst of concurrent requests; they share one read.
    if (!inflight) {
      inflight = load().then((loaded) => {
        cache = loaded;
        inflight = null;
        return loaded;
      });
    }
    return (await inflight).map;
  }

  return {
    async resolve(id: string): Promise<string | null> {
      if (!supabaseUrl || !publishableKey) {
        if (!warnedEnv) {
          warnedEnv = true;
          log("[official-redirects] NEXT_PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY absent — no redirects served");
        }
        return null;
      }
      const map = await current();
      return map.get(id.toLowerCase()) ?? null;
    },
  };
}
