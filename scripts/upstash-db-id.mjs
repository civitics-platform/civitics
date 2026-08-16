#!/usr/bin/env node
// upstash-db-id.mjs — resolve UPSTASH_DATABASE_ID from the credentials already
// in .env.local.prod, so nobody has to hand-copy a UUID out of a console.
//
// WHY THIS EXISTS: the Upstash MANAGEMENT API (api.upstash.com/v2) addresses
// databases by a UUID `database_id`, which is NOT derivable from the data-plane
// `UPSTASH_REDIS_REST_URL` (that is a hostname/slug). The two are linked only by
// the `endpoint` field in the management API's database list. This script does
// that join, and in doing so also proves the freshly-minted management key
// actually authenticates — which is the other thing you want to know at that
// moment.
//
//   node scripts/upstash-db-id.mjs            # resolve + print the env line
//   node scripts/upstash-db-id.mjs --all      # list every database on the account
//
// Reads UPSTASH_EMAIL / UPSTASH_API_KEY / UPSTASH_REDIS_REST_URL from
// .env.local.prod by direct file read — the same trick as cf-analytics.mjs and
// db-query.mjs, which sidesteps the `source`-doesn't-export trap and keeps
// $(...) command substitution out of the agent's command line.
//
// SECURITY NOTE. The management key is UNSCOPED — Upstash's own docs list
// per-privilege keys as a roadmap item ("you will be able to create a key with
// read-only access"), not a shipped feature. So this credential can delete
// databases. It is strictly more privileged than UPSTASH_REDIS_REST_TOKEN.
// This script only ever issues GETs, and never prints the key.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const API = "https://api.upstash.com/v2";

function loadEnv(names) {
  let text;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    console.error(`[upstash-db-id] cannot read ${ENV_FILE}`);
    process.exit(1);
  }
  const out = {};
  // NB: .env.local.prod is CRLF on this machine. Strip the \r BEFORE matching —
  // in JS `.` does not match \r (it is a line terminator), so a `(.*)$` pattern
  // silently fails on every line of a CRLF file. Cost 10 minutes once.
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    for (const name of names) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
      if (m) out[name] = m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = loadEnv(["UPSTASH_EMAIL", "UPSTASH_API_KEY", "UPSTASH_REDIS_REST_URL"]);
const missing = ["UPSTASH_EMAIL", "UPSTASH_API_KEY"].filter((k) => !env[k]);
if (missing.length) {
  console.error(
    `[upstash-db-id] ${missing.join(" and ")} not found in .env.local.prod.\n` +
      `  Mint a key at Upstash console → Account → Management API. It is shown ONCE.`,
  );
  process.exit(1);
}

/**
 * Upstash's docs disagree with themselves about the Basic-auth username: the
 * stats page says `-u username:password`, the list page says
 * `-u your_api_key:your_api_secret`. email:key is the pair that works, so try
 * it first and fall back rather than making the caller guess on a 401.
 */
async function listDatabases() {
  const pairs = [
    { label: "email:api_key", user: env.UPSTASH_EMAIL, pass: env.UPSTASH_API_KEY },
    { label: "api_key:email", user: env.UPSTASH_API_KEY, pass: env.UPSTASH_EMAIL },
  ];
  let lastStatus = 0;
  for (const p of pairs) {
    const auth = Buffer.from(`${p.user}:${p.pass}`).toString("base64");
    const res = await fetch(`${API}/redis/databases`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (res.ok) {
      const body = await res.json();
      if (p.label !== "email:api_key") {
        console.log(`[upstash-db-id] NB: authenticated as ${p.label}, not the documented order.`);
      }
      return Array.isArray(body) ? body : [];
    }
    lastStatus = res.status;
    if (res.status !== 401 && res.status !== 403) break;
  }
  console.error(
    `[upstash-db-id] auth failed (HTTP ${lastStatus}) on both credential orders.\n` +
      `  Check UPSTASH_EMAIL is the Upstash ACCOUNT email and that the key was\n` +
      `  copied whole — Upstash does not store it, so a truncated paste is silent.`,
  );
  process.exit(1);
}

/** Host of the data-plane REST URL, e.g. "eager-mule-12345.upstash.io". */
function restHost() {
  if (!env.UPSTASH_REDIS_REST_URL) return null;
  try {
    return new URL(env.UPSTASH_REDIS_REST_URL).host.toLowerCase();
  } catch {
    return env.UPSTASH_REDIS_REST_URL.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  }
}

const dbs = await listDatabases();
if (!dbs.length) {
  console.error("[upstash-db-id] the account has no Redis databases.");
  process.exit(1);
}

if (process.argv.includes("--all")) {
  console.log(`${dbs.length} database(s) on this account:\n`);
  for (const d of dbs) {
    console.log(`  ${d.database_name}`);
    console.log(`    database_id : ${d.database_id}`);
    console.log(`    endpoint    : ${d.endpoint}`);
    console.log(`    region      : ${d.primary_region ?? d.region ?? "?"}`);
    console.log(`    type/state  : ${d.type ?? "?"} / ${d.state ?? "?"}\n`);
  }
  process.exit(0);
}

const host = restHost();
// `endpoint` is documented as "endpoint identifier or hostname … may be a slug
// like 'beloved-stallion-58500' or a full host", so match both shapes.
const match = host
  ? dbs.find((d) => {
      const ep = String(d.endpoint ?? "").toLowerCase();
      return ep === host || host.startsWith(`${ep}.`) || ep.startsWith(host);
    })
  : null;

if (!match) {
  console.error(
    `[upstash-db-id] no database on this account matches UPSTASH_REDIS_REST_URL` +
      `${host ? ` (host ${host})` : " (unset)"}.\n` +
      `  Run with --all and pick the right one by hand — but note a mismatch means\n` +
      `  the management key and the REST token belong to DIFFERENT accounts, which\n` +
      `  would make any usage number read from the API describe the wrong database.`,
  );
  process.exit(1);
}

console.log(`[upstash-db-id] matched "${match.database_name}" (${match.endpoint})`);
console.log(`[upstash-db-id] state=${match.state ?? "?"} type=${match.type ?? "?"} region=${match.primary_region ?? "?"}\n`);
console.log(`UPSTASH_DATABASE_ID=${match.database_id}`);
