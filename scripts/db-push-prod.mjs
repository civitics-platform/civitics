#!/usr/bin/env node
// FIX-392 — `pnpm db:push:prod` wrapper for applying migrations to Supabase Pro.
//
// `supabase db push --linked` is unreliable on this CLI (v2.78.1): it fails
// with a cli_login_postgres role-alter error before touching any user
// migration. The reliable path is `--db-url` with the prod direct connection.
//
// This wrapper:
//   1. Reads SUPABASE_DB_PASSWORD from .env.local.prod (reading the file
//      directly sidesteps the `source` non-export trap — see CLAUDE.md
//      "Claude ↔ Database Access"; also works on Windows where there is no
//      `source`).
//   2. Injects it into the CLI-cached session-pooler URL
//      (supabase/.temp/pooler-url), falling back to a hardcoded default.
//   3. Prints the resolved command with the password redacted.
//   4. Runs `supabase db push --db-url <url>`, forwarding any extra args.
//
// Usage:
//   pnpm db:push:prod                 # apply all pending migrations to Pro
//   pnpm db:push:prod -- --dry-run    # list pending migrations, apply nothing
//   pnpm db:push:prod -- --include-all
//
// Extra args after `--` are forwarded verbatim to `supabase db push`.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
if (!password) {
  console.error(`[db:push:prod] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error("[db:push:prod] cannot build the prod connection string — aborting.");
  process.exit(1);
}

const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;

// Insert the password between the user and the host: scheme://user@host → scheme://user:pass@host
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (!url.includes("@") || url === baseUrl) {
  console.error(`[db:push:prod] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(1);
}
const redacted = url.replace(encodeURIComponent(password), "********");

// pnpm forwards the `--` argument separator itself, so process.argv can lead
// with a literal "--". Drop leading `--` tokens before they reach the supabase
// CLI: cobra treats `--` as end-of-flags, which makes it IGNORE a following
// --dry-run and silently turn a preview into a real push (and in a non-TTY the
// [Y/n] confirm auto-accepts). This guards that footgun.
let passthrough = process.argv.slice(2);
while (passthrough[0] === "--") passthrough = passthrough.slice(1);

const isDryRun = passthrough.includes("--dry-run");
const args = ["db", "push", "--db-url", url, ...passthrough];

console.log(
  `[db:push:prod] ${isDryRun ? "DRY RUN — listing pending migrations only, applying nothing" : "APPLYING pending migrations to PRODUCTION (Supabase Pro)"}.`,
);
console.log(`[db:push:prod] supabase db push --db-url "${redacted}"${passthrough.length ? " " + passthrough.join(" ") : ""}`);

const res = spawnSync("supabase", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[db:push:prod] failed to launch supabase CLI:`, res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
