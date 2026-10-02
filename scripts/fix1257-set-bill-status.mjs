#!/usr/bin/env node
// fix1257-set-bill-status.mjs — ONE authorized prod data set (FIX-1257, cc-180).
//
// HR 4795 (proposal 0e2433b5-0fd3-4e27-a3ae-9741c468122d, the 08-04 key-holder)
// passed the House on roll 2026-house-295 (On Passage, Passed 237–169), but
// reads `introduced`: cc-177's FIX-1256 repair copied the stub's newer status
// onto the holder, and the stub's status came from mapBillStatus(), which reads
// only latestAction.text ("Motion to reconsider laid on the table…" falls
// through to the introduced default). This hand-sets the status the vote path
// itself derives for that roll: mapVoteResult("Passed") → passed_chamber
// (packages/data/src/pipelines/congress/members.ts).
//
// TEMPORARY BY CONSTRUCTION. The recent-bills sync (congress/votes.ts Step 1 →
// upsertBillProposalsBatch) upserts `status` with no regression guard, so the
// next time HR 4795 enters the top-50 `updateDate desc` list the value reverts.
// The durable fix — a status that never goes backwards, and a mapper that reads
// the action sequence — is FIX-1257's own prompt, not this script.
//
// THE POPULATION (rule 45): exactly the bills named in ITEMS below, each
// resolved by its bill_details natural key AND its congress_gov ref to ONE
// proposal, with the named roll present in votes on that proposal and mapping
// to a status. Nothing is derived beyond that.
//
// PER ITEM, ONE DO STATEMENT: re-read the row FOR UPDATE; if the status is not
// the manifest's expected_status, SKIP with the live value (the world moved, or
// the item already landed — the idempotent re-run); otherwise UPDATE status and
// RAISE NOTICE the before and after. The proposals updated_at trigger stamps
// updated_at.
//
// MODES (exactly one; target --local or --prod, always explicit):
//   --build-manifest [--out P]  READ ONLY: resolve each item, write the manifest
//   --dry-run                   READ ONLY: per item, the precondition and the plan
//   --apply                     the write. On --prod it refuses unless it runs
//                               under a FIX-950 claim (session:wait-for-gate
//                               --then sets CIVITICS_PROD_SESSION_CLAIMANT)
//   --seed-rehearsal            --local ONLY: give the clone prod's state (status
//                               `introduced`) and one marked vote row for the
//                               roll it predates
//   --unseed-rehearsal          --local ONLY: delete that marked vote row
// --manifest P (default docs/audits/2026-10-01-fix1257-hr4795-status.json);
// an apply refuses a manifest built on the other database.
//
// USAGE — prod reads the password from .env.local.prod; a worktree's copy is a
// stub, so run prod from the PRIMARY checkout (or pass --env-file):
//   node scripts/fix1257-set-bill-status.mjs --prod --build-manifest
//   node scripts/fix1257-set-bill-status.mjs --prod --dry-run
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 1 --census off \
//     --reason "cc-180 FIX-1257 HR 4795 status" \
//     --then "node ../../scripts/fix1257-set-bill-status.mjs --prod --apply"

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DEFAULT_MANIFEST = join(ROOT, "docs", "audits", "2026-10-01-fix1257-hr4795-status.json");
const STATEMENT_TIMEOUT = "30s";

/** The bills this script may touch. */
const ITEMS = [
  { external_id: "119-HR-4795", session: "119", bill_number: "HR 4795", roll: "2026-house-295" },
];

// mapVoteResult() in packages/data/src/pipelines/congress/members.ts, copied
// for the one case this script writes. A roll that maps anywhere else (failed,
// floor_vote) is refused rather than guessed.
const PASSED = new Set(["passed", "agreed to", "amendment agreed to", "nomination confirmed", "resolution agreed to"]);
const statusForRoll = (result) => (PASSED.has(String(result).trim().toLowerCase()) ? "passed_chamber" : null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_RE = /^[a-z_]+$/;

// ── args / connection ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const MODES = ["--build-manifest", "--dry-run", "--apply", "--seed-rehearsal", "--unseed-rehearsal"];
const modes = MODES.filter(has);
if (modes.length !== 1) usage(`pass exactly one of ${MODES.join(" | ")}`);
const MODE = modes[0];
if (has("--local") === has("--prod")) usage("pass exactly one of --local | --prod");
const TARGET = has("--prod") ? "prod" : "local";
if ((MODE === "--seed-rehearsal" || MODE === "--unseed-rehearsal") && TARGET !== "local") {
  usage(`${MODE} is --local only`);
}
const MANIFEST = resolve(argValue("--manifest", DEFAULT_MANIFEST));
const OUT = resolve(argValue("--out", MANIFEST));
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));
const TARGET_LABEL = TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL (127.0.0.1:54322)";

function usage(msg) {
  console.error(`[fix1257] ${msg}`);
  console.error("[fix1257] see the header of scripts/fix1257-set-bill-status.mjs");
  process.exit(64);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

function prodUrl() {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1257] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error("[fix1257] a worktree's .env.local.prod is a stub — run from the primary checkout or pass --env-file");
    process.exit(2);
  }
  const base = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  const u = base.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === base) {
    console.error("[fix1257] could not inject the password into the pooler URL");
    process.exit(2);
  }
  return u;
}
const url = TARGET === "local" ? LOCAL_URL : prodUrl();
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** Run SQL through psql; returns {status, stdout, stderr}. */
function psql(sql, { readOnly = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  if (readOnly) args.push("--single-transaction");
  const res = spawnSync("psql", args, {
    input: (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sql,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[fix1257] failed to launch psql: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function readJson(sql) {
  const res = psql(sql, { readOnly: true });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[fix1257] read failed (psql exit ${res.status})`);
    process.exit(1);
  }
  const line = res.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{") || l.trim().startsWith("[")).pop();
  return JSON.parse(line ?? "null");
}

// ── --build-manifest ─────────────────────────────────────────────────────────
function resolveItem(it) {
  return readJson(`
SELECT json_build_object(
  'holders', (SELECT json_agg(json_build_object('proposal_id', bd.proposal_id, 'jurisdiction_id', bd.jurisdiction_id, 'chamber', bd.chamber))
                FROM public.bill_details bd
               WHERE bd.session = ${lit(it.session)} AND bd.bill_number = ${lit(it.bill_number)}),
  'refs', (SELECT json_agg(r.entity_id) FROM public.external_source_refs r
            WHERE r.source = 'congress_gov' AND r.entity_type = 'proposal' AND r.external_id = ${lit(it.external_id)}),
  'proposal', (SELECT json_build_object('id', p.id, 'status', p.status, 'title', p.title,
                       'last_action_at', p.last_action_at, 'updated_at', p.updated_at,
                       'latest_action', p.metadata->'latest_action')
                 FROM public.proposals p
                 JOIN public.bill_details bd ON bd.proposal_id = p.id
                WHERE bd.session = ${lit(it.session)} AND bd.bill_number = ${lit(it.bill_number)}
                LIMIT 1),
  'roll', (SELECT json_agg(json_build_object('bill_proposal_id', v.bill_proposal_id, 'vote_result', v.metadata->>'vote_result',
                    'vote_question', v.vote_question, 'legis_num', v.metadata->>'legis_num', 'voted_at', v.voted_at,
                    'n', v.n, 'yes', v.yes, 'no', v.no))
             FROM (SELECT bill_proposal_id, metadata->>'vote_result' AS vr, vote_question, min(voted_at) AS voted_at,
                          count(*) AS n, count(*) FILTER (WHERE vote = 'yes') AS yes, count(*) FILTER (WHERE vote = 'no') AS no,
                          (array_agg(metadata))[1] AS metadata
                     FROM public.votes WHERE roll_call_id = ${lit(it.roll)}
                    GROUP BY bill_proposal_id, metadata->>'vote_result', vote_question) v)
);`);
}

function buildManifest() {
  console.log(`[fix1257] ${TARGET_LABEL} — READ ONLY: resolving ${ITEMS.length} item(s)`);
  const items = [];
  for (const it of ITEMS) {
    const r = resolveItem(it);
    const holders = r.holders ?? [];
    const refs = r.refs ?? [];
    const rolls = r.roll ?? [];
    const fail = (why) => {
      console.error(`[fix1257] ${it.external_id}: REFUSE — ${why}`);
      process.exit(3);
    };
    if (holders.length !== 1) fail(`${holders.length} bill_details rows hold (${it.session}, ${it.bill_number})`);
    const id = holders[0].proposal_id;
    if (refs.length !== 1 || refs[0] !== id) fail(`the congress_gov ref resolves to ${JSON.stringify(refs)}, not the key-holder ${id}`);
    if (rolls.length !== 1) fail(`roll ${it.roll} has ${rolls.length} (proposal, result, question) groups — expected exactly one`);
    const roll = rolls[0];
    if (roll.bill_proposal_id !== id) fail(`roll ${it.roll} is on ${roll.bill_proposal_id}, not ${id}`);
    const newStatus = statusForRoll(roll.vote_result);
    if (newStatus === null) fail(`roll ${it.roll} result "${roll.vote_result}" does not map to passed_chamber — STOP, do not guess`);
    const p = r.proposal;
    if (p.status !== "introduced") fail(`the proposal reads "${p.status}", not "introduced" — the premise moved`);
    items.push({
      proposal_id: id,
      bill_key: { external_id: it.external_id, jurisdiction_id: holders[0].jurisdiction_id, session: it.session, bill_number: it.bill_number, chamber: holders[0].chamber },
      title: p.title,
      expected_status: p.status,
      new_status: newStatus,
      roll: it.roll,
      roll_result: roll.vote_result,
      roll_question: roll.vote_question,
      roll_tally: { yes: roll.yes, no: roll.no, recorded: roll.n },
      latest_action: p.latest_action,
      last_action_at: p.last_action_at,
      updated_at_at_build: p.updated_at,
      reason:
        "cc-177's FIX-1256 copy rule took the stub's mapBillStatus value (latestAction.text alone: 'Motion to reconsider laid on the table' → introduced); " +
        `roll ${it.roll} ${roll.vote_question} ${roll.vote_result} ${roll.yes}–${roll.no}, which the vote path maps to ${newStatus}. ` +
        "Temporary: the recent-bills sync regresses it the next time the bill is in its top-50 list (FIX-1257).",
    });
    console.log(`[fix1257] ${it.external_id}: ${id} ${p.status} → ${newStatus} (roll ${it.roll} ${roll.vote_result} ${roll.yes}–${roll.no})`);
  }
  const manifest = { database: TARGET, fix: "FIX-1257", prompt: "cc-180", built_at: new Date().toISOString(), items };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[fix1257] wrote ${relative(ROOT, OUT)} (${items.length} item(s))`);
}

// ── --dry-run / --apply ──────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== TARGET) usage(`manifest was built on ${m.database}; refusing to use it on ${TARGET}`);
  for (const i of m.items) {
    if (!UUID_RE.test(i.proposal_id)) usage(`bad proposal_id ${i.proposal_id}`);
    if (!STATUS_RE.test(i.expected_status) || !STATUS_RE.test(i.new_status)) usage(`bad status in ${i.proposal_id}`);
  }
  return m;
}

function dryRun() {
  const m = loadManifest();
  console.log(`[fix1257] ${TARGET_LABEL} — READ ONLY dry run of ${relative(ROOT, MANIFEST)} (${m.items.length} item(s))`);
  for (const i of m.items) {
    const live = readJson(`SELECT json_build_object('status', status, 'updated_at', updated_at) FROM public.proposals WHERE id = ${lit(i.proposal_id)};`);
    if (!live) {
      console.log(`[fix1257] ${i.bill_key.external_id}: plan SKIP — proposal ${i.proposal_id} is gone`);
    } else if (live.status !== i.expected_status) {
      console.log(`[fix1257] ${i.bill_key.external_id}: precondition status = '${i.expected_status}' FAILS (live '${live.status}') — plan SKIP`);
    } else {
      console.log(`[fix1257] ${i.bill_key.external_id}: precondition status = '${i.expected_status}' holds (updated_at ${live.updated_at})`);
      console.log(`[fix1257]   plan: UPDATE public.proposals SET status = '${i.new_status}' WHERE id = '${i.proposal_id}' AND status = '${i.expected_status}'`);
    }
  }
}

function itemSql(i) {
  return `
DO $fix1257$
DECLARE
  v_before public.proposal_status;
  v_at     timestamptz;
BEGIN
  SELECT status, updated_at INTO v_before, v_at FROM public.proposals WHERE id = ${lit(i.proposal_id)} FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'FIX1257|SKIP|%|proposal % is gone', ${lit(i.bill_key.external_id)}, ${lit(i.proposal_id)}; RETURN;
  END IF;
  IF v_before::text <> ${lit(i.expected_status)} THEN
    RAISE NOTICE 'FIX1257|SKIP|%|status is % (expected %) — the world moved or this already landed', ${lit(i.bill_key.external_id)}, v_before, ${lit(i.expected_status)};
    RETURN;
  END IF;
  UPDATE public.proposals SET status = ${lit(i.new_status)}::public.proposal_status WHERE id = ${lit(i.proposal_id)};
  RAISE NOTICE 'FIX1257|DONE|%|% before % (updated_at %) after % (updated_at %)', ${lit(i.bill_key.external_id)}, ${lit(i.proposal_id)},
    v_before, v_at, (SELECT status FROM public.proposals WHERE id = ${lit(i.proposal_id)}),
    (SELECT updated_at FROM public.proposals WHERE id = ${lit(i.proposal_id)});
END
$fix1257$;
`;
}

function apply() {
  const m = loadManifest();
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (TARGET === "prod" && claimant === null) {
    usage("--prod --apply runs only under a FIX-950 claim — run it as session:wait-for-gate:prod --then");
  }
  if (claimant !== null && /[\r\n\0]/.test(claimant)) usage("CIVITICS_PROD_SESSION_CLAIMANT must be one line");
  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\nSET application_name = 'fix1257-set-bill-status';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  console.log(`[fix1257] ${TARGET_LABEL} — WRITE: ${m.items.length} item(s) from ${relative(ROOT, MANIFEST)}${claimant ? `; claimant ${claimant}` : ""}; start ${new Date().toISOString()}`);
  let failed = 0;
  for (const i of m.items) {
    const res = psql(pre + itemSql(i));
    const tagged = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).filter((l) => l.includes("FIX1257|")).map((l) => l.slice(l.indexOf("FIX1257|")));
    if (res.status === 0 && tagged.length) {
      console.log(`[fix1257] ${tagged[0]}`);
    } else {
      failed += 1;
      process.stderr.write(res.stderr);
      console.error(`[fix1257] ${i.bill_key.external_id}: psql exit ${res.status} — nothing written for this item`);
    }
  }
  console.log(`[fix1257] end ${new Date().toISOString()}`);
  process.exit(failed ? 1 : 0);
}

// ── --seed-rehearsal / --unseed-rehearsal (local only) ───────────────────────
// The clone predates roll 2026-house-295 (it landed in the 10-01 prod nightly),
// and a cc-177 rehearsal left its HR 4795 at passed_chamber. Seed prod's state:
// status `introduced`, plus ONE vote row for the roll, marked so unseed deletes
// only it.
function seed() {
  const it = ITEMS[0];
  const res = psql(`
WITH p AS (SELECT bd.proposal_id FROM public.bill_details bd WHERE bd.session = ${lit(it.session)} AND bd.bill_number = ${lit(it.bill_number)})
UPDATE public.proposals SET status = 'introduced' WHERE id = (SELECT proposal_id FROM p);
INSERT INTO public.votes (bill_proposal_id, official_id, vote, voted_at, roll_call_id, vote_question, chamber, session, metadata)
SELECT bd.proposal_id, (SELECT id FROM public.officials ORDER BY id LIMIT 1), 'yes', '2026-09-03T00:00:00Z', ${lit(it.roll)},
       'On Passage', 'House', '2', '{"vote_result": "Passed", "legis_num": "H R 4795", "fix1257_rehearsal": true}'::jsonb
  FROM public.bill_details bd WHERE bd.session = ${lit(it.session)} AND bd.bill_number = ${lit(it.bill_number)}
ON CONFLICT (roll_call_id, official_id) DO NOTHING;
`);
  if (res.status !== 0) { process.stderr.write(res.stderr); process.exit(1); }
  console.log("[fix1257] LOCAL seeded: HR 4795 status → introduced; one marked vote row for 2026-house-295");
}

function unseed() {
  const res = psql(`DELETE FROM public.votes WHERE roll_call_id = ${lit(ITEMS[0].roll)} AND metadata->>'fix1257_rehearsal' = 'true';`);
  if (res.status !== 0) { process.stderr.write(res.stderr); process.exit(1); }
  console.log("[fix1257] LOCAL unseeded: the marked vote row is gone (the status is left as the rehearsal set it)");
}

({ "--build-manifest": buildManifest, "--dry-run": dryRun, "--apply": apply,
   "--seed-rehearsal": seed, "--unseed-rehearsal": unseed })[MODE]();
