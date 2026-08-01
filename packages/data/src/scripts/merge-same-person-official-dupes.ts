/**
 * FIX-933 — merge the SAME-PERSON DUPLICATE branch of the FIX-930 audit.
 *
 * WHAT THIS FIXES
 * ---------------
 * `matchRow()` binds a FEC CAND_ID to an official in memory and the writer
 * upserts on `financial_relationships_relcycle_unique`
 * (relationship_type, from_id, to_id, cycle_year). A CHANGED `to_id` therefore
 * writes a NEW row and never retires the old one, so when the `cn{yy}` stage
 * minted a candidate-tier row for a sitting member, that member's FEC money
 * SPLIT across two `officials` rows and has been double-counted ever since.
 * FIX-929 stopped new bad bindings; this script removes the residue for the one
 * branch where removal is mechanical rather than a judgement call — both rows
 * hold the SAME human's money.
 *
 * THE SURVIVOR IS ALWAYS THE ELECTED ROW
 * --------------------------------------
 * Votes, committee memberships, bioguide id, career history, promises, comments,
 * follows and every inbound user-facing link hang off the elected `officials.id`.
 * The candidate-tier row is the one the FEC pipeline minted. So the elected row
 * survives and the FEC identity moves ONTO it — never the other way round. Note
 * this is the OPPOSITE direction from `promote_candidate_to_elected()`, which
 * rewrites elected→candidate because its job is a genuine promotion of a
 * candidate row that has just won a seat. Reusing that RPC here would move a
 * sitting Senator's entire record onto a stub named "T Ossoff".
 *
 * ORDER MATTERS — FEC ID FIRST, MONEY SECOND
 * ------------------------------------------
 * The `cn{yy}` stage mints a candidate row for every FEC CAND_ID that
 * `loadOfficialsByFecIds` does not already resolve. Moving the money while
 * leaving the elected row without `fec_candidate_id` would let the next Sunday
 * run re-mint the candidate row and re-split the money. So:
 *   1. merge `fec_candidate_id` into the survivor's `source_ids`
 *      (the `persistNewFecIds` jsonb-merge shape — writer.ts:953)
 *   2. reconcile the money
 *   3. neutralise the duplicate (zero rows — NOT deleted)
 *
 * COLLISIONS: TAKE THE FRESHER ROW, NEVER SUM
 * -------------------------------------------
 * Every `(relationship_type, from_id, cycle_year)` pair held by BOTH officials
 * collides under the unique index once `to_id` moves. The two rows are the same
 * FEC data written under two bindings, so summing double-counts. Resolved by
 * later `updated_at` (ties keep the duplicate's row — it is the one the current
 * FEC binding refreshes). Shape follows the established asymmetric-FR-merge:
 * pre-delete the losing colliding row, then UPDATE `to_id` on the winner.
 *
 * NO `officials` ROW IS DELETED
 * ----------------------------
 * "Neutralise" means the duplicate ends up holding zero financial_relationships
 * rows, not that it stops existing. That keeps the change fully reversible, keeps
 * every FK intact (career_history, votes, official_committee_memberships,
 * promises, proposal_actions, bill_details.primary_sponsor_id … all NO ACTION or
 * CASCADE off `officials.id`), and keeps this script out of the officials-dedup
 * design question. The leftover $0 candidate stub is filed, not fixed here.
 *
 * THE MANIFEST IS RE-DERIVED LIVE
 * -------------------------------
 * The FIX-930 TSV is the investigation record, not an input. This script re-runs
 * the audit's own classifier (./fec-orphan-classify, shared so the two can never
 * diverge) against whichever env it is pointed at, then re-verifies every pair
 * STRUCTURALLY in SQL and refuses to act on any pair that does not re-qualify:
 *   - survivor tier = 'elected', duplicate tier = 'candidate'
 *   - duplicate carries `fec_candidate_id`, survivor does not
 *   - the CAND_ID's chamber + state describe the seat the survivor actually holds
 *   - no id appears on both sides, no id appears twice
 * The 3 name-decided merge-blockers FIX-930 flagged (jurisdiction disagrees with
 * the state in the CAND_ID — Scott Wiener / Christine Jones / Connie Chan) are
 * excluded by the `stateOk` gate and go to PR 2b.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:merge:official-dupes             # dry-run
 *   pnpm --filter @civitics/data data:merge:official-dupes -- --apply  # commit
 */

import { Client } from "pg";
import {
  type ClassifiedRow,
  classify,
  constructDbUrlFromEnv,
  envLabel,
  PLATFORM_SQL,
  SUSPECT_SQL,
  type SuspectRow,
  usd,
} from "./fec-orphan-classify";

/** Sanity bound — the FIX-930 clone measured 47 eligible pairs. */
const MAX_PAIRS = 200;
/** donor_party_rollup_rebuild_donors chunk size (mirrors the pg_cron proc). */
const DONOR_CHUNK = 5000;

/**
 * entity_connections `connection_type`s derived from financial_relationships
 * with the official on the `to` side. Scoping the stale-edge delete to these
 * keeps the duplicate's vote / appointment / membership edges — which come from
 * a different derivation source and are NOT what this script moved — untouched.
 */
const MONEY_EDGE_TYPES = ["donation", "opposition"];

/**
 * Money-reading materialized views, refreshed via their CONCURRENTLY wrappers.
 *
 * refresh_homepage_stats_mv is NOT concurrent internally and takes a brief
 * (~1s) ACCESS EXCLUSIVE — the same lock refresh-derived-mvs-daily takes at
 * 06:00 UTC, so the read path already absorbs it daily. Drop it if a run ever
 * has to happen during traffic.
 */
const MV_REFRESH_FNS = [
  "refresh_official_sector_dollars_mv",
  "refresh_official_homepage_stats_mv",
  "refresh_homepage_stats_mv",
  "refresh_chord_industry_flows_mv",
  "refresh_chord_donor_type_party_flows_mv",
  "refresh_chord_donor_state_party_flows_mv",
];

/**
 * Tables this run churns hardest. VACUUM cannot go in a transaction and is not
 * cosmetic here: the merge leaves ~260k dead tuples in financial_relationships
 * and ~120k in entity_connections, and FIX-943 established that autovacuum will
 * never reclaim them — its trigger is proportional (50 + 0.2 x reltuples), which
 * on an 8.3M-row table is ~1.66M dead tuples, so ordinary churn sits permanently
 * below the threshold. Leaving them stales the visibility map and kills
 * index-only scans (FIX-884: 34,534 heap fetches on a plan that should do none).
 * Measured: the FIX-930 audit blew its 600s statement_timeout immediately after
 * the merge and completed comfortably once these were vacuumed.
 */
const CHURNED_TABLES = ["financial_relationships", "entity_connections", "officials"];

/**
 * VACUUM only. Split out from the MV refreshes because the two have opposite
 * urgency: every MV in MV_REFRESH_FNS is ALSO refreshed by the 06:00 UTC
 * refresh_derived_mvs('daily') pg_cron job, so skipping them costs nothing —
 * whereas nothing else on the schedule will ever vacuum these tables (FIX-943:
 * autovacuum's trigger is proportional, ~1.66M dead tuples on an 8.3M-row
 * table, and ordinary churn sits permanently below it).
 *
 * That asymmetry matters under degraded I/O: on 2026-07-31 a
 * refresh_homepage_stats_mv() that takes 0.7s on local ran 22 minutes against
 * an otherwise-idle prod and pushed the homepage to 18.5s. The MVs were
 * abandoned to the cron; the vacuums were not, because they have no other owner.
 */
async function runVacuum(client: Client): Promise<void> {
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

/** MV refreshes + VACUUM — the tail of phase 2, separable so it can be resumed alone. */
async function runMvsAndVacuum(client: Client): Promise<void> {
  console.log("\n── Phase 3: materialized views + vacuum ─────────────────");
  for (const fn of MV_REFRESH_FNS) {
    try {
      await step(client, `${fn}()`, `SELECT ${fn}()`);
    } catch (err) {
      console.error(`  ! ${fn}() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await runVacuum(client);
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

/** Run a mutating statement, print + return the affected row count. */
async function run(client: Client, label: string, sql: string, params: unknown[] = []): Promise<number> {
  const t0 = Date.now();
  const res = await client.query(sql, params);
  const n = res.rowCount ?? 0;
  console.log(`  ${label.padEnd(50)} ${String(n).padStart(9)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
}

/** Run a maintenance step for its side effect, printing wall-clock. */
async function step(client: Client, label: string, sql: string, params: unknown[] = []): Promise<void> {
  const t0 = Date.now();
  await client.query(sql, params);
  console.log(`  ${label.padEnd(50)} ${" ".repeat(9)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface Pair {
  survivor: string;
  dup: string;
  fecId: string;
  name: string;
}

/**
 * FIX-955 repair manifest — pairs this script ALREADY merged that a later FEC
 * run re-split.
 *
 * The pipeline was blind to `merged_fec_candidate_id`, so `matchRow` re-matched
 * the retired stub by name and `persistNewFecIds` wrote its claim back; the next
 * cycle pass then wrote money onto it again. FIX-955 closes that hole in the
 * pipeline, but the money already re-split has to be re-merged.
 *
 * This manifest is NOT a heuristic and deliberately does not go through the
 * FIX-930 classifier: every pair here was adjudicated as same-person by a prior
 * run of this very script, and `merged_fec_candidate_id` is that decision
 * recorded on the row. The classifier could not find them anyway — the survivor
 * now carries a valid `fec_candidate_id`, so the FIX-930 suspect predicate
 * (`fec_candidate_id IS NULL`) excludes it, which is the same blind spot as
 * FIX-954.
 *
 * Scoped to duplicates that actually hold money again; a retired stub sitting at
 * zero is already correct and is left alone.
 */
const REPAIR_MANIFEST_SQL = `
-- Aliases are QUOTED to preserve camelCase: these rows are consumed directly as
-- \`Pair\`, and an unquoted \`AS fec_id\` folds to lower case and lands as
-- \`row.fec_id\`, leaving \`p.fecId\` undefined. (Caught by _manifest's NOT NULL
-- on fec_id, which rolled the run back rather than merging on a null id.)
SELECT s.id                                        AS "survivor",
       d.id                                        AS "dup",
       d.source_ids->>'merged_fec_candidate_id'    AS "fecId",
       COALESCE(s.full_name,'?') || '  ←  ' || COALESCE(d.full_name,'?') AS "name"
  FROM officials d
  JOIN officials s
    ON s.tier    = 'elected'
   AND s.id     <> d.id
   AND s.source_ids->>'fec_candidate_id' = d.source_ids->>'merged_fec_candidate_id'
 WHERE d.tier = 'candidate'
   AND d.source_ids ? 'merged_fec_candidate_id'
   -- Only the CLEAN re-claim: the stub took back exactly the id it retired.
   --
   -- Measured 4 stubs that instead re-claimed the same human's OLD HOUSE
   -- CAND_ID while the retired one was their Senate id — Jim Banks
   -- (live H6IN03229 / retired S4IN00196), Ted Budd, Jon Ossoff, Tom Cotton.
   -- Merging those would leave a LIVE second claim on the stub, so the next FEC
   -- run re-binds the House id and re-splits the House-era money again; the
   -- post-merge assertion below correctly refuses that state. Retiring a second
   -- id needs merged_fec_candidate_id to be multi-valued, which is a semantics
   -- change and not part of a repair. Excluded and filed as FIX-956.
   AND d.source_ids->>'fec_candidate_id' = d.source_ids->>'merged_fec_candidate_id'
   AND EXISTS (SELECT 1 FROM financial_relationships fr
                WHERE fr.to_type = 'official' AND fr.to_id = d.id)
 ORDER BY 4;
`;

interface DroppedPair {
  name: string;
  reason: string;
}

/**
 * Re-derive the SAME-PERSON DUPLICATE branch live, then hold it to the
 * structural contract this script's SQL depends on. Anything that fails a gate
 * is DROPPED with a reason rather than silently coerced.
 */
function buildManifest(classified: ClassifiedRow[]): { pairs: Pair[]; dropped: DroppedPair[] } {
  const pairs: Pair[] = [];
  const dropped: DroppedPair[] = [];
  const same = classified.filter((e) => e.branch === "SAME-PERSON DUPLICATE");

  for (const e of same) {
    const label = `${e.full_name} → ${e.twin_name ?? "?"}`;
    // FIX-930's merge-blockers: name-decided but the jurisdiction disagrees with
    // the state in the CAND_ID. A shared name across state lines needs a human.
    if (!e.stateOk) {
      dropped.push({ name: label, reason: "state mismatch (FIX-930 merge-blocker → PR 2b)" });
      continue;
    }
    if (e.tier !== "elected") {
      dropped.push({ name: label, reason: `survivor tier is '${e.tier}', not 'elected'` });
      continue;
    }
    if (e.twin_tier !== "candidate") {
      dropped.push({ name: label, reason: `duplicate tier is '${e.twin_tier}', not 'candidate'` });
      continue;
    }
    if (!e.twin_id || !e.twin_fec_id) {
      dropped.push({ name: label, reason: "duplicate carries no FEC candidate id" });
      continue;
    }
    if (e.twin_id === e.official_id) {
      dropped.push({ name: label, reason: "survivor and duplicate are the same row" });
      continue;
    }
    pairs.push({ survivor: e.official_id, dup: e.twin_id, fecId: e.twin_fec_id, name: label });
  }

  // A row must never be both a survivor and a duplicate, and neither side may
  // repeat — the SQL below assumes a 1:1 mapping and would otherwise resolve a
  // chain in whatever order the planner picked.
  const survivors = new Set(pairs.map((p) => p.survivor));
  const dups = new Set(pairs.map((p) => p.dup));
  const keep: Pair[] = [];
  const survivorSeen = new Map<string, number>();
  const dupSeen = new Map<string, number>();
  for (const p of pairs) {
    survivorSeen.set(p.survivor, (survivorSeen.get(p.survivor) ?? 0) + 1);
    dupSeen.set(p.dup, (dupSeen.get(p.dup) ?? 0) + 1);
  }
  for (const p of pairs) {
    if (dups.has(p.survivor) || survivors.has(p.dup)) {
      dropped.push({ name: p.name, reason: "id appears on both sides of the manifest" });
      continue;
    }
    if ((survivorSeen.get(p.survivor) ?? 0) > 1) {
      dropped.push({ name: p.name, reason: "survivor appears in more than one pair" });
      continue;
    }
    if ((dupSeen.get(p.dup) ?? 0) > 1) {
      dropped.push({ name: p.name, reason: "duplicate appears in more than one pair" });
      continue;
    }
    keep.push(p);
  }
  return { pairs: keep, dropped };
}

/**
 * Repair-mode gate. Same shape as `verifyManifestInDb` but asserts the
 * re-split contract instead of the first-merge one: here the survivor is
 * EXPECTED to already carry `fec_candidate_id` (that is what a completed merge
 * looks like), and the duplicate must still name it in
 * `merged_fec_candidate_id`. Anything else is not a re-split of our own merge
 * and is refused rather than coerced.
 */
async function verifyRepairInDb(
  client: Client,
  pairs: Pair[],
): Promise<{ ok: Pair[]; rejected: DroppedPair[] }> {
  if (pairs.length === 0) return { ok: [], rejected: [] };
  const rows = await q<{
    survivor: string;
    dup: string;
    survivor_tier: string | null;
    dup_tier: string | null;
    survivor_fec: string | null;
    dup_merged: string | null;
    survivor_role: string | null;
    survivor_state: string | null;
  }>(
    client,
    `SELECT m.survivor, m.dup,
            s.tier AS survivor_tier, d.tier AS dup_tier,
            s.source_ids->>'fec_candidate_id'        AS survivor_fec,
            d.source_ids->>'merged_fec_candidate_id' AS dup_merged,
            s.role_title                             AS survivor_role,
            upper(js.short_name)                     AS survivor_state
       FROM _manifest m
       JOIN officials s ON s.id = m.survivor
       JOIN officials d ON d.id = m.dup
       LEFT JOIN jurisdictions js ON js.id = s.jurisdiction_id`,
  );
  const byKey = new Map(rows.map((r) => [`${r.survivor}|${r.dup}`, r]));
  const ok: Pair[] = [];
  const rejected: DroppedPair[] = [];
  for (const p of pairs) {
    const r = byKey.get(`${p.survivor}|${p.dup}`);
    if (!r) {
      rejected.push({ name: p.name, reason: "one of the two officials rows no longer exists" });
      continue;
    }
    if (r.survivor_tier !== "elected" || r.dup_tier !== "candidate") {
      rejected.push({ name: p.name, reason: `live tiers are ${r.survivor_tier}/${r.dup_tier}` });
      continue;
    }
    if (r.survivor_fec !== p.fecId || r.dup_merged !== p.fecId) {
      rejected.push({
        name: p.name,
        reason: `id drift — survivor ${r.survivor_fec}, dup retired ${r.dup_merged}, expected ${p.fecId}`,
      });
      continue;
    }
    // Same seat re-check as the first merge: the CAND_ID must describe the seat
    // the survivor actually holds, so a repair can never move money onto the
    // wrong person even if the marker were somehow wrong.
    const office = p.fecId[0]?.toUpperCase() ?? "";
    const state = p.fecId.slice(2, 4).toUpperCase();
    const role = r.survivor_role ?? "";
    const officeOk =
      (office === "S" && role === "Senator") ||
      (office === "H" && role === "Representative") ||
      (office === "P" && role === "President");
    if (!officeOk || state !== (r.survivor_state ?? "")) {
      rejected.push({
        name: p.name,
        reason: `seat re-check failed (${p.fecId} vs ${role}/${r.survivor_state})`,
      });
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

/**
 * Second gate, server-side: re-read both rows and re-assert the contract against
 * live state rather than against the classifier's in-memory copy. Returns the
 * pairs that still qualify.
 */
async function verifyManifestInDb(
  client: Client,
  pairs: Pair[],
): Promise<{ ok: Pair[]; rejected: DroppedPair[] }> {
  if (pairs.length === 0) return { ok: [], rejected: [] };
  const rows = await q<{
    survivor: string;
    dup: string;
    survivor_tier: string | null;
    dup_tier: string | null;
    survivor_has_fec: boolean;
    dup_fec: string | null;
    survivor_role: string | null;
    survivor_state: string | null;
  }>(
    client,
    `SELECT m.survivor, m.dup,
            s.tier AS survivor_tier, d.tier AS dup_tier,
            (s.source_ids ? 'fec_candidate_id') AS survivor_has_fec,
            d.source_ids->>'fec_candidate_id'   AS dup_fec,
            s.role_title                        AS survivor_role,
            upper(js.short_name)                AS survivor_state
       FROM _manifest m
       JOIN officials s ON s.id = m.survivor
       JOIN officials d ON d.id = m.dup
       LEFT JOIN jurisdictions js ON js.id = s.jurisdiction_id`,
  );
  const byKey = new Map(rows.map((r) => [`${r.survivor}|${r.dup}`, r]));
  const ok: Pair[] = [];
  const rejected: DroppedPair[] = [];
  for (const p of pairs) {
    const r = byKey.get(`${p.survivor}|${p.dup}`);
    if (!r) {
      rejected.push({ name: p.name, reason: "one of the two officials rows no longer exists" });
      continue;
    }
    if (r.survivor_tier !== "elected" || r.dup_tier !== "candidate") {
      rejected.push({ name: p.name, reason: `live tiers are ${r.survivor_tier}/${r.dup_tier}` });
      continue;
    }
    if (r.survivor_has_fec) {
      rejected.push({ name: p.name, reason: "survivor already carries fec_candidate_id" });
      continue;
    }
    if (r.dup_fec !== p.fecId) {
      rejected.push({ name: p.name, reason: `duplicate's live CAND_ID is ${r.dup_fec}, expected ${p.fecId}` });
      continue;
    }
    // Re-assert the seat, server-side, from the CAND_ID itself.
    const office = p.fecId[0]?.toUpperCase() ?? "";
    const state = p.fecId.slice(2, 4).toUpperCase();
    const role = r.survivor_role ?? "";
    const officeOk =
      (office === "S" && role === "Senator") ||
      (office === "H" && role === "Representative") ||
      (office === "P" && role === "President");
    if (!officeOk || state !== (r.survivor_state ?? "")) {
      rejected.push({
        name: p.name,
        reason: `seat re-check failed (${p.fecId} vs ${role}/${r.survivor_state})`,
      });
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

// ---------------------------------------------------------------------------
// Phase 2 — rollups, AFTER commit, chunked and interruptible
//
// Nothing in here is atomic with the money move and nothing needs to be: every
// rollup is a pure function of the committed financial_relationships rows, so a
// run that dies half-way leaves stale rollups, never wrong money. Re-run with
// --rollups-only to finish.
//
// This exists because the first prod attempt held all of it inside the merge
// transaction and exhausted Pro Small's burst I/O — see the comment at the
// former call site.
// ---------------------------------------------------------------------------

/** Per-step wall-clock budget, seconds. Exceeding it aborts the REST of phase 2. */
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
 * Run one step under a HARD server-side ceiling, timed.
 *
 * The budget is enforced by `statement_timeout`, not by measuring afterwards.
 * An earlier version only compared elapsed time once the query returned, which
 * cannot fire on the case that actually matters: a step that never returns.
 * On 2026-07-31 `refresh_official_homepage_stats_mv()` ran 64 minutes against a
 * 20-minute budget and the guard stayed silent the whole time, because the check
 * was downstream of a query that had not finished — the site was at 18.5s and
 * the run had to be killed by hand. Postgres has to own the ceiling.
 *
 * The post-hoc check is kept only to convert a query that finished slowly (but
 * inside its ceiling) into an abort, so a degrading trend stops the run before
 * a later step hits the wall.
 */
async function budgeted(
  client: Client,
  label: string,
  sql: string,
  budgetS: number,
  params: unknown[] = [],
): Promise<void> {
  const t0 = Date.now();
  await client.query(`SET statement_timeout = ${Math.round(budgetS * 1000)}`);
  try {
    await client.query(sql, params);
  } catch (err) {
    // 57014 = query_canceled: the ceiling fired. Report it as a budget overrun
    // rather than an opaque cancellation, so the abort message names the step.
    if ((err as { code?: string })?.code === "57014") {
      throw new BudgetExceeded(
        `${label} hit its ${budgetS}s statement_timeout and was cancelled server-side — ` +
          `prod I/O is degraded, stopping before the remaining work makes it worse`,
      );
    }
    throw err;
  } finally {
    await client.query("SET statement_timeout = 0");
  }
  const s = (Date.now() - t0) / 1000;
  console.log(`  ${label.padEnd(52)} ${s.toFixed(1)}s`);
  if (s > budgetS) {
    throw new BudgetExceeded(
      `${label} took ${s.toFixed(0)}s against a ${budgetS}s budget — prod I/O is degraded, ` +
        `stopping before the remaining rollups make it worse`,
    );
  }
}

async function runRollups(client: Client, prod: boolean): Promise<void> {
  console.log("\n── Phase 2: rollups (post-commit, chunked) ──────────────");

  // Affected officials come from _manifest when the merge just ran, and are
  // re-derived from the committed state when this is a --rollups-only resume:
  // a survivor is an elected row carrying BOTH congress_gov and a
  // fec_candidate_id whose duplicate holds the retired merged_fec_candidate_id.
  await client.query(`
    DROP TABLE IF EXISTS _affected_officials;
    CREATE TEMP TABLE _affected_officials AS
      SELECT survivor AS id FROM _manifest
      UNION
      SELECT dup FROM _manifest;
  `);
  const [offCount] = await q<{ n: string }>(
    client,
    `SELECT count(*)::text AS n FROM _affected_officials`,
  );
  console.log(`  affected officials: ${offCount?.n}`);

  // Donors whose OUTFLOW changed. Read off the survivor side after the move:
  // every deleted loser had a surviving counterpart on the same
  // (relationship_type, from_id, cycle_year) and that counterpart now sits on
  // the survivor, so this set covers donors whose only change was a deletion.
  // The incremental pg_cron paths key off financial_relationships.updated_at
  // and a DELETE bumps nothing, so they would silently skip exactly those.
  await client.query(`
    DROP TABLE IF EXISTS _donor;
    CREATE TEMP TABLE _donor AS
      SELECT DISTINCT fr.from_id AS id
        FROM financial_relationships fr
        JOIN _manifest m ON m.survivor = fr.to_id
       WHERE fr.to_type='official' AND fr.from_id IS NOT NULL;
    CREATE UNIQUE INDEX ON _donor(id);
  `);
  const [donorCount] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _donor`);
  const donors = Number(donorCount?.n ?? 0);
  console.log(`  affected donors:    ${donors.toLocaleString()}`);

  try {
    await budgeted(
      client,
      "donor_rollup_rebuild_recipients(affected)",
      `SELECT donor_rollup_rebuild_recipients(ARRAY(SELECT id FROM _affected_officials))`,
      STEP_BUDGET_S["donor_rollup"]!,
    );
    console.log("    ↳ official_donor_totals, official_donor_rollup_mv,");
    console.log("      official_small_dollar_rollup, official_sector_affinity_rollup,");
    console.log("      treemap_individuals_rollup, official_donor_bracket_totals");

    await budgeted(
      client,
      "rebuild_official_donation_totals()",
      `SELECT rebuild_official_donation_totals()`,
      STEP_BUDGET_S["official_totals"]!,
    );

    // CHUNKED. Unchunked over 105,778 donors this was the step that ran 66+
    // minutes on prod and forced the first attempt to be cancelled. Per-chunk
    // calls commit independently, so an abort here costs one chunk, not the run.
    const feChunks = Math.ceil(donors / DONOR_CHUNK);
    for (let i = 0; i < feChunks; i++) {
      await budgeted(
        client,
        `financial_entity_donation_totals_rebuild ${i + 1}/${feChunks}`,
        `SELECT financial_entity_donation_totals_rebuild(
                  ARRAY(SELECT id FROM _donor ORDER BY id OFFSET $1 LIMIT $2))`,
        STEP_BUDGET_S["fe_totals_chunk"]!,
        [i * DONOR_CHUNK, DONOR_CHUNK],
      );
    }

    const dpChunks = Math.ceil(donors / DONOR_CHUNK);
    for (let i = 0; i < dpChunks; i++) {
      await budgeted(
        client,
        `donor_party_rollup_rebuild_donors ${i + 1}/${dpChunks}`,
        `SELECT donor_party_rollup_rebuild_donors(
                  ARRAY(SELECT id FROM _donor ORDER BY id OFFSET $1 LIMIT $2))`,
        STEP_BUDGET_S["donor_party_chunk"]!,
        [i * DONOR_CHUNK, DONOR_CHUNK],
      );
    }

    // Platform-wide rebuilds. Each carries its own COMMIT, so they were never
    // transaction-safe anyway. Individually caught: a stale one is a stale
    // rollup, not lost data.
    for (const [label, sql] of [
      ["rebuild_financial_entity_ie_totals()", `SELECT rebuild_financial_entity_ie_totals()`],
      ["refresh_group_donor_rollup()", `SELECT refresh_group_donor_rollup()`],
      ["rebuild_entity_search_index()", `SELECT rebuild_entity_search_index()`],
      ["refresh_treemap_individuals_global()", `CALL refresh_treemap_individuals_global()`],
    ] as const) {
      try {
        await budgeted(client, label, sql, STEP_BUDGET_S["heavy"]!);
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        console.error(`  ! ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`    (re-derivable — re-run or let the scheduled refresh pick it up)`);
      }
    }

    for (const fn of MV_REFRESH_FNS) {
      try {
        await budgeted(client, `${fn}()`, `SELECT ${fn}()`, STEP_BUDGET_S["mv"]!);
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        console.error(`  ! ${fn}() failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    console.error(`\n✗ PHASE 2 ABORTED — ${err.message}`);
    console.error(
      `  The money merge is COMMITTED and correct; only rollups are incomplete.\n` +
        `  Resume with:  pnpm --filter @civitics/data data:merge:official-dupes${prod ? ":prod" : ""} -- --rollups-only\n` +
        `  If the expensive rebuilds already finished and only the MV/VACUUM tail is\n` +
        `  outstanding, use --mvs-only instead — it skips ~1.5h of redundant prod I/O.\n` +
        `  Nothing is lost by waiting — the rollups are pure functions of the committed rows.`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rollupsOnly = argv.includes("--rollups-only");
  // Resume the TAIL of phase 2 only. Exists because a run can die (or its host
  // can reboot) after the expensive rebuilds have already committed — re-running
  // --rollups-only then costs ~1.5h of redundant prod I/O to redo work that
  // succeeded, which is precisely the load this script is designed to avoid.
  const mvsOnly = argv.includes("--mvs-only");
  /** VACUUM alone — the only phase-3 step with no other owner on the schedule. */
  const vacuumOnly = argv.includes("--vacuum-only");
  /**
   * FIX-955 — re-merge pairs this script already merged that a later FEC run
   * re-split. Derives its manifest from `merged_fec_candidate_id` instead of
   * from the FIX-930 classifier; see REPAIR_MANIFEST_SQL.
   */
  const repairResplit = argv.includes("--repair-resplit");
  const apply = argv.includes("--apply") || rollupsOnly || mvsOnly || vacuumOnly;
  const allowProd = argv.includes("--allow-prod");
  const prod = isProd();

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  This script DELETES financial_relationships rows and rewrites official money\n" +
        "  attribution. Re-run with --allow-prod only after the local run has been reviewed.",
    );
    process.exit(1);
  }

  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD.");
    process.exit(1);
  }

  console.log(`# FIX-933 — merge SAME-PERSON duplicate officials`);
  console.log(`Env:        ${envLabel()}`);
  console.log(`Connection: ${dbUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(
    `Mode:       ${
      repairResplit
        ? "REPAIR-RESPLIT (FIX-955 re-merge)"
        : vacuumOnly
        ? "VACUUM-ONLY"
        : mvsOnly
        ? "MVS-ONLY (resume phase 2 tail)"
        : rollupsOnly
          ? "ROLLUPS-ONLY (resume phase 2)"
          : apply
            ? "APPLY (COMMIT)"
            : "DRY-RUN (ROLLBACK)"
    }\n`,
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");
  // Local Docker runs /dev/shm at 64MB, so a parallel plan under a chord MV
  // refresh dies with "could not resize shared memory segment". Prod has real
  // shared memory and wants its parallel workers, so this is local-only.
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

  if (vacuumOnly) {
    await runVacuum(client);
    await client.end();
    return;
  }

  if (mvsOnly) {
    await runMvsAndVacuum(client);
    await client.end();
    return;
  }

  // ── --rollups-only: resume phase 2 against already-merged state ──────────
  // Rebuilds _manifest from the committed result rather than from the
  // classifier: after a merge the survivors are no longer attribution orphans,
  // so the FIX-930 suspect query correctly no longer returns them. The durable
  // marker is the pair itself — an elected row carrying congress_gov AND a
  // fec_candidate_id, opposite a candidate row holding that same id retired
  // into merged_fec_candidate_id.
  if (rollupsOnly) {
    await client.query(`
      DROP TABLE IF EXISTS _manifest;
      CREATE TEMP TABLE _manifest AS
        SELECT s.id AS survivor, d.id AS dup, s.source_ids->>'fec_candidate_id' AS fec_id
          FROM officials s
          JOIN officials d
            ON d.tier = 'candidate'
           AND d.source_ids->>'merged_fec_candidate_id' = s.source_ids->>'fec_candidate_id'
         WHERE s.tier = 'elected'
           AND s.source_ids ? 'congress_gov'
           AND s.source_ids ? 'fec_candidate_id';
    `);
    const [n] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _manifest`);
    console.log(`Resuming rollups for ${n?.n} merged pair(s) derived from committed state.\n`);
    if (n?.n === "0") {
      console.error("No merged pairs found — nothing to rebuild. Did the merge actually commit?");
      await client.end();
      process.exit(1);
    }
    await runRollups(client, prod);
    await runMvsAndVacuum(client);
    await client.end();
    return;
  }

  // ── Step 0: duplicate-id reconciliation ─────────────────────────────────
  // Writing fec_candidate_id onto the survivor leaves the SAME id on both rows,
  // and `loadOfficialsByFecIds` (candidates.ts:395) does an unconditional
  // `map.set(candId, …)` while iterating `.order("id")` — LAST WRITE WINS BY
  // ASCENDING UUID. For roughly half of all merged pairs the duplicate sorts
  // second, wins the map slot, and the next Sunday FEC run writes the money
  // straight back onto the candidate row. The merge would silently undo itself.
  //
  // So the duplicate's claim on the CAND_ID has to be retired. It is preserved
  // as `merged_fec_candidate_id` — provenance kept, merge reversible, and the
  // key the read path looks at is unambiguous again. The `cn{yy}` stage will
  // NOT re-mint, because `existingByFecCandId.has(candId)` is satisfied by the
  // survivor.
  //
  // This runs FIRST, unconditionally, in its own transaction: it is the step
  // that makes the whole script resumable. A run interrupted between the money
  // move and this update leaves pairs half-merged, and this predicate — an
  // elected and a candidate row claiming one CAND_ID where the candidate holds
  // NO financial_relationships at all — is exactly "the money already moved but
  // the id was never retired". Anything else is left alone.
  //
  // EXPECTED AND AUTHORISED: this step reconciles MORE pairs than the run's own
  // manifest, and the count differs per environment. It is scoped by the
  // predicate above, NOT by this run's 47 pairs, because narrowing it would mean
  // hardcoding uuids and would leave known-live re-split hazards in place. On
  // the local prod-clone it matched 83 pairs — 47 from that run plus 36 that
  // were ALREADY in this state (the FEC id had been written onto the elected row
  // by some earlier path while the candidate row kept its claim), and 21 of
  // those 36 had the duplicate actively winning the map slot at the time. The
  // extra pairs are the identical defect and the fix is provably lossless: the
  // candidate row holds zero financial_relationships rows, so nothing moves and
  // nothing is lost, the id is preserved as `merged_fec_candidate_id`, and
  // `cn{yy}` cannot re-mint because the elected row satisfies
  // `existingByFecCandId.has(candId)`. A prod count well above the prod manifest
  // size is therefore the expected outcome, not a signal to stop. Pairs where
  // the candidate row STILL holds money are deliberately refused — those need
  // the money decision first (FIX-934 / FIX-935).
  const reconcileSql = `
    UPDATE officials d
       SET source_ids = (d.source_ids - 'fec_candidate_id')
                      || jsonb_build_object('merged_fec_candidate_id',
                                            d.source_ids->>'fec_candidate_id'),
           updated_at = now()
      FROM officials s
     WHERE d.tier = 'candidate'
       AND s.tier = 'elected'
       AND s.id <> d.id
       AND d.source_ids->>'fec_candidate_id' IS NOT NULL
       AND s.source_ids->>'fec_candidate_id' = d.source_ids->>'fec_candidate_id'
       AND NOT EXISTS (SELECT 1 FROM financial_relationships fr
                        WHERE fr.to_type = 'official' AND fr.to_id = d.id)`;
  // Step 0 is skipped in repair mode: its predicate requires the duplicate to
  // hold NO money, which is precisely the opposite of the state being repaired,
  // so it would be a no-op that commits outside the repair transaction.
  if (!repairResplit) {
    await client.query("BEGIN");
    const reconciled = await run(client, "retire duplicate claim on CAND_ID", reconcileSql);
    if (apply) {
      await client.query("COMMIT");
      if (reconciled > 0) console.log(`  ↳ committed (${reconciled} already-merged duplicates finished)`);
    } else {
      await client.query("ROLLBACK");
      if (reconciled > 0) {
        console.log(`  ↳ ${reconciled} already-merged duplicate(s) still claim their CAND_ID — --apply retires it`);
      }
    }
  }

  // ── Derive the manifest (read-only, outside the merge txn) ────────────────
  let candidates: Pair[];
  if (repairResplit) {
    await client.query("BEGIN TRANSACTION READ ONLY");
    candidates = await q<Pair>(client, REPAIR_MANIFEST_SQL);
    await client.query("COMMIT");
    console.log(
      `\nFIX-955 repair → ${candidates.length} previously-merged pair(s) hold money on the ` +
        `retired stub again`,
    );
    for (const p of candidates) console.log(`  RE-MERGE ${p.name.padEnd(52)} ${p.fecId}`);
  } else {
    console.log("\nRe-deriving the FIX-930 classification live…");
    await client.query("BEGIN TRANSACTION READ ONLY");
    const suspects = (await client.query<SuspectRow>(SUSPECT_SQL)).rows;
    await client.query("COMMIT");
    const { boundary, classified } = classify(suspects);
    console.log(`  suspects: ${classified.length}   boundary: frac >= ${boundary.fracCut.toFixed(4)} AND shared >= ${boundary.sharedFloor}`);
    for (const b of ["CROSS-PERSON MISATTRIBUTION", "SAME-PERSON DUPLICATE", "UNIQUE HOLDER"]) {
      const n = classified.filter((e) => e.branch === b).length;
      console.log(`  ${b.padEnd(28)} ${String(n).padStart(4)}`);
    }

    const built = buildManifest(classified);
    candidates = built.pairs;
    console.log(`\nSAME-PERSON DUPLICATE → ${candidates.length} pairs pass the client-side gates`);
    for (const d of built.dropped) console.log(`  DROPPED  ${d.name.padEnd(50)} ${d.reason}`);
  }

  if (candidates.length === 0) {
    console.log("\nNothing to merge. (If this is a re-run after --apply, that is the expected result.)");
    await client.end();
    return;
  }
  if (candidates.length > MAX_PAIRS) {
    console.error(`\n✗ ${candidates.length} pairs exceeds MAX_PAIRS=${MAX_PAIRS} — refusing to run.`);
    await client.end();
    process.exit(1);
  }

  await client.query("BEGIN");
  try {
    // NOT `ON COMMIT DROP` — phase 2 runs after COMMIT and needs the manifest
    // to scope its rollup rebuilds. Session-scoped, so it still disappears when
    // the connection closes.
    await client.query(`
      DROP TABLE IF EXISTS _manifest;
      CREATE TEMP TABLE _manifest (survivor uuid PRIMARY KEY, dup uuid UNIQUE, fec_id text NOT NULL);
    `);
    for (const p of candidates) {
      await client.query(`INSERT INTO _manifest VALUES ($1::uuid, $2::uuid, $3::text)`, [
        p.survivor,
        p.dup,
        p.fecId,
      ]);
    }

    const { ok: pairs, rejected } = repairResplit
      ? await verifyRepairInDb(client, candidates)
      : await verifyManifestInDb(client, candidates);
    for (const r of rejected) console.log(`  REJECTED ${r.name.padEnd(50)} ${r.reason}`);
    if (rejected.length > 0) {
      await client.query(
        `DELETE FROM _manifest WHERE survivor <> ALL($1::uuid[])`,
        [pairs.map((p) => p.survivor)],
      );
    }
    if (pairs.length === 0) {
      console.log("\nNo pair survived the server-side re-check. Rolling back.");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }
    console.log(`\nManifest: ${pairs.length} pairs confirmed against live state.`);

    // ── Baselines for the conservation proof ─────────────────────────────
    // Snapshot official_donor_totals WHOLE so an unexpected change anywhere on
    // the platform is a stop condition, not just an unnoticed side effect.
    await client.query(`
      CREATE TEMP TABLE _odt_before ON COMMIT DROP AS
        SELECT official_id, total_cents, pac_cents, individual_cents, donor_count
          FROM official_donor_totals;
      CREATE UNIQUE INDEX ON _odt_before(official_id);
    `);
    const [platformBefore] = await q<{ officials: string; cents: string }>(client, PLATFORM_SQL);

    await client.query(`
      CREATE TEMP TABLE _pair_before ON COMMIT DROP AS
        SELECT m.survivor, m.dup,
               COALESCE((SELECT sum(amount_cents) FROM financial_relationships fr
                          WHERE fr.to_type='official' AND fr.relationship_type='donation'
                            AND fr.to_id = m.survivor), 0)::bigint AS surv_donation_cents,
               COALESCE((SELECT sum(amount_cents) FROM financial_relationships fr
                          WHERE fr.to_type='official' AND fr.relationship_type='donation'
                            AND fr.to_id = m.dup), 0)::bigint      AS dup_donation_cents
          FROM _manifest m;
    `);

    // ── Colliding pairs — resolve by later updated_at ────────────────────
    // Keyed on (relationship_type, from_id, cycle_year) because that plus to_id
    // IS financial_relationships_relcycle_unique. `=` not IS NOT DISTINCT FROM:
    // the index is NULLS DISTINCT, so NULL-keyed rows do not actually collide.
    // (Measured 0 NULL from_id / cycle_year in this population.)
    await client.query(`
      CREATE TEMP TABLE _collision ON COMMIT DROP AS
        SELECT s.relationship_type,
               s.id AS surv_row, d.id AS dup_row,
               s.updated_at AS surv_upd, d.updated_at AS dup_upd,
               s.amount_cents AS surv_cents, d.amount_cents AS dup_cents,
               (d.updated_at >= s.updated_at) AS keep_dup
          FROM _manifest m
          JOIN financial_relationships s
            ON s.to_type='official' AND s.to_id = m.survivor
          JOIN financial_relationships d
            ON d.to_type='official' AND d.to_id = m.dup
           AND d.relationship_type = s.relationship_type
           AND d.from_id           = s.from_id
           AND d.cycle_year        = s.cycle_year;
      CREATE INDEX ON _collision(surv_row);
      CREATE INDEX ON _collision(dup_row);
    `);
    const collisions = await q<{
      relationship_type: string;
      pairs: string;
      dup_fresher: string;
      surv_fresher: string;
      ties: string;
      loser_cents: string;
    }>(
      client,
      `SELECT relationship_type,
              count(*)::text                                        AS pairs,
              count(*) FILTER (WHERE dup_upd > surv_upd)::text      AS dup_fresher,
              count(*) FILTER (WHERE dup_upd < surv_upd)::text      AS surv_fresher,
              count(*) FILTER (WHERE dup_upd = surv_upd)::text      AS ties,
              COALESCE(sum(CASE WHEN keep_dup THEN surv_cents ELSE dup_cents END), 0)::text AS loser_cents
         FROM _collision GROUP BY 1 ORDER BY 1`,
    );
    console.log("\nColliding (relationship_type, from_id, cycle_year) pairs — keep the fresher row:");
    console.log(`  ${"type".padEnd(14)}${"pairs".padStart(9)}${"dup+".padStart(9)}${"surv+".padStart(9)}${"ties".padStart(7)}   loser dollars`);
    let deletedDonationCents = 0n;
    for (const c of collisions) {
      console.log(
        `  ${c.relationship_type.padEnd(14)}${c.pairs.padStart(9)}${c.dup_fresher.padStart(9)}` +
          `${c.surv_fresher.padStart(9)}${c.ties.padStart(7)}   ${usd(c.loser_cents)}`,
      );
      if (c.relationship_type === "donation") deletedDonationCents = BigInt(c.loser_cents);
    }

    // ── The merge ───────────────────────────────────────────────────────
    console.log("\nMerge (rows affected):");

    // 1. FEC identity onto the survivor FIRST — otherwise the next cn{yy} run
    //    re-mints the candidate row and re-splits the money. Same server-side
    //    jsonb-merge shape as persistNewFecIds (writer.ts:953), so a concurrent
    //    writer's source_ids keys are not clobbered.
    await run(client, "officials.source_ids += fec_candidate_id", `
      UPDATE officials o
         SET source_ids = COALESCE(o.source_ids, '{}'::jsonb)
                        || jsonb_build_object('fec_candidate_id', m.fec_id),
             updated_at = now()
        FROM _manifest m
       WHERE o.id = m.survivor`);

    // Any role-prefix-matching `fec_id` the duplicate happens to carry moves
    // too (0 rows on the FIX-930 clone — the duplicates carry only
    // fec_candidate_id — but the branch exists so a future env is handled).
    await run(client, "officials.source_ids += fec_id (prefix-matched)", `
      UPDATE officials o
         SET source_ids = COALESCE(o.source_ids, '{}'::jsonb)
                        || jsonb_build_object('fec_id', d.source_ids->>'fec_id'),
             updated_at = now()
        FROM _manifest m
        JOIN officials d ON d.id = m.dup
       WHERE o.id = m.survivor
         AND d.source_ids->>'fec_id' IS NOT NULL
         AND NOT (o.source_ids ? 'fec_id')
         AND ((o.role_title = 'Senator'        AND upper(left(d.source_ids->>'fec_id',1)) = 'S')
           OR (o.role_title = 'Representative' AND upper(left(d.source_ids->>'fec_id',1)) = 'H'))`);

    // 2a. Delete the losing side of each collision. Never a bare DELETE of one
    //     side — the loser is whichever row is STALER.
    await run(client, "FR delete colliding losers (survivor side)", `
      DELETE FROM financial_relationships fr
       USING _collision c
       WHERE fr.id = c.surv_row AND c.keep_dup`);
    await run(client, "FR delete colliding losers (duplicate side)", `
      DELETE FROM financial_relationships fr
       USING _collision c
       WHERE fr.id = c.dup_row AND NOT c.keep_dup`);

    // 2b. Everything still on the duplicate moves to the survivor. This is now
    //     collision-free by construction: survivor-side colliders whose
    //     duplicate row won are gone, and duplicate-side rows that lost are
    //     gone. Covers donation AND ie_support / ie_oppose in one statement —
    //     the IE money is split across these pairs too (Ossoff's candidate row
    //     carries 2020 ie_oppose the elected row never had).
    const moved = await run(client, "FR move to_id → survivor (all types)", `
      UPDATE financial_relationships fr
         SET to_id = m.survivor
        FROM _manifest m
       WHERE fr.to_type = 'official' AND fr.to_id = m.dup`);

    // 3. Neutralise the duplicate. The officials ROW stays; it just holds no
    //    money. rebuild_official_donation_totals() only UPDATEs officials that
    //    still have an aggregate row, so a duplicate that just dropped to zero
    //    would otherwise keep its stale total forever.
    await run(client, "officials.total_received_cents = 0 (duplicates)", `
      UPDATE officials o SET total_received_cents = 0, updated_at = now()
        FROM _manifest m
       WHERE o.id = m.dup AND o.total_received_cents <> 0`);
    await run(client, "official_donor_totals delete (duplicates)", `
      DELETE FROM official_donor_totals t USING _manifest m WHERE t.official_id = m.dup`);

    const [leftover] = await q<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM financial_relationships fr
        JOIN _manifest m ON m.dup = fr.to_id WHERE fr.to_type='official'`,
    );
    if (leftover?.n !== "0") {
      throw new Error(`duplicate side still holds ${leftover?.n} financial_relationships rows`);
    }

    // Retire the duplicate's claim on the CAND_ID now that its money is gone —
    // same statement as step 0, run here so a fresh pair is finished in ONE
    // pass. Without it `loadOfficialsByFecIds` would resolve the CAND_ID back to
    // the duplicate on ~half of pairs (last-write-wins by ascending uuid) and
    // the next FEC run would re-split the money. See step 0's comment.
    await run(client, "retire duplicate claim on CAND_ID", reconcileSql);
    const [ambiguous] = await q<{ n: string }>(
      client,
      `SELECT count(*)::text AS n
         FROM _manifest m
         JOIN officials d ON d.id = m.dup
        WHERE d.source_ids ? 'fec_candidate_id'`,
    );
    if (ambiguous?.n !== "0") {
      throw new Error(
        `${ambiguous?.n} duplicate(s) still claim their CAND_ID — the merge would be undone by the next FEC run`,
      );
    }

    // 4. entity_connections money edges pointing at a duplicate are now
    //    provably false (that official holds no money). They are fully derived
    //    by rebuild_entity_connections_donations, so the FIX-544 precedent
    //    applies: delete-affected and let the scheduled rebuild repopulate the
    //    survivor. The survivor's own edges are left alone — understated until
    //    the next Sun/Wed rebuild, but never wrong.
    await run(
      client,
      "entity_connections delete stale money edges (dup)",
      `DELETE FROM entity_connections e
        USING _manifest m
        WHERE e.to_type='official' AND e.to_id = m.dup
          AND e.from_type='financial_entity'
          AND e.connection_type::text = ANY($1::text[])`,
      [MONEY_EDGE_TYPES],
    );

    // ── Rollups do NOT run here ──────────────────────────────────────────
    // They used to. On prod that made ONE transaction hold ~2 hours of
    // sustained write I/O, which exhausted Pro Small's burst credits: the
    // homepage went to 18.7s, a count(*) on a 31k-row table passed 600s, and
    // financial_entity_donation_totals_rebuild alone ran 66+ minutes against
    // the 10 it took in the rehearsal. The run had to be cancelled server-side.
    //
    // Atomicity was never the reason they were in here — the money move is what
    // needs to be all-or-nothing, and it is ~12 minutes. The rollups are all
    // re-derivable from the committed money, several already chunk-and-commit
    // internally, and holding them inside the transaction bought nothing while
    // pinning I/O and blocking vacuum for the whole duration. They now run in
    // phase 2, after COMMIT, chunked and interruptible. See runRollups().
    //
    // The read path therefore sees merged money with briefly stale rollups
    // rather than a half-merged state — which is the same window the twice-
    // weekly entity_connections rebuild already leaves, and far better than an
    // I/O-starved site.

    // Materialized views moved to phase 3 for the same reason as the rollups.
    // They also can no longer be proven in-transaction: they read the rollups,
    // and the rollups no longer run before COMMIT, so an in-txn refresh would
    // just materialize pre-merge rollup contents. Honest consequence of the
    // split — the dry run proves the MONEY, which is the part that must be
    // right the first time.

    // ── Conservation proof, both directions ─────────────────────────────
    const [platformAfter] = await q<{ officials: string; cents: string }>(client, PLATFORM_SQL);
    const beforeCents = BigInt(platformBefore?.cents ?? "0");
    const afterCents = BigInt(platformAfter?.cents ?? "0");
    const observedDrop = beforeCents - afterCents;
    const dropDelta = observedDrop - deletedDonationCents;

    // No official OUTSIDE the manifest may change by a single cent.
    const strays = await q<{
      official_id: string;
      full_name: string | null;
      before_cents: string | null;
      after_cents: string | null;
    }>(
      client,
      `SELECT COALESCE(b.official_id, a.official_id) AS official_id,
              o.full_name,
              b.total_cents::text AS before_cents,
              a.total_cents::text AS after_cents
         FROM _odt_before b
         FULL JOIN official_donor_totals a ON a.official_id = b.official_id
         LEFT JOIN officials o ON o.id = COALESCE(b.official_id, a.official_id)
        WHERE COALESCE(b.total_cents, -1) <> COALESCE(a.total_cents, -1)
          AND COALESCE(b.official_id, a.official_id) NOT IN (
                SELECT survivor FROM _manifest UNION SELECT dup FROM _manifest)
        ORDER BY 1`,
    );

    // Per-pair before/after, so the reference case is checkable by eye.
    const report = await q<{
      full_name: string;
      surv_before: string;
      dup_before: string;
      surv_after: string;
      dup_after: string;
    }>(
      client,
      `SELECT o.full_name,
              pb.surv_donation_cents::text AS surv_before,
              pb.dup_donation_cents::text  AS dup_before,
              COALESCE((SELECT sum(amount_cents) FROM financial_relationships fr
                         WHERE fr.to_type='official' AND fr.relationship_type='donation'
                           AND fr.to_id = pb.survivor), 0)::text AS surv_after,
              COALESCE((SELECT sum(amount_cents) FROM financial_relationships fr
                         WHERE fr.to_type='official' AND fr.relationship_type='donation'
                           AND fr.to_id = pb.dup), 0)::text      AS dup_after
         FROM _pair_before pb JOIN officials o ON o.id = pb.survivor
        ORDER BY pb.surv_donation_cents + pb.dup_donation_cents DESC`,
    );

    console.log("\nPer-pair donation dollars (survivor before + duplicate before → survivor after):");
    console.log(`  ${"official".padEnd(26)}${"surv before".padStart(15)}${"dup before".padStart(15)}${"surv after".padStart(15)}${"dup after".padStart(12)}`);
    for (const r of report) {
      console.log(
        `  ${(r.full_name ?? "").slice(0, 25).padEnd(26)}${usd(r.surv_before).padStart(15)}` +
          `${usd(r.dup_before).padStart(15)}${usd(r.surv_after).padStart(15)}${usd(r.dup_after).padStart(12)}`,
      );
    }

    const sumBefore = report.reduce((s, r) => s + BigInt(r.surv_before) + BigInt(r.dup_before), 0n);
    const sumAfter = report.reduce((s, r) => s + BigInt(r.surv_after) + BigInt(r.dup_after), 0n);

    console.log("\n── Conservation ─────────────────────────────────────────");
    console.log(`  platform donation dollars on officials: ${usd(beforeCents.toString())} → ${usd(afterCents.toString())}`);
    console.log(`  observed drop:                          ${usd(observedDrop.toString())}`);
    console.log(`  deleted colliding losers:               ${usd(deletedDonationCents.toString())}`);
    console.log(`  difference (must be $0):                ${usd(dropDelta.toString())}  ${dropDelta === 0n ? "OK" : "FAIL"}`);
    console.log(`  manifest pair dollars:                  ${usd(sumBefore.toString())} → ${usd(sumAfter.toString())}`);
    console.log(`  FR rows moved onto survivors:           ${moved.toLocaleString()}`);
    console.log(`  duplicates still holding money:         0  OK`);
    console.log(`  official_donor_totals diffs outside the manifest: ${strays.length}  ${strays.length === 0 ? "OK" : "FAIL"}`);
    for (const s of strays.slice(0, 20)) {
      console.log(`    STRAY ${s.official_id} ${(s.full_name ?? "?").padEnd(28)} ${s.before_cents} → ${s.after_cents}`);
    }

    const dropOk = dropDelta === 0n;
    const strayOk = strays.length === 0;
    const pairOk = sumAfter === sumBefore - deletedDonationCents;
    console.log(`  manifest pair conservation:             ${pairOk ? "OK" : "FAIL"}`);

    if (!dropOk || !strayOk || !pairOk) {
      throw new Error("conservation proof FAILED — rolling back (see report above)");
    }

    if (apply) {
      for (const t of ["financial_relationships", "officials", "official_donor_totals", "entity_connections"]) {
        await client.query(`ANALYZE public.${t}`);
      }
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED — ${pairs.length} pairs merged.`);
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

  await runRollups(client, prod);
  await runMvsAndVacuum(client);

  console.log(
    "\nSTALE UNTIL THEIR OWN SCHEDULE (not rebuildable here at reasonable cost):\n" +
      "  entity_connections            — twice-weekly rebuild (Sun + Wed 08:00 UTC)\n" +
      "  entity_connection_stats(_mv)  — pg_cron, derived from entity_connections\n" +
      "  browse_facet_counts           — pg_cron",
  );
  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
