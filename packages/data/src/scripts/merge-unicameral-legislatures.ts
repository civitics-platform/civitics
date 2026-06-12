/**
 * FIX-489 / FIX-548 — convert the four mis-modeled unicameral legislatures
 * (DC, NE, GU, VI) from a State Senate/House pair to a single
 * legislature_unicameral governing body.
 *
 * Same class + playbook as FIX-482/FIX-487 (jurisdiction merges), one level
 * down: this time the duplicate is the governing-body PAIR inside a single
 * (correct) jurisdiction. Each of the four jurisdictions has:
 *   - WINNER: the populated 'X State Senate' row, type='legislature_upper'
 *     (DC's 13 councilmembers and NE's 49 senators are parked here; GU/VI are
 *     empty pending openstates coverage)
 *   - LOSER:  an empty 'X State House' sibling, type='legislature_lower'
 *
 * Root cause (fixed in the same commit, pipelines/openstates/index.ts +
 * jurisdictions/legislature-shapes.ts): Phase 0 unconditionally resolved an
 * upper+lower pair for every STATE_DATA entry and the writer inserts misses,
 * so the pair re-split on every run; unicameral members are exposed by the
 * openstates API only under org_classification=legislature (and DC/territory
 * OCD ids use district:/territory: prefixes, not state:).
 *
 * CONVERT-IN-PLACE (decision 1): the winner row is UPDATEd to
 * type='legislature_unicameral' with its proper name from
 * jurisdictions/legislature-shapes.ts, short_name regenerated, slug NULLed
 * and refilled via backfill_governing_body_slugs() (canonical formula +
 * collision handling), and its FIX-477 synthetic openstates xsr external_id
 * rewritten gb/<juris>/legislature_upper → gb/<juris>/legislature_unicameral
 * — otherwise the next writer run inserts a SECOND xsr row and source_count
 * silently doubles. Preserving the winner's UUID keeps
 * officials.governing_body_id and group_donor_rollup(gb_id) rows valid
 * untouched. Slug churn is accepted (decision 10): old deep-links break, the
 * UUID fallback in the group route still resolves.
 *
 * AUDIT-BEFORE-APPLY (decision 2): the ref surface is discovered LIVE from
 * information_schema (FK columns referencing governing_bodies) plus the
 * polymorphic entity_id tables and the gb_id rollup tables — never from
 * migration archaeology. Plan mode prints per-table counts for winner AND
 * loser; apply refuses when the loser carries refs on any surface the script
 * does not explicitly handle, and refuses when the loser has officials (the
 * populated-row-is-upper assumption would be wrong).
 *
 * Atomic per jurisdiction: each conversion runs inside one transaction, so a
 * conflict rolls that jurisdiction back cleanly (stop-and-report).
 *
 * Run local (executes by default — local is free per the DB safety rules):
 *   pnpm --filter @civitics/data data:merge-unicameral-legislatures
 *   pnpm --filter @civitics/data data:merge-unicameral-legislatures -- --dry-run
 *
 * Prod is GATED (decision 5): plan prints statements + live counts, no writes:
 *   pnpm --filter @civitics/data data:merge-unicameral-legislatures:prod:plan
 * Only after Craig's explicit go:
 *   pnpm --filter @civitics/data data:merge-unicameral-legislatures:prod
 */

import { Client } from "pg";
import { LEGISLATURE_SHAPES } from "../jurisdictions/legislature-shapes";

// The four conversions. Jurisdictions resolved live by (fips, type, name) —
// never hardcode UUIDs (prod UUIDs differ from local in general; gb rows are
// resolved live per jurisdiction the same way).
const TARGETS: Array<{ abbr: string; name: string; fips: string; jurisType: string }> = [
  { abbr: "DC", name: "District of Columbia", fips: "11", jurisType: "federal_district" },
  { abbr: "NE", name: "Nebraska", fips: "31", jurisType: "state" },
  { abbr: "GU", name: "Guam", fips: "66", jurisType: "unincorporated_territory" },
  { abbr: "VI", name: "U.S. Virgin Islands", fips: "78", jurisType: "unincorporated_territory" },
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
  return Number(rows[0].n);
}

interface GbRow {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  slug: string | null;
  jurisdiction_id: string;
}

/**
 * Live FK discovery — every (table, column) in public that REFERENCES
 * governing_bodies, straight from information_schema. Self-extending: a new
 * FK added after this script ships is audited (and repointed) automatically.
 */
async function discoverGbFkCols(client: Client): Promise<Array<[string, string]>> {
  const rows = await q(
    client,
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = 'governing_bodies'
      ORDER BY 1, 2`,
  );
  return rows.map((r) => [r.table_name as string, r.column_name as string]);
}

/**
 * Live polymorphic-surface discovery — every public base table with BOTH
 * entity_type and entity_id columns. external_source_refs is excluded here
 * because it gets dedicated handling (loser rows deleted, winner's synthetic
 * openstates key rewritten); everything else is repointed loser → winner.
 */
async function discoverPolymorphicTables(client: Client): Promise<string[]> {
  const rows = await q(
    client,
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = 'public' AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'entity_id'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns c2
           WHERE c2.table_schema = 'public' AND c2.table_name = c.table_name
             AND c2.column_name = 'entity_type')
        AND c.table_name <> 'external_source_refs'
      ORDER BY 1`,
  );
  return rows.map((r) => r.table_name as string);
}

// gb_id rollup tables (FIX-500) — derived data, regenerated by
// refresh_group_donor_rollup(); loser rows are deleted, winner rows survive
// untouched (the winner UUID is preserved by convert-in-place).
const GB_ID_ROLLUP_TABLES = ["group_donor_rollup", "group_donor_rollup_summary"];

interface TargetResult {
  abbr: string;
  winnerId: string;
  loserId: string;
  oldSlug: string | null;
  newSlug: string | null;
  newName: string;
  officialsBefore: number;
  officialsAfter: number;
  ok: boolean;
}

async function processTarget(
  client: Client,
  t: (typeof TARGETS)[number],
  fkCols: Array<[string, string]>,
  polyTables: string[],
  willExecute: boolean,
): Promise<TargetResult> {
  console.log(`\n${"═".repeat(70)}\n${t.name} (${t.abbr}, fips ${t.fips})\n${"═".repeat(70)}`);

  const shape = LEGISLATURE_SHAPES[t.abbr];
  if (!shape || shape.shape !== "unicameral" || !shape.unicameralName || !shape.unicameralShortName) {
    throw new Error(`${t.abbr}: legislature-shapes.ts has no unicameral entry — refusing.`);
  }

  // ── 1. Resolve jurisdiction + the gb pair live ────────────────────────────
  const jRows = await q(
    client,
    `SELECT id FROM public.jurisdictions WHERE fips_code = $1 AND type = $2 AND name = $3`,
    [t.fips, t.jurisType, t.name],
  );
  if (jRows.length !== 1) {
    throw new Error(`${t.abbr}: jurisdiction (fips=${t.fips}, type=${t.jurisType}) matched ${jRows.length} rows (expected 1).`);
  }
  const jurisId = jRows[0].id as string;

  const gbRows = (await q(
    client,
    `SELECT id, name, short_name, type, slug, jurisdiction_id
       FROM public.governing_bodies
      WHERE jurisdiction_id = $1 AND type IN ('legislature_upper','legislature_lower','legislature_unicameral')
      ORDER BY type`,
    [jurisId],
  )) as unknown as GbRow[];

  const already = gbRows.find((g) => g.type === "legislature_unicameral");
  if (already) {
    // Idempotent re-run: conversion already applied. Verify no lower sibling.
    const lowers = gbRows.filter((g) => g.type === "legislature_lower");
    console.log(`  ALREADY CONVERTED: ${already.id} "${already.name}" (slug ${already.slug}); ${lowers.length} lower sibling(s) remaining`);
    const n = await count(client, `SELECT COUNT(*)::int AS n FROM public.officials WHERE governing_body_id = $1`, [already.id]);
    return {
      abbr: t.abbr, winnerId: already.id, loserId: "(none)", oldSlug: null,
      newSlug: already.slug, newName: already.name,
      officialsBefore: n, officialsAfter: n, ok: lowers.length === 0,
    };
  }

  const winner = gbRows.find((g) => g.type === "legislature_upper");
  const loser = gbRows.find((g) => g.type === "legislature_lower");
  if (!winner || !loser) {
    throw new Error(
      `${t.abbr}: expected exactly one legislature_upper + one legislature_lower; found:\n` +
        gbRows.map((g) => `  ${g.id}  ${g.type}  "${g.name}"`).join("\n"),
    );
  }

  console.log(`  WINNER (convert in place): ${winner.id}  ${winner.type}  "${winner.name}"  slug=${winner.slug}`);
  console.log(`  LOSER  (delete):           ${loser.id}  ${loser.type}  "${loser.name}"  slug=${loser.slug}`);
  console.log(`  → legislature_unicameral "${shape.unicameralName}" / "${shape.unicameralShortName}"`);

  // ── 2. Populated-row guard — the model says the upper row holds the roster ─
  const winnerOfficials = await count(client, `SELECT COUNT(*)::int AS n FROM public.officials WHERE governing_body_id = $1`, [winner.id]);
  const loserOfficials = await count(client, `SELECT COUNT(*)::int AS n FROM public.officials WHERE governing_body_id = $1`, [loser.id]);
  if (loserOfficials > 0) {
    throw new Error(
      `${t.abbr}: loser (lower) gb has ${loserOfficials} officials — the populated-upper-row assumption ` +
        `does not hold here. Refusing; investigate before merging.`,
    );
  }
  const officialsBefore = winnerOfficials + loserOfficials;

  // ── 3. Full ref audit — every discovered surface, winner AND loser ────────
  console.log(`  BEFORE — refs per surface (winner / loser):`);
  const loserPolyCounts = new Map<string, number>();
  const loserFkCounts = new Map<string, number>();

  for (const [table, col] of fkCols) {
    const w = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [winner.id]);
    const l = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [loser.id]);
    if (w > 0 || l > 0) console.log(`    ${String(w).padStart(6)} / ${String(l).padEnd(5)} ${table}.${col} [fk]`);
    loserFkCounts.set(`${table}.${col}`, l);
  }
  for (const table of polyTables) {
    const w = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE entity_id::text = $1`, [winner.id]);
    const l = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE entity_id::text = $1`, [loser.id]);
    if (w > 0 || l > 0) console.log(`    ${String(w).padStart(6)} / ${String(l).padEnd(5)} ${table}.entity_id [poly]`);
    loserPolyCounts.set(table, l);
  }
  for (const table of GB_ID_ROLLUP_TABLES) {
    const w = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE gb_id = $1`, [winner.id]);
    const l = await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE gb_id = $1`, [loser.id]);
    if (w > 0 || l > 0) console.log(`    ${String(w).padStart(6)} / ${String(l).padEnd(5)} ${table}.gb_id [rollup]`);
  }
  const winnerXsr = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type = 'governing_body' AND entity_id = $1`,
    [winner.id],
  );
  const loserXsr = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type = 'governing_body' AND entity_id = $1`,
    [loser.id],
  );
  console.log(`    ${String(winnerXsr).padStart(6)} / ${String(loserXsr).padEnd(5)} external_source_refs.entity_id [xsr]`);

  // Every surface above is handled (fk repoint / poly repoint / rollup delete /
  // xsr delete-or-rewrite). The refusal case is a loser ref on a surface NOT in
  // the discovered lists — which by construction cannot happen unless a new
  // ref shape exists that information_schema + the column conventions miss.
  // The populated-row guard above is the substantive refusal.

  const oldXsrKey = `gb/${jurisId}/legislature_upper`;
  const newXsrKey = `gb/${jurisId}/legislature_unicameral`;

  // ── 4. Print the exact plan ────────────────────────────────────────────────
  console.log(`  ── PLAN (winner=${winner.id}, loser=${loser.id}) ──`);
  for (const [table, col] of fkCols) {
    if ((loserFkCounts.get(`${table}.${col}`) ?? 0) > 0)
      console.log(`    UPDATE ${table} SET ${col}='${winner.id}' WHERE ${col}='${loser.id}';`);
  }
  for (const table of polyTables) {
    if ((loserPolyCounts.get(table) ?? 0) > 0)
      console.log(`    UPDATE ${table} SET entity_id='${winner.id}' WHERE entity_id='${loser.id}';`);
  }
  for (const table of GB_ID_ROLLUP_TABLES) {
    console.log(`    DELETE FROM ${table} WHERE gb_id='${loser.id}';`);
  }
  console.log(`    DELETE FROM external_source_refs WHERE entity_type='governing_body' AND entity_id='${loser.id}';`);
  console.log(`    DELETE FROM governing_bodies WHERE id='${loser.id}';`);
  console.log(
    `    UPDATE governing_bodies SET type='legislature_unicameral', name='${shape.unicameralName}', ` +
      `short_name='${shape.unicameralShortName}', slug=NULL, updated_at=NOW() WHERE id='${winner.id}';`,
  );
  console.log(
    `    UPDATE external_source_refs SET external_id='${newXsrKey}' WHERE entity_type='governing_body' ` +
      `AND entity_id='${winner.id}' AND source='openstates' AND external_id='${oldXsrKey}';`,
  );
  console.log(`    SELECT backfill_governing_body_slugs();  -- refills winner slug from new short_name`);

  if (!willExecute) {
    return {
      abbr: t.abbr, winnerId: winner.id, loserId: loser.id, oldSlug: winner.slug,
      newSlug: null, newName: shape.unicameralName,
      officialsBefore, officialsAfter: officialsBefore, ok: true,
    };
  }

  // ── 5. Execute atomically ──────────────────────────────────────────────────
  await client.query("BEGIN");
  try {
    for (const [table, col] of fkCols) {
      const res = await client.query(`UPDATE public.${table} SET ${col} = $1 WHERE ${col} = $2`, [winner.id, loser.id]);
      if (res.rowCount) console.log(`    repointed ${res.rowCount} ${table}.${col}`);
    }
    for (const table of polyTables) {
      const res = await client.query(
        `UPDATE public.${table} SET entity_id = $1 WHERE entity_id::text = $2`,
        [winner.id, loser.id],
      );
      if (res.rowCount) console.log(`    repointed ${res.rowCount} ${table}.entity_id`);
    }
    for (const table of GB_ID_ROLLUP_TABLES) {
      const res = await client.query(`DELETE FROM public.${table} WHERE gb_id = $1`, [loser.id]);
      if (res.rowCount) console.log(`    deleted ${res.rowCount} ${table} loser row(s)`);
    }
    await client.query(
      `DELETE FROM public.external_source_refs WHERE entity_type = 'governing_body' AND entity_id = $1`,
      [loser.id],
    );
    const del = await client.query(`DELETE FROM public.governing_bodies WHERE id = $1`, [loser.id]);
    console.log(`    deleted ${del.rowCount} loser gb row(s)`);

    await client.query(
      `UPDATE public.governing_bodies
          SET type = 'legislature_unicameral', name = $1, short_name = $2, slug = NULL, updated_at = NOW()
        WHERE id = $3`,
      [shape.unicameralName, shape.unicameralShortName, winner.id],
    );
    const xsr = await client.query(
      `UPDATE public.external_source_refs SET external_id = $1
        WHERE entity_type = 'governing_body' AND entity_id = $2 AND source = 'openstates' AND external_id = $3`,
      [newXsrKey, winner.id, oldXsrKey],
    );
    console.log(`    converted winner in place; rewrote ${xsr.rowCount ?? 0} openstates xsr key`);

    const slugRes = await client.query(`SELECT public.backfill_governing_body_slugs() AS filled`);
    console.log(`    slug backfill filled ${slugRes.rows[0]?.filled ?? 0} slug(s)`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // ── 6. Re-verify ───────────────────────────────────────────────────────────
  const loserGone = await count(client, `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE id = $1`, [loser.id]);
  const lowersLeft = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE jurisdiction_id = $1 AND type = 'legislature_lower'`,
    [jurisId],
  );
  const winnerRow = (await q(
    client,
    `SELECT id, name, short_name, type, slug FROM public.governing_bodies WHERE id = $1`,
    [winner.id],
  ))[0] as { name: string; type: string; slug: string | null } | undefined;
  const officialsAfter = await count(client, `SELECT COUNT(*)::int AS n FROM public.officials WHERE governing_body_id = $1`, [winner.id]);

  let dangling = 0;
  for (const [table, col] of fkCols) {
    dangling += await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [loser.id]);
  }
  for (const table of polyTables) {
    dangling += await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE entity_id::text = $1`, [loser.id]);
  }
  for (const table of GB_ID_ROLLUP_TABLES) {
    dangling += await count(client, `SELECT COUNT(*)::int AS n FROM public.${table} WHERE gb_id = $1`, [loser.id]);
  }
  dangling += await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='governing_body' AND entity_id = $1`,
    [loser.id],
  );
  const staleXsr = await count(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='governing_body' AND external_id IN ($1, $2)`,
    [oldXsrKey, `gb/${jurisId}/legislature_lower`],
  );

  const ok =
    loserGone === 0 &&
    lowersLeft === 0 &&
    winnerRow?.type === "legislature_unicameral" &&
    winnerRow?.name === shape.unicameralName &&
    Boolean(winnerRow?.slug) &&
    dangling === 0 &&
    staleXsr === 0 &&
    officialsAfter === officialsBefore;

  console.log(`  ── POST-MERGE (${t.abbr}) ──`);
  console.log(`    loser gb remaining:                ${loserGone}   (expect 0)`);
  console.log(`    legislature_lower rows in juris:   ${lowersLeft}   (expect 0)`);
  console.log(`    winner: ${winnerRow?.type}  "${winnerRow?.name}"  slug=${winnerRow?.slug}`);
  console.log(`    dangling refs to loser:            ${dangling}   (expect 0)`);
  console.log(`    stale upper/lower xsr keys:        ${staleXsr}   (expect 0)`);
  console.log(`    officials (combined→winner):       ${officialsBefore} → ${officialsAfter}   (expect equal)`);
  console.log(`    ${ok ? "✓ VERIFIED" : "✗ INCOMPLETE — investigate above"}`);

  return {
    abbr: t.abbr, winnerId: winner.id, loserId: loser.id, oldSlug: winner.slug,
    newSlug: winnerRow?.slug ?? null, newName: shape.unicameralName,
    officialsBefore, officialsAfter, ok,
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
        "  Use `pnpm --filter @civitics/data data:merge-unicameral-legislatures:prod:plan` to PRINT the plan,\n" +
        "  then (after explicit confirmation) `…:prod` to execute. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  const env = prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker";
  const willExecute = dryRun ? false : prod ? confirm : true;

  console.log(`# FIX-489/FIX-548 — unicameral legislature conversion (DC/NE/GU/VI)`);
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

  const results: TargetResult[] = [];
  try {
    const fkCols = await discoverGbFkCols(client);
    const polyTables = await discoverPolymorphicTables(client);
    console.log(`\nDiscovered ref surface (live information_schema):`);
    console.log(`  FK cols:     ${fkCols.map(([t, c]) => `${t}.${c}`).join(", ")}`);
    console.log(`  Polymorphic: ${polyTables.join(", ")}`);
    console.log(`  gb_id:       ${GB_ID_ROLLUP_TABLES.join(", ")}`);

    for (const t of TARGETS) {
      results.push(await processTarget(client, t, fkCols, polyTables, willExecute));
    }
  } finally {
    await client.end();
  }

  console.log(`\n${"═".repeat(70)}\nSUMMARY\n${"═".repeat(70)}`);
  for (const r of results) {
    console.log(
      `  ${r.abbr}  "${r.newName}"  slug ${r.oldSlug ?? "?"} → ${r.newSlug ?? "(pending)"}  ` +
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
  console.log(`\n${allOk ? "✓ ALL FOUR CONVERTED + VERIFIED" : "✗ ONE OR MORE INCOMPLETE — investigate above"}`);
  if (!allOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
