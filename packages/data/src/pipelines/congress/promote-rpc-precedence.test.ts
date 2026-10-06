/**
 * FIX-1195 — promote_candidate_to_elected()'s source_ids precedence.
 *
 * Runs via:  tsx --test src/pipelines/congress/promote-rpc-precedence.test.ts
 *
 * The bug this pins is a one-character-class mistake that no type system and no
 * test could have caught, because the COMMENT above it stated the rule
 * correctly: jsonb `a || b` keeps the RIGHT operand on key conflict, and the
 * function wrote `(c.source_ids || e.source_ids)` — elected on the right — so
 * the elected row's keys won and the surviving candidate row lost its own
 * fec_candidate_id on every single promotion.
 *
 * Both halves are asserted, the grant-staff-idempotency precedent:
 *   - the SOURCE anchor runs everywhere, CI with no database included, and is
 *     the half that would catch a future re-inversion;
 *   - the BEHAVIOURAL half runs the four cases against a reachable database and
 *     rolls back. `supabase/tests/verify_fix1195.sql` is the same four cases in
 *     plain SQL for running by hand.
 *
 * FIX-1279 adds the identity-field precedence (elected first) on both halves;
 * it is CASE 5 in verify_fix1195.sql. FIX-1278 adds the official_redirects row
 * the promotion writes for the id it deletes; it is CASE 6.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

// The NEWEST definition of the function, because a source anchor guards the
// LIVE body, not a superseded file. FIX-1279 (20261005200000) re-states the
// FIX-1195 body verbatim apart from the six identity fields, and FIX-1278
// (20261006010000) re-states the FIX-1279 body verbatim plus the two
// official_redirects statements, so the earlier anchors below read it unchanged.
const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..", "..",
  "supabase", "migrations", "20261006010000_fix1278_official_redirects.sql",
);

// ---------------------------------------------------------------------------
// Source anchors — run everywhere, including CI with no database.
// ---------------------------------------------------------------------------

test("FIX-1195: the merge puts the CANDIDATE on the right of ||", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  assert.match(
    src,
    /SELECT \(e\.source_ids \|\| c\.source_ids\)/,
    "the candidate's source_ids must be the RIGHT operand — it is the row that survives",
  );
  assert.doesNotMatch(
    src,
    /SELECT \(c\.source_ids \|\| e\.source_ids\)/,
    "(c || e) is the FIX-1195 inversion: it hands every conflicted key to the row being deleted",
  );
});

test("FIX-1195: the losing id is filed as a PRIOR claim, never as a retired one", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  // prior_fec_candidate_ids is inside authoritativeClaims(), so it keeps a
  // claim and blocks the cn{yy} re-mint. merged_fec_candidate_ids is filtered
  // OUT of authoritativeClaims by design (FIX-955), so filing there would leave
  // the id unheld — the same zero-holder state the fix exists to prevent.
  assert.match(src, /jsonb_set\(\s*v_merged_source_ids, '\{prior_fec_candidate_ids\}'/);
  assert.doesNotMatch(
    src,
    /jsonb_set\([\s\S]{0,80}'\{merged_fec_candidate_ids\}'/,
    "the promotion must not RETIRE the losing id — nothing else holds it",
  );
});

test("FIX-1195: the function takes no SET clause (FIX-1128 / transaction control)", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const m = src.match(/CREATE OR REPLACE FUNCTION promote_candidate_to_elected[\s\S]*?AS \$\$/);
  assert.ok(m, "function header not found");
  assert.doesNotMatch(m[0], /\bSET\s+\w+\s*=/, "a proconfig SET cannot bound this and blocks COMMIT");
});

test("FIX-1279: the six identity fields read the elected row first; full_name is written", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  for (const col of ["full_name", "first_name", "last_name", "district_name", "photo_url", "website_url"]) {
    assert.match(
      src,
      new RegExp(`^\\s+${col}\\s+= COALESCE\\(e\\.${col},\\s+c\\.${col}\\),$`, "m"),
      `${col} must be COALESCE(e.${col}, c.${col}) — congress.gov is authoritative for a sitting member`,
    );
    assert.doesNotMatch(src, new RegExp(`COALESCE\\(c\\.${col},`), `${col}: the candidate-first form is the FIX-1279 bug`);
  }
});

test("FIX-1279: party and the term dates stay candidate-first (out of scope)", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  for (const col of ["party", "term_start", "term_end"]) {
    assert.match(src, new RegExp(`^\\s+${col}\\s+= COALESCE\\(c\\.${col},\\s+e\\.${col}\\),$`, "m"), col);
  }
});

test("FIX-1278: the retired id is recorded BEFORE the elected row is deleted", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const del = src.indexOf("DELETE FROM officials WHERE id = p_elected_id;");
  const repoint = src.indexOf(
    "UPDATE public.official_redirects SET new_id = p_candidate_id, merged_at = now()\n    WHERE new_id = p_elected_id;",
  );
  const record = src.indexOf(
    "INSERT INTO public.official_redirects (old_id, new_id, reason)\n    VALUES (p_elected_id, p_candidate_id, 'promotion')",
  );
  assert.ok(del > 0, "the DELETE FROM officials line is gone");
  assert.ok(repoint > 0, "the chain-collapse UPDATE is missing — a redirect to the deleted row would dangle");
  assert.ok(record > 0, "the INSERT of the retired id is missing — its page 404s");
  assert.ok(repoint < record && record < del, "re-point, then record, then delete — in that order");
});

test("FIX-1279: the migration is the newest definition of the function", () => {
  // Pinning a superseded file would leave the anchors guarding a body prod no
  // longer runs. Any later CREATE OR REPLACE must move MIGRATION with it.
  const dir = path.dirname(MIGRATION);
  const definers = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /CREATE OR REPLACE FUNCTION (public\.)?promote_candidate_to_elected\s*\(/.test(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort();
  assert.equal(definers[definers.length - 1], path.basename(MIGRATION));
});

// ---------------------------------------------------------------------------
// Behavioural anchor — skipped when no database is reachable.
// ---------------------------------------------------------------------------

const LOCAL_DB =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type Case = {
  name:    string;
  elected: Record<string, unknown>;
  cand:    Record<string, unknown>;
  expect:  { live: string; prior: string[] | null };
};

const CASES: Case[] = [
  {
    // The Mark Harris shape, exactly: two H-prefix ids for two NC districts.
    name:    "elected holds a different id — candidate's wins, elected's is filed as prior",
    elected: { congress_gov: "X000001", fec_candidate_id: "H4XX08066" },
    cand:    { fec_candidate_id: "H6XX09200" },
    expect:  { live: "H6XX09200", prior: ["H4XX08066"] },
  },
  {
    name:    "elected holds no id — nothing is appended",
    elected: { congress_gov: "X000002" },
    cand:    { fec_candidate_id: "S4XX00555" },
    expect:  { live: "S4XX00555", prior: null },
  },
  {
    name:    "both hold the same id — no self-append",
    elected: { congress_gov: "X000003", fec_candidate_id: "S0XX00137" },
    cand:    { fec_candidate_id: "S0XX00137" },
    expect:  { live: "S0XX00137", prior: null },
  },
  {
    // The concatenation would silently drop the elected row's own prior array
    // whenever the candidate has one too, and the elected row is deleted.
    name:    "both carry prior arrays — the union survives",
    elected: { congress_gov: "X000004", fec_candidate_id: "H8XX03238", prior_fec_candidate_ids: ["H0XX27085"] },
    cand:    { fec_candidate_id: "S4XX00282", prior_fec_candidate_ids: ["S8XX00210"] },
    expect:  { live: "S4XX00282", prior: ["S8XX00210", "H0XX27085", "H8XX03238"] },
  },
];

test("FIX-1195: promote_candidate_to_elected keeps every id it touches", async (t) => {
  const client = new Client({ connectionString: LOCAL_DB, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    t.skip("no database reachable — behavioural half skipped (source anchors above still ran)");
    return;
  }
  try {
    await client.query("BEGIN");
    const jur = await client.query<{ id: string }>("SELECT id FROM jurisdictions LIMIT 1");
    const jurisdictionId = jur.rows[0]?.id;
    assert.ok(jurisdictionId, "no jurisdictions row to hang the fixtures off");

    for (const c of CASES) {
      const ins = async (tier: string, role: string, src: Record<string, unknown>) =>
        (await client.query<{ id: string }>(
          `INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
          [jurisdictionId, `FIX1195 ${c.name}`, role, tier, JSON.stringify(src)],
        )).rows[0]!.id;

      const electedId = await ins("elected", "Representative", c.elected);
      const candId    = await ins("candidate", "Candidate for Representative", c.cand);

      await client.query("SELECT public.promote_candidate_to_elected($1, $2)", [electedId, candId]);

      const after = await client.query<{ source_ids: Record<string, unknown> }>(
        "SELECT source_ids FROM officials WHERE id = $1", [candId],
      );
      const src = after.rows[0]!.source_ids;

      assert.equal(src["fec_candidate_id"], c.expect.live, `${c.name}: live id`);
      if (c.expect.prior === null) {
        assert.equal(src["prior_fec_candidate_ids"], undefined, `${c.name}: no prior array`);
      } else {
        assert.deepEqual(src["prior_fec_candidate_ids"], c.expect.prior, `${c.name}: priors`);
      }
      assert.equal(src["merged_fec_candidate_ids"], undefined, `${c.name}: nothing retired`);

      const gone = await client.query("SELECT 1 FROM officials WHERE id = $1", [electedId]);
      assert.equal(gone.rowCount, 0, `${c.name}: the elected row is deleted`);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});

// FIX-1279 — the cc-194 shape: the survivor is the FEC candidate stub, whose
// name fields are the FEC legal name ("ASHLEY ARENHOLZ", district "02"). For a
// sitting member congress.gov is authoritative, so the six identity fields read
// the elected row first. The FIX-1195 invariant (the stub's own live id) holds.
test("FIX-1279: the survivor adopts the elected row's name, district, photo and website", async (t) => {
  const client = new Client({ connectionString: LOCAL_DB, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    t.skip("no database reachable — behavioural half skipped (source anchors above still ran)");
    return;
  }
  try {
    await client.query("BEGIN");
    const jur = await client.query<{ id: string }>("SELECT id FROM jurisdictions LIMIT 1");
    const jurisdictionId = jur.rows[0]?.id;
    assert.ok(jurisdictionId, "no jurisdictions row to hang the fixtures off");

    const ins = async (row: Record<string, unknown>) =>
      (await client.query<{ id: string }>(
        `INSERT INTO officials (jurisdiction_id, full_name, first_name, last_name, district_name,
                                photo_url, website_url, role_title, tier, source_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
        [jurisdictionId, row["full_name"], row["first_name"], row["last_name"], row["district_name"],
         row["photo_url"], row["website_url"], row["role_title"], row["tier"], JSON.stringify(row["source_ids"])],
      )).rows[0]!.id;

    const electedId = await ins({
      full_name: "Ashley Hinson", first_name: "Ashley", last_name: "Hinson", district_name: "District 2",
      photo_url: "https://e.example/hinson.jpg", website_url: "https://e.example",
      role_title: "Representative", tier: "elected", source_ids: { congress_gov: "X001279" },
    });
    const candId = await ins({
      full_name: "ASHLEY ARENHOLZ", first_name: "ASHLEY", last_name: "ARENHOLZ", district_name: "02",
      photo_url: null, website_url: null,
      role_title: "Candidate for Representative", tier: "candidate", source_ids: { fec_candidate_id: "H2XX02279" },
    });

    await client.query("SELECT public.promote_candidate_to_elected($1, $2)", [electedId, candId]);

    const after = await client.query<Record<string, unknown>>(
      `SELECT full_name, first_name, last_name, district_name, photo_url, website_url, tier, source_ids
         FROM officials WHERE id = $1`,
      [candId],
    );
    const r = after.rows[0]!;
    assert.equal(r["full_name"], "Ashley Hinson", "full_name");
    assert.equal(r["first_name"], "Ashley", "first_name");
    assert.equal(r["last_name"], "Hinson", "last_name");
    assert.equal(r["district_name"], "District 2", "district_name");
    assert.equal(r["photo_url"], "https://e.example/hinson.jpg", "photo_url");
    assert.equal(r["website_url"], "https://e.example", "website_url");
    assert.equal(r["tier"], "elected");
    const src = r["source_ids"] as Record<string, unknown>;
    assert.equal(src["fec_candidate_id"], "H2XX02279", "the survivor keeps its own live id (FIX-1195)");
    assert.equal(src["congress_gov"], "X001279");
    const gone = await client.query("SELECT 1 FROM officials WHERE id = $1", [electedId]);
    assert.equal(gone.rowCount, 0, "the elected row is deleted");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});

// FIX-1278 — the deleted id gets a forwarding address, and an older redirect
// that pointed AT the deleted row is re-pointed to the survivor, so the table
// stays single-hop and the edge never walks a chain.
test("FIX-1278: the promotion records the retired id and collapses chains", async (t) => {
  const client = new Client({ connectionString: LOCAL_DB, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    t.skip("no database reachable — behavioural half skipped (source anchors above still ran)");
    return;
  }
  try {
    await client.query("BEGIN");
    const jur = await client.query<{ id: string }>("SELECT id FROM jurisdictions LIMIT 1");
    const jurisdictionId = jur.rows[0]?.id;
    assert.ok(jurisdictionId, "no jurisdictions row to hang the fixtures off");

    const ins = async (tier: string, role: string, src: Record<string, unknown>) =>
      (await client.query<{ id: string }>(
        `INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
         VALUES ($1, 'FIX1278 chain', $2, $3, $4::jsonb) RETURNING id`,
        [jurisdictionId, role, tier, JSON.stringify(src)],
      )).rows[0]!.id;

    const electedId = await ins("elected", "Representative", { congress_gov: "X001278" });
    const candId    = await ins("candidate", "Candidate for Representative", { fec_candidate_id: "H2XX01278" });

    // An id retired by some earlier merge, forwarding to the row about to go.
    const earlier = (await client.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
    await client.query(
      "INSERT INTO public.official_redirects (old_id, new_id, reason) VALUES ($1, $2, 'test:earlier')",
      [earlier, electedId],
    );

    await client.query("SELECT public.promote_candidate_to_elected($1, $2)", [electedId, candId]);

    const rows = (await client.query<{ old_id: string; new_id: string; reason: string }>(
      `SELECT old_id, new_id, reason FROM public.official_redirects
        WHERE old_id = ANY($1::uuid[]) OR new_id = ANY($1::uuid[]) ORDER BY reason`,
      [[electedId, candId, earlier]],
    )).rows;
    assert.deepEqual(rows, [
      { old_id: electedId, new_id: candId, reason: "promotion" },
      { old_id: earlier,   new_id: candId, reason: "test:earlier" },
    ], "exactly the retired id -> survivor, plus the earlier redirect re-pointed (no row targets the deleted id)");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});
