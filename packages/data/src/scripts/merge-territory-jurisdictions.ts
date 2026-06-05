/**
 * FIX-487 — merge the duplicate territory jurisdiction rows (AS/GU/MP/PR/VI).
 *
 * Same class + playbook as FIX-482 (the DC merge), now for the five U.S.
 * territories with non-voting House delegates. Each territory has TWO
 * jurisdiction rows sharing one fips (60/66/69/72/78):
 *   - WINNER (canonical, FIX-422 model):  type='unincorporated_territory'
 *   - LOSER  (resolver split, FIX-321):   type='district'
 *
 * Root cause is identical to DC: STATE_DATA in jurisdictions/us-states.ts
 * declared the territories as type='district', so the shared
 * seedJurisdictions() lookup keyed on (fips_code, type, parent_id) never
 * matched the canonical unincorporated_territory row and created/resolved a
 * separate type='district' row. Pipelines then split each territory's
 * officials across the two rows, and the /jurisdictions territory filter
 * (which expects unincorporated_territory) rendered them wrong. The root-cause
 * resolver fix (the 5 STATE_DATA entries flip type='district' →
 * 'unincorporated_territory') lands in the SAME commit; without it the next
 * data:jurisdictions run re-splits. This script is the data-merge half.
 *
 * WHERE THIS DIFFERS FROM DC (decisions 3 + 4):
 *   On the local snapshot (2026-06-04) every territory's WINNER row has ZERO
 *   governing_bodies of its own — openstates resolved the gbs onto the LOSER
 *   row (e.g. "Puerto Rico State Senate"). So unlike DC (where each loser gb
 *   had a same-type winner gb and got MERGED + deleted), the territory loser
 *   gbs are REPOINTED onto the winner and KEPT. The branch is decided per gb
 *   AT RUN TIME, not assumed:
 *     - winner HAS a same-type gb  → MERGE  (repoint gb-refs onto the winner
 *       gb of same type, delete the loser gb + its xsr). Same as DC.
 *     - winner has NO same-type gb → REPOINT (UPDATE gb.jurisdiction_id →
 *       winner, KEEP the gb). The gb's FIX-477 synthetic openstates xsr
 *       external_id embeds the jurisdiction_id (`gb/<juris>/<type>`), so it is
 *       rewritten to `gb/<winner>/<type>` — otherwise the next writer run
 *       inserts a SECOND xsr row per gb and source_count silently doubles.
 *
 * Atomic per territory: each territory's repoints + deletes run inside one
 * transaction, so a unique-constraint conflict rolls that territory back
 * cleanly (stop-and-report) without half-merging it. The FK column lists below
 * are the SAME audited surface FIX-482 used, re-confirmed via a live
 * information_schema FK sweep on 2026-06-04 (8 jurisdiction FKs, 8
 * governing_body FKs — complete).
 *
 * Single pg.Client against the ACTIVE env (local Docker, or prod via
 * --env-file=.env.local.prod + SUPABASE_DB_PASSWORD), sidestepping the
 * PostgREST 1000-row cap — same shape as merge-dc-jurisdiction.ts (FIX-482).
 *
 * Run local (executes by default — local is free per the DB safety rules):
 *   pnpm --filter @civitics/data data:merge-territory-jurisdictions
 *   pnpm --filter @civitics/data data:merge-territory-jurisdictions -- --dry-run  # plan only
 *
 * Prod is GATED (decision 2): the prod plan command prints the exact
 * statements + live counts and STOPS (no writes) for explicit confirmation:
 *   pnpm --filter @civitics/data data:merge-territory-jurisdictions:prod:plan
 * Only after Craig's go, run the executing variant:
 *   pnpm --filter @civitics/data data:merge-territory-jurisdictions:prod
 */

import { Client } from "pg";

// The five territories. Resolved live by (fips, type, name) — never hardcode
// UUIDs (prod UUIDs differ from local).
const TERRITORIES: Array<{ name: string; fips: string }> = [
  { name: "American Samoa", fips: "60" },
  { name: "Guam", fips: "66" },
  { name: "Northern Mariana Islands", fips: "69" },
  { name: "Puerto Rico", fips: "72" },
  { name: "U.S. Virgin Islands", fips: "78" },
];

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    // local Docker
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

type Row = Record<string, unknown>;

async function q(client: Client, sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await client.query(sql, params);
  return res.rows as Row[];
}

async function count(client: Client, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await q(client, sql, params);
  return rows[0].n as number;
}

interface JRow {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  fips_code: string | null;
  parent_id: string | null;
}

interface GbRow {
  id: string;
  name: string;
  type: string;
  jurisdiction_id: string;
}

// (childTable, childColumn) pairs whose values point at governing_bodies.id.
// Used ONLY in the MERGE branch (winner has a same-type gb) — repointed onto
// the winner gb of the SAME type. In the REPOINT branch the loser gb is kept,
// so its inbound refs stay valid and are NOT touched.
const GB_REF_COLS: Array<[string, string]> = [
  ["officials", "governing_body_id"],
  ["career_history", "governing_body_id"],
  ["agencies", "governing_body_id"],
  ["meetings", "governing_body_id"],
  ["proposals", "governing_body_id"],
  ["official_committee_memberships", "committee_id"],
  ["institution_extensions", "governing_body_id"],
  ["institution_extensions", "parent_id"],
];

// (childTable, childColumn) pairs whose values point at jurisdictions.id.
// Repointed straight onto the winner jurisdiction. (governing_bodies
// .jurisdiction_id is handled separately per gb — merge-delete or repoint.)
const JURIS_REF_COLS: Array<[string, string]> = [
  ["officials", "jurisdiction_id"],
  ["agencies", "jurisdiction_id"],
  ["claim_queue", "jurisdiction_id"],
  ["promises", "jurisdiction_id"],
  ["proposals", "jurisdiction_id"],
  ["user_preferences", "home_jurisdiction_id"],
  ["jurisdictions", "parent_id"],
];

async function resolveOne(
  client: Client,
  label: string,
  sql: string,
  params: unknown[],
): Promise<JRow> {
  const rows = (await q(client, sql, params)) as unknown as JRow[];
  if (rows.length === 0) throw new Error(`Could not resolve ${label}: no row matched.`);
  if (rows.length > 1) {
    throw new Error(
      `Refusing to proceed — ${label} matched ${rows.length} rows (expected exactly 1):\n` +
        rows.map((r) => `  ${r.id}  ${r.type}  fips=${r.fips_code}  "${r.name}"`).join("\n"),
    );
  }
  return rows[0];
}

interface GbPlan {
  gb: GbRow;
  action: "merge" | "repoint";
  winnerGbId: string | null; // merge target (same type) — null for repoint
  oldXsrKey: string;
  newXsrKey: string;
}

interface TerritoryResult {
  name: string;
  fips: string;
  winnerId: string;
  loserId: string;
  gbPlans: GbPlan[];
  officialsBefore: number; // winner + loser combined
  officialsAfter: number; // winner after
  jurisRefsRepointed: number;
  ok: boolean;
}

async function processTerritory(
  client: Client,
  t: { name: string; fips: string },
  willExecute: boolean,
): Promise<TerritoryResult> {
  console.log(`\n${"═".repeat(70)}\n${t.name} (fips ${t.fips})\n${"═".repeat(70)}`);

  // ── 1. Resolve winner + loser live ────────────────────────────────────
  const winner = await resolveOne(
    client,
    `WINNER (unincorporated_territory ${t.name})`,
    `SELECT id, name, short_name, type, fips_code, parent_id FROM public.jurisdictions
      WHERE fips_code = $1 AND type = 'unincorporated_territory' AND name = $2`,
    [t.fips, t.name],
  );
  const loser = await resolveOne(
    client,
    `LOSER (district ${t.name})`,
    `SELECT id, name, short_name, type, fips_code, parent_id FROM public.jurisdictions
      WHERE fips_code = $1 AND type = 'district' AND name = $2`,
    [t.fips, t.name],
  );
  if (winner.id === loser.id) throw new Error(`${t.name}: winner and loser resolved to the same row.`);
  if (winner.type !== "unincorporated_territory") throw new Error(`${t.name}: winner type unexpected (${winner.type}).`);
  if (loser.type !== "district") throw new Error(`${t.name}: loser type unexpected (${loser.type}).`);

  console.log(`  WINNER:  ${winner.id}  ${winner.type}  "${winner.name}"`);
  console.log(`  LOSER:   ${loser.id}  ${loser.type}  "${loser.name}"`);

  // Loud confirmation of OTHER fips rows that must survive (county etc.).
  const survivors = await q(
    client,
    `SELECT id, name, type, fips_code FROM public.jurisdictions
      WHERE fips_code = $1 AND id NOT IN ($2, $3) ORDER BY type, name`,
    [t.fips, winner.id, loser.id],
  );
  if (survivors.length) {
    console.log(`  Other fips-${t.fips} rows (MUST survive untouched):`);
    for (const r of survivors) console.log(`    ${r.id}  ${r.type}  "${r.name}"`);
  }

  // ── 2. Resolve gb pairs + decide per-gb branch ────────────────────────
  const winnerGbs = (await q(
    client,
    `SELECT id, name, type, jurisdiction_id FROM public.governing_bodies WHERE jurisdiction_id = $1`,
    [winner.id],
  )) as unknown as GbRow[];
  const loserGbs = (await q(
    client,
    `SELECT id, name, type, jurisdiction_id FROM public.governing_bodies WHERE jurisdiction_id = $1`,
    [loser.id],
  )) as unknown as GbRow[];
  const winnerByType = new Map(winnerGbs.map((g) => [g.type, g]));

  const gbPlans: GbPlan[] = loserGbs.map((lg) => {
    const wg = winnerByType.get(lg.type);
    return {
      gb: lg,
      action: wg ? "merge" : "repoint",
      winnerGbId: wg ? wg.id : null,
      oldXsrKey: `gb/${loser.id}/${lg.type}`,
      newXsrKey: `gb/${winner.id}/${lg.type}`,
    };
  });

  console.log(`  gb handling (${loserGbs.length} loser gb(s); winner has ${winnerGbs.length}):`);
  for (const p of gbPlans) {
    console.log(
      p.action === "merge"
        ? `    MERGE   ${p.gb.id} (${p.gb.type} "${p.gb.name}") → winner gb ${p.winnerGbId}`
        : `    REPOINT ${p.gb.id} (${p.gb.type} "${p.gb.name}") jurisdiction_id → winner; xsr ${p.oldXsrKey} → ${p.newXsrKey}`,
    );
  }

  // ── officials before (winner + loser combined) ────────────────────────
  const officialsBefore = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.officials WHERE jurisdiction_id = ANY($1::uuid[])`,
    [[winner.id, loser.id]],
  );

  // ── Live FK-surface audit of the LOSER jurisdiction ───────────────────
  console.log(`  BEFORE — references to the loser jurisdiction:`);
  for (const [table, col] of JURIS_REF_COLS) {
    const n = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [loser.id]);
    if (n > 0) console.log(`    ${String(n).padStart(5)}  ${table}.${col}`);
  }
  const metaBefore = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.officials WHERE metadata->>'district_jurisdiction_id' = $1`,
    [loser.id],
  );
  if (metaBefore > 0) console.log(`    ${String(metaBefore).padStart(5)}  officials.metadata->>'district_jurisdiction_id'`);

  // ── Print the exact plan ──────────────────────────────────────────────
  console.log(`  ── PLAN (params: winner=${winner.id}, loser=${loser.id}) ──`);
  for (const p of gbPlans) {
    if (p.action === "merge") {
      for (const [table, col] of GB_REF_COLS) {
        console.log(`    UPDATE ${table} SET ${col}='${p.winnerGbId}' WHERE ${col}='${p.gb.id}';`);
      }
      console.log(`    DELETE FROM external_source_refs WHERE entity_type='governing_body' AND entity_id='${p.gb.id}';`);
      console.log(`    DELETE FROM governing_bodies WHERE id='${p.gb.id}';`);
    } else {
      console.log(`    UPDATE governing_bodies SET jurisdiction_id='${winner.id}' WHERE id='${p.gb.id}';`);
      console.log(
        `    UPDATE external_source_refs SET external_id='${p.newXsrKey}' ` +
          `WHERE entity_type='governing_body' AND entity_id='${p.gb.id}' AND source='openstates' AND external_id='${p.oldXsrKey}';`,
      );
    }
  }
  for (const [table, col] of JURIS_REF_COLS) {
    console.log(`    UPDATE ${table} SET ${col}='${winner.id}' WHERE ${col}='${loser.id}';`);
  }
  console.log(
    `    UPDATE officials SET metadata = jsonb_set(metadata,'{district_jurisdiction_id}',to_jsonb('${winner.id}'::text)) ` +
      `WHERE metadata->>'district_jurisdiction_id'='${loser.id}';`,
  );
  console.log(`    DELETE FROM external_source_refs WHERE entity_type='jurisdiction' AND entity_id='${loser.id}';`);
  console.log(`    DELETE FROM jurisdictions WHERE id='${loser.id}';`);

  if (!willExecute) {
    return {
      name: t.name,
      fips: t.fips,
      winnerId: winner.id,
      loserId: loser.id,
      gbPlans,
      officialsBefore,
      officialsAfter: officialsBefore, // unchanged in plan-only
      jurisRefsRepointed: 0,
      ok: true,
    };
  }

  // ── 3. Execute atomically (per territory) ─────────────────────────────
  let jurisRefsRepointed = 0;
  await client.query("BEGIN");
  try {
    for (const p of gbPlans) {
      if (p.action === "merge") {
        for (const [table, col] of GB_REF_COLS) {
          const res = await client.query(
            `UPDATE public.${table} SET ${col} = $1 WHERE ${col} = $2`,
            [p.winnerGbId, p.gb.id],
          );
          if (res.rowCount) console.log(`    repointed ${res.rowCount} ${table}.${col} (loser gb → winner gb)`);
        }
        await client.query(
          `DELETE FROM public.external_source_refs WHERE entity_type='governing_body' AND entity_id=$1`,
          [p.gb.id],
        );
        await client.query(`DELETE FROM public.governing_bodies WHERE id = $1`, [p.gb.id]);
        console.log(`    merged + deleted loser gb ${p.gb.id}`);
      } else {
        await client.query(`UPDATE public.governing_bodies SET jurisdiction_id = $1 WHERE id = $2`, [winner.id, p.gb.id]);
        const xsr = await client.query(
          `UPDATE public.external_source_refs SET external_id = $1
            WHERE entity_type='governing_body' AND entity_id = $2 AND source='openstates' AND external_id = $3`,
          [p.newXsrKey, p.gb.id, p.oldXsrKey],
        );
        console.log(`    repointed gb ${p.gb.id} → winner; rewrote ${xsr.rowCount ?? 0} openstates xsr key`);
      }
    }

    for (const [table, col] of JURIS_REF_COLS) {
      const res = await client.query(`UPDATE public.${table} SET ${col} = $1 WHERE ${col} = $2`, [winner.id, loser.id]);
      if (res.rowCount) {
        console.log(`    repointed ${res.rowCount} ${table}.${col} (→ winner jurisdiction)`);
        jurisRefsRepointed += res.rowCount;
      }
    }
    const metaRes = await client.query(
      `UPDATE public.officials SET metadata = jsonb_set(metadata,'{district_jurisdiction_id}',to_jsonb($1::text))
        WHERE metadata->>'district_jurisdiction_id' = $2`,
      [winner.id, loser.id],
    );
    if (metaRes.rowCount) console.log(`    repointed ${metaRes.rowCount} officials.metadata.district_jurisdiction_id`);

    await client.query(
      `DELETE FROM public.external_source_refs WHERE entity_type='jurisdiction' AND entity_id = $1`,
      [loser.id],
    );
    const jDel = await client.query(`DELETE FROM public.jurisdictions WHERE id = $1`, [loser.id]);
    console.log(`    deleted ${jDel.rowCount} loser jurisdiction row(s)`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // ── 4. Re-verify ──────────────────────────────────────────────────────
  const loserGone = await count(client, `SELECT COUNT(*)::int AS n FROM public.jurisdictions WHERE id = $1`, [loser.id]);
  const winnerStill = await count(client, `SELECT COUNT(*)::int AS n FROM public.jurisdictions WHERE id = $1`, [winner.id]);
  const gbsOnLoser = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE jurisdiction_id = $1`,
    [loser.id],
  );
  let dangling = gbsOnLoser;
  for (const [table, col] of JURIS_REF_COLS) {
    dangling += await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [loser.id]);
  }
  dangling += await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.officials WHERE metadata->>'district_jurisdiction_id' = $1`,
    [loser.id],
  );
  dangling += await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='jurisdiction' AND entity_id = $1`,
    [loser.id],
  );
  // stale gb xsr keys still embedding the loser jurisdiction id
  const staleXsr = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='governing_body' AND external_id LIKE $1`,
    [`gb/${loser.id}/%`],
  );
  const officialsAfter = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.officials WHERE jurisdiction_id = $1`,
    [winner.id],
  );
  const repointGbCount = gbPlans.filter((p) => p.action === "repoint").length;
  const repointedGbsOnWinner = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE id = ANY($1::uuid[]) AND jurisdiction_id = $2`,
    [gbPlans.filter((p) => p.action === "repoint").map((p) => p.gb.id), winner.id],
  );

  const ok =
    loserGone === 0 &&
    winnerStill === 1 &&
    dangling === 0 &&
    staleXsr === 0 &&
    officialsAfter === officialsBefore &&
    repointedGbsOnWinner === repointGbCount;

  console.log(`  ── POST-MERGE (${t.name}) ──`);
  console.log(`    loser jurisdiction remaining:        ${loserGone}   (expect 0)`);
  console.log(`    winner jurisdiction present:         ${winnerStill}   (expect 1)`);
  console.log(`    dangling refs to loser:              ${dangling}   (expect 0)`);
  console.log(`    stale gb xsr keys (gb/<loser>/…):    ${staleXsr}   (expect 0)`);
  console.log(`    repointed gbs now on winner:         ${repointedGbsOnWinner}/${repointGbCount}`);
  console.log(`    officials (combined→winner):         ${officialsBefore} → ${officialsAfter}   (expect equal)`);
  console.log(`    ${ok ? "✓ VERIFIED" : "✗ INCOMPLETE — investigate above"}`);

  return {
    name: t.name,
    fips: t.fips,
    winnerId: winner.id,
    loserId: loser.id,
    gbPlans,
    officialsBefore,
    officialsAfter,
    jurisRefsRepointed,
    ok,
  };
}

async function main(): Promise<void> {
  const prod = isProd();
  const allowProd = process.argv.includes("--allow-prod");
  const confirm = process.argv.includes("--confirm");
  const dryRun = process.argv.includes("--dry-run");

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  Use `pnpm --filter @civitics/data data:merge-territory-jurisdictions:prod:plan` to PRINT the plan,\n" +
        "  then (after explicit confirmation) `…:prod` to execute. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  const env = prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker";
  const willExecute = dryRun ? false : prod ? confirm : true;

  console.log(`# FIX-487 — territory jurisdiction merge (AS/GU/MP/PR/VI)`);
  console.log(`Env:        ${env}`);
  console.log(`Connection: ${masked}`);
  console.log(
    `Mode:       ${
      willExecute ? (prod ? "PROD WRITE (--allow-prod --confirm given)" : "local write") : "PLAN ONLY (no writes)"
    }`,
  );

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const results: TerritoryResult[] = [];
  try {
    for (const t of TERRITORIES) {
      results.push(await processTerritory(client, t, willExecute));
    }
  } finally {
    await client.end();
  }

  // ── Summary table ───────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}\nSUMMARY\n${"═".repeat(70)}`);
  for (const r of results) {
    const merges = r.gbPlans.filter((p) => p.action === "merge").length;
    const repoints = r.gbPlans.filter((p) => p.action === "repoint").length;
    console.log(
      `  ${r.name.padEnd(26)} fips ${r.fips}  gb: ${merges} merge / ${repoints} repoint  ` +
        `officials ${r.officialsBefore}→${r.officialsAfter}  ${willExecute ? (r.ok ? "✓" : "✗") : "(plan)"}`,
    );
  }

  if (!willExecute) {
    console.log(
      `\n⏸  PLAN ONLY — no writes performed.` +
        (prod
          ? `\n   Prod execution is gated: re-run with the executing variant (…:prod) only after explicit confirmation.`
          : `\n   (--dry-run given.)`),
    );
    return;
  }

  const allOk = results.every((r) => r.ok);
  console.log(`\n${allOk ? "✓ ALL TERRITORIES MERGED + VERIFIED" : "✗ ONE OR MORE TERRITORIES INCOMPLETE — investigate above"}`);
  if (!allOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
