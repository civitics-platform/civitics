// FIX-880 / FIX-571 PR1 — abuse-event capture helper (SERVER-ONLY, observe-only).
//
// One entry point, recordAbuseEvent(), used by every capture site (content-write
// routes, the four 53400 cap-hits, Turnstile outcomes, auth-callback landings).
// It writes ONE append-only row to public.abuse_events and is wrapped so it can
// NEVER throw and NEVER meaningfully slow the user action.
//
// ── DETECTION ≠ PUNISHMENT ───────────────────────────────────────────────────
// This confers zero consequence. It is a linkage substrate for a future,
// human-gated Sybil review (PR2), nothing more. See the migration header.
//
// ── Privacy ──────────────────────────────────────────────────────────────────
// Raw IP / User-Agent are NEVER stored, not even transiently in meta. They are
// HMAC-SHA256'd with a stable server-only pepper (ABUSE_EVENT_PEPPER) here, and
// only the hex digest is inserted. Pepper unset → NULL hashes + one warn
// (fail-open, never a raw fallback). meta is sanitized to strip any raw-identifier
// keys a caller might pass by mistake.
//
// ── Await vs fire-and-forget (decision, Next 14.2) ───────────────────────────
// recordAbuseEvent is AWAITED by callers. Fire-and-forget loses events on
// Vercel's post-response function freeze — and the events ARE the substrate, so
// losing an unknown fraction defeats the point. `after()`/waitUntil is the
// zero-latency alternative but needs the Next-15 stable API (we're on 14.2, where
// it's unstable_after behind an experimental flag) or a new @vercel/functions dep
// (out of scope). Instead we await a single indexed service-role insert raced
// against a short timeout: a few ms on the healthy path, and a degraded DB adds
// at most ABUSE_EVENT_TIMEOUT_MS before the call no-ops. Uses the ADMIN client
// (RLS on abuse_events has zero policies — service-role writes only), never the
// cookie client.

import { createHmac } from "node:crypto";
import { createAdminClient, type Json } from "@civitics/db";

// The taxonomy — mirrors the CHECK constraint in
// supabase/migrations/20260722020000_fix880_abuse_events_substrate.sql. Detail
// (route / cap / outcome / write kind) rides in meta, not in new action values.
export type AbuseAction =
  | "position_set"
  | "statement_create"
  | "statement_vote"
  | "comment_create"
  | "flag_create"
  | "investigation_create"
  | "evidence_write"
  | "auth_callback"
  | "cap_hit"
  | "turnstile_challenge";

// Ceiling on how long a log insert may add to a user action before we give up
// (fail-open). The healthy path is a few ms; this only bounds a degraded DB.
const ABUSE_EVENT_TIMEOUT_MS = 2000;

// Warn ONCE per process when the pepper is unset (decision 3: single startup warn).
let warnedNoPepper = false;

// Keys that must never land in meta — a defensive strip so a raw identifier can
// never leak in via a caller's meta object (the "meta never carries raw ip/ua"
// invariant is enforced here, not merely trusted).
const META_DENYLIST = new Set([
  "ip",
  "ua",
  "user_agent",
  "useragent",
  "ip_hash",
  "ua_hash",
  "x-forwarded-for",
  "x-real-ip",
  "remoteip",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HMAC-SHA256(pepper) of a raw network identifier → hex digest, or null.
 * Deterministic: same value + same pepper ⇒ same digest (the cross-week linkage
 * the substrate depends on). Returns null for an empty value OR an unset pepper
 * (fail-open — never a raw fallback).
 */
export function hashIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const pepper = process.env.ABUSE_EVENT_PEPPER;
  if (!pepper) {
    if (!warnedNoPepper) {
      warnedNoPepper = true;
      console.warn(
        "[abuse-events] ABUSE_EVENT_PEPPER unset — recording events with NULL " +
          "network hashes (linkage-blind, fail-open). Set it to enable linkage.",
      );
    }
    return null;
  }
  return createHmac("sha256", pepper).update(value).digest("hex");
}

/** First hop of x-forwarded-for, else x-real-ip. Null when neither is present. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && first !== "unknown") return first;
  }
  const real = headers.get("x-real-ip");
  return real && real !== "unknown" ? real : null;
}

/** Strip raw-identifier keys and drop undefined values so meta stays minimal. */
export function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (META_DENYLIST.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export interface RecordAbuseEventInput {
  action: AbuseAction;
  /** Request headers — client IP + UA are extracted and HASHED here (raw never stored). */
  headers?: Headers | null;
  /** Actor, when known. NULL is fine (e.g. an auth landing without a resolvable session). */
  userId?: string | null;
  /** The entity acted on, where cheaply available (e.g. 'proposal', 'statement'). */
  targetType?: string | null;
  /** Must be a UUID; a non-UUID value is dropped to null so the event still lands. */
  targetId?: string | null;
  /** Minimal — route / cap / outcome / kind only. Sanitized before insert. */
  meta?: Record<string, unknown>;
}

/**
 * Record ONE abuse_events row. Never throws, never hangs past
 * ABUSE_EVENT_TIMEOUT_MS. Awaited by callers, but a failure or timeout is a
 * silent no-op — logging must never break or meaningfully slow a user action.
 */
export async function recordAbuseEvent(input: RecordAbuseEventInput): Promise<void> {
  try {
    const ipHash = input.headers ? hashIdentifier(clientIpFromHeaders(input.headers)) : null;
    const uaHash = input.headers ? hashIdentifier(input.headers.get("user-agent")) : null;
    const targetId =
      input.targetId && UUID_RE.test(input.targetId) ? input.targetId : null;

    const admin = createAdminClient();
    // .then(noop, noop) so a slow insert that loses the race below never surfaces
    // as an unhandledRejection after we've already resolved.
    const insert = admin
      .from("abuse_events")
      .insert({
        action: input.action,
        user_id: input.userId ?? null,
        ip_hash: ipHash,
        ua_hash: uaHash,
        target_type: input.targetType ?? null,
        target_id: targetId,
        meta: sanitizeMeta(input.meta) as Json,
      })
      .then(
        () => {},
        () => {},
      );

    await Promise.race([
      insert,
      new Promise<void>((resolve) => setTimeout(resolve, ABUSE_EVENT_TIMEOUT_MS)),
    ]);
  } catch {
    // fail-open: a broken admin client / missing env / anything at all must not
    // touch the user action.
  }
}
