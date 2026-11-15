/**
 * FIX-1409 — an official → bill vote edge comes from the member's latest FINAL
 * roll on the bill (else an advance roll, at 0.250), ordered by roll number
 * inside a day; _votes_full() is a merge. cc-283,
 * `20261117000000_fix1409_vote_edge_question_rule.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1409-vote-edge-rule.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - vote_question_class()'s literals ARE passage-questions.json's five keys,
 *     as sets per tier; vote_roll_class()'s shape regex IS FEDERAL_ROLL_CALL_ID;
 *   - D6: the edge rule (SELECT DISTINCT ON … v.id DESC) is character-identical
 *     in both arms but for the incremental arm's INNER JOIN line pair;
 *   - the incremental arm is 20260905000100's body with only that SELECT and
 *     its two comment lines changed; _votes_full() keeps the live DECLARE
 *     head, watermark write and returned rows;
 *   - no SET on any of the four; the helpers are LANGUAGE sql IMMUTABLE
 *     PARALLEL SAFE; grants as the live file states them; the file writes and
 *     drops nothing outside the bodies;
 *   - the revert is the live bodies verbatim, with no SET, and drops nothing.
 * Clone tests (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK:
 *   - the live bodies are this file's, proconfig NULL;
 *   - vote_roll_class() ≡ voteQuestionClass() on every distinct
 *     (vote_question, roll_call_id) of the clone;
 *   - after _votes_full() the vote edges equal an independent SELECT of the
 *     rule (the JSON's lists, a row_number() pick), EXCEPT ALL both ways 0/0;
 *     from a perturbed state (100 retyped pairs, 400 changed values, 100
 *     deleted edges, 50 orphans) the NOTICE counts are exact and no statement
 *     meets the unique key; a second call writes 0 rows;
 *   - a dirty set made by bumping updated_at on ten rolls' votes: the
 *     incremental arm leaves those pairs equal to the full set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";
import passageQuestions from "../pipelines/congress/passage-questions.json";
import { FEDERAL_ROLL_CALL_ID, voteQuestionClass } from "../pipelines/congress/bill-status";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261117000000_fix1409_vote_edge_question_rule.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const LIVE = () => read(path.join(MIGRATIONS, "20260905000100_fix1139_votes_watermark_horizon.sql"));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1409-revert-vote-edge-question-rule.sql"));

const SIG_INCR = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()";
const SIG_FULL = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()";
const SIG_QCLASS = "CREATE OR REPLACE FUNCTION public.vote_question_class(p_vote_question text)";
const SIG_RCLASS = "CREATE OR REPLACE FUNCTION public.vote_roll_class(p_vote_question text, p_roll_call_id text)";

/** md5(prosrc) of the bodies this file installs: what the push's read-back prints. */
const INCR_MD5 = "efb7d5f628a1439c23f7be23b20bf9a4";
const FULL_MD5 = "0c9c5fa64e8331fe38c733ecca5b03a4";
/** md5(prosrc) of the live bodies (clone and prod, cc-283 read 3). */
const LIVE_INCR_MD5 = "4e34295bee6f343f78800e82a58404de";
const LIVE_FULL_MD5 = "584de460d563ff8531cd37161d26a361";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const RULE_START = "    SELECT DISTINCT ON (v.official_id, v.bill_proposal_id)";
const RULE_END = "      v.id DESC";
const OLD_RULE_END = "v.id DESC";
const JOIN_LINES =
  "    INNER JOIN _dirty_vote_keys d\n      ON d.official_id = v.official_id AND d.bill_proposal_id = v.bill_proposal_id\n";

/** The edge rule's SELECT inside a body: from SELECT DISTINCT ON to the `id DESC` that ends its ORDER BY. */
function rule(src: string, end = RULE_END): string {
  const a = src.indexOf(RULE_START);
  assert.notEqual(a, -1, "no SELECT DISTINCT ON");
  const b = src.indexOf(end, a);
  assert.notEqual(b, -1, `no ${end} after the SELECT`);
  assert.equal(src.indexOf(RULE_START, a + 1), -1, "one edge rule per body");
  return src.slice(a, b + end.length);
}

/** The tier literals of vote_question_class(): literal → tier. */
function literals(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [, lit, tier] of body(FILE(), SIG_QCLASS).matchAll(/WHEN '((?:[^']|'')*)' THEN '(final|advance)'/g)) {
    const q = (lit as string).replace(/''/g, "'");
    assert.ok(!m.has(q), `literal listed twice: ${q}`);
    m.set(q, tier as string);
  }
  return m;
}

const FINAL = new Set([
  ...passageQuestions.house, ...passageQuestions.senate, ...passageQuestions.nomination, ...passageQuestions.veto_override,
]);
const ADVANCE = new Set(passageQuestions.advance);

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("D1–D3: vote_question_class()'s literals are the JSON's five keys, as sets per tier", () => {
  const lits = literals();
  const sql = (tier: string) => new Set([...lits].filter(([, t]) => t === tier).map(([q]) => q));
  assert.deepEqual([...sql("final")].sort(), [...FINAL].sort());
  assert.deepEqual([...sql("advance")].sort(), [...ADVANCE].sort());
  for (const q of ADVANCE) assert.ok(!FINAL.has(q), `${q} in two tiers`);
  const code = body(FILE(), SIG_QCLASS);
  // The normalisation isPassageQuestion() applies, in sqlIsPassage's spelling, evaluated once.
  assert.ok(code.includes("SELECT CASE lower(regexp_replace(btrim(coalesce($1, '')), '\\s+', ' ', 'g'))"));
  assert.match(code, /ELSE 'other'\s+END\s*$/);
});

test("D9: vote_roll_class()'s shape regex is FEDERAL_ROLL_CALL_ID; any other id is final", () => {
  const code = body(FILE(), SIG_RCLASS);
  const m = code.match(/WHEN \$2 ~ '([^']+)' THEN public\.vote_question_class\(\$1\)\s+ELSE 'final'/);
  assert.ok(m, "the shape test");
  assert.equal(m[1], FEDERAL_ROLL_CALL_ID.source);
});

test("the helpers inline: LANGUAGE sql, IMMUTABLE, PARALLEL SAFE, no SET, not STRICT, not SECURITY DEFINER", () => {
  for (const sig of [SIG_QCLASS, SIG_RCLASS]) {
    const h = header(FILE(), sig);
    assert.match(h, /\nLANGUAGE sql\nIMMUTABLE\nPARALLEL SAFE\n$/, sig);
    assert.doesNotMatch(h, /\bSET\b|STRICT|SECURITY DEFINER|RETURNS NULL ON NULL INPUT/i, sig);
  }
});

test("D6: the edge rule is character-identical in both arms but for the INNER JOIN line pair", () => {
  const incr = rule(body(FILE(), SIG_INCR));
  const full = rule(body(FILE(), SIG_FULL));
  assert.ok(incr.includes(JOIN_LINES));
  assert.equal(incr.replace(JOIN_LINES, ""), full);
  // D2 + D4 in the text: the tier filter, final before advance, then the day, the roll number, the id.
  assert.ok(full.includes("AND public.vote_roll_class(v.vote_question, v.roll_call_id) IN ('final', 'advance')"));
  assert.match(
    full,
    /ORDER BY v\.official_id, v\.bill_proposal_id,\n[\s\S]*?WHEN 'final' THEN 0\.500\n\s+ELSE 0\.250\n\s+END\)::numeric\(4,3\) DESC,\n\s+v\.voted_at DESC NULLS LAST,\n[^\n]*\n\s+substring\(v\.roll_call_id FROM '\(\[0-9\]\+\)\$'\)::numeric DESC NULLS LAST,\n\s+v\.id DESC$/,
  );
  // D5: no metadata; evidence is the deciding vote, occurred_at its date.
  assert.ok(full.includes("      v.voted_at::date,\n      1, 'votes', ARRAY[v.id]\n"));
  assert.doesNotMatch(full, /metadata/);
});

test("the incremental arm is the live body with only the edge rule (and its two comment lines) changed", () => {
  const live = body(LIVE(), SIG_INCR);
  const now = body(FILE(), SIG_INCR);
  const comment =
    "  -- FIX-1409 — the edge rule (D1–D4, D9). This SELECT is character-identical\n" +
    "  -- to _votes_full()'s but for the INNER JOIN line pair; a test holds it.\n";
  assert.ok(now.includes(comment));
  const back = now.replace(comment, "").replace(rule(now), rule(live, OLD_RULE_END));
  assert.equal(back, live);
  assert.equal(md5(live), LIVE_INCR_MD5);
  assert.equal(md5(now), INCR_MD5);
});

test("_votes_full() keeps the live DECLARE head, watermark write and returned rows; the merge's four steps", () => {
  const live = body(LIVE(), SIG_FULL);
  const now = body(FILE(), SIG_FULL);
  assert.equal(md5(live), LIVE_FULL_MD5);
  assert.equal(md5(now), FULL_MD5);
  const head = "\n#variable_conflict use_column\nDECLARE\n  v_vote_yes     BIGINT;\n  v_vote_no      BIGINT;\n  v_vote_abstain BIGINT;\n";
  assert.ok(live.startsWith(head) && now.startsWith(head));
  const tail = (s: string) => s.slice(s.indexOf("  -- FIX-1139: the horizon, not NOW()."));
  assert.ok(tail(live).length > 200);
  assert.equal(tail(now), tail(live));
  const code = stripComments(now);
  // D7, in order: absent pairs, retypes, value changes, the missing rows.
  const at = (needle: string) => {
    const i = code.indexOf(needle);
    assert.notEqual(i, -1, needle);
    return i;
  };
  const order = [
    at("WITH gone AS (\n    DELETE FROM public.entity_connections ec"),
    at("WITH replaced AS (\n    DELETE FROM public.entity_connections ec"),
    at("WITH changed AS (\n    UPDATE public.entity_connections ec"),
    at("WITH added AS (\n    INSERT INTO public.entity_connections ("),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(code.split("ec.evidence_source = 'votes'").length - 1, 4, "every step scoped to the arm's own source");
  assert.ok(code.includes("AND ec.connection_type <> s.connection_type"), "retype = delete the other-typed row");
  assert.match(code, /\(ec\.strength\s+IS DISTINCT FROM s\.strength\s+OR ec\.occurred_at\s+IS DISTINCT FROM s\.occurred_at\s+OR ec\.evidence_ids IS DISTINCT FROM s\.evidence_ids\)/);
  // No key column is ever UPDATEd: the SET list is the three values and derived_at.
  const set = code.slice(code.indexOf("       SET strength"), code.indexOf("      FROM _vote_edge_set s", code.indexOf("       SET strength")));
  assert.doesNotMatch(set, /connection_type|from_id|to_id|from_type|to_type/);
  assert.ok(code.includes("RAISE NOTICE '[votes_full] merge: deleted % / retyped % / updated % / inserted % / untouched %'"));
  assert.ok(code.includes("DROP TABLE _vote_edge_set;"), "a second call in one transaction can rebuild it");
  assert.doesNotMatch(code, /DELETE FROM public\.entity_connections\s+WHERE entity_connections\.connection_type/, "no delete-all");
});

test("no SET on any of the four; grants as the live file states them; nothing written or dropped outside the bodies", () => {
  const src = FILE();
  for (const sig of [SIG_INCR, SIG_FULL]) {
    const h = header(src, sig);
    assert.match(h, /\n LANGUAGE plpgsql\n$/, sig);
    assert.doesNotMatch(h, /\bSET\b/, sig);
  }
  for (const fn of ["rebuild_entity_connections_votes()", "rebuild_entity_connections_votes_full()"]) {
    assert.ok(src.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`), fn);
    assert.ok(src.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`), fn);
    assert.ok(LIVE().includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`), fn);
  }
  for (const fn of ["vote_question_class(text)", "vote_roll_class(text, text)"]) {
    assert.ok(src.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`), fn);
    assert.ok(src.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`), fn);
  }
  const sql = stripComments(src);
  assert.deepEqual(
    [...sql.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE|VIEW) public\.(\w+)/g)].map((m) => m[1]),
    ["vote_question_class", "vote_roll_class", "rebuild_entity_connections_votes", "rebuild_entity_connections_votes_full"],
  );
  const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|CREATE INDEX)/i);
  assert.doesNotMatch(outside, /job_registry|cron\.|platform_dials/);
});

test("the revert is the two live bodies verbatim, with no SET, and drops nothing", () => {
  const rev = REVERT();
  assert.equal(body(rev, SIG_INCR), body(LIVE(), SIG_INCR));
  assert.equal(body(rev, SIG_FULL), body(LIVE(), SIG_FULL));
  for (const sig of [SIG_INCR, SIG_FULL]) assert.doesNotMatch(header(rev, sig), /\bSET\b/, sig);
  const code = stripComments(rev);
  assert.doesNotMatch(code.replace(/AS \$function\$[\s\S]*?\$function\$/g, ""), /\bDROP\b/i);
  assert.match(rev, /It DROPS NOTHING/);
  for (const fn of ["rebuild_entity_connections_votes()", "rebuild_entity_connections_votes_full()"]) {
    assert.ok(rev.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`), fn);
  }
});

test("the migration lands after 20261116000000 and is the newest to define the vote arms", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf(FILE_NAME);
  assert.ok(at > 0);
  assert.ok(all[at - 1]! >= "20261116000000", all[at - 1]);
  const definers = all.filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG_INCR));
  assert.equal(definers[definers.length - 1], FILE_NAME);
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const VOTE_TYPES = "('vote_yes', 'vote_no', 'vote_abstain')";
const EC_COLS =
  "from_type, from_id, to_type, to_id, connection_type, strength, occurred_at, evidence_count, evidence_source, evidence_ids";

/**
 * The rule, written independently of the body: the JSON's lists (not
 * vote_question_class), the TS shape regex, and a row_number() pick (not
 * DISTINCT ON). Tier 1 = final, 2 = advance; a federal roll whose question is
 * in no list has no tier and decides nothing.
 */
function expectedSql(): string {
  const values = [
    ...[...FINAL].map((q) => `(${lit(q)}, 1)`),
    ...[...ADVANCE].map((q) => `(${lit(q)}, 2)`),
  ].join(",\n    ");
  return `
WITH q(norm, tier) AS (VALUES
    ${values}),
r AS (
  SELECT v.id, v.official_id, v.bill_proposal_id, v.vote, v.voted_at, v.roll_call_id,
         CASE WHEN v.roll_call_id ~ ${lit(FEDERAL_ROLL_CALL_ID.source)} THEN q.tier ELSE 1 END AS tier
    FROM public.votes v
    LEFT JOIN q ON q.norm = lower(regexp_replace(btrim(coalesce(v.vote_question, '')), '\\s+', ' ', 'g'))
   WHERE v.vote IN ('yes', 'no', 'abstain')
),
ranked AS (
  SELECT r.*, row_number() OVER (
           PARTITION BY r.official_id, r.bill_proposal_id
           ORDER BY r.tier, r.voted_at DESC,
                    (substring(r.roll_call_id FROM '([0-9]+)$'))::numeric DESC NULLS LAST,
                    r.id DESC) AS rk
    FROM r WHERE r.tier IS NOT NULL
)
SELECT 'official'::text AS from_type, official_id AS from_id, 'proposal'::text AS to_type, bill_proposal_id AS to_id,
       ('vote_' || vote)::public.connection_type AS connection_type,
       (CASE tier WHEN 1 THEN 0.500 ELSE 0.250 END)::numeric(4,3) AS strength,
       voted_at::date AS occurred_at, 1 AS evidence_count, 'votes'::text AS evidence_source, ARRAY[id] AS evidence_ids
  FROM ranked WHERE rk = 1`;
}

/** The vote edges (every source) against the expected set: [ec − expected, expected − ec]. */
async function diff(c: Client, scope = "TRUE"): Promise<[number, number]> {
  const ec = `SELECT ${EC_COLS} FROM public.entity_connections WHERE connection_type IN ${VOTE_TYPES} AND ${scope}`;
  const ex = `SELECT ${EC_COLS} FROM _fix1409_expected WHERE ${scope}`;
  const n = async (sql: string) => (await c.query(`SELECT count(*)::int AS n FROM (${sql}) x`)).rows[0].n as number;
  return [await n(`${ec} EXCEPT ALL ${ex}`), await n(`${ex} EXCEPT ALL ${ec}`)];
}

/** _votes_full()'s NOTICE, parsed. */
async function merge(c: Client): Promise<{ deleted: number; retyped: number; updated: number; inserted: number; untouched: number }> {
  const notices: string[] = [];
  const on = (n: { message?: string }) => notices.push(n.message ?? "");
  c.on("notice", on);
  try {
    await c.query("SELECT * FROM public.rebuild_entity_connections_votes_full()");
  } finally {
    c.off("notice", on);
  }
  const line = notices.find((m) => m.startsWith("[votes_full] merge:"));
  assert.ok(line, `no merge NOTICE in ${JSON.stringify(notices)}`);
  const m = line.match(/deleted (\d+) \/ retyped (\d+) \/ updated (\d+) \/ inserted (\d+) \/ untouched (\d+)$/);
  assert.ok(m, line);
  const [deleted, retyped, updated, inserted, untouched] = m.slice(1).map(Number) as [number, number, number, number, number];
  return { deleted, retyped, updated, inserted, untouched };
}

test("clone: the live bodies are this file's; proconfig NULL on all four", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows } = await c.query(
      `SELECT p.proname, md5(p.prosrc) AS m, p.proconfig AS cfg, p.provolatile AS vol
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('rebuild_entity_connections_votes', 'rebuild_entity_connections_votes_full',
                            'vote_question_class', 'vote_roll_class')
        ORDER BY 1`,
    );
    assert.equal(rows.length, 4);
    const by = Object.fromEntries(rows.map((r) => [r.proname, r]));
    assert.equal(by.rebuild_entity_connections_votes.m, INCR_MD5);
    assert.equal(by.rebuild_entity_connections_votes_full.m, FULL_MD5);
    for (const r of rows) assert.equal(r.cfg, null, r.proname);
    assert.equal(by.vote_question_class.vol, "i");
    assert.equal(by.vote_roll_class.vol, "i");
  } finally {
    await c.end();
  }
});

test("clone: vote_roll_class() ≡ voteQuestionClass() on every distinct (vote_question, roll_call_id)", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows } = await c.query(
      `SELECT vote_question AS q, roll_call_id AS id, public.vote_roll_class(vote_question, roll_call_id) AS cls
         FROM (SELECT DISTINCT vote_question, roll_call_id FROM public.votes) d`,
    );
    assert.ok(rows.length > 1000, `${rows.length} rolls`);
    const seen = new Set<string>();
    for (const r of rows) {
      assert.equal(r.cls, voteQuestionClass(r.q, r.id), `${JSON.stringify(r.q)} @ ${r.id}`);
      seen.add(r.cls);
    }
    assert.deepEqual([...seen].sort(), ["advance", "final", "other"]);
  } finally {
    await c.end();
  }
});

test("clone: _votes_full() is a merge — equal to the rule 0/0, exact counts from a perturbed state, then 0 written", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '15min'");
      await c.query(`CREATE TEMP TABLE _fix1409_expected ON COMMIT DROP AS ${expectedSql()}`);
      const n: number = (await c.query("SELECT count(*)::int AS n FROM _fix1409_expected")).rows[0].n;
      assert.ok(n > 100_000, `${n} expected edges`);

      // From whatever state the clone holds, one merge lands the rule.
      await merge(c);
      assert.deepEqual(await diff(c), [0, 0]);

      // Perturb disjoint slices (by md5(id)), each a different merge path.
      await c.query(`CREATE TEMP TABLE _fix1409_slices ON COMMIT DROP AS
        SELECT id, strength, ntile(1000) OVER (ORDER BY md5(id::text)) AS b
          FROM public.entity_connections WHERE connection_type IN ${VOTE_TYPES} AND evidence_source = 'votes'`);
      const slice = async (sql: string, from: number, cond = "TRUE") =>
        (await c.query(`${sql} WHERE id IN (SELECT id FROM _fix1409_slices WHERE b >= ${from} AND ${cond} ORDER BY b, id LIMIT 100)`)).rowCount;
      // retype: the pair keeps an edge under the other type — the merge must not meet the unique key
      assert.equal(await slice(`UPDATE public.entity_connections SET connection_type =
        (CASE connection_type WHEN 'vote_yes' THEN 'vote_no' ELSE 'vote_yes' END)::public.connection_type`, 1), 100);
      // value changes, one per column (and the advance → final strength)
      assert.equal(await slice("UPDATE public.entity_connections SET strength = 0.500", 200, "strength = 0.250"), 100);
      assert.equal(await slice("UPDATE public.entity_connections SET strength = 0.250", 300, "strength = 0.500"), 100);
      assert.equal(await slice("UPDATE public.entity_connections SET occurred_at = occurred_at - 1", 400), 100);
      assert.equal(await slice("UPDATE public.entity_connections SET evidence_ids = '{}'", 500), 100);
      // missing edges
      assert.equal(await slice("DELETE FROM public.entity_connections", 600), 100);
      // orphans: an edge for an (official, proposal) pair with no vote row
      const orphans = await c.query(`INSERT INTO public.entity_connections (${EC_COLS})
        SELECT 'official', o.id, 'proposal', p.id, 'vote_yes', 0.500, CURRENT_DATE, 1, 'votes', '{}'
          FROM (SELECT id FROM public.officials ORDER BY id LIMIT 20) o
         CROSS JOIN (SELECT id FROM public.proposals ORDER BY id LIMIT 20) p
         WHERE NOT EXISTS (SELECT 1 FROM public.votes v WHERE v.official_id = o.id AND v.bill_proposal_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM public.entity_connections e WHERE e.from_type = 'official' AND e.from_id = o.id
                             AND e.to_type = 'proposal' AND e.to_id = p.id AND e.connection_type IN ${VOTE_TYPES})
         LIMIT 50`);
      assert.equal(orphans.rowCount, 50);
      const [extra, missing] = await diff(c);
      assert.equal(extra, 100 + 400 + 50, "retyped + changed + orphans");
      assert.equal(missing, 100 + 400 + 100, "retyped + changed + deleted");

      const counts = await merge(c);
      assert.deepEqual(counts, { deleted: 50, retyped: 100, updated: 400, inserted: 100, untouched: n - 600 });
      assert.deepEqual(await diff(c), [0, 0]);

      // A second merge writes nothing.
      assert.deepEqual(await merge(c), { deleted: 0, retyped: 0, updated: 0, inserted: 0, untouched: n });
      const per: Record<string, number> = Object.fromEntries(
        (await c.query("SELECT * FROM public.rebuild_entity_connections_votes_full()")).rows.map((r) => [r.connection_type, Number(r.edges_upserted)]),
      );
      const exp: Record<string, number> = Object.fromEntries(
        (await c.query("SELECT connection_type::text AS t, count(*)::int AS n FROM _fix1409_expected GROUP BY 1")).rows.map((r) => [r.t, r.n]),
      );
      assert.deepEqual(per, { vote_yes: exp.vote_yes ?? 0, vote_no: exp.vote_no ?? 0, vote_abstain: exp.vote_abstain ?? 0 });
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the incremental arm, on a dirty set of ten rolls' votes, leaves those pairs equal to the full set", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '15min'");
      await c.query(`CREATE TEMP TABLE _fix1409_expected ON COMMIT DROP AS ${expectedSql()}`);
      await merge(c);
      assert.deepEqual(await diff(c), [0, 0]);

      // Ten rolls, among them a same-day multi-roll Senate day; their votes become the dirty set.
      await c.query(`CREATE TEMP TABLE _fix1409_rolls ON COMMIT DROP AS
        SELECT roll_call_id FROM (SELECT DISTINCT roll_call_id FROM public.votes WHERE chamber IN ('House', 'Senate')) r
         ORDER BY md5(roll_call_id) LIMIT 10`);
      await c.query(`CREATE TEMP TABLE _fix1409_pairs ON COMMIT DROP AS
        SELECT DISTINCT official_id, bill_proposal_id FROM public.votes WHERE roll_call_id IN (SELECT roll_call_id FROM _fix1409_rolls)`);
      const pairs: number = (await c.query("SELECT count(*)::int AS n FROM _fix1409_pairs")).rows[0].n;
      assert.ok(pairs > 500, `${pairs} pairs`);
      const inPairs = "(from_id, to_id) IN (SELECT official_id, bill_proposal_id FROM _fix1409_pairs)";

      // Their edges go back to junk: every type flipped, every strength 0.500, the evidence emptied.
      const flipped = await c.query(`UPDATE public.entity_connections SET
          connection_type = (CASE connection_type WHEN 'vote_yes' THEN 'vote_no' ELSE 'vote_yes' END)::public.connection_type,
          strength = 0.500, evidence_ids = '{}'
        WHERE connection_type IN ${VOTE_TYPES} AND ${inPairs}`);
      assert.ok((flipped.rowCount ?? 0) > 100);
      const [extra] = await diff(c, inPairs);
      assert.equal(extra, flipped.rowCount);

      // The watermark just below now(), no head lag, and the ten rolls' rows stamped now() by the trigger.
      await c.query("SET LOCAL civitics.watermark_lag_seconds = '0'");
      await c.query(`UPDATE public.pipeline_state SET value = jsonb_build_object('last_indexed_at', (now() - interval '1 second')::text)
        WHERE key = 'entity_connections_votes'`);
      const bumped = await c.query("UPDATE public.votes SET updated_at = updated_at WHERE roll_call_id IN (SELECT roll_call_id FROM _fix1409_rolls)");
      assert.ok((bumped.rowCount ?? 0) > 500);

      const { rows } = await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      const upserted = rows.reduce((s, r) => s + Number(r.edges_upserted), 0);
      const want: number = (await c.query(`SELECT count(*)::int AS n FROM _fix1409_expected WHERE ${inPairs}`)).rows[0].n;
      assert.equal(upserted, want);
      assert.deepEqual(await diff(c, inPairs), [0, 0]);
      assert.deepEqual(await diff(c), [0, 0], "and nothing outside the dirty set moved");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
