/**
 * FIX-1074 / FIX-1165 — the one drain a financial_relationships rewrite owes.
 *
 * FIX-1074 left an OPEN QUESTION: "whether the drain belongs in each landing
 * script or in one shared post-bulk-landing helper that takes the set of tables
 * rewritten and maps them to the derived arms that consume them. The second is
 * better if more than two landing scripts need it."
 *
 * The tree answers it. THREE scripts already carry a byte-for-byte identical
 * tail — remediate-role-ineligible-holders, remediate-cross-person-
 * misattribution, merge-same-person-official-dupes — and FIX-1106's residue
 * sweep is a fourth. Four is more than two, so the helper wins, and this is it.
 *
 * WHAT A FINANCIAL_RELATIONSHIPS REWRITE OWES, in order:
 *
 *   1. entity_connections money edges for the rows deleted   (the 954:693 shape)
 *   2. donor_rollup_rebuild_recipients(affected officials)
 *   3. financial_entity_donation_totals_rebuild(donors)      chunked
 *   4. donor_party_rollup_rebuild_donors(donors)             chunked
 *   ---- everything past here is platform-scoped and defers ----
 *   5. rebuild_financial_entity_ie_totals / refresh_group_donor_rollup /
 *      rebuild_entity_search_index / refresh_treemap_individuals_global
 *   6. the six MV refreshes
 *   7. VACUUM (ANALYZE) on what was rewritten
 *
 * Steps 1-4 SCALE WITH THE MANIFEST. Steps 5-7 do not, and every one of them has
 * a scheduled owner on prod. That split is FIX-1165's standing rule, and the
 * reviewer's test for it is a measurement rather than a judgement: if a step's
 * runtime does not move when the manifest goes from 28 rows to 2,736, it is
 * platform-scoped by definition.
 *
 * THE DONORS MUST BE CAPTURED BEFORE THE DELETE. After it they are unreachable —
 * the rows that named them are gone. Callers own that capture; this helper takes
 * the temp tables it produces and never re-derives them, because re-deriving on
 * prod is the 81-minute, 132-cancellation phase FIX-1165 exists to end.
 */

import type { Client } from "pg";
import {
  declareRemediationTail,
  printTailTable,
  type TailStep,
} from "../scripts/remediation-manifest";
import { readOwnerSchedules } from "./cron-job-pipelines";

/** Chunk width for the two per-donor rollups. Matches the three scripts. */
export const DONOR_CHUNK = 5000;

/** Money edge types entity_connections derives from donation rows. */
export const MONEY_EDGE_TYPES = ["donation", "opposition"] as const;

/** Per-step budget ceilings, seconds. */
export const STEP_BUDGET_S: Readonly<Record<string, number>> = {
  ec_delete: 20 * 60,
  donor_rollup: 40 * 60,
  fe_totals_chunk: 10 * 60,
  donor_party_chunk: 10 * 60,
  heavy: 40 * 60,
  mv: 20 * 60,
};

export class BudgetExceeded extends Error {}

/**
 * 57014 query_canceled / 57P01 admin_shutdown — a human or a watchdog said stop.
 *
 * FIX-1165: a cancel used to be swallowed like any other step failure, so the
 * hand-cancel of rebuild_financial_entity_ie_totals() at minute 28 on 2026-09-07
 * fell straight through into refresh_group_donor_rollup(), which ran a further
 * 414 s against a front door already at ~70x its baseline cancellation rate.
 * Someone reaching for pg_cancel_backend means STOP, and every step here is
 * resumable.
 */
export function isCancellation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "57014" || code === "57P01";
}

async function q<T>(client: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await client.query(sql, params);
  return res.rows as T[];
}

/** Run one step under a statement_timeout, converting a timeout to BudgetExceeded. */
async function budgeted(
  client: Client,
  label: string,
  sql: string,
  budgetSeconds: number,
  params: unknown[] = [],
): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`  ${label} ... `);
  try {
    await client.query(`SET LOCAL statement_timeout = '${budgetSeconds}s'`);
    await client.query(sql, params);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if ((err as { code?: string })?.code === "57014" && Date.now() - t0 >= budgetSeconds * 900) {
      console.log(`BUDGET (${secs}s)`);
      throw new BudgetExceeded(`${label} exceeded its ${budgetSeconds}s budget`);
    }
    console.log(`FAILED (${secs}s)`);
    throw err;
  }
}

export interface DrainScope {
  /**
   * Temp table naming the affected OFFICIALS, and the column holding their id.
   * The three scripts disagree on the column name (`official_id` vs `id`), which
   * is why it is a parameter rather than an assumption.
   */
  affectedTable: string;
  affectedIdColumn: string;
  /** Temp table naming the affected DONORS (financial_entities.id in `id`). */
  donorTable: string;
  /**
   * financial_relationships.id values the landing deleted, for the EC money-edge
   * cleanup. Null when the landing moved rows rather than deleting them.
   */
  deletedFrRowIds?: string[] | null;
}

export interface DrainOptions {
  prod: boolean;
  /**
   * --defer-tails, for the TABLE the drain prints. The drain never runs a
   * platform-scoped step either way; this controls how the trade is reported so
   * a caller that intends to pay the platform cost itself says so out loud.
   */
  defer: boolean;
  /** Tables the landing rewrote, for the FIX-943 vacuum step's tail entry. */
  churnedTables?: readonly string[];
  /**
   * Print the tail table here. Default true. The three remediation scripts
   * already print it at their dry-run planning stage — before the go-ahead,
   * which is the point of it (FIX-1165 c) — so they pass false to avoid a second
   * copy at execution time.
   */
  printTable?: boolean;
}

/**
 * The tail this helper will execute, as a declared table.
 *
 * Shared with the three remediation scripts via declareRemediationTail so there
 * is exactly one place a step's cost class and owner are asserted — and so the
 * FIX-1165 structural test that reads the scripts' source can read this too.
 */
export function declareDrainTail(defer: boolean): TailStep[] {
  return declareRemediationTail(defer);
}

/**
 * Drive the derived arms a financial_relationships rewrite dirtied.
 *
 * Returns the steps it actually ran, so a caller (and a test) can assert that
 * nothing platform-scoped executed under --defer-tails.
 */
export async function drainFrRewrite(
  client: Client,
  scope: DrainScope,
  opts: DrainOptions,
): Promise<{ ran: string[]; deferred: string[] }> {
  const steps = declareDrainTail(opts.defer);
  // FIX-1193 - the owners' live cron.job schedule and guard state. Read here
  // rather than passed in, because this helper already holds the connection and
  // a second source for the same fact is what the parentheticals were.
  if (opts.printTable !== false) {
    printTailTable(steps, opts.defer, await readOwnerSchedules(client));
  }

  const ran: string[] = [];
  const deferred = steps.filter((s) => s.deferred).map((s) => s.label);

  console.log("\n-- FR rewrite drain (post-commit, chunked) ----------------");

  const [offRow] = await q<{ n: string }>(
    client,
    `SELECT count(*)::text AS n FROM ${scope.affectedTable}`,
  );
  const [donorRow] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM ${scope.donorTable}`);
  const officials = Number(offRow?.n ?? 0);
  const donors = Number(donorRow?.n ?? 0);
  console.log(`  affected officials: ${officials.toLocaleString()}   donors: ${donors.toLocaleString()}`);

  try {
    // -- 1. entity_connections money edges for the deleted rows --------------
    // FIX-544/693: EC donation edges are fully derived, so deleting the FR rows
    // they came from leaves them false until the next rebuild. Scoped by the
    // deleted row ids, never by a global predicate.
    if (scope.deletedFrRowIds && scope.deletedFrRowIds.length > 0) {
      await budgeted(
        client,
        `entity_connections delete stale money edges (${scope.deletedFrRowIds.length.toLocaleString()} rows)`,
        `DELETE FROM public.entity_connections e
           USING unnest($1::uuid[]) AS d(fr_id)
          WHERE e.connection_type = ANY($2::text[])
            AND e.evidence_source = 'financial_relationships'
            AND e.evidence_id = d.fr_id`,
        STEP_BUDGET_S["ec_delete"]!,
        [scope.deletedFrRowIds, [...MONEY_EDGE_TYPES]],
      );
      ran.push("entity_connections delete stale money edges");
    }

    // -- 2. recipients -------------------------------------------------------
    // FIX-964: in a resume the affected set can legitimately be empty — after
    // the commit it is unrecoverable unless handed back in. Say what is being
    // skipped rather than calling the RPC with an empty array and reading the
    // no-op as success.
    if (officials > 0) {
      await budgeted(
        client,
        "donor_rollup_rebuild_recipients(affected)",
        `SELECT donor_rollup_rebuild_recipients(
                  ARRAY(SELECT ${scope.affectedIdColumn} FROM ${scope.affectedTable}))`,
        STEP_BUDGET_S["donor_rollup"]!,
      );
      ran.push("donor_rollup_rebuild_recipients(affected)");
      console.log("    -> official_donor_totals, official_donor_rollup_mv,");
      console.log("       official_small_dollar_rollup, official_sector_affinity_rollup,");
      console.log("       treemap_individuals_rollup, official_donor_bracket_totals");
    } else {
      console.log(
        `  SKIPPED donor_rollup_rebuild_recipients -- no affected officials in scope ` +
          `(pass the official ids back in to run it)`,
      );
    }

    // -- 3 + 4. the two per-donor rollups, chunked ---------------------------
    // CHUNKED deliberately. Unchunked over 105,778 donors this ran 66+ minutes on
    // prod and forced the first merge attempt to be cancelled. Per-chunk calls
    // commit independently, so an abort costs one chunk, not the run.
    const chunks = Math.ceil(donors / DONOR_CHUNK);
    if (chunks === 0) {
      console.log(
        `  SKIPPED financial_entity_donation_totals_rebuild + donor_party_rollup_rebuild_donors --
` +
          `    no donor set. Donors are read off the rows the landing DELETED and a DELETE leaves
` +
          `    no trace, so the set cannot be reconstructed after the commit (FIX-964). Their
` +
          `    totals stay stale until a manifest exists or a full rebuild runs.`,
      );
    }
    for (let i = 0; i < chunks; i++) {
      await budgeted(
        client,
        `financial_entity_donation_totals_rebuild ${i + 1}/${chunks}`,
        `SELECT financial_entity_donation_totals_rebuild(
                  ARRAY(SELECT id FROM ${scope.donorTable} ORDER BY id OFFSET $1 LIMIT $2))`,
        STEP_BUDGET_S["fe_totals_chunk"]!,
        [i * DONOR_CHUNK, DONOR_CHUNK],
      );
    }
    if (chunks > 0) ran.push("financial_entity_donation_totals_rebuild");

    for (let i = 0; i < chunks; i++) {
      await budgeted(
        client,
        `donor_party_rollup_rebuild_donors ${i + 1}/${chunks}`,
        `SELECT donor_party_rollup_rebuild_donors(
                  ARRAY(SELECT id FROM ${scope.donorTable} ORDER BY id OFFSET $1 LIMIT $2))`,
        STEP_BUDGET_S["donor_party_chunk"]!,
        [i * DONOR_CHUNK, DONOR_CHUNK],
      );
    }
    if (chunks > 0) ran.push("donor_party_rollup_rebuild_donors");

    // -- 5-7. platform-scoped. NOT EXECUTED HERE, EVER. ---------------------
    //
    // The helper's scope is the manifest's cost and nothing else. That is
    // FIX-1165's rule stated as a boundary rather than a flag: a step whose
    // runtime does not move when the manifest goes from 28 rows to 2,736 has no
    // business inside a manifest-scoped drain.
    //
    // Two consequences, both deliberate:
    //   * --defer-tails is the DEFAULT here and not an option. A caller that
    //     genuinely wants a platform rebuild runs it itself, in its own window,
    //     with its own budget.
    //   * the platform steps stay in the callers that already implement them
    //     correctly. refresh_treemap_individuals_global() in particular must
    //     NEVER be run under an armed statement_timeout — the 2026-08-05
    //     server-side cancellation of exactly that step wedged prod for ~7 hours
    //     (FIX-965), and it takes its budget through a session GUC instead.
    //     Folding it into a generic step loop here would silently re-arm the
    //     timeout that caused the incident.
    //
    // What the caller gets back is the declared list, so a test can assert that
    // nothing platform-scoped ran.
    console.log(
      `
  ${deferred.length} platform-scoped step(s) declared and NOT run here.
` +
        `  Vacuum included: the residue this landing leaves is collected by the daily and
` +
        `  Monday vacuum jobs (FIX-1152 slots), not by this script (FIX-943 + rule 41).`,
    );

    return { ran, deferred };
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    console.error(`\nFAIL DRAIN ABORTED -- ${err.message}`);
    console.error(
      `  The landing is COMMITTED and correct; only the derived layer is incomplete.\n` +
        `  Resume with --rollups-only${opts.prod ? " --allow-prod" : ""}${opts.defer ? " --defer-tails" : ""}.`,
    );
    throw err;
  }
}
