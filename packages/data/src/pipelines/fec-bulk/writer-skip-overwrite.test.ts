/**
 * FIX-700 — the correctness proof for scoped-run skip-overwrite.
 *
 * This is the test that makes the whole "surgical re-run" design safe: a scoped
 * (e.g. tx-type-10-only) run must NOT overwrite an existing donor's aggregate
 * with just the slice it processed. It proves, against a real Postgres:
 *   1. A scoped upsert of an EXISTING donor leaves total_donated_cents /
 *      total_received_cents untouched.
 *   2. A scoped upsert of a NEW donor inserts cleanly at the column default (0),
 *      not an error.
 *   3. rebuild_financial_entity_donation_totals() then re-derives the correct
 *      authoritative total from live financial_relationships.
 *
 * DB integration — OPT-IN. Skipped unless RUN_DB_TESTS=1 AND local Docker
 * Postgres (127.0.0.1:54322) is reachable, so the default `pnpm test` (loop +
 * CI, which have no local DB) stays fast and green. Run the proof with:
 *
 *   RUN_DB_TESTS=1 pnpm --filter @civitics/data exec tsx --test \
 *     src/pipelines/fec-bulk/writer-skip-overwrite.test.ts
 *
 * Note: step 3 runs the FULL-table donation-totals rebuild (the same idempotent
 * recompute the pipeline runs); on a full local clone it takes a little while.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertIndividualDonorsBatch } from "./writer";
import { canonicalDonorName } from "./indiv";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const UNIQ = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryConnect(): Promise<any | null> {
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 1500 });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

test("FIX-700 scoped upsert preserves existing donor aggregates; rebuild re-derives them", async (t) => {
  if (process.env.RUN_DB_TESTS !== "1") {
    t.skip("set RUN_DB_TESTS=1 to run the local-DB skip-overwrite proof");
    return;
  }
  const client = await tryConnect();
  if (!client) {
    t.skip("local Docker Postgres (127.0.0.1:54322) not reachable");
    return;
  }

  // upsertIndividualDonorsBatch resolves its connection via buildDbUrl(); point
  // it at local for the duration of this test.
  const prevDbUrl = process.env.SUPABASE_DB_URL;
  process.env.SUPABASE_DB_URL = LOCAL_DSN;

  const existingFp = `FIXN-SKIP-EXIST-${UNIQ}|00000`;
  const existingName = `FIXNSKIP${UNIQ}, EXISTING`;
  const existingCanon = canonicalDonorName(existingName);
  const newFp = `FIXN-SKIP-NEW-${UNIQ}|00000`;
  const newName = `FIXNSKIP${UNIQ}, FRESH`;

  let existingId: string | null = null;
  const relIds: string[] = [];

  try {
    // ── Seed: an EXISTING donor with a real aggregate we must not clobber ─────
    const seed = await client.query(
      `INSERT INTO public.financial_entities
         (canonical_name, display_name, entity_type, donor_fingerprint,
          total_donated_cents, total_received_cents, metadata)
       VALUES ($1, $2, 'individual', $3, 1000000, 222, '{}'::jsonb)
       RETURNING id`,
      [existingCanon, existingName, existingFp],
    );
    existingId = seed.rows[0].id as string;

    // ── 1. Scoped upsert of the SAME donor with a SMALLER (slice) amount ──────
    await upsertIndividualDonorsBatch(
      [
        {
          fingerprint: existingFp,
          displayName: existingName,
          city: "", state: "", zip5: "00000", employer: "", occupation: "",
          totalDonatedCents: 50, // the type-10-only slice — must NOT be written
        },
      ],
      true, // skipAggregateOverwrite (scoped)
    );

    const afterExisting = await client.query(
      `SELECT total_donated_cents, total_received_cents FROM public.financial_entities WHERE id = $1`,
      [existingId],
    );
    assert.equal(
      Number(afterExisting.rows[0].total_donated_cents),
      1000000,
      "scoped upsert must preserve the existing total_donated_cents (not overwrite with the 50 slice)",
    );
    assert.equal(
      Number(afterExisting.rows[0].total_received_cents),
      222,
      "scoped upsert must preserve total_received_cents too",
    );

    // ── 2. Scoped upsert of a BRAND-NEW donor inserts cleanly at default 0 ────
    const newRes = await upsertIndividualDonorsBatch(
      [
        {
          fingerprint: newFp,
          displayName: newName,
          city: "", state: "", zip5: "00000", employer: "", occupation: "",
          totalDonatedCents: 99, // must be ignored — new row takes DEFAULT 0
        },
      ],
      true,
    );
    assert.equal(newRes.failed, 0, "new-donor scoped insert must not error");
    const newRow = await client.query(
      `SELECT total_donated_cents, total_received_cents FROM public.financial_entities WHERE donor_fingerprint = $1`,
      [newFp],
    );
    assert.equal(newRow.rows.length, 1, "new donor row was inserted");
    assert.equal(
      Number(newRow.rows[0].total_donated_cents),
      0,
      "new donor takes the column DEFAULT 0, not the ignored 99",
    );

    // ── 3. rebuild_financial_entity_donation_totals() corrects the aggregate ──
    // Give the existing donor one live donation of $7.77, then recompute.
    const rel = await client.query(
      `INSERT INTO public.financial_relationships
         (relationship_type, from_type, from_id, to_type, to_id,
          amount_cents, occurred_at, cycle_year, metadata)
       VALUES ('donation', 'financial_entity', $1, 'official', gen_random_uuid(),
               777, '2024-01-01', 2024, '{}'::jsonb)
       RETURNING id`,
      [existingId],
    );
    relIds.push(rel.rows[0].id as string);

    await client.query(`SELECT public.rebuild_financial_entity_donation_totals()`);

    const recomputed = await client.query(
      `SELECT total_donated_cents FROM public.financial_entities WHERE id = $1`,
      [existingId],
    );
    assert.equal(
      Number(recomputed.rows[0].total_donated_cents),
      777,
      "the totals rebuild re-derives the authoritative total (777) from live relationships",
    );
  } finally {
    // Best-effort cleanup — leave the local DB as we found it.
    try {
      for (const id of relIds) {
        await client.query(`DELETE FROM public.financial_relationships WHERE id = $1`, [id]);
      }
      await client.query(
        `DELETE FROM public.financial_entities WHERE donor_fingerprint IN ($1, $2)`,
        [existingFp, newFp],
      );
    } catch {
      /* best effort */
    }
    await client.end();
    if (prevDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = prevDbUrl;
  }
});

/**
 * FIX-1009 — the UNSCOPED run must not overwrite `total_donated_cents` either.
 *
 * `upsertIndividualDonorsBatch` wrote the donor's aggregate FOR THE CYCLE BEING
 * INGESTED, and `rebuild_financial_entity_donation_totals()` overwrote it
 * minutes later with the live all-cycle SUM — the authoritative value, and the
 * whole reason FIX-269 exists. So for every multi-cycle donor the pipeline wrote
 * a value it KNEW was wrong and repaired it afterwards: pure write thrash on the
 * platform's hottest table, and a hard ceiling on FIX-1008 (the stored all-cycle
 * value can never equal the cycle-only value being written, so 24.2% of donors
 * — the multi-cycle ones, per the prod sample of 2,576 — were rewritten every
 * week no matter what).
 *
 * THE SHAPE DIFFERS FROM FIX-700's ON PURPOSE. A scoped run drops the columns
 * from the INSERT list, so a new donor lands at DEFAULT 0 and waits for a
 * rebuild. An unscoped run cannot afford that wait — see the coverage-gate test
 * below — so it INSERTs the value and merely omits it from the DO UPDATE SET
 * list. New donor: real value. Existing donor: untouched.
 */
test("FIX-1009 unscoped upsert preserves an EXISTING donor's aggregate but seeds a NEW one", async (t) => {
  if (process.env.RUN_DB_TESTS !== "1") {
    t.skip("set RUN_DB_TESTS=1 to run the local-DB unscoped skip-overwrite proof");
    return;
  }
  const client = await tryConnect();
  if (!client) {
    t.skip("local Docker Postgres (127.0.0.1:54322) not reachable");
    return;
  }

  const prevDbUrl = process.env.SUPABASE_DB_URL;
  process.env.SUPABASE_DB_URL = LOCAL_DSN;

  const existingFp = `FIX1009-EXIST-${UNIQ}|00000`;
  const existingName = `FIX1009X${UNIQ}, EXISTING`;
  const newFp = `FIX1009-NEW-${UNIQ}|00000`;
  const newName = `FIX1009N${UNIQ}, FRESH`;

  try {
    // A multi-cycle donor whose stored total is the authoritative ALL-CYCLE sum.
    const seed = await client.query(
      `INSERT INTO public.financial_entities
         (canonical_name, display_name, entity_type, donor_fingerprint,
          total_donated_cents, total_received_cents, metadata)
       VALUES ($1, $2, 'individual', $3, 5000000, 4242, '{}'::jsonb)
       RETURNING id`,
      [canonicalDonorName(existingName), existingName, existingFp],
    );
    const existingId = seed.rows[0].id as string;

    // ── 1. UNSCOPED upsert with this cycle's slice — must NOT be written ──────
    await upsertIndividualDonorsBatch(
      [
        {
          fingerprint: existingFp,
          displayName: existingName,
          city: "", state: "", zip5: "00000", employer: "", occupation: "",
          totalDonatedCents: 120000, // the 2026-cycle-only slice
        },
      ],
      false, // UNSCOPED — this is the FIX-1009 path
    );

    const after = await client.query(
      `SELECT total_donated_cents, total_received_cents FROM public.financial_entities WHERE id = $1`,
      [existingId],
    );
    assert.equal(
      Number(after.rows[0].total_donated_cents),
      5000000,
      "an unscoped upsert must leave the authoritative all-cycle total alone",
    );
    assert.equal(
      Number(after.rows[0].total_received_cents),
      4242,
      "total_received_cents is pas2's column and is likewise not clobbered",
    );

    // ── 2. …but the rest of the row still updates on conflict ────────────────
    const relabelled = `${existingName} JR`;
    await upsertIndividualDonorsBatch(
      [
        {
          fingerprint: existingFp,
          displayName: relabelled,
          city: "AUSTIN", state: "TX", zip5: "00000", employer: "ACME", occupation: "ENGINEER",
          totalDonatedCents: 999,
        },
      ],
      false,
    );
    const relabel = await client.query(
      `SELECT display_name, metadata->>'employer' AS employer, total_donated_cents
         FROM public.financial_entities WHERE id = $1`,
      [existingId],
    );
    assert.equal(relabel.rows[0].display_name, relabelled, "non-aggregate columns still merge");
    assert.equal(relabel.rows[0].employer, "ACME", "metadata still merges");
    assert.equal(
      Number(relabel.rows[0].total_donated_cents),
      5000000,
      "narrowing the SET list must not be confused with DO NOTHING",
    );

    // ── 3. A BRAND-NEW donor lands with a REAL value, not DEFAULT 0 ──────────
    // This is the difference from FIX-700's scoped shape, and the reason the
    // coverage gate below matters.
    const newRes = await upsertIndividualDonorsBatch(
      [
        {
          fingerprint: newFp,
          displayName: newName,
          city: "", state: "", zip5: "00000", employer: "", occupation: "",
          totalDonatedCents: 250000,
        },
      ],
      false,
    );
    assert.equal(newRes.failed, 0, "new-donor unscoped insert must not error");
    const newRow = await client.query(
      `SELECT total_donated_cents FROM public.financial_entities WHERE donor_fingerprint = $1`,
      [newFp],
    );
    assert.equal(newRow.rows.length, 1, "new donor row was inserted");
    assert.equal(
      Number(newRow.rows[0].total_donated_cents),
      250000,
      "a NEW donor has no prior-cycle rows by construction, so the cycle total IS " +
        "their all-cycle total — it must be inserted, not defaulted to 0",
    );
  } finally {
    try {
      await client.query(
        `DELETE FROM public.financial_entities WHERE donor_fingerprint IN ($1, $2)`,
        [existingFp, newFp],
      );
    } catch {
      /* best effort */
    }
    await client.end();
    if (prevDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = prevDbUrl;
  }
});

/**
 * FIX-1009 COVERAGE GATE — the bullet's own care point, proven rather than
 * assumed: "confirm the rebuild covers every donor an unscoped run can
 * introduce, including donors whose only rows are in a cycle the rebuild's
 * predicate does not reach, otherwise a brand-new donor could sit at 0 until the
 * next full rebuild."
 *
 * Two findings, and they pull in opposite directions:
 *
 *   PASS — no cycle predicate exists. Every writer of `total_donated_cents`
 *   aggregates `financial_relationships` on
 *   `from_type='financial_entity' AND relationship_type='donation'` with NO
 *   `cycle_year` filter: `rebuild_financial_entity_donation_totals()`
 *   (20260513010000), `financial_entity_donation_totals_window()` and
 *   `reconcile_financial_entity_totals()` (20260704000000). So "a cycle the
 *   rebuild's predicate does not reach" does not exist — the coverage hole the
 *   bullet feared is not there.
 *
 *   FAIL — the CADENCE, not the predicate, is the gap. This pipeline stopped
 *   calling any donation-totals rebuild at FIX-702/726; the work moved to
 *   pg_cron. `financial-entity-totals-incremental` (Tue 09:00, the weekly
 *   dirty-set pass that would catch a new donor within days) was created PAUSED
 *   by 20260704000000 and no migration ever enabled it — measured `active=false`
 *   on the local clone 2026-08-12. Only `financial-entity-totals-reconcile`
 *   (1st of month 12:00 UTC, enabled by 20260705000200) is active.
 *
 * Hence the chosen shape: keep the INSERT value for new donors. A new donor is
 * correct on arrival and needs no rebuild at all, so the ~31-day reconcile
 * cadence stops being load-bearing for correctness.
 *
 * This test pins the PASS half — the predicate reaches a donor whose only rows
 * sit in a cycle no run touched — so a future edit that adds a cycle filter to
 * the rebuild fails here instead of silently zeroing donors.
 */
test("FIX-1009 coverage gate — the totals rebuild has no cycle predicate", async (t) => {
  if (process.env.RUN_DB_TESTS !== "1") {
    t.skip("set RUN_DB_TESTS=1 to run the local-DB coverage gate");
    return;
  }
  const client = await tryConnect();
  if (!client) {
    t.skip("local Docker Postgres (127.0.0.1:54322) not reachable");
    return;
  }

  const fp = `FIX1009-GATE-${UNIQ}|00000`;
  const name = `FIX1009G${UNIQ}, ANCIENT`;
  // Explicit id inside a deliberately sparse tail of the uuid keyspace, so the
  // window call below is a tight index probe rather than a half-table scan.
  const id = `ffffffff-ffff-4fff-8fff-${UNIQ.slice(-12).padStart(12, "0")}`;
  const WINDOW_LO = "ffffffff-ffff-4fff-8fff-000000000000";
  const WINDOW_HI = "ffffffff-ffff-4fff-9000-000000000000";
  try {
    // A donor whose ONLY donation row sits in a cycle nothing re-runs (1996 is
    // decades outside FEC_CYCLES / FEC_INDIV_CYCLES), inserted at 0 as if the
    // aggregate column had been dropped entirely.
    await client.query(
      `INSERT INTO public.financial_entities
         (id, canonical_name, display_name, entity_type, donor_fingerprint,
          total_donated_cents, total_received_cents, metadata)
       VALUES ($1, $2, $3, 'individual', $4, 0, 0, '{}'::jsonb)`,
      [id, canonicalDonorName(name), name, fp],
    );
    await client.query(
      `INSERT INTO public.financial_relationships
         (relationship_type, from_type, from_id, to_type, to_id,
          amount_cents, occurred_at, cycle_year, metadata)
       VALUES ('donation', 'financial_entity', $1, 'official', gen_random_uuid(),
               31337, '1996-05-05', 1996, '{}'::jsonb)`,
      [id],
    );

    // The window helper is the unit both the monthly reconcile and the (paused)
    // weekly incremental drive their aggregation through.
    await client.query(
      `SELECT public.financial_entity_donation_totals_window($1::uuid, $2::uuid)`,
      [WINDOW_LO, WINDOW_HI],
    );

    const got = await client.query(
      `SELECT total_donated_cents FROM public.financial_entities WHERE id = $1`,
      [id],
    );
    assert.equal(
      Number(got.rows[0].total_donated_cents),
      31337,
      "a donor whose only row is in cycle 1996 must still be re-derived — the " +
        "rebuild aggregates financial_relationships with NO cycle_year predicate",
    );
  } finally {
    try {
      await client.query(
        `DELETE FROM public.financial_relationships fr
          USING public.financial_entities fe
          WHERE fe.donor_fingerprint = $1 AND fr.from_id = fe.id`,
        [fp],
      );
      await client.query(`DELETE FROM public.financial_entities WHERE donor_fingerprint = $1`, [fp]);
    } catch {
      /* best effort */
    }
    await client.end();
  }
});
