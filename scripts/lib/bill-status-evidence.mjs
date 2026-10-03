// bill-status-evidence.mjs — what the cc-185 manifest scripts (FIX-1260/1261/
// 1262) count as evidence of a federal measure's stage, and the psql plumbing
// they share. No side effects at import: bill-status.test.ts imports this to
// prove it agrees with the nightly's TypeScript (mapVoteResult,
// isPassageQuestion) and PREPAREs the scripts' SQL against the clone (rule 158).

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FEDERAL_JURISDICTION = "eb075dd5-038f-4b21-82f7-30f5c9e1d49a";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── the evidence rules (twins of packages/data/src/pipelines/congress) ───────

const PQ = JSON.parse(
  readFileSync(join(ROOT, "packages", "data", "src", "pipelines", "congress", "passage-questions.json"), "utf8"),
);
/** Lowercased, whitespace-collapsed — the form isPassageQuestion() compares. */
export const HOUSE_PASSAGE_QUESTIONS = Object.freeze([...PQ.house]);
export const SENATE_PASSAGE_QUESTIONS = Object.freeze([...PQ.senate]);
export const PASSAGE_QUESTIONS = Object.freeze([...new Set([...PQ.house, ...PQ.senate])]);

export const normQuestion = (q) => String(q ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const isPassageQuestion = (q) => PASSAGE_QUESTIONS.includes(normQuestion(q));

/** members.ts mapVoteResult(), by class: 'passed' | 'failed' | 'other'. Failed is tested FIRST ("Not Agreed to"). */
export const FAILED_SUFFIX = /(rejected|failed|defeated|not agreed to|not sustained|not well taken)$/;
export const PASSED_SUFFIX = /(^|\s)(passed|agreed to|confirmed|sustained)$/;
export function voteResultClass(result) {
  const r = String(result ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (FAILED_SUFFIX.test(r)) return "failed";
  if (PASSED_SUFFIX.test(r)) return "passed";
  return "other";
}

/** status-rank.ts PROPOSAL_STATUS_RANK (bill-status-scripts.test.ts holds them equal). */
export const STATUS_RANK = Object.freeze({
  introduced: 10, in_committee: 20, passed_committee: 30, floor_vote: 40, passed_chamber: 50,
  passed_both_chambers: 60, vetoed: 65, signed: 70, veto_overridden: 75, enacted: 80,
  failed: 90, withdrawn: 90, tabled: 90, open_comment: 20, comment_closed: 30, final_rule: 80,
});
export const rankOf = (s) => (s == null ? -1 : STATUS_RANK[s] ?? -1);
/** The highest-ranked of a list of statuses (nulls ignored). */
export const highest = (statuses) =>
  statuses.filter((s) => s != null).reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a), null);

/**
 * bill-status.ts mapBillStatus(), including FIX-1262's origin-chamber arms
 * (bill-status-scripts.test.ts runs both over one table). Without a chamber it
 * is the pre-FIX-1262 function.
 */
export function mapBillStatus(latestActionText, originChamber) {
  if (!latestActionText || !String(latestActionText).trim()) return "introduced";
  const t = String(latestActionText).toLowerCase();
  const s = t.trim();
  if (t.includes("became public law") || t.includes("signed by president")) return "enacted";
  if (t.includes("signed") && t.includes("president")) return "signed";
  if (t.includes("vetoed")) return "vetoed";
  if (t.includes("passed") && (t.includes("senate") || t.includes("house"))) {
    if (t.includes("both") || (t.includes("senate") && t.includes("house"))) return "passed_both_chambers";
    return "passed_chamber";
  }
  if (t.includes("reported") || t.includes("ordered to be reported")) return "passed_committee";
  if (originChamberProvesPassage(s, originChamber)) return "passed_chamber";
  if (t.includes("referred to")) return "in_committee";
  if (/^introduced in (the )?(house|senate)\b/.test(s)) return "introduced";
  return null;
}

/** FIX-1262's arms: the text proves the ORIGIN chamber passed the measure. */
export function originChamberProvesPassage(s, originChamber) {
  if (originChamber === "house" && /^received in the senate\b/.test(s)) return true;
  if (originChamber === "senate" && /^held at the desk\b/.test(s)) return true;
  if ((originChamber === "house" || originChamber === "senate") && /^message on senate action sent to the house\b/.test(s)) return true;
  return false;
}

/** SQL twin of isPassageQuestion() on a column. */
export const sqlIsPassage = (col) =>
  `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g')) = ANY (ARRAY[${PASSAGE_QUESTIONS.map(lit).join(", ")}])`;
/** SQL twin of voteResultClass(...) = 'passed' on a column. */
export const sqlResultPassed = (col) => {
  const r = `lower(regexp_replace(btrim(coalesce(${col}, '')), '\\s+', ' ', 'g'))`;
  return `(${r} !~ '${FAILED_SUFFIX.source}' AND ${r} ~ '${PASSED_SUFFIX.source}')`;
};

// ── psql plumbing (the fix1257 family's shape) ──────────────────────────────

const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
export const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function lit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
export const litList = (xs) => xs.map(lit).join(", ");
export const uuidArray = (ids) => `ARRAY[${ids.map(lit).join(", ")}]::uuid[]`;
export const textArray = (xs) => `ARRAY[${xs.map(lit).join(", ")}]::text[]`;

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

/** The connection for a target. A worktree's .env.local.prod is a stub — pass --env-file to the primary's. */
export function connectionUrl(target, envFile, tag) {
  if (target === "local") return LOCAL_URL;
  const password = readEnvVar(envFile, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[${tag}] SUPABASE_DB_PASSWORD not found in ${envFile}`);
    console.error(`[${tag}] a worktree's .env.local.prod is a stub — run from the primary checkout or pass --env-file`);
    process.exit(2);
  }
  const base = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  const u = base.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === base) {
    console.error(`[${tag}] could not inject the password into the pooler URL`);
    process.exit(2);
  }
  return u;
}

/** Run SQL through psql (ON_ERROR_STOP); a read is one READ ONLY transaction. */
export function psql(url, sql, { readOnly = false, tag = "psql" } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  if (readOnly) args.push("--single-transaction");
  const res = spawnSync("psql", args, {
    input: (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sql,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[${tag}] failed to launch psql: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

/** The single JSON value a query printed — json_agg output spans lines, so parse from its first line to the end. */
export function lastJson(stdout) {
  const s = stdout.trim();
  const i = s.search(/^\s*[[{]/m);
  return JSON.parse(i === -1 ? "null" : s.slice(i));
}

export function readJson(url, sql, tag) {
  const res = psql(url, sql, { readOnly: true, tag });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[${tag}] read failed (psql exit ${res.status})`);
    process.exit(1);
  }
  return lastJson(res.stdout);
}

/** The FIX-950 claim preamble every --prod --apply runs under (session:wait-for-gate --then sets it). */
export function claimPreamble(target, appName, tag, timeout = "60s") {
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (target === "prod" && claimant === null) {
    console.error(`[${tag}] --prod --apply runs only under a FIX-950 claim — run it as session:wait-for-gate:prod --then`);
    process.exit(64);
  }
  if (claimant !== null && /[\r\n\0]/.test(claimant)) {
    console.error(`[${tag}] CIVITICS_PROD_SESSION_CLAIMANT must be one line`);
    process.exit(64);
  }
  let pre = `SET statement_timeout = '${timeout}';\nSET application_name = '${appName}';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  return { pre, claimant };
}

/** Common argv: exactly one mode, exactly one of --local | --prod, --manifest/--out/--env-file. */
export function parseArgs(argv, { modes, defaultManifest, tag }) {
  const has = (f) => argv.includes(f);
  const val = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const usage = (msg) => {
    console.error(`[${tag}] ${msg}`);
    console.error(`[${tag}] see the header of scripts/${tag}-*.mjs`);
    process.exit(64);
  };
  const picked = modes.filter(has);
  if (picked.length !== 1) usage(`pass exactly one of ${modes.join(" | ")}`);
  if (has("--local") === has("--prod")) usage("pass exactly one of --local | --prod");
  const target = has("--prod") ? "prod" : "local";
  const manifest = val("--manifest", defaultManifest);
  return {
    mode: picked[0],
    target,
    targetLabel: target === "prod" ? "PROD (Supabase Pro)" : "LOCAL (127.0.0.1:54322)",
    manifest,
    out: val("--out", manifest),
    envFile: val("--env-file", join(ROOT, ".env.local.prod")),
    has,
    val,
    usage,
  };
}

// ── the scripts' SQL (each PREPAREd against the clone by bill-status-scripts.test.ts, rule 158) ──

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const idsOrNil = (ids) => (ids.length ? ids : [NIL_UUID]);

/** id → {status, rank} for a set of proposal ids, in one read. */
export const LIVE_STATUS_SQL = (ids) => `
SELECT json_object_agg(p.id, json_build_object('status', p.status, 'rank', public.proposal_status_rank(p.status)))
  FROM public.proposals p
 WHERE p.id = ANY (${uuidArray(idsOrNil(ids))})`;

/** FIX-1260: one row per stored Senate roll (DISTINCT ON roll_call_id). */
export const SENATE_ROLLS_SQL = () => `
SELECT json_agg(x ORDER BY x.roll_call_id) FROM (
  SELECT DISTINCT ON (v.roll_call_id) v.roll_call_id, v.vote_question AS stored_question, v.source_url,
         v.bill_proposal_id, v.metadata->>'vote_result' AS stored_result
    FROM public.votes v
   WHERE v.chamber = 'Senate'
   ORDER BY v.roll_call_id
) x`;

/** Federal non-PN bills among `ids`, with their live status, rank, origin chamber and latest action. */
export const FEDERAL_BILLS_SQL = (ids) => `
SELECT json_agg(json_build_object('id', p.id, 'status', p.status, 'rank', public.proposal_status_rank(p.status),
                                  'bill_number', bd.bill_number, 'session', bd.session, 'chamber', bd.chamber,
                                  'latest_action', p.metadata->>'latest_action') ORDER BY bd.session, bd.bill_number)
  FROM public.proposals p
  JOIN public.bill_details bd ON bd.proposal_id = p.id
 WHERE p.id = ANY (${uuidArray(idsOrNil(ids))})
   AND p.jurisdiction_id = '${FEDERAL_JURISDICTION}'
   AND split_part(bd.bill_number, ' ', 1) <> 'PN'`;

/** The upward-only write (FIX-1257's RPC): every id asks for `status`. */
export const ADVANCE_APPLY_SQL = (ids, status) => `
SELECT json_build_object('moved', COALESCE(json_agg(json_build_object('id', t.id, 'from', t.from_status, 'to', t.to_status) ORDER BY t.id), '[]'::json),
                         'at', clock_timestamp())
  FROM public.proposals_advance_status(${uuidArray(idsOrNil(ids))}, array_fill(${lit(status)}::public.proposal_status, ARRAY[${Math.max(ids.length, 1)}])) t`;

/**
 * FIX-1261: every federal measure (bill_details row, not PN) at `failed` or
 * `passed_chamber`, with every roll it has — question, result, chamber, date —
 * and its latest action. The script classifies; SQL only gathers.
 */
export const MINT_ARTIFACT_CANDIDATES_SQL = () => `
SELECT json_agg(c ORDER BY c.status, c.session, c.bill_number) FROM (
  SELECT p.id, p.status, p.metadata->>'latest_action' AS latest_action, p.created_at,
         bd.bill_number, bd.session, bd.chamber,
         (SELECT json_agg(json_build_object('roll', r.roll_call_id, 'chamber', r.chamber, 'question', r.vote_question,
                                            'result', r.vote_result, 'voted_at', r.voted_at) ORDER BY r.voted_at, r.roll_call_id)
            FROM (SELECT DISTINCT ON (v.roll_call_id) v.roll_call_id, v.chamber, v.vote_question,
                         v.metadata->>'vote_result' AS vote_result, v.voted_at
                    FROM public.votes v WHERE v.bill_proposal_id = p.id
                   ORDER BY v.roll_call_id) r) AS rolls
    FROM public.proposals p
    JOIN public.bill_details bd ON bd.proposal_id = p.id
   WHERE p.jurisdiction_id = '${FEDERAL_JURISDICTION}'
     AND split_part(bd.bill_number, ' ', 1) <> 'PN'
     AND p.status IN ('failed', 'passed_chamber', 'enacted')
) c`;

/**
 * FIX-1261's repair — a DIRECT update that bypasses proposals_advance_status()
 * by design (D3): it moves rows OFF `failed` and LOWERS passed_chamber →
 * floor_vote, the two moves the rank rule must never learn to allow. One
 * statement: UPDATE locks each row and re-evaluates `status = current` on the
 * latest version (READ COMMITTED), so a row that moved since the manifest was
 * built is skipped, not overwritten.
 */
export const DIRECT_REPAIR_SQL = (items) => `
WITH m(id, cur, nxt) AS (
  SELECT * FROM unnest(${uuidArray(idsOrNil(items.map((i) => i.proposal_id)))},
                       ${textArray(items.length ? items.map((i) => i.current_status) : ["-"])},
                       ${textArray(items.length ? items.map((i) => i.new_status) : ["-"])})
),
upd AS (
  UPDATE public.proposals p
     SET status = m.nxt::public.proposal_status
    FROM m
   WHERE p.id = m.id
     AND p.status::text = m.cur
  RETURNING p.id, m.cur AS from_status, m.nxt AS to_status
)
SELECT json_build_object('moved', COALESCE((SELECT json_agg(json_build_object('id', id, 'from', from_status, 'to', to_status) ORDER BY id) FROM upd), '[]'::json),
                         'at', clock_timestamp())`;

/**
 * FIX-1262: federal measures below passed_chamber whose latest action is one
 * of the origin-chamber-passage texts. The script applies mapBillStatus(text,
 * origin) to decide; SQL only narrows.
 */
export const VOICE_VOTE_CANDIDATES_SQL = () => `
SELECT json_agg(c ORDER BY c.session, c.bill_number) FROM (
  SELECT p.id, p.status, public.proposal_status_rank(p.status) AS rank, p.metadata->>'latest_action' AS latest_action,
         bd.bill_number, bd.session, bd.chamber, split_part(bd.bill_number, ' ', 1) AS bill_type
    FROM public.proposals p
    JOIN public.bill_details bd ON bd.proposal_id = p.id
   WHERE p.jurisdiction_id = '${FEDERAL_JURISDICTION}'
     AND split_part(bd.bill_number, ' ', 1) IN ('HR', 'HJRES', 'HCONRES', 'S', 'SJRES', 'SCONRES')
     AND public.proposal_status_rank(p.status) < public.proposal_status_rank('passed_chamber')
     AND lower(btrim(p.metadata->>'latest_action')) ~ '^(received in the senate|held at the desk|message on senate action sent to the house)'
) c`;

// ── the upward-only advance, shared by fix1260 (advances[]) and fix1262 (items[]) ──
// items: [{proposal_id, session, bill_number, current_status, new_status}]

const labelOf = (i) => `${i.session}-${i.bill_number} ${i.proposal_id}`;

export function advanceDryRun({ url, tag, items }) {
  const live = readJson(url, LIVE_STATUS_SQL(items.map((i) => i.proposal_id)) + ";", tag) ?? {};
  let plan = 0;
  const skips = [];
  for (const i of items) {
    const l = live[i.proposal_id];
    if (!l) skips.push(`${labelOf(i)}: gone`);
    else if (l.status !== i.current_status || l.rank >= rankOf(i.new_status)) skips.push(`${labelOf(i)}: live '${l.status}' (manifest '${i.current_status}')`);
    else {
      plan += 1;
      console.log(`[${tag}]   ${labelOf(i)}: '${i.current_status}' (rank ${l.rank}) → ${i.new_status}`);
    }
  }
  for (const s of skips) console.log(`[${tag}]   SKIP ${s}`);
  const pct = items.length ? (100 * skips.length) / items.length : 0;
  console.log(`[${tag}] dry run: ${plan} to advance, ${skips.length} skip (${pct.toFixed(1)}%; the RPC re-checks every row at apply)`);
  if (pct > 5) console.log(`[${tag}] ⚠ STOP: skips exceed 5% of the manifest — the population moved; rebuild it`);
  return { plan, skips: skips.length };
}

export function advanceApply({ url, tag, target, appName, items, manifestLabel }) {
  const { pre, claimant } = claimPreamble(target, appName, tag);
  const statuses = [...new Set(items.map((i) => i.new_status))];
  if (statuses.length > 1) throw new Error(`[${tag}] one new_status per apply, got ${statuses.join(", ")}`);
  console.log(`[${tag}] ${target === "prod" ? "PROD" : "LOCAL"} — WRITE: ${items.length} item(s) from ${manifestLabel}${claimant ? `; claimant ${claimant}` : ""}; start ${new Date().toISOString()}`);
  if (items.length === 0) { console.log(`[${tag}] nothing to send`); return; }
  const res = psql(url, pre + ADVANCE_APPLY_SQL(items.map((i) => i.proposal_id), statuses[0]) + ";", { tag });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[${tag}] psql exit ${res.status} — the statement rolled back; nothing was written`);
    process.exit(1);
  }
  const out = lastJson(res.stdout);
  const moved = out.moved ?? [];
  const movedIds = new Set(moved.map((x) => x.id));
  const byId = new Map(items.map((i) => [i.proposal_id, i]));
  const tally = {};
  for (const x of moved) {
    const k = `${x.from}→${x.to}`;
    tally[k] = (tally[k] ?? 0) + 1;
    console.log(`[${tag}]   MOVED ${byId.get(x.id)?.bill_number ?? "?"} ${x.id} ${x.from} → ${x.to}`);
  }
  const held = items.filter((i) => !movedIds.has(i.proposal_id));
  const live = held.length ? readJson(url, LIVE_STATUS_SQL(held.map((i) => i.proposal_id)) + ";", tag) ?? {} : {};
  for (const i of held) console.log(`[${tag}]   HELD ${labelOf(i)}: live '${live[i.proposal_id]?.status ?? "gone"}'`);
  console.log(`[${tag}] moved ${moved.length} ${JSON.stringify(tally)}, held ${held.length} of ${items.length}; statement at ${out.at}; end ${new Date().toISOString()}`);
}

/** Exit 0 when every item is at or above its new_status. */
export function advanceReadBack({ url, tag, items }) {
  const live = readJson(url, LIVE_STATUS_SQL(items.map((i) => i.proposal_id)) + ";", tag) ?? {};
  const counts = {};
  const below = [];
  for (const i of items) {
    const l = live[i.proposal_id];
    const s = l?.status ?? "gone";
    counts[s] = (counts[s] ?? 0) + 1;
    if (!l || l.rank < rankOf(i.new_status)) below.push(`${labelOf(i)} '${s}'`);
  }
  console.log(`[${tag}] READ ONLY read-back of ${items.length} item(s) at ${new Date().toISOString()}: ${JSON.stringify(counts)}`);
  for (const b of below) console.log(`[${tag}]   BELOW ${b}`);
  return below.length;
}

/** n_live/n_dead on proposals — the prompt's before/after for each write (not a bulk rewrite: no VACUUM). */
export const PROPOSALS_TUPLES_SQL = () => `
SELECT json_build_object('n_live_tup', n_live_tup, 'n_dead_tup', n_dead_tup, 'last_autovacuum', last_autovacuum, 'at', clock_timestamp())
  FROM pg_stat_user_tables WHERE relname = 'proposals' AND schemaname = 'public'`;

/** Origin chamber from the bill-number prefix (cc-185 read 5: bill_details.chamber agrees on every federal row). */
export const originChamberOf = (billNumber) => (/^h/i.test(String(billNumber ?? "").trim()) ? "house" : "senate");
