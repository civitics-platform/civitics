// FIX-568: server-side disposable-email blocklist for the OTP-send preflight.
//
// DESIGN — design-bot-protection-gate.md §3.5: check the email domain against a
// VENDORED static list (no third-party API → no per-check cost, no PII sent off
// box) BEFORE calling Supabase. Rejection copy is neutral ("please use a
// permanent email address") and never reveals the list. This is a cheap,
// high-value defeat for throwaway-inbox farms — NOT a hard guarantee: a bot that
// hits Supabase's public OTP endpoint directly bypasses it (Supabase Turnstile +
// `[auth.rate_limit]` are the unbypassable layer). The list is DATA, refreshable
// later (a follow-up FIX can sync the full disposable-email-domains dataset or
// add a refresh script); the starter set covers the highest-traffic providers.
//
// Legit privacy-alias services that real users keep permanently (SimpleLogin,
// AnonAddy, Firefox Relay, …) are deliberately NOT on the list — blocking them
// would gate participation (brand rule #1), the opposite of the intent.

import domains from "./disposable-email-domains.json";

const BLOCKED = new Set<string>((domains as string[]).map((d) => d.toLowerCase()));

/** Lowercased domain part of an email, or null if there isn't a usable one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * True when the email's domain is a known disposable/throwaway provider. Matches
 * the exact domain AND any subdomain of a blocked domain (e.g.
 * `foo.mailinator.com` → blocked via `mailinator.com`).
 */
export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (BLOCKED.has(domain)) return true;
  // Walk the domain suffixes (drop one leftmost label at a time) so subdomains
  // of a blocked provider are caught without listing every alias host.
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (BLOCKED.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
