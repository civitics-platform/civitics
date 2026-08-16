#!/usr/bin/env node
// cf-analytics.mjs — Cloudflare zone analytics as TEXT, so an agent can read
// edge traffic without a dashboard screenshot.
//
// WHY THIS EXISTS: the Cloudflare layer is the one tier of the stack the repo
// could not see. docs/CLOUDFLARE.md §5 says "the Cloudflare layer cannot be
// verified by script" — that is true of the REQUEST PATH (CF 403s every scripted
// probe), but NOT of the ANALYTICS API, which the existing CLOUDFLARE_API_TOKEN
// already has scope for. During the 2026-08-15 crawl incident this was the only
// clean discriminator between "traffic stopped" and "traffic stopped being
// counted" — see docs/audits/2026-08-15-traffic-cost-spike.md.
//
//   node scripts/cf-analytics.mjs                 # last 24h, hourly
//   node scripts/cf-analytics.mjs --hours 6
//   node scripts/cf-analytics.mjs --since 2026-08-15T06:00:00Z --hours 12
//
// Reads CLOUDFLARE_API_TOKEN from .env.local.prod by direct file read — the
// same trick as db-query.mjs / db-push-prod.mjs, which sidesteps the `source`
// non-export trap and keeps the agent's command free of $(...) substitution.
//
// FREE-PLAN LIMIT: the GraphQL Analytics API refuses a range wider than 1 day
// on a Free zone ("cannot request a time range wider than 1d"). --hours is
// clamped to 24. For a longer view, run it repeatedly with --since.
// Read-only: this script only ever issues GraphQL queries.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const ZONE_NAME = "civitics.com";
const API = "https://api.cloudflare.com/client/v4";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadToken() {
  let text;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    console.error(`[cf-analytics] cannot read ${ENV_FILE}`);
    process.exit(1);
  }
  // NB: .env.local.prod is CRLF on this machine. Strip the \r BEFORE matching —
  // in JS `.` does not match \r (it is a line terminator), so a `(.*)$` pattern
  // silently fails on every line of a CRLF file. Cost 10 minutes once.
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  console.error("[cf-analytics] CLOUDFLARE_API_TOKEN not found in .env.local.prod");
  process.exit(1);
}

const TOKEN = loadToken();
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function gql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("[cf-analytics] GraphQL error:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data?.viewer?.zones?.[0] ?? null;
}

async function resolveZoneId() {
  const res = await fetch(`${API}/zones?name=${ZONE_NAME}`, { headers: HEADERS });
  const json = await res.json();
  if (!json.success || !json.result?.[0]) {
    console.error(
      `[cf-analytics] zone lookup failed — the token may lack Zone:Read, or the ` +
        `zone moved accounts (see docs/CLOUDFLARE.md).`,
    );
    process.exit(1);
  }
  return json.result[0];
}

const zone = await resolveZoneId();
const hours = Math.min(24, Math.max(1, Number(arg("hours", "24"))));
const until = arg("since")
  ? new Date(new Date(arg("since")).getTime() + hours * 3600_000)
  : new Date(Date.now() - 60_000);
const since = new Date(until.getTime() - hours * 3600_000);
const vars = { zoneTag: zone.id, since: since.toISOString(), until: until.toISOString() };

console.log(`[cf-analytics] zone=${zone.name} id=${zone.id} plan=${zone.plan?.name}`);
console.log(`[cf-analytics] window ${vars.since} .. ${vars.until} (${hours}h, UTC)\n`);

const GROUPS = `
query ($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer { zones(filter: {zoneTag: $zoneTag}) {
    httpRequestsAdaptiveGroups(limit: 2000,
      filter: {datetime_geq: $since, datetime_leq: $until},
      orderBy: [datetimeHour_ASC]) {
      count
      dimensions { datetimeHour clientRequestHTTPHost edgeResponseStatus cacheStatus }
    }
  } }
}`;

const data = await gql(GROUPS, vars);
const rows = data?.httpRequestsAdaptiveGroups ?? [];
if (!rows.length) {
  console.log("(no rows — zone may have had no traffic in the window)");
  process.exit(0);
}

const byHour = new Map();
for (const r of rows) {
  const k = r.dimensions.datetimeHour;
  if (!byHour.has(k)) byHour.set(k, { total: 0, hosts: new Map(), status: new Map(), hit: 0 });
  const b = byHour.get(k);
  const { clientRequestHTTPHost: host, edgeResponseStatus: st, cacheStatus: cs } = r.dimensions;
  b.total += r.count;
  b.hosts.set(host, (b.hosts.get(host) ?? 0) + r.count);
  b.status.set(st, (b.status.get(st) ?? 0) + r.count);
  if (cs === "hit") b.hit += r.count;
}

// 403 is the tell for a Cloudflare challenge/block; 200 is what reached the
// origin. The gap between them is the whole story of a mitigation.
console.log("hour_utc                total      200      403    other   cache_hit  top_host");
let gTotal = 0, g200 = 0, g403 = 0;
for (const [hr, b] of [...byHour.entries()].sort()) {
  const s200 = b.status.get(200) ?? 0;
  const s403 = b.status.get(403) ?? 0;
  const other = b.total - s200 - s403;
  gTotal += b.total; g200 += s200; g403 += s403;
  const top = [...b.hosts.entries()].sort((a, c) => c[1] - a[1])[0];
  console.log(
    `${hr}  ${String(b.total).padStart(7)}  ${String(s200).padStart(7)}  ` +
      `${String(s403).padStart(7)}  ${String(other).padStart(7)}  ` +
      `${String(b.hit).padStart(9)}  ${top ? `${top[0]}=${top[1]}` : "-"}`,
  );
}
console.log(
  `\nTOTAL ${gTotal}   reached-origin(200) ${g200}   ` +
    `mitigated(403) ${g403}   → ${((g403 / gTotal) * 100).toFixed(1)}% mitigated`,
);
