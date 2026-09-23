import {
  createBrowserClient as createSSRBrowserClient,
  createServerClient as createSSRServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types/database";

// ---------------------------------------------------------------------------
// Browser client — safe to call in client components
// Uses the publishable key (replaces legacy anon key)
// ---------------------------------------------------------------------------
export function createBrowserClient() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    );
  }

  return createSSRBrowserClient<Database>(url, key);
}

// ---------------------------------------------------------------------------
// Cookie store interface — matches Next.js ReadonlyRequestCookies and
// ResponseCookies without importing from next/headers (keeps this package
// framework-agnostic).
// ---------------------------------------------------------------------------
export interface CookieStore {
  getAll(): { name: string; value: string }[];
  setAll?(
    cookies: { name: string; value: string; options: CookieOptions }[]
  ): void;
}

// ---------------------------------------------------------------------------
// Server client (auth-aware) — for Next.js Server Components and Route Handlers
// Reads and writes auth cookies so the user's session is preserved during SSR.
//
// Usage in a Server Component:
//   import { cookies } from "next/headers"
//   const supabase = createServerClient(await cookies())
//
// Usage in a Route Handler:
//   const supabase = createServerClient(cookies())
// ---------------------------------------------------------------------------
export function createServerClient(cookieStore: CookieStore) {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    );
  }

  return createSSRServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookieStore.setAll?.(cookiesToSet);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Public client — server-side, no cookies, RLS-respecting (anon role).
// Use for Server Components that only read public civic data and don't need
// the user's session. Calling cookies() in a Server Component opts that
// page out of static rendering / ISR; createPublicClient avoids that, so
// the page can use `export const revalidate = N` and be served from disk
// (true static generation) or the Vercel CDN cache (cf. FIX-201).
//
// Auth-aware reads (anything that depends on auth.uid()) still need
// createServerClient(cookies()) — civic_comments, follows, user_positions,
// profile pages, etc. Use createPublicClient only on routes that are
// genuinely public.
// ---------------------------------------------------------------------------
export function createPublicClient() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    );
  }

  return createClient<Database>(url, key, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Admin client — server only, bypasses RLS
// Uses the secret key (replaces legacy service_role key).
// Never import this in client components or expose it to the browser.
//
// Pipeline guard (FIX-158): when invoked from a tsx pipeline (no NEXT_RUNTIME
// or VERCEL env var), prints a one-line target banner to stderr and refuses
// to run against a non-local URL unless --allow-prod is in process.argv.
// Prevents accidental cross-env writes when .env.local was last copied from
// .env.local.prod. Skipped entirely inside Next.js (server routes, build).
// ---------------------------------------------------------------------------
let pipelineGuardChecked = false;

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
}

function runPipelineGuard(url: string): void {
  if (pipelineGuardChecked) return;
  pipelineGuardChecked = true;
  if (process.env["NEXT_RUNTIME"] || process.env["VERCEL"]) return;

  const local = isLocalUrl(url);
  const banner = `[pipeline] target: ${url} (${local ? "local" : "REMOTE"})`;
  process.stderr.write(`${banner}\n`);

  if (!local && !process.argv.includes("--allow-prod")) {
    process.stderr.write(
      `[pipeline] REFUSING to run against a non-local DB without --allow-prod\n` +
        `[pipeline] If intentional, re-invoke with --allow-prod.\n` +
        `[pipeline] To switch back to local: Copy-Item .env.local.dev .env.local\n`,
    );
    process.exit(1);
  }
}

export type AdminClientOptions = {
  /**
   * The fetch supabase-js sends every request through. Omit it and supabase-js
   * uses the global `fetch` — which inside Next.js is the PATCHED fetch, so
   * the request is subject to the Data Cache. Pass `noStoreFetch` from a route
   * whose calls must reach the database every time (FIX-1208).
   */
  fetch?: typeof fetch;
};

/**
 * `fetch` with `cache: "no-store"` forced on — the `front-door-watch` shape,
 * for a supabase-js client.
 *
 * Why it is needed (FIX-1208, measured against next@14.2.35's own source): a
 * GET Route Handler with `export const dynamic = "force-dynamic"` sets only
 * `forceDynamic`; its `revalidate` defaults to `false`, and patch-fetch's
 * "auto no cache" for an authed or POST fetch fires only when `revalidate === 0`.
 * So a supabase-js `.rpc()` POST with an identical body is "auto cache" with
 * `revalidate: false` — cached for a year. The cron-watchdog route called its
 * RPC for real exactly once (2026-09-22 01:20:18) and was answered from that
 * entry every two minutes after.
 *
 * Resolves the global `fetch` at CALL time, not import time, so inside Next it
 * is the patched fetch that honours `cache`.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  // The assertion is for this package's lib set: @types/node's RequestInit
  // (undici) has no `cache`, the DOM one Next type-checks against does.
  fetch(input, { ...init, cache: "no-store" } as RequestInit);

export function createAdminClient(options: AdminClientOptions = {}) {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["SUPABASE_SECRET_KEY"];

  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  }

  runPipelineGuard(url);

  return createClient<Database>(url, key, {
    auth: { persistSession: false },
    // Only when asked: every existing caller keeps supabase-js's default fetch.
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}

// Cross-environment admin client for one-shot scripts that need to talk to
// local + prod simultaneously (e.g. copy-pac-tags-to-prod). Caller passes the
// url/key explicitly — no process.env reads. The pipeline guard is skipped
// because the caller has, by definition, opted into a non-active-env target.
export function createAdminClientWith(url: string, key: string) {
  if (!url || !key) {
    throw new Error("createAdminClientWith requires both url and key");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false },
  });
}
