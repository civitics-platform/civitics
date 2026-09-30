/**
 * FIX-1252 — verification harness for get_financial_entity_naics(), run against
 * the LOCAL clone. Everything happens inside ONE transaction that is rolled
 * back: the fixture rows, the reads, and the mutant redefinition. Nothing is
 * left behind.
 *
 * THE RULE. A contractor's NAICS code is the code carrying the most dollars on
 * its contract/grant rows (NULL amounts count as 0); a tie goes to the code
 * with more rows; a tie on both goes to the smaller code. Before FIX-1252 it
 * was MIN(naics_code), the lexicographically smallest code on any row, so
 * Sikorsky (336411 aircraft) was tagged by 323117 book printing and Electric
 * Boat (336611 ship building) by 213113 coal-mining support.
 *
 *   1. FIXTURES — eight synthetic contractors (the f1252000- prefix) through
 *      the live function, each with exactly one element and the expected code.
 *   2. REAL DATA — the live function equals a reference implementation (a
 *      row_number() window over the same rows) for every coded entity, and
 *      returns one element per entity.
 *   3. MUTANT (rule 105) — the pre-FIX-1252 MIN(naics_code) body, redefined
 *      inside a savepoint: at least two fixtures must go red, and every
 *      single-code entity must still get the same code from both bodies.
 *
 * Run: pnpm --filter @civitics/data data:verify:naics-dominant
 */

import { Client } from "pg";

let failures = 0;
function check(cond: boolean, label: string, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Row = {
  code: string | null;
  cents: number | null;
  type?: "contract" | "grant";
  /** 'to' (agency → contractor, the USASpending shape) or 'from' (an FE-sourced row). */
  side?: "to" | "from";
  times?: number;
};

type Fixture = { name: string; entity_id: string; rows: Row[]; expected: string; minRed: boolean };

const id = (n: number) => `f1252000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGENCY = "f1252000-0000-4000-8000-a00000000000";

// minRed = the MIN(naics_code) mutant picks a different code (the fixture goes red under it).
const FIXTURES: Fixture[] = [
  { name: "one code — tags the same as before", entity_id: id(1),
    rows: [{ code: "336611", cents: 500_000 }],
    expected: "336611", minRed: false },
  { name: "two codes, dollars 10:1 — the dominant (larger) code wins over MIN", entity_id: id(2),
    rows: [{ code: "336411", cents: 1_000_000 }, { code: "323117", cents: 100_000 }],
    expected: "336411", minRed: true },
  { name: "equal dollars, rows 3:1 — the code with more rows wins", entity_id: id(3),
    rows: [{ code: "541512", cents: 100, times: 3 }, { code: "238210", cents: 300 }],
    expected: "541512", minRed: true },
  { name: "equal dollars AND rows — the smaller code wins (deterministic)", entity_id: id(4),
    rows: [{ code: "336611", cents: 500 }, { code: "213113", cents: 500 }],
    expected: "213113", minRed: false },
  { name: "grant-only, NULL amounts — the row count decides", entity_id: id(5),
    rows: [{ code: "621111", cents: null, type: "grant", times: 2 },
           { code: "541990", cents: null, type: "grant" }],
    expected: "621111", minRed: true },
  { name: "both sides aggregate as ONE entity (to_id + an FE-sourced from_id row)", entity_id: id(6),
    rows: [{ code: "336611", cents: 100, side: "to" }, { code: "336611", cents: 100, side: "from" },
           { code: "213113", cents: 150, side: "to" }],
    expected: "336611", minRed: true },
  { name: "dollars before rows — $0.01 beats five NULL-amount rows", entity_id: id(7),
    rows: [{ code: "111110", cents: null, times: 5 }, { code: "921110", cents: 1 }],
    expected: "921110", minRed: true },
  { name: "a row with no code carries no vote, however large", entity_id: id(8),
    rows: [{ code: "336611", cents: 100 }, { code: null, cents: 10_000_000 }],
    expected: "336611", minRed: false },
];

// The pre-FIX-1252 body (20260927020100_fix919_naics_contractor_side.sql), for the mutant.
const MIN_BODY = `
CREATE OR REPLACE FUNCTION public.get_financial_entity_naics()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'entity_id',  n.entity_id,
           'naics_code', n.naics_code
         )), '[]'::jsonb)
  FROM (
    SELECT side.entity_id,
           MIN(fr.metadata->>'naics_code') AS naics_code
    FROM public.financial_relationships fr
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN fr.to_type   = 'financial_entity' THEN fr.to_id   END),
      (CASE WHEN fr.from_type = 'financial_entity' THEN fr.from_id END)
    ) AS side(entity_id)
    WHERE fr.relationship_type IN ('contract', 'grant')
      AND (fr.to_type = 'financial_entity' OR fr.from_type = 'financial_entity')
      AND fr.metadata->>'naics_code' IS NOT NULL
      AND side.entity_id IS NOT NULL
    GROUP BY side.entity_id
  ) n;
$function$;`;

// An independent statement of the rule: a window over the same rows.
const REFERENCE = `
  SELECT entity_id::text, naics_code FROM (
    SELECT c.entity_id, c.naics_code,
           row_number() OVER (PARTITION BY c.entity_id
                              ORDER BY c.cents DESC, c.n_rows DESC, c.naics_code) AS rk
    FROM (
      SELECT side.entity_id, fr.metadata->>'naics_code' AS naics_code,
             sum(COALESCE(fr.amount_cents, 0)) AS cents, count(*) AS n_rows
      FROM public.financial_relationships fr
      CROSS JOIN LATERAL (VALUES
        (CASE WHEN fr.to_type   = 'financial_entity' THEN fr.to_id   END),
        (CASE WHEN fr.from_type = 'financial_entity' THEN fr.from_id END)) AS side(entity_id)
      WHERE fr.relationship_type IN ('contract', 'grant')
        AND (fr.to_type = 'financial_entity' OR fr.from_type = 'financial_entity')
        AND fr.metadata->>'naics_code' IS NOT NULL
        AND side.entity_id IS NOT NULL
      GROUP BY 1, 2
    ) c
  ) r WHERE rk = 1`;

async function readFunction(pg: Client): Promise<Map<string, string>> {
  const r = await pg.query<{ entity_id: string; naics_code: string }>(
    `SELECT e->>'entity_id' AS entity_id, e->>'naics_code' AS naics_code
       FROM jsonb_array_elements(public.get_financial_entity_naics()) e`,
  );
  const out = new Map<string, string>();
  for (const row of r.rows) {
    if (out.has(row.entity_id)) throw new Error(`get_financial_entity_naics returned two elements for ${row.entity_id}`);
    out.set(row.entity_id, row.naics_code);
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`verify-fix1252-naics-dominant is LOCAL ONLY (active env: ${url || "unset"}).`);
  }
  const pg = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    application_name: "verify_fix1252_naics_dominant",
  });
  await pg.connect();

  try {
    await pg.query("BEGIN");
    await pg.query("SET LOCAL statement_timeout = '10min'");
    for (const f of FIXTURES) {
      for (const r of f.rows) {
        for (let i = 0; i < (r.times ?? 1); i++) {
          const toSide = (r.side ?? "to") === "to";
          await pg.query(
            `INSERT INTO public.financial_relationships
               (relationship_type, from_type, from_id, to_type, to_id, amount_cents, occurred_at, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-01-01', $7)`,
            [r.type ?? "contract",
             toSide ? "agency" : "financial_entity", toSide ? AGENCY : f.entity_id,
             toSide ? "financial_entity" : "agency", toSide ? f.entity_id : AGENCY,
             r.cents, r.code ? { naics_code: r.code } : {}],
          );
        }
      }
    }

    console.log("\n=== 1. fixtures through the live function ===");
    const live = await readFunction(pg);
    for (const f of FIXTURES) {
      check(live.get(f.entity_id) === f.expected, f.name,
        `got ${live.get(f.entity_id) ?? "no element"}, want ${f.expected}`);
    }

    console.log("\n=== 2. real data: live function = reference window, one element per entity ===");
    const ref = new Map<string, string>();
    for (const row of (await pg.query<{ entity_id: string; naics_code: string }>(REFERENCE)).rows) {
      ref.set(row.entity_id, row.naics_code);
    }
    let diff = 0;
    for (const [e, code] of ref) if (live.get(e) !== code) diff++;
    check(live.size === ref.size, `same entity count (live ${live.size}, reference ${ref.size})`);
    check(diff === 0, `live = reference on all ${ref.size} coded entities`, `${diff} differ`);

    console.log("\n=== 3. mutant: MIN(naics_code) restored (savepoint, rolled back) ===");
    await pg.query("SAVEPOINT mutant");
    await pg.query(MIN_BODY);
    const min = await readFunction(pg);
    await pg.query("ROLLBACK TO SAVEPOINT mutant");
    let red = 0;
    for (const f of FIXTURES) {
      const isRed = min.get(f.entity_id) !== f.expected;
      if (isRed) red++;
      check(isRed === f.minRed, `mutant ${isRed ? "RED  " : "green"}: ${f.name}`,
        `expected the mutant to be ${f.minRed ? "red" : "green"} here (got ${min.get(f.entity_id)})`);
    }
    check(red >= 2, `the MIN mutant turns ${red} fixture(s) red (need >= 2)`);

    // Entities with exactly one code must tag identically under both bodies.
    const single = (await pg.query<{ entity_id: string }>(`
      SELECT side.entity_id::text AS entity_id
      FROM public.financial_relationships fr
      CROSS JOIN LATERAL (VALUES
        (CASE WHEN fr.to_type   = 'financial_entity' THEN fr.to_id   END),
        (CASE WHEN fr.from_type = 'financial_entity' THEN fr.from_id END)) AS side(entity_id)
      WHERE fr.relationship_type IN ('contract', 'grant')
        AND (fr.to_type = 'financial_entity' OR fr.from_type = 'financial_entity')
        AND fr.metadata->>'naics_code' IS NOT NULL
        AND side.entity_id IS NOT NULL
      GROUP BY 1 HAVING count(DISTINCT fr.metadata->>'naics_code') = 1`)).rows.map((r) => r.entity_id);
    let singleDiff = 0;
    for (const e of single) if (live.get(e) !== min.get(e)) singleDiff++;
    check(singleDiff === 0, `all ${single.length} single-code entities tag the same under MIN and dominant`,
      `${singleDiff} differ`);
    let multiDiff = 0;
    for (const [e, code] of live) if (min.get(e) !== code) multiDiff++;
    console.log(`  info  ${multiDiff} of ${live.size} entities get a different code from MIN than from the dominant rule`);
  } finally {
    await pg.query("ROLLBACK").catch(() => undefined);
    await pg.end();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
