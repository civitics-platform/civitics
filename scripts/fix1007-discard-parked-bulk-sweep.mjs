#!/usr/bin/env node
// fix1007-discard-parked-bulk-sweep.mjs
//
// FIX-1007 — discard the bulk sweep parked at chunk 16/32.
//
// The parked state on prod:
//   {"mode":"dirty","chunks":32,"chunk_cursor":16,
//    "sweep_target":"2026-08-08 03:35:26.632984+00",
//    "sweep_started_at":"2026-08-08 20:15:18.36423+00"}
//
// Its sweep_target is OLDER than donor_rollup_watermark.last_indexed_at, which
// the incremental path advanced past it on the 2026-08-09 09:00 firing. The
// remaining 16 chunks were planned against a recipient set frozen at that older
// target, so resuming could skip recipients dirtied between the two timestamps —
// a silent correctness gap, which is why FIX-1007 says explicitly: do NOT simply
// resume from chunk 16. Craig chose option (a): discard, and let the incremental
// path converge on its own now that FIX-1002 bounds each firing and FIX-1003
// keeps the arms unbloated.
//
// HOW "DISCARDED" IS SPELLED — the state's own convention, not a new one.
// donor_rollup_rebuild_bulk() decides whether a sweep is in flight with
//     v_cursor := COALESCE((v_state->>'chunk_cursor')::int, -1);
//     IF v_cursor >= 0 THEN ... resume ...
// so the single load-bearing act is REMOVING `chunk_cursor`. On a clean finish
// the procedure rewrites the row to {last_completed_at, mode, chunks, targets} —
// also cursorless. This script writes that same cursorless shape but
// deliberately does NOT write `last_completed_at`: this sweep did not complete,
// and claiming otherwise would put a false completion into the one row a future
// reader would consult. The discarded values are retained under `discarded_*`
// keys so the parked plan stays auditable after it stops being actionable.
//
// Net effect: the next donor_rollup_rebuild_bulk() call plans a FRESH sweep
// against the current watermark instead of replaying a stale plan.
//
//   node scripts/fix1007-discard-parked-bulk-sweep.mjs --prod  --confirm
//   node scripts/fix1007-discard-parked-bulk-sweep.mjs --prod            (dry run)

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const argv = process.argv.slice(2);
const target = argv.includes("--prod") ? "prod" : argv.includes("--local") ? "local" : null;
const confirm = argv.includes("--confirm");

if (!target) {
  console.error("usage: fix1007-discard-parked-bulk-sweep.mjs --prod|--local [--confirm]");
  process.exit(2);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

let url, label;
if (target === "local") {
  url = LOCAL_URL;
  label = "LOCAL (127.0.0.1:54322)";
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1007] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE)
    ? readFileSync(POOLER_FILE, "utf8").trim()
    : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  label = "PROD (Supabase Pro) — WRITE";
}

const BEFORE_SQL = `
\\echo '--- BEFORE ---'
SELECT key, jsonb_pretty(value) AS value, updated_at
FROM public.pipeline_state
WHERE key IN ('donor_rollup_bulk_sweep', 'donor_rollup_watermark')
ORDER BY key;
`;

// Guarded by the cursor's presence: if some other process has already cleared or
// advanced the sweep since the read above, this is a no-op rather than a clobber.
const APPLY_SQL = BEFORE_SQL + `
\\echo '--- DISCARD ---'
UPDATE public.pipeline_state
   SET value = jsonb_build_object(
         'mode',                       value->>'mode',
         'chunks',                     (value->>'chunks')::int,
         'discarded_at',               now()::text,
         'discarded_by',               'FIX-1007',
         'discarded_chunk_cursor',     (value->>'chunk_cursor')::int,
         'discarded_sweep_target',     value->>'sweep_target',
         'discarded_sweep_started_at', value->>'sweep_started_at',
         'discard_reason',
           'sweep_target predates donor_rollup_watermark.last_indexed_at; the '
           'remaining chunks were planned against a stale recipient set, so '
           'resuming could skip recipients dirtied between the two timestamps. '
           'Discarded per FIX-1007 option (a) — the incremental path converges '
           'on its own. No last_completed_at: this sweep did NOT complete.'),
       updated_at = clock_timestamp()
 WHERE key = 'donor_rollup_bulk_sweep'
   AND value ? 'chunk_cursor';

\\echo '--- AFTER ---'
SELECT key, jsonb_pretty(value) AS value, updated_at
FROM public.pipeline_state
WHERE key IN ('donor_rollup_bulk_sweep', 'donor_rollup_watermark')
ORDER BY key;

\\echo '--- next bulk call plans FRESH? (cursor must resolve to -1) ---'
SELECT COALESCE((value->>'chunk_cursor')::int, -1) AS resume_cursor,
       CASE WHEN COALESCE((value->>'chunk_cursor')::int, -1) < 0
            THEN 'FRESH SWEEP' ELSE 'WOULD RESUME' END AS verdict
FROM public.pipeline_state WHERE key = 'donor_rollup_bulk_sweep';
`;

console.error(`[fix1007] ${label}`);
console.error(`[fix1007] mode: ${confirm ? "APPLY (discard parked cursor)" : "DRY RUN (read only)"}`);

const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "--single-transaction"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: confirm ? APPLY_SQL : BEFORE_SQL,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1007] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
