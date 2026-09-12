/**
 * FIX-934 phase 2 — remediate the CROSS-PERSON MISATTRIBUTION branch.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 * ---------------------------------------
 * Phase 1 (`audit-cross-person-misattribution.ts`) established that a suspect's
 * holding is a UNION of several people's money and that the safe unit of action
 * is the ROW, not the official. This script acts on exactly one of the three row
 * classes phase 1 derives:
 *
 *   CROSS     DELETED from the suspect. A different person already holds the
 *             identical (relationship_type, from_id, cycle_year) key, so the
 *             money still renders — under the right name.
 *   OWN       LEFT ALONE. The colliding counterpart is the suspect's own other
 *             `officials` row (Shontel M. Brown vs `M Brown [H2OH11169]`, Al
 *             Green vs `Alexander Green [H4TX09095]`). Deleting these would
 *             delete a sitting member's own donors. They are FIX-933 merges in
 *             the opposite direction and belong to FIX-953.
 *   DIVERTED  LEFT ALONE. Nobody else holds it, so it is the only copy and
 *             deleting it destroys real FEC data. Its owner is not recoverable
 *             from the money (nothing in financial_relationships records a
 *             CAND_ID), so it cannot be moved either. See FIX-952.
 *
 * FRESHER-WINS, NOT UNCONDITIONAL DELETE
 * --------------------------------------
 * The two copies of a CROSS key can disagree on amount: they are aggregated
 * rows (`aggregated: true, tx_count: N`) written by runs at different times.
 * Phase 1 measured 28 officials holding $118,950 ABOVE the true owner's copy. A
 * bare delete would destroy that difference rather than de-duplicate it, so
 * where the suspect's row is strictly FRESHER by `updated_at` its amount and
 * metadata are propagated onto the owner's row BEFORE the delete. That is
 * FIX-933's collision rule, applied in the only direction that is correct here
 * (the owner is the rightful holder and keeps their row; only the value moves).
 *
 * THE WRONG BINDING IS RETIRED, NOT DELETED
 * -----------------------------------------
 * A suspect carrying a `fec_id` that its role cannot legitimately hold (the
 * FIX-937 read/write asymmetry — judges and council members holding House or
 * Senate CAND_IDs) has
 * it renamed to `misattributed_fec_id`. Renaming rather than deleting keeps the
 * evidence; leaving it in place would hand the slot back on the next run.
 *
 * RESUME MODES (FIX-964)
 * ----------------------
 * `--vacuum-only`, `--mvs-only` and `--rollups-only` all short-circuit BEFORE
 * the FIX-930 suspect derivation. `--rollups-only` did not, and that made the
 * script's own advertised recovery path impossible to use: the abort message
 * printed "Resume with --rollups-only", but that mode re-ran the derivation,
 * which post-commit finds 0 CROSS suspects (the deletes already happened) and
 * exited "Nothing to remediate" without running a single rollup step. Measured
 * on prod 2026-08-05 when refresh_treemap_individuals_global() blew its budget
 * mid-tail. The resume path can never work after the commit it exists to
 * resume, so it no longer derives anything.
 *
 * What resume can and cannot recover:
 *   - The GLOBAL phase-2 steps (official totals, FE IE totals, group rollup,
 *     search index, treemap) need no manifest and always run.
 *   - The OFFICIAL-scoped step (donor_rollup_rebuild_recipients) takes its list
 *     from `--officials <uuid,uuid,…>` when supplied.
 *   - The DONOR-scoped chunk loops (financial_entity_donation_totals_rebuild,
 *     donor_party_rollup_rebuild_donors) CANNOT be reconstructed after the
 *     commit — the donor set is read off the deleted rows, and a DELETE leaves
 *     no trace. They are skipped, loudly, with the reason printed. Re-run the
 *     apply-path steps for those donors only if a manifest exists.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:remediate:cross-person             # dry-run
 *   pnpm --filter @civitics/data data:remediate:cross-person -- --apply  # commit
 *   pnpm --filter @civitics/data data:remediate:cross-person -- --rollups-only
 *   pnpm --filter @civitics/data data:remediate:cross-person -- --rollups-only --officials <uuid>,<uuid>
 */

import { Client } from "pg";
import {
  ALL_OWNERS_SQL,
  classify,
  constructDbUrlFromEnv,
  deferTails,
  envLabel,
  type OwnerBase,
  ownerRelation,
  OWNER_SQL,
  printDeferredTail,
  ROWCLASS_SQL,
  ROWHIT_SQL,
  seatMatches,
  SPLIT_SQL,
  type SplitRow,
  SUSPECT_SQL,
  suspectSqlKeyed,
  type SuspectRow,
  usd,
} from "./fec-orphan-classify";
import {
  declareRemediationTail,
  manifestArg,
  manifestColumn,
  printTailTable,
  requireManifestOnProd,
} from "./remediation-manifest";
import { drainFrRewrite } from "../lib/fr-rewrite-drain";
import { runUnderProdSession } from "../lib/prod-session";

/** Sanity bound — phase 1 measured 59 after exclusions. */
const MAX_SUSPECTS = 200;
// FIX-1074: the chunk width moved into fr-rewrite-drain.ts with the drain itself.

/** Mike Collins' S6GA00390 is genuinely his (2026 GA Senate bid). Never touch. */
const EXCLUDED_FEC_IDS = new Set(["S6GA00390"]);

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
// FIX-975 — financial_entities added: this script mass-UPDATEs it via the
// chunked financial_entity_donation_totals_rebuild loop and
// rebuild_financial_entity_ie_totals below, and nothing else on the schedule
// vacuumed it (vacuum_count was 0 instance-wide).
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

/** 57014 query_canceled / 57P01 admin_shutdown — a human or a watchdog said stop. */
function isCancellation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "57014" || code === "57P01";
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

async function q<T = Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

async function run(client: Client, label: string, sql: string, params: unknown[] = []): Promise<number> {
  const t0 = Date.now();
  const res = await client.query(sql, params);
  const n = res.rowCount ?? 0;
  console.log(`  ${label.padEnd(52)} ${String(n).padStart(9)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
}

async function step(client: Client, label: string, sql: string): Promise<void> {
  const t0 = Date.now();
  await client.query(sql);
  console.log(`  ${label.padEnd(52)} ${" ".repeat(9)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function budgeted(client: Client, label: string, sql: string, budgetS: number, params: unknown[] = []): Promise<void> {
  const t0 = Date.now();
  await client.query(`SET statement_timeout = ${Math.round(budgetS * 1000)}`);
  try {
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
  // FIX-1153 — on prod the scheduled *-vacuum-analyze jobs own this entirely;
  // a script-run VACUUM of these tables is a front-door incident (FIX-1144).
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
 * Rollups — post-commit, chunked, interruptible. Same shape and rationale as
 * FIX-933's: nothing here is atomic with the delete and nothing needs to be,
 * because every rollup is a pure function of the committed rows.
 */
async function runRollups(client: Client, prod: boolean, defer = false): Promise<void> {
  console.log("\n── Phase 2: rollups (post-commit, chunked) ──────────────");

  const [offCount] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _affected`);
  const officials = Number(offCount?.n ?? 0);
  console.log(`  affected officials: ${officials.toLocaleString()}`);

  // Donors whose OUTFLOW changed. Read off the DONOR side of the deleted rows,
  // captured before the delete — a DELETE bumps no updated_at, so the
  // incremental pg_cron paths would silently skip exactly these.
  const [donorCount] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _donor`);
  const donors = Number(donorCount?.n ?? 0);
  console.log(`  affected donors:    ${donors.toLocaleString()}`);

  try {
    // FIX-1074 — the manifest-scoped drain is now ONE shared helper
    // (packages/data/src/lib/fr-rewrite-drain.ts). Three remediation scripts
    // carried a byte-for-byte identical copy of these steps and FIX-1106's
    // residue sweep is a fourth caller, which answers FIX-1074's open question
    // ("each landing script or one shared helper") from the tree rather than
    // from taste. The FIX-964 empty-set guards moved into the helper with it.
    //
    // This script's _affected keys on `id`; role-ineligible's on `official_id`
    // and the merge script's table is _affected_officials — which is why the
    // helper takes the names as parameters rather than assuming them.
    await drainFrRewrite(
      client,
      { affectedTable: "_affected", affectedIdColumn: "id", donorTable: "_donor" },
      { prod, defer, printTable: false },
    );

    // FIX-1165 — ALL of these defer, the two entity-total rebuilds included.
    // The comment this replaces said they stay "because nothing scheduled knows
    // which rows this run deleted". That reasoning is right for the DONOR- and
    // OFFICIAL-scoped rollups above and wrong for these two: neither takes an
    // argument, so neither knows what this run deleted either — both recompute
    // the whole platform. rebuild_financial_entity_ie_totals() ran 28 minutes on
    // the 28-row set-2 apply and produced 70 of its 202 statement cancellations.
    // refresh_group_donor_rollup() genuinely had no owner, which is why FIX-1165
    // gave it one rather than leaving it to whichever remediation ran next.
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
        // FIX-1165 — a CANCEL stops the tail rather than advancing to the next
        // platform-scoped step. On 2026-09-07 the hand-cancel of
        // rebuild_financial_entity_ie_totals() was swallowed here and the loop
        // moved straight on to refresh_group_donor_rollup(), which ran a further
        // 414 s against a front door already at ~70x its baseline.
        if (isCancellation(err)) {
          console.error(`\n✗ ${label} was CANCELLED — stopping the tail.`);
          console.error(
            `  The delete is COMMITTED and the manifest-scoped rollups are done.` +
              ` Remaining steps have scheduled owners; let them collect.`,
          );
          throw err;
        }
        console.error(`  ! ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // FIX-965: the treemap global refresh is resumable and budget-guards
    // ITSELF. Never arm a statement_timeout around this CALL — the 2026-08-05
    // server-side cancellation of exactly this step wedged the prod instance
    // for ~7 hours. Hand the step budget to the procedure's session GUC; on
    // budget it exits cleanly as status='partial' and any later CALL (weekly
    // cron or data:treemap:sweep) resumes from the committed chunk cursor.
    if (defer) {
      printDeferredTail("heavy");
    } else try {
      await client.query(
        `SET civitics.treemap_global_budget_seconds = '${STEP_BUDGET_S["heavy"]!}'`,
      );
      await step(client, "refresh_treemap_individuals_global()", `CALL refresh_treemap_individuals_global()`);
      const [tm] = await q<{ status: string }>(
        client,
        `SELECT status FROM data_sync_log
          WHERE pipeline = 'treemap_individuals_global_refresh'
          ORDER BY started_at DESC LIMIT 1`,
      );
      if (tm && tm.status !== "complete") {
        console.error(
          `  ! treemap global refresh ended '${tm.status}' — resumable; ` +
            `finish with: pnpm --filter @civitics/data data:treemap:sweep${prod ? ":prod" : ""}`,
        );
      }
    } catch (err) {
      console.error(
        `  ! refresh_treemap_individuals_global() failed: ${err instanceof Error ? err.message : String(err)} ` +
          `(committed chunks are cursor-tracked; resume with data:treemap:sweep)`,
      );
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    console.error(`\n✗ ROLLUPS ABORTED — ${err.message}`);
    // FIX-964: this message is only true because --rollups-only no longer
    // re-derives the manifest. Keep the --officials hint attached to it — the
    // official-scoped step is the one the resume cannot infer for itself.
    const officialsHint =
      officials > 0
        ? `\n  Re-scope the official step with: --officials ${await affectedIdList(client)}`
        : "";
    console.error(
      `  The delete is COMMITTED and correct; only rollups are incomplete.\n` +
        `  Resume with --rollups-only${prod ? " --allow-prod" : ""}.` +
        officialsHint,
    );
  }
}

/** Comma-joined affected-official ids, for pasting into a `--officials` resume. */
async function affectedIdList(client: Client): Promise<string> {
  try {
    const rows = await q<{ id: string }>(client, `SELECT id::text FROM _affected ORDER BY id`);
    return rows.map((r) => r.id).join(",");
  } catch {
    return "<_affected unavailable>";
  }
}

export type RunMode = "vacuum-only" | "mvs-only" | "rollups-only" | "full";

export interface ModeSelection {
  mode: RunMode;
  /** Commits rather than rolling back. Every resume mode implies it. */
  apply: boolean;
  /** Whether the FIX-930 suspect derivation runs. Only `full` derives. */
  derives: boolean;
  officialIds: string[];
}

/**
 * FIX-964 — single place that decides what a given argv actually does, so the
 * "does this mode derive?" question is answerable without a database. The bug
 * this encodes against: `--rollups-only` used to answer `derives: true`, which
 * post-commit means "find 0 suspects and exit before any rollup step".
 */
export function selectMode(argv: string[]): ModeSelection {
  const rollupsOnly = argv.includes("--rollups-only");
  const mvsOnly = argv.includes("--mvs-only");
  const vacuumOnly = argv.includes("--vacuum-only");
  const mode: RunMode = vacuumOnly
    ? "vacuum-only"
    : mvsOnly
      ? "mvs-only"
      : rollupsOnly
        ? "rollups-only"
        : "full";
  return {
    mode,
    apply: argv.includes("--apply") || mode !== "full",
    derives: mode === "full",
    officialIds: parseOfficialsArg(argv),
  };
}

/** `--officials a,b,c` (repeatable). Rejects anything that is not a UUID. */
export function parseOfficialsArg(argv: string[]): string[] {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--officials=")) raw.push(a.slice("--officials=".length));
    else if (a === "--officials" && argv[i + 1]) {
      raw.push(argv[i + 1]!);
      i++;
    }
  }
  const ids = raw
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = ids.filter(
    (s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  );
  if (bad.length > 0) {
    throw new Error(`--officials contains non-UUID value(s): ${bad.join(", ")}`);
  }
  return [...new Set(ids)];
}

/**
 * FIX-964 — phase-2 resume. Stands up the two manifest temp tables the rollup
 * steps read, WITHOUT re-deriving anything: `_affected` from `--officials` (or
 * empty), `_donor` always empty. Then runs the same phase 2 → phase 3 sequence
 * the apply path runs, so a resume finishes the run rather than half of it.
 */
async function runRollupsResume(client: Client, prod: boolean, officialIds: string[], defer = false): Promise<void> {
  console.log("\n── RESUME (--rollups-only): no derivation, no delete ────");
  console.log(`  officials handed in: ${officialIds.length}`);
  await client.query(`
    DROP TABLE IF EXISTS _affected;
    CREATE TEMP TABLE _affected (id uuid PRIMARY KEY);
    DROP TABLE IF EXISTS _donor;
    CREATE TEMP TABLE _donor (id uuid PRIMARY KEY);
  `);
  if (officialIds.length > 0) {
    await client.query(`INSERT INTO _affected (id) SELECT unnest($1::uuid[])`, [officialIds]);
  }
  await runRollups(client, prod, defer);
  await runMvsAndVacuum(client, defer);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let selection: ModeSelection;
  try {
    selection = selectMode(argv);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { mode, apply, officialIds } = selection;
  const rollupsOnly = mode === "rollups-only";
  const mvsOnly = mode === "mvs-only";
  const vacuumOnly = mode === "vacuum-only";
  const allowProd = argv.includes("--allow-prod");
  const defer = deferTails(argv);
  const prod = isProd();
  const manifestPath = manifestArg(argv);

  // FIX-1165 Rule 1 — checked for dry runs too. The FIX-930 re-derivation below
  // is a full audit scan of financial_relationships; on 2026-09-07 it ran 81
  // minutes on prod and produced 132 of the day's 202 statement cancellations,
  // for a manifest of 28 rows. Derive on the clone, apply from the TSV.
  const manifest = requireManifestOnProd({
    prod,
    manifestPath,
    script: "remediate-cross-person-misattribution",
    flag: "--manifest <path>",
  });
  if (officialIds.length > 0 && !rollupsOnly) {
    console.error("✗ --officials is only meaningful with --rollups-only (FIX-964 resume scope).");
    process.exit(1);
  }

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  This script DELETES financial_relationships rows. Re-run with --allow-prod\n" +
        "  only after the local run has been reviewed and signed off.",
    );
    process.exit(1);
  }

  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD.");
    process.exit(1);
  }

  console.log(`# FIX-934 phase 2 — remediate CROSS-PERSON misattribution`);
  console.log(`Env:        ${envLabel()}`);
  console.log(`Connection: ${dbUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(
    `Mode:       ${mode}` +
      (mode === "full" ? ` — ${apply ? "APPLY (COMMIT)" : "DRY-RUN (ROLLBACK)"}` : " — resume, no derivation, no delete") +
      "\n",
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

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
  // FIX-964: short-circuit BEFORE the derivation, like the other two resume
  // modes. Deriving here is what made the advertised resume path a no-op.
  if (rollupsOnly) {
    await runRollupsResume(client, prod, officialIds, defer);
    await client.end();
    return;
  }

  // ── Re-derive the manifest live ──────────────────────────────────────────
  let suspects: SuspectRow[];
  if (manifest) {
    const ids = manifestColumn(manifest, "official_id");
    console.log(`Manifest: ${manifest.path}`);
    console.log(`  ${ids.length} suspects — re-measuring their FIX-930 facts here, keyed.`);
    suspects = (await client.query<SuspectRow>(suspectSqlKeyed(), [ids])).rows;
    if (suspects.length !== ids.length) {
      console.log(
        `  note: ${ids.length - suspects.length} manifest id(s) no longer satisfy the suspect` +
          ` predicate here — already remediated, or the twin moved. They drop out.`,
      );
    }
  } else {
    console.log("Re-deriving the FIX-930 classification live…  (clone-only path)");
    suspects = (await client.query<SuspectRow>(SUSPECT_SQL)).rows;
  }
  const { boundary, classified } = classify(suspects);
  console.log(
    `  suspects: ${classified.length}   boundary: frac >= ${boundary.fracCut.toFixed(4)} AND shared >= ${boundary.sharedFloor}`,
  );

  const cross = classified.filter((e) => e.branch === "CROSS-PERSON MISATTRIBUTION");
  const kept = cross.filter((e) => !(e.twin_fec_id && EXCLUDED_FEC_IDS.has(e.twin_fec_id)));
  console.log(`  CROSS-PERSON: ${cross.length} suspects, ${kept.length} after by-name exclusions`);

  if (kept.length === 0) {
    console.log("\nNothing to remediate. (Expected on a re-run after --apply.)");
    await client.end();
    return;
  }
  if (kept.length > MAX_SUSPECTS) {
    console.error(`\n✗ ${kept.length} suspects exceeds MAX_SUSPECTS=${MAX_SUSPECTS} — refusing.`);
    await client.end();
    process.exit(1);
  }

  await client.query(`DROP TABLE IF EXISTS _xp; CREATE TEMP TABLE _xp (suspect_id uuid PRIMARY KEY);`);
  for (const e of kept) await client.query(`INSERT INTO _xp VALUES ($1::uuid)`, [e.official_id]);

  console.log("\nDecomposing holdings row-by-row…");
  await client.query(OWNER_SQL);

  const suspectById = new Map(kept.map((e) => [e.official_id, e]));
  const allOwners = await q<OwnerBase>(client, ALL_OWNERS_SQL);
  await client.query(
    `DROP TABLE IF EXISTS _ownrel;
     CREATE TEMP TABLE _ownrel (suspect_id uuid, owner_id uuid, relation text,
                                PRIMARY KEY (suspect_id, owner_id));`,
  );
  let sameOwners = 0;
  for (const o of allOwners) {
    const s = suspectById.get(o.suspect_id);
    if (!s) continue;
    const { relation } = ownerRelation(s, o);
    if (relation === "SAME") sameOwners++;
    await client.query(`INSERT INTO _ownrel VALUES ($1::uuid, $2::uuid, $3)`, [o.suspect_id, o.owner_id, relation]);
  }
  console.log(`  ${allOwners.length} (suspect, owner) pairs — ${sameOwners} SAME-person, ${allOwners.length - sameOwners} CROSS-person`);

  await client.query(ROWHIT_SQL);
  await client.query(ROWCLASS_SQL);

  const splits = await q<SplitRow>(client, SPLIT_SQL);
  const totals = splits.reduce(
    (a, s) => ({
      total: a.total + BigInt(s.total_cents),
      own: a.own + BigInt(s.same_cents),
      cross: a.cross + BigInt(s.cross_cents),
      div: a.div + BigInt(s.div_cents),
      crossRows: a.crossRows + Number(s.cross_rows),
    }),
    { total: 0n, own: 0n, cross: 0n, div: 0n, crossRows: 0 },
  );
  console.log(`\n  total    ${usd(totals.total.toString()).padStart(16)}`);
  console.log(`  OWN      ${usd(totals.own.toString()).padStart(16)}  (kept — FIX-953)`);
  console.log(`  CROSS    ${usd(totals.cross.toString()).padStart(16)}  (${totals.crossRows.toLocaleString()} rows — DELETED here)`);
  console.log(`  DIVERTED ${usd(totals.div.toString()).padStart(16)}  (kept — FIX-952)`);

  if (totals.crossRows === 0) {
    console.log("\nNo CROSS rows to remediate. Nothing to do.");
    await client.end();
    return;
  }

  // FIX-1165 (c) — the cost table, before anything is written.
  printTailTable(declareRemediationTail(defer), defer);

  await client.query("BEGIN");
  try {
    // ── Baselines for the conservation proof ────────────────────────────────
    // FIX-1165 — conservation, KEYED. This used to be PLATFORM_SQL, which
    // aggregates every official donation row on the instance. Measured on prod
    // 2026-09-07 during this script's own --pair dry run: it ran 2m28s for a
    // TWO-OFFICIAL change and was still going when it was cancelled by hand. Its
    // cost is a function of financial_relationships, not of the manifest, so it
    // is the same defect as the platform-scoped tail rebuilds and it hides in
    // the same place -- a step that looks like a safety check rather than work.
    // The invariant is unchanged: a merge MOVES money, so the total resident on
    // the officials in the manifest must not fall except by the collision losers
    // this run deliberately drops.
    const [platformBefore] = await q<{ officials: string; cents: string }>(
      client,
      `SELECT count(DISTINCT fr.to_id)::text            AS officials,
              COALESCE(sum(fr.amount_cents), 0)::text   AS cents
         FROM financial_relationships fr
        WHERE fr.to_type = 'official'
          AND fr.relationship_type = 'donation'
          AND fr.to_id = ANY(ARRAY(
                SELECT suspect_id FROM _xp
                UNION SELECT owner_id FROM _ownrel))`,
    );
    await client.query(`
      CREATE TEMP TABLE _odt_before ON COMMIT DROP AS
        SELECT official_id, total_cents FROM official_donor_totals;
      CREATE UNIQUE INDEX ON _odt_before(official_id);
    `);

    // The exact row set to delete, frozen before anything mutates.
    await client.query(`
      DROP TABLE IF EXISTS _doomed;
      CREATE TEMP TABLE _doomed AS
        SELECT r.row_id, r.suspect_id, r.amount_cents
          FROM _rowclass r WHERE r.class = 'CROSS';
      CREATE UNIQUE INDEX ON _doomed(row_id);
      ANALYZE _doomed;
    `);

    // Officials + donors touched — captured BEFORE the delete, because a DELETE
    // bumps no updated_at and the incremental rollup paths key off it.
    await client.query(`
      DROP TABLE IF EXISTS _affected;
      CREATE TEMP TABLE _affected AS
        SELECT DISTINCT suspect_id AS id FROM _doomed
        UNION
        SELECT DISTINCT h.owner_id FROM _rowhit h JOIN _doomed d ON d.row_id = h.row_id;
      DROP TABLE IF EXISTS _donor;
      CREATE TEMP TABLE _donor AS
        SELECT DISTINCT fr.from_id AS id
          FROM financial_relationships fr
          JOIN _doomed d ON d.row_id = fr.id
         WHERE fr.from_id IS NOT NULL;
      CREATE UNIQUE INDEX ON _donor(id);
    `);

    const [doomedAgg] = await q<{ rows: string; cents: string }>(
      client,
      `SELECT count(*)::text AS rows, COALESCE(sum(amount_cents),0)::text AS cents FROM _doomed`,
    );
    const doomedCents = BigInt(doomedAgg?.cents ?? "0");

    console.log("\nRemediation (rows affected):");

    // 1. FRESHER-WINS: where the suspect's copy is strictly newer than the
    //    owner's counterpart, propagate its value onto the owner BEFORE the
    //    delete, so the fresher aggregate is preserved rather than destroyed.
    //    Scoped to CROSS owners only — an OWN counterpart is never touched.
    //
    //    The set is FROZEN first, with both the old and the new amount, because
    //    the conservation proof needs the delta this introduces and after the
    //    UPDATE the two are equal by construction. DISTINCT ON keeps the
    //    freshest claimant where several suspects collide on one owner row.
    await client.query(`
      DROP TABLE IF EXISTS _refresh;
      CREATE TEMP TABLE _refresh AS
        SELECT DISTINCT ON (o.id)
               o.id            AS owner_row,
               o.amount_cents  AS old_cents,
               s.amount_cents  AS new_cents
          FROM _doomed d
          JOIN financial_relationships s ON s.id = d.row_id
          JOIN _rowhit h                 ON h.row_id = d.row_id
          JOIN _ownrel rel               ON rel.suspect_id = h.suspect_id
                                        AND rel.owner_id   = h.owner_id
                                        AND rel.relation   = 'CROSS'
          JOIN financial_relationships o
            ON o.to_type            = 'official'
           AND o.to_id              = h.owner_id
           AND o.relationship_type  = s.relationship_type
           AND o.from_id            = s.from_id
           AND o.cycle_year         = s.cycle_year
         WHERE s.updated_at    >  o.updated_at
           AND s.amount_cents <>  o.amount_cents
         ORDER BY o.id, s.updated_at DESC;
      CREATE UNIQUE INDEX ON _refresh(owner_row);
    `);
    const [refreshAgg] = await q<{ n: string; delta: string }>(
      client,
      `SELECT count(*)::text AS n, COALESCE(sum(new_cents - old_cents),0)::text AS delta FROM _refresh`,
    );
    const refreshDelta = BigInt(refreshAgg?.delta ?? "0");
    const refreshed = await run(
      client,
      "propagate fresher suspect amount onto owner",
      `UPDATE financial_relationships o
          SET amount_cents = r.new_cents,
              metadata     = COALESCE(o.metadata,'{}'::jsonb)
                             || jsonb_build_object('fix934_refreshed_from_misattributed', true),
              updated_at   = now()
         FROM _refresh r
        WHERE o.id = r.owner_row`,
    );

    // 2. Delete the mis-bound rows.
    const deleted = await run(
      client,
      "FR delete CROSS-person mis-bound rows",
      `DELETE FROM financial_relationships fr USING _doomed d WHERE fr.id = d.row_id`,
    );
    if (deleted !== Number(doomedAgg?.rows ?? 0)) {
      throw new Error(`deleted ${deleted} rows but the manifest froze ${doomedAgg?.rows}`);
    }

    // 3. Retire a role-illegitimate stored fec_id so the slot is not handed
    //    back on the next run. Renamed, never dropped — it is evidence.
    const retireIds = kept
      .filter((e) => e.stored_fec_id && !seatMatches(e.role_title, e.jurisdiction, e.stored_fec_id))
      .map((e) => e.official_id);
    let retired = 0;
    if (retireIds.length > 0) {
      retired = await run(
        client,
        "officials: fec_id → misattributed_fec_id",
        `UPDATE officials o
            SET source_ids = (o.source_ids - 'fec_id')
                           || jsonb_build_object('misattributed_fec_id', o.source_ids->>'fec_id'),
                updated_at = now()
          WHERE o.id = ANY($1::uuid[]) AND o.source_ids ? 'fec_id'`,
        [retireIds],
      );
    }

    // 4. entity_connections money edges into a suspect are now partly false.
    //    Fully derived by rebuild_entity_connections_donations, so the FIX-544
    //    precedent applies: delete-affected, let the Sun/Wed rebuild repopulate.
    await run(
      client,
      "entity_connections delete stale money edges",
      `DELETE FROM entity_connections e
        USING _xp x
        WHERE e.to_type='official' AND e.to_id = x.suspect_id
          AND e.from_type='financial_entity'
          AND e.connection_type::text = ANY($1::text[])`,
      [MONEY_EDGE_TYPES],
    );

    // ── Conservation proof ──────────────────────────────────────────────────
    // FIX-1165 — the same keyed read as the baseline above.
    const [platformAfter] = await q<{ officials: string; cents: string }>(
      client,
      `SELECT count(DISTINCT fr.to_id)::text            AS officials,
              COALESCE(sum(fr.amount_cents), 0)::text   AS cents
         FROM financial_relationships fr
        WHERE fr.to_type = 'official'
          AND fr.relationship_type = 'donation'
          AND fr.to_id = ANY(ARRAY(
                SELECT suspect_id FROM _xp
                UNION SELECT owner_id FROM _ownrel))`,
    );
    const beforeCents = BigInt(platformBefore?.cents ?? "0");
    const afterCents = BigInt(platformAfter?.cents ?? "0");
    const observedDrop = beforeCents - afterCents;
    // The fresher-wins propagation moves value ONTO owner rows, so the platform
    // drop is the deleted sum less whatever those updates added.
    const expectedDrop = doomedCents - refreshDelta;
    const dropDelta = observedDrop - expectedDrop;

    // No official OUTSIDE the affected set may change by a cent.
    const strays = await q<{ official_id: string; full_name: string | null; before_cents: string | null; after_cents: string | null }>(
      client,
      `SELECT COALESCE(b.official_id, a.official_id) AS official_id, o.full_name,
              b.total_cents::text AS before_cents, a.total_cents::text AS after_cents
         FROM _odt_before b
         FULL JOIN official_donor_totals a ON a.official_id = b.official_id
         LEFT JOIN officials o ON o.id = COALESCE(b.official_id, a.official_id)
        WHERE COALESCE(b.total_cents,-1) <> COALESCE(a.total_cents,-1)
          AND COALESCE(b.official_id, a.official_id) NOT IN (SELECT id FROM _affected)
        ORDER BY 1`,
    );

    // OWN and DIVERTED rows must ALL still be resident — that is the whole point.
    const [survivors] = await q<{ own: string; div: string }>(
      client,
      `SELECT count(*) FILTER (WHERE r.class='SAME')::text     AS own,
              count(*) FILTER (WHERE r.class='DIVERTED')::text AS div
         FROM _rowclass r
         JOIN financial_relationships fr ON fr.id = r.row_id`,
    );
    const [expected] = await q<{ own: string; div: string }>(
      client,
      `SELECT count(*) FILTER (WHERE class='SAME')::text AS own,
              count(*) FILTER (WHERE class='DIVERTED')::text AS div FROM _rowclass`,
    );

    console.log("\n── Conservation ─────────────────────────────────────────");
    console.log(`  platform donation dollars: ${usd(beforeCents.toString())} → ${usd(afterCents.toString())}`);
    console.log(`  observed drop:             ${usd(observedDrop.toString())}`);
    console.log(`  deleted CROSS rows:        ${usd(doomedCents.toString())}  (${deleted.toLocaleString()} rows)`);
    console.log(`  fresher-wins propagations: ${refreshed}  (value moved onto owners, net ${usd(refreshDelta.toString())})`);
    console.log(`  difference (must be $0):   ${usd(dropDelta.toString())}  ${dropDelta === 0n ? "OK" : "CHECK"}`);
    console.log(`  OWN rows still resident:      ${survivors?.own} / ${expected?.own}  ${survivors?.own === expected?.own ? "OK" : "FAIL"}`);
    console.log(`  DIVERTED rows still resident: ${survivors?.div} / ${expected?.div}  ${survivors?.div === expected?.div ? "OK" : "FAIL"}`);
    console.log(`  official_donor_totals diffs outside the affected set: ${strays.length}  ${strays.length === 0 ? "OK" : "FAIL"}`);
    for (const s of strays.slice(0, 20)) {
      console.log(`    STRAY ${s.official_id} ${(s.full_name ?? "?").padEnd(28)} ${s.before_cents} → ${s.after_cents}`);
    }
    console.log(`  retired misattributed fec_id on ${retired} official(s)`);

    const ok =
      survivors?.own === expected?.own &&
      survivors?.div === expected?.div &&
      strays.length === 0 &&
      dropDelta === 0n;
    if (!ok) throw new Error("conservation proof FAILED — rolling back (see report above)");

    if (apply) {
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED — ${deleted.toLocaleString()} mis-bound rows removed from ${kept.length} officials.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n✓ DRY-RUN complete — all checks passed, rolled back. Re-run with --apply to commit.`);
      await client.end();
      return;
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n✗ Rolled back due to error:", err instanceof Error ? err.message : String(err));
    await client.end();
    process.exit(1);
  }

  await runRollups(client, prod, defer);
  await runMvsAndVacuum(client, defer);

  console.log(
    "\nSTALE UNTIL THEIR OWN SCHEDULE:\n" +
      "  entity_connections            — twice-weekly rebuild (Sun + Wed 08:00 UTC)\n" +
      "  entity_connection_stats(_mv)  — pg_cron\n" +
      "  browse_facet_counts           — pg_cron",
  );
  await client.end();
}

// Only run when invoked as a script (mirrors mark-killed.ts). Importing this
// module for the FIX-964 unit tests must not open a connection or exit.
if (require.main === module) {
  // FIX-950 — see merge-same-person-official-dupes.ts's tail. The claim stays
  // inside this guard: importing the module for the FIX-964 unit tests must not
  // take a lock any more than it may open a connection.
  runUnderProdSession(
    { script: "remediate-cross-person-misattribution", expectedMinutes: 120 },
    main,
  ).catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
