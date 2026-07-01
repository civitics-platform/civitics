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
