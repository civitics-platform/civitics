/**
 * FIX-575 / FIX-655 — refresh the vendored disposable-email blocklist.
 *
 * Regenerates apps/civitics/src/lib/disposable-email-domains.json from the
 * community `disposable-email-domains` dataset, so the OTP-send preflight
 * (FIX-568, apps/civitics/src/lib/disposable-email.ts) blocks throwaway-inbox
 * farms across the full known set instead of the ~186-domain starter slice.
 *
 * The list is DATA, never a runtime dependency: this script regenerates and
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
 * Pinned source (a commit SHA, not a moving branch, for reproducible refreshes):
 * see SOURCE_COMMIT below. The upstream file is
 * disposable-email-domains/disposable-email-domains :: disposable_email_blocklist.conf,
 * one domain per line.
 *
 * FIX-655 — this is now driven monthly by .github/workflows/refresh-disposable-emails.yml,
 * which invokes `--latest --write-pin`: the script resolves the upstream
 * default-branch HEAD SHA (GitHub API, no auth needed for a public repo),
 * regenerates against it, and — on a real content change — rewrites SOURCE_COMMIT
 * in THIS file so the pin and the regenerated JSON always move together in the
 * same PR. Invariants the workflow relies on:
 *   (a) a fetch/parse/gate failure leaves the working tree UNTOUCHED and exits
 *       non-zero (loud) — nothing is half-written;
 *   (b) the pin and the JSON move together (both, or neither);
 *   (c) no content change → no write → no PR (create-pull-request opens nothing).
 *
 * Sanity gates (run on EVERY invocation, manual or CI, BEFORE any write):
 *   - size bounds: MIN_DOMAINS ≤ final ≤ MAX_DOMAINS (current ≈ 7,573);
 *   - canary: no known-legit consumer domain (gmail/outlook/yahoo/…) may appear
 *     in the final BLOCKED list.
 * A compromised or vandalized upstream (e.g. gmail.com slipped in) is exactly
 * what these catch — the whole point of the monthly PR review + auto-PR shape.
 *
 * Flags:
 *   --source <sha>   regenerate against this exact upstream SHA (overrides the pin)
 *   --latest         resolve + use the upstream default-branch HEAD SHA
 *   --write-pin      on a real change, rewrite SOURCE_COMMIT in this file to the
 *                    effective SHA (kept OFF for casual local regens)
 *
 * Run (no DB, no env needed — just network + file write):
 *   pnpm --filter @civitics/data data:refresh-disposable-emails
 *   pnpm --filter @civitics/data data:refresh-disposable-emails -- --latest --write-pin
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_COMMIT = "62776332540f730afeb0255cf6e21a7de907b0a4";

const UPSTREAM_OWNER = "disposable-email-domains";
const UPSTREAM_REPO = "disposable-email-domains";
const UPSTREAM_FILE = "disposable_email_blocklist.conf";

const rawUrlFor = (sha: string) =>
  `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/${sha}/${UPSTREAM_FILE}`;

// ── Sanity-gate bounds (FIX-655) ────────────────────────────────────────────
// The final list has hovered around 7,573. A regenerated list far outside this
// band means upstream broke (empty/partial fetch → too small) or was flooded
// (vandalism/format change → too large). Fail loudly rather than commit garbage.
const MIN_DOMAINS = 5_000;
const MAX_DOMAINS = 25_000;

// Known-legit consumer/provider domains that must NEVER end up blocked. If any
// appears in the FINAL list, a compromised upstream slipped it in — abort. This
// is belt-and-braces on top of ALLOWLIST subtraction (proton.me / icloud.com
// are also allowlisted; the rest are mainstream providers we never curate in).
const CANARY_LEGIT: ReadonlyArray<string> = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
];

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

// Repo root is four levels up from this file (.../packages/data/src/scripts).
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const TARGET_JSON = path.join(
  REPO_ROOT,
  "apps/civitics/src/lib/disposable-email-domains.json",
);

interface Args {
  source: string | null;
  latest: boolean;
  writePin: boolean;
}

function parseArgs(argv: string[]): Args {
  let source: string | null = null;
  const latest = argv.includes("--latest");
  const writePin = argv.includes("--write-pin");
  const srcIdx = argv.indexOf("--source");
  if (srcIdx >= 0) {
    const v = argv[srcIdx + 1];
    if (!v || v.startsWith("--")) {
      throw new Error("--source requires a SHA value");
    }
    source = v;
  }
  if (source && !/^[0-9a-f]{7,40}$/i.test(source)) {
    throw new Error(`--source is not a hex commit SHA: ${source}`);
  }
  return { source, latest, writePin };
}

async function loadCurated(): Promise<string[]> {
  // Read the committed JSON so the union never drops a hand-picked entry.
  const raw = await readFile(TARGET_JSON, "utf8");
  return JSON.parse(raw) as string[];
}

/**
 * Resolve the upstream default-branch HEAD SHA via the GitHub API. Public repo,
 * so no auth is required; if GITHUB_TOKEN is present (CI) we send it purely to
 * lift the 60/hr unauthenticated rate limit. Returns the full 40-char SHA.
 */
async function resolveLatestSha(): Promise<string> {
  const url = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits?per_page=1`;
  const headers: Record<string, string> = {
    "User-Agent": "civitics-refresh-disposable-emails",
    Accept: "application/vnd.github+json",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API HEAD-SHA resolve failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Array<{ sha?: string }>;
  const sha = body?.[0]?.sha;
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub API returned no valid HEAD SHA (got: ${JSON.stringify(sha)})`);
  }
  return sha.toLowerCase();
}

async function fetchUpstream(sha: string): Promise<string[]> {
  const res = await fetch(rawUrlFor(sha));
  if (!res.ok) {
    throw new Error(`Upstream fetch failed (@${sha.slice(0, 7)}): ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    // Drop blanks and any comment lines (`#` — the .conf format permits them).
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Pure list builder: (curated ∪ upstream) − ALLOWLIST, sorted. Exported so the
 * gates + shape can be reasoned about without a network round-trip.
 */
export function buildFinalList(curated: string[], upstream: string[]): string[] {
  const merged = new Set<string>();
  for (const d of curated) merged.add(d.trim().toLowerCase());
  for (const d of upstream) merged.add(d.trim().toLowerCase());
  for (const allowed of ALLOWLIST) merged.delete(allowed);
  return [...merged].sort();
}

/**
 * Fail-closed sanity gates (FIX-655). Throws with a specific message on any
 * violation; callers must run this BEFORE writing so a bad regen never touches
 * the tree. Returns silently when the list is safe to commit.
 */
export function assertSaneList(list: string[]): void {
  if (list.length < MIN_DOMAINS || list.length > MAX_DOMAINS) {
    throw new Error(
      `blocklist size ${list.length} outside sane bounds [${MIN_DOMAINS}, ${MAX_DOMAINS}] — ` +
        `refusing to write (upstream likely broke or was flooded).`,
    );
  }
  const asSet = new Set(list);
  const hits = CANARY_LEGIT.filter((d) => asSet.has(d));
  if (hits.length > 0) {
    throw new Error(
      `canary legit domain(s) present in blocklist: ${hits.join(", ")} — ` +
        `refusing to write (upstream may be compromised).`,
    );
  }
}

/** Rewrite the SOURCE_COMMIT pin in THIS file to `sha`. */
async function writePin(sha: string): Promise<void> {
  const src = await readFile(SCRIPT_PATH, "utf8");
  const re = /const SOURCE_COMMIT = "[0-9a-f]+";/;
  if (!re.test(src)) {
    throw new Error("could not locate SOURCE_COMMIT pin line to rewrite");
  }
  const next = src.replace(re, `const SOURCE_COMMIT = "${sha}";`);
  await writeFile(SCRIPT_PATH, next, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the effective SHA. --source wins; else --latest resolves HEAD; else
  // the committed pin. Any resolve/fetch failure throws BEFORE we touch the tree.
  let effectiveSha = SOURCE_COMMIT;
  if (args.source) {
    effectiveSha = args.source.toLowerCase();
  } else if (args.latest) {
    effectiveSha = await resolveLatestSha();
  }

  const [curated, upstream] = await Promise.all([
    loadCurated(),
    fetchUpstream(effectiveSha),
  ]);

  const sorted = buildFinalList(curated, upstream);

  // Gates BEFORE any write — a violation aborts with the tree untouched.
  assertSaneList(sorted);

  const nextJson = JSON.stringify(sorted, null, 2) + "\n";
  const currentJson = await readFile(TARGET_JSON, "utf8").catch(() => "");
  const changed = nextJson !== currentJson;
  const pinChanged = effectiveSha !== SOURCE_COMMIT;

  console.log(`curated starter:   ${curated.length}`);
  console.log(`upstream fetched:  ${upstream.length}  (@${effectiveSha.slice(0, 7)})`);
  console.log(`allowlist size:    ${ALLOWLIST.size}`);
  console.log(`final list:        ${sorted.length}  (gates OK: bounds + canary)`);

  if (!changed) {
    // Invariant (c): no content delta → write nothing (not even the pin), so
    // create-pull-request opens no PR. Pin-only churn is deliberately avoided.
    console.log(
      pinChanged
        ? `no content change vs committed JSON (upstream @${effectiveSha.slice(0, 7)} yields an identical list) — leaving pin at ${SOURCE_COMMIT.slice(0, 7)}, nothing written.`
        : "no change vs committed JSON — nothing written.",
    );
    return;
  }

  await writeFile(TARGET_JSON, nextJson, "utf8");
  console.log(`wrote:             ${path.relative(REPO_ROOT, TARGET_JSON)}`);

  // Invariant (b): pin + JSON move together. Only bump the pin under --write-pin
  // (CI); casual local regens against a --source SHA leave the constant alone.
  if (args.writePin && pinChanged) {
    await writePin(effectiveSha);
    console.log(`bumped SOURCE_COMMIT pin: ${SOURCE_COMMIT.slice(0, 7)} → ${effectiveSha.slice(0, 7)}`);
  } else if (pinChanged) {
    console.log(
      `(pin NOT bumped — pass --write-pin to move SOURCE_COMMIT ${SOURCE_COMMIT.slice(0, 7)} → ${effectiveSha.slice(0, 7)})`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
