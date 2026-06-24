/**
 * FIX-575 — refresh the vendored disposable-email blocklist.
 *
 * Regenerates apps/civitics/src/lib/disposable-email-domains.json from the
 * community `disposable-email-domains` dataset, so the OTP-send preflight
 * (FIX-568, apps/civitics/src/lib/disposable-email.ts) blocks throwaway-inbox
 * farms across the full known set instead of the ~186-domain starter slice.
 *
 * The list is DATA, never a runtime dependency: this script runs MANUALLY and
 * commits its output. No per-check API call, no PII off-box. The matcher in
 * disposable-email.ts is unchanged — exact-match + suffix-walk already handles
 * subdomains at any list size.
 *
 * Final list = (curated starter set ∪ filtered full upstream) − ALLOWLIST.
 *   - Union with whatever the JSON already holds so curated, high-traffic
 *     entries can never regress out if upstream drops one.
 *   - Subtract ALLOWLIST so permanent privacy-alias services real users keep
 *     (SimpleLogin, AnonAddy/addy.io, Firefox Relay, DuckDuckGo, Proton, Apple
 *     iCloud relay) stay UNBLOCKED — blocking them gates real participation
 *     (brand rule #1: open participation), the opposite of the intent.
 *
 * Pinned source (commit, not a moving branch, for reproducible refreshes):
 *   disposable-email-domains/disposable-email-domains@d7fb152 (2026-06-21)
 *   disposable_email_blocklist.conf — one domain per line.
 * Bump SOURCE_COMMIT to a newer SHA to pull a fresher set.
 *
 * Run (no DB, no env needed — just network + file write):
 *   pnpm --filter @civitics/data data:refresh-disposable-emails
 *   # or: pnpm --filter @civitics/data exec tsx src/scripts/refresh-disposable-emails.ts
 *
 * Follow-up (out of scope here): a scheduled GHA to run this on a cadence.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_COMMIT = "d7fb152d99320da2448cdb80d1f8e4fb28fd1233";
const SOURCE_URL =
  `https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/${SOURCE_COMMIT}/disposable_email_blocklist.conf`;

// Repo root is four levels up from this file (.../packages/data/src/scripts).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const TARGET_JSON = path.join(
  REPO_ROOT,
  "apps/civitics/src/lib/disposable-email-domains.json",
);

/**
 * Permanent privacy-alias services that real users keep forever. These are NOT
 * disposable — blocking them gates legitimate sign-in. Kept explicit and
 * commented so a future refresh can never silently swallow one if upstream
 * misclassifies it. Stored as exact apex domains; the suffix-walk matcher in
 * disposable-email.ts means a subdomain of any of these is implicitly allowed
 * too (we never ADD them to BLOCKED, so the walk never matches).
 */
export const ALLOWLIST: ReadonlySet<string> = new Set(
  [
    // SimpleLogin (Proton-owned alias service) and its alias apexes.
    "simplelogin.com",
    "simplelogin.io",
    "simplelogin.fr",
    "simplelogin.co",
    "slmail.me",
    "8alias.com",
    "aleeas.com",
    "dralias.com",
    "silomails.com",
    // AnonAddy / addy.io.
    "anonaddy.com",
    "anonaddy.me",
    "addy.io",
    // Mozilla Firefox Relay.
    "mozmail.com",
    // DuckDuckGo Email Protection.
    "duck.com",
    // Proton Mail (incl. the pm.me / proton.me short domains).
    "proton.me",
    "protonmail.com",
    "protonmail.ch",
    "pm.me",
    // Apple iCloud + Hide My Email relay (icloud.com MUST stay allowed).
    "icloud.com",
    "me.com",
    "mac.com",
  ].map((d) => d.toLowerCase()),
);

async function loadCurated(): Promise<string[]> {
  // Read the committed JSON so the union never drops a hand-picked entry.
  const raw = await readFile(TARGET_JSON, "utf8");
  return JSON.parse(raw) as string[];
}

async function fetchUpstream(): Promise<string[]> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    // Drop blanks and any comment lines (`#` — the .conf format permits them).
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function main() {
  const [curated, upstream] = await Promise.all([
    loadCurated(),
    fetchUpstream(),
  ]);

  const merged = new Set<string>();
  for (const d of curated) merged.add(d.trim().toLowerCase());
  for (const d of upstream) merged.add(d);

  let removed = 0;
  for (const allowed of ALLOWLIST) {
    if (merged.delete(allowed)) removed++;
  }

  const sorted = [...merged].sort();
  const json = JSON.stringify(sorted, null, 2) + "\n";
  await writeFile(TARGET_JSON, json, "utf8");

  console.log(`curated starter:   ${curated.length}`);
  console.log(`upstream fetched:  ${upstream.length}  (@${SOURCE_COMMIT.slice(0, 7)})`);
  console.log(`allowlisted out:   ${removed} of ${ALLOWLIST.size}`);
  console.log(`final list:        ${sorted.length}`);
  console.log(`wrote:             ${path.relative(REPO_ROOT, TARGET_JSON)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
