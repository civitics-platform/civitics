/**
 * FIX-482 — merge the duplicate District of Columbia jurisdiction rows.
 *
 * Two 'District of Columbia' jurisdiction rows share fips '11':
 *   - WINNER (canonical, FIX-422 50-states+1 model):  type='federal_district'
 *   - LOSER  (resolver split, created by seedJurisdictions): type='district'
 *
 * The split is a RESOLVER bug, not an orphan dup: STATE_DATA in
 * jurisdictions/us-states.ts declared DC as type='district', so the shared
 * seedJurisdictions() lookup keyed on (fips_code, type, parent_id) never
 * matched the canonical federal_district row and created/resolved a separate
 * type='district' DC row. Every pipeline that resolves DC via the shared
 * stateIds map (openstates-bulk, congress/officials, fec-bulk candidates, …)
 * then landed officials on whichever row was current at write time, so the two
 * rows accumulate real data and their two gb pairs (DC State House/Senate)
 * duplicate (4 → 2). The root-cause resolver fix (DC → type='federal_district'
 * in STATE_DATA) lands in the SAME commit; without it the next pipeline run
 * re-splits. This script is the data-merge half.
 *
 * Recipe (mirrors the FE-merge preserve-data approach — audit FK refs, repoint,
 * never bare-DELETE a loser that holds real data):
 *   1. Resolve winner + loser live (by fips/type/name — never hardcode UUIDs;
 *      prod UUIDs differ from local). Hard asserts: exactly one of each, loser
 *      name is exactly 'District of Columbia' (so the 'District of Columbia
 *      Delegate District (at Large)' row — also type='district', fips '11' on
 *      prod — is NEVER touched), and the county row (fips '11001') is untouched.
 *   2. Live FK-surface audit of the loser jurisdiction + its 2 gbs across every
 *      FK constraint that references jurisdictions/governing_bodies, plus the
 *      secondary non-FK references (external_source_refs.entity_id, officials
 *      .metadata->>'district_jurisdiction_id').
 *   3. Repoint gb references onto the winner gb OF THE SAME TYPE (House→House,
 *      Senate→Senate) via a type-join, and jurisdiction references onto the
 *      winner row. Delete the loser gbs' external_source_refs (they re-seed for
 *      the winner gbs on the next backfill-gb-attribution run).
 *   4. Delete the 2 loser gbs, then the loser jurisdiction row.
 *   5. Re-audit: zero dangling refs to the loser, loser rows gone, winner intact.
 *
 * Per-env, backfill-style (NOT a migration — a migration auto-runs on prod via
 * db:push and would sidestep the destructive-SQL confirmation rule). Atomic:
 * every write runs inside one transaction, so a unique-constraint conflict on a
 * rare repoint (e.g. institution_extensions) rolls the whole thing back cleanly
 * rather than landing half-done — that surfaces as "stop and report".
 *
 * Single pg.Client against the ACTIVE env (local Docker, or prod via
 * --env-file=.env.local.prod + SUPABASE_DB_PASSWORD), sidestepping the
 * PostgREST 1000-row cap — same shape as backfill-gb-attribution.ts (FIX-477).
 *
 * Run local (executes by default — local is free per the DB safety rules):
 *   pnpm --filter @civitics/data data:merge-dc-jurisdiction
 *   pnpm --filter @civitics/data data:merge-dc-jurisdiction -- --dry-run   # plan only
 *
 * Prod is GATED (decision 2): the prod plan command prints the exact statements
 * + live counts and STOPS (no writes) for explicit confirmation in chat:
 *   pnpm --filter @civitics/data data:merge-dc-jurisdiction:prod:plan
 * Only after Craig's go, run the executing variant:
 *   pnpm --filter @civitics/data data:merge-dc-jurisdiction:prod
 */

import { Client } from "pg";

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
// Repointed onto the winner gb of the SAME type via a type-join.
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
// .jurisdiction_id is excluded — those ARE the loser gbs, which get deleted.)
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

async function auditRefs(
  client: Client,
  loserJurisdiction: string,
  loserGbIds: string[],
): Promise<{ rows: Array<{ ref: string; n: number }>; totalLoser: number }> {
  const out: Array<{ ref: string; n: number }> = [];

  for (const [table, col] of JURIS_REF_COLS) {
    const r = await q(
      client,
      `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = $1`,
      [loserJurisdiction],
    );
    out.push({ ref: `${table}.${col} → loser jurisdiction`, n: r[0].n as number });
  }
  // the 2 loser gbs themselves (governing_bodies.jurisdiction_id) — deleted, not repointed
  const gbSelf = await q(
    client,
    `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE jurisdiction_id = $1`,
    [loserJurisdiction],
  );
  out.push({ ref: `governing_bodies.jurisdiction_id (loser gbs, to delete)`, n: gbSelf[0].n as number });

  for (const [table, col] of GB_REF_COLS) {
    const r = await q(
      client,
      `SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = ANY($1::uuid[])`,
      [loserGbIds],
    );
    out.push({ ref: `${table}.${col} → loser gbs`, n: r[0].n as number });
  }

  // secondary / non-FK references
  const xsrJ = await q(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='jurisdiction' AND entity_id=$1`,
    [loserJurisdiction],
  );
  out.push({ ref: `external_source_refs (jurisdiction) → loser`, n: xsrJ[0].n as number });
  const xsrG = await q(
    client,
    `SELECT COUNT(*)::int AS n FROM public.external_source_refs WHERE entity_type='governing_body' AND entity_id = ANY($1::uuid[])`,
    [loserGbIds],
  );
  out.push({ ref: `external_source_refs (governing_body) → loser gbs`, n: xsrG[0].n as number });
  const meta = await q(
    client,
    `SELECT COUNT(*)::int AS n FROM public.officials WHERE metadata->>'district_jurisdiction_id' = $1`,
    [loserJurisdiction],
  );
  out.push({ ref: `officials.metadata->>'district_jurisdiction_id' → loser`, n: meta[0].n as number });

  // dangling-after-delete signal: everything except the gbs-to-delete row
  const totalLoser = out
    .filter((r) => !r.ref.startsWith("governing_bodies.jurisdiction_id"))
    .reduce((a, r) => a + r.n, 0);
  return { rows: out, totalLoser };
}

function printAudit(title: string, rows: Array<{ ref: string; n: number }>): void {
  console.log(`\n${title}`);
  for (const r of rows) {
    if (r.n > 0) console.log(`  ${String(r.n).padStart(5)}  ${r.ref}`);
  }
  const zero = rows.filter((r) => r.n === 0).length;
  console.log(`  (+ ${zero} reference site(s) with 0 rows)`);
}

async function main(): Promise<void> {
  const prod = isProd();
  const allowProd = process.argv.includes("--allow-prod");
  const confirm = process.argv.includes("--confirm");
  const dryRun = process.argv.includes("--dry-run");

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  Use `pnpm --filter @civitics/data data:merge-dc-jurisdiction:prod:plan` to PRINT the plan,\n" +
        "  then (after explicit confirmation) `…:prod` to execute. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  const env = prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker";

  // Execute by default on local; on prod require --confirm (the chat gate).
  const willExecute = dryRun ? false : prod ? confirm : true;

  console.log(`# FIX-482 — DC jurisdiction merge`);
  console.log(`Env:        ${env}`);
  console.log(`Connection: ${masked}`);
  console.log(
    `Mode:       ${
      willExecute
        ? prod
          ? "PROD WRITE (--allow-prod --confirm given)"
          : "local write"
        : "PLAN ONLY (no writes)"
    }`,
  );

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  try {
    // ── 1. Resolve winner + loser live (never hardcode UUIDs) ──────────────
    const winner = await resolveOne(
      client,
      "WINNER (federal_district DC)",
      `SELECT id, name, short_name, type, fips_code, parent_id
         FROM public.jurisdictions
        WHERE fips_code = '11' AND type = 'federal_district'`,
      [],
    );
    const loser = await resolveOne(
      client,
      "LOSER (district DC)",
      `SELECT id, name, short_name, type, fips_code, parent_id
         FROM public.jurisdictions
        WHERE fips_code = '11' AND type = 'district' AND name = 'District of Columbia'`,
      [],
    );

    if (winner.id === loser.id) throw new Error("winner and loser resolved to the same row — aborting.");
    if (loser.fips_code === "11001") throw new Error("loser is the county row (fips 11001) — aborting.");

    console.log(`\nWINNER (canonical):  ${winner.id}  ${winner.type}  "${winner.name}" (${winner.short_name})`);
    console.log(`LOSER  (to merge):   ${loser.id}  ${loser.type}  "${loser.name}" (${loser.short_name})`);

    // Loud confirmation that the explicitly-out-of-scope rows are visible and untouched.
    const survivors = await q(
      client,
      `SELECT id, name, type, fips_code FROM public.jurisdictions
        WHERE fips_code IN ('11','11001')
          AND id <> $1
        ORDER BY type, name`,
      [loser.id],
    );
    console.log(`\nOther fips-11* DC-area rows (MUST survive untouched):`);
    for (const r of survivors) {
      console.log(`  ${r.id}  ${r.type}  fips=${r.fips_code}  "${r.name}"`);
    }

    // ── Resolve gb pairs + build the type-map ──────────────────────────────
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
    for (const lg of loserGbs) {
      if (!winnerByType.has(lg.type)) {
        throw new Error(
          `Loser gb ${lg.id} ("${lg.name}", type=${lg.type}) has no winner gb of the same type — ` +
            `refusing to orphan it. Resolve manually.`,
        );
      }
    }
    console.log(`\ngb type-map (loser → winner, repointed House→House / Senate→Senate):`);
    for (const lg of loserGbs) {
      const wg = winnerByType.get(lg.type)!;
      console.log(`  ${lg.id} (${lg.type}) → ${wg.id}`);
    }
    const loserGbIds = loserGbs.map((g) => g.id);

    // ── 2. Live FK-surface audit ───────────────────────────────────────────
    const before = await auditRefs(client, loser.id, loserGbIds);
    printAudit("BEFORE — references to the LOSER (jurisdiction + gbs):", before.rows);

    // ── Print the exact plan (statements + bound params) ───────────────────
    console.log(`\n── PLAN — exact statements (params: winner=${winner.id}, loser=${loser.id}) ──`);
    for (const [table, col] of GB_REF_COLS) {
      console.log(
        `  UPDATE ${table} t SET ${col} = w.id FROM governing_bodies l ` +
          `JOIN governing_bodies w ON w.jurisdiction_id='${winner.id}' AND w.type=l.type ` +
          `WHERE l.jurisdiction_id='${loser.id}' AND t.${col}=l.id;`,
      );
    }
    for (const [table, col] of JURIS_REF_COLS) {
      console.log(`  UPDATE ${table} SET ${col}='${winner.id}' WHERE ${col}='${loser.id}';`);
    }
    console.log(
      `  UPDATE officials SET metadata = jsonb_set(metadata,'{district_jurisdiction_id}',to_jsonb('${winner.id}'::text)) ` +
        `WHERE metadata->>'district_jurisdiction_id'='${loser.id}';`,
    );
    console.log(
      `  DELETE FROM external_source_refs WHERE (entity_type='governing_body' AND entity_id = ANY('{${loserGbIds.join(",")}}')) ` +
        `OR (entity_type='jurisdiction' AND entity_id='${loser.id}');`,
    );
    console.log(`  DELETE FROM governing_bodies WHERE id = ANY('{${loserGbIds.join(",")}}');`);
    console.log(`  DELETE FROM jurisdictions WHERE id='${loser.id}';`);

    if (!willExecute) {
      console.log(
        `\n⏸  PLAN ONLY — no writes performed.` +
          (prod
            ? `\n   Prod execution is gated: re-run with the executing variant (…:prod, which adds --confirm)\n   only after explicit confirmation of the statements above.`
            : `\n   (--dry-run given.)`),
      );
      await client.end();
      return;
    }

    // ── 3 + 4. Execute, atomically ─────────────────────────────────────────
    let totalRepointed = 0;
    await client.query("BEGIN");
    try {
      for (const [table, col] of GB_REF_COLS) {
        const res = await client.query(
          `UPDATE public.${table} t SET ${col} = w.id
             FROM public.governing_bodies l
             JOIN public.governing_bodies w
               ON w.jurisdiction_id = $1 AND w.type = l.type
            WHERE l.jurisdiction_id = $2 AND t.${col} = l.id`,
          [winner.id, loser.id],
        );
        if (res.rowCount) {
          console.log(`  repointed ${res.rowCount} ${table}.${col} (gb → winner gb of same type)`);
          totalRepointed += res.rowCount;
        }
      }
      for (const [table, col] of JURIS_REF_COLS) {
        const res = await client.query(
          `UPDATE public.${table} SET ${col} = $1 WHERE ${col} = $2`,
          [winner.id, loser.id],
        );
        if (res.rowCount) {
          console.log(`  repointed ${res.rowCount} ${table}.${col} (→ winner jurisdiction)`);
          totalRepointed += res.rowCount;
        }
      }
      const metaRes = await client.query(
        `UPDATE public.officials
            SET metadata = jsonb_set(metadata, '{district_jurisdiction_id}', to_jsonb($1::text))
          WHERE metadata->>'district_jurisdiction_id' = $2`,
        [winner.id, loser.id],
      );
      if (metaRes.rowCount) console.log(`  repointed ${metaRes.rowCount} officials.metadata.district_jurisdiction_id`);

      const xsrRes = await client.query(
        `DELETE FROM public.external_source_refs
          WHERE (entity_type = 'governing_body' AND entity_id = ANY($1::uuid[]))
             OR (entity_type = 'jurisdiction' AND entity_id = $2)`,
        [loserGbIds, loser.id],
      );
      if (xsrRes.rowCount) console.log(`  deleted ${xsrRes.rowCount} external_source_refs row(s) for loser gbs/jurisdiction`);

      const gbDel = await client.query(
        `DELETE FROM public.governing_bodies WHERE id = ANY($1::uuid[])`,
        [loserGbIds],
      );
      console.log(`  deleted ${gbDel.rowCount} loser governing_bodies row(s)`);

      const jDel = await client.query(`DELETE FROM public.jurisdictions WHERE id = $1`, [loser.id]);
      console.log(`  deleted ${jDel.rowCount} loser jurisdiction row(s)`);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    console.log(`\n  total references repointed: ${totalRepointed}`);

    // ── 5. Re-audit ────────────────────────────────────────────────────────
    const loserGone = (await q(client, `SELECT COUNT(*)::int AS n FROM public.jurisdictions WHERE id = $1`, [loser.id]))[0]
      .n as number;
    const loserGbsGone = (await q(
      client,
      `SELECT COUNT(*)::int AS n FROM public.governing_bodies WHERE id = ANY($1::uuid[])`,
      [loserGbIds],
    ))[0].n as number;
    const winnerStill = (await q(client, `SELECT COUNT(*)::int AS n FROM public.jurisdictions WHERE id = $1`, [winner.id]))[0]
      .n as number;
    const after = await auditRefs(client, loser.id, loserGbIds);

    console.log(`\n── POST-MERGE verification ──`);
    console.log(`  loser jurisdiction rows remaining:        ${loserGone}   (expect 0)`);
    console.log(`  loser gb rows remaining:                  ${loserGbsGone}   (expect 0)`);
    console.log(`  winner jurisdiction rows present:         ${winnerStill}   (expect 1)`);
    console.log(`  dangling references to loser remaining:   ${after.totalLoser}   (expect 0)`);
    printAudit("AFTER — references to the loser (expect all-zero):", after.rows);

    const ok = loserGone === 0 && loserGbsGone === 0 && winnerStill === 1 && after.totalLoser === 0;
    // exactly one state-level fips-11 DC row should remain (the winner)
    const stateLevel = await q(
      client,
      `SELECT id, type, name FROM public.jurisdictions
        WHERE fips_code = '11' AND type IN ('state','federal_district')`,
    );
    console.log(`\n  state-level fips-11 DC rows remaining: ${stateLevel.length}   (expect 1: the federal_district winner)`);
    for (const r of stateLevel) console.log(`    ${r.id}  ${r.type}  "${r.name}"`);

    console.log(`\n${ok && stateLevel.length === 1 ? "✓ MERGE VERIFIED" : "✗ MERGE INCOMPLETE — investigate above"}`);
    if (!(ok && stateLevel.length === 1)) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
