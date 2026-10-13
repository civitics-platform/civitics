#!/usr/bin/env node
// box-health-minute-profile-lit.mjs — FIX-1292 control (cc-216 scratch, committed by cc-219)
//
// The off-box memory ring folded by minute-of-hour, like
// scripts/box-health-minute-profile.mjs, plus the one column that script does
// not compute: how many samples per minute swapped in at more than 240 pages/s
// ("lit"). cc-216 judged the snapshot split with it — a slot is LIT when its
// median is > 240 and >= 80 % of its samples are > 240; QUIET when its median
// is < 60 and <= 2 samples are > 240 (rule 213: n >= 12 per slot is judged).
//
// Same filters as the sibling: --after keeps rows stamped at or after the
// instant; --exclude drops a half-open window [from, to) and may repeat;
// Δ mem_avail is taken only across a consecutive pair of KEPT rows <= 360 s
// apart. Reproduced cc-213 §2's pre-split figures exactly (:02 488.3/371.3
// 23/24, :32 423.8/355.0 23/24).
//
// USAGE
//   node scripts/box-health-minute-profile-lit.mjs <ring.json> [--after <ISO>]
//        [--exclude <ISO>..<ISO>]... [--list]
//
// Prints JSON: per-minute folds and the named slot groups. --list also prints
// every :10/:40/:24/:54/:02/:32 sample to stderr.

import { readFileSync } from "node:fs";

const USAGE = "usage: node scripts/box-health-minute-profile-lit.mjs <ring.json> [--after <ISO>] [--exclude <ISO>..<ISO>]... [--list]";
const args = process.argv.slice(2);
let file = null;
let after = -Infinity;
const ex = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--after") after = Date.parse(args[++i]);
  else if (a === "--exclude") {
    const [from, to] = String(args[++i] ?? "").split("..").map((s) => Date.parse(s));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      console.error(`[minute-profile-lit] bad window ${JSON.stringify(args[i])} — want <ISO>..<ISO>, from < to`);
      process.exit(2);
    }
    ex.push({ a: from, b: to });
  } else if (a === "--list") continue;
  else if (!a.startsWith("--") && file === null) file = a;
  else {
    console.error(`[minute-profile-lit] unknown argument ${JSON.stringify(a)}`);
    process.exit(2);
  }
}
if (!file || Number.isNaN(after)) {
  console.error(USAGE);
  process.exit(2);
}

const raw = readFileSync(file, "utf8");
const all = JSON.parse(raw.slice(raw.indexOf("{"))).rows;
const rows = all.filter((r) => {
  const t = Date.parse(r.at);
  return t >= after && !ex.some((w) => t >= w.a && t < w.b);
});
const wd = rows.map((r, i) => {
  const p = rows[i - 1];
  const gap = p ? (Date.parse(r.at) - Date.parse(p.at)) / 1000 : Infinity;
  return { r, m: new Date(r.at).getUTCMinutes(), d: gap <= 360 ? r.mem_avail_mb - p.mem_avail_mb : null };
});

const mean = (x) => (x.length ? Math.round((x.reduce((a, b) => a + b, 0) / x.length) * 10) / 10 : null);
// Lower median, as the sibling script.
const med = (x) => (x.length ? [...x].sort((a, b) => a - b)[Math.floor((x.length - 1) / 2)] : null);
function fold(s) {
  const si = s.map((x) => x.r.swapin_per_s).filter((v) => v != null);
  const dm = s.map((x) => x.d).filter((v) => v != null);
  const so = s.map((x) => x.r.swapout_per_s).filter((v) => v != null);
  const ld = s.map((x) => x.r.load1).filter((v) => v != null);
  const sc = s.map((x) => x.r.scrape_ms).filter((v) => v != null);
  return {
    n: s.length, n_si: si.length, mean: mean(si), med: med(si), max: si.length ? Math.max(...si) : null,
    gt240: si.filter((v) => v > 240).length, dmem: mean(dm), dmem_med: med(dm),
    so_med: med(so), load_med: med(ld), scrape_med: med(sc),
  };
}

const out = {};
for (let m = 0; m < 60; m++) {
  const s = wd.filter((x) => x.m === m);
  if (s.length) out[m] = fold(s);
}
const groups = {
  "usage :10": [10], "usage :40": [40], "usage :10+:40": [10, 40],
  "status :24": [24], "status :54": [54], "status :24+:54": [24, 54],
  "ctrl :08": [8], "ctrl :38": [38], "ctrl :22": [22], "ctrl :52": [52],
  "old :02": [2], "old :32": [32], "ec-crawl :16": [16], "ec-crawl :46": [46],
  "next :12": [12], "next :42": [42], "next :26": [26], "next :56": [56],
};
const key = [10, 40, 24, 54, 8, 38, 22, 52, 2, 32];
const g = {};
for (const [k, ms] of Object.entries(groups)) g[k] = fold(wd.filter((x) => ms.includes(x.m)));
g["every other minute (not the 10 key)"] = fold(wd.filter((x) => !key.includes(x.m)));
console.log(JSON.stringify({ rows: rows.length, first: rows[0]?.at, last: rows.at(-1)?.at, by_minute: out, groups: g }, null, 1));
if (args.includes("--list")) {
  for (const m of [10, 40, 24, 54, 2, 32]) {
    console.error(`-- :${m} samples --`);
    for (const x of wd.filter((y) => y.m === m)) console.error(x.r.at, x.r.swapin_per_s, x.d);
  }
}
