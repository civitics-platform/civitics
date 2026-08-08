/**
 * FIX-975 — the first OWNED vacuum of public.financial_entities, plus the
 * before/after measurement that is the acceptance criterion.
 *
 * WHY THIS SCRIPT EXISTS (and why it is not "just run VACUUM"):
 * `financial_entities` is the hottest table on the instance with `vacuum_count`
 * = 0 — no script, cron job or procedure has ever issued a manual VACUUM
 * against it. The 2026-08-07 efficiency audit measured the consequence on its
 * own covering index (`financial_entities_nonindividual_id`): 108,419 Heap
 * Fetches on 226,640 rows (47.8%), 47.0 s, against 4.8% on the FIX-974-owned
 * `financial_relationships` path. VACUUM cannot run inside a function or a
 * transaction block, so the 13 plpgsql functions that mass-UPDATE this table
 * structurally cannot own their own tails — ownership has to live at a call
 * layer that can issue a bare statement. This is that layer for the one-off
 * corrective pass; `vacuum-tail.ts` is that layer for the ongoing writes and
 * the `derived-table-vacuum-analyze` cron job is the backstop.
 *
 * Playbook B1 (watch relallvisible AND Heap Fetches — they disagree, and in
 * which direction matters) and B2 (a bulk rewrite owns its vacuum tail).
 *
 *   tsx --env-file=../../.env.local.prod src/scripts/fix975-vacuum-fe.ts --allow-prod
 *   tsx src/scripts/fix975-vacuum-fe.ts            # local Docker
 *
 * Non-destructive: VACUUM reclaims dead-tuple space and refreshes the
 * visibility map. It does not touch live data. Never VACUUM FULL — that takes
 * ACCESS EXCLUSIVE and rewrites the whole 2.9 GB heap.
 */

import { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";

/** Tables this pass owns. FE is the named case; the other two are the same
 *  `vacuum_count = 0` cohort the audit enumerated (74.9% / 65.0% all-visible). */
const TARGETS = [
  "public.financial_entities",
  "public.donor_party_rollup_mv",
] as const;

/** The covering index whose Heap Fetches rate is the acceptance measurement. */
const PROBE_SQL = `
  SELECT id, display_name, entity_type
  FROM public.financial_entities
  WHERE entity_type <> 'individual'
  ORDER BY id
`;

const STAT_SQL = `
  SELECT c.relname,
         c.relpages,
         c.relallvisible,
         ROUND(100.0 * c.relallvisible / NULLIF(c.relpages, 0), 1) AS pct_all_visible,
         s.n_dead_tup,
         s.n_live_tup,
         s.vacuum_count,
         s.last_vacuum
  FROM pg_class c
  JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relname = ANY($1::text[])
  ORDER BY pct_all_visible
`;

function bare(t: string): string {
  return t.replace(/^public\./, "");
}

async function stats(c: Client): Promise<Record<string, unknown>[]> {
  const res = await c.query(STAT_SQL, [TARGETS.map(bare)]);
  return res.rows as Record<string, unknown>[];
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) the covering-index path and pull out the two
 * numbers that matter. Run ONCE per phase — never twice, because the second
 * run reads a plan this script warmed itself, which is the shape that makes a
 * vacuum look like it worked when it did not.
 */
async function probe(c: Client): Promise<{ heapFetches: number; rows: number; ms: number; raw: string }> {
  const res = await c.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${PROBE_SQL}`,
  );
  const raw = res.rows.map((r) => r["QUERY PLAN"]).join("\n");
  const heap = /Heap Fetches:\s*(\d+)/.exec(raw);
  const rows = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(raw);
  const ms = /Execution Time:\s*([\d.]+)\s*ms/.exec(raw);
  return {
    heapFetches: heap ? Number(heap[1]) : NaN,
    rows: rows ? Number(rows[1]) : NaN,
    ms: ms ? Number(ms[1]) : NaN,
    raw,
  };
}

function summarize(label: string, p: { heapFetches: number; rows: number; ms: number }): void {
  const pct = p.rows > 0 ? ((100 * p.heapFetches) / p.rows).toFixed(1) : "?";
  console.log(
    `[fix975] ${label}: Heap Fetches ${p.heapFetches.toLocaleString()} / ${p.rows.toLocaleString()} rows ` +
      `= ${pct}%   Execution ${(p.ms / 1000).toFixed(1)}s`,
  );
}

async function main(): Promise<number> {
  const dsn = buildDbUrl();
  const isProd = /supabase\.co|pooler\.supabase\.com/i.test(dsn);
  const allowProd = process.argv.includes("--allow-prod");
  if (isProd && !allowProd) {
    console.error("[fix975] refusing to run against PROD without --allow-prod");
    return 1;
  }
  console.log(`[fix975] target: ${isProd ? "PROD (Supabase Pro)" : "LOCAL Docker"}`);

  const c = new Client({ connectionString: dsn });
  await c.connect();
  try {
    // A multi-GB first vacuum can run minutes. The default session timeout
    // would cancel it partway, which leaves the visibility map worse than a
    // clean skip would have.
    await c.query("SET statement_timeout = '90min'");

    console.log("[fix975] --- BEFORE ---");
    console.table(await stats(c));
    const before = await probe(c);
    summarize("BEFORE", before);

    for (const table of TARGETS) {
      const t0 = Date.now();
      // VACUUM cannot run inside a transaction block. node-postgres issues
      // simple queries in autocommit, which is what makes this legal here and
      // illegal inside the 13 plpgsql writers.
      await c.query(`VACUUM (ANALYZE) ${table}`);
      console.log(`[fix975] VACUUM (ANALYZE) ${table} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    console.log("[fix975] --- AFTER ---");
    console.table(await stats(c));
    const after = await probe(c);
    summarize("AFTER ", after);

    const bPct = (100 * before.heapFetches) / before.rows;
    const aPct = (100 * after.heapFetches) / after.rows;
    console.log(
      `[fix975] heap-fetch rate ${bPct.toFixed(1)}% -> ${aPct.toFixed(1)}%  ` +
        `(FR benchmark, owned since FIX-974: 4.8%)`,
    );
    return 0;
  } finally {
    await c.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
