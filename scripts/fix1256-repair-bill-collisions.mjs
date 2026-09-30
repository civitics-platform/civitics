#!/usr/bin/env node
// fix1256-repair-bill-collisions.mjs — ONE authorized prod data set (FIX-1256, cc-177).
//
// Three congress.gov bills have two `proposals` rows: an 08-04 KEY-HOLDER that
// holds the bill_details natural key (jurisdiction_id, session, bill_number)
// and has NO congress_gov ref, and a later STUB that holds the ref and has no
// bill_details row (case b: HR 4795 / 9816 / 9847). Three more refs point at a
// proposal with no bill_details row and no second holder (case a: S 221 /
// 2466 / 3690). Roll 2026-house-295 (HR 4795) is skipped nightly by the
// FIX-1238 guard because its ref resolves to the stub.
//
// HOW THE SHAPE AROSE (cc-177 read 3, the 08-04 nightly log, GHA run
// 30880119350): not a cancel. The recent-bills sync writes proposals, then
// bill_details, then refs as three separate PostgREST calls. On a stressed box
// the HR batch's `source_refs chunk 0-18` and the S batch's
// `bill_details chunk 0-3` were cancelled by the 8 s statement timeout; the
// errors were logged and not counted. Every later ingest of three of those
// bills found no ref and minted a stub beside the holder. The writer is fixed
// (a638f474); this puts the six rows right.
//
// THE POPULATION (rule 45 — the filter is part of the contract): every
// external_source_refs row source='congress_gov', entity_type='proposal' whose
// entity_id has no bill_details row. Its natural key derives from the ref's
// external_id `<congress>-<TYPE>-<number>` → session '<congress>', bill_number
// '<TYPE> <number>', jurisdiction = the ref proposal's — the same derivation as
// billNaturalKey() in packages/data/src/pipelines/congress/bills.ts. Case b:
// another proposal holds that key and carries no congress_gov ref of its own.
// Case a: nobody holds it. A key-holder that DOES carry its own congress_gov
// ref is not case b and is excluded (listed, not repaired).
//
// PER CASE-B ITEM, ONE DO STATEMENT (atomic — a cancel or a refusal rolls back
// all of it, rule 66):
//   (i)   preconditions re-read under FOR UPDATE: the stub still holds the ref
//         and has no bill_details row; the holder still holds the key and has
//         no congress_gov ref. Otherwise SKIP with the reason (the world moved,
//         or the item is already repaired — the idempotent re-run).
//   (ii)  UPDATE external_source_refs SET entity_id = holder WHERE id = ref.
//   (iii) every dependent of the stub, by the DEPENDENTS survivor rules below:
//         MOVE to the holder; an identical row the holder already has is the
//         same derived fact, so the stub's copy is dropped; a NON-identical
//         collision REFUSES the item (rollback — Craig decides); a table with
//         no mechanical survivor rule REFUSES on any row.
//   (iv)  when the stub's updated_at is newer, copy title, summary_plain,
//         status, external_url, last_action_at, introduced_at and metadata to
//         the holder (a NULL on the stub never overwrites the holder), and say
//         which columns moved. A stub the VOTE path minted (title = the bill
//         number; its dates are the roll's) copies nothing. updated_at itself
//         is the set_updated_at() trigger's: it becomes now().
//   (v)   assert every dependent count on the stub is 0, then DELETE the stub;
//         refresh the holder's primary_source (refresh_primary_source_for_entities).
//   (vi)  RAISE NOTICE the item's receipt line (the run log).
// PER CASE-A ITEM: assert the key is free (else REFUSE — it is case b), then
// INSERT the bill_details row — every column from the key, congress_gov_url =
// the ref's source_url, which the writer set from the same URL builder.
//
// A REFUSE rolls its item back and the run continues; any OTHER error stops the
// run (rule 204). Items before it stay committed; a re-run of the same manifest
// skips them as already repaired.
//
// MODES (exactly one; target --local or --prod, always explicit):
//   --build-manifest [--out P]  READ ONLY: derive the population, write the manifest
//   --dry-run                   READ ONLY: per item, the preconditions, every
//                               dependent's count on stub and holder, and the plan
//   --apply                     the repair. On --prod it refuses unless it runs
//                               under a FIX-950 claim (session:wait-for-gate
//                               --then sets CIVITICS_PROD_SESSION_CLAIMANT)
//   --seed-rehearsal            --local ONLY: give the clone the prod pairs it
//                               predates, plus two fabricated fixtures (a REFUSE
//                               and a vote-path placeholder stub)
//   --unseed-rehearsal          --local ONLY: remove the fabricated fixtures
// --manifest P (default docs/audits/2026-09-30-fix1256-bill-proposal-collisions.json);
// an apply refuses a manifest built on the other database.
//
// USAGE — prod reads the password from .env.local.prod; a worktree's copy is a
// stub, so run prod from the PRIMARY checkout (or pass --env-file):
//   node scripts/fix1256-repair-bill-collisions.mjs --prod --build-manifest
//   node scripts/fix1256-repair-bill-collisions.mjs --prod --dry-run
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 1 --census off \
//     --reason "cc-177 FIX-1256 bill collisions (6 items)" \
//     --then "node ../../scripts/fix1256-repair-bill-collisions.mjs --prod --apply"
//
// No psql meta-commands. Every literal interpolated into SQL is validated first
// (uuid regex, the external_id shape).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DEFAULT_MANIFEST = join(ROOT, "docs", "audits", "2026-09-30-fix1256-bill-proposal-collisions.json");
const STATEMENT_TIMEOUT = "60s"; // per item; each is a handful of index probes and ≤ 10 row writes

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const XID_RE = /^[0-9]+-[A-Z]+-[0-9]+$/;

// ── the dependent surface of a proposal (cc-177 read 4) ─────────────────────
// Derived on prod from pg_constraint (every FK to proposals(id), plus votes →
// bill_details(proposal_id)) and from the polymorphic id columns in public
// (information_schema). `rule`:
//   move   re-point to the holder. `key` = the columns that, with the entity
//          column, are unique: a stub row whose key the holder already has is
//          dropped when the two rows are identical apart from identity columns
//          (the same derived fact twice), and REFUSES the item otherwise.
//          No key = nothing can collide.
//   drop   a projection keyed by the proposal's own id (search index): the
//          stub's row goes with the stub; the holder has its own, refreshed by
//          the next index build.
//   zero   no mechanical survivor rule: any row on the stub REFUSES the item.
const P = "'proposal'";
export const DEPENDENTS = [
  { table: "external_source_refs", col: "entity_id", where: `entity_type = ${P}`, rule: "move", key: [] },
  { table: "entity_tags", col: "entity_id", where: `entity_type = ${P}`, rule: "move", key: ["tag", "tag_category"] },
  { table: "enrichment_queue", col: "entity_id", text: true, where: `entity_type = ${P}`, rule: "move", key: ["task_type"] },
  { table: "ai_summary_cache", col: "entity_id", where: `entity_type = ${P}`, rule: "move", key: ["summary_type"] },
  { table: "page_views", col: "entity_id", where: `entity_type = ${P}`, rule: "move", key: [] },
  { table: "entity_search_index", col: "entity_id", where: `kind = ${P}`, rule: "drop" },
  { table: "bill_details", col: "proposal_id", rule: "zero" },
  { table: "votes", col: "bill_proposal_id", rule: "zero" },
  { table: "promises", col: "related_proposal_id", rule: "zero" },
  { table: "civic_comments", col: "proposal_id", rule: "zero" },
  { table: "official_comment_submissions", col: "proposal_id", rule: "zero" },
  { table: "civic_initiative_signatures", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_responses", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_versions", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_upvotes", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_arguments", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_milestone_events", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_follows", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_proposal_links", col: "initiative_id", rule: "zero" },
  { table: "civic_initiative_proposal_links", col: "proposal_id", rule: "zero" },
  { table: "proposal_cosponsors", col: "proposal_id", rule: "zero" },
  { table: "case_details", col: "proposal_id", rule: "zero" },
  { table: "measure_details", col: "proposal_id", rule: "zero" },
  { table: "measure_details", col: "originating_initiative_id", rule: "zero" },
  { table: "initiative_details", col: "proposal_id", rule: "zero" },
  { table: "initiative_details", col: "promoted_to_proposal_id", rule: "zero" },
  { table: "proposal_actions", col: "proposal_id", rule: "zero" },
  { table: "agenda_items", col: "proposal_id", rule: "zero" },
  { table: "proposal_comment_stats", col: "proposal_id", rule: "zero" },
  { table: "entity_activity_state", col: "entity_id", rule: "zero" },
  { table: "entity_comments", col: "entity_id", rule: "zero" },
  { table: "entity_positions", col: "entity_id", rule: "zero" },
  { table: "entity_statements", col: "entity_id", rule: "zero" },
  { table: "notifications", col: "entity_id", rule: "zero" },
  { table: "position_events", col: "entity_id", rule: "zero" },
  { table: "synthetic_entities", col: "entity_id", rule: "zero" },
  { table: "synthetic_position_rollup", col: "entity_id", rule: "zero" },
  { table: "abuse_events", col: "target_id", rule: "zero" },
  { table: "citations", col: "target_id", rule: "zero" },
  { table: "entity_grants", col: "target_id", rule: "zero" },
  { table: "brigade_candidates", col: "target_id", rule: "zero" },
  { table: "entity_connections", col: "from_id", where: `from_type = ${P}`, rule: "zero" },
  { table: "entity_connections", col: "to_id", where: `to_type = ${P}`, rule: "zero" },
  { table: "financial_relationships", col: "from_id", where: `from_type = ${P}`, rule: "zero" },
  { table: "financial_relationships", col: "to_id", where: `to_type = ${P}`, rule: "zero" },
  { table: "external_relationships", col: "from_id", where: `from_type = ${P}`, rule: "zero" },
  { table: "external_relationships", col: "to_id", where: `to_type = ${P}`, rule: "zero" },
  { table: "evidence_cards", col: "from_id", rule: "zero" },
  { table: "evidence_cards", col: "to_id", rule: "zero" },
  { table: "entity_connection_stats_mv", col: "entity_id", rule: "zero" },
  { table: "user_preferences", col: "followed_proposals", array: true, rule: "zero" },
];

const depName = (d) => `${d.table}.${d.col}`;
const IDENTITY = ["id", "created_at"];

/** SQL predicate: the dependent's rows keyed on the uuid expression `idExpr`. */
function depPred(d, idExpr, alias = "") {
  const a = alias ? `${alias}.` : "";
  const match = d.array
    ? `${idExpr} = ANY(${a}${d.col})`
    : d.text
      ? `${a}${d.col} = (${idExpr})::text`
      : `${a}${d.col} = ${idExpr}`;
  return d.where ? `${d.where.replace(/^(\w+)/, `${a}$1`)} AND ${match}` : match;
}

/** A count of `d`'s rows on `idExpr`, as a SQL scalar subquery. */
const depCount = (d, idExpr) => `(SELECT count(*) FROM public.${d.table} WHERE ${depPred(d, idExpr)})`;

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

function usage(msg) {
  console.error(`[fix1256] ${msg}`);
  console.error("[fix1256] see the header of scripts/fix1256-repair-bill-collisions.mjs");
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
    console.error(`[fix1256] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error("[fix1256] a worktree's .env.local.prod is a stub — run from the primary checkout or pass --env-file");
    process.exit(2);
  }
  const base = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  const u = base.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === base) {
    console.error(`[fix1256] could not inject the password into the pooler URL`);
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
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[fix1256] failed to launch psql: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function readJson(sql) {
  const res = psql(sql, { readOnly: true });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[fix1256] read failed (psql exit ${res.status})`);
    process.exit(1);
  }
  // One value out; json_agg breaks lines between elements, so parse from the
  // first brace to the end rather than line by line.
  const start = res.stdout.search(/[{[]/);
  if (start < 0) {
    console.error("[fix1256] read returned no JSON value");
    process.exit(1);
  }
  return JSON.parse(res.stdout.slice(start));
}

const TARGET_LABEL = TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL (127.0.0.1:54322)";

// ── --build-manifest ─────────────────────────────────────────────────────────
function buildManifest() {
  const read = readJson(`
SELECT json_build_object(
  'read_at', now(),
  'rows', COALESCE((SELECT json_agg(r ORDER BY r.external_id) FROM (
    SELECT x.id AS ref_id, x.external_id, x.source_url, x.entity_id AS ref_proposal_id,
           p.jurisdiction_id, p.title AS ref_title, p.created_at AS ref_created_at,
           h.proposal_id AS holder_proposal_id, hp.title AS holder_title, hp.created_at AS holder_created_at,
           (SELECT string_agg(hx.source || ':' || hx.external_id, ',') FROM public.external_source_refs hx
             WHERE hx.entity_type = 'proposal' AND hx.entity_id = h.proposal_id) AS holder_refs,
           EXISTS (SELECT 1 FROM public.external_source_refs hx
                    WHERE hx.source = 'congress_gov' AND hx.entity_type = 'proposal' AND hx.entity_id = h.proposal_id) AS holder_has_cg_ref
      FROM public.external_source_refs x
      JOIN public.proposals p ON p.id = x.entity_id
      LEFT JOIN public.bill_details h
        ON h.jurisdiction_id = p.jurisdiction_id
       AND h.session = split_part(x.external_id, '-', 1)
       AND h.bill_number = split_part(x.external_id, '-', 2) || ' ' || split_part(x.external_id, '-', 3)
      LEFT JOIN public.proposals hp ON hp.id = h.proposal_id
     WHERE x.source = 'congress_gov' AND x.entity_type = 'proposal'
       AND NOT EXISTS (SELECT 1 FROM public.bill_details bd WHERE bd.proposal_id = x.entity_id)) r), '[]'::json),
  'latent_holders', (SELECT count(*) FROM public.bill_details bd
                      WHERE bd.jurisdiction_id = (SELECT jurisdiction_id FROM public.proposals WHERE external_url LIKE 'https://congress.gov/bill/%' LIMIT 1)
                        AND NOT EXISTS (SELECT 1 FROM public.external_source_refs x
                                         WHERE x.source = 'congress_gov' AND x.entity_type = 'proposal' AND x.entity_id = bd.proposal_id))
);`);

  const items = [];
  const excluded = [];
  for (const r of read.rows) {
    if (!XID_RE.test(r.external_id)) {
      excluded.push({ external_id: r.external_id, reason: "external_id is not <congress>-<TYPE>-<number>" });
      continue;
    }
    for (const id of [r.ref_id, r.ref_proposal_id, r.jurisdiction_id, r.holder_proposal_id].filter(Boolean)) {
      if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${id}`);
    }
    const [congress, type, number] = r.external_id.split("-");
    const bill_key = { jurisdiction_id: r.jurisdiction_id, session: congress, bill_number: `${type} ${number}` };
    if (r.holder_proposal_id && r.holder_has_cg_ref) {
      excluded.push({
        external_id: r.external_id,
        reason: `key-holder ${r.holder_proposal_id} carries its own congress_gov ref (${r.holder_refs}) — not case b`,
      });
    } else if (r.holder_proposal_id) {
      items.push({
        case: "b",
        external_id: r.external_id,
        ref_id: r.ref_id,
        ref_proposal_id: r.ref_proposal_id,
        holder_proposal_id: r.holder_proposal_id,
        bill_key,
        ref_proposal: { title: r.ref_title, created_at: r.ref_created_at },
        holder: { title: r.holder_title, created_at: r.holder_created_at, refs: r.holder_refs },
      });
    } else {
      items.push({
        case: "a",
        external_id: r.external_id,
        ref_id: r.ref_id,
        proposal_id: r.ref_proposal_id,
        bill_key,
        chamber: type.startsWith("H") ? "house" : "senate", // chamberForBillType()
        congress_number: Number(congress),
        congress_gov_url: r.source_url,
        proposal: { title: r.ref_title, created_at: r.ref_created_at },
      });
    }
  }
  const manifest = {
    generated_at: read.read_at,
    database: TARGET,
    fix: "FIX-1256",
    prompt: "cc-177",
    population_filter:
      "external_source_refs x WHERE x.source = 'congress_gov' AND x.entity_type = 'proposal' AND NOT EXISTS " +
      "(bill_details bd WHERE bd.proposal_id = x.entity_id); natural key (x's proposal's jurisdiction_id, " +
      "split_part(external_id,'-',1), split_part(external_id,'-',2) || ' ' || split_part(external_id,'-',3)); " +
      "case b = another proposal holds it and has no congress_gov ref; case a = nobody holds it",
    counts: {
      case_b: items.filter((i) => i.case === "b").length,
      case_a: items.filter((i) => i.case === "a").length,
      excluded: excluded.length,
      latent_holders_federal_no_congress_gov_ref: Number(read.latent_holders),
    },
    items,
    excluded,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`[fix1256] ${TARGET_LABEL} read at ${read.read_at} — READ ONLY; nothing written to the database`);
  console.log(`[fix1256] manifest: ${OUT}`);
  console.log(`[fix1256] case b ${manifest.counts.case_b}, case a ${manifest.counts.case_a}, excluded ${excluded.length}; latent holders (federal bill_details, no congress_gov ref) ${manifest.counts.latent_holders_federal_no_congress_gov_ref}`);
  for (const i of items) {
    console.log(
      i.case === "b"
        ? `[fix1256]   b ${i.external_id}: ref ${i.ref_id} on stub ${i.ref_proposal_id}; key ${i.bill_key.bill_number} held by ${i.holder_proposal_id}`
        : `[fix1256]   a ${i.external_id}: ref ${i.ref_id} on ${i.proposal_id}; key ${i.bill_key.bill_number} free`,
    );
  }
  for (const e of excluded) console.log(`[fix1256]   excluded ${e.external_id}: ${e.reason}`);
}

// ── manifest ─────────────────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) usage(`no manifest at ${MANIFEST} — run --build-manifest first`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== TARGET) usage(`manifest database is ${JSON.stringify(m.database)}; this run targets "${TARGET}"`);
  if (!Array.isArray(m.items) || m.items.length === 0) usage("manifest has no items");
  const seen = new Set();
  for (const i of m.items) {
    if (!XID_RE.test(i.external_id)) throw new Error(`bad external_id ${i.external_id}`);
    if (seen.has(i.external_id)) throw new Error(`external_id ${i.external_id} is in the manifest twice`);
    seen.add(i.external_id);
    const ids = i.case === "b" ? [i.ref_id, i.ref_proposal_id, i.holder_proposal_id] : i.case === "a" ? [i.ref_id, i.proposal_id] : null;
    if (!ids) throw new Error(`item ${i.external_id} has case ${JSON.stringify(i.case)}`);
    for (const id of [...ids, i.bill_key?.jurisdiction_id]) if (!UUID_RE.test(String(id))) throw new Error(`not a uuid in ${i.external_id}: ${id}`);
    const [congress, type, number] = i.external_id.split("-");
    if (i.bill_key.session !== congress || i.bill_key.bill_number !== `${type} ${number}`) {
      throw new Error(`item ${i.external_id}: bill_key does not derive from the external_id`);
    }
    if (i.case === "a" && !/^https:\/\/congress\.gov\/bill\/[0-9a-z/-]+$/.test(String(i.congress_gov_url))) {
      throw new Error(`item ${i.external_id}: congress_gov_url ${i.congress_gov_url} is not a congress.gov bill URL`);
    }
  }
  return m;
}

// ── --dry-run ────────────────────────────────────────────────────────────────
function dryRun() {
  const m = loadManifest();
  const itemSql = (i) => {
    const k = i.bill_key;
    const keyPred = `jurisdiction_id = ${lit(k.jurisdiction_id)} AND session = ${lit(k.session)} AND bill_number = ${lit(k.bill_number)}`;
    if (i.case === "a") {
      return `json_build_object('external_id', ${lit(i.external_id)}, 'case', 'a',
        'ref_on_proposal', EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = ${lit(i.ref_id)} AND entity_id = ${lit(i.proposal_id)} AND external_id = ${lit(i.external_id)}),
        'has_bill_details', EXISTS (SELECT 1 FROM public.bill_details WHERE proposal_id = ${lit(i.proposal_id)}),
        'key_holder', (SELECT proposal_id FROM public.bill_details WHERE ${keyPred}),
        'proposal_row', (SELECT json_build_object('jurisdiction_id', jurisdiction_id, 'legacy_bill_number', metadata->>'legacy_bill_number',
                                                  'legacy_session', metadata->>'legacy_session', 'external_url', external_url)
                           FROM public.proposals WHERE id = ${lit(i.proposal_id)}))`;
    }
    const s = lit(i.ref_proposal_id);
    const h = lit(i.holder_proposal_id);
    const deps = DEPENDENTS.map((d) => {
      const coll =
        d.rule === "move" && d.key.length > 0
          ? `(SELECT count(*) FROM public.${d.table} s1 JOIN public.${d.table} h1 ON ${depPred(d, h, "h1")} AND ${d.key.map((c) => `h1.${c} = s1.${c}`).join(" AND ")}
               WHERE ${depPred(d, s, "s1")})`
          : "0";
      const ident =
        d.rule === "move" && d.key.length > 0
          ? `(SELECT count(*) FROM public.${d.table} s1 JOIN public.${d.table} h1 ON ${depPred(d, h, "h1")} AND ${d.key.map((c) => `h1.${c} = s1.${c}`).join(" AND ")}
               WHERE ${depPred(d, s, "s1")}
                 AND (to_jsonb(s1) - ARRAY['id','created_at','${d.col}']) = (to_jsonb(h1) - ARRAY['id','created_at','${d.col}']))`
          : "0";
      return `json_build_array(${lit(depName(d))}, ${lit(d.rule)}, ${depCount(d, s)}, ${depCount(d, h)}, ${coll}, ${ident})`;
    });
    return `json_build_object('external_id', ${lit(i.external_id)}, 'case', 'b',
      'ref_on_stub', EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = ${lit(i.ref_id)} AND source = 'congress_gov' AND entity_type = 'proposal' AND external_id = ${lit(i.external_id)} AND entity_id = ${s}),
      'ref_on_holder', EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = ${lit(i.ref_id)} AND entity_id = ${h}),
      'stub_exists', EXISTS (SELECT 1 FROM public.proposals WHERE id = ${s}),
      'holder_holds_key', EXISTS (SELECT 1 FROM public.bill_details WHERE proposal_id = ${h} AND ${keyPred}),
      'holder_cg_refs', (SELECT count(*) FROM public.external_source_refs WHERE source = 'congress_gov' AND entity_type = 'proposal' AND entity_id = ${h}),
      'stub', (SELECT json_build_object('title', title, 'status', status, 'updated_at', updated_at, 'last_action_at', last_action_at,
                                         'vote_path_placeholder', title = metadata->>'legacy_bill_number') FROM public.proposals WHERE id = ${s}),
      'holder', (SELECT json_build_object('title', title, 'status', status, 'updated_at', updated_at, 'last_action_at', last_action_at) FROM public.proposals WHERE id = ${h}),
      'deps', json_build_array(${deps.join(",\n")}))`;
  };
  const read = readJson(`SELECT json_build_object('read_at', now(), 'items', json_build_array(${m.items.map(itemSql).join(",\n")}));`);

  console.log(`[fix1256] DRY RUN — ${TARGET_LABEL} read at ${read.read_at}; READ ONLY, nothing written`);
  console.log(`[fix1256] manifest ${MANIFEST} (${m.items.length} items, built ${m.generated_at})`);
  let n = 0;
  for (const r of read.items) {
    n += 1;
    if (r.case === "a") {
      const plan = r.has_bill_details
        ? "SKIP — already has a bill_details row"
        : !r.ref_on_proposal
          ? "SKIP — the ref no longer binds this proposal"
          : r.key_holder
            ? `REFUSE — key held by ${r.key_holder} (case b, not a)`
            : "LAND one bill_details row";
      console.log(`[fix1256] item ${n}/${m.items.length} a ${r.external_id}: ${plan}; proposal row ${JSON.stringify(r.proposal_row)}`);
      continue;
    }
    const refusals = [];
    const lines = [];
    for (const [name, rule, onStub, onHolder, coll, ident] of r.deps) {
      if (onStub === 0 && onHolder === 0) continue;
      let action = "";
      if (onStub > 0) {
        if (rule === "zero") {
          action = name === "bill_details.proposal_id" ? "SKIP (stub has bill_details)" : `REFUSE (${onStub} row(s), no mechanical survivor rule)`;
          if (name !== "bill_details.proposal_id") refusals.push(name);
        } else if (rule === "drop") action = `drop ${onStub} (projection of the stub)`;
        else if (coll - ident > 0) {
          action = `REFUSE (${coll - ident} non-identical collision(s))`;
          refusals.push(name);
        } else action = `move ${onStub - ident}${ident > 0 ? `, drop ${ident} identical` : ""}`;
      }
      lines.push(`${name.padEnd(40)} stub ${String(onStub).padStart(3)}  holder ${String(onHolder).padStart(3)}  ${action}`);
    }
    const moved = !r.stub_exists && r.ref_on_holder;
    const plan = moved
      ? "SKIP — already repaired"
      : !r.ref_on_stub || !r.stub_exists || !r.holder_holds_key || r.holder_cg_refs > 0
        ? `SKIP — world moved (ref_on_stub ${r.ref_on_stub}, stub_exists ${r.stub_exists}, holder_holds_key ${r.holder_holds_key}, holder congress_gov refs ${r.holder_cg_refs})`
        : refusals.length > 0
          ? `REFUSE — ${refusals.join(", ")}`
          : "REPAIR — move the ref, the dependents as listed, retire the stub";
    console.log(`[fix1256] item ${n}/${m.items.length} b ${r.external_id}: ${plan}`);
    if (r.stub) {
      const newer = new Date(r.stub.updated_at) > new Date(r.holder.updated_at);
      console.log(`[fix1256]     stub   ${JSON.stringify(r.stub)}`);
      console.log(`[fix1256]     holder ${JSON.stringify(r.holder)}`);
      console.log(
        `[fix1256]     copy stub → holder: ${
          r.stub.vote_path_placeholder
            ? "no (the stub is a vote-path placeholder)"
            : newer
              ? "yes (stub updated_at is newer)"
              : "no (holder is as new or newer)"
        }`,
      );
    }
    for (const l of lines) console.log(`[fix1256]     ${l}`);
  }
}

// ── --apply ──────────────────────────────────────────────────────────────────
function caseBSql(i) {
  const s = "v_stub";
  const h = "v_holder";
  const k = i.bill_key;
  const refuse = (msg, ...args) => `RAISE EXCEPTION 'FIX1256|REFUSE|%|${msg}', v_xid${args.map((a) => `, ${a}`).join("")};`;
  const skip = (msg, ...args) => `RAISE NOTICE 'FIX1256|SKIP|%|${msg}', v_xid${args.map((a) => `, ${a}`).join("")}; RETURN;`;
  const depSteps = DEPENDENTS.filter((d) => !(d.table === "external_source_refs")).map((d) => {
    const name = depName(d);
    if (d.rule === "zero") {
      if (d.table === "bill_details") return ""; // a precondition, asserted above
      return `
  SELECT count(*) INTO v_n FROM public.${d.table} WHERE ${depPred(d, s)};
  IF v_n > 0 THEN ${refuse(`${name} has % row(s) on the stub — no mechanical survivor rule`, "v_n")} END IF;`;
    }
    if (d.rule === "drop") {
      return `
  DELETE FROM public.${d.table} WHERE ${depPred(d, s)};
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_log := v_log || format('${name} dropped %s; ', v_n); END IF;`;
    }
    const setCol = d.text ? `${d.col} = (${h})::text` : `${d.col} = ${h}`;
    if (d.key.length === 0) {
      return `
  UPDATE public.${d.table} SET ${setCol} WHERE ${depPred(d, s)};
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_log := v_log || format('${name} moved %s; ', v_n); END IF;`;
    }
    const join = `public.${d.table} h1 WHERE ${depPred(d, h, "h1")} AND ${d.key.map((c) => `h1.${c} = s1.${c}`).join(" AND ")}`;
    const same = `(to_jsonb(s1) - ARRAY['id','created_at','${d.col}']) = (to_jsonb(h1) - ARRAY['id','created_at','${d.col}'])`;
    return `
  SELECT count(*) INTO v_n FROM public.${d.table} s1
   WHERE ${depPred(d, s, "s1")} AND EXISTS (SELECT 1 FROM ${join} AND NOT ${same});
  IF v_n > 0 THEN ${refuse(`${name} has % row(s) on the stub colliding with a DIFFERENT row on the holder`, "v_n")} END IF;
  DELETE FROM public.${d.table} s1 WHERE ${depPred(d, s, "s1")} AND EXISTS (SELECT 1 FROM ${join} AND ${same});
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_log := v_log || format('${name} dropped %s identical; ', v_n); END IF;
  UPDATE public.${d.table} SET ${setCol} WHERE ${depPred(d, s)};
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_log := v_log || format('${name} moved %s; ', v_n); END IF;`;
  });
  const leftover = DEPENDENTS.map((d) => `${depCount(d, s)}`).join(" + ");
  const copyCols = ["title", "summary_plain", "status", "external_url", "last_action_at", "introduced_at", "metadata"];
  return `DO $fix1256$
DECLARE
  v_xid    text := ${lit(i.external_id)};
  v_ref    uuid := ${lit(i.ref_id)};
  v_stub   uuid := ${lit(i.ref_proposal_id)};
  v_holder uuid := ${lit(i.holder_proposal_id)};
  v_n      bigint;
  v_log    text := '';
  v_copied text := '';
  s public.proposals%ROWTYPE;
  h public.proposals%ROWTYPE;
BEGIN
  -- (i) preconditions, under row locks
  SELECT * INTO s FROM public.proposals WHERE id = v_stub FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = v_ref AND entity_id = v_holder AND external_id = v_xid) THEN
      ${skip("already repaired — the ref is on the holder % and the stub is gone", "v_holder")}
    END IF;
    ${skip("world moved — stub % is gone and the ref is not on the holder", "v_stub")}
  END IF;
  SELECT * INTO h FROM public.proposals WHERE id = v_holder FOR UPDATE;
  IF NOT FOUND THEN ${skip("world moved — holder % is gone", "v_holder")} END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = v_ref AND source = 'congress_gov'
                   AND entity_type = 'proposal' AND external_id = v_xid AND entity_id = v_stub) THEN
    ${skip("world moved — ref % no longer binds the stub", "v_ref")}
  END IF;
  IF EXISTS (SELECT 1 FROM public.bill_details WHERE proposal_id = v_stub) THEN
    ${skip("world moved — the stub now has a bill_details row")}
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bill_details WHERE proposal_id = v_holder AND jurisdiction_id = ${lit(k.jurisdiction_id)}
                   AND session = ${lit(k.session)} AND bill_number = ${lit(k.bill_number)}) THEN
    ${skip("world moved — the holder no longer holds the key")}
  END IF;
  IF EXISTS (SELECT 1 FROM public.external_source_refs WHERE source = 'congress_gov' AND entity_type = 'proposal' AND entity_id = v_holder) THEN
    ${skip("world moved — the holder has its own congress_gov ref; not case b")}
  END IF;

  -- (ii) the ref, then any other ref on the stub (unique is (source, external_id): nothing can collide)
  UPDATE public.external_source_refs SET entity_id = v_holder WHERE id = v_ref;
  UPDATE public.external_source_refs SET entity_id = v_holder WHERE entity_type = 'proposal' AND entity_id = v_stub;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_log := v_log || format('external_source_refs moved %s (+ ref %s); ', v_n, v_ref);

  -- (iii) dependents
${depSteps.join("\n")}

  -- (iv) the stub is the newer ingest of the same bill — unless the vote path
  -- minted it: votes.ts builds those args from the roll (title = the bill
  -- number, introduced_at = last_action_at = the roll's date, no latest_action
  -- in metadata), so nothing on such a row is newer truth about the bill.
  IF s.title = s.metadata->>'legacy_bill_number' THEN
    v_copied := 'nothing — the stub is a vote-path placeholder (title = the bill number)';
  ELSIF s.updated_at > h.updated_at THEN
${copyCols
  .map(
    (c) => `    IF s.${c} IS NOT NULL AND s.${c} IS DISTINCT FROM h.${c} THEN v_copied := v_copied || format('${c} %s -> %s; ', left(coalesce(h.${c}::text, 'NULL'), 60), left(s.${c}::text, 60)); END IF;`,
  )
  .join("\n")}
    UPDATE public.proposals SET
${copyCols.map((c) => `      ${c} = COALESCE(s.${c}, h.${c})`).join(",\n")}
     WHERE id = v_holder;
  END IF;

  -- (v) nothing may be left on the stub; then retire it
  SELECT ${leftover} INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'FIX1256|ERROR|%|% dependent row(s) still on the stub after the moves', v_xid, v_n;
  END IF;
  DELETE FROM public.proposals WHERE id = v_stub;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FIX1256|ERROR|%|deleted % stub rows, expected 1', v_xid, v_n; END IF;
  PERFORM public.refresh_primary_source_for_entities('proposal', ARRAY[v_holder]);

  -- (vi) the receipt
  RAISE NOTICE 'FIX1256|DONE|%|holder %|stub % retired|%|copied: %|at %',
    v_xid, v_holder, v_stub, v_log, CASE WHEN v_copied = '' THEN 'nothing' ELSE v_copied END, clock_timestamp();
END
$fix1256$;
`;
}

function caseASql(i) {
  const k = i.bill_key;
  return `DO $fix1256$
DECLARE
  v_xid    text := ${lit(i.external_id)};
  v_p      uuid := ${lit(i.proposal_id)};
  v_holder uuid;
BEGIN
  PERFORM 1 FROM public.proposals WHERE id = v_p FOR UPDATE;
  IF NOT FOUND THEN RAISE NOTICE 'FIX1256|SKIP|%|world moved — proposal % is gone', v_xid, v_p; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.bill_details WHERE proposal_id = v_p) THEN
    RAISE NOTICE 'FIX1256|SKIP|%|already landed — % has a bill_details row', v_xid, v_p; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_source_refs WHERE id = ${lit(i.ref_id)} AND entity_id = v_p AND external_id = v_xid) THEN
    RAISE NOTICE 'FIX1256|SKIP|%|world moved — the ref no longer binds %', v_xid, v_p; RETURN;
  END IF;
  SELECT proposal_id INTO v_holder FROM public.bill_details
   WHERE jurisdiction_id = ${lit(k.jurisdiction_id)} AND session = ${lit(k.session)} AND bill_number = ${lit(k.bill_number)};
  IF FOUND THEN
    RAISE EXCEPTION 'FIX1256|REFUSE|%|the key is held by % — this is case b, not a', v_xid, v_holder;
  END IF;
  INSERT INTO public.bill_details (proposal_id, bill_number, chamber, session, congress_number, congress_gov_url, jurisdiction_id)
  VALUES (v_p, ${lit(k.bill_number)}, ${lit(i.chamber)}, ${lit(k.session)}, ${Number(i.congress_number)}, ${lit(i.congress_gov_url)}, ${lit(k.jurisdiction_id)});
  RAISE NOTICE 'FIX1256|DONE|%|bill_details landed for % (% / % / %)|at %', v_xid, v_p, ${lit(k.session)}, ${lit(k.bill_number)}, ${lit(i.chamber)}, clock_timestamp();
END
$fix1256$;
`;
}

function apply() {
  const m = loadManifest();
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (TARGET === "prod" && claimant === null) {
    usage("--prod --apply runs only under a FIX-950 claim — run it as session:wait-for-gate:prod --then");
  }
  if (claimant !== null && /[\r\n\0]/.test(claimant)) usage("CIVITICS_PROD_SESSION_CLAIMANT must be one line");
  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\nSET application_name = 'fix1256-repair';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;

  console.log(`[fix1256] ${TARGET_LABEL} — WRITE: ${m.items.length} items from ${MANIFEST}${claimant ? `; claimant ${claimant}` : ""}`);
  console.log(`[fix1256] one DO statement per item (atomic), statement_timeout ${STATEMENT_TIMEOUT}; start ${new Date().toISOString()}`);
  const tally = { DONE: 0, SKIP: 0, REFUSE: 0 };
  let n = 0;
  for (const i of m.items) {
    n += 1;
    const t0 = Date.now();
    const res = psql(pre + (i.case === "b" ? caseBSql(i) : caseASql(i)));
    const ms = Date.now() - t0;
    const lines = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).filter((l) => l.includes("FIX1256|"));
    const tagged = lines.map((l) => l.slice(l.indexOf("FIX1256|")));
    const kind = tagged[0]?.split("|")[1] ?? null;
    if (res.status === 0 && (kind === "DONE" || kind === "SKIP")) {
      tally[kind] += 1;
      console.log(`[fix1256] item ${n}/${m.items.length} ${i.case} ${i.external_id} (${ms} ms): ${tagged[0]}`);
      continue;
    }
    if (res.status !== 0 && kind === "REFUSE") {
      tally.REFUSE += 1;
      console.log(`[fix1256] item ${n}/${m.items.length} ${i.case} ${i.external_id} (${ms} ms): ${tagged[0]} — rolled back`);
      continue;
    }
    process.stderr.write(res.stderr);
    console.error(
      `[fix1256] STOPPED at item ${n}/${m.items.length} ${i.external_id} (psql exit ${res.status}). Items 1..${n - 1} are committed; ` +
        "read why before re-running — a re-run skips what landed.",
    );
    console.log(`[fix1256] tally: done ${tally.DONE}, skipped ${tally.SKIP}, refused ${tally.REFUSE}`);
    process.exit(1);
  }
  console.log(`[fix1256] end ${new Date().toISOString()} — done ${tally.DONE}, skipped ${tally.SKIP}, refused ${tally.REFUSE}`);
  process.exit(tally.REFUSE > 0 ? 3 : 0);
}

// ── --seed-rehearsal / --unseed-rehearsal (local only) ───────────────────────
// The clone predates the 08-26 stubs: it has HR 9816 / 9847's holders with no
// ref and no stub. Seed each stub with PROD's id and prod's dependent shape
// (the ref, a rule tag identical to the holder's, a pending enrichment tag
// task, a search-index row), so the rehearsal moves and drops exactly what
// prod's apply will. Plus two FABRICATED pairs: HR 99001, whose stub and holder
// both carry an ai_summary_cache row of the same type with different text (the
// refusal fixture), and HR 99002, whose stub is a vote-path placeholder (title
// = the bill number, dates = a roll's) that must copy nothing. Unseed removes
// only the fabricated pairs.
const SEED = {
  pairs: [
    { xid: "119-HR-9816", stub: "a1675d57-ca42-4e6e-b5de-cbf1c2238db6", holder: "bb9d330b-f1c9-4f52-b107-217369a7ee0e" },
    { xid: "119-HR-9847", stub: "7969fc6c-6703-4b06-800f-66495d900046", holder: "221255d4-f435-423a-ac29-eb243033df4d" },
  ],
  fabricated: [
    { xid: "119-HR-99001", stub: "f1256000-0000-4000-8000-00000000b001", holder: "f1256000-0000-4000-8000-00000000a001", summaryCollision: true },
    { xid: "119-HR-99002", stub: "f1256000-0000-4000-8000-00000000b002", holder: "f1256000-0000-4000-8000-00000000a002", placeholderStub: true },
  ],
};

function seedPairSql({ xid, stub, holder, summaryCollision = false, placeholderStub = false }, { fabricateHolder = false } = {}) {
  const [, , num] = xid.split("-");
  const stubOverrides = placeholderStub
    ? `'title', 'HR ${num}', 'introduced_at', '2026-09-03', 'last_action_at', '2026-09-03', 'status', 'passed_chamber',
       'metadata', jsonb_build_object('legacy_bill_number', 'HR ${num}', 'legacy_session', '119', 'legacy_congress_num', 119)`
    : `'introduced_at', '2026-07-21', 'summary_plain', 'FIX-1256 rehearsal: the stub carries the newer summary'`;
  return `
DO $seed$
BEGIN
  IF EXISTS (SELECT 1 FROM public.proposals WHERE id = ${lit(stub)}) THEN RAISE NOTICE 'FIX1256|SEED|%|already seeded', ${lit(xid)}; RETURN; END IF;
  ${
    fabricateHolder
      ? `INSERT INTO public.proposals SELECT (jsonb_populate_record(NULL::public.proposals,
           to_jsonb(p) || jsonb_build_object('id', ${lit(holder)}, 'title', 'FIX-1256 rehearsal fixture ${num} (holder)',
             'external_url', 'https://congress.gov/bill/119th-congress/house-bill/${num}',
             'metadata', jsonb_build_object('latest_action', 'Referred to committee.', 'legacy_bill_number', 'HR ${num}', 'legacy_session', '119', 'legacy_congress_num', 119),
             'created_at', now() - interval '60 days', 'updated_at', now() - interval '60 days'))).*
         FROM public.proposals p WHERE p.id = ${lit(SEED.pairs[0].holder)};
       INSERT INTO public.bill_details (proposal_id, bill_number, chamber, session, congress_number, congress_gov_url, jurisdiction_id)
       SELECT ${lit(holder)}, 'HR ${num}', 'house', '119', 119, 'https://congress.gov/bill/119th-congress/house-bill/${num}', jurisdiction_id
         FROM public.proposals WHERE id = ${lit(holder)};`
      : ""
  }
  IF EXISTS (SELECT 1 FROM public.external_source_refs WHERE source = 'congress_gov' AND external_id = ${lit(xid)} AND entity_id = ${lit(holder)}) THEN
    RAISE NOTICE 'FIX1256|SEED|%|already repaired on this clone — not re-seeded', ${lit(xid)}; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.external_source_refs WHERE source = 'congress_gov' AND external_id = ${lit(xid)}) THEN
    RAISE EXCEPTION 'FIX1256|SEED|%|the clone already has this ref elsewhere — not the prod shape', ${lit(xid)};
  END IF;
  INSERT INTO public.proposals SELECT (jsonb_populate_record(NULL::public.proposals,
    to_jsonb(p) || jsonb_build_object('id', ${lit(stub)}, 'created_at', now() - interval '30 days', 'updated_at', now() - interval '20 days',
      ${stubOverrides}))).*
    FROM public.proposals p WHERE p.id = ${lit(holder)};
  INSERT INTO public.external_source_refs (source, external_id, entity_type, entity_id, source_url, metadata)
  VALUES ('congress_gov', ${lit(xid)}, 'proposal', ${lit(stub)}, 'https://congress.gov/bill/119th-congress/house-bill/${num}', '{}');
  INSERT INTO public.entity_tags (entity_type, entity_id, tag, tag_category, display_label, generated_by, confidence, visibility, metadata)
  VALUES ('proposal', ${lit(holder)}, 'national', 'scope', 'National Scope', 'rule', 1.00, 'secondary', '{"proposal_type": "bill"}')
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;
  INSERT INTO public.entity_tags (entity_type, entity_id, tag, tag_category, display_label, display_icon, visibility, generated_by, confidence, ai_model, pipeline_version, metadata)
  SELECT entity_type, ${lit(stub)}, tag, tag_category, display_label, display_icon, visibility, generated_by, confidence, ai_model, pipeline_version, metadata
    FROM public.entity_tags WHERE entity_type = 'proposal' AND entity_id = ${lit(holder)} AND tag = 'national' AND tag_category = 'scope';
  INSERT INTO public.enrichment_queue (entity_id, entity_type, task_type, status, context)
  VALUES (${lit(stub)}, 'proposal', 'tag', 'pending', '{"title": "FIX-1256 rehearsal"}');
  INSERT INTO public.entity_search_index (kind, entity_id, display_name)
  VALUES ('proposal', ${lit(stub)}, 'FIX-1256 rehearsal stub') ON CONFLICT DO NOTHING;
  ${
    summaryCollision
      ? `INSERT INTO public.ai_summary_cache (entity_type, entity_id, summary_type, summary_text, model)
         VALUES ('proposal', ${lit(holder)}, 'plain_language', 'holder summary', 'rehearsal'),
                ('proposal', ${lit(stub)}, 'plain_language', 'a DIFFERENT stub summary', 'rehearsal');`
      : ""
  }
  RAISE NOTICE 'FIX1256|SEED|%|stub % beside holder %', ${lit(xid)}, ${lit(stub)}, ${lit(holder)};
END
$seed$;`;
}

function seed() {
  const sql = [
    ...SEED.pairs.map((p) => seedPairSql(p)),
    ...SEED.fabricated.map((p) => seedPairSql(p, { fabricateHolder: true })),
  ].join("\n");
  const res = psql(sql);
  for (const l of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) if (l.includes("FIX1256|")) console.log(`[fix1256] ${l.slice(l.indexOf("FIX1256|"))}`);
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    process.exit(1);
  }
}

function unseed() {
  const ids = SEED.fabricated.flatMap((f) => [f.stub, f.holder]).map(lit).join(", ");
  const xids = SEED.fabricated.map((f) => lit(f.xid)).join(", ");
  const res = psql(`
BEGIN;
DELETE FROM public.ai_summary_cache WHERE entity_type = 'proposal' AND entity_id IN (${ids});
DELETE FROM public.entity_tags WHERE entity_type = 'proposal' AND entity_id IN (${ids});
DELETE FROM public.enrichment_queue WHERE entity_type = 'proposal' AND entity_id IN (${ids});
DELETE FROM public.entity_search_index WHERE kind = 'proposal' AND entity_id IN (${ids});
DELETE FROM public.external_source_refs WHERE source = 'congress_gov' AND external_id IN (${xids});
DELETE FROM public.proposals WHERE id IN (${ids});
COMMIT;
SELECT 'FIX1256|UNSEED|' || ${lit(SEED.fabricated.map((f) => f.xid).join(","))} || '|fabricated pairs removed';`);
  for (const l of res.stdout.split(/\r?\n/)) if (l.includes("FIX1256|")) console.log(`[fix1256] ${l}`);
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    process.exit(1);
  }
}

if (MODE === "--build-manifest") buildManifest();
else if (MODE === "--dry-run") dryRun();
else if (MODE === "--apply") apply();
else if (MODE === "--seed-rehearsal") seed();
else unseed();
