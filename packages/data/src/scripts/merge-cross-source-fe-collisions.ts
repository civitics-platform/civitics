/**
 * FIX-544 — Cross-source canonical-collision merge (org-only, gated).
 *
 * Background & investigation
 * --------------------------
 * The FIX-380 closeout (2026-06-09) flagged cross-source `canonical_name`
 * collisions where a LittleSis-bound `financial_entities` row shares a name
 * with non-LS (FEC / IRS / EDGAR / USASpending) rows — nominally "3,414
 * clusters". The FIX-544 investigation (2026-07-16) re-measured on live prod
 * and found the residue is ~15x larger (54,055 clusters) and **overwhelmingly
 * unmergeable individual common-name collisions**: `financial_entities.
 * canonical_name` for FEC individuals is the bare natural-order name (the zip
 * lives only in the separate `donor_fingerprint` UNIQUE column), so one name
 * legitimately spans many *different people* (e.g. "ADAM BECK" = 6 distinct
 * donors across 6 states). Per the FIX-273 lesson, individuals must NEVER
 * auto-merge on name.
 *
 * The genuinely-eligible residue is small and **org-only**. This script merges
 * exactly two tightly-gated, non-individual populations (canonical_name +
 * entity_type clusters):
 *
 *   P3 — committee dupes: a cluster with EXACTLY ONE `fec_committee_id`-bearing
 *        row (the FEC committee) + >=1 pure LittleSis-profile row (has a
 *        `littlesis` external_source_ref, no `fec_committee_id`). Winner = the
 *        FEC committee (canonical identifiers/edges); losers = the LS
 *        profile(s), folded in — preserving the LS provenance via
 *        external_source_refs. Clusters with >1 FEC committee row (distinct
 *        committees sharing a name, e.g. GREAT AMERICA C00640664 vs C00608489)
 *        are EXCLUDED. This is the population FIX-271 deliberately skipped
 *        (its org scope required fec_committee_id IS NULL); we merge it here
 *        because the LS row is a same-named *profile* of the committee, not a
 *        separate committee.
 *
 *   P2 — non-committee org dupes: a cluster (fec_committee_id IS NULL, >=2 rows)
 *        with EXACTLY ONE source-bound row (littlesis / irs_990 / sec_edgar /
 *        usaspending_recipient) + >=1 UNBOUND same-name stub. Winner = the sole
 *        bound (source-verified) row; losers = the unbound stubs. This is
 *        FIX-271's org rule TIGHTENED from ">=1 binding, winner = most
 *        bindings" to "exactly 1 binding" so the survivor is unambiguous;
 *        multi-binding clusters (e.g. CARDINAL HEALTH: usaspending + littlesis)
 *        are EXCLUDED and left for a future, edge-confirmed pass.
 *
 * Individuals: ZERO merged. There is no corroborating signal (an LS stub
 * shares nothing with a same-name FEC donor beyond the name) and the
 * false-positive harm is real (attributing an LS person's profile to a random
 * same-name donor). See docs/audits for the full segmented investigation.
 *
 * FK-rewrite surface
 * ------------------
 * The 2026-05-25 FE FK-surface audit (docs/audits/2026-05-25-fe-fk-surface-*)
 * enumerated 11-12 tables. This script re-confirmed the surface GREW
 * post-cutover; it rewrites the full current surface:
 *   - financial_relationships (from_id/to_id, relcycle-unique — pre-delete
 *     colliders then UPDATE, FIX-379 pattern)
 *   - external_relationships  (from_id/to_id, straight UPDATE)
 *   - external_source_refs    (entity_id, pre-delete (source,external_id)
 *     collider then UPDATE — moves LS provenance to the survivor)
 *   - edgar_companies / edgar_executive_officers / edgar_major_shareholders /
 *     irs990_filings.financial_entity_id / irs990_officers.matched_entity_id /
 *     irs990_grants_out.matched_entity_id / financial_entities.parent_entity_id
 *   - entity_tags (pre-delete collider + UPDATE)
 *   - enrichment_queue (TEXT entity_id, pre-delete collider + UPDATE)
 *   - ai_summary_cache (pre-delete collider + UPDATE)
 *   - NEW since 2026-05-25: evidence_cards (from_id/to_id), synthetic_entities
 *     (entity_id), and the entity_comments / entity_positions /
 *     entity_statements / entity_activity_state / position_events /
 *     synthetic_position_rollup family (entity_id; FE allowed by CHECK, 0 FE
 *     rows today but rewritten defensively).
 *
 * Derived / re-derivable rollups (per FIX-544 decision: DELETE-affected, let
 * scheduled rebuilds repopulate — NOT synchronous rewrite):
 *   - entity_connections, entity_search_index, group_donor_rollup, and the
 *     _next stats staging tables + browse_facet_counts when present.
 *   Rows referencing any winner or loser id are deleted; the twice-weekly
 *   rebuild_entity_connections + the pg_cron rollup refreshes repopulate the
 *   surviving winner ids (graph/search stale up to a few days — accepted).
 *
 * Safety
 * ------
 * - Whole run is ONE transaction. Default is --dry-run (ROLLBACK + full
 *   report). --apply COMMITs.
 * - PROD requires --allow-prod (mirrors the other direct-pg backfills).
 * - Sanity bound: aborts if the loser set exceeds MAX_LOSERS.
 * - Invariants verified before commit: SUM(total_donated_cents) and
 *   SUM(total_received_cents) across financial_entities are unchanged (losers'
 *   totals fold into winners); post-merge eligible residue = 0; no FK table
 *   still references a deleted loser id.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:merge-fe-collisions            # local dry-run
 *   pnpm --filter @civitics/data data:merge-fe-collisions -- --apply # local apply
 *   pnpm --filter @civitics/data data:merge-fe-collisions:prod -- --dry-run
 *   pnpm --filter @civitics/data data:merge-fe-collisions:prod -- --apply   # PROD (adds --allow-prod)
 */

import { Client } from "pg";

const MAX_LOSERS = 2000; // sanity bound; investigation measured ~277 on prod-clone

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "postgresql://postgres:postgres@127.0.0.1:54322/postgres"; // local Docker
  const password = process.env["SUPABASE_DB_PASSWORD"];
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

async function q<T = Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await client.query(sql, params);
  return res.rows as T[];
}

/** Run a mutating statement, return affected row count. */
async function run(client: Client, label: string, sql: string): Promise<number> {
  const res = await client.query(sql);
  const n = res.rowCount ?? 0;
  console.log(`  ${label.padEnd(52)} ${String(n).padStart(8)}`);
  return n;
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const r = await q<{ ok: boolean }>(
    client,
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`public.${name}`],
  );
  return Boolean(r[0]?.ok);
}

async function colExists(client: Client, table: string, col: string): Promise<boolean> {
  const r = await q<{ ok: boolean }>(
    client,
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, col],
  );
  return Boolean(r[0]?.ok);
}

/** Build the _feflag / _p3 / _p2 / _loser_remap / _affected temp tables. */
async function buildRemap(client: Client): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE _feflag ON COMMIT DROP AS
    SELECT f.id, f.canonical_name, f.entity_type,
      (f.fec_committee_id IS NOT NULL) AS is_cmte,
      EXISTS(SELECT 1 FROM external_source_refs r
              WHERE r.entity_type='financial_entity' AND r.entity_id=f.id
                AND r.source='littlesis') AS has_ls,
      EXISTS(SELECT 1 FROM external_source_refs r
              WHERE r.entity_type='financial_entity' AND r.entity_id=f.id
                AND r.source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient')) AS has_bind
    FROM financial_entities f
    WHERE f.entity_type <> 'individual'
      AND f.canonical_name IS NOT NULL AND f.canonical_name <> ''
      AND NOT COALESCE(f.is_synthetic, false);  -- SF-P1 quarantine: never merge Franklin synthetics
    CREATE INDEX ON _feflag(canonical_name, entity_type);
  `);

  // P3 — committee dupes: exactly 1 committee row (the FEC committee is the
  // source-verified survivor). Losers = same-name non-committee rows that are
  // either LS profiles (has_ls — a cross-source-attested same-named committee
  // profile) OR unbound stubs (no source binding at all — empty same-name
  // duplicates). Other-bound rows (usaspending / edgar / irs, NOT LS) are LEFT:
  // a same-named federal-contractor / filer identity may be a genuinely
  // distinct entity, so it is not folded on name alone. Consistent with P2,
  // which likewise folds unbound stubs into its single identified survivor.
  await client.query(`
    CREATE TEMP TABLE _p3 ON COMMIT DROP AS
    WITH c AS (
      SELECT canonical_name, entity_type,
        count(*) FILTER (WHERE is_cmte)                        AS cmte_rows,
        (array_agg(id) FILTER (WHERE is_cmte))[1]              AS winner_id,
        array_agg(id) FILTER (WHERE NOT is_cmte AND (has_ls OR NOT has_bind)) AS loser_ids
      FROM _feflag GROUP BY canonical_name, entity_type
    )
    SELECT winner_id, unnest(loser_ids) AS loser_id
    FROM c
    WHERE cmte_rows = 1 AND coalesce(array_length(loser_ids,1),0) >= 1;
  `);

  // P2 — non-committee org dupes: exactly 1 bound row + >=1 unbound stub.
  // Exclude any canonical that has a committee row — those clusters belong to
  // P3, and a shared LS-profile row must not be both a P3 loser and a P2 winner.
  await client.query(`
    CREATE TEMP TABLE _p2 ON COMMIT DROP AS
    WITH cmte_canons AS (
      SELECT DISTINCT canonical_name, entity_type FROM _feflag WHERE is_cmte
    ),
    mg AS (
      SELECT f.* FROM _feflag f
      WHERE NOT f.is_cmte
        AND NOT EXISTS (
          SELECT 1 FROM cmte_canons cc
           WHERE cc.canonical_name = f.canonical_name
             AND cc.entity_type    = f.entity_type
        )
    ),
    c AS (
      SELECT canonical_name, entity_type,
        count(*)                              AS n,
        count(*) FILTER (WHERE has_bind)      AS bound_rows,
        (array_agg(id) FILTER (WHERE has_bind))[1]     AS winner_id,
        array_agg(id) FILTER (WHERE NOT has_bind)      AS loser_ids
      FROM mg GROUP BY canonical_name, entity_type
    )
    SELECT winner_id, unnest(loser_ids) AS loser_id
    FROM c
    WHERE n >= 2 AND bound_rows = 1;
  `);

  await client.query(`
    CREATE TEMP TABLE _loser_remap ON COMMIT DROP AS
      SELECT loser_id, winner_id FROM _p3
      UNION ALL
      SELECT loser_id, winner_id FROM _p2;
  `);
  // Belt-and-braces: a row that is somehow a winner AND a loser must not be
  // deleted. (Disjoint by construction — losers are never committee/bound
  // winners — but enforce anyway.)
  await client.query(
    `DELETE FROM _loser_remap WHERE loser_id IN (SELECT winner_id FROM _loser_remap);`,
  );
  await client.query(`CREATE UNIQUE INDEX ON _loser_remap(loser_id);`);
  await client.query(`CREATE INDEX ON _loser_remap(winner_id);`);

  await client.query(`
    CREATE TEMP TABLE _affected ON COMMIT DROP AS
      SELECT DISTINCT winner_id AS id FROM _loser_remap
      UNION
      SELECT DISTINCT loser_id AS id FROM _loser_remap;
    CREATE INDEX ON _affected(id);
  `);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = !apply; // default is dry-run
  const allowProd = argv.includes("--allow-prod");
  const prod = isProd();

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD (xsazcoxinpgttgquwvuf) but --allow-prod was not passed.\n" +
        "  This script MERGES + DELETES financial_entities rows. Re-run via\n" +
        "  `pnpm --filter @civitics/data data:merge-fe-collisions:prod -- --apply` (adds --allow-prod),\n" +
        "  or add --allow-prod explicitly. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }

  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  console.log(`# FIX-544 — cross-source FE collision merge (org-only, gated)`);
  console.log(`Env:        ${prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker"}`);
  console.log(`Connection: ${masked}`);
  console.log(`Mode:       ${apply ? "APPLY (COMMIT)" : "DRY-RUN (ROLLBACK)"}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");

  await client.query("BEGIN");
  try {
    // ── Pre-merge invariants ────────────────────────────────────────────
    const [pre] = await q<{ don: string; rec: string; n: string }>(
      client,
      `SELECT coalesce(sum(total_donated_cents),0)::text AS don,
              coalesce(sum(total_received_cents),0)::text AS rec,
              count(*)::text AS n
         FROM financial_entities`,
    );

    // ── Build the loser→winner remap ───────────────────────────────────
    await buildRemap(client);
    const [counts] = await q<{ p3: string; p2: string; losers: string; winners: string }>(
      client,
      `SELECT (SELECT count(*) FROM _p3)::text AS p3,
              (SELECT count(*) FROM _p2)::text AS p2,
              (SELECT count(*) FROM _loser_remap)::text AS losers,
              (SELECT count(DISTINCT winner_id) FROM _loser_remap)::text AS winners`,
    );
    const loserCount = Number(counts?.losers ?? 0);
    console.log(
      `\nEligible: P3(committee)=${counts?.p3} losers, P2(org)=${counts?.p2} losers, ` +
        `total losers=${counts?.losers} → winners=${counts?.winners}`,
    );

    if (loserCount === 0) {
      console.log("\nNo eligible clusters — nothing to merge. Rolling back.");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }
    if (loserCount > MAX_LOSERS) {
      throw new Error(
        `loser count ${loserCount} exceeds MAX_LOSERS=${MAX_LOSERS} sanity bound — aborting`,
      );
    }

    // Sample the merges for the log.
    const sample = await q<{ canonical_name: string; entity_type: string; role: string }>(
      client,
      `SELECT left(w.canonical_name,34) AS canonical_name, w.entity_type,
              'winner:'||coalesce(w.fec_committee_id,'org') AS role
         FROM (SELECT DISTINCT winner_id FROM _loser_remap) lw
         JOIN financial_entities w ON w.id=lw.winner_id
         ORDER BY w.canonical_name LIMIT 12`,
    );
    console.log("\nSample winners:");
    for (const s of sample) console.log(`  ${s.canonical_name.padEnd(36)} ${s.entity_type}  ${s.role}`);

    console.log("\nFK rewrites (rows affected):");

    // ── financial_relationships — FIX-379 pre-delete-collider + UPDATE ──
    await run(client, "financial_relationships from-collider delete", `
      DELETE FROM financial_relationships e
       USING financial_relationships c, _loser_remap lr
       WHERE e.from_type='financial_entity' AND e.from_id=lr.loser_id
         AND c.from_type='financial_entity' AND c.from_id=lr.winner_id
         AND c.relationship_type=e.relationship_type AND c.to_type=e.to_type
         AND c.to_id IS NOT DISTINCT FROM e.to_id
         AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year`);
    await run(client, "financial_relationships from-id update", `
      UPDATE financial_relationships fr SET from_id=lr.winner_id
       FROM _loser_remap lr
       WHERE fr.from_type='financial_entity' AND fr.from_id=lr.loser_id`);
    await run(client, "financial_relationships to-collider delete", `
      DELETE FROM financial_relationships e
       USING financial_relationships c, _loser_remap lr
       WHERE e.to_type='financial_entity' AND e.to_id=lr.loser_id
         AND c.to_type='financial_entity' AND c.to_id=lr.winner_id
         AND c.relationship_type=e.relationship_type AND c.from_type=e.from_type
         AND c.from_id IS NOT DISTINCT FROM e.from_id
         AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year`);
    await run(client, "financial_relationships to-id update", `
      UPDATE financial_relationships fr SET to_id=lr.winner_id
       FROM _loser_remap lr
       WHERE fr.to_type='financial_entity' AND fr.to_id=lr.loser_id`);

    // ── external_relationships — straight UPDATE (unique is (source,source_id)) ──
    await run(client, "external_relationships from-id update", `
      UPDATE external_relationships er SET from_id=lr.winner_id
       FROM _loser_remap lr
       WHERE er.from_type='financial_entity' AND er.from_id=lr.loser_id`);
    await run(client, "external_relationships to-id update", `
      UPDATE external_relationships er SET to_id=lr.winner_id
       FROM _loser_remap lr
       WHERE er.to_type='financial_entity' AND er.to_id=lr.loser_id`);

    // ── external_source_refs — pre-delete (source,external_id) collider + UPDATE.
    //    Moves LS provenance (littlesis:NNN) onto the survivor. ───────────
    await run(client, "external_source_refs collider delete", `
      DELETE FROM external_source_refs e
       USING external_source_refs c, _loser_remap lr
       WHERE e.entity_type='financial_entity' AND e.entity_id=lr.loser_id
         AND c.entity_type='financial_entity' AND c.entity_id=lr.winner_id
         AND c.source=e.source AND c.external_id=e.external_id`);
    await run(client, "external_source_refs entity_id update", `
      UPDATE external_source_refs esr SET entity_id=lr.winner_id
       FROM _loser_remap lr
       WHERE esr.entity_type='financial_entity' AND esr.entity_id=lr.loser_id`);

    // ── Hard FKs — straight UPDATE ──────────────────────────────────────
    await run(client, "edgar_companies", `
      UPDATE edgar_companies ec SET financial_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE ec.financial_entity_id=lr.loser_id`);
    await run(client, "edgar_executive_officers", `
      UPDATE edgar_executive_officers eo SET financial_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE eo.financial_entity_id=lr.loser_id`);
    await run(client, "edgar_major_shareholders", `
      UPDATE edgar_major_shareholders es SET financial_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE es.financial_entity_id=lr.loser_id`);
    await run(client, "irs990_filings", `
      UPDATE irs990_filings f SET financial_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE f.financial_entity_id=lr.loser_id`);
    await run(client, "irs990_officers.matched_entity_id", `
      UPDATE irs990_officers iof SET matched_entity_id=lr.winner_id
       FROM _loser_remap lr
       WHERE iof.matched_entity_type='financial_entity' AND iof.matched_entity_id=lr.loser_id`);
    await run(client, "irs990_grants_out.matched_entity_id", `
      UPDATE irs990_grants_out g SET matched_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE g.matched_entity_id=lr.loser_id`);
    await run(client, "financial_entities.parent_entity_id", `
      UPDATE financial_entities fe SET parent_entity_id=lr.winner_id
       FROM _loser_remap lr WHERE fe.parent_entity_id=lr.loser_id`);

    // ── entity_tags — pre-delete collider + UPDATE ──────────────────────
    await run(client, "entity_tags collider delete", `
      DELETE FROM entity_tags e
       USING entity_tags c, _loser_remap lr
       WHERE e.entity_type='financial_entity' AND e.entity_id=lr.loser_id
         AND c.entity_type='financial_entity' AND c.entity_id=lr.winner_id
         AND c.tag=e.tag AND c.tag_category=e.tag_category`);
    await run(client, "entity_tags entity_id update", `
      UPDATE entity_tags et SET entity_id=lr.winner_id
       FROM _loser_remap lr
       WHERE et.entity_type='financial_entity' AND et.entity_id=lr.loser_id`);

    // ── enrichment_queue — TEXT entity_id, pre-delete collider + UPDATE ──
    await run(client, "enrichment_queue collider delete", `
      DELETE FROM enrichment_queue e
       USING enrichment_queue c, _loser_remap lr
       WHERE e.entity_type='financial_entity' AND e.entity_id=lr.loser_id::text
         AND c.entity_type='financial_entity' AND c.entity_id=lr.winner_id::text
         AND c.task_type=e.task_type`);
    await run(client, "enrichment_queue entity_id update", `
      UPDATE enrichment_queue eq SET entity_id=lr.winner_id::text
       FROM _loser_remap lr
       WHERE eq.entity_type='financial_entity' AND eq.entity_id=lr.loser_id::text`);

    // ── ai_summary_cache — pre-delete collider + UPDATE (0 FE rows today) ─
    await run(client, "ai_summary_cache collider delete", `
      DELETE FROM ai_summary_cache e
       USING ai_summary_cache c, _loser_remap lr
       WHERE e.entity_type='financial_entity' AND e.entity_id=lr.loser_id
         AND c.entity_type='financial_entity' AND c.entity_id=lr.winner_id
         AND c.summary_type=e.summary_type`);
    await run(client, "ai_summary_cache entity_id update", `
      UPDATE ai_summary_cache aic SET entity_id=lr.winner_id
       FROM _loser_remap lr
       WHERE aic.entity_type='financial_entity' AND aic.entity_id=lr.loser_id`);

    // ── NEW surface: evidence_cards (from/to, PK id, no poly unique) ─────
    if (await tableExists(client, "evidence_cards")) {
      await run(client, "evidence_cards from-id update", `
        UPDATE evidence_cards e SET from_id=lr.winner_id
         FROM _loser_remap lr
         WHERE e.from_type='financial_entity' AND e.from_id=lr.loser_id`);
      await run(client, "evidence_cards to-id update", `
        UPDATE evidence_cards e SET to_id=lr.winner_id
         FROM _loser_remap lr
         WHERE e.to_type='financial_entity' AND e.to_id=lr.loser_id`);
    }

    // ── synthetic_entities is a VIEW over each base table's is_synthetic
    //    column (financial_entities.is_synthetic for the FE branch), NOT a
    //    writable table. Synthetic (Franklin) FEs are excluded from the merge
    //    up front (see _feflag WHERE), so there is nothing to rewrite here —
    //    the is_synthetic flag travels with the row.

    // ── NEW surface: user-content tables that ALLOW financial_entity by
    //    CHECK (0 FE rows today; rewrite defensively). entity_id + entity_type. ─
    for (const t of [
      "entity_comments",
      "entity_positions",
      "entity_statements",
      "entity_activity_state",
      "position_events",
      "synthetic_position_rollup",
    ]) {
      if ((await tableExists(client, t)) && (await colExists(client, t, "entity_id"))) {
        await run(client, `${t} entity_id update`, `
          UPDATE ${t} x SET entity_id=lr.winner_id
           FROM _loser_remap lr
           WHERE x.entity_type='financial_entity' AND x.entity_id=lr.loser_id`);
      }
    }

    // ── Winner merge — fold loser totals + union metadata (winner wins on
    //    key conflict); keep the longest display_name. ────────────────────
    await run(client, "financial_entities winner merge (totals + metadata)", `
      UPDATE financial_entities w SET
        total_donated_cents  = w.total_donated_cents  + agg.don,
        total_received_cents = w.total_received_cents + agg.rec,
        metadata             = COALESCE(agg.loser_meta, '{}'::jsonb) || COALESCE(w.metadata, '{}'::jsonb),
        updated_at           = now()
      FROM (
        SELECT lr.winner_id,
               SUM(l.total_donated_cents)  AS don,
               SUM(l.total_received_cents) AS rec,
               (array_agg(l.metadata      ORDER BY l.total_donated_cents DESC NULLS LAST))[1]  AS loser_meta
          FROM _loser_remap lr
          JOIN financial_entities l ON l.id=lr.loser_id
         GROUP BY lr.winner_id
      ) agg
      WHERE w.id=agg.winner_id`);
    // display_name: keep the longest among {winner, losers} (winner not yet
    // overwritten above), preserving the most-informative casing.
    await run(client, "financial_entities keep-longest display_name", `
      UPDATE financial_entities w SET display_name=cand.dn
      FROM (
        SELECT lr.winner_id,
               (array_agg(x.display_name ORDER BY length(x.display_name) DESC NULLS LAST))[1] AS dn
          FROM _loser_remap lr
          JOIN financial_entities x ON x.id IN (lr.winner_id, lr.loser_id)
         GROUP BY lr.winner_id
      ) cand
      WHERE w.id=cand.winner_id AND length(cand.dn) > length(w.display_name)`);

    // ── DELETE losers ───────────────────────────────────────────────────
    const deleted = await run(client, "DELETE loser financial_entities", `
      DELETE FROM financial_entities WHERE id IN (SELECT loser_id FROM _loser_remap)`);

    // ── Delete-affected from derived / re-derivable rollups ─────────────
    console.log("\nDerived rollup delete-affected (rebuilds repopulate winners):");
    await run(client, "entity_connections (from/to affected)", `
      DELETE FROM entity_connections
       WHERE from_id IN (SELECT id FROM _affected) OR to_id IN (SELECT id FROM _affected)`);
    if (await tableExists(client, "entity_search_index")) {
      await run(client, "entity_search_index (entity_id affected)", `
        DELETE FROM entity_search_index WHERE entity_id IN (SELECT id FROM _affected)`);
    }
    if (await tableExists(client, "group_donor_rollup")) {
      await run(client, "group_donor_rollup (financial_entity_id affected)", `
        DELETE FROM group_donor_rollup WHERE financial_entity_id IN (SELECT id FROM _affected)`);
    }
    for (const t of ["entity_connection_stats_next", "donor_party_rollup_next"]) {
      if ((await tableExists(client, t)) && (await colExists(client, t, "entity_id"))) {
        await run(client, `${t} (entity_id affected)`, `
          DELETE FROM ${t} WHERE entity_id IN (SELECT id FROM _affected)`);
      }
    }

    // ── ANALYZE the mutated core tables (apply only — pointless work in a
    //    rolled-back dry-run, and it dominates local wall-clock) ───────────
    if (apply) {
      for (const t of [
        "financial_entities",
        "financial_relationships",
        "external_relationships",
        "external_source_refs",
        "entity_tags",
      ]) {
        await client.query(`ANALYZE public.${t}`);
      }
    }

    // ── Verification (before COMMIT/ROLLBACK) ───────────────────────────
    const [post] = await q<{ don: string; rec: string; n: string }>(
      client,
      `SELECT coalesce(sum(total_donated_cents),0)::text AS don,
              coalesce(sum(total_received_cents),0)::text AS rec,
              count(*)::text AS n
         FROM financial_entities`,
    );
    // Residue: rebuild _feflag on the NEW state, re-check P3/P2 eligibility.
    await client.query(`DROP TABLE IF EXISTS _feflag2;`);
    await client.query(`
      CREATE TEMP TABLE _feflag2 ON COMMIT DROP AS
      SELECT f.id, f.canonical_name, f.entity_type,
        (f.fec_committee_id IS NOT NULL) AS is_cmte,
        EXISTS(SELECT 1 FROM external_source_refs r WHERE r.entity_type='financial_entity' AND r.entity_id=f.id AND r.source='littlesis') AS has_ls,
        EXISTS(SELECT 1 FROM external_source_refs r WHERE r.entity_type='financial_entity' AND r.entity_id=f.id AND r.source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient')) AS has_bind
      FROM financial_entities f
      WHERE f.entity_type<>'individual' AND f.canonical_name IS NOT NULL AND f.canonical_name<>''
        AND NOT COALESCE(f.is_synthetic, false);`);
    const [residue] = await q<{ p3: string; p2: string }>(client, `
      WITH c3 AS (
        SELECT canonical_name, entity_type,
          count(*) FILTER (WHERE is_cmte) AS cmte_rows,
          count(*) FILTER (WHERE NOT is_cmte AND (has_ls OR NOT has_bind)) AS foldable
        FROM _feflag2 GROUP BY canonical_name, entity_type),
      c2 AS (
        -- Mirror the merge P2 predicate exactly: non-committee rows in
        -- canonicals that have NO committee row (committee canonicals are P3's
        -- domain and are intentionally left when they also carry a separate
        -- non-LS-bound org row — not a residue failure).
        SELECT canonical_name, entity_type, count(*) AS n,
          count(*) FILTER (WHERE has_bind) AS bound_rows
        FROM (
          SELECT f.* FROM _feflag2 f
          WHERE NOT f.is_cmte
            AND NOT EXISTS (
              SELECT 1 FROM _feflag2 c
               WHERE c.is_cmte AND c.canonical_name=f.canonical_name AND c.entity_type=f.entity_type
            )
        ) m GROUP BY canonical_name, entity_type)
      SELECT (SELECT count(*) FROM c3 WHERE cmte_rows=1 AND foldable>=1)::text AS p3,
             (SELECT count(*) FROM c2 WHERE n>=2 AND bound_rows=1)::text AS p2`);

    // Orphan check: any FK table still pointing at a deleted loser id.
    const [orph] = await q<{ orphans: string }>(client, `
      SELECT (
        (SELECT count(*) FROM financial_relationships WHERE from_type='financial_entity' AND from_id IN (SELECT loser_id FROM _loser_remap)) +
        (SELECT count(*) FROM financial_relationships WHERE to_type='financial_entity'   AND to_id   IN (SELECT loser_id FROM _loser_remap)) +
        (SELECT count(*) FROM external_relationships  WHERE from_type='financial_entity' AND from_id IN (SELECT loser_id FROM _loser_remap)) +
        (SELECT count(*) FROM external_relationships  WHERE to_type='financial_entity'   AND to_id   IN (SELECT loser_id FROM _loser_remap)) +
        (SELECT count(*) FROM external_source_refs    WHERE entity_type='financial_entity' AND entity_id IN (SELECT loser_id FROM _loser_remap)) +
        (SELECT count(*) FROM entity_tags             WHERE entity_type='financial_entity' AND entity_id IN (SELECT loser_id FROM _loser_remap))
      )::text AS orphans`);

    const donOk = pre?.don === post?.don;
    const recOk = pre?.rec === post?.rec;
    const nOk = Number(pre?.n) - deleted === Number(post?.n);
    const residueOk = residue?.p3 === "0" && residue?.p2 === "0";
    const orphOk = orph?.orphans === "0";

    console.log("\n── Verification ─────────────────────────────────────────");
    console.log(`  total_donated_cents  invariant: ${donOk ? "OK" : "FAIL"}  (${pre?.don} → ${post?.don})`);
    console.log(`  total_received_cents invariant: ${recOk ? "OK" : "FAIL"}  (${pre?.rec} → ${post?.rec})`);
    console.log(`  FE row count: ${pre?.n} − ${deleted} deleted = ${post?.n}  ${nOk ? "OK" : "FAIL"}`);
    console.log(`  post-merge eligible residue: P3=${residue?.p3} P2=${residue?.p2}  ${residueOk ? "OK" : "FAIL"}`);
    console.log(`  loser-id orphans across core FK tables: ${orph?.orphans}  ${orphOk ? "OK" : "FAIL"}`);

    const allOk = donOk && recOk && nOk && residueOk && orphOk;
    if (!allOk) {
      throw new Error("verification FAILED — rolling back (see report above)");
    }

    if (apply) {
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED. Merged ${counts?.losers} loser rows into ${counts?.winners} winners.`);
      console.log(
        "  NOTE: entity_connections / entity_search_index / group_donor_rollup rows for the\n" +
          "  affected ids were deleted; the scheduled rebuild_entity_connections (Sun+Wed) and\n" +
          "  pg_cron rollup refreshes will repopulate the surviving winner ids.",
      );
    } else {
      await client.query("ROLLBACK");
      console.log(`\n✓ DRY-RUN complete — all checks passed, rolled back. Re-run with --apply to commit.`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n✗ Rolled back due to error:", err instanceof Error ? err.message : String(err));
    await client.end();
    process.exit(1);
  }
  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
