/**
 * FIX-1195 — restore CAND_IDs that promote_candidate_to_elected() erased.
 *
 * WHAT WENT WRONG. The promotion merged source_ids as
 * `(c.source_ids || e.source_ids)`, and jsonb concatenation keeps the RIGHT
 * operand on key conflict. So the DELETED elected row's `fec_candidate_id`
 * overwrote the SURVIVING candidate row's own, on every promotion the nightly
 * ever ran. Migration 20260919000000 fixes the function; this script repairs
 * the three rows it already destroyed on prod on 2026-09-17.
 *
 * WHY IT IS TIME-BOXED. An unheld CAND_ID is re-minted: the cn{yy} stage of the
 * weekly FEC drop creates a fresh candidate stub for any id no officials row
 * claims. The next drop is Sunday 2026-09-20 22:44 UTC.
 *
 * WHY prior_fec_candidate_ids. Only two arrays keep a CLAIM —
 * `fec_candidate_id` and `prior_fec_candidate_ids` — because
 * `authoritativeClaims()` is the union of exactly those two, and that function
 * is what both `buildMatchIndex` pass 1 and `loadOfficialsByFecIds` read.
 * `merged_fec_candidate_ids` is the RETIRED marker and is filtered OUT of
 * authoritativeClaims by design (FIX-955), so an id filed there is claimed by
 * nobody and gets re-minted anyway. Retirement is only safe where a merge puts
 * it — on a stub, while the survivor holds the id live.
 *
 * SAFETY. One transaction. Every UPDATE is keyed by UUID *and* asserts the row's
 * current live `fec_candidate_id` in its WHERE, so a row that moved since the
 * manifest's census matches zero rows and the whole run rolls back. Before any
 * write it re-reads the holder census and refuses unless every id to restore has
 * ZERO holders on every surface — restoring an id that something else now claims
 * would manufacture a double-claim, which is the FIX-1019 defect.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:fec:restore-ids:prod -- \
 *     --manifest ../../docs/audits/2026-09-18-fix1195-restore-manifest.tsv
 *   …same, plus --apply, to write.
 *
 * Without --apply it prints the plan and the census and writes nothing.
 */

import { Client } from "pg";
import { constructDbUrlFromEnv, envLabel } from "./fec-orphan-classify";
import { readManifest, type ManifestRow } from "./remediation-manifest";
import { runUnderProdSession } from "../lib/prod-session";

const PRIOR_KEY = "prior_fec_candidate_ids";
const LIVE_KEY  = "fec_candidate_id";

interface Plan {
  uuid:     string;
  key:      string;
  restore:  string;
  expected: string;
  official: string;
  note:     string;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parsePlans(rows: ManifestRow[], file: string): Plan[] {
  const out: Plan[] = [];
  for (const r of rows) {
    const uuid     = (r["uuid"] ?? "").trim();
    const key      = (r["key"] ?? "").trim();
    const restore  = (r["restore_id"] ?? "").trim();
    const expected = (r["expected_current_live_id"] ?? "").trim();
    if (!uuid || !key || !restore || !expected) {
      throw new Error(`${file}: a row is missing one of uuid / key / restore_id / expected_current_live_id`);
    }
    if (key !== PRIOR_KEY && key !== LIVE_KEY) {
      throw new Error(`${file}: key must be ${LIVE_KEY} or ${PRIOR_KEY}, got "${key}"`);
    }
    if (!/^[HSP][0-9A-Z]{8}$/.test(restore)) {
      throw new Error(`${file}: "${restore}" is not a CAND_ID`);
    }
    out.push({ uuid, key, restore, expected, official: r["official"] ?? "", note: r["note"] ?? "" });
  }
  if (out.length === 0) throw new Error(`${file}: no rows`);
  return out;
}

/**
 * Every surface an id can be claimed on. `authoritativeClaims` reads the first
 * two; the merged pair and `fec_id` are read here so "zero holders" means zero
 * ANYWHERE, not just zero where it would have counted.
 */
const CENSUS_SQL = `
  SELECT $1::text AS cand_id,
         (SELECT count(*) FROM officials o WHERE o.source_ids->>'fec_candidate_id' = $1)        AS live,
         (SELECT count(*) FROM officials o WHERE o.source_ids->'prior_fec_candidate_ids' ? $1)  AS prior,
         (SELECT count(*) FROM officials o
           WHERE o.source_ids->'merged_fec_candidate_ids' ? $1
              OR o.source_ids->>'merged_fec_candidate_id' = $1)                                 AS merged,
         (SELECT count(*) FROM officials o WHERE o.source_ids->>'fec_id' = $1)                   AS fec_id`;

/**
 * The SQL mirror of `authoritativeClaims()`: fec_candidate_id plus
 * prior_fec_candidate_ids, MINUS anything the SAME row has retired (FIX-955).
 *
 * This, not the all-surfaces census above, is what "has a holder" means AFTER a
 * write. A retired marker on some OTHER row is not a claim — it is the correct
 * post-merge shape, a stub recording the id it gave up while the survivor holds
 * it live. Counting those as holders reports a correct restore as a failure,
 * which is exactly what the first prod run did on 2026-09-18: all three ids
 * restored to exactly one authoritative holder each, and the check called it
 * "2 holders" because set 1's merge stubs still carry the retired markers.
 *
 * COALESCE on the scalar comparison is load-bearing: `NULL = 'X'` is NULL, so a
 * bare `NOT (… OR …)` evaluates to NULL and drops every row.
 */
const AUTH_CENSUS_SQL = `
  SELECT $1::text AS cand_id,
         count(*) AS holders,
         COALESCE(string_agg(t.name || ' [' || t.tier || ']', ', '), '(none)') AS who
    FROM (
      SELECT o.id, o.tier, o.full_name AS name
        FROM officials o,
             LATERAL (
               SELECT o.source_ids->>'fec_candidate_id' AS c
               UNION ALL
               SELECT jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(o.source_ids->'prior_fec_candidate_ids') = 'array'
                             THEN o.source_ids->'prior_fec_candidate_ids' ELSE '[]'::jsonb END)
             ) x
       WHERE x.c = $1::text
         AND NOT (
           COALESCE(o.source_ids->'merged_fec_candidate_ids', '[]'::jsonb) ? x.c
           OR COALESCE(o.source_ids->>'merged_fec_candidate_id' = x.c, false)
         )
    ) t`;

async function authCensus(client: Client, ids: string[]) {
  const rows: Array<{ cand_id: string; holders: string; who: string }> = [];
  for (const id of ids) {
    const r = await client.query(AUTH_CENSUS_SQL, [id]);
    rows.push(r.rows[0]);
  }
  return rows;
}

async function census(client: Client, ids: string[]) {
  const rows: Array<{ cand_id: string; live: string; prior: string; merged: string; fec_id: string }> = [];
  for (const id of ids) {
    const r = await client.query(CENSUS_SQL, [id]);
    rows.push(r.rows[0]);
  }
  return rows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const manifestPath = argValue("--manifest");
  const env = envLabel();

  if (!manifestPath) {
    console.error("✗ --manifest <file> is required. This script only ever applies a REVIEWED file.");
    process.exit(2);
  }
  const manifest = readManifest(manifestPath);
  const plans = parsePlans(manifest.rows, manifestPath);

  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("✗ no database URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD");
    process.exit(2);
  }

  console.log(`\nFIX-1195 restore — target ${env.toUpperCase()}, manifest ${manifestPath}`);
  console.log(`${plans.length} row(s), ${apply ? "APPLY" : "DRY RUN (nothing is written)"}\n`);
  for (const c of manifest.comments.slice(0, 3)) console.log(`  ${c}`);
  console.log();

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // ── Pre-write census. Refuse unless every id is unheld everywhere. ──────
    console.log("── Holder census BEFORE ─────────────────────────────────");
    const before = await census(client, plans.map((p) => p.restore));
    let held = 0;
    for (const r of before) {
      const n = Number(r.live) + Number(r.prior) + Number(r.merged) + Number(r.fec_id);
      if (n > 0) held++;
      console.log(
        `  ${r.cand_id}  live=${r.live} prior=${r.prior} merged=${r.merged} fec_id=${r.fec_id}` +
        (n > 0 ? "   ← ALREADY HELD" : ""),
      );
    }
    if (held > 0) {
      console.error(
        `\n✗ REFUSED — ${held} id(s) already have a holder. Restoring one would create a\n` +
        `  double claim (the FIX-1019 defect). Re-derive the manifest before retrying.`,
      );
      process.exit(2);
    }
    console.log("  ✓ all ids unheld on every surface\n");

    if (!apply) {
      console.log("── Plan ─────────────────────────────────────────────────");
      for (const p of plans) {
        console.log(`  ${p.uuid}  ${p.official}`);
        console.log(`    ${p.key} <- ${p.restore}   (asserts live id is currently ${p.expected})`);
        if (p.key === LIVE_KEY) console.log(`    …and ${p.expected} moves into ${PRIOR_KEY}`);
        if (p.note) console.log(`    ${p.note}`);
      }
      console.log("\nDRY RUN — re-run with --apply to write.");
      return;
    }

    // ── The write. ONE transaction; every UPDATE asserts the live id. ───────
    console.log("── Applying ─────────────────────────────────────────────");
    await client.query("BEGIN");
    try {
      for (const p of plans) {
        // Append `restore` to prior_fec_candidate_ids, deduped. When the
        // manifest's key is fec_candidate_id, `restore` becomes the live id and
        // the id it displaces (`expected`) is what goes to prior instead.
        const toPrior = p.key === LIVE_KEY ? p.expected : p.restore;
        const newLive = p.key === LIVE_KEY ? p.restore : null;

        const sql = `
          UPDATE officials SET
            source_ids = (
              CASE WHEN $3::text IS NULL THEN source_ids
                   ELSE jsonb_set(source_ids, '{fec_candidate_id}', to_jsonb($3::text), true)
              END
            ) || jsonb_build_object(
              '${PRIOR_KEY}',
              CASE
                WHEN jsonb_typeof(source_ids->'${PRIOR_KEY}') = 'array'
                     AND source_ids->'${PRIOR_KEY}' @> to_jsonb($4::text)
                  THEN source_ids->'${PRIOR_KEY}'
                WHEN jsonb_typeof(source_ids->'${PRIOR_KEY}') = 'array'
                  THEN source_ids->'${PRIOR_KEY}' || to_jsonb($4::text)
                ELSE jsonb_build_array($4::text)
              END
            ),
            updated_at = now()
          WHERE id = $1::uuid
            AND source_ids->>'fec_candidate_id' = $2::text
          RETURNING id, full_name, role_title, source_ids`;

        const res = await client.query(sql, [p.uuid, p.expected, newLive, toPrior]);
        if (res.rowCount !== 1) {
          throw new Error(
            `${p.uuid} (${p.official}) matched ${res.rowCount} rows — its live ` +
            `fec_candidate_id is no longer "${p.expected}". Nothing is written.`,
          );
        }
        const row = res.rows[0];
        console.log(`  ✓ ${row.full_name} (${row.role_title})`);
        console.log(`      ${JSON.stringify(row.source_ids)}`);
      }
      await client.query("COMMIT");
      console.log("\n  COMMITTED\n");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`\n✗ ROLLED BACK — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }

    // ── Post-write census. Every id must now have exactly ONE AUTHORITATIVE
    // holder — see AUTH_CENSUS_SQL for why a retired marker elsewhere is not one.
    console.log("── Authoritative holders AFTER ──────────────────────────");
    let bad = 0;
    const check = async (ids: string[], label: string) => {
      console.log(`  ${label}`);
      for (const r of await authCensus(client, ids)) {
        const n = Number(r.holders);
        if (n !== 1) bad++;
        console.log(`    ${r.cand_id}  holders=${n}  ${r.who}` + (n === 1 ? "   ✓" : "   ← expected 1"));
      }
    };
    await check(plans.map((p) => p.restore),  "restored ids:");
    await check(plans.map((p) => p.expected), "previously-live ids (must be untouched):");

    // Informational: retired markers are the correct post-merge shape and are
    // reported, never counted.
    const retired = await client.query(
      `SELECT o.full_name, o.tier, o.source_ids->'merged_fec_candidate_ids' AS retired
         FROM officials o
        WHERE o.source_ids->'merged_fec_candidate_ids' ?| $1::text[]`,
      [plans.map((p) => p.expected)],
    );
    if (retired.rowCount) {
      console.log("\n  retired markers on other rows (expected — set 1's merge stubs):");
      for (const r of retired.rows) console.log(`    ${r.full_name} [${r.tier}] ${JSON.stringify(r.retired)}`);
    }

    if (bad > 0) {
      console.error(`\n✗ ${bad} id(s) do NOT have exactly one authoritative holder. Investigate.`);
      process.exit(2);
    }
    console.log("\n  ✓ every id has exactly one authoritative holder\n");
  } finally {
    await client.end().catch(() => {});
  }
}

// FIX-950 — the supervised-session interlock; see merge-same-person-official-dupes.ts's tail.
runUnderProdSession({ script: "restore-fec-ids", expectedMinutes: 5 }, main).catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
