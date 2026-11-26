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
// FIX-1195 body verbatim apart from the six identity fields, FIX-1278
// (20261006010000) re-states the FIX-1279 body verbatim plus the two
// official_redirects statements, and FIX-1427 (20261126005000) re-states the
// FIX-1278 body verbatim plus the data_flags block, so the earlier anchors
// below read it unchanged.
const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..", "..",
  "supabase", "migrations", "20261126005000_fix1427_promote_moves_data_flags.sql",
);
const PRIOR = path.join(path.dirname(MIGRATION), "20261006010000_fix1278_official_redirects.sql");
const REVERT = path.join(path.dirname(MIGRATION), "..", "..", "scripts", "fix1427-revert-promote-data-flags.sql");

/** The function's dollar-quoted body text, from its CREATE OR REPLACE to `END $$;`. */
function fnText(src: string): string {
  const a = src.indexOf("CREATE OR REPLACE FUNCTION promote_candidate_to_elected(");
  assert.notEqual(a, -1, "no CREATE OR REPLACE FUNCTION promote_candidate_to_elected(");
  const b = src.indexOf("\nEND $$;", a);
  assert.notEqual(b, -1, "no END $$;");
  return src.slice(a, b + "\nEND $$;".length);
}

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

test("FIX-1427: the body is FIX-1278's verbatim plus the one data_flags block; the revert is FIX-1278's verbatim", () => {
  const now = fnText(fs.readFileSync(MIGRATION, "utf8"));
  const prior = fnText(fs.readFileSync(PRIOR, "utf8"));
  const anchor = "  -- Derived, self-healing surfaces:";
  const at = now.indexOf("  -- FIX-1427: data_flags (FIX-401)");
  const end = now.indexOf(anchor);
  assert.ok(at > 0 && end > at, "the block sits before the derived surfaces");
  assert.equal(now.slice(0, at) + now.slice(end), prior, "nothing outside the block changed");
  const block = now.slice(at, end);
  // The candidate wins a collision (as user_follows), behind an EXISTS: service_role has no DELETE on data_flags.
  assert.match(block, /IF EXISTS \(SELECT 1 FROM data_flags e[\s\S]*?\) THEN\n {4}DELETE FROM data_flags e\n {5}USING data_flags c\n/);
  assert.match(block, /AND c\.flagger_user_id = e\.flagger_user_id\n\s+AND c\.reason = e\.reason;\n {2}END IF;/);
  assert.ok(block.includes("  UPDATE data_flags SET entity_id = p_candidate_id\n    WHERE entity_type = 'official' AND entity_id = p_elected_id;\n"));
  assert.equal(fnText(fs.readFileSync(REVERT, "utf8")), prior, "the revert restores the prior body verbatim");
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

// FIX-1427 — a data flag on the retired id moves to the survivor; on a
// collision (one reader, one reason, both rows) the candidate's row wins; a
// flag of another entity_type that happens to carry the same uuid is left; the
// redirect row is still filed. A service_role caller still promotes when no
// flag collides (it holds no DELETE on data_flags, so the DELETE runs only on
// a real collision).
test("FIX-1427: the promotion moves data_flags, the candidate's row winning a collision", async (t) => {
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
    // A flagger under the 20-a-day cap (the BEFORE INSERT trigger counts the last 24 hours).
    const flagger = (await client.query<{ id: string }>(
      `SELECT u.id FROM public.users u
        WHERE (SELECT count(*) FROM public.data_flags d
                WHERE d.flagger_user_id = u.id AND d.created_at > now() - interval '24 hours') < 10
        ORDER BY u.id LIMIT 1`,
    )).rows[0]?.id;
    if (!flagger) {
      t.skip("no users row to flag with");
      return;
    }

    const ins = async (tier: string, role: string, src: Record<string, unknown>) =>
      (await client.query<{ id: string }>(
        `INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
         VALUES ($1, 'FIX1427 flags', $2, $3, $4::jsonb) RETURNING id`,
        [jurisdictionId, role, tier, JSON.stringify(src)],
      )).rows[0]!.id;
    const flag = async (entityType: string, entityId: string, reason: string) =>
      (await client.query<{ id: string }>(
        `INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [entityType, entityId, reason, flagger],
      )).rows[0]!.id;

    const electedId = await ins("elected", "Representative", { congress_gov: "X001427" });
    const candId    = await ins("candidate", "Candidate for Representative", { fec_candidate_id: "H2XX01427" });

    const moves     = await flag("official", electedId, "misspelled");   // no twin → moves
    const loser     = await flag("official", electedId, "wrong");        // twin on the candidate → deleted
    const winner    = await flag("official", candId,    "wrong");        // the candidate's → kept
    const otherType = await flag("proposal", electedId, "outdated");     // not an official ref → untouched

    const res = (await client.query<{ r: { total_fks_moved: number } }>(
      "SELECT public.promote_candidate_to_elected($1, $2) AS r", [electedId, candId],
    )).rows[0]!.r;
    assert.ok(res.total_fks_moved >= 1, "the moved flag is counted");

    const rows = (await client.query<{ id: string; entity_type: string; entity_id: string; reason: string }>(
      "SELECT id, entity_type, entity_id, reason FROM public.data_flags WHERE id = ANY($1::uuid[]) ORDER BY reason",
      [[moves, loser, winner, otherType]],
    )).rows;
    assert.deepEqual(rows, [
      { id: moves,     entity_type: "official", entity_id: candId,    reason: "misspelled" },
      { id: otherType, entity_type: "proposal", entity_id: electedId, reason: "outdated" },
      { id: winner,    entity_type: "official", entity_id: candId,    reason: "wrong" },
    ], "moved, untouched, and the candidate's row kept; the elected's colliding row is gone");
    const orphans = await client.query(
      "SELECT 1 FROM public.data_flags WHERE entity_type = 'official' AND entity_id = $1", [electedId],
    );
    assert.equal(orphans.rowCount, 0, "no official flag keeps the retired id");

    const redirect = await client.query<{ new_id: string; reason: string }>(
      "SELECT new_id, reason FROM public.official_redirects WHERE old_id = $1", [electedId],
    );
    assert.deepEqual(redirect.rows, [{ new_id: candId, reason: "promotion" }], "the redirect is still filed");

    // service_role, no colliding flag: the guarded DELETE never executes, so the promotion runs.
    const e2 = await ins("elected", "Representative", { congress_gov: "X001428" });
    const c2 = await ins("candidate", "Candidate for Representative", { fec_candidate_id: "H2XX01428" });
    const f2 = await flag("official", e2, "other");
    await client.query("SAVEPOINT sr");
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SELECT public.promote_candidate_to_elected($1, $2)", [e2, c2]);
    await client.query("RESET ROLE");
    const moved2 = await client.query<{ entity_id: string }>("SELECT entity_id FROM public.data_flags WHERE id = $1", [f2]);
    assert.equal(moved2.rows[0]?.entity_id, c2, "service_role promotes and moves the flag");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});
