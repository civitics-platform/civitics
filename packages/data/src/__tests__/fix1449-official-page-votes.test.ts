/**
 * FIX-1449 — public.get_official_page(uuid): the vote lists carry their roll's
 * question, chamber and class and come newest first; the global "spending" list
 * is gone. cc-325 Item 1, `20261126001000_fix1449_official_page_votes_say_what_they_count.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1449-official-page-votes.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the header is FIX-646's (STABLE, invoker, search_path only, no timeout);
 *   - the body's top-level keys are the old ones minus 'spending', and it reads
 *     no financial_relationships;
 *   - both vote lists carry vote_roll_class and order by voted_at, then the roll
 *     number; all_votes' LIMIT 500 has an ORDER BY;
 *   - every key but the two vote lists is FIX-646's text byte-for-byte;
 *   - the body's md5 is the pin the guard and the read-back carry; the revert
 *     file is FIX-646's body verbatim; nothing else is written or dropped.
 * Clone tests (CIVITICS_CLONE_TESTS=1):
 *   - the live body is this file's, with FIX-646's proconfig;
 *   - for the heaviest official, a light one and a senator: no 'spending', every
 *     other old key present; each vote row carries vote_question, chamber and
 *     roll_class (= vote_roll_class); all_votes is the newest 500 in order;
 *   - anon executes it; an official with no votes reads empty lists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, type QueryResult } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261126001000_fix1449_official_page_votes_say_what_they_count.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const FIX646 = () => read(path.join(MIGRATIONS, "20260621060000_fix646_get_official_page.sql"));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1449-revert-get-official-page.sql"));
const ALLOW = () =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "pipelines", "integrity-audit", "checks", "rpc-grant-allowlist.json"), "utf8"),
  ) as { anon_public: string[] };

const SIG = "CREATE OR REPLACE FUNCTION public.get_official_page(p_id uuid)";

/** md5(prosrc) of the body this file installs: what the push's read-back prints. */
const PIN = "cae21650a7053828a739de47d33f0976";
/** FIX-646's body, live on the clone and prod at cc-325 read 2: the revert's target. */
const OLD = "cefb35bb5ad3e8406df6b7ec1086e6ab";

const OLD_KEYS = [
  "vote_count", "recent_votes", "all_votes", "ai_summary", "career_history",
  "promises", "civic_responses", "passive_answer_count", "spending",
];
const NEW_KEYS = OLD_KEYS.filter((k) => k !== "spending");

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

/** The top-level keys of the jsonb_build_object: a quoted name at four spaces, then a comma. */
const topKeys = (b: string) => [...b.matchAll(/^ {4}'(\w+)',$/gm)].map((m) => m[1]);

/** One key's text: from its line to the next top-level key (or the closing paren). */
function section(b: string, key: string): string {
  const start = b.indexOf(`\n    '${key}',\n`);
  assert.notEqual(start, -1, key);
  const rest = b.slice(start + 1);
  const next = rest.slice(1).search(/\n {4}(?:'\w+',\n|-- )/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("D5: the header is FIX-646's — STABLE, invoker, search_path only, no statement_timeout", () => {
  const h = header(FILE(), SIG);
  assert.equal(
    h,
    `${SIG}\nRETURNS jsonb\nLANGUAGE sql\nSTABLE\nSECURITY INVOKER\nSET search_path = public, extensions\n`,
  );
  assert.equal(h, header(FIX646(), SIG));
});

test("D1: the keys are FIX-646's minus 'spending'; the body reads no financial_relationships", () => {
  assert.deepEqual(topKeys(body(FIX646(), SIG)), OLD_KEYS);
  const b = body(FILE(), SIG);
  assert.deepEqual(topKeys(b), NEW_KEYS);
  assert.doesNotMatch(stripComments(b), /financial_relationships|agencies|financial_entities|jurisdiction_id/);
});

test("D3: both vote lists carry question, chamber and roll class, newest first by the roll number inside a day", () => {
  const b = body(FILE(), SIG);
  const order =
    /ORDER BY v\.voted_at DESC NULLS LAST,\s+substring\(v\.roll_call_id FROM '\(\[0-9\]\+\)\$'\)::numeric DESC NULLS LAST\s+LIMIT (\d+)/;
  for (const [key, limit] of [["recent_votes", "100"], ["all_votes", "500"]] as const) {
    const s = section(b, key);
    assert.ok(s.includes("v.vote_question, v.chamber,"), `${key}: question and chamber`);
    assert.ok(s.includes("public.vote_roll_class(v.vote_question, v.roll_call_id) AS roll_class"), `${key}: class`);
    assert.equal(order.exec(s)?.[1], limit, `${key}: ORDER BY … LIMIT ${limit}`);
    // jsonb_agg keeps the same order (an aggregate does not inherit it).
    const alias = key === "recent_votes" ? "rv" : "av";
    assert.match(
      s,
      new RegExp(`jsonb_agg\\(to_jsonb\\(${alias}\\) ORDER BY ${alias}\\.voted_at DESC NULLS LAST,\\s+substring\\(${alias}\\.roll_call_id`),
      `${key}: aggregate order`,
    );
    // One hydration per distinct proposal (Memoize), the payload's shape unchanged.
    assert.match(s, /LEFT JOIN LATERAL \(\s+SELECT jsonb_build_object\(/, `${key}: lateral hydration`);
    assert.match(s, /WHERE p\.id = v\.bill_proposal_id\s+OFFSET 0\s+\) pj ON true/, `${key}: OFFSET 0 fence`);
    assert.ok(s.includes("'bill_details', (\n                SELECT jsonb_build_object('bill_number', bd.bill_number)"), key);
  }
  const all = section(b, "all_votes");
  assert.ok(all.includes("SELECT v.vote, v.voted_at, v.roll_call_id, v.bill_proposal_id,"), "all_votes gains voted_at and roll_call_id");
  assert.ok(section(b, "recent_votes").includes("SELECT v.id, v.vote, v.voted_at, v.roll_call_id, v.bill_proposal_id,"));
});

test("D5: every key but the two vote lists is FIX-646's text byte-for-byte", () => {
  const was = body(FIX646(), SIG);
  const now = body(FILE(), SIG);
  for (const k of ["vote_count", "ai_summary", "career_history", "promises", "civic_responses", "passive_answer_count"]) {
    // passive_answer_count was followed by spending; compare up to its closing paren.
    const trim = (s: string) => (k === "passive_answer_count" ? s.slice(0, s.indexOf("'visible')") + 10) : s);
    assert.equal(trim(section(now, k)), trim(section(was, k)), k);
  }
});

test("the body's md5 is the pin; the guard and the read-back carry it; the revert is FIX-646's body", () => {
  const src = FILE();
  assert.equal(md5(body(src, SIG)), PIN);
  assert.equal(src.split(PIN).length - 1, 3, "guard (twice) + read-back (once)");
  assert.equal(md5(body(FIX646(), SIG)), OLD, "FIX-646's file is the body live at read 2");
  assert.ok(src.includes(`IF v_self IS DISTINCT FROM '${OLD}' AND v_self IS DISTINCT FROM '${PIN}' THEN`));
  const rev = REVERT();
  assert.equal(md5(body(rev, SIG)), OLD, "the revert puts FIX-646's body back verbatim");
  assert.equal(header(rev, SIG), header(FIX646(), SIG));
  assert.ok(rev.includes(`IF v_self IS DISTINCT FROM '${PIN}' AND v_self IS DISTINCT FROM '${OLD}' THEN`));
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${OLD}' THEN`));
});

test("grants restated; in the anon allow-list; nothing written or dropped outside the body", () => {
  for (const src of [FILE(), REVERT()]) {
    assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.get_official_page(uuid) TO anon, authenticated, service_role;"));
    const sql = stripComments(src);
    assert.deepEqual(
      [...sql.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE|VIEW) public\.(\w+)/g)].map((m) => m[1]),
      ["get_official_page"],
    );
    const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
    assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|CREATE INDEX|REVOKE|ALTER FUNCTION)/i);
  }
  assert.ok(ALLOW().anon_public.includes("get_official_page"));
});

test("the migration sorts after prod's head and no later file redefines the function", () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const i = files.indexOf(FILE_NAME);
  assert.notEqual(i, -1);
  assert.ok(FILE_NAME > "20261126000000_fix1447_proposal_vote_rolls.sql");
  for (const f of files.slice(i + 1)) {
    assert.ok(!read(path.join(MIGRATIONS, f)).includes("FUNCTION public.get_official_page"), f);
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

type VoteJson = {
  vote: string;
  voted_at: string;
  roll_call_id: string;
  vote_question: string | null;
  chamber: string;
  roll_class: string;
  bill_proposal_id: string;
  proposals: { id: string; title: string | null } | null;
};

const rollNo = (id: string) => {
  const m = /([0-9]+)$/.exec(id);
  return m ? Number(m[1]) : -1;
};

test("clone: the live body is this file's, with FIX-646's proconfig; STABLE; invoker", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows } = await c.query(
      `SELECT md5(prosrc) AS m, proconfig AS cfg, provolatile AS vol, prosecdef AS sec
         FROM pg_proc WHERE oid = to_regprocedure('public.get_official_page(uuid)')`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].m, PIN);
    assert.deepEqual(rows[0].cfg, ["search_path=public, extensions"]);
    assert.equal(rows[0].vol, "s");
    assert.equal(rows[0].sec, false);
  } finally {
    await c.end();
  }
});

test("clone: three officials — no spending, the old keys, question/chamber/class on each row, the newest 500 in order", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows: picks } = await c.query<{ kind: string; id: string }>(`
      WITH per AS (SELECT official_id AS id, count(*) AS n FROM public.votes GROUP BY official_id)
      (SELECT 'heaviest' AS kind, id::text FROM per ORDER BY n DESC, id LIMIT 1)
      UNION ALL
      (SELECT 'light', id::text FROM per WHERE n BETWEEN 2 AND 99 ORDER BY n DESC, id LIMIT 1)
      UNION ALL
      (SELECT 'senator', per.id::text FROM per JOIN public.officials o ON o.id = per.id
        WHERE o.role_title = 'Senator' AND o.is_active ORDER BY per.n DESC, per.id LIMIT 1)`);
    assert.equal(picks.length, 3, JSON.stringify(picks));
    for (const { kind, id } of picks) {
      const { rows }: QueryResult<{ p: Record<string, unknown> }> = await c.query<{ p: Record<string, unknown> }>(
        `SELECT public.get_official_page($1) AS p`,
        [id],
      );
      const page: Record<string, unknown> = rows[0]!.p;
      assert.ok(!("spending" in page), `${kind}: no spending key`);
      for (const k of NEW_KEYS) assert.ok(k in page, `${kind}: ${k} present`);

      const { rows: direct }: QueryResult<{ n: number; nth: Date | null }> = await c.query<{ n: number; nth: Date | null }>(
        `SELECT (SELECT count(*)::int FROM public.votes WHERE official_id = $1) AS n,
                (SELECT voted_at FROM public.votes WHERE official_id = $1
                  ORDER BY voted_at DESC NULLS LAST OFFSET 499 LIMIT 1) AS nth`,
        [id],
      );
      const n: number = direct[0]!.n;
      assert.equal(page["vote_count"], n, `${kind}: vote_count`);

      const all = page["all_votes"] as VoteJson[];
      const recent = page["recent_votes"] as (VoteJson & { id: string })[];
      assert.equal(all.length, Math.min(n, 500), `${kind}: all_votes length`);
      assert.equal(recent.length, Math.min(n, 100), `${kind}: recent_votes length`);
      for (const list of [all, recent]) {
        for (const v of list) {
          for (const k of ["vote_question", "chamber", "roll_class", "roll_call_id", "voted_at"]) {
            assert.ok(k in v, `${kind}: ${k} on a row`);
          }
        }
        // Newest first; inside a day, the higher roll number first.
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1]!;
          const b = list[i]!;
          const d = new Date(a.voted_at).getTime() - new Date(b.voted_at).getTime();
          assert.ok(d > 0 || (d === 0 && rollNo(a.roll_call_id) >= rollNo(b.roll_call_id)), `${kind}: order at ${i}`);
        }
      }
      // recent_votes is the head of all_votes.
      assert.deepEqual(
        recent.map((v) => v.roll_call_id),
        all.slice(0, recent.length).map((v) => v.roll_call_id),
        `${kind}: recent is the head of all`,
      );
      // The newest 500: every vote newer than the 500th is in the list.
      if (direct[0]!.nth) {
        const { rows: newer }: QueryResult<{ n: number }> = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.votes WHERE official_id = $1 AND voted_at > $2`,
          [id, direct[0]!.nth],
        );
        const nth: Date = direct[0]!.nth;
        const inList: number = all.filter((v) => new Date(v.voted_at) > nth).length;
        assert.equal(inList, newer[0]!.n, `${kind}: every vote newer than the 500th is listed`);
      }
      // roll_class is vote_roll_class of the row's own question and roll.
      const { rows: cls }: QueryResult<{ bad: number }> = await c.query<{ bad: number }>(
        `SELECT count(*)::int AS bad
           FROM jsonb_to_recordset($1::jsonb) AS x(vote_question text, roll_call_id text, roll_class text)
          WHERE x.roll_class IS DISTINCT FROM public.vote_roll_class(x.vote_question, x.roll_call_id)`,
        [JSON.stringify(all)],
      );
      assert.equal(cls[0]!.bad, 0, `${kind}: roll_class`);
      // Hydration unchanged: a row's proposal is its bill_proposal_id's.
      for (const v of all) if (v.proposals) assert.equal(v.proposals.id, v.bill_proposal_id, kind);
    }
  } finally {
    await c.end();
  }
});

test("clone: anon executes it; an official with no votes reads empty lists", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL ROLE anon");
      const { rows } = await c.query<{ p: Record<string, unknown> }>(
        `SELECT public.get_official_page((SELECT official_id FROM public.votes LIMIT 1)) AS p`,
      );
      assert.ok((rows[0]!.p["recent_votes"] as unknown[]).length >= 1, "anon reads votes");
      const { rows: none } = await c.query<{ p: Record<string, unknown> }>(
        `SELECT public.get_official_page(gen_random_uuid()) AS p`,
      );
      assert.equal(none[0]!.p["vote_count"], 0);
      assert.deepEqual(none[0]!.p["recent_votes"], []);
      assert.deepEqual(none[0]!.p["all_votes"], []);
      assert.ok(!("spending" in none[0]!.p));
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
