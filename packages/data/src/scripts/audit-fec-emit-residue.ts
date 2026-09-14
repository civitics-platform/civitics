/**
 * FIX-1106 — the emit-set anti-join. Builds a MANIFEST. Deletes nothing.
 *
 *   pnpm --filter @civitics/data data:audit:fec-residue        -- --cycle 2026
 *   pnpm --filter @civitics/data data:audit:fec-residue:prod   -- --cycle 2026
 *
 * WHAT IT ANSWERS. For one (cycle_year, source) slice of financial_relationships,
 * which rows did the newest COMPLETE run not emit? Those rows are recipient-set
 * residue: an upsert-only replay cannot shrink a set, so anything the writers
 * stopped emitting to still stands and is still summed by officials'
 * total_received_cents, official_donor_totals, the donor rollup MV, the treemap
 * brackets and the graph money branch.
 *
 * WHY IT REFUSES. Two guards, both of which can fire, and neither is decorative:
 *
 *   (1) complete_at IS NULL — the run was killed, or is mid-resume, or its
 *       watermark persist failed. Its emit set is a PREFIX of the true set, and
 *       anti-joining a prefix classifies live rows as residue. There is no safe
 *       partial answer here, so there is no --force.
 *
 *   (2) recorded key count != keys actually present. fec_emit_keys is UNLOGGED,
 *       so crash recovery truncates it. Prod crash-recovered on 2026-09-08
 *       15:12 UTC. If the ledger survived and the keys did not, every row in the
 *       slice would look like residue — the largest possible wrong answer. The
 *       count cross-check turns that into a refusal.
 *
 * OUTPUT is per-RECIPIENT, because FIX-1106 measured the residue as
 * per-recipient and not per-donor (Ossoff reproduces the harness exactly: zero
 * residue on a large recipient). Each recipient carries a class:
 *
 *   DROPPED-OUT — the run emitted ZERO rows to this recipient. This is the
 *                 population FIX-1106 sized at 3,416 recipients / 209,017 rows /
 *                 $1,481,928,516, and the only class the apply sweeps by default.
 *   PARTIAL     — the run emitted SOME rows to this recipient and not these.
 *                 Listed, never swept by default: a recipient the writers still
 *                 resolve is one whose per-donor set legitimately shrank, and
 *                 that is a different claim needing its own evidence.
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { constructDbUrlFromEnv, envLabel, usd } from "./fec-orphan-classify";

const SOURCES = ["fec_bulk_indiv", "fec_bulk_indiv_to_committee", "fec_bulk_pac"] as const;
type Source = (typeof SOURCES)[number];

export interface EmitRun {
  run_id: string;
  cycle_year: number;
  source: Source;
  started_at: string;
  complete_at: string | null;
  keys: string;
  /** FIX-1184 — set when a later begin() replaced this never-completed run. */
  superseded_at: string | null;
}

interface ResidueRow {
  to_type: string;
  to_id: string;
  name: string;
  rows: string;
  cents: string;
  last_write: string;
  emitted: string;
}

async function q<T>(client: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await client.query(sql, params);
  return res.rows as T[];
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`FAIL ${flag} needs a value.`);
    process.exit(1);
  }
  return v;
}

/** What the guard decided about a slice's run history. */
export type RunVerdict =
  | { kind: "use"; run: EmitRun }
  | { kind: "none" }
  | { kind: "refuse"; reason: "incomplete" | "superseded-prefix"; run: EmitRun };

/**
 * Guard 1 — which run's emit set may this slice be judged against.
 *
 * Newest by started_at, NOT "newest complete", and that has not changed: an
 * older set's absences are last week's answer, and acting on them would delete
 * rows this week's run legitimately re-emitted. What FIX-1184 changes is only
 * the VOCABULARY — the walk can now tell two things apart that both used to
 * read as "newest row is incomplete, refuse":
 *
 *   complete_at set                 -> use it.
 *   superseded_at set AND keys = 0  -> SKIP. A later begin() replaced a run that
 *                                      had emitted nothing, so it is not a
 *                                      prefix of anything and cannot hide a
 *                                      re-emit. Keep walking.
 *   superseded_at set AND keys > 0  -> REFUSE, naming the run and its count. A
 *                                      prefix WAS written after the last
 *                                      complete set, which is exactly the case
 *                                      "newest, not newest-complete" exists for.
 *   neither set                     -> REFUSE. In flight, or killed and not yet
 *                                      superseded by a later begin().
 *
 * The rows must arrive newest-first.
 */
export function resolveEmitRun(rowsNewestFirst: readonly EmitRun[]): RunVerdict {
  for (const run of rowsNewestFirst) {
    if (run.complete_at !== null) return { kind: "use", run };
    if (run.superseded_at !== null) {
      if (Number(run.keys) > 0) return { kind: "refuse", reason: "superseded-prefix", run };
      continue;
    }
    return { kind: "refuse", reason: "incomplete", run };
  }
  return { kind: "none" };
}

async function resolveRun(client: Client, cycle: number, source: Source): Promise<RunVerdict> {
  const rows = await q<EmitRun>(
    client,
    `SELECT run_id::text, cycle_year, source, started_at::text, complete_at::text,
            keys::text, superseded_at::text
       FROM public.fec_emit_runs
      WHERE cycle_year = $1 AND source = $2
      ORDER BY started_at DESC`,
    [cycle, source],
  );
  return resolveEmitRun(rows);
}

/**
 * The anti-join.
 *
 * THE PLAN, MEASURED rather than assumed (local clone, 2026-09-09, cycle-2026
 * fec_bulk_indiv: 852,502 slice rows against an 852,194-key emit set, 2.3 s):
 *
 *   financial_relationships  ->  Bitmap Index Scan on financial_relationships_cycle
 *   fec_emit_keys            ->  Seq Scan, feeding a Hash Anti Join
 *
 * The FR side is the one that matters and it is keyed — no Seq Scan on
 * financial_relationships, which --explain asserts. The emit side is NOT the
 * per-row index probe the fec_emit_keys_slice_idx was built for, and that is the
 * planner being right rather than wrong: when the probe set is most of the emit
 * set, hashing it once beats 852k index lookups. The index still earns its place
 * on the apply's keyed re-check, where the probe is `to_id = ANY(<manifest>)` and
 * the candidate set is a few hundred rows rather than the whole slice.
 *
 * Re-check the plan on prod before the apply; a slice several times this size can
 * move the choice, and the guarantee being asserted is the FR side either way.
 */
export const RESIDUE_SQL = `
  WITH residue AS (
    SELECT fr.to_type, fr.to_id, fr.amount_cents, fr.updated_at
      FROM public.financial_relationships fr
     WHERE fr.cycle_year = $2
       AND fr.metadata->>'source' = $3
       AND NOT EXISTS (
             SELECT 1 FROM public.fec_emit_keys k
              WHERE k.run_id            = $1
                AND k.cycle_year        = fr.cycle_year
                AND k.source            = $3
                AND k.relationship_type = fr.relationship_type
                AND k.to_type           = fr.to_type
                AND k.to_id             = fr.to_id
                AND k.from_id           = fr.from_id
           )
  ),
  emitted AS (
    SELECT to_type, to_id, count(*)::bigint AS n
      FROM public.fec_emit_keys
     WHERE run_id = $1 AND cycle_year = $2 AND source = $3
     GROUP BY to_type, to_id
  )
  SELECT r.to_type,
         r.to_id::text,
         coalesce(o.full_name, fe.canonical_name, '(unnamed)') AS name,
         count(*)::text                    AS rows,
         sum(r.amount_cents)::text         AS cents,
         max(r.updated_at)::text           AS last_write,
         coalesce(max(e.n), 0)::text       AS emitted
    FROM residue r
    LEFT JOIN emitted e                    ON e.to_type = r.to_type AND e.to_id = r.to_id
    LEFT JOIN public.officials o           ON r.to_type = 'official'         AND o.id  = r.to_id
    LEFT JOIN public.financial_entities fe ON r.to_type = 'financial_entity' AND fe.id = r.to_id
   GROUP BY r.to_type, r.to_id, o.full_name, fe.canonical_name
   ORDER BY sum(r.amount_cents) DESC`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const prod = envLabel() === "prod";
  const cycle = Number(arg(argv, "--cycle") ?? "2026");
  const source = (arg(argv, "--source") ?? "fec_bulk_indiv") as Source;
  const explain = argv.includes("--explain");
  const outDir = arg(argv, "--out-dir") ?? path.join("docs", "audits");

  if (!SOURCES.includes(source)) {
    console.error(`FAIL --source must be one of ${SOURCES.join(", ")}`);
    process.exit(1);
  }
  if (prod && !argv.includes("--allow-prod")) {
    console.error("FAIL prod requires --allow-prod. This is a keyed READ, but say so explicitly.");
    process.exit(1);
  }

  const client = new Client({ connectionString: constructDbUrlFromEnv() });
  await client.connect();
  // Local Docker runs Postgres with /dev/shm capped at 64 MB, so a parallel
  // Gather over a slice this size dies with 53100 "could not resize shared
  // memory segment". Prod has room and keeps its parallel plan; this is a
  // local-only accommodation and must not change the plan the prod run gets.
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

  try {
    console.log(`\n-- FIX-1106 emit-set residue audit -- ${envLabel()} -- cycle ${cycle} / ${source} --\n`);

    // -- Guard 1: resolve which run may judge this slice (FIX-1184) ----------
    const verdict = await resolveRun(client, cycle, source);
    if (verdict.kind === "none") {
      console.error(
        `REFUSING -- no usable fec_emit_runs row for (cycle ${cycle}, ${source}).\n` +
          `  Nothing has recorded a complete emit set for this slice yet. The first prod run\n` +
          `  to write one is the next complete fec-phase (or a drop-probe-triggered run).`,
      );
      process.exit(2);
    }
    if (verdict.kind === "refuse" && verdict.reason === "incomplete") {
      console.error(
        `REFUSING -- the newest run for this slice is NOT complete.\n` +
          `  run_id ${verdict.run.run_id}  started_at ${verdict.run.started_at}  complete_at NULL\n` +
          `  An incomplete run's emit set is a PREFIX of the true set: it was killed, is\n` +
          `  mid-resume, or its FIX-754 watermark persist failed. Anti-joining a prefix\n` +
          `  classifies live rows as residue, so there is no --force for this.\n` +
          `  Wait for a run that reaches the FIX-754 clear path for cycle ${cycle}.`,
      );
      process.exit(2);
    }
    if (verdict.kind === "refuse" && verdict.reason === "superseded-prefix") {
      console.error(
        `REFUSING -- a SUPERSEDED run for this slice had already emitted keys (FIX-1184).\n` +
          `  run_id ${verdict.run.run_id}  started_at ${verdict.run.started_at}  keys ${Number(verdict.run.keys).toLocaleString()}\n` +
          `  It was replaced by a later begin() before it completed, but it wrote a PREFIX\n` +
          `  after the last complete set. The older complete set's absences would delete\n` +
          `  rows that prefix emitted -- the same reason this guard is "newest" and not\n` +
          `  "newest complete". Wait for a run that completes cycle ${cycle}.`,
      );
      process.exit(2);
    }
    const run = verdict.run;

    // -- Guard 2: the keys must still be there -------------------------------
    const [present] = await q<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM public.fec_emit_keys
        WHERE run_id = $1 AND cycle_year = $2 AND source = $3`,
      [run.run_id, cycle, source],
    );
    const recorded = Number(run.keys);
    const actual = Number(present?.n ?? 0);

    const [sliceRow] = await q<{ rows: string; cents: string }>(
      client,
      `SELECT count(*)::text AS rows, coalesce(sum(amount_cents), 0)::text AS cents
         FROM public.financial_relationships
        WHERE cycle_year = $1 AND metadata->>'source' = $2`,
      [cycle, source],
    );

    // The first line, as promised: the emit set against the slice it judges.
    console.log(
      `  emit set: ${actual.toLocaleString()} keys (recorded ${recorded.toLocaleString()})   ` +
        `slice: ${Number(sliceRow?.rows ?? 0).toLocaleString()} rows / ${usd(sliceRow?.cents ?? 0)}   ` +
        `run ${run.run_id} complete ${run.complete_at}`,
    );

    if (actual !== recorded) {
      console.error(
        `\nREFUSING -- emit-set key count disagrees with the ledger.\n` +
          `  recorded ${recorded.toLocaleString()} vs present ${actual.toLocaleString()}.\n` +
          `  fec_emit_keys is UNLOGGED, so crash recovery truncates it; prod crash-recovered\n` +
          `  on 2026-09-08 15:12 UTC. A stamped ledger over a truncated key set would make\n` +
          `  EVERY row in the slice look like residue. Re-run the ingest for cycle ${cycle}.`,
      );
      process.exit(2);
    }
    if (actual === 0) {
      console.error(`\nREFUSING -- the emit set is empty for a run marked complete. Same class as above.`);
      process.exit(2);
    }

    if (explain) {
      const plan = await q<Record<string, string>>(
        client,
        `EXPLAIN ${RESIDUE_SQL}`,
        [run.run_id, cycle, source],
      );
      console.log("\n-- EXPLAIN --");
      for (const p of plan) console.log("  " + p["QUERY PLAN"]);
      const seq = plan.some((p) => /Seq Scan on financial_relationships/.test(p["QUERY PLAN"] ?? ""));
      console.log(`\n  seq scan on financial_relationships: ${seq ? "YES -- the plan is wrong" : "no"}`);
    }

    const t0 = Date.now();
    const rows = await q<ResidueRow>(client, RESIDUE_SQL, [run.run_id, cycle, source]);
    console.log(`  anti-join: ${rows.length.toLocaleString()} recipients in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    // -- Classify ------------------------------------------------------------
    // DROPPED-OUT is "this run emitted nothing at all to this recipient". It is
    // the only class whose claim the emit set fully supports.
    const classed = rows.map((r) => ({
      ...r,
      cls: Number(r.emitted) === 0 ? ("DROPPED-OUT" as const) : ("PARTIAL" as const),
    }));

    const summarise = (cls: "DROPPED-OUT" | "PARTIAL") => {
      const sub = classed.filter((c) => c.cls === cls);
      return {
        recipients: sub.length,
        rows: sub.reduce((a, c) => a + Number(c.rows), 0),
        cents: sub.reduce((a, c) => a + Number(c.cents), 0),
      };
    };
    const dropped = summarise("DROPPED-OUT");
    const partial = summarise("PARTIAL");

    console.log(`  DROPPED-OUT  ${dropped.recipients.toLocaleString()} recipients  ${dropped.rows.toLocaleString()} rows  ${usd(dropped.cents)}`);
    console.log(`  PARTIAL      ${partial.recipients.toLocaleString()} recipients  ${partial.rows.toLocaleString()} rows  ${usd(partial.cents)}`);
    console.log(
      `\n  FIX-1106 measured 3,416 / 209,017 / $1,481,928,516 on prod 2026-08-25 by the\n` +
        `  bracket-row proxy. Decomposition is the check, not magnitude -- a clone is stale.`,
    );

    // -- The manifest --------------------------------------------------------
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const out = path.join(outDir, `${stamp}-fix1106-residue-${cycle}-${source}.tsv`);
    const header = ["class", "to_type", "to_id", "name", "rows", "cents", "last_write", "emitted_rows"];
    const body = classed.map((c) =>
      [c.cls, c.to_type, c.to_id, c.name.replace(/[\t\r\n]/g, " "), c.rows, c.cents, c.last_write, c.emitted].join("\t"),
    );
    fs.writeFileSync(
      out,
      [
        `# FIX-1106 emit-set residue manifest -- ${envLabel()} -- generated ${new Date().toISOString()}`,
        `# cycle=${cycle} source=${source} run_id=${run.run_id} complete_at=${run.complete_at}`,
        `# emit set ${actual.toLocaleString()} keys; slice ${Number(sliceRow?.rows ?? 0).toLocaleString()} rows / ${usd(sliceRow?.cents ?? 0)}`,
        `# DROPPED-OUT ${dropped.recipients} recipients / ${dropped.rows} rows / ${usd(dropped.cents)}`,
        `# PARTIAL     ${partial.recipients} recipients / ${partial.rows} rows / ${usd(partial.cents)}`,
        `# This file is an AUTHORISATION, not a description. The apply re-checks every`,
        `# row-level fact keyed on these ids and SKIPS anything that grew since.`,
        header.join("\t"),
        ...body,
      ].join("\n") + "\n",
      "utf8",
    );
    console.log(`\n  -> ${out}`);
    console.log(`\n  Next: remediate-fec-emit-residue.ts --manifest ${out} (dry run first; --classes DROPPED-OUT is the default).`);
  } finally {
    await client.end();
  }
}

// FIX-1184 — only when invoked directly. resolveEmitRun() is imported by
// audit-fec-emit-residue.test.ts, and without this guard the import ran main(),
// which exits on the first argv check.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
