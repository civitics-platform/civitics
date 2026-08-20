#!/usr/bin/env node
// scripts/drain-ec-donations.mjs — FIX-1069 supervised drain of the windowed
// incremental EC donations arm.
//
// WHY THIS EXISTS. After FIX-1069 the donations arm is 16 committed, budget-
// checked, resumable windows. That makes it safe to drive to convergence by
// hand in a quiet window, which is the point: the next scheduled firing should
// wake to a near-zero dirty set instead of the 1.96M-donor backlog that turned
// 2026-08-19 into a six-hour, zero-output run.
//
// It drives the SHIPPED functions — rebuild_ec_donations_incr_prepare(),
// _incr_window(), _incr_close() — one window per statement, exactly as
// run_entity_connections_rebuild() drives them. It is NOT a reimplementation,
// so a hand drain and a scheduled firing cannot diverge.
//
// SAFETY PROPERTIES:
//   * --until is a hard wall-clock stop checked BEFORE each window, so the
//     drain never starts a window it cannot finish inside the quiet slot.
//     Stopping is free: completed windows are already committed and their
//     watermarks advanced (FIX-1069's ratchet).
//   * every window is idempotent and range-scoped, so a re-run resumes.
//   * --dry-run stages nothing and writes nothing.
//   * refuses to write to prod without --allow-prod.
//   * deliberately NOT --single-transaction: each window must be its own
//     committed transaction, which is the entire point of the design.
//
// USAGE (from repo root):
//   node scripts/drain-ec-donations.mjs --local --dry-run
//   node scripts/drain-ec-donations.mjs --prod  --dry-run
//   node scripts/drain-ec-donations.mjs --prod  --allow-prod --until 04:45
//
// --until takes HH:MM in UTC, interpreted as the next occurrence.
// Default is 240 minutes from start.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SEP = "|@|";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const isProd = has("--prod");
const dryRun = has("--dry-run");

if (!isProd && !has("--local")) {
  console.error("drain-ec-donations — pass --local or --prod explicitly.");
  process.exit(1);
}
if (isProd && !dryRun && !has("--allow-prod")) {
  console.error("drain-ec-donations — refusing to write to PRODUCTION without --allow-prod.");
  process.exit(1);
}

// ── Deadline ────────────────────────────────────────────────────────────────
let deadline;
const untilArg = val("--until");
if (untilArg) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(untilArg);
  if (!m) {
    console.error(`drain-ec-donations — --until must be HH:MM (UTC), got "${untilArg}".`);
    process.exit(1);
  }
  const now = new Date();
  deadline = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Number(m[1]), Number(m[2]), 0, 0,
  ));
  if (deadline <= now) deadline = new Date(deadline.getTime() + 24 * 3600 * 1000);
} else {
  deadline = new Date(Date.now() + 240 * 60 * 1000);
}

// ── Connection ──────────────────────────────────────────────────────────────
function prodUrl() {
  const envFile = join(ROOT, ".env.local.prod");
  if (!existsSync(envFile)) throw new Error(".env.local.prod not found");
  const txt = readFileSync(envFile, "utf8");
  const pw = /^SUPABASE_DB_PASSWORD=(.*)$/m.exec(txt)?.[1]?.trim();
  if (!pw) throw new Error("SUPABASE_DB_PASSWORD not found in .env.local.prod");
  const poolerFile = join(ROOT, "supabase", ".temp", "pooler-url");
  const base = existsSync(poolerFile)
    ? readFileSync(poolerFile, "utf8").trim()
    : `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
  return base.replace(/^(postgresql:\/\/[^:]+):?[^@]*@/, `$1:${encodeURIComponent(pw)}@`);
}

const BOUNDS = [
  "00000000-0000-0000-0000-000000000000", "10000000-0000-0000-0000-000000000000",
  "20000000-0000-0000-0000-000000000000", "30000000-0000-0000-0000-000000000000",
  "40000000-0000-0000-0000-000000000000", "50000000-0000-0000-0000-000000000000",
  "60000000-0000-0000-0000-000000000000", "70000000-0000-0000-0000-000000000000",
  "80000000-0000-0000-0000-000000000000", "90000000-0000-0000-0000-000000000000",
  "a0000000-0000-0000-0000-000000000000", "b0000000-0000-0000-0000-000000000000",
  "c0000000-0000-0000-0000-000000000000", "d0000000-0000-0000-0000-000000000000",
  "e0000000-0000-0000-0000-000000000000", "f0000000-0000-0000-0000-000000000000",
];

const utc = (d) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";

// ── psql runner ─────────────────────────────────────────────────────────────
// Root scripts in this repo shell out to psql rather than depend on `pg`, which
// is only installed under packages/data.
let PSQL_URL = null;
function q(sql) {
  const res = spawnSync("psql", [PSQL_URL, "-v", "ON_ERROR_STOP=1", "-At", "-F", SEP], {
    input: sql + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`psql failed to launch: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`psql exited ${res.status}: ${(res.stderr || "").trim()}`);
  const warn = (res.stderr || "").trim();
  if (warn) {
    for (const l of warn.split("\n")) if (l.trim()) console.log(`[drain]   psql: ${l.trim()}`);
  }
  return (res.stdout || "").trim().split("\n").filter(Boolean).map((l) => l.split(SEP));
}

const DIRTY_SQL = `SELECT count(*), count(DISTINCT from_id)
     FROM public.financial_relationships
    WHERE relationship_type IN ('donation','ie_support','ie_oppose')
      AND updated_at > (SELECT (value->>'last_indexed_at')::timestamptz
                          FROM public.pipeline_state
                         WHERE key = 'entity_connections_donations')`;

function main() {
  PSQL_URL = isProd ? prodUrl() : LOCAL_URL;
  console.log(`[drain] target: ${isProd ? "PROD (Supabase Pro)" : "LOCAL"}`);
  console.log(`[drain] mode:   ${dryRun ? "DRY RUN (reads only)" : "DRAIN"}`);
  console.log(`[drain] now:    ${utc(new Date())}`);
  if (!dryRun) {
    console.log(`[drain] until:  ${utc(deadline)}  (hard stop, checked before each window)`);
  }

  const st = q(`SELECT coalesce(value->>'last_indexed_at','(none)'),
                       coalesce((value->'cycle')::text,'(none)'),
                       (SELECT count(*) FROM jsonb_each_text(value->'windows'))
                  FROM public.pipeline_state WHERE key = 'entity_connections_donations'`);
  if (!st.length) {
    console.error("[drain] no entity_connections_donations watermark row at all — this needs the");
    console.error("[drain] FULL windowed bootstrap path, not the incremental drain. Aborting.");
    process.exit(2);
  }
  console.log(`[drain] watermark (scalar): ${st[0][0]}`);
  console.log(`[drain] per-window keys:    ${st[0][2]}/16`);
  console.log(`[drain] open cycle:         ${st[0][1]}`);

  const d0 = q(DIRTY_SQL)[0];
  console.log(`[drain] dirty since scalar watermark: ${Number(d0[0]).toLocaleString()} rows / ${Number(d0[1]).toLocaleString()} donors`);

  if (dryRun) {
    console.log("[drain] dry run — nothing staged, nothing written.");
    return;
  }

  console.log("[drain] prepare — opening or resuming a cycle...");
  const t0 = Date.now();
  const target = q(`SELECT public.rebuild_ec_donations_incr_prepare()`)[0][0];
  const prepSec = ((Date.now() - t0) / 1000).toFixed(1);
  if (!target) {
    console.error("[drain] prepare returned NULL — no watermark exists, so this needs the FULL");
    console.error("[drain] windowed bootstrap path, not the incremental drain. Aborting.");
    process.exit(2);
  }
  const staged = q(`SELECT count(*) FROM public.ec_donations_incr_dirty`)[0][0];
  console.log(`[drain] prepare done in ${prepSec}s — target=${target}, ${Number(staged).toLocaleString()} donors staged`);

  let totalEdges = 0, ran = 0, skipped = 0, stoppedEarly = false;
  for (let i = 0; i < 16; i++) {
    if (Date.now() >= deadline.getTime()) {
      console.log(`[drain] DEADLINE reached before window ${i + 1}/16 — stopping cleanly.`);
      console.log("[drain] completed windows are committed and their watermarks advanced;");
      console.log("[drain] re-run this script to resume from here.");
      stoppedEarly = true;
      break;
    }
    const lo = BOUNDS[i];
    const hi = i < 15 ? `'${BOUNDS[i + 1]}'::uuid` : "NULL::uuid";
    const w0 = Date.now();
    const edges = Number(q(
      `SELECT public.rebuild_ec_donations_incr_window(${i}::int, '${lo}'::uuid, ${hi}, '${target}'::timestamptz)`
    )[0][0]);
    const secs = (Date.now() - w0) / 1000;
    totalEdges += edges;
    if (edges === 0 && secs < 2) {
      skipped++;
      console.log(`[drain]   window ${String(i + 1).padStart(2)}/16  SKIPPED (already at target)`);
    } else {
      ran++;
      console.log(`[drain]   window ${String(i + 1).padStart(2)}/16  ${edges.toLocaleString().padStart(9)} edges  ${secs.toFixed(1)}s  (elapsed ${((Date.now() - t0) / 60000).toFixed(1)}m)`);
    }
  }

  if (!stoppedEarly) {
    const closed = q(`SELECT public.rebuild_ec_donations_incr_close('${target}'::timestamptz)`)[0][0];
    console.log(`[drain] close: ${closed === "t"
      ? "cycle CLOSED — staging cleared, scalar watermark advanced"
      : "NOT closed (a window still lags)"}`);
  }

  const after = q(`SELECT value->>'last_indexed_at', (value ? 'cycle')::text
                     FROM public.pipeline_state WHERE key='entity_connections_donations'`)[0];
  const d1 = q(DIRTY_SQL)[0];

  console.log("");
  console.log("[drain] ---- result ------------------------------------------");
  console.log(`[drain] windows run: ${ran}   skipped: ${skipped}   edges written: ${totalEdges.toLocaleString()}`);
  console.log(`[drain] total elapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`[drain] scalar watermark now: ${after[0]}`);
  console.log(`[drain] cycle still open:     ${after[1]}`);
  console.log(`[drain] RESIDUAL dirty set:   ${Number(d1[0]).toLocaleString()} rows / ${Number(d1[1]).toLocaleString()} donors`);
  console.log("[drain] ^ this is what the next scheduled firing will find.");
}

try { main(); } catch (e) { console.error("[drain] FAILED:", e.message); process.exit(1); }
