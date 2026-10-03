#!/usr/bin/env node
// fix1261-repair-vote-path-mints.mjs — FIX-1261 (cc-185). The statuses the vote
// path MINTED from a bill's first roll, whatever its question, repaired from
// the bill's rolls.
//
// THE ARTIFACTS (cc-181 §4; cc-185 read 3, prod 2026-10-03 23:07 UTC):
//   (i)  status = 'failed' — every federal one was minted from a failed FIRST
//        roll (On Motion to Recommit 91, an amendment 39, a failed suspension
//        19, …). A failed roll is a failed MOTION, not a failed bill; 139 of
//        the 174 later passed a passage roll. new_status = the HIGHEST of
//        floor_vote, passed_chamber (any passed passage roll), and
//        mapBillStatus(latest_action, origin) — so nothing is moved below what
//        its own evidence proves. A latest action that reads failed/withdrawn is
//        a real outcome: excluded and listed, never written.
//   (ii) status = 'passed_chamber' on a measure the vote path minted (it HAS
//        rolls) with NO passed passage roll under the extended list
//        (passage-questions.json) and no latest action proving ≥ passed_chamber
//        — the HRES "On Ordering the Previous Question" class. new_status =
//        floor_vote: the roll proves the floor, not passage.
//   (iii) the federal bills at `enacted` whose first roll was a failed motion —
//        rescued by the pre-FIX-1257 overwrite; correct, untouched, counted.
//
// EVIDENCE: House rolls from votes (vote_question + metadata.vote_result);
// Senate rolls from the FIX-1260 manifest's items[] (re-fetched LIS XML) —
// the Senate rows in votes still store vote_result '' (cc-185 stopped that
// backfill). Pass --senate-results to name the manifest.
//
// THE WRITE — deliberately NOT through proposals_advance_status() (D3, Craig's
// call): (i) moves OFF a terminal rank and (ii) LOWERS 50 → 40, the two moves
// the rank rule must never learn to allow. ONE statement (DIRECT_REPAIR_SQL):
// UPDATE … WHERE status = current_status, so a row that moved since the build is
// skipped and reported with its live value.
//
// MODES (exactly one; target --local or --prod):
//   --build-manifest [--out P] [--senate-results P]   READ ONLY
//   --dry-run        READ ONLY: per item, the precondition and the plan
//   --apply          the write; on --prod only under a FIX-950 claim
//   --read-back      READ ONLY: every item at its new_status
// --manifest P (default docs/audits/2026-10-04-fix1261-mint-artifacts.json).
//
// USAGE (prod reads the password from the PRIMARY checkout's .env.local.prod):
//   node scripts/fix1261-repair-vote-path-mints.mjs --prod --build-manifest --env-file …
//   node scripts/fix1261-repair-vote-path-mints.mjs --prod --dry-run --env-file …
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 2 --census off \
//     --reason "cc-185 FIX-1261 mint-artifact repair (<N>)" \
//     --then "node ../../scripts/fix1261-repair-vote-path-mints.mjs --prod --apply --manifest <abs>"
//   node scripts/fix1261-repair-vote-path-mints.mjs --prod --read-back --env-file …

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  ROOT, UUID_RE, PASSAGE_QUESTIONS, isPassageQuestion, voteResultClass, mapBillStatus, originChamberOf,
  highest, rankOf, connectionUrl, psql, lastJson, readJson, claimPreamble, parseArgs,
  LIVE_STATUS_SQL, MINT_ARTIFACT_CANDIDATES_SQL, DIRECT_REPAIR_SQL, PROPOSALS_TUPLES_SQL,
} from "./lib/bill-status-evidence.mjs";

const TAG = "fix1261";
const args = parseArgs(process.argv.slice(2), {
  modes: ["--build-manifest", "--dry-run", "--apply", "--read-back"],
  defaultManifest: join(ROOT, "docs", "audits", "2026-10-04-fix1261-mint-artifacts.json"),
  tag: TAG,
});
const MANIFEST = resolve(args.manifest);
const OUT = resolve(args.out);
const SENATE_RESULTS = resolve(args.val("--senate-results", join(ROOT, "docs", "audits", "2026-10-04-fix1260-senate-results.json")));
const url = connectionUrl(args.target, resolve(args.envFile), TAG);
const NEGATIVE_TEXT = /\b(failed|withdrawn)\b/i;

// ── --build-manifest ─────────────────────────────────────────────────────────
function buildManifest() {
  if (!existsSync(SENATE_RESULTS)) args.usage(`no FIX-1260 manifest at ${SENATE_RESULTS} — Senate evidence is required`);
  const sr = JSON.parse(readFileSync(SENATE_RESULTS, "utf8"));
  if (sr.database !== args.target) args.usage(`the FIX-1260 manifest was built on ${sr.database}, not ${args.target}`);
  const senate = new Map(sr.items.map((i) => [i.roll_call_id, i]));

  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY: gathering failed / passed_chamber / enacted federal measures and their rolls`);
  const candidates = readJson(url, MINT_ARTIFACT_CANDIDATES_SQL() + ";", TAG) ?? [];

  const items = [];
  const excluded = { negative_text: [], failed_without_rolls: [] };
  const untouchedEnacted = [];
  let correctPassed = 0, passedNoRolls = 0, passedByText = 0;
  for (const c of candidates) {
    const origin = originChamberOf(c.bill_number);
    // A Senate roll's result comes from the re-fetched LIS XML (FIX-1260).
    const rolls = (c.rolls ?? []).map((r) => {
      const s = r.chamber === "Senate" ? senate.get(r.roll) : null;
      const result = s ? s.vote_result : r.result ?? "";
      return { roll: r.roll, chamber: r.chamber, question: r.question, result, voted_at: r.voted_at, result_source: s ? "lis-manifest" : "votes" };
    });
    const passedPassage = rolls.filter((r) => isPassageQuestion(r.question) && voteResultClass(r.result) === "passed");
    const text = mapBillStatus(c.latest_action, origin);
    const first = rolls[0] ?? null;
    const base = {
      proposal_id: c.id, bill_number: c.bill_number, session: c.session, origin_chamber: origin,
      current_status: c.status, latest_action: c.latest_action, latest_action_maps_to: text,
      first_roll: first, passed_passage_rolls: passedPassage.map((r) => r.roll),
    };

    if (c.status === "enacted") {
      // Rescued = the pre-FIX-1261 mint read THIS stored result as failed. A Senate
      // first roll stored '' (FIX-1260), so it minted floor_vote — not a rescue.
      if (first && first.result_source === "votes" && voteResultClass(first.result) === "failed") untouchedEnacted.push({ ...base, rolls });
      continue;
    }
    if (c.status === "failed") {
      if (c.latest_action && NEGATIVE_TEXT.test(c.latest_action)) { excluded.negative_text.push(base); continue; }
      if (rolls.length === 0) { excluded.failed_without_rolls.push(base); continue; }
      const next = highest(["floor_vote", passedPassage.length ? "passed_chamber" : null, text]);
      items.push({ ...base, class: "i", new_status: next, rolls });
      continue;
    }
    // passed_chamber
    if (rolls.length === 0) { passedNoRolls += 1; continue; }          // minted by the sync, not the vote path
    if (passedPassage.length > 0) { correctPassed += 1; continue; }    // a passed passage roll proves it
    if (rankOf(text) >= rankOf("passed_chamber")) { passedByText += 1; continue; } // the text proves it
    items.push({ ...base, class: "ii", new_status: "floor_vote", rolls });
  }
  for (const i of items) if (!UUID_RE.test(i.proposal_id)) args.usage(`bad proposal_id ${i.proposal_id}`);

  const tally = (xs, f) => xs.reduce((o, x) => ((o[f(x)] = (o[f(x)] ?? 0) + 1), o), {});
  const classI = items.filter((i) => i.class === "i");
  const classII = items.filter((i) => i.class === "ii");
  const manifest = {
    database: args.target,
    fix: "FIX-1261",
    prompt: "cc-185",
    built_at: new Date().toISOString(),
    senate_results_manifest: relative(ROOT, SENATE_RESULTS),
    population: {
      rule: "(i) federal non-PN measure at failed, with rolls, latest action not failed/withdrawn → highest(floor_vote, passed_chamber if a passed passage roll, mapBillStatus(latest_action, origin)); (ii) at passed_chamber, with rolls, no passed passage roll, latest action ranks < passed_chamber → floor_vote; (iii) enacted with a failed first roll — untouched",
      passage_questions: PASSAGE_QUESTIONS,
      classes: { i: classI.length, ii: classII.length },
      by_transition: tally(items, (i) => `${i.current_status}→${i.new_status}`),
      class_i_by_first_question: tally(classI, (i) => i.first_roll?.question ?? "<none>"),
      class_ii_by_type_and_first_question: tally(classII, (i) => `${i.bill_number.split(" ")[0]} · ${i.first_roll?.question ?? "<none>"}`),
      untouched_enacted: untouchedEnacted.length,
      untouched_enacted_items: untouchedEnacted.map((e) => ({ proposal_id: e.proposal_id, bill_number: e.bill_number, first_roll: e.first_roll })),
      passed_chamber_kept: { with_passed_passage_roll: correctPassed, no_rolls_minted_by_sync: passedNoRolls, latest_action_proves_it: passedByText },
      excluded: {
        negative_text: excluded.negative_text,
        failed_without_rolls: excluded.failed_without_rolls,
      },
    },
    items,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[${TAG}] ${JSON.stringify({ classes: manifest.population.classes, by_transition: manifest.population.by_transition, untouched_enacted: untouchedEnacted.length, kept: manifest.population.passed_chamber_kept, excluded_negative_text: excluded.negative_text.length, failed_without_rolls: excluded.failed_without_rolls.length })}`);
  console.log(`[${TAG}] class (i) by first question: ${JSON.stringify(manifest.population.class_i_by_first_question)}`);
  console.log(`[${TAG}] class (ii) by type · first question: ${JSON.stringify(manifest.population.class_ii_by_type_and_first_question)}`);
  if (classII.length > 100) console.log(`[${TAG}] ⚠ STOP: class (ii) is ${classII.length} > 100 — the resolution questions did not explain the passed_chamber artifacts; report before applying (ii)`);
  console.log(`[${TAG}] wrote ${relative(ROOT, OUT)} (${items.length} item(s))`);
}

// ── --dry-run / --apply / --read-back ────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) args.usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== args.target) args.usage(`manifest was built on ${m.database}; refusing to use it on ${args.target}`);
  for (const i of m.items) {
    if (!UUID_RE.test(i.proposal_id)) args.usage(`bad proposal_id ${i.proposal_id}`);
    if (!["failed", "passed_chamber"].includes(i.current_status)) args.usage(`unexpected current_status in ${i.proposal_id}`);
    if (rankOf(i.new_status) < 0) args.usage(`bad new_status in ${i.proposal_id}`);
  }
  return m;
}

const label = (i) => `${i.session}-${i.bill_number} ${i.proposal_id}`;

function dryRun() {
  const m = loadManifest();
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY dry run of ${relative(ROOT, MANIFEST)} (${m.items.length} item(s))`);
  const live = readJson(url, LIVE_STATUS_SQL(m.items.map((i) => i.proposal_id)) + ";", TAG) ?? {};
  let plan = 0;
  const skips = [];
  for (const i of m.items) {
    const l = live[i.proposal_id];
    if (!l) skips.push(`${label(i)}: gone`);
    else if (l.status !== i.current_status) skips.push(`${label(i)}: live '${l.status}' (manifest '${i.current_status}')`);
    else {
      plan += 1;
      console.log(`[${TAG}]   (${i.class}) ${label(i)}: precondition status = '${i.current_status}' holds — plan ${i.current_status} → ${i.new_status}`);
    }
  }
  for (const s of skips) console.log(`[${TAG}]   SKIP ${s}`);
  const pct = m.items.length ? (100 * skips.length) / m.items.length : 0;
  console.log(`[${TAG}] dry run: ${plan} to write, ${skips.length} skip (${pct.toFixed(1)}%)`);
  if (pct > 5) console.log(`[${TAG}] ⚠ STOP: skips exceed 5% of the manifest — the population moved; rebuild it`);
  console.log(`[${TAG}] proposals tuples: ${JSON.stringify(readJson(url, PROPOSALS_TUPLES_SQL() + ";", TAG))}`);
}

function apply() {
  const m = loadManifest();
  const { pre, claimant } = claimPreamble(args.target, "fix1261-repair-vote-path-mints", TAG);
  console.log(`[${TAG}] ${args.targetLabel} — DIRECT WRITE (bypasses proposals_advance_status by design): ${m.items.length} item(s) from ${relative(ROOT, MANIFEST)}${claimant ? `; claimant ${claimant}` : ""}; start ${new Date().toISOString()}`);
  if (m.items.length === 0) { console.log(`[${TAG}] nothing to send`); return; }
  const res = psql(url, pre + DIRECT_REPAIR_SQL(m.items) + ";", { tag: TAG });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[${TAG}] psql exit ${res.status} — the statement rolled back; nothing was written`);
    process.exit(1);
  }
  const out = lastJson(res.stdout);
  const moved = out.moved ?? [];
  const movedIds = new Set(moved.map((x) => x.id));
  const tally = {};
  for (const x of moved) tally[`${x.from}→${x.to}`] = (tally[`${x.from}→${x.to}`] ?? 0) + 1;
  const skipped = m.items.filter((i) => !movedIds.has(i.proposal_id));
  const live = skipped.length ? readJson(url, LIVE_STATUS_SQL(skipped.map((i) => i.proposal_id)) + ";", TAG) ?? {} : {};
  for (const i of skipped) console.log(`[${TAG}]   SKIP ${label(i)}: live '${live[i.proposal_id]?.status ?? "gone"}' (manifest '${i.current_status}')`);
  console.log(`[${TAG}] moved ${moved.length} ${JSON.stringify(tally)}, skipped ${skipped.length} of ${m.items.length}; statement at ${out.at}; end ${new Date().toISOString()}`);
}

function readBack() {
  const m = loadManifest();
  const live = readJson(url, LIVE_STATUS_SQL(m.items.map((i) => i.proposal_id)) + ";", TAG) ?? {};
  const counts = {};
  const off = [];
  for (const i of m.items) {
    const s = live[i.proposal_id]?.status ?? "gone";
    counts[s] = (counts[s] ?? 0) + 1;
    if (s !== i.new_status) off.push(`${label(i)} '${s}' (want '${i.new_status}')`);
  }
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY read-back of ${m.items.length} item(s) at ${new Date().toISOString()}: ${JSON.stringify(counts)}`);
  for (const o of off) console.log(`[${TAG}]   NOT AT new_status: ${o}`);
  console.log(`[${TAG}] proposals tuples: ${JSON.stringify(readJson(url, PROPOSALS_TUPLES_SQL() + ";", TAG))}`);
  process.exit(off.length > 0 ? 1 : 0);
}

({ "--build-manifest": buildManifest, "--dry-run": dryRun, "--apply": apply, "--read-back": readBack })[args.mode]();
