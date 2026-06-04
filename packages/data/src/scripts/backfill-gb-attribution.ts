/**
 * FIX-477 — governing_bodies attribution backfill.
 *
 * State-legislature, federal-chamber, and CourtListener-court governing_bodies
 * carry no primary_source, so their /institutions/[id] pages render no
 * SourceBadge even though FIX-473 wired the column through. The
 * xsr→primary_source materialization that FIX-402 added for governing_bodies
 * only ever covered the legistar-created bodies (source='legistar:<metro>:body')
 * — the ~117 openstates chambers + 13 CourtListener courts never got an
 * external_source_refs row, so refresh_primary_source_for_entities had nothing
 * to materialize.
 *
 * This is the backfill VEHICLE (the writer-side upserts in
 * openstates/writer.ts + courtlistener/writer.ts keep FUTURE rows covered, but
 * a full pipeline run is too heavy to be the backfill mechanism). It seeds REAL
 * external_source_refs rows per cohort, then calls
 * refresh_primary_source_for_entities('governing_body', …) so the existing
 * machinery materializes the primary_source* columns. xsr is seeded (not a
 * synthetic primary_source fill) so the FIX-400 attribution popover — which
 * reads xsr — lists a source rather than showing a badge over an empty list.
 *
 * Cohorts (see FIX-477 design decisions):
 *   1. State / territory chambers (openstates/writer.ts resolveGoverningBodies)
 *      → source='openstates'. No captured org id (metadata is {}), so the
 *      external_id is a deterministic synthetic key derived from stable row
 *      facts: gb/<jurisdiction_id>/<gb.type>. (jurisdiction_id is the only
 *      fact that is both stable-within-env AND unique per gb — fips/abbr
 *      collide on the duplicate-DC-jurisdiction pollution, two DC jurisdictions
 *      sharing fips 11.) The writer derives the identical key.
 *   2. Federal chambers (US Senate / US House) → source='congress_gov',
 *      external_id='chamber/senate' | 'chamber/house'. Distinguished from the
 *      state chambers by their country-level jurisdiction. Script-only coverage
 *      (the congress pipeline isn't in this FIX's writer scope) — fine, the
 *      two rows are effectively static.
 *   3. CourtListener courts (courtlistener/writer.ts) → source='courtlistener',
 *      external_id = metadata->>'courtlistener_court_id' (real id, on every row).
 *   4. Executive seed rows (OPOTUS etc.) + judiciary seed rows (Federal
 *      Judiciary, a seed SCOTUS with no court id) → LEFT NULL, intentionally.
 *      Seed-created rows with no external source get no badge — that's honest
 *      (same call as the 8 EOP-shaped agencies in FIX-410).
 *
 * source_url is left NULL on every seeded row: there is no confidently-stable
 * public per-chamber/per-court URL for these three sources (openstates'
 * external_id is a synthetic UUID key anyway; congress.gov + courtlistener
 * return 403 to verification and have no clean per-chamber landing), and
 * decision 4 / the existing attribution rule is "null is correct, never
 * synthesize a URL that might 404." The badge renders from primary_source
 * regardless; the popover lists the source without a backlink.
 *
 * Idempotent: ON CONFLICT (source, external_id) DO UPDATE bumps last_seen_at
 * and leaves entity_id untouched, so re-running adds zero rows, changes no
 * primary_source, and just refreshes freshness — the same both-paths semantics
 * the writer coverage uses.
 *
 * Mirrors audit-gb-membership-pollution.ts (FIX-470): a single pg.Client
 * against the ACTIVE env (local Docker, or prod via --env-file=.env.local.prod
 * + SUPABASE_DB_PASSWORD). Using pg.Client (not supabase-js) sidesteps the
 * PostgREST 1000-row max_rows cap entirely — every read/write is server-side,
 * so no pagination is needed for the ~130-row entity set.
 *
 * Run local:
 *   pnpm --filter @civitics/data data:backfill-gb-attribution
 * Run prod (writes — requires the explicit allow flag):
 *   pnpm --filter @civitics/data data:backfill-gb-attribution:prod
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

// Cohort labelling — the single source of truth for both the before/after
// NULL report and the per-cohort upserts. Kept as a SQL fragment so the
// report and the seed predicates can never drift.
const COHORT_LABEL_SQL = `
  CASE
    WHEN gb.type IN ('legislature_upper','legislature_lower','legislature_unicameral')
         AND j.type IS DISTINCT FROM 'country'
      THEN 'openstates_state_chamber'
    WHEN gb.type IN ('legislature_upper','legislature_lower')
         AND j.type = 'country'
      THEN 'congress_federal_chamber'
    WHEN gb.type = 'judicial'
         AND gb.metadata ? 'courtlistener_court_id'
         AND nullif(gb.metadata->>'courtlistener_court_id','') IS NOT NULL
      THEN 'courtlistener_court'
    ELSE 'other_or_intentional_null'
  END
`;

async function cohortNullCounts(client: Client): Promise<Row[]> {
  return q(
    client,
    `WITH labeled AS (
       SELECT gb.id, gb.primary_source, ${COHORT_LABEL_SQL} AS cohort
         FROM public.governing_bodies gb
         LEFT JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
     )
     SELECT cohort,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE primary_source IS NULL)::int AS null_ps
       FROM labeled
      GROUP BY cohort
      ORDER BY cohort`,
  );
}

interface Cohort {
  key: string;
  // INSERT … SELECT … RETURNING entity_id. ON CONFLICT bumps last_seen_at only.
  sql: string;
}

const COHORTS: Cohort[] = [
  {
    key: "openstates_state_chamber",
    sql: `
      INSERT INTO public.external_source_refs
        (source, external_id, entity_type, entity_id, source_url, last_seen_at, metadata)
      SELECT 'openstates',
             'gb/' || gb.jurisdiction_id::text || '/' || gb.type::text,
             'governing_body',
             gb.id,
             NULL,
             now(),
             '{}'::jsonb
        FROM public.governing_bodies gb
        JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
       WHERE gb.type IN ('legislature_upper','legislature_lower','legislature_unicameral')
         AND j.type IS DISTINCT FROM 'country'
      ON CONFLICT (source, external_id)
        DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
      RETURNING entity_id`,
  },
  {
    key: "congress_federal_chamber",
    sql: `
      INSERT INTO public.external_source_refs
        (source, external_id, entity_type, entity_id, source_url, last_seen_at, metadata)
      SELECT 'congress_gov',
             CASE gb.type
               WHEN 'legislature_upper' THEN 'chamber/senate'
               WHEN 'legislature_lower' THEN 'chamber/house'
             END,
             'governing_body',
             gb.id,
             NULL,
             now(),
             '{}'::jsonb
        FROM public.governing_bodies gb
        JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
       WHERE gb.type IN ('legislature_upper','legislature_lower')
         AND j.type = 'country'
      ON CONFLICT (source, external_id)
        DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
      RETURNING entity_id`,
  },
  {
    key: "courtlistener_court",
    sql: `
      INSERT INTO public.external_source_refs
        (source, external_id, entity_type, entity_id, source_url, last_seen_at, metadata)
      SELECT 'courtlistener',
             gb.metadata->>'courtlistener_court_id',
             'governing_body',
             gb.id,
             NULL,
             now(),
             '{}'::jsonb
        FROM public.governing_bodies gb
       WHERE gb.type = 'judicial'
         AND gb.metadata ? 'courtlistener_court_id'
         AND nullif(gb.metadata->>'courtlistener_court_id','') IS NOT NULL
      ON CONFLICT (source, external_id)
        DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
      RETURNING entity_id`,
  },
];

function printCohortTable(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log("  cohort                       total  null_primary_source");
  console.log("  ---------------------------  -----  -------------------");
  for (const r of rows) {
    const cohort = String(r.cohort).padEnd(27);
    const total = String(r.total).padStart(5);
    const nullPs = String(r.null_ps).padStart(19);
    console.log(`  ${cohort}  ${total}  ${nullPs}`);
  }
}

async function main(): Promise<void> {
  const prod = isProd();
  const allowProd = process.argv.includes("--allow-prod");
  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD (xsazcoxinpgttgquwvuf) but --allow-prod was not passed.\n" +
        "  This script WRITES external_source_refs rows. Re-run via\n" +
        "  `pnpm --filter @civitics/data data:backfill-gb-attribution:prod` (which passes --allow-prod),\n" +
        "  or add --allow-prod explicitly. Refusing to write to prod by accident.",
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  const env = prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker";

  console.log(`# FIX-477 — governing_bodies attribution backfill`);
  console.log(`Env:        ${env}`);
  console.log(`Connection: ${masked}`);
  console.log(`Mode:       ${prod ? "PROD WRITE (--allow-prod given)" : "local write"}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  // ── BEFORE (read-only) ────────────────────────────────────────────────
  const before = await cohortNullCounts(client);
  printCohortTable("BEFORE — governing_bodies with NULL primary_source, by cohort:", before);

  // ── Per-cohort xsr upserts + refresh, in one transaction ──────────────
  const touched = new Set<string>();
  await client.query("BEGIN");
  try {
    for (const cohort of COHORTS) {
      const res = await client.query(cohort.sql);
      const n = res.rows.length;
      for (const r of res.rows as Array<{ entity_id: string }>) touched.add(r.entity_id);
      console.log(`\n  cohort ${cohort.key}: ${n} xsr row(s) upserted`);
    }

    const ids = [...touched];
    if (ids.length > 0) {
      const refreshed = await q(
        client,
        `SELECT public.refresh_primary_source_for_entities('governing_body', $1::uuid[]) AS n`,
        [ids],
      );
      console.log(
        `\n  refresh_primary_source_for_entities('governing_body', ${ids.length} ids) → ${refreshed[0]?.n} row(s) updated`,
      );
    } else {
      console.log(`\n  (no entity ids touched — skipping refresh)`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // ── AFTER ──────────────────────────────────────────────────────────────
  const after = await cohortNullCounts(client);
  printCohortTable("AFTER — governing_bodies with NULL primary_source, by cohort:", after);

  // ── Idempotency evidence: gb xsr row counts by source ─────────────────
  const xsrCounts = await q(
    client,
    `SELECT source, COUNT(*)::int AS n
       FROM public.external_source_refs
      WHERE entity_type = 'governing_body'
        AND source IN ('openstates','congress_gov','courtlistener')
      GROUP BY source ORDER BY source`,
  );
  console.log(`\nGoverning-body xsr rows by source (re-run leaves these identical):`);
  for (const r of xsrCounts) console.log(`  ${String(r.source).padEnd(14)} ${r.n}`);

  const remainingNull = (after.find((r) => r.cohort === "other_or_intentional_null")?.null_ps as number) ?? 0;
  console.log(
    `\nRemaining NULL primary_source (intentional — executive/judiciary seed rows with no external source): ${remainingNull}`,
  );

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
