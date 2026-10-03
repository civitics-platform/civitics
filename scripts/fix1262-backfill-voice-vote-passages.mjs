#!/usr/bin/env node
// fix1262-backfill-voice-vote-passages.mjs — FIX-1262 (cc-185). Federal
// measures whose latest action proves their ORIGIN chamber passed them, but
// which read below passed_chamber because the passage was a voice vote or
// unanimous consent (no roll, so no FIX-1257 passage evidence).
//
// THE TEXTS (mapBillStatus(text, originChamber), FIX-1262's arms):
//   a House measure  "Received in the Senate…" (incl. "…and Read twice and
//                    referred to…", which used to map in_committee) — the
//                    Senate can only receive what the House passed;
//   a Senate measure "Held at the desk." — the House holds what the Senate sent;
//   either           "Message on Senate action sent to the House." — the Senate
//                    acted on it, so its origin chamber had passed it.
// cc-185 read 3(iii), prod 2026-10-03 23:08 UTC: 359 below passed_chamber.
// The origin chamber is the bill-number prefix (read 5: bill_details.chamber
// agrees on every federal row).
//
// THE WRITE: ONE statement through proposals_advance_status() — upward only;
// the RPC re-checks the rule on each locked row (the fix1257 shape).
//
// MODES (exactly one; target --local or --prod):
//   --build-manifest [--out P]   READ ONLY
//   --dry-run                    READ ONLY
//   --apply                      on --prod only under a FIX-950 claim
//   --read-back                  READ ONLY: 0 items below passed_chamber
// --manifest P (default docs/audits/2026-10-04-fix1262-voice-vote-passages.json).
//
// USAGE (prod reads the password from the PRIMARY checkout's .env.local.prod):
//   node scripts/fix1262-backfill-voice-vote-passages.mjs --prod --build-manifest --env-file …
//   node scripts/fix1262-backfill-voice-vote-passages.mjs --prod --dry-run --env-file …
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 2 --census off \
//     --reason "cc-185 FIX-1262 voice-vote passages (<N>)" \
//     --then "node ../../scripts/fix1262-backfill-voice-vote-passages.mjs --prod --apply --manifest <abs>"
//   node scripts/fix1262-backfill-voice-vote-passages.mjs --prod --read-back --env-file …

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  ROOT, UUID_RE, mapBillStatus, originChamberOf, connectionUrl, readJson, parseArgs,
  VOICE_VOTE_CANDIDATES_SQL, PROPOSALS_TUPLES_SQL, advanceDryRun, advanceApply, advanceReadBack,
} from "./lib/bill-status-evidence.mjs";

const TAG = "fix1262";
const NEW_STATUS = "passed_chamber";
const args = parseArgs(process.argv.slice(2), {
  modes: ["--build-manifest", "--dry-run", "--apply", "--read-back"],
  defaultManifest: join(ROOT, "docs", "audits", "2026-10-04-fix1262-voice-vote-passages.json"),
  tag: TAG,
});
const MANIFEST = resolve(args.manifest);
const OUT = resolve(args.out);
const url = connectionUrl(args.target, resolve(args.envFile), TAG);

const textClass = (s) => {
  const t = String(s ?? "").trim().toLowerCase();
  if (/^received in the senate and read twice and referred to/.test(t)) return "received in the senate + referred";
  if (/^received in the senate\b/.test(t)) return "received in the senate";
  if (/^held at the desk\b/.test(t)) return "held at the desk";
  if (/^message on senate action sent to the house\b/.test(t)) return "message on senate action";
  return "other";
};

function buildManifest() {
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY: federal measures below passed_chamber with an origin-passage text`);
  const candidates = readJson(url, VOICE_VOTE_CANDIDATES_SQL() + ";", TAG) ?? [];
  const items = [];
  const notProven = [];
  const chamberDisagrees = [];
  for (const c of candidates) {
    const origin = originChamberOf(c.bill_number);
    if (c.chamber && c.chamber !== origin) chamberDisagrees.push({ proposal_id: c.id, bill_number: c.bill_number, chamber: c.chamber });
    const proves = mapBillStatus(c.latest_action, origin);
    const row = {
      proposal_id: c.id, bill_number: c.bill_number, session: c.session, origin_chamber: origin,
      current_status: c.status, latest_action: c.latest_action, text_class: textClass(c.latest_action),
      maps_without_chamber: mapBillStatus(c.latest_action), new_status: NEW_STATUS,
    };
    if (proves !== NEW_STATUS) { notProven.push({ ...row, maps_to: proves }); continue; }
    if (!UUID_RE.test(c.id)) args.usage(`bad proposal_id ${c.id}`);
    items.push(row);
  }
  const tally = (xs, f) => xs.reduce((o, x) => ((o[f(x)] = (o[f(x)] ?? 0) + 1), o), {});
  const manifest = {
    database: args.target,
    fix: "FIX-1262",
    prompt: "cc-185",
    built_at: new Date().toISOString(),
    population: {
      rule: "federal HR/HJRES/HCONRES/S/SJRES/SCONRES below passed_chamber whose latest action proves the ORIGIN chamber passed it — mapBillStatus(text, prefix-origin) = passed_chamber",
      counts: {
        items: items.length,
        by_type_and_class: tally(items, (i) => `${i.bill_number.split(" ")[0]} · ${i.text_class}`),
        by_current_status: tally(items, (i) => i.current_status),
        candidates_not_proven: notProven.length,
        chamber_vs_prefix_disagreements: chamberDisagrees.length,
      },
      not_proven: notProven,
      chamber_vs_prefix_disagreements: chamberDisagrees,
    },
    items,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[${TAG}] ${JSON.stringify(manifest.population.counts)}`);
  console.log(`[${TAG}] wrote ${relative(ROOT, OUT)} (${items.length} item(s))`);
}

function loadManifest() {
  if (!existsSync(MANIFEST)) args.usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== args.target) args.usage(`manifest was built on ${m.database}; refusing to use it on ${args.target}`);
  for (const i of m.items) {
    if (!UUID_RE.test(i.proposal_id)) args.usage(`bad proposal_id ${i.proposal_id}`);
    if (i.new_status !== NEW_STATUS) args.usage(`bad new_status in ${i.proposal_id}`);
  }
  return m;
}

const tuples = () => JSON.stringify(readJson(url, PROPOSALS_TUPLES_SQL() + ";", TAG));

function dryRun() {
  const m = loadManifest();
  console.log(`[${TAG}] ${args.targetLabel} — READ ONLY dry run of ${relative(ROOT, MANIFEST)} (${m.items.length} item(s))`);
  advanceDryRun({ url, tag: TAG, items: m.items });
  console.log(`[${TAG}] proposals tuples: ${tuples()}`);
}

function apply() {
  const m = loadManifest();
  advanceApply({ url, tag: TAG, target: args.target, appName: "fix1262-backfill-voice-vote-passages", items: m.items, manifestLabel: relative(ROOT, MANIFEST) });
}

function readBack() {
  const m = loadManifest();
  const below = advanceReadBack({ url, tag: TAG, items: m.items });
  console.log(`[${TAG}] proposals tuples: ${tuples()}`);
  process.exit(below > 0 ? 1 : 0);
}

({ "--build-manifest": buildManifest, "--dry-run": dryRun, "--apply": apply, "--read-back": readBack })[args.mode]();
