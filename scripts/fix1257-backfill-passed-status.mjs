#!/usr/bin/env node
// fix1257-backfill-passed-status.mjs — ONE authorized prod data set (FIX-1257, cc-181).
//
// Federal bills that PASSED a House passage roll but read introduced or
// in_committee, because the recent-bills sync used to upsert `status` from
// mapBillStatus(latestAction.text) — and a procedural text after the passage
// ("Motion to reconsider laid on the table…", "Received in the Senate…") fell
// to a lower stage. cc-181 read 2 (prod, 2026-10-03 01:58 UTC): 166 bills
// (69 introduced + 97 in_committee); 88 carry an On Passage roll, the other 78
// passed only on a suspension. The writer fix (Step 3 never lowers a status; a
// passage roll advances an existing bill) is commit 16e2cf36. This moves the
// bills the writer will never revisit: the sync reads only the top 50 by
// updateDate, and the vote path skips rolls it already stored.
//
// THE POPULATION (rule 8, re-derived here; the manifest is the number): a
// federal proposal with a bill_details row whose status ranks below
// passed_chamber (proposal_status_rank, migration 20261003000000), with at
// least one roll in `votes` whose vote_question is a passage question and
// whose metadata.vote_result is Passed / Agreed to, and NO later Failed roll on
// a passage question. Excluded and listed, never written:
//   - the Senate's "On Passage of the Bill": every Senate roll stores
//     vote_result "" (FIX-1260), so its outcome is not in the table;
//   - "Passage, Objections of the President To The Contrary Notwithstanding"
//     (a veto override — a different stage);
//   - a bill already at a terminal status (failed/vetoed/…): its rank is not
//     below passed_chamber, and the rule would hold it anyway (FIX-1261).
//
// THE WRITE: ONE statement — SELECT … FROM public.proposals_advance_status(
// ids, statuses) — whose argument IS the manifest's rows (rule 42). The RPC
// re-checks the rule against each locked row, so a row the sync advanced in the
// meantime is a no-op, counted as held with its live status.
//
// MODES (exactly one; target --local or --prod, always explicit):
//   --build-manifest [--out P]  READ ONLY: derive the population, write the manifest
//   --dry-run                   READ ONLY: per item, the precondition and the plan
//   --apply                     the write. On --prod it refuses unless it runs
//                               under a FIX-950 claim (session:wait-for-gate
//                               --then sets CIVITICS_PROD_SESSION_CLAIMANT)
//   --read-back                 READ ONLY: the live status of every manifest id
// --manifest P (default docs/audits/2026-10-03-fix1257-passed-status-backfill.json);
// an apply refuses a manifest built on the other database.
//
// USAGE — prod reads the password from .env.local.prod; a worktree's copy is a
// stub, so run prod from the PRIMARY checkout (or pass --env-file):
//   node scripts/fix1257-backfill-passed-status.mjs --prod --build-manifest
//   node scripts/fix1257-backfill-passed-status.mjs --prod --dry-run
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 2 --census off \
//     --reason "cc-181 FIX-1257 passed-status backfill (<N> rows)" \
//     --then "node ../../scripts/fix1257-backfill-passed-status.mjs --prod --apply"
//   node scripts/fix1257-backfill-passed-status.mjs --prod --read-back

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DEFAULT_MANIFEST = join(ROOT, "docs", "audits", "2026-10-03-fix1257-passed-status-backfill.json");
const STATEMENT_TIMEOUT = "60s";
const FEDERAL_JURISDICTION = "eb075dd5-038f-4b21-82f7-30f5c9e1d49a";
const NEW_STATUS = "passed_chamber";

/** House passage questions with a recorded result (prod's distinct values, 2026-10-03). */
const PASSAGE_QUESTIONS = [
  "On Passage",
  "On Motion to Suspend the Rules and Pass",
  "On Motion to Suspend the Rules and Pass, as Amended",
];
/** mapVoteResult() → passed_chamber, restricted to the values these questions carry. */
const PASSED_RESULTS = ["Passed", "Agreed to"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_RE = /^[a-z_]+$/;

// ── args / connection ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const MODES = ["--build-manifest", "--dry-run", "--apply", "--read-back"];
const modes = MODES.filter(has);
if (modes.length !== 1) usage(`pass exactly one of ${MODES.join(" | ")}`);
const MODE = modes[0];
if (has("--local") === has("--prod")) usage("pass exactly one of --local | --prod");
const TARGET = has("--prod") ? "prod" : "local";
const MANIFEST = resolve(argValue("--manifest", DEFAULT_MANIFEST));
const OUT = resolve(argValue("--out", MANIFEST));
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));
const TARGET_LABEL = TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL (127.0.0.1:54322)";

function usage(msg) {
  console.error(`[fix1257] ${msg}`);
  console.error("[fix1257] see the header of scripts/fix1257-backfill-passed-status.mjs");
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
const litList = (xs) => xs.map(lit).join(", ");

/** Run SQL through psql; returns {status, stdout, stderr}. */
function psql(sql, { readOnly = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  if (readOnly) args.push("--single-transaction");
  const res = spawnSync("psql", args, {
    input: (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sql,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[fix1257] failed to launch psql: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

/** The single JSON value a query printed — json_agg output spans lines, so parse from its first line to the end. */
function lastJsonLine(stdout) {
  const s = stdout.trim();
  const i = s.search(/^\s*[[{]/m);
  return JSON.parse(i === -1 ? "null" : s.slice(i));
}

function readJson(sql) {
  const res = psql(sql, { readOnly: true });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[fix1257] read failed (psql exit ${res.status})`);
    process.exit(1);
  }
  return lastJsonLine(res.stdout);
}

// ── --build-manifest ─────────────────────────────────────────────────────────
function buildManifest() {
  console.log(`[fix1257] ${TARGET_LABEL} — READ ONLY: deriving the population`);
  const r = readJson(`
WITH passage AS (
  SELECT v.bill_proposal_id AS pid, v.roll_call_id, v.vote_question, v.metadata->>'vote_result' AS vote_result,
         min(v.voted_at) AS voted_at
    FROM public.votes v
   WHERE v.vote_question IN (${litList(PASSAGE_QUESTIONS)})
   GROUP BY 1, 2, 3, 4
),
first_pass AS (
  SELECT DISTINCT ON (pid) pid, roll_call_id, vote_question, vote_result, voted_at
    FROM passage WHERE vote_result IN (${litList(PASSED_RESULTS)})
   ORDER BY pid, voted_at, roll_call_id
),
fed AS (
  SELECT p.id, p.status, p.title, p.last_action_at, p.metadata->>'latest_action' AS latest_action,
         bd.session, bd.bill_number, bd.chamber,
         (SELECT string_agg(r.external_id, ',' ORDER BY r.external_id) FROM public.external_source_refs r
           WHERE r.source = 'congress_gov' AND r.entity_type = 'proposal' AND r.entity_id = p.id) AS refs,
         fp.roll_call_id, fp.vote_question, fp.vote_result, fp.voted_at,
         (SELECT json_agg(json_build_object('roll', l.roll_call_id, 'question', l.vote_question, 'voted_at', l.voted_at))
            FROM passage l WHERE l.pid = p.id AND l.vote_result = 'Failed' AND l.voted_at > fp.voted_at) AS later_failed
    FROM first_pass fp
    JOIN public.proposals p ON p.id = fp.pid
    JOIN public.bill_details bd ON bd.proposal_id = p.id
   WHERE p.jurisdiction_id = ${lit(FEDERAL_JURISDICTION)}
)
SELECT json_build_object(
  'items', (SELECT json_agg(f ORDER BY f.status, f.session, f.bill_number) FROM fed f
             WHERE public.proposal_status_rank(f.status) < public.proposal_status_rank(${lit(NEW_STATUS)})),
  'correct', (SELECT json_object_agg(s, n) FROM (SELECT status::text AS s, count(*) AS n FROM fed
               WHERE public.proposal_status_rank(status) >= public.proposal_status_rank(${lit(NEW_STATUS)})
               GROUP BY 1) x),
  'questions', (SELECT json_agg(json_build_object('question', q, 'result', res, 'bills', n) ORDER BY q, res) FROM (
                  SELECT v.vote_question AS q, v.metadata->>'vote_result' AS res, count(DISTINCT v.bill_proposal_id) AS n
                    FROM public.votes v JOIN public.proposals p ON p.id = v.bill_proposal_id
                   WHERE p.jurisdiction_id = ${lit(FEDERAL_JURISDICTION)}
                     AND (v.vote_question ILIKE '%passage%' OR v.vote_question ILIKE '%suspend the rules and pass%')
                   GROUP BY 1, 2) x),
  'senate_only_below', (SELECT count(DISTINCT p.id) FROM public.votes v JOIN public.proposals p ON p.id = v.bill_proposal_id
                         WHERE p.jurisdiction_id = ${lit(FEDERAL_JURISDICTION)} AND v.vote_question = 'On Passage of the Bill'
                           AND public.proposal_status_rank(p.status) < public.proposal_status_rank(${lit(NEW_STATUS)})
                           AND NOT EXISTS (SELECT 1 FROM first_pass fp WHERE fp.pid = p.id))
);`);
  const all = r.items ?? [];
  const excluded = all.filter((i) => i.later_failed);
  const items = all
    .filter((i) => !i.later_failed)
    .map((i) => ({
      proposal_id: i.id,
      bill_key: { external_id: i.refs, session: i.session, bill_number: i.bill_number, chamber: i.chamber },
      title: i.title,
      current_status: i.status,
      roll_call_id: i.roll_call_id,
      vote_question: i.vote_question,
      vote_result: i.vote_result,
      voted_at: i.voted_at,
      latest_action: i.latest_action,
      last_action_at: i.last_action_at,
      new_status: NEW_STATUS,
    }));
  for (const i of items) {
    if (!UUID_RE.test(i.proposal_id)) usage(`bad proposal_id ${i.proposal_id}`);
  }
  const byStatus = {};
  const byQuestion = {};
  for (const i of items) {
    byStatus[i.current_status] = (byStatus[i.current_status] ?? 0) + 1;
    byQuestion[i.vote_question] = (byQuestion[i.vote_question] ?? 0) + 1;
  }
  const onPassage = new Set(
    readJson(`SELECT json_agg(DISTINCT bill_proposal_id) FROM public.votes
               WHERE vote_question = 'On Passage' AND metadata->>'vote_result' IN (${litList(PASSED_RESULTS)})
                 AND bill_proposal_id = ANY (ARRAY[${items.map((i) => lit(i.proposal_id)).join(", ") || "NULL"}]::uuid[]);`) ?? [],
  );
  const manifest = {
    database: TARGET,
    fix: "FIX-1257",
    prompt: "cc-181",
    built_at: new Date().toISOString(),
    population: {
      rule: "federal bill (bill_details row), status rank < passed_chamber, a House passage roll with result Passed/Agreed to, no later Failed passage roll",
      passage_questions_included: PASSAGE_QUESTIONS,
      passed_results_included: PASSED_RESULTS,
      questions_excluded: [
        "On Passage of the Bill (Senate) — every Senate roll stores vote_result '' (FIX-1260)",
        "Passage, Objections of the President To The Contrary Notwithstanding — a veto override, not a chamber passage",
      ],
      distinct_questions_seen: r.questions ?? [],
      counts: {
        rows: items.length,
        by_current_status: byStatus,
        by_first_passing_question: byQuestion,
        with_an_on_passage_roll: items.filter((i) => onPassage.has(i.proposal_id)).length,
        suspension_only: items.filter((i) => !onPassage.has(i.proposal_id)).length,
        already_at_or_above_passed_chamber: r.correct ?? {},
        excluded_later_failed_passage_roll: excluded.length,
        senate_passage_roll_only_below_passed_chamber: r.senate_only_below ?? 0,
      },
      excluded_later_failed: excluded.map((i) => ({ proposal_id: i.id, bill_number: i.bill_number, later_failed: i.later_failed })),
    },
    items,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[fix1257] ${JSON.stringify(manifest.population.counts)}`);
  for (const q of manifest.population.distinct_questions_seen) console.log(`[fix1257]   seen: ${q.question} / ${q.result || "''"} — ${q.bills} bill(s)`);
  console.log(`[fix1257] wrote ${relative(ROOT, OUT)} (${items.length} item(s))`);
}

// ── --dry-run / --apply / --read-back ────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== TARGET) usage(`manifest was built on ${m.database}; refusing to use it on ${TARGET}`);
  for (const i of m.items) {
    if (!UUID_RE.test(i.proposal_id)) usage(`bad proposal_id ${i.proposal_id}`);
    if (!STATUS_RE.test(i.current_status) || i.new_status !== NEW_STATUS) usage(`bad status in ${i.proposal_id}`);
  }
  return m;
}

/** id → {status, rank} for every manifest id, in one read. */
function liveStatuses(m) {
  const rows = readJson(`
SELECT json_object_agg(p.id, json_build_object('status', p.status, 'rank', public.proposal_status_rank(p.status),
                                                'updated_at', p.updated_at))
  FROM public.proposals p
 WHERE p.id = ANY (ARRAY[${m.items.map((i) => lit(i.proposal_id)).join(", ")}]::uuid[]);`);
  return rows ?? {};
}

function dryRun() {
  const m = loadManifest();
  console.log(`[fix1257] ${TARGET_LABEL} — READ ONLY dry run of ${relative(ROOT, MANIFEST)} (${m.items.length} item(s))`);
  const live = liveStatuses(m);
  let plan = 0;
  const skips = [];
  for (const i of m.items) {
    const l = live[i.proposal_id];
    const label = `${i.bill_key.external_id ?? i.bill_key.bill_number} ${i.proposal_id}`;
    if (!l) {
      skips.push(`${label}: gone`);
    } else if (l.status !== i.current_status || l.rank >= 50) {
      skips.push(`${label}: live '${l.status}' (manifest '${i.current_status}')`);
    } else {
      plan += 1;
      console.log(`[fix1257]   ${label}: precondition status = '${i.current_status}' (rank ${l.rank} < 50) holds — plan ${i.current_status} → ${NEW_STATUS} (roll ${i.roll_call_id} ${i.vote_question} ${i.vote_result})`);
    }
  }
  for (const s of skips) console.log(`[fix1257]   SKIP ${s}`);
  console.log(`[fix1257] dry run: ${plan} to advance, ${skips.length} skip (the RPC re-checks every row at apply)`);
}

function apply() {
  const m = loadManifest();
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (TARGET === "prod" && claimant === null) {
    usage("--prod --apply runs only under a FIX-950 claim — run it as session:wait-for-gate:prod --then");
  }
  if (claimant !== null && /[\r\n\0]/.test(claimant)) usage("CIVITICS_PROD_SESSION_CLAIMANT must be one line");
  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\nSET application_name = 'fix1257-backfill-passed-status';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  const ids = m.items.map((i) => lit(i.proposal_id)).join(", ");
  const statuses = m.items.map(() => lit(NEW_STATUS)).join(", ");
  console.log(`[fix1257] ${TARGET_LABEL} — WRITE: ${m.items.length} item(s) from ${relative(ROOT, MANIFEST)}${claimant ? `; claimant ${claimant}` : ""}; start ${new Date().toISOString()}`);
  const res = psql(
    pre +
      `SELECT json_build_object('moved', COALESCE(json_agg(json_build_object('id', t.id, 'from', t.from_status, 'to', t.to_status) ORDER BY t.id), '[]'::json),
                               'at', clock_timestamp())
         FROM public.proposals_advance_status(ARRAY[${ids}]::uuid[], ARRAY[${statuses}]::public.proposal_status[]) t;`,
  );
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[fix1257] psql exit ${res.status} — the statement rolled back; nothing was written`);
    process.exit(1);
  }
  const out = lastJsonLine(res.stdout);
  const moved = out.moved ?? [];
  const movedIds = new Set(moved.map((x) => x.id));
  const byId = new Map(m.items.map((i) => [i.proposal_id, i]));
  for (const x of moved) {
    const i = byId.get(x.id);
    console.log(`[fix1257]   MOVED ${i?.bill_key.external_id ?? "?"} ${x.id} ${x.from} → ${x.to}`);
  }
  const held = m.items.filter((i) => !movedIds.has(i.proposal_id));
  if (held.length > 0) {
    const live = liveStatuses({ items: held });
    for (const i of held) {
      console.log(`[fix1257]   HELD ${i.bill_key.external_id ?? "?"} ${i.proposal_id}: live '${live[i.proposal_id]?.status ?? "gone"}' — the rule refused`);
    }
  }
  console.log(`[fix1257] moved ${moved.length}, held ${held.length} of ${m.items.length}; statement at ${out.at}; end ${new Date().toISOString()}`);
}

function readBack() {
  const m = loadManifest();
  const live = liveStatuses(m);
  const counts = {};
  const below = [];
  for (const i of m.items) {
    const l = live[i.proposal_id];
    const s = l?.status ?? "gone";
    counts[s] = (counts[s] ?? 0) + 1;
    if (!l || l.rank < 50) below.push(`${i.bill_key.external_id ?? i.bill_key.bill_number} ${i.proposal_id} '${s}'`);
  }
  console.log(`[fix1257] ${TARGET_LABEL} — READ ONLY read-back of ${m.items.length} manifest id(s) at ${new Date().toISOString()}: ${JSON.stringify(counts)}`);
  for (const b of below) console.log(`[fix1257]   BELOW passed_chamber: ${b}`);
  process.exit(below.length > 0 ? 1 : 0);
}

({ "--build-manifest": buildManifest, "--dry-run": dryRun, "--apply": apply, "--read-back": readBack })[MODE]();
