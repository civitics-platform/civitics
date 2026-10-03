#!/usr/bin/env node
// fix1260-backfill-senate-results.mjs — FIX-1260 (cc-185). The Senate results
// the vote writer never stored, re-read from senate.gov, and the bills they
// prove passed the Senate.
//
// THE DEFECT: votes.ts read root["result"], an element the LIS XML does not
// carry (it has <vote_result>, <vote_result_text>, <vote_question_text>,
// <vote_title> — cc-185 read 2, senate-119-2-00256). Every stored Senate roll
// has metadata.vote_result = '' (prod 2026-10-03 23:00 UTC: 1,893 rolls /
// 163,251 vote rows). The nightly's skip-check keys on roll_call_id, so a
// stored roll is never re-fetched: this script is the only path back to the
// results.
//
// THE MANIFEST (rule 42): items[] = one per stored Senate roll, the four LIS
// elements as fetched; advances[] = the federal bills a PASSED Senate passage
// roll (bill-status-evidence.mjs: question in passage-questions.json, result
// class 'passed') proves passed the Senate, whose live status ranks below
// passed_chamber at build time.
//
// THE WRITE: ONE statement — SELECT … FROM public.proposals_advance_status(
// advances ids, 'passed_chamber') — upward only; the RPC re-checks the rule on
// each locked row. That is all --apply sends.
//
// NOT WRITTEN — the votes.metadata backfill (cc-185 stopped it). The prompt
// sized it as "UPDATE roll_calls … 1,893 rows by PK — seconds". There is no
// roll_calls table: the result lives on every member's votes row, so the
// backfill is 163,251 UPDATEs on a 1 GB, 14-index table whose BEFORE UPDATE
// trigger stamps updated_at — the watermark the EC votes arm (FIX-1139) and the
// fix1178a rate signature read. That is a bulk rewrite with a vacuum tail and a
// derived-work tail, to store a value no reader reads (only this writer touches
// metadata.vote_result). items[] keeps the results as the evidence of record;
// the backfill is a separate decision, filed.
//
// MODES (exactly one; target --local or --prod, always explicit):
//   --build-manifest [--out P] [--pace-ms 500] [--cache DIR]
//                       READ ONLY: list the stored Senate rolls, fetch each
//                       roll's XML from senate.gov (cached, resumable, ≥ pace
//                       apart, stops on 5 consecutive 429/403), write the manifest
//   --dry-run           READ ONLY: per advance, the precondition and the plan
//   --apply             the RPC statement. On --prod only under a FIX-950 claim
//   --read-back         READ ONLY: every advance at or above passed_chamber
// --manifest P (default docs/audits/2026-10-04-fix1260-senate-results.json).
//
// USAGE (prod reads the password from the PRIMARY checkout's .env.local.prod):
//   node scripts/fix1260-backfill-senate-results.mjs --prod --build-manifest --env-file ../../App/.env.local.prod
//   node scripts/fix1260-backfill-senate-results.mjs --prod --dry-run --env-file …
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 2 --census off \
//     --reason "cc-185 FIX-1260 Senate passage advances (<N>)" \
//     --then "node ../../scripts/fix1260-backfill-senate-results.mjs --prod --apply --manifest <abs>"
//   node scripts/fix1260-backfill-senate-results.mjs --prod --read-back --env-file …

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  ROOT, UUID_RE, SENATE_PASSAGE_QUESTIONS,
  isPassageQuestion, voteResultClass, connectionUrl, readJson, parseArgs,
  SENATE_ROLLS_SQL, FEDERAL_BILLS_SQL, PROPOSALS_TUPLES_SQL,
  advanceDryRun, advanceApply, advanceReadBack,
} from "./lib/bill-status-evidence.mjs";

const TAG = "fix1260";
const NEW_STATUS = "passed_chamber";
const args = parseArgs(process.argv.slice(2), {
  modes: ["--build-manifest", "--dry-run", "--apply", "--read-back"],
  defaultManifest: join(ROOT, "docs", "audits", "2026-10-04-fix1260-senate-results.json"),
  tag: TAG,
});
const MANIFEST = resolve(args.manifest);
const OUT = resolve(args.out);
const url = connectionUrl(args.target, resolve(args.envFile), TAG);
const PACE_MS = Number(args.val("--pace-ms", "500"));
const CACHE = resolve(args.val("--cache", join(ROOT, "scratchpad", "fix1260-lis-cache")));
const STREAK_STOP = 5;
const LIS_ELEMENTS = ["vote_result", "vote_result_text", "vote_question_text", "vote_title", "question", "result"];

/** senate-119-2-00256 → the URL votes.ts builds (votes.ts:786-788). */
function lisUrl(rollCallId) {
  const m = /^senate-(\d+)-(\d)-(\d{5})$/.exec(rollCallId);
  if (!m) return null;
  const [, c, s, n] = m;
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${c}${s}/vote_${c}_${s}_${n}.xml`;
}

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** A top-level element of <roll_call_vote>: its text, '' when self-closed, null when absent. */
function element(xml, name) {
  const head = xml.slice(0, xml.indexOf("<members>") === -1 ? xml.length : xml.indexOf("<members>"));
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>|<${name}\\s*/>`).exec(head);
  if (!m) return null;
  return decode((m[1] ?? "").trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── --build-manifest ─────────────────────────────────────────────────────────
async function buildManifest() {
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY: listing stored Senate rolls`);
  const rolls = readJson(url, SENATE_ROLLS_SQL() + ";", TAG) ?? [];
  console.log(`[${TAG}] ${rolls.length} stored Senate roll(s); cache ${relative(ROOT, CACHE)}`);
  mkdirSync(CACHE, { recursive: true });

  let fetched = 0, cached = 0, streak = 0, stoppedAt = null;
  const failures = [];
  const t0 = Date.now();
  let lastStart = 0;
  for (const r of rolls) {
    const file = join(CACHE, `${r.roll_call_id}.xml`);
    if (existsSync(file)) { cached += 1; continue; }
    if (stoppedAt) continue;
    const u = lisUrl(r.roll_call_id);
    if (!u) { failures.push({ roll_call_id: r.roll_call_id, error: "unparseable roll_call_id" }); continue; }
    if (r.source_url && r.source_url !== u) {
      console.warn(`[${TAG}]   ${r.roll_call_id}: stored source_url ${r.source_url} ≠ built ${u} — fetching the built one`);
    }
    const wait = lastStart + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    try {
      const res = await fetch(u);
      if (res.status === 429 || res.status === 403) {
        streak += 1;
        failures.push({ roll_call_id: r.roll_call_id, error: `HTTP ${res.status}` });
        console.warn(`[${TAG}]   ${r.roll_call_id}: HTTP ${res.status} (streak ${streak})`);
        if (streak >= STREAK_STOP) {
          stoppedAt = r.roll_call_id;
          console.error(`[${TAG}] STOP: ${STREAK_STOP} consecutive 429/403 — keeping the cache, building from what landed`);
        }
        continue;
      }
      streak = 0;
      if (!res.ok) {
        failures.push({ roll_call_id: r.roll_call_id, error: `HTTP ${res.status}` });
        console.warn(`[${TAG}]   ${r.roll_call_id}: HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (!text.includes("<roll_call_vote>")) {
        failures.push({ roll_call_id: r.roll_call_id, error: "no <roll_call_vote> root" });
        continue;
      }
      writeFileSync(file, text);
      fetched += 1;
      if (fetched % 100 === 0) {
        console.log(`[${TAG}]   fetched ${fetched} (cached ${cached}) — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    } catch (e) {
      failures.push({ roll_call_id: r.roll_call_id, error: e instanceof Error ? e.message : String(e) });
      console.warn(`[${TAG}]   ${r.roll_call_id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const wallS = Math.round((Date.now() - t0) / 1000);
  console.log(`[${TAG}] fetch: ${fetched} fetched, ${cached} from cache, ${failures.length} failed, ${wallS} s${stoppedAt ? `; STOPPED at ${stoppedAt}` : ""}`);

  // Parse every cached roll.
  const items = [];
  const elementsPresent = Object.fromEntries(LIS_ELEMENTS.map((e) => [e, 0]));
  const vocab = new Map();
  for (const r of rolls) {
    const file = join(CACHE, `${r.roll_call_id}.xml`);
    if (!existsSync(file)) continue;
    const xml = readFileSync(file, "utf8");
    const got = Object.fromEntries(LIS_ELEMENTS.map((e) => [e, element(xml, e)]));
    for (const e of LIS_ELEMENTS) if (got[e] !== null) elementsPresent[e] += 1;
    const question = got.question ?? "";
    const result = got.vote_result ?? "";
    const cls = voteResultClass(result);
    const passage = isPassageQuestion(question);
    const key = result;
    const v = vocab.get(key) ?? { vote_result: result, class: cls, rolls: 0, on_passage_questions: 0 };
    v.rolls += 1;
    if (passage) v.on_passage_questions += 1;
    vocab.set(key, v);
    items.push({
      roll_call_id: r.roll_call_id,
      vote_question: question,
      stored_question: r.stored_question,
      vote_result: result,
      vote_result_text: got.vote_result_text ?? "",
      vote_question_text: got.vote_question_text ?? "",
      vote_title: got.vote_title ?? "",
      result_class: cls,
      passage_question: passage,
      bill_proposal_id: r.bill_proposal_id,
      fetched_at: statSync(file).mtime.toISOString(),
    });
  }

  // advances[]: the bills a passed Senate passage roll proves, live rank < 50.
  const evidence = new Map();
  for (const i of items) {
    if (!i.passage_question || i.result_class !== "passed" || !i.bill_proposal_id) continue;
    if (!evidence.has(i.bill_proposal_id)) evidence.set(i.bill_proposal_id, i);
  }
  const ids = [...evidence.keys()];
  const live = ids.length === 0 ? [] : readJson(url, FEDERAL_BILLS_SQL(ids) + ";", TAG) ?? [];
  const advances = [];
  const atOrAbove = {};
  for (const l of live) {
    if (l.rank >= 50) { atOrAbove[l.status] = (atOrAbove[l.status] ?? 0) + 1; continue; }
    const e = evidence.get(l.id);
    advances.push({
      proposal_id: l.id, bill_number: l.bill_number, session: l.session, origin_chamber: l.chamber,
      current_status: l.status, latest_action: l.latest_action,
      roll_call_id: e.roll_call_id, vote_question: e.vote_question, vote_result: e.vote_result,
      vote_result_text: e.vote_result_text, new_status: NEW_STATUS,
    });
  }

  const manifest = {
    database: args.target,
    fix: "FIX-1260",
    prompt: "cc-185",
    built_at: new Date().toISOString(),
    population: {
      rule: "items: every stored Senate roll (votes.chamber='Senate', DISTINCT roll_call_id), its LIS XML re-fetched; advances: federal non-PN bills with a Senate roll whose question is a passage question (passage-questions.json) and whose vote_result classes 'passed' (members.ts mapVoteResult suffix rule), live rank < passed_chamber",
      senate_passage_questions: SENATE_PASSAGE_QUESTIONS,
      fetch: { stored_rolls: rolls.length, fetched_this_run: fetched, from_cache: cached, failed: failures.length, wall_s: wallS, pace_ms: PACE_MS, stopped_at: stoppedAt, failures },
      lis_elements_present: elementsPresent,
      vote_result_vocabulary: [...vocab.values()].sort((a, b) => b.rolls - a.rolls),
      counts: {
        items: items.length,
        passed_passage_rolls: items.filter((i) => i.passage_question && i.result_class === "passed").length,
        bills_with_passed_senate_passage_roll: ids.length,
        advances: advances.length,
        already_at_or_above_passed_chamber: atOrAbove,
      },
      votes_metadata_backfill: "NOT WRITTEN — 163,251 votes rows, not 1,893 roll_calls rows (no such table); stopped by cc-185, filed",
    },
    advances,
    items,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[${TAG}] elements present: ${JSON.stringify(elementsPresent)}`);
  for (const v of manifest.population.vote_result_vocabulary) {
    console.log(`[${TAG}]   ${JSON.stringify(v.vote_result).padEnd(44)} ${v.class.padEnd(6)} ${String(v.rolls).padStart(5)} roll(s), ${v.on_passage_questions} on a passage question`);
  }
  console.log(`[${TAG}] ${JSON.stringify(manifest.population.counts)}`);
  console.log(`[${TAG}] wrote ${relative(ROOT, OUT)} (${items.length} item(s), ${advances.length} advance(s))`);
}

// ── --dry-run / --apply / --read-back ────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) args.usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== args.target) args.usage(`manifest was built on ${m.database}; refusing to use it on ${args.target}`);
  for (const a of m.advances) {
    if (!UUID_RE.test(a.proposal_id)) args.usage(`bad proposal_id ${a.proposal_id}`);
    if (a.new_status !== NEW_STATUS) args.usage(`bad new_status in ${a.proposal_id}`);
  }
  return m;
}

function emptySenateResults() {
  return readJson(url, `SELECT json_build_object('rolls', count(DISTINCT roll_call_id), 'rows', count(*)) FROM public.votes
                         WHERE chamber = 'Senate' AND coalesce(metadata->>'vote_result', '') = '';`, TAG);
}

function dryRun() {
  const m = loadManifest();
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY dry run of ${relative(ROOT, MANIFEST)} (${m.advances.length} advance(s))`);
  advanceDryRun({ url, tag: TAG, items: m.advances });
  console.log(`[${TAG}] proposals tuples: ${JSON.stringify(readJson(url, PROPOSALS_TUPLES_SQL() + ";", TAG))}`);
  console.log(`[${TAG}] Senate rolls storing vote_result '' (informational; the votes backfill is not this script's): ${JSON.stringify(emptySenateResults())}`);
}

function apply() {
  const m = loadManifest();
  advanceApply({
    url, tag: TAG, target: args.target, appName: "fix1260-backfill-senate-results",
    items: m.advances, manifestLabel: relative(ROOT, MANIFEST),
  });
}

function readBack() {
  const m = loadManifest();
  const below = advanceReadBack({ url, tag: TAG, items: m.advances });
  console.log(`[${TAG}] proposals tuples: ${JSON.stringify(readJson(url, PROPOSALS_TUPLES_SQL() + ";", TAG))}`);
  console.log(`[${TAG}] Senate rolls storing vote_result '': ${JSON.stringify(emptySenateResults())} (the votes backfill was not run — filed)`);
  process.exit(below > 0 ? 1 : 0);
}

await ({ "--build-manifest": buildManifest, "--dry-run": dryRun, "--apply": apply, "--read-back": readBack })[args.mode]();
