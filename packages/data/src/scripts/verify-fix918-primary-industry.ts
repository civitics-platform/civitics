/**
 * FIX-918 — verification harness for primary_industry_tag(), run against the
 * LOCAL clone (it writes fixture rows into entity_tags and removes them again).
 *
 *   1. FIXTURES — every fixture's pick through SQL, both call shapes (an id
 *      array, and NULL = every tagged entity), equals the hand-written
 *      expectation; exactly one row per tagged fixture, none for an untagged id.
 *   2. TS = SQL — fetchIndustryTagsByEntityId() returns the same pick for every
 *      fixture, twice (a PostgREST read with no ORDER BY would not be stable).
 *   3. REAL DATA — for every multi-tag donor on the env, the array call, the
 *      NULL call and the TS reader agree.
 *
 * Run: pnpm --filter @civitics/data data:verify:primary-industry
 */

import { Client } from "pg";
import { createAdminClient, fetchIndustryTagsByEntityId } from "@civitics/db";
import { FIX918_FIXTURES } from "./fix918-primary-industry-fixtures";

let failures = 0;
function check(cond: boolean, label: string, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sqlPicks(pg: Client, ids: string[] | null, scope: string[]): Promise<Map<string, string>> {
  const r = await pg.query<{ entity_id: string; tag: string }>(
    `SELECT pit.entity_id, pit.tag
       FROM public.primary_industry_tag($1::uuid[]) pit
      WHERE pit.entity_id = ANY ($2::uuid[])`,
    [ids, scope],
  );
  const out = new Map<string, string>();
  for (const row of r.rows) {
    if (out.has(row.entity_id)) throw new Error(`primary_industry_tag returned two rows for ${row.entity_id}`);
    out.set(row.entity_id, row.tag);
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`verify-fix918-primary-industry is LOCAL ONLY (active env: ${url || "unset"}).`);
  }
  const pg = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    application_name: "verify_fix918_primary_industry",
  });
  await pg.connect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const ids = FIX918_FIXTURES.map((f) => f.entity_id);

  try {
    await pg.query(`DELETE FROM public.entity_tags WHERE entity_id = ANY ($1::uuid[])`, [ids]);
    for (const f of FIX918_FIXTURES) {
      for (const t of f.tags) {
        await pg.query(
          `INSERT INTO public.entity_tags
             (entity_type, entity_id, tag, tag_category, display_label, generated_by, confidence, metadata)
           VALUES ('financial_entity', $1, $2, 'industry', $2, $3, $4, $5)`,
          [f.entity_id, t.tag, t.generated_by, t.confidence,
           t.naics_code ? { naics_code: t.naics_code } : {}],
        );
      }
    }

    console.log("\n=== 1. fixtures through SQL ===");
    const byArray = await sqlPicks(pg, ids, ids);
    const byNull = await sqlPicks(pg, null, ids);
    for (const f of FIX918_FIXTURES) {
      check((byArray.get(f.entity_id) ?? null) === f.expected,
        `array: ${f.name}`, `got ${byArray.get(f.entity_id) ?? "no row"}, want ${f.expected ?? "no row"}`);
      check((byNull.get(f.entity_id) ?? null) === f.expected,
        `NULL:  ${f.name}`, `got ${byNull.get(f.entity_id) ?? "no row"}, want ${f.expected ?? "no row"}`);
    }

    console.log("\n=== 2. TS = SQL on the fixtures (two reads) ===");
    for (const pass of [1, 2]) {
      const ts = await fetchIndustryTagsByEntityId(db, ids);
      for (const f of FIX918_FIXTURES) {
        check((ts.get(f.entity_id)?.tag ?? null) === f.expected,
          `ts#${pass}: ${f.name}`, `got ${ts.get(f.entity_id)?.tag ?? "no row"}, want ${f.expected ?? "no row"}`);
      }
    }

    console.log("\n=== 3. real multi-tag donors: array = NULL = TS ===");
    const multi = (await pg.query<{ entity_id: string }>(
      `SELECT entity_id FROM public.entity_tags
        WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
          AND NOT (entity_id = ANY ($1::uuid[]))
        GROUP BY entity_id HAVING count(*) >= 2`, [ids],
    )).rows.map((r) => r.entity_id);
    const rA = await sqlPicks(pg, multi, multi);
    const rN = await sqlPicks(pg, null, multi);
    const rT = await fetchIndustryTagsByEntityId(db, multi);
    let diffAN = 0, diffAT = 0;
    for (const e of multi) {
      if (rA.get(e) !== rN.get(e)) diffAN++;
      if (rA.get(e) !== rT.get(e)?.tag) diffAT++;
    }
    check(rA.size === multi.length, `one SQL row per multi-tag donor (${rA.size}/${multi.length})`);
    check(diffAN === 0, `array call = NULL call on ${multi.length} multi-tag donors`, `${diffAN} differ`);
    check(diffAT === 0, `SQL = TS on ${multi.length} multi-tag donors`, `${diffAT} differ`);
  } finally {
    await pg.query(`DELETE FROM public.entity_tags WHERE entity_id = ANY ($1::uuid[])`, [ids]);
    await pg.end();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
