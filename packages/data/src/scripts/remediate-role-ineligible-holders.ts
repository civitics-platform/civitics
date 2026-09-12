/**
 * FIX-1153 — remediate the ROLE-INELIGIBLE HOLDER branch.
 *
 * WHAT THIS IS
 * ------------
 * FIX-1154 gave the classifier a branch it was missing: an official whose
 * `role_title` can hold NO FEC office at all, holding fec_bulk-sourced donation
 * money. On the 2026-09-07 clone that is 84 officials and $4,837,765 — 66
 * Council Members and 18 Federal Judges. Every one of those rows renders
 * somebody else's donors under a judge's or a council member's name, which is
 * the FIX-937 bug itself, still resident.
 *
 * FIX-954 remediates CROSS-PERSON and FIX-933 merges SAME-PERSON. Neither can
 * take this branch: 954 filters to `branch === "CROSS-PERSON MISATTRIBUTION"`
 * and 933 to `"SAME-PERSON DUPLICATE"`. Hence a third script with the same
 * shape.
 *
 * THE POPULATION IS MONEY-KEYED, NOT ID-KEYED
 * -------------------------------------------
 * The obvious predicate — "carries an H/S/P `fec_id` its role cannot hold" —
 * MISSES most of the branch. The 18 Federal Judges hold $333,582 between them
 * with NO stored id at all; the id was never written (the fec phase gets
 * SIGTERM'd at its GHA budget before persistNewFecIds runs), and the money got
 * there through the name-match pool that FIX-937 has since closed. On the clone
 * the split is 64 rows with a stored id and 20 without.
 *
 * So the predicate is: the role can hold no FEC office AND the official holds
 * fec_bulk-sourced `financial_relationships` rows. The stored id, where there is
 * one, is retired as a SECOND step rather than being the selector.
 *
 * ONE PREDICATE, ONE FILE. The role list is generated from `ROLE_TO_OFFICE` /
 * `FEC_ELECTABLE_ROLE_TITLES` in ../pipelines/fec-bulk/electable-role and passed
 * as a parameter (`role_title <> ALL($1)`). It is never a second hand-written
 * list in SQL — that is exactly the drift FIX-1025 closed after finding six
 * spellings of this rule, two of them wrong in opposite directions.
 *
 * The count is scoped to `metadata->>'source' LIKE 'fec_bulk%'` here, unlike
 * SUSPECT_SQL's `facts` CTE which counts all donation sources. There the count
 * is a statistic; here it decides what gets deleted, so it must name exactly
 * the money the branch is about.
 *
 * TWO ROW CLASSES, BOTH DELETED
 * -----------------------------
 *   CROSS      another official holds an identical
 *              (relationship_type, from_id, cycle_year) key — FIX-954's
 *              definition. Fresher-wins propagation onto the owner's row runs
 *              first, exactly as 954 does, so the value is de-duplicated rather
 *              than destroyed; then the suspect's copy goes.
 *   ONLY-COPY  nobody else holds it. A plain delete.
 *
 * WHY THE ONLY-COPY ROWS GO TOO — this is the decision that needs stating,
 * because FIX-952 deliberately left the equivalent rows alone in the CROSS-PERSON
 * branch. The difference is the role. There, a suspect MIGHT legitimately hold
 * federal money and the question was only whose; here the holder can hold none,
 * so "keep the only copy" means keeping a judge's page rendering a stranger's
 * donors indefinitely. The transactions are not lost: they are still in the FEC
 * bulk file, and a PR 3b per-cycle replay lands them on the right candidate row
 * if one exists. The branch is 0.02% of platform donation money ($4.8M of
 * $6.93B). The manifest's class column is what makes that trade visible before
 * anyone approves it.
 *
 * NO `merged_into` POINTER. A council member's row is a legitimate historical
 * office record, not a duplicate stub — there is no survivor to point it at.
 * Only the money and the wrong id leave; the official row stays.
 *
 * RESUME MODES (FIX-964) and --defer-tails (FIX-1153) work exactly as they do in
 * remediate-cross-person-misattribution.ts; see fec-orphan-classify's
 * `deferTails` for what defers and what never does.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:remediate:role-ineligible             # dry-run
 *   pnpm --filter @civitics/data data:remediate:role-ineligible -- --apply
 *   pnpm --filter @civitics/data data:remediate:role-ineligible:prod -- --apply --defer-tails
 *   pnpm --filter @civitics/data data:remediate:role-ineligible -- --rollups-only
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import {
  classify,
  constructDbUrlFromEnv,
  deferTails,
  envLabel,
  PLATFORM_SQL,
  printDeferredTail,
  SUSPECT_SQL,
  type SuspectRow,
  usd,
} from "./fec-orphan-classify";
import { FEC_ELECTABLE_ROLE_TITLES } from "../pipelines/fec-bulk/electable-role";
import {
  diffActionable,
  diffVerdict,
  formatDiffLine,
  manifestArg,
  manifestColumn,
  declareRemediationTail,
  printTailTable,
  requireManifestOnProd,
  type DiffInput,
} from "./remediation-manifest";
import { drainFrRewrite } from "../lib/fr-rewrite-drain";
import { runUnderProdSession } from "../lib/prod-session";

/** Sanity bound. The clone measured 84; the reconciliation ceiling is ~200. */
const MAX_OFFICIALS = 400;
// FIX-1074: the chunk width moved into fr-rewrite-drain.ts with the drain itself.

const MONEY_EDGE_TYPES = ["donation", "opposition"];

const MV_REFRESH_FNS = [
  "refresh_official_sector_dollars_mv",
  "refresh_official_homepage_stats_mv",
  "refresh_homepage_stats_mv",
  "refresh_chord_industry_flows_mv",
  "refresh_chord_donor_type_party_flows_mv",
  "refresh_chord_donor_state_party_flows_mv",
];

/** See the root CLAUDE.md standing rule — a bulk rewrite ends by vacuuming. */
const CHURNED_TABLES = ["financial_relationships", "entity_connections", "officials", "financial_entities"];

const STEP_BUDGET_S: Record<string, number> = {
  donor_rollup: 40 * 60,
  official_totals: 15 * 60,
  fe_totals_chunk: 10 * 60,
  donor_party_chunk: 10 * 60,
  heavy: 40 * 60,
  mv: 20 * 60,
};

class BudgetExceeded extends Error {}

/**
 * 57014 query_canceled / 57P01 admin_shutdown — a human or a watchdog said stop.
 * Distinguished from an ordinary step failure because the response differs: an
 * ordinary failure is logged and the next step runs, a cancellation aborts.
 */
function isCancellation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "57014" || code === "57P01";
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

/** The role allow-list, as a SQL parameter. Never a second hand-written list. */
const ELECTABLE_ROLES: string[] = [...FEC_ELECTABLE_ROLE_TITLES];

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

/**
 * Officials whose role can hold no FEC office, holding fec_bulk money.
 *
 * `role_title <> ALL($1)` with a NULL-safe guard: a NULL role_title is not
 * electable either (`fecOfficePrefixFor(null)` is null), and `NULL <> ALL(…)`
 * is NULL rather than true, so it needs saying explicitly.
 */
const POPULATION_SQL = `
SELECT o.id::text                           AS official_id,
       o.full_name,
       o.role_title,
       o.is_active,
       o.tier,
       j.short_name                         AS jurisdiction,
       o.source_ids->>'fec_id'              AS stored_fec_id,
       count(fr.id)::text                   AS fec_rows,
       COALESCE(sum(fr.amount_cents), 0)::text AS fec_cents
  FROM officials o
  JOIN financial_relationships fr
    ON fr.to_type = 'official'
   AND fr.relationship_type = 'donation'
   AND fr.to_id = o.id
   AND fr.metadata->>'source' LIKE 'fec_bulk%'
  LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
 WHERE COALESCE(o.role_title, '') <> ALL($1::text[])
 GROUP BY o.id, o.full_name, o.role_title, o.is_active, o.tier, j.short_name, o.source_ids
 ORDER BY sum(fr.amount_cents) DESC;
`;

/**
 * FIX-1165 — the SAME facts, keyed on the manifest's ids.
 *
 * This is what runs on prod. `o.id = ANY($1)` is an index scan on the officials
 * PK feeding a nested loop into financial_relationships_to (to_type, to_id), so
 * the cost is the manifest's length and not the table's. POPULATION_SQL above
 * — which finds WHICH officials qualify, and therefore cannot be keyed — runs
 * only on the clone.
 *
 * LEFT JOIN, not JOIN: a manifest official may legitimately hold zero FR rows
 * (FIX-1164's 55 zero-money fec_id carriers are exactly that case, and they
 * still need their id retired). An inner join would silently drop them.
 */
const KEYED_POPULATION_SQL = `
SELECT o.id::text                           AS official_id,
       o.full_name,
       o.role_title,
       o.is_active,
       o.tier,
       j.short_name                         AS jurisdiction,
       o.source_ids->>'fec_id'              AS stored_fec_id,
       count(fr.id)::text                   AS fec_rows,
       COALESCE(sum(fr.amount_cents), 0)::text AS fec_cents
  FROM officials o
  LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
  LEFT JOIN financial_relationships fr
    ON fr.to_type = 'official'
   AND fr.to_id = o.id
   AND fr.relationship_type = 'donation'
   AND fr.metadata->>'source' LIKE 'fec_bulk%'
 WHERE o.id = ANY($1::uuid[])
 GROUP BY o.id, o.full_name, o.role_title, o.is_active, o.tier, j.short_name, o.source_ids
 ORDER BY sum(fr.amount_cents) DESC NULLS LAST;
`;

/**
 * FIX-1165 — conservation, keyed on the affected donors.
 *
 * PLATFORM_SQL aggregates every official donation row on the instance. That is
 * the right check on a clone and it is the WRONG one on prod: it was the
 * "conservation phase" that cost 132 of the 2026-09-07 apply's 202 statement
 * cancellations, for a 28-row change. Keyed on the donors whose rows are
 * actually moving, the same invariant holds — after = before - deleted — and
 * the read is a bitmap scan over financial_relationships_from rather than the
 * table.
 */
const KEYED_CONSERVATION_SQL = `
SELECT count(*)::text                              AS rows,
       COALESCE(sum(fr.amount_cents), 0)::text     AS cents
  FROM financial_relationships fr
 WHERE fr.to_type = 'official'
   AND fr.relationship_type = 'donation'
   AND fr.from_id = ANY($1::uuid[]);
`;

/**
 * The closing number, keyed. Answers both halves of the class in one pass, for
 * the manifest's officials only: still holding fec_bulk money (FIX-1153), and
 * still carrying an fec_id their role cannot hold (FIX-1164).
 */
const KEYED_CLOSING_SQL = `
SELECT count(*) FILTER (WHERE fr_rows > 0)::text AS still_money,
       count(*) FILTER (WHERE has_fec_id)::text  AS still_id
  FROM (
    SELECT o.id,
           (SELECT count(*)
              FROM financial_relationships fr
             WHERE fr.to_type = 'official'
               AND fr.to_id = o.id
               AND fr.relationship_type = 'donation'
               AND fr.metadata->>'source' LIKE 'fec_bulk%') AS fr_rows,
           (o.source_ids ? 'fec_id')                        AS has_fec_id
      FROM officials o
     WHERE o.id = ANY($1::uuid[])
       AND COALESCE(o.role_title, '') <> ALL($2::text[])
  ) t;
`;

interface PopRow extends Record<string, unknown> {
  official_id: string;
  full_name: string;
  role_title: string | null;
  is_active: boolean;
  tier: string | null;
  jurisdiction: string | null;
  stored_fec_id: string | null;
  fec_rows: string;
  fec_cents: string;
}

/**
 * Freeze the doomed rows and classify each by whether another official already
 * holds the identical (relationship_type, from_id, cycle_year) key.
 *
 * Captured into a TEMP TABLE **before** the delete: after it, the donor set is
 * unrecoverable (FIX-964's lesson — a DELETE leaves no trace to rebuild the
 * donor-scoped rollups from).
 */
const FREEZE_DROP_SQL = `DROP TABLE IF EXISTS _doomed`;

/**
 * FIX-1165 — ONE command, because it now takes a bind parameter. Postgres'
 * extended query protocol (which node-postgres uses the moment a query has
 * values) rejects a multi-statement string with 42601, so the DROP above and
 * the indexes below are issued separately rather than folded in here.
 */
const FREEZE_SQL = `
CREATE TEMP TABLE _doomed AS
SELECT fr.id            AS row_id,
       fr.to_id         AS official_id,
       fr.from_id       AS donor_id,
       fr.cycle_year,
       fr.relationship_type,
       fr.amount_cents,
       fr.updated_at,
       o2.id            AS owner_row,
       o2.amount_cents  AS owner_cents,
       o2.updated_at    AS owner_updated_at,
       CASE WHEN o2.id IS NULL THEN 'ONLY-COPY' ELSE 'CROSS' END AS row_class
  FROM financial_relationships fr
  JOIN _pop p ON p.official_id = fr.to_id
  LEFT JOIN LATERAL (  -- keyed per doomed row on financial_relationships_relcycle_unique
        SELECT x.id, x.amount_cents, x.updated_at
          FROM financial_relationships x
         WHERE x.to_type = 'official'
           AND x.relationship_type = fr.relationship_type
           AND x.from_id  = fr.from_id
           AND x.cycle_year IS NOT DISTINCT FROM fr.cycle_year
           AND x.to_id <> fr.to_id
         ORDER BY x.updated_at DESC, x.id
         LIMIT 1
  ) o2 ON true
 WHERE fr.to_type = 'official'
   AND fr.relationship_type = 'donation'
   AND fr.metadata->>'source' LIKE 'fec_bulk%'
   -- FIX-1165: the explicit array bound, not just the join to _pop. A TEMP TABLE
   -- created by CREATE TABLE AS carries no statistics, so the planner has no row
   -- estimate for _pop and is free to hash-join it against a SEQUENTIAL SCAN of
   -- financial_relationships — which on prod is the whole cost of the change.
   -- = ANY($1) gives it a concrete array and the (to_type, to_id) index; the
   -- caller ANALYZEs _pop as well, for the join order.
   AND fr.to_id = ANY($1::uuid[])
`;

const FREEZE_POST_SQL = `
CREATE INDEX ON _doomed (official_id);
CREATE INDEX ON _doomed (donor_id);
ANALYZE _doomed;
`;

// ---------------------------------------------------------------------------
// Helpers (same shapes as remediate-cross-person-misattribution.ts)
// ---------------------------------------------------------------------------

async function q<T extends Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

async function run(client: Client, label: string, sql: string, params: unknown[] = []): Promise<number> {
  const t0 = Date.now();
  const res = await client.query(sql, params);
  const s = (Date.now() - t0) / 1000;
  console.log(`  ${label.padEnd(52)} ${String(res.rowCount ?? 0).padStart(9)} rows  ${s.toFixed(1)}s`);
  return res.rowCount ?? 0;
}

async function step(client: Client, label: string, sql: string, params: unknown[] = []): Promise<void> {
  const t0 = Date.now();
  await client.query(sql, params);
  console.log(`  ${label.padEnd(52)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function budgeted(
  client: Client,
  label: string,
  sql: string,
  budgetS: number,
  params: unknown[] = [],
): Promise<void> {
  const t0 = Date.now();
  try {
    await client.query(`SET statement_timeout = ${budgetS * 1000}`);
    await client.query(sql, params);
  } catch (err) {
    if ((err as { code?: string })?.code === "57014") {
      throw new BudgetExceeded(`${label} hit its ${budgetS}s statement_timeout and was cancelled server-side`);
    }
    throw err;
  } finally {
    await client.query("SET statement_timeout = 0");
  }
  const s = (Date.now() - t0) / 1000;
  console.log(`  ${label.padEnd(52)} ${s.toFixed(1)}s`);
  if (s > budgetS) throw new BudgetExceeded(`${label} took ${s.toFixed(0)}s against a ${budgetS}s budget`);
}

async function runVacuum(client: Client, defer = false): Promise<void> {
  if (defer) {
    printDeferredTail("vacuum");
    return;
  }
  console.log("\n── VACUUM (ANALYZE) ─────────────────────────────────────");
  for (const t of CHURNED_TABLES) {
    try {
      await step(client, `VACUUM ANALYZE ${t}`, `VACUUM (ANALYZE) public.${t}`);
    } catch (err) {
      console.error(`  ! VACUUM ${t} failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`    (autovacuum will NOT catch up — see FIX-943; re-run this step)`);
    }
  }
}

async function runMvsAndVacuum(client: Client, defer = false): Promise<void> {
  // FIX-1153 — the MV loop is deferred too. Every one of these has a
  // scheduled owner: refresh-derived-mvs-weekly (jobid 10, Tue 00:47 UTC)
  // rebuilds the three chord MVs and official_sector_dollars_mv, and
  // refresh-derived-mvs-daily (jobid 9, 06:00 UTC) rebuilds homepage_stats_mv
  // and official_homepage_stats_mv. Running them from here duplicates that
  // work hours early, and this specific phase has a prod incident against it:
  // the FIX-953 apply (2026-08-10/11) ran phase 3 after an aborted phase 2 and
  // took prod fully unresponsive (pooler ECHECKOUTTIMEOUT, Cloudflare 522 for
  // 30+ minutes, manual project reset). It is also the ONE place these scripts
  // refresh the chord MVs WITHOUT the FIX-1129 guard: that fix set
  // max_parallel_workers_per_gather = 0 for the weekly cadence because the
  // parallel hash build over financial_entities cannot resize its DSM segment,
  // and these scripts only set that GUC on LOCAL (see main()).
  if (defer) {
    printDeferredTail("mvs");
    await runVacuum(client, defer);
    return;
  }

  console.log("\n── Phase 3: materialized views + vacuum ─────────────────");
  for (const fn of MV_REFRESH_FNS) {
    try {
      await budgeted(client, `${fn}()`, `SELECT ${fn}()`, STEP_BUDGET_S["mv"]!);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      console.error(`  ! ${fn}() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await runVacuum(client, defer);
}

/**
 * Rollups — post-commit, chunked, interruptible. Nothing here is atomic with the
 * delete and nothing needs to be: every rollup is a pure function of the
 * committed rows.
 */
async function runRollups(client: Client, prod: boolean, defer = false): Promise<void> {
  console.log("\n── Phase 2: rollups (post-commit, chunked) ──────────────");
  try {
    const [offCount] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _affected`);
    const officials = Number(offCount?.n ?? 0);
    const [donorCount] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _donor`);
    const donors = Number(donorCount?.n ?? 0);
    console.log(`  affected officials: ${officials.toLocaleString()}   donors: ${donors.toLocaleString()}`);

    // FIX-1074 — the manifest-scoped drain is now ONE shared helper. The three
    // remediation scripts carried a byte-for-byte identical copy of these steps
    // and FIX-1106's residue sweep is a fourth caller, which is the answer to
    // FIX-1074's open question ("each landing script or one shared helper").
    //
    // Note this script's _affected keys on official_id, cross-person's on id and
    // the merge script's table is called _affected_officials — the divergence is
    // exactly why the helper takes the names as parameters instead of assuming.
    //
    // FIX-1165's rebuild_official_donation_totals() removal stands and is not
    // reintroduced here: the function does not exist in pg_proc on either prod or
    // the clone, and it wrote officials.total_received_cents, a column with no
    // reader left.
    await drainFrRewrite(
      client,
      { affectedTable: "_affected", affectedIdColumn: "official_id", donorTable: "_donor" },
      { prod, defer, printTable: false },
    );

    // FIX-1153 — the search index is the 06:00 daily's ninth unit and the
    // treemap is treemap-individuals-global-refresh's whole job.
    if (defer) printDeferredTail("heavy");
    // FIX-1165 — ALL THREE defer, not just the search index. The first two used
    // to run unconditionally, which is precisely the bug: on the 2026-09-07
    // set-2 apply, a 28-row manifest, rebuild_financial_entity_ie_totals() ran
    // 28 minutes before being cancelled by hand and accounted for 70 of the
    // run's 202 statement cancellations. Its cost is a function of
    // financial_entities, not of the manifest.
    const heavySteps: ReadonlyArray<readonly [string, string]> = defer
      ? []
      : [
          ["rebuild_financial_entity_ie_totals()", `SELECT rebuild_financial_entity_ie_totals()`],
          ["refresh_group_donor_rollup()", `SELECT refresh_group_donor_rollup()`],
          ["rebuild_entity_search_index()", `SELECT rebuild_entity_search_index()`],
        ];
    for (const [label, sql] of heavySteps) {
      try {
        await budgeted(client, label, sql, STEP_BUDGET_S["heavy"]!);
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        // FIX-1165 — a CANCEL stops the tail. It used to be swallowed like any
        // other error, so the loop advanced to the next step: on 2026-09-07 the
        // hand-cancel of rebuild_financial_entity_ie_totals() at minute 28 fell
        // straight through into refresh_group_donor_rollup(), which then ran a
        // further 414 s (pg_stat_statements, one call) against a front door
        // already at ~70x its baseline cancellation rate. Someone reaching for
        // pg_cancel_backend means stop, and every step here is resumable.
        if (isCancellation(err)) {
          console.error(`
✗ ${label} was CANCELLED — stopping the tail.`);
          console.error(
            `  The delete is COMMITTED and the manifest-scoped rollups are done.
` +
              `  Remaining platform-scoped steps have scheduled owners; let them collect.`,
          );
          throw err;
        }
        console.error(`  ! ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // FIX-965: never arm a statement_timeout around the treemap CALL — the
    // 2026-08-05 server-side cancellation of exactly this step wedged prod for
    // ~7 hours. Hand the budget to the procedure's own session GUC.
    if (!defer) {
      try {
        await client.query(`SET civitics.treemap_global_budget_seconds = '${STEP_BUDGET_S["heavy"]!}'`);
        await step(client, "refresh_treemap_individuals_global()", `CALL refresh_treemap_individuals_global()`);
      } catch (err) {
        console.error(
          `  ! refresh_treemap_individuals_global() failed: ${err instanceof Error ? err.message : String(err)} ` +
            `(committed chunks are cursor-tracked; resume with data:treemap:sweep)`,
        );
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    console.error(`\n✗ ROLLUPS ABORTED — ${err.message}`);
    console.error(
      `  The delete is COMMITTED and correct; only rollups are incomplete.\n` +
        `  Resume with --rollups-only${prod ? " --allow-prod" : ""}` +
        `${defer ? " --defer-tails" : ""}.`,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------

function tsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]/g, " ")).join("\t")).join("\n") + "\n";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rollupsOnly = argv.includes("--rollups-only");
  const mvsOnly = argv.includes("--mvs-only");
  const vacuumOnly = argv.includes("--vacuum-only");
  const apply = argv.includes("--apply") || rollupsOnly || mvsOnly || vacuumOnly;
  const allowProd = argv.includes("--allow-prod");
  const defer = deferTails(argv);
  const prod = isProd();
  const manifestPath = manifestArg(argv);

  // FIX-1165 Rule 1. Note this is checked for DRY RUNS TOO, not only applies:
  // the derivation IS what the dry run does, and on 2026-09-07 the dry run's
  // derivation was 81 minutes and 132 of the day's 202 statement cancellations.
  // Deriving on prod is the expensive mistake whether or not anything is written.
  const manifest = requireManifestOnProd({
    prod,
    manifestPath,
    script: "remediate-role-ineligible-holders",
    flag: "--manifest <path>",
  });

  if (prod && apply && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  This script DELETES financial_relationships rows. Re-run with --allow-prod\n" +
        "  only after the local dry run has been reviewed.",
    );
    process.exit(1);
  }

  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD.");
    process.exit(1);
  }

  console.log(
    `[fix1153] role-ineligible holders — ${envLabel()} — ${apply ? "APPLY" : "DRY RUN"}` +
      `${defer ? " (--defer-tails)" : ""}\n`,
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

  // Resume modes short-circuit BEFORE the derivation (FIX-964).
  if (vacuumOnly) {
    await runVacuum(client, defer);
    await client.end();
    return;
  }
  if (mvsOnly) {
    await runMvsAndVacuum(client, defer);
    await client.end();
    return;
  }
  if (rollupsOnly) {
    console.error(
      "✗ --rollups-only needs the _affected/_donor temp tables, which do not survive\n" +
        "  the session that created them. Re-run the apply, or rebuild the donor set\n" +
        "  from the manifest TSV this run wrote.",
    );
    await client.end();
    process.exit(1);
  }

  // ── The population ────────────────────────────────────────────────────────
  //
  // Two paths, and which one runs is decided by the MANIFEST, never by the env:
  // with a manifest the ids are READ and the facts RE-READ keyed on them; with
  // no manifest the population is DERIVED, which needs a full audit scan and is
  // therefore reachable only off prod (requireManifestOnProd above).
  let pop: PopRow[];

  if (manifest) {
    const ids = manifestColumn(manifest, "official_id");
    console.log(`Manifest: ${manifest.path}`);
    console.log(`  ${ids.length} officials — recomputing their facts on ${envLabel()}, keyed.`);
    pop = await q<PopRow>(client, KEYED_POPULATION_SQL, [ids]);

    // The clone-vs-here diff. A clone dry run is stale the moment prod moves, so
    // the manifest is an AUTHORISATION and not a description: rows the manifest
    // never saw are reported and SKIPPED rather than swept in.
    const expected = new Map(manifest.rows.map((r) => [r["official_id"]!, r] as const));
    const diffs = pop.map((r) => {
      const e = expected.get(r.official_id);
      const d: DiffInput = {
        key: r.official_id,
        expectedRows: Number(e?.["fec_rows"] ?? 0),
        expectedCents: Number(e?.["fec_cents"] ?? 0),
        actualRows: Number(r.fec_rows),
        actualCents: Number(r.fec_cents),
      };
      return { r, d, v: diffVerdict(d) };
    });

    const moved = diffs.filter((x) => x.v !== "match");
    console.log(`  diff vs manifest: ${diffs.length - moved.length} match, ${moved.length} moved`);
    for (const { r, d, v } of moved) {
      console.log(`    ${(r.full_name ?? "").slice(0, 30).padEnd(30)} ${formatDiffLine(d, v)}`);
    }

    const blocked = diffs.filter((x) => !diffActionable(x.v) && x.v !== "gone");
    if (blocked.length > 0) {
      console.log(
        `  ! ${blocked.length} official(s) hold MORE rows here than the manifest recorded.` +
          ` They are SKIPPED — the manifest did not authorise those rows.` +
          ` Re-derive on a fresh clone and re-authorise them.`,
      );
      const drop = new Set(blocked.map((x) => x.d.key));
      pop = pop.filter((r) => !drop.has(r.official_id));
    }
    // An official whose rows are already gone needs no delete but may still carry
    // an illegitimate fec_id, and the retire step is keyed on the OFFICIAL, not
    // on its rows — so it stays in the population. This is FIX-1164's 55.
    const gone = diffs.filter((x) => x.v === "gone").length;
    if (gone > 0) console.log(`  ${gone} official(s) hold no FR rows here — id-retire only.`);
  } else {
    console.log("Deriving the role-ineligible holder population…  (clone-only path)");
    console.log(`  electable roles (from ROLE_TO_OFFICE): ${ELECTABLE_ROLES.join(", ")}\n`);
    pop = await q<PopRow>(client, POPULATION_SQL, [ELECTABLE_ROLES]);
  }

  if (pop.length === 0) {
    console.log("Nothing to remediate — 0 role-ineligible officials hold fec_bulk money.");
    await client.end();
    return;
  }
  if (pop.length > MAX_OFFICIALS) {
    console.error(`\n✗ ${pop.length} officials exceeds MAX_OFFICIALS=${MAX_OFFICIALS} — refusing.`);
    await client.end();
    process.exit(1);
  }

  const totalRows = pop.reduce((s, r) => s + Number(r.fec_rows), 0);
  const totalCents = pop.reduce((s, r) => s + Number(r.fec_cents), 0);
  console.log(`  ${pop.length} officials, ${totalRows.toLocaleString()} FR rows, ${usd(totalCents)}`);

  const byRole = new Map<string, { n: number; cents: number }>();
  for (const r of pop) {
    const k = r.role_title ?? "(null)";
    const cur = byRole.get(k) ?? { n: 0, cents: 0 };
    byRole.set(k, { n: cur.n + 1, cents: cur.cents + Number(r.fec_cents) });
  }
  console.log("\n  by role:");
  for (const [role, v] of [...byRole].sort((a, b) => b[1].cents - a[1].cents)) {
    console.log(`    ${role.padEnd(28)} ${String(v.n).padStart(4)}  ${usd(v.cents)}`);
  }

  // ── Reconciliation against the classifier and the FIX-937 manifests ───────
  // FIX-1165 — reconciliation re-derives across the classifier and the FIX-937
  // manifests, which is a second full audit scan. It is the derivation path's
  // check on the derivation, so it runs where the derivation runs: the clone.
  if (!manifest) await reconcile(client, pop);

  // ── Freeze the doomed rows and split by class ─────────────────────────────
  const popIds = pop.map((r) => r.official_id);
  await client.query(`DROP TABLE IF EXISTS _pop; CREATE TEMP TABLE _pop (official_id uuid PRIMARY KEY);`);
  await client.query(`INSERT INTO _pop SELECT unnest($1::uuid[])`, [popIds]);
  await client.query(`ANALYZE _pop`);
  await client.query(FREEZE_DROP_SQL);
  await client.query(FREEZE_SQL, [popIds]);
  await client.query(FREEZE_POST_SQL);

  const classSplit = await q<{ row_class: string; rows: string; cents: string }>(
    client,
    `SELECT row_class, count(*)::text AS rows, COALESCE(sum(amount_cents),0)::text AS cents
       FROM _doomed GROUP BY row_class ORDER BY row_class`,
  );
  console.log("\n  row classes:");
  for (const c of classSplit) {
    console.log(`    ${c.row_class.padEnd(12)} ${Number(c.rows).toLocaleString().padStart(9)} rows  ${usd(c.cents)}`);
  }

  const perOfficial = await q<{
    official_id: string;
    cross_rows: string;
    only_rows: string;
    cross_cents: string;
    only_cents: string;
  }>(
    client,
    `SELECT official_id::text AS official_id,
            count(*) FILTER (WHERE row_class='CROSS')::text      AS cross_rows,
            count(*) FILTER (WHERE row_class='ONLY-COPY')::text  AS only_rows,
            COALESCE(sum(amount_cents) FILTER (WHERE row_class='CROSS'),0)::text     AS cross_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE row_class='ONLY-COPY'),0)::text AS only_cents
       FROM _doomed
      GROUP BY official_id`,
  );

  // ── Write the manifest ────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), "../../docs/audits");
  fs.mkdirSync(outDir, { recursive: true });
  const tsvPath = path.join(
    outDir,
    // A manifest-driven run does not re-derive, so what it writes is a RECEIPT of
    // what this database actually held, not a new derivation. Different name, so
    // it can never be mistaken for one and fed back in as an authorisation.
    manifest
      ? `${stamp}-fix1153-role-ineligible-holders-recomputed-${envLabel().toLowerCase()}.tsv`
      : `${stamp}-fix1153-role-ineligible-holders.tsv`,
  );

  const perClass = new Map(perOfficial.map((r) => [r.official_id, r]));
  const header = [
    "official_id", "full_name", "role_title", "tier", "is_active", "jurisdiction",
    "stored_fec_id", "fec_rows", "fec_cents", "cross_rows", "only_rows", "cross_cents", "only_cents",
  ];
  const body = pop.map((r) => {
    const c = perClass.get(r.official_id);
    return [
      r.official_id, r.full_name, r.role_title ?? "", r.tier ?? "", String(r.is_active),
      r.jurisdiction ?? "", r.stored_fec_id ?? "", r.fec_rows, r.fec_cents,
      c?.cross_rows ?? "", c?.only_rows ?? "", c?.cross_cents ?? "", c?.only_cents ?? "",
    ];
  });
  fs.writeFileSync(tsvPath, tsv([header, ...body]), "utf8");
  console.log(`\nwrote ${tsvPath}`);

  // FIX-1165 (c) — the tail's cost table, printed BEFORE the go-ahead so the
  // trade is visible at decision time rather than discovered at minute 28.
  printTailTable(declareRemediationTail(defer), defer);

  if (!apply) {
    console.log("\nDRY RUN — nothing written to the database. Re-run with --apply to commit.");
    await client.end();
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  // The donor set is read off _doomed, which was frozen before any delete —
  // after the delete it is unrecoverable (FIX-964).
  const donorIds = (
    await q<{ id: string }>(client, `SELECT DISTINCT donor_id::text AS id FROM _doomed WHERE donor_id IS NOT NULL`)
  ).map((r) => r.id);

  const conservationBefore = manifest
    ? (await q<{ rows: string; cents: string }>(client, KEYED_CONSERVATION_SQL, [donorIds]))[0]
    : (await q<{ rows: string; cents: string }>(client, PLATFORM_SQL))[0];

  // Conservation needs two numbers that only exist BEFORE the transaction runs:
  // what the delete removes, and what the fresher-wins propagation adds back to
  // the owners' rows. Both are read off _doomed, both keyed.
  const [dc] = await q<{ cents: string }>(
    client,
    `SELECT COALESCE(sum(amount_cents), 0)::text AS cents FROM _doomed`,
  );
  const deletedCents: number | null = Number(dc?.cents ?? 0);
  const [pd] = await q<{ cents: string }>(
    client,
    `SELECT COALESCE(sum(d.amount_cents - o.amount_cents), 0)::text AS cents
       FROM _doomed d
       JOIN financial_relationships o ON o.id = d.owner_row
      WHERE d.row_class = 'CROSS'
        AND d.updated_at > d.owner_updated_at
        AND d.amount_cents <> o.amount_cents`,
  );
  const propagatedCents = Number(pd?.cents ?? 0);

  console.log("\n── Phase 1: the delete (one transaction) ────────────────");
  await client.query("BEGIN");
  try {
    // Donor + official sets, captured BEFORE the delete — after it they are gone.
    await client.query(
      `DROP TABLE IF EXISTS _affected;
       CREATE TEMP TABLE _affected AS SELECT DISTINCT official_id FROM _doomed;
       DROP TABLE IF EXISTS _donor;
       CREATE TEMP TABLE _donor AS SELECT DISTINCT donor_id AS id FROM _doomed WHERE donor_id IS NOT NULL;`,
    );

    // 1. Fresher-wins propagation onto the owner's row, for CROSS rows only.
    //    Identical rule to FIX-954: the owner is the rightful holder and keeps
    //    their row; only a strictly fresher value moves.
    const refreshed = await run(
      client,
      "propagate fresher amount onto owner (CROSS)",
      `UPDATE financial_relationships o
          SET amount_cents = d.amount_cents,
              metadata     = COALESCE(o.metadata,'{}'::jsonb)
                             || jsonb_build_object('fix1153_refreshed_from_role_ineligible', true),
              updated_at   = now()
         FROM _doomed d
        WHERE o.id = d.owner_row
          AND d.row_class = 'CROSS'
          AND d.updated_at > d.owner_updated_at
          AND d.amount_cents <> o.amount_cents`,
    );

    // 2. Delete every doomed row — both classes.
    const [frozen] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _doomed`);
    const deleted = await run(
      client,
      "FR delete role-ineligible holdings",
      `DELETE FROM financial_relationships fr USING _doomed d WHERE fr.id = d.row_id`,
    );
    if (deleted !== Number(frozen?.n ?? 0)) {
      throw new Error(`deleted ${deleted} rows but the manifest froze ${frozen?.n}`);
    }

    // 3. Retire the stored id. Renamed, never dropped — it is evidence, and
    //    leaving it in place hands the slot back on the next fec run.
    const retired = await run(
      client,
      "officials: fec_id → misattributed_fec_id",
      `UPDATE officials o
          SET source_ids = (o.source_ids - 'fec_id')
                         || jsonb_build_object('misattributed_fec_id', o.source_ids->>'fec_id'),
              updated_at = now()
        FROM _pop p
       WHERE o.id = p.official_id AND o.source_ids ? 'fec_id'`,
    );

    // 4. entity_connections money edges into these officials are now false.
    //    Fully derived by rebuild_entity_connections_donations, so the FIX-544
    //    precedent applies: delete-affected, let the crawl repopulate.
    await run(
      client,
      "entity_connections delete stale money edges",
      `DELETE FROM entity_connections e
        USING _pop p
        WHERE e.to_type='official' AND e.to_id = p.official_id
          AND e.from_type='financial_entity'
          AND e.connection_type::text = ANY($1::text[])`,
      [MONEY_EDGE_TYPES],
    );

    await client.query("COMMIT");
    console.log(`\n  committed — ${deleted.toLocaleString()} FR rows deleted, ${retired} id(s) retired, ${refreshed} owner row(s) refreshed`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n✗ ROLLED BACK — ${err instanceof Error ? err.message : String(err)}`);
    await client.end();
    process.exit(1);
  }

  // ── Conservation ──────────────────────────────────────────────────────────
  const conservationAfter = manifest
    ? (await q<{ rows: string; cents: string }>(client, KEYED_CONSERVATION_SQL, [donorIds]))[0]
    : (await q<{ rows: string; cents: string }>(client, PLATFORM_SQL))[0];

  const scope = manifest ? `affected donors (${donorIds.length.toLocaleString()})` : "platform";
  const before = Number(conservationBefore?.cents ?? 0);
  const after = Number(conservationAfter?.cents ?? 0);
  console.log(`\n  ${scope} donation total: ${usd(before)} → ${usd(after)}`);
  const expected = before - deletedCents + propagatedCents;
  console.log(
    `  deleted ${usd(-deletedCents)}; fresher-wins propagation ${usd(propagatedCents)}; ` +
      `expected ${usd(expected)}`,
  );
  if (after !== expected) {
    console.error(
      `  ! CONSERVATION FAILED — expected ${usd(expected)}, got ${usd(after)} ` +
        `(off by ${usd(after - expected)}). Rows moved that this run did not touch. ` +
        `Investigate before reporting.`,
    );
  } else {
    console.log(`  conservation OK`);
  }

  await runRollups(client, prod, defer);
  await runMvsAndVacuum(client, defer);

  // ── The closing number ────────────────────────────────────────────────────
  // FIX-1165 — keyed on the manifest, and it answers BOTH halves of the class:
  // still holding fec_bulk money (FIX-1153) and still carrying an fec_id the
  // role cannot hold (FIX-1164). The clone path keeps the platform-wide form,
  // which is the stronger statement and is affordable where it runs.
  if (manifest) {
    const [c] = await q<{ still_money: string; still_id: string }>(client, KEYED_CLOSING_SQL, [
      popIds,
      ELECTABLE_ROLES,
    ]);
    console.log(`  manifest officials still holding fec_bulk money: ${c?.still_money}`);
    console.log(`  manifest officials still carrying an fec_id:     ${c?.still_id}`);
    if (c?.still_money !== "0" || c?.still_id !== "0") {
      console.error("  ! expected 0 and 0 — the class is NOT closed for this manifest.");
    }
  } else {
    const [left] = await q<{ n: string }>(
      client,
      `SELECT count(DISTINCT o.id)::text AS n
         FROM officials o
         JOIN financial_relationships fr
           ON fr.to_type='official' AND fr.relationship_type='donation'
          AND fr.to_id = o.id AND fr.metadata->>'source' LIKE 'fec_bulk%'
        WHERE COALESCE(o.role_title,'') <> ALL($1::text[])`,
      [ELECTABLE_ROLES],
    );
    console.log(`  officials with a role-ineligible title still holding fec_bulk money: ${left?.n}`);
    if (left?.n !== "0") {
      console.error("  ! expected 0 — the class is NOT closed. Investigate before reporting.");
    }
  }

  await client.end();
}

/**
 * Set differences, both ways, against the three manifests this population is
 * supposed to reconcile with. A row in a manifest that the predicate does not
 * return is a premise contradiction to REPORT, not to force.
 */
async function reconcile(client: Client, pop: PopRow[]): Promise<void> {
  console.log("\n── Reconciliation ───────────────────────────────────────");
  const predicate = new Set(pop.map((r) => r.official_id));

  // (a) the classifier's own ROLE-INELIGIBLE branch, re-derived live.
  const suspects = (await client.query<SuspectRow>(SUSPECT_SQL)).rows;
  const { classified } = classify(suspects);
  const branch = classified.filter((e) => e.branch === "ROLE-INELIGIBLE HOLDER");
  const branchIds = new Set(branch.map((e) => e.official_id));
  console.log(`  classifier ROLE-INELIGIBLE branch: ${branch.length}`);

  const inBranchNotPredicate = branch.filter((e) => !predicate.has(e.official_id));
  const inPredicateNotBranch = pop.filter((r) => !branchIds.has(r.official_id));
  console.log(`    in branch but NOT in the predicate: ${inBranchNotPredicate.length}`);
  for (const e of inBranchNotPredicate) console.log(`      ! ${e.full_name} (${e.role_title})`);
  console.log(`    in the predicate but NOT in the branch: ${inPredicateNotBranch.length}`);
  for (const r of inPredicateNotBranch.slice(0, 40)) {
    console.log(`      + ${r.full_name} (${r.role_title}, ${r.jurisdiction ?? "—"}, ${usd(r.fec_cents)})`);
  }
  if (inPredicateNotBranch.length > 40) {
    console.log(`      … and ${inPredicateNotBranch.length - 40} more (see the manifest TSV)`);
  }

  // (b) the FIX-937 manifests, if they are still on disk.
  const auditDir = path.resolve(process.cwd(), "../../docs/audits");
  for (const f of [
    "2026-09-05-fix937-nonfederal-holders-active.tsv",
    "2026-09-05-fix937-nonfederal-holders-inactive.tsv",
    "2026-09-05-fix935-unique-holder-manifest.tsv",
  ]) {
    const p = path.join(auditDir, f);
    if (!fs.existsSync(p)) {
      console.log(`  ${f}: not on disk — skipped`);
      continue;
    }
    // These manifests carry a leading `#` banner (counts, provenance, refusal
    // reasons) before the real header row — skip it rather than reading the
    // banner as a header, which silently reports "no official_id column".
    const lines = fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.trim() !== "");
    const head = lines[0]!.split("\t");
    const idCol = head.findIndex((c) => /official_id|^id$/i.test(c));
    if (idCol < 0) {
      console.log(`  ${f}: no official_id column — skipped`);
      continue;
    }
    const ids = lines.slice(1).map((l) => l.split("\t")[idCol]!).filter(Boolean);
    const missing = ids.filter((id) => !predicate.has(id));
    console.log(`  ${f}: ${ids.length} rows, ${missing.length} NOT returned by the predicate`);
    for (const id of missing.slice(0, 20)) console.log(`      ! ${id}`);
  }
}

// FIX-950 — see merge-same-person-official-dupes.ts's tail.
runUnderProdSession(
  { script: "remediate-role-ineligible-holders", expectedMinutes: 120 },
  main,
).catch((err) => {
  console.error(err);
  process.exit(1);
});
