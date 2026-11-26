/**
 * FIX-1422 — a vote whose (official, bill) pair moves, or whose row is deleted,
 * retires its old edge: the votes triggers capture the OLD pair in
 * public.vote_edge_stale_pairs and rebuild_entity_connections_votes() consumes
 * it into its dirty set. `20261126006000_fix1422_vote_edge_stale_pairs.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1422-vote-edge-stale-pairs.test.ts
 *            CIVITICS_CLONE_TESTS=1 for the clone half (each case rolls back).
 *
 * Text half (CI): the arm is 20261117000000's body plus four named hunks, its
 * edge rule still character-identical to _votes_full()'s but for the INNER JOIN
 * pair; the capture has no EXCEPTION block and no SET; the two triggers' WHENs;
 * the revert drops exactly the two triggers and restores the prior body.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261126006000_fix1422_vote_edge_stale_pairs.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const PRIOR = () => read(path.join(MIGRATIONS, "20261117000000_fix1409_vote_edge_question_rule.sql"));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1422-revert-vote-edge-stale-pairs.sql"));

const SIG_INCR = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()";
const SIG_FULL = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()";
const SIG_CAP = "CREATE OR REPLACE FUNCTION public.capture_vote_edge_stale_pair()";

const PRIOR_MD5 = "efb7d5f628a1439c23f7be23b20bf9a4";
const INCR_MD5 = "76bce60cc492db5465f6c1e1c970de91";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const RULE_START = "    SELECT DISTINCT ON (v.official_id, v.bill_proposal_id)";
const RULE_END = "      v.id DESC";
const JOIN_LINES =
  "    INNER JOIN _dirty_vote_keys d\n      ON d.official_id = v.official_id AND d.bill_proposal_id = v.bill_proposal_id\n";

function rule(src: string): string {
  const a = src.indexOf(RULE_START);
  assert.notEqual(a, -1, "no SELECT DISTINCT ON");
  const b = src.indexOf(RULE_END, a);
  assert.notEqual(b, -1, "no v.id DESC after the SELECT");
  assert.equal(src.indexOf(RULE_START, a + 1), -1, "one edge rule per body");
  return src.slice(a, b + RULE_END.length);
}

// The four hunks, exactly as the file adds them: removing them gives back the prior body.
const WRITE =
  "INSERT INTO public.pipeline_state (key, value)\n" +
  "VALUES (\n" +
  "  'entity_connections_votes',\n" +
  "  jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)\n" +
  ")\n" +
  "ON CONFLICT (key) DO UPDATE\n" +
  "  SET value = EXCLUDED.value, updated_at = NOW();\n";
const indent = (s: string, n: number) => s.replace(/^(?=.)/gm, " ".repeat(n));
const FORWARD = (n: number) =>
  `${" ".repeat(n)}-- FIX-1422: forward only (a capture-only cycle leaves it where it was).\n` +
  `${" ".repeat(n)}IF v_new_max_updated_at > v_last_indexed_at THEN\n` +
  indent(WRITE, n + 2) +
  `${" ".repeat(n)}END IF;\n`;
const CONSUME_START = "  -- FIX-1422 — the old pairs the votes triggers captured";
const CONSUME_END = "    RAISE NOTICE '[votes] FIX-1422: % captured pair(s) consumed into the dirty set', v_captured;\n  END IF;\n\n";

function unhunk(src: string): string {
  let s = src;
  const cut = (a: string, b: string) => {
    assert.equal(s.split(a).length - 1, 1, `one ${JSON.stringify(a.slice(0, 50))}`);
    s = s.replace(a, b);
  };
  cut("  v_captured             BIGINT;        -- FIX-1422: old pairs consumed from vote_edge_stale_pairs\n", "");
  cut(
    "  --\n  -- FIX-1422 — and nothing captured: a moved or deleted vote leaves its OLD\n" +
    "  -- pair in vote_edge_stale_pairs, and a delete moves no updated_at.\n" +
    "  IF v_new_max_updated_at <= v_last_indexed_at\n     AND NOT EXISTS (SELECT 1 FROM public.vote_edge_stale_pairs) THEN\n",
    "  IF v_new_max_updated_at <= v_last_indexed_at THEN\n",
  );
  const a = s.indexOf(CONSUME_START);
  const b = s.indexOf(CONSUME_END);
  assert.ok(a > 0 && b > a, "the consume hunk");
  s = s.slice(0, a) + s.slice(b + CONSUME_END.length);
  cut(FORWARD(4), indent(WRITE, 4));
  cut(FORWARD(2), indent(WRITE, 2));
  return s;
}

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("the arm is 20261117000000's body plus the four FIX-1422 hunks, nothing else", () => {
  const now = body(FILE(), SIG_INCR);
  const prior = body(PRIOR(), SIG_INCR);
  assert.equal(md5(prior), PRIOR_MD5);
  assert.equal(md5(now), INCR_MD5);
  assert.equal(unhunk(now), prior);
});

test("the edge rule stays character-identical to _votes_full()'s but for the INNER JOIN pair", () => {
  const incr = rule(body(FILE(), SIG_INCR));
  assert.ok(incr.includes(JOIN_LINES));
  assert.equal(incr.replace(JOIN_LINES, ""), rule(body(PRIOR(), SIG_FULL)));
  assert.equal(incr, rule(body(PRIOR(), SIG_INCR)), "and to the prior arm's, byte for byte");
});

test("the queue is consumed by DELETE … RETURNING into _dirty_vote_keys; both watermark writes are forward-only", () => {
  const code = stripComments(body(FILE(), SIG_INCR));
  assert.match(code, /WITH consumed AS \(\n\s+DELETE FROM public\.vote_edge_stale_pairs\n\s+RETURNING official_id, bill_proposal_id\n\s+\), added AS \(\n\s+INSERT INTO _dirty_vote_keys/);
  assert.equal(code.split("IF v_new_max_updated_at > v_last_indexed_at THEN").length - 1, 2);
  assert.equal(code.split("INSERT INTO public.pipeline_state").length - 1, 2, "no new watermark write");
  // The consume sits after the watermark's dirty set and before the empty-set return.
  const at = (n: string) => code.indexOf(n);
  assert.ok(at("CREATE TEMP TABLE _dirty_vote_keys") < at("WITH consumed AS") && at("WITH consumed AS") < at("IF NOT EXISTS (SELECT 1 FROM _dirty_vote_keys)"));
});

test("the capture: one conflict-free INSERT of the OLD pair, no EXCEPTION block, no SET, SECURITY INVOKER", () => {
  const h = header(FILE(), SIG_CAP);
  assert.match(h, /\n RETURNS trigger\n LANGUAGE plpgsql\n$/);
  assert.doesNotMatch(h, /\bSET\b|SECURITY DEFINER/i);
  const code = stripComments(body(FILE(), SIG_CAP));
  assert.doesNotMatch(code, /\bEXCEPTION\b/i, "a handler is a subtransaction per fired row");
  assert.equal(
    code.trim(),
    "BEGIN\n  INSERT INTO public.vote_edge_stale_pairs (official_id, bill_proposal_id)\n" +
    "  VALUES (OLD.official_id, OLD.bill_proposal_id)\n  ON CONFLICT DO NOTHING;\n  RETURN NULL;\nEND;",
  );
});

test("the two triggers: UPDATE OF the pair WHEN it moved, DELETE WHEN it was whole; created last; no DROP TRIGGER", () => {
  const src = FILE();
  const code = stripComments(src);
  assert.ok(code.includes(
    "CREATE OR REPLACE TRIGGER votes_capture_stale_pair_update\n" +
    "  AFTER UPDATE OF official_id, bill_proposal_id ON public.votes\n  FOR EACH ROW\n" +
    "  WHEN ((OLD.official_id, OLD.bill_proposal_id) IS DISTINCT FROM (NEW.official_id, NEW.bill_proposal_id)\n" +
    "        AND OLD.official_id IS NOT NULL AND OLD.bill_proposal_id IS NOT NULL)\n" +
    "  EXECUTE FUNCTION public.capture_vote_edge_stale_pair();",
  ));
  assert.ok(code.includes(
    "CREATE OR REPLACE TRIGGER votes_capture_stale_pair_delete\n  AFTER DELETE ON public.votes\n  FOR EACH ROW\n" +
    "  WHEN (OLD.official_id IS NOT NULL AND OLD.bill_proposal_id IS NOT NULL)\n" +
    "  EXECUTE FUNCTION public.capture_vote_edge_stale_pair();",
  ));
  // DROP TRIGGER takes ACCESS EXCLUSIVE on votes; CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE.
  assert.doesNotMatch(code, /DROP TRIGGER/);
  assert.ok(code.indexOf("SET LOCAL lock_timeout = '5s';") < code.indexOf("CREATE TABLE"));
  assert.ok(code.lastIndexOf(SIG_INCR) < code.indexOf("CREATE OR REPLACE TRIGGER"), "the triggers come after the arm");
});

test("before its CREATE TABLE the file names the queue through to_regclass() only, never a ::regclass literal", () => {
  // A literal is resolved at parse time: on a database without the table it raises 42P01 whatever the IF
  // around it says. cc-319's first push stopped there (2026-11-26 19:47:11Z) and the file rolled back whole.
  const code = stripComments(FILE());
  const create = code.indexOf("CREATE TABLE IF NOT EXISTS public.vote_edge_stale_pairs");
  assert.ok(create > 0);
  const guard = code.slice(0, create);
  assert.doesNotMatch(guard, /'(public\.)?vote_edge_stale_pairs'::regclass/);
  assert.ok(guard.split("to_regclass('public.vote_edge_stale_pairs')").length - 1 >= 4, "the shape check reads it through to_regclass");
});

test("the queue is service-only: RLS on, ALL revoked from all four, SELECT/INSERT/DELETE to service_role; grants restated", () => {
  const code = stripComments(FILE());
  assert.ok(code.includes("ALTER TABLE public.vote_edge_stale_pairs ENABLE ROW LEVEL SECURITY;"));
  assert.ok(code.includes("REVOKE ALL ON TABLE public.vote_edge_stale_pairs FROM PUBLIC, anon, authenticated, service_role;"));
  assert.ok(code.includes("GRANT SELECT, INSERT, DELETE ON TABLE public.vote_edge_stale_pairs TO service_role;"));
  assert.doesNotMatch(code, /CREATE POLICY/);
  assert.ok(code.includes("REVOKE ALL ON FUNCTION public.capture_vote_edge_stale_pair() FROM PUBLIC, anon, authenticated;"));
  assert.ok(code.includes("REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes() FROM PUBLIC, anon, authenticated;"));
  assert.ok(code.includes("GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes() TO service_role;"));
  assert.doesNotMatch(code, new RegExp(SIG_FULL.replace(/[()]/g, "\\$&")), "_votes_full() is not edited");
});

test("the revert drops the two triggers by name and restores the prior arm verbatim; the queue and capture stay", () => {
  const rev = REVERT();
  const code = stripComments(rev);
  assert.deepEqual(
    [...code.matchAll(/DROP (\w+) IF EXISTS (\w+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ["TRIGGER votes_capture_stale_pair_update", "TRIGGER votes_capture_stale_pair_delete"],
  );
  assert.equal(body(rev, SIG_INCR), body(PRIOR(), SIG_INCR));
  assert.doesNotMatch(header(rev, SIG_INCR), /\bSET\b/);
  assert.ok(code.includes("SET LOCAL lock_timeout = '5s';"));
  assert.doesNotMatch(code, /DROP TABLE|DROP FUNCTION/);
});

test("the file is the newest to define the incremental arm; _votes_full() stays 20261117000000's", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const incr = all.filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG_INCR));
  assert.equal(incr[incr.length - 1], FILE_NAME);
  const full = all.filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG_FULL));
  assert.equal(full[full.length - 1], "20261117000000_fix1409_vote_edge_question_rule.sql");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only), each case rolled back
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

const VOTE_TYPES = "('vote_yes', 'vote_no', 'vote_abstain')";
type Pair = { official_id: string; bill_proposal_id: string };
type Edge = { connection_type: string; strength: string; evidence_ids: string[] };

/** BEGIN; no head lag; the watermark just below now(), so only this transaction's votes are past it; an empty queue. */
async function begin(c: Client, watermark = "now() - interval '1 second'"): Promise<void> {
  await c.query("BEGIN");
  await c.query("SET LOCAL statement_timeout = '10min'");
  await c.query("SET LOCAL civitics.watermark_lag_seconds = '0'");
  await c.query(`UPDATE public.pipeline_state SET value = jsonb_build_object('last_indexed_at', (${watermark})::text)
                  WHERE key = 'entity_connections_votes'`);
  await c.query("DELETE FROM public.vote_edge_stale_pairs");
}

const queue = async (c: Client): Promise<Pair[]> =>
  (await c.query<Pair>("SELECT official_id, bill_proposal_id FROM public.vote_edge_stale_pairs ORDER BY 1, 2")).rows;
const edges = async (c: Client, p: Pair): Promise<Edge[]> =>
  (await c.query<Edge>(
    `SELECT connection_type::text, strength::text, evidence_ids::text[] AS evidence_ids FROM public.entity_connections
      WHERE from_type = 'official' AND from_id = $1 AND to_type = 'proposal' AND to_id = $2 AND connection_type IN ${VOTE_TYPES}`,
    [p.official_id, p.bill_proposal_id],
  )).rows;
const fingerprint = async (c: Client): Promise<string> =>
  (await c.query<{ fp: string }>("SELECT public.ec_arm_source_fingerprint('rebuild_entity_connections_votes') AS fp")).rows[0]!.fp;

/**
 * A final-class yes/no vote that is its pair's ONLY vote row and its edge's evidence. The candidates are fenced
 * to one official's votes (MATERIALIZED): unfenced, the planner turns the edge probe into a scan of every vote
 * edge (74 s on the clone); fenced it is ~0.5 s.
 */
async function soleVote(c: Client): Promise<{ id: string; vote: string } & Pair> {
  const r = (await c.query<{ id: string; vote: string } & Pair>(
    `WITH r AS MATERIALIZED (
       SELECT v.id, v.vote, v.official_id, v.bill_proposal_id, v.vote_question, v.roll_call_id FROM public.votes v
        WHERE v.official_id = (SELECT official_id FROM public.votes ORDER BY id LIMIT 1))
     SELECT r.id, r.vote, r.official_id, r.bill_proposal_id FROM r
      WHERE r.vote IN ('yes', 'no') AND public.vote_roll_class(r.vote_question, r.roll_call_id) = 'final'
        AND NOT EXISTS (SELECT 1 FROM public.votes w
                         WHERE w.official_id = r.official_id AND w.bill_proposal_id = r.bill_proposal_id AND w.id <> r.id)
        AND EXISTS (SELECT 1 FROM public.entity_connections ec
                     WHERE ec.from_type = 'official' AND ec.from_id = r.official_id AND ec.to_type = 'proposal'
                       AND ec.to_id = r.bill_proposal_id AND ec.connection_type IN ('vote_yes', 'vote_no')
                       AND ec.evidence_ids = ARRAY[r.id])
      ORDER BY r.id LIMIT 1`,
  )).rows[0];
  assert.ok(r, "no sole-vote edge on the clone");
  return r;
}

async function newOfficial(c: Client, tag: string): Promise<string> {
  const jur = (await c.query<{ id: string }>("SELECT id FROM public.jurisdictions LIMIT 1")).rows[0]!.id;
  return (await c.query<{ id: string }>(
    `INSERT INTO public.officials (jurisdiction_id, full_name, role_title, tier, source_ids)
     VALUES ($1, $2, 'Representative', 'elected', '{}'::jsonb) RETURNING id`,
    [jur, `FIX1422 ${tag}`],
  )).rows[0]!.id;
}

test("clone: the file's bodies and triggers are live; the queue is empty and service-only", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const r = (await c.query(
      `SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.rebuild_entity_connections_votes()'::regprocedure) AS arm,
              (SELECT string_agg(tgname || ':' || tgenabled::text, ', ' ORDER BY tgname) FROM pg_trigger
                WHERE tgrelid = 'public.votes'::regclass AND NOT tgisinternal) AS trg,
              (SELECT count(*)::int FROM public.vote_edge_stale_pairs) AS queued,
              has_table_privilege('anon', 'public.vote_edge_stale_pairs', 'SELECT') AS anon_sel`,
    )).rows[0];
    assert.equal(r.arm, INCR_MD5);
    assert.equal(r.trg, "votes_capture_stale_pair_delete:O, votes_capture_stale_pair_update:O, votes_updated_at:O");
    assert.equal(r.queued, 0);
    assert.equal(r.anon_sel, false);
  } finally {
    await c.end();
  }
});

test("clone: a vote's official_id moves → one captured row, the OLD pair; one arm call retires its edge and lays the new one", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      const v = await soleVote(c);
      const old: Pair = { official_id: v.official_id, bill_proposal_id: v.bill_proposal_id };
      assert.equal((await edges(c, old)).length, 1, "the old pair has its edge");
      const to = await newOfficial(c, "re-attributed");
      const fp0 = await fingerprint(c);
      await c.query("UPDATE public.votes SET official_id = $2 WHERE id = $1", [v.id, to]);
      assert.notEqual(await fingerprint(c), fp0, "the gate sees the move and calls the arm");
      assert.deepEqual(await queue(c), [old]);
      await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      assert.deepEqual(await edges(c, old), [], "the old edge is gone");
      assert.deepEqual(await edges(c, { official_id: to, bill_proposal_id: v.bill_proposal_id }), [
        { connection_type: `vote_${v.vote}`, strength: "0.500", evidence_ids: [v.id] },
      ], "the new pair's edge is there");
      assert.deepEqual(await queue(c), [], "consumed");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: a vote's bill_proposal_id moves → the same", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      const v = await soleVote(c);
      const old: Pair = { official_id: v.official_id, bill_proposal_id: v.bill_proposal_id };
      const bill = (await c.query<{ id: string }>(
        `SELECT bd.proposal_id AS id FROM public.bill_details bd
          WHERE NOT EXISTS (SELECT 1 FROM public.votes w WHERE w.official_id = $1 AND w.bill_proposal_id = bd.proposal_id)
          ORDER BY bd.proposal_id LIMIT 1`,
        [v.official_id],
      )).rows[0]!.id;
      const fp0 = await fingerprint(c);
      await c.query("UPDATE public.votes SET bill_proposal_id = $2 WHERE id = $1", [v.id, bill]);
      assert.notEqual(await fingerprint(c), fp0);
      assert.deepEqual(await queue(c), [old]);
      await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      assert.deepEqual(await edges(c, old), []);
      assert.deepEqual(await edges(c, { official_id: v.official_id, bill_proposal_id: bill }), [
        { connection_type: `vote_${v.vote}`, strength: "0.500", evidence_ids: [v.id] },
      ]);
      assert.deepEqual(await queue(c), []);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: a pair's only vote deleted → a capture-only cycle retires the edge and leaves last_indexed_at where it was", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    // The watermark past every updated_at, so the arm's caught-up test holds and only the queue can make it work.
    await begin(c, "now() + interval '1 hour'");
    try {
      const wm0 = (await c.query<{ v: string }>("SELECT value->>'last_indexed_at' AS v FROM public.pipeline_state WHERE key = 'entity_connections_votes'")).rows[0]!.v;
      const v = await soleVote(c);
      const old: Pair = { official_id: v.official_id, bill_proposal_id: v.bill_proposal_id };
      const fp0 = await fingerprint(c);
      await c.query("DELETE FROM public.votes WHERE id = $1", [v.id]);
      assert.notEqual(await fingerprint(c), fp0, "count(*) moves, so the gate calls the arm");
      assert.deepEqual(await queue(c), [old]);
      await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      assert.deepEqual(await edges(c, old), [], "the edge is gone");
      assert.deepEqual(await queue(c), [], "consumed");
      const wm1 = (await c.query<{ v: string }>("SELECT value->>'last_indexed_at' AS v FROM public.pipeline_state WHERE key = 'entity_connections_votes'")).rows[0]!.v;
      assert.equal(wm1, wm0, "a capture-only cycle never moves the watermark");
      // And a second call with nothing queued takes the caught-up return: zero rows written.
      const again = (await c.query<{ edges_upserted: string }>("SELECT * FROM public.rebuild_entity_connections_votes()")).rows;
      assert.deepEqual(again.map((r) => Number(r.edges_upserted)), [0, 0, 0]);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: one of a pair's two votes deleted → the edge is re-derived from the survivor by FIX-1409's rule", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      // Fenced to the 20 most prolific officials' two-vote pairs, as soleVote() is fenced.
      const p = (await c.query<{ decider: string; survivor: string; vote: string; cls: string } & Pair>(
        `WITH o AS MATERIALIZED (SELECT official_id FROM public.votes GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 20),
         r AS MATERIALIZED (
           SELECT w.official_id, w.bill_proposal_id, array_agg(w.id) AS ids FROM public.votes w
            WHERE w.official_id IN (SELECT official_id FROM o) GROUP BY 1, 2 HAVING count(*) = 2)
         SELECT ec.from_id AS official_id, ec.to_id AS bill_proposal_id, ec.evidence_ids[1] AS decider,
                s.id AS survivor, s.vote, public.vote_roll_class(s.vote_question, s.roll_call_id) AS cls
           FROM r
          CROSS JOIN LATERAL (
            SELECT e.from_id, e.to_id, e.evidence_ids, e.id FROM public.entity_connections e
             WHERE e.from_type = 'official' AND e.from_id = r.official_id AND e.to_type = 'proposal'
               AND e.to_id = r.bill_proposal_id AND e.connection_type IN ('vote_yes', 'vote_no')
               AND e.evidence_source = 'votes' AND cardinality(e.evidence_ids) = 1
            OFFSET 0) ec
           JOIN public.votes s ON s.id = ANY (r.ids) AND s.id <> ec.evidence_ids[1]
          WHERE s.vote IN ('yes', 'no') AND public.vote_roll_class(s.vote_question, s.roll_call_id) IN ('final', 'advance')
          ORDER BY ec.id LIMIT 1`,
      )).rows[0];
      assert.ok(p, "no two-vote pair on the clone");
      const pair: Pair = { official_id: p.official_id, bill_proposal_id: p.bill_proposal_id };
      const fp0 = await fingerprint(c);
      await c.query("DELETE FROM public.votes WHERE id = $1", [p.decider]);
      assert.notEqual(await fingerprint(c), fp0);
      assert.deepEqual(await queue(c), [pair]);
      await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      assert.deepEqual(await edges(c, pair), [
        { connection_type: `vote_${p.vote}`, strength: p.cls === "final" ? "0.500" : "0.250", evidence_ids: [p.survivor] },
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: an upsert that re-sets both columns captures nothing; a vote value change captures nothing and rides the watermark", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      const v = await soleVote(c);
      const pair: Pair = { official_id: v.official_id, bill_proposal_id: v.bill_proposal_id };
      await c.query("UPDATE public.votes SET official_id = official_id, bill_proposal_id = bill_proposal_id WHERE id = $1", [v.id]);
      await c.query(
        `INSERT INTO public.votes SELECT * FROM public.votes WHERE id = $1
         ON CONFLICT (roll_call_id, official_id) DO UPDATE
           SET official_id = EXCLUDED.official_id, bill_proposal_id = EXCLUDED.bill_proposal_id, vote = EXCLUDED.vote`,
        [v.id],
      );
      assert.deepEqual(await queue(c), [], "UPDATE OF fires, the WHEN holds it");
      const flipped = v.vote === "yes" ? "no" : "yes";
      await c.query("UPDATE public.votes SET vote = $2 WHERE id = $1", [v.id, flipped]);
      assert.deepEqual(await queue(c), [], "a vote value is not a pair");
      await c.query("SELECT * FROM public.rebuild_entity_connections_votes()");
      assert.deepEqual(await edges(c, pair), [
        { connection_type: `vote_${flipped}`, strength: "0.500", evidence_ids: [v.id] },
      ], "the watermark re-derives it as before");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: 5,000 votes moved in one statement — the wall with and without the triggers, and no subtransaction", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const subxacts = async (): Promise<{ n: number; overflowed: boolean }> => {
    await c.query("SELECT pg_stat_clear_snapshot()");
    const r = (await c.query<{ n: number; o: boolean }>(
      `SELECT s.subxact_count AS n, s.subxact_overflowed AS o
         FROM pg_stat_get_backend_idset() b(id), LATERAL pg_stat_get_backend_subxact(b.id) s
        WHERE pg_stat_get_backend_pid(b.id) = pg_backend_pid()`,
    )).rows[0]!;
    return { n: Number(r.n), overflowed: r.o };
  };
  try {
    await begin(c);
    try {
      // Two prolific officials' votes, each to its own new official (no roll collides), 5,000 rows in one UPDATE.
      const from = (await c.query<{ official_id: string }>(
        "SELECT official_id FROM public.votes GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 2",
      )).rows.map((r) => r.official_id);
      const to = [await newOfficial(c, "bulk a"), await newOfficial(c, "bulk b")];
      await c.query(`CREATE TEMP TABLE _fix1422_bulk ON COMMIT DROP AS
        SELECT id FROM public.votes WHERE official_id = ANY ($1::uuid[]) ORDER BY id LIMIT 5000`, [from]);
      const pairs = Number((await c.query<{ n: string }>(
        "SELECT count(DISTINCT (official_id, bill_proposal_id))::text AS n FROM public.votes WHERE id IN (SELECT id FROM _fix1422_bulk)",
      )).rows[0]!.n);
      const MOVE = `UPDATE public.votes SET official_id = CASE official_id WHEN $1::uuid THEN $2::uuid ELSE $3::uuid END
                     WHERE id IN (SELECT id FROM _fix1422_bulk)`;
      const run = async (): Promise<number> => {
        await c.query("SAVEPOINT m");
        const t0 = process.hrtime.bigint();
        const r = await c.query(MOVE, [from[0], to[0], to[1]]);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.equal(r.rowCount, 5000);
        // Undo the move, then close the savepoint, so the kept run below is at the top level.
        await c.query("ROLLBACK TO SAVEPOINT m");
        await c.query("RELEASE SAVEPOINT m");
        return ms;
      };
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      await run(); // warm
      const withT: number[] = [];
      const without: number[] = [];
      for (let i = 0; i < 3; i++) {
        withT.push(await run());
        await c.query("ALTER TABLE public.votes DISABLE TRIGGER votes_capture_stale_pair_update");
        without.push(await run());
        await c.query("ALTER TABLE public.votes ENABLE TRIGGER votes_capture_stale_pair_update");
      }
      t.diagnostic(`5,000 rows / ${pairs} pairs: with the triggers ${withT.map((x) => x.toFixed(0)).join(" / ")} ms (median ${median(withT).toFixed(0)}), ` +
        `without ${without.map((x) => x.toFixed(0)).join(" / ")} ms (median ${median(without).toFixed(0)}), ` +
        `+${((median(withT) / median(without) - 1) * 100).toFixed(1)} %`);

      // The kept run: every distinct OLD pair queued once, and no subtransaction for it.
      assert.equal((await subxacts()).n, 0, "no subtransaction open before the kept move");
      await c.query(MOVE, [from[0], to[0], to[1]]);
      const s = await subxacts();
      assert.deepEqual(s, { n: 0, overflowed: false }, "the capture opened no subtransaction");
      assert.equal((await queue(c)).length, pairs, "one captured row per distinct old pair");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
