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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..", "..",
  "supabase", "migrations", "20260919000000_fix1195_promote_rpc_precedence.sql",
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
