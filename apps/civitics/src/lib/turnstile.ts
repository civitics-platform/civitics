// FIX-569: server-side Turnstile token verification + the new-account "first
// writes" challenge gate, used by the content-creation routes (/api/comments,
// /api/positions, /api/statements POST). The AUTH front door (FIX-568) does NOT
// use these — Supabase verifies the auth captcha itself via [auth.captcha].
//
// This is an INTERNAL trust multiplier, never surfaced (brand rule #3 — no public
// karma/tier), and it gates the RATE of writes (a 403 at the access layer), never
// the right to post and never already-posted content.

import type { SupabaseClient } from "@supabase/supabase-js";
import { NEW_ACCOUNT_AGE_HOURS, NEW_ACCOUNT_MIN_ACTIONS } from "@civitics/db";

type AnyClient = SupabaseClient<any, "public", any>;

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token with Cloudflare (server-side), using the shared
 * TURNSTILE_SECRET_KEY (FIX-568). Returns:
 *   • true  — valid token, OR no secret configured (challenge inert in envs
 *             without keys; the per-user DB caps + age gate still apply).
 *   • false — missing token, a non-OK response, OR a network/parse error.
 * NB this FAILS CLOSED (false on error), unlike the FIX-570 edge limiter — the
 * challenge only fires for the highest-risk (newest) accounts on net-new content,
 * so a transient verify failure there is a 403 retry, not a broken site.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not provisioned → inert
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") form.set("remoteip", ip);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Pure predicate: must this account be challenged on a content write? True when
 * the account is younger than NEW_ACCOUNT_AGE_HOURS OR has fewer than
 * NEW_ACCOUNT_MIN_ACTIONS prior actions (spec: age < H OR actions < N). Trust
 * accrues with both age and participation; crossing BOTH thresholds clears it.
 */
export function requiresChallenge(
  createdAt: string | null | undefined,
  actionCount: number,
): boolean {
  const createdAtMs = createdAt ? new Date(createdAt).getTime() : NaN;
  const young =
    !Number.isFinite(createdAtMs) ||
    Date.now() - createdAtMs < NEW_ACCOUNT_AGE_HOURS * 3_600_000;
  return young || actionCount < NEW_ACCOUNT_MIN_ACTIONS;
}

/**
 * Route-facing gate: does this user need a Turnstile challenge for a content
 * write? Short-circuits on age — a brand-new account (the risky case, and one
 * that has < N actions anyway) is challenged WITHOUT a count query; only an
 * already-aged account pays one cheap indexed count of its comments (the action
 * proxy) to confirm it has cleared the experience threshold.
 */
export async function challengeRequiredForWrite(
  db: AnyClient,
  user: { id: string; created_at?: string | null },
): Promise<boolean> {
  // `Infinity` actions ⇒ the predicate reduces to the age test alone.
  if (requiresChallenge(user.created_at, Number.POSITIVE_INFINITY)) return true;
  const { count } = await db
    .from("entity_comments")
    .select("*", { count: "exact", head: true })
    .eq("author_id", user.id);
  return requiresChallenge(user.created_at, count ?? 0);
}
