/**
 * FIX-663 investigation harness (read-only).
 *
 * Re-creates the FIX-661 EXPLAIN harness to sweep the sibling consolidated-page
 * RPCs for the same `from_type='agency' AND relationship_type IN
 * ('contract','grant')` top-N-by-amount spend pattern that bit
 * get_jurisdiction_page:
 *
 *   * get_agency_page.spend     — SINGLE from_id (fr.from_id = p_id)
 *   * get_official_page.spending— GLOBAL top-10 (NO from_id / from_type filter)
 *   * get_gb_page               — no financial_relationships section (control)
 *
 * Runs EXPLAIN (ANALYZE, BUFFERS) of each spend section's exact body, bound to
 * the heaviest real id, over a direct read-only pg.Client. EXPLAIN ANALYZE on a
 * SELECT executes the plan but writes nothing. One script, one run = one
 * approval.
 *
 * Run against prod:
 *   pnpm --filter @civitics/data exec tsx \
 *     --env-file=<ABS>/.env.local.prod \
 *     <ABS>/packages/data/src/scripts/explain-spend-variants.ts
 */
import { buildDbUrl } from "../lib/heavy-rebuild";

async function main() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  try {
    // Read-only: a generous timeout so a catastrophic plan still completes and
    // reports its true ms rather than dying at a cap.
    await client.query("SET statement_timeout = '600s'");

    const section = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
    const explain = async (label: string, sql: string, params: unknown[] = []) => {
      console.log(`\n--- ${label} ---`);
      try {
        const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${sql}`, params);
        console.log(res.rows.map((r) => r["QUERY PLAN"]).join("\n"));
      } catch (e) {
        console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    // ── Indexes currently on financial_relationships ────────────────────────
    section("Indexes on public.financial_relationships");
    const idx = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename='financial_relationships'
       ORDER BY indexname`,
    );
    for (const r of idx.rows) console.log(`${r.indexname}\n   ${r.indexdef}`);

    // ── Heaviest agencies by contract/grant row count ───────────────────────
    section("Top-5 agencies by contract/grant relationship count");
    const heavy = await client.query<{ from_id: string; c: string }>(
      `SELECT from_id, count(*) c
       FROM public.financial_relationships
       WHERE from_type='agency' AND relationship_type IN ('contract','grant')
       GROUP BY from_id ORDER BY c DESC LIMIT 5`,
    );
    for (const r of heavy.rows) console.log(`${r.from_id}  ${r.c}`);
    const heavyAgency = heavy.rows[0]?.from_id;
    console.log(`\nheaviest agency from_id = ${heavyAgency}`);

    // Total contract/grant rows across ALL from_types (the official global scan).
    const totalCG = await client.query<{ c: string }>(
      `SELECT count(*) c FROM public.financial_relationships
       WHERE relationship_type IN ('contract','grant')`,
    );
    console.log(`total contract/grant rows (all from_types) = ${totalCG.rows[0]?.c}`);

    // ── get_agency_page.spend — SINGLE from_id ──────────────────────────────
    section("get_agency_page.spend — single from_id, current ORDER BY DESC (NULLS FIRST)");
    await explain(
      "current: ORDER BY amount_cents DESC  (NULLS FIRST — index is NULLS LAST)",
      `SELECT
         COALESCE(fe.display_name, fe.canonical_name, 'Unknown recipient') AS recipient_name,
         fr.relationship_type AS award_type,
         COALESCE(fr.amount_cents, 0) AS amount_cents,
         fr.occurred_at AS award_date
       FROM public.financial_relationships fr
       LEFT JOIN public.financial_entities fe
         ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
       WHERE fr.relationship_type IN ('contract', 'grant')
         AND fr.from_type = 'agency'
         AND fr.from_id = $1
       ORDER BY fr.amount_cents DESC
       LIMIT 100`,
      [heavyAgency],
    );
    await explain(
      "candidate: ORDER BY amount_cents DESC NULLS LAST  (matches FIX-661 index)",
      `SELECT
         COALESCE(fe.display_name, fe.canonical_name, 'Unknown recipient') AS recipient_name,
         fr.relationship_type AS award_type,
         COALESCE(fr.amount_cents, 0) AS amount_cents,
         fr.occurred_at AS award_date
       FROM public.financial_relationships fr
       LEFT JOIN public.financial_entities fe
         ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
       WHERE fr.relationship_type IN ('contract', 'grant')
         AND fr.from_type = 'agency'
         AND fr.from_id = $1
       ORDER BY fr.amount_cents DESC NULLS LAST
       LIMIT 100`,
      [heavyAgency],
    );

    // ── get_official_page.spending — GLOBAL top-10 ──────────────────────────
    section("get_official_page.spending — GLOBAL top-10, no from_id/from_type filter");
    await explain(
      "current: global ORDER BY amount_cents DESC LIMIT 10 (amount_cents > 0)",
      `SELECT fr.id,
         coalesce(fe.display_name, 'Unknown recipient') AS recipient_name,
         fr.relationship_type AS award_type,
         coalesce(fr.amount_cents, 0) AS amount_cents,
         fr.occurred_at AS award_date,
         (fr.metadata->>'description') AS description,
         coalesce(ag.name, 'Unknown agency') AS awarding_agency
       FROM public.financial_relationships fr
       LEFT JOIN public.agencies ag ON ag.id = fr.from_id
       LEFT JOIN public.financial_entities fe ON fe.id = fr.to_id
       WHERE fr.relationship_type IN ('contract', 'grant')
         AND fr.amount_cents > 0
       ORDER BY fr.amount_cents DESC
       LIMIT 10`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
