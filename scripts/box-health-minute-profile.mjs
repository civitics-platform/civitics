#!/usr/bin/env node
// box-health-minute-profile.mjs — FIX-1125 burst census (cc-202 / cc-203)
//
// The off-box memory ring, folded by minute-of-hour. Input is the JSON that
// `pnpm --filter @civitics/data data:box-health:series --hours 24 --json`
// prints (rows oldest first: at, mem_avail_mb, swapin_per_s, swapout_per_s, …).
//
// A row's swap rates are BACKWARD rates over the previous sample, and samples
// land at ~:x2:22, so the ":02" row covers :00:22 → :02:22. Whatever owns the
// ":02" burst fires at :00, not :02.
//
// USAGE
//   node scripts/box-health-minute-profile.mjs <ring.json> [--after <ISO>]
//        [--exclude <ISO>..<ISO>]... [--within <ISO>..<ISO>] [--json]
//
// --after keeps only rows stamped at or after the instant (cc-203: the cron
// move's deploy instant + 10 min). --exclude drops rows stamped inside a
// half-open window [from, to) and may repeat (cc-203: rule 81's saturation
// window, 10-08 17:10Z → box-clear). --within keeps ONLY rows inside one
// window — the excluded window's own profile, which is quoted but never read
// for a verdict. Δ mem_avail is taken only across a consecutive pair of KEPT
// rows (≤ 6 min apart, the series' MAX_RATE_GAP_S), so a cut never fabricates
// a delta across its edge.

import { readFileSync } from "node:fs";

const USAGE = "usage: node scripts/box-health-minute-profile.mjs <ring.json> [--after <ISO>] [--exclude <ISO>..<ISO>]... [--within <ISO>..<ISO>] [--json]";
const args = process.argv.slice(2);
let file = null;
let after = -Infinity;
const excludes = [];
let within = null;
function windowArg(v) {
  const [from, to] = String(v ?? "").split("..").map((s) => Date.parse(s));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    console.error(`[minute-profile] bad window ${JSON.stringify(v)} — want <ISO>..<ISO>, from < to`);
    process.exit(2);
  }
  return { from, to };
}
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--after") after = Date.parse(args[++i]);
  else if (a === "--exclude") excludes.push(windowArg(args[++i]));
  else if (a === "--within") within = windowArg(args[++i]);
  else if (a === "--json") continue;
  else if (!a.startsWith("--") && file === null) file = a;
  else {
    console.error(`[minute-profile] unknown argument ${JSON.stringify(a)}`);
    process.exit(2);
  }
}
if (!file || Number.isNaN(after)) {
  console.error(USAGE);
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
const all = JSON.parse(raw.slice(raw.indexOf("{"))).rows;
const inWin = (t, w) => t >= w.from && t < w.to;
const rows = all.filter((r) => {
  const t = Date.parse(r.at);
  return t >= after && !excludes.some((w) => inWin(t, w)) && (within === null || inWin(t, within));
});

const mean = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);
const max = (xs) => (xs.length === 0 ? null : Math.max(...xs));
// Lower median. One burst can carry a minute's mean (02:08Z 10-07: 3,484.9 against a median of 6.0).
const med = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]);
const nn = (xs) => xs.filter((x) => x !== null && x !== undefined);

function fold(subset) {
  const si = nn(subset.map((r) => r.r.swapin_per_s));
  const so = nn(subset.map((r) => r.r.swapout_per_s));
  const dm = nn(subset.map((r) => r.dmem));
  return { n: subset.length, swapin_mean: mean(si), swapin_med: med(si), swapin_max: max(si), swapout_mean: mean(so), swapout_med: med(so), swapout_max: max(so), dmem_mean: mean(dm) };
}

const withDelta = rows.map((r, i) => {
  const p = i > 0 ? rows[i - 1] : undefined;
  const gap = p ? (Date.parse(r.at) - Date.parse(p.at)) / 1000 : Infinity;
  return { r, minute: new Date(r.at).getUTCMinutes(), dmem: gap <= 360 ? r.mem_avail_mb - p.mem_avail_mb : null };
});

const byMinute = [];
for (let m = 0; m < 60; m++) {
  const s = withDelta.filter((x) => x.minute === m);
  if (s.length > 0) byMinute.push({ minute: m, ...fold(s) });
}
const KEY = [2, 32, 8, 38, 16, 46];
const other = { minute: "other", ...fold(withDelta.filter((x) => !KEY.includes(x.minute))) };
const iso = (w) => `${new Date(w.from).toISOString()}..${new Date(w.to).toISOString()}`;
const summary = {
  rows: rows.length,
  first_at: rows[0]?.at ?? null,
  last_at: rows.at(-1)?.at ?? null,
  after: Number.isFinite(after) ? new Date(after).toISOString() : null,
  excluded: excludes.map(iso),
  within: within ? iso(within) : null,
};

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...summary, by_minute: byMinute, other }, null, 2));
  process.exit(0);
}
const head = ["min", "n", "swpin_mean", "swpin_med", "swpin_max", "swpout_mean", "swpout_med", "swpout_max", "Δavail_mb"];
const line = (o) => [String(o.minute).padStart(5), o.n, o.swapin_mean, o.swapin_med, o.swapin_max, o.swapout_mean, o.swapout_med, o.swapout_max, o.dmem_mean]
  .map((v, i) => String(v ?? "—").padStart(head[i].length)).join("  ");
console.log(`[minute-profile] ${summary.rows} rows ${summary.first_at} → ${summary.last_at}${summary.after ? ` (after ${summary.after})` : ""}`);
for (const w of summary.excluded) console.log(`[minute-profile] excluded ${w}`);
if (summary.within) console.log(`[minute-profile] within ${summary.within} only`);
console.log(head.map((h) => h.padStart(5)).join("  "));
for (const o of byMinute) console.log(line(o));
console.log("-- key minutes (:02/:32 = :00/:30 owner; :08/:38 = :07/:37; :16/:46 = ec-crawl :15/:45) --");
for (const m of KEY) {
  const o = byMinute.find((x) => x.minute === m);
  if (o) console.log(line(o));
}
console.log(line(other));
