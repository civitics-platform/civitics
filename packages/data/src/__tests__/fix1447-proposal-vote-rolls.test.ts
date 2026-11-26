/**
 * FIX-1447 — public.proposal_vote_rolls(uuid): one row per roll of a proposal,
 * the proposal page's one vote read. cc-317 D1,
 * `20261126000000_fix1447_proposal_vote_rolls.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1447-proposal-vote-rolls.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - LANGUAGE sql STABLE, no SET, not SECURITY DEFINER, so it inlines;
 *   - the body's one filter is the equality on bill_proposal_id;
 *   - the body's md5 is the pin the guard and the read-back both carry;
 *   - EXECUTE to anon, authenticated, service_role, and the two class helpers
 *     it calls to anon and authenticated; all three in the FIX-1113 allow-list;
 *   - nothing written or dropped outside the body; the newest migration.
 * Clone tests (CIVITICS_CLONE_TESTS=1):
 *   - the live body is this file's, proconfig NULL, STABLE, invoker;
 *   - for a House-only proposal, a two-chamber one and the heaviest, every row
 *     equals an independent GROUP BY over votes (scalars, and by_party unnested
 *     against a per-party GROUP BY), EXCEPT ALL both ways 0/0; roll_class equals
 *     vote_roll_class on each row; the rows come newest first;
 *   - an unknown id returns 0 rows; anon executes it; the plan reads votes_bill.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261126000000_fix1447_proposal_vote_rolls.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const ALLOW = () =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "pipelines", "integrity-audit", "checks", "rpc-grant-allowlist.json"), "utf8"),
  ) as { anon_public: string[]; triggers_and_helpers: string[] };

const SIG = "CREATE OR REPLACE FUNCTION public.proposal_vote_rolls(p_proposal_id uuid)";

/** md5(prosrc) of the body this file installs: what the push's read-back prints. */
const PIN = "35ee10d8653a61d2b9b4b96ec28eb69b";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("D1: LANGUAGE sql STABLE, no SET, not SECURITY DEFINER — the shape that inlines", () => {
  const h = header(FILE(), SIG);
  assert.match(h, /\nLANGUAGE sql\nSTABLE\n$/);
  assert.doesNotMatch(h, /\bSET\b|SECURITY DEFINER|VOLATILE|STRICT/);
  const columns = [
    ["roll_call_id", "text"], ["chamber", "text"], ["vote_question", "text"], ["roll_class", "text"],
    ["voted_at", "timestamptz"], ["source_url", "text"], ["vote_result", "text"], ["rows_on_record", "integer"],
    ["yes", "integer"], ["no", "integer"], ["present", "integer"], ["not_voting", "integer"], ["other", "integer"],
    ["by_party", "jsonb"],
  ];
  const listed = h.slice(h.indexOf("RETURNS TABLE (") + "RETURNS TABLE (".length, h.indexOf("\n)"));
  assert.deepEqual(
    listed.split(",").map((c) => c.trim().split(/\s+/)),
    columns,
  );
});

test("D1: the body's one filter is the equality on bill_proposal_id; roll_class is vote_roll_class", () => {
  const b = body(FILE(), SIG);
  // Every WHERE but the FILTER (WHERE …) clauses of the counts.
  const wheres = [...b.matchAll(/(?<!FILTER \()\bWHERE\b([^\n]*)/g)].map((m) => (m[1] as string).trim());
  assert.deepEqual(wheres, ["v.bill_proposal_id = p_proposal_id"]);
  assert.ok(b.includes("public.vote_roll_class(max(pp.vote_question), pp.roll_call_id)"));
  // FIX-1409's roll-number order inside a day, after the date.
  assert.match(b, /ORDER BY min\(pp\.voted_at\) DESC,\s+substring\(pp\.roll_call_id FROM '\(\[0-9\]\+\)\$'\)::numeric DESC NULLS LAST,\s+pp\.roll_call_id DESC\s*$/);
  // by_party's four keys; paired/abstain land in the top-level other.
  for (const p of ["democrat", "republican", "independent"]) assert.ok(b.includes(`WHEN '${p}'`), p);
  assert.ok(b.includes("ELSE 'other'"));
  assert.ok(b.includes("sum(pp.n - pp.yes - pp.no - pp.present - pp.not_voting)::integer"));
});

test("the body's md5 is the pin, and the guard and the read-back both carry it", () => {
  const src = FILE();
  assert.equal(md5(body(src, SIG)), PIN);
  assert.equal(src.split(PIN).length - 1, 3, "guard (twice) + read-back (once)");
  assert.doesNotMatch(src, /PIN_SELF/);
});

test("grants: the function to all three roles, the class helpers to anon and authenticated; all in the allow-list", () => {
  const src = FILE();
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.proposal_vote_rolls(uuid) TO anon, authenticated, service_role;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.vote_roll_class(text, text) TO anon, authenticated;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.vote_question_class(text) TO anon, authenticated;"));
  assert.doesNotMatch(stripComments(src), /\bREVOKE\b/);
  const allow = ALLOW();
  assert.ok(allow.anon_public.includes("proposal_vote_rolls"));
  assert.ok(allow.triggers_and_helpers.includes("vote_roll_class"));
  assert.ok(allow.triggers_and_helpers.includes("vote_question_class"));
});

test("the file writes and drops nothing outside the body, and replaces no other routine", () => {
  const sql = stripComments(FILE());
  assert.deepEqual(
    [...sql.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE|VIEW) public\.(\w+)/g)].map((m) => m[1]),
    ["proposal_vote_rolls"],
  );
  const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|CREATE INDEX)/i);
  assert.doesNotMatch(outside, /job_registry|cron\.|platform_dials/);
});

test("the migration is the newest file", () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const i = files.indexOf(FILE_NAME);
  assert.notEqual(i, -1);
  assert.ok(FILE_NAME > "20261122002000_fix1443_conn_windows_upper_bound_index_condition.sql");
  // Later files may land; none may redefine this function.
  for (const f of files.slice(i + 1)) {
    assert.ok(!read(path.join(MIGRATIONS, f)).includes("FUNCTION public.proposal_vote_rolls"), f);
  }
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

const PARTY = `CASE o.party::text WHEN 'democrat' THEN 'democrat' WHEN 'republican' THEN 'republican'
                 WHEN 'independent' THEN 'independent' ELSE 'other' END`;

/** The function's scalars, re-derived by one direct GROUP BY over votes. */
const DIRECT_SCALARS = `
  SELECT v.roll_call_id, v.chamber, max(v.vote_question) AS vote_question, min(v.voted_at) AS voted_at,
         max(v.source_url) AS source_url, max(nullif(v.metadata->>'vote_result', '')) AS vote_result,
         count(*)::int AS rows_on_record,
         count(*) FILTER (WHERE v.vote = 'yes')::int AS yes,
         count(*) FILTER (WHERE v.vote = 'no')::int AS no,
         count(*) FILTER (WHERE v.vote = 'present')::int AS present,
         count(*) FILTER (WHERE v.vote = 'not_voting')::int AS not_voting,
         count(*) FILTER (WHERE v.vote NOT IN ('yes', 'no', 'present', 'not_voting'))::int AS other
    FROM public.votes v WHERE v.bill_proposal_id = $1
   GROUP BY v.roll_call_id, v.chamber`;

const FN_SCALARS = `
  SELECT roll_call_id, chamber, vote_question, voted_at, source_url, vote_result,
         rows_on_record, yes, no, present, not_voting, other
    FROM public.proposal_vote_rolls($1)`;

/** by_party unnested, against a per-party GROUP BY. */
const DIRECT_PARTY = `
  SELECT v.roll_call_id, v.chamber, ${PARTY} AS party,
         count(*) FILTER (WHERE v.vote = 'yes')::int AS yes,
         count(*) FILTER (WHERE v.vote = 'no')::int AS no,
         count(*) FILTER (WHERE v.vote = 'present')::int AS present,
         count(*) FILTER (WHERE v.vote = 'not_voting')::int AS not_voting
    FROM public.votes v LEFT JOIN public.officials o ON o.id = v.official_id
   WHERE v.bill_proposal_id = $1
   GROUP BY 1, 2, 3`;

const FN_PARTY = `
  SELECT r.roll_call_id, r.chamber, e.key AS party,
         (e.value->>'yes')::int AS yes, (e.value->>'no')::int AS no,
         (e.value->>'present')::int AS present, (e.value->>'not_voting')::int AS not_voting
    FROM public.proposal_vote_rolls($1) r, jsonb_each(r.by_party) e`;

async function exceptBoth(c: Client, a: string, b: string, id: string): Promise<[number, number]> {
  const one = await c.query(`SELECT count(*)::int AS n FROM ((${a}) EXCEPT ALL (${b})) x`, [id]);
  const two = await c.query(`SELECT count(*)::int AS n FROM ((${b}) EXCEPT ALL (${a})) x`, [id]);
  return [one.rows[0].n, two.rows[0].n];
}

test("clone: the live body is this file's; proconfig NULL; STABLE; invoker", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows } = await c.query(
      `SELECT md5(prosrc) AS m, proconfig AS cfg, provolatile AS vol, prosecdef AS sec
         FROM pg_proc WHERE oid = to_regprocedure('public.proposal_vote_rolls(uuid)')`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].m, PIN);
    assert.equal(rows[0].cfg, null);
    assert.equal(rows[0].vol, "s");
    assert.equal(rows[0].sec, false);
  } finally {
    await c.end();
  }
});

test("clone: three proposals (House-only, two chambers, the heaviest) equal a direct GROUP BY, 0/0", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows: picks } = await c.query(`
      WITH per AS (
        SELECT bill_proposal_id AS id, count(*) AS n, count(DISTINCT roll_call_id) AS rolls,
               count(DISTINCT chamber) AS chambers, bool_and(chamber = 'House') AS house_only
          FROM public.votes GROUP BY bill_proposal_id
      )
      (SELECT 'house_only' AS kind, id::text FROM per WHERE house_only AND rolls > 1 ORDER BY n DESC, id LIMIT 1)
      UNION ALL
      (SELECT 'two_chambers', id::text FROM per WHERE chambers = 2 ORDER BY n DESC, id LIMIT 1)
      UNION ALL
      (SELECT 'heaviest', id::text FROM per ORDER BY n DESC, id LIMIT 1)`);
    assert.equal(picks.length, 3, JSON.stringify(picks));
    for (const { kind, id } of picks) {
      const fn = await c.query(
        `SELECT roll_call_id, voted_at, roll_class, vote_question,
                public.vote_roll_class(vote_question, roll_call_id) AS want_class,
                substring(roll_call_id FROM '([0-9]+)$')::numeric AS num,
                rows_on_record, yes + no + present + not_voting + other AS parts
           FROM public.proposal_vote_rolls($1)`,
        [id],
      );
      assert.ok(fn.rows.length > 0, `${kind} ${id}: rows`);
      const direct = await c.query(
        `SELECT count(DISTINCT (roll_call_id, chamber))::int AS rolls FROM public.votes WHERE bill_proposal_id = $1`,
        [id],
      );
      assert.equal(fn.rows.length, direct.rows[0].rolls, `${kind}: one row per roll`);
      for (const r of fn.rows) {
        assert.equal(r.roll_class, r.want_class, `${kind} ${r.roll_call_id}: roll_class`);
        assert.equal(r.rows_on_record, r.parts, `${kind} ${r.roll_call_id}: the five counts sum to the rows`);
      }
      // Newest first: voted_at, then the roll number inside a day.
      for (let i = 1; i < fn.rows.length; i++) {
        const a = fn.rows[i - 1];
        const b = fn.rows[i];
        const at = new Date(a.voted_at).getTime() - new Date(b.voted_at).getTime();
        assert.ok(at > 0 || (at === 0 && Number(a.num ?? -1) >= Number(b.num ?? -1)), `${kind}: order at ${i}`);
      }
      assert.deepEqual(await exceptBoth(c, FN_SCALARS, DIRECT_SCALARS, id), [0, 0], `${kind}: scalars`);
      assert.deepEqual(await exceptBoth(c, FN_PARTY, DIRECT_PARTY, id), [0, 0], `${kind}: by_party`);
    }
  } finally {
    await c.end();
  }
});

test("clone: an unknown id returns 0 rows; anon executes it; the plan reads votes_bill", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const none = await c.query(`SELECT count(*)::int AS n FROM public.proposal_vote_rolls(gen_random_uuid())`);
    assert.equal(none.rows[0].n, 0);
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL ROLE anon");
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM public.proposal_vote_rolls(
           (SELECT bill_proposal_id FROM public.votes LIMIT 1))`,
      );
      assert.ok(rows[0].n >= 1, "anon reads a roll");
      const plan = await c.query(
        `EXPLAIN SELECT * FROM public.proposal_vote_rolls('00000000-0000-0000-0000-000000000000')`,
      );
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(text, /votes_bill/, text);
      assert.doesNotMatch(text, /Function Scan/, "inlined");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
