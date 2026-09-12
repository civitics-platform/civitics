/**
 * FIX-1106 — apply the emit-set residue manifest. The cc-115 shape, fourth user.
 *
 *   # clone: derive
 *   pnpm --filter @civitics/data data:audit:fec-residue -- --cycle 2026
 *   # prod: keyed dry run, then the Craig-gated apply
 *   pnpm --filter @civitics/data data:remediate:fec-residue:prod -- \
 *     --manifest docs/audits/<date>-fix1106-residue-2026-fec_bulk_indiv.tsv
 *   pnpm --filter @civitics/data data:remediate:fec-residue:prod -- \
 *     --manifest <path> --apply --allow-prod --defer-tails
 *
 * RULE 1 (FIX-1165) — a remediation applies from a manifest and never derives on
 * prod. The derivation is the anti-join in audit-fec-emit-residue.ts; on prod it
 * is a keyed read, but it is still a derivation and it belongs on the clone. This
 * script consumes its TSV.
 *
 * Prod still recomputes every row-level fact it is about to act on, keyed on the
 * manifest's ids — a clone dry run is stale the moment prod moves. Recipients
 * whose residue GREW since the manifest was cut are REPORTED and SKIPPED: a
 * manifest is an authorisation, not a description.
 *
 * DEFAULT CLASS IS DROPPED-OUT ONLY. PARTIAL recipients are ones the run still
 * emits to, whose per-donor set shrank; FIX-1106 bounded the false-positive rate
 * on the proxy at ~2% and the emit set removes that uncertainty for DROPPED-OUT,
 * not for PARTIAL. Sweeping PARTIAL needs its own evidence and its own go-ahead.
 *
 * THE TAIL is the shared FIX-1074 drain. Every platform-scoped step is declared
 * and left to its scheduled owner, the VACUUM included — the residue is ~209k FR
 * rows, 1.4% of the table and under the 0.02 autovacuum trigger, so
 * fr-vacuum-analyze (Mon 01:00) collects it. If a future manifest exceeds ~1M
 * rows that answer changes to a supervised window; the script says so.
 */

import { Client } from "pg";
import { constructDbUrlFromEnv, deferTails, envLabel, usd } from "./fec-orphan-classify";
import { manifestArg, requireManifestOnProd, type Manifest } from "./remediation-manifest";
import { drainFrRewrite, isCancellation } from "../lib/fr-rewrite-drain";
import { runUnderProdSession } from "../lib/prod-session";

/** Above this the vacuum answer stops being "let the Monday job collect it". */
const SUPERVISED_VACUUM_ROWS = 1_000_000;

type Cls = "DROPPED-OUT" | "PARTIAL";

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

/** `# cycle=2026 source=fec_bulk_indiv run_id=... complete_at=...` */
function headerFacts(m: Manifest): { cycle: number; source: string; runId: string } {
  const line = m.comments.find((c) => c.includes("cycle=") && c.includes("run_id="));
  if (!line) {
    console.error("FAIL manifest has no `# cycle=... source=... run_id=...` line -- not a FIX-1106 manifest.");
    process.exit(1);
  }
  const get = (k: string): string => new RegExp(`${k}=(\\S+)`).exec(line)?.[1] ?? "";
  const cycle = Number(get("cycle"));
  const source = get("source");
  const runId = get("run_id");
  if (!cycle || !source || !runId) {
    console.error(`FAIL manifest header incomplete: cycle=${cycle} source=${source} run_id=${runId}`);
    process.exit(1);
  }
  return { cycle, source, runId };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const prod = envLabel() === "prod";
  const apply = argv.includes("--apply");
  const defer = deferTails(argv);
  const classes = (arg(argv, "--classes") ?? "DROPPED-OUT").split(",").map((c) => c.trim()) as Cls[];

  const manifestPath = manifestArg(argv);
  const manifest = requireManifestOnProd({
    prod,
    manifestPath,
    script: "remediate-fec-emit-residue",
    flag: "--manifest <path>",
  });
  if (!manifest) {
    console.error("FAIL --manifest <path> is required. Build one with data:audit:fec-residue.");
    process.exit(1);
  }
  if (prod && apply && !argv.includes("--allow-prod")) {
    console.error("FAIL prod --apply requires --allow-prod.");
    process.exit(1);
  }

  const { cycle, source, runId } = headerFacts(manifest);
  const wanted = manifest.rows.filter((r) => classes.includes(r["class"] as Cls));
  const toIds = wanted.map((r) => r["to_id"]!).filter(Boolean);

  console.log(`\n-- FIX-1106 residue remediation -- ${envLabel()} -- cycle ${cycle} / ${source} --`);
  console.log(`  manifest ${manifest.path}`);
  console.log(`  classes  ${classes.join(",")}  ->  ${toIds.length.toLocaleString()} of ${manifest.rows.length.toLocaleString()} recipients`);
  for (const c of manifest.comments) console.log(`  ${c}`);
  if (toIds.length === 0) {
    console.log("\n  Nothing selected. Done.");
    return;
  }

  const client = new Client({ connectionString: constructDbUrlFromEnv() });
  await client.connect();

  try {
    // -- The emit set must still be the one the manifest was cut against ------
    // A newer run has a different run_id, and its absences are a different
    // answer. Acting on last week's answer would delete rows this week's run
    // legitimately re-emitted.
    const [runRow] = await q<{ complete_at: string | null; keys: string }>(
      client,
      `SELECT complete_at::text, keys::text FROM public.fec_emit_runs
        WHERE run_id = $1 AND cycle_year = $2 AND source = $3`,
      [runId, cycle, source],
    );
    if (!runRow || runRow.complete_at === null) {
      console.error(
        `\nFAIL REFUSING -- the manifest's run ${runId} is absent or not complete on ${envLabel()}.\n` +
          `  Re-run the audit against the current emit set and cut a fresh manifest.`,
      );
      process.exit(2);
    }
    const [presentRow] = await q<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM public.fec_emit_keys
        WHERE run_id = $1 AND cycle_year = $2 AND source = $3`,
      [runId, cycle, source],
    );
    if (Number(presentRow?.n ?? 0) !== Number(runRow.keys)) {
      console.error(
        `\nFAIL REFUSING -- emit-set key count moved (ledger ${runRow.keys}, present ${presentRow?.n}).\n` +
          `  fec_emit_keys is UNLOGGED; a crash truncates it. Re-run the ingest and re-audit.`,
      );
      process.exit(2);
    }

    // -- Re-check, keyed on the manifest's ids -------------------------------
    // Index range scan on (to_type, to_id) plus the emit-set probe. Never a scan
    // of financial_relationships.
    console.log("\n-- Keyed re-check on this environment ----------------------");
    const live = await q<{ to_id: string; rows: string; cents: string }>(
      client,
      `SELECT fr.to_id::text, count(*)::text AS rows, sum(fr.amount_cents)::text AS cents
         FROM public.financial_relationships fr
        WHERE fr.to_id = ANY($1::uuid[])
          AND fr.cycle_year = $2
          AND fr.metadata->>'source' = $3
          AND NOT EXISTS (
                SELECT 1 FROM public.fec_emit_keys k
                 WHERE k.run_id            = $4
                   AND k.cycle_year        = fr.cycle_year
                   AND k.source            = $3
                   AND k.relationship_type = fr.relationship_type
                   AND k.to_type           = fr.to_type
                   AND k.to_id             = fr.to_id
                   AND k.from_id           = fr.from_id
              )
        GROUP BY fr.to_id`,
      [toIds, cycle, source, runId],
    );

    const byId = new Map(live.map((l) => [l.to_id, l]));
    const match: string[] = [];
    const shrunk: string[] = [];
    const grown: string[] = [];
    const gone: string[] = [];
    for (const r of wanted) {
      const id = r["to_id"]!;
      const here = byId.get(id);
      const was = Number(r["rows"]);
      if (!here) { gone.push(id); continue; }
      const now = Number(here.rows);
      if (now === was) match.push(id);
      else if (now < was) shrunk.push(id);
      else grown.push(id);
    }
    console.log(`  match ${match.length}   shrunk ${shrunk.length}   grown ${grown.length} (SKIPPED)   gone ${gone.length}`);
    if (grown.length > 0) {
      console.log(`  ! ${grown.length} recipient(s) have MORE residue than the manifest recorded and are skipped.`);
      console.log(`    A manifest is an authorisation, not a description. Re-audit to widen it.`);
    }

    const actIds = [...match, ...shrunk];
    const actRows = actIds.reduce((a, id) => a + Number(byId.get(id)?.rows ?? 0), 0);
    const actCents = actIds.reduce((a, id) => a + Number(byId.get(id)?.cents ?? 0), 0);
    console.log(`\n  TO DELETE: ${actRows.toLocaleString()} rows / ${usd(actCents)} across ${actIds.length.toLocaleString()} recipients`);

    if (actRows > SUPERVISED_VACUUM_ROWS) {
      console.log(
        `\n  ! ${actRows.toLocaleString()} rows exceeds ${SUPERVISED_VACUUM_ROWS.toLocaleString()}.\n` +
          `    The "let fr-vacuum-analyze collect it" answer holds for the ~209k-row residue\n` +
          `    FIX-1106 measured, which sits under the 0.02 autovacuum trigger. At this size\n` +
          `    the vacuum becomes a supervised off-peak window and is a decision, not a\n` +
          `    default. Stop and size it.`,
      );
    }

    if (!apply) {
      console.log(`\n  DRY RUN -- nothing written. Re-run with --apply${prod ? " --allow-prod" : ""} --defer-tails.`);
      return;
    }
    if (actIds.length === 0) {
      console.log("\n  Nothing left to act on. Done.");
      return;
    }

    // -- Apply ---------------------------------------------------------------
    // Donors are captured BEFORE the delete: afterwards the rows that named them
    // are gone and they are unreachable (FIX-1074).
    console.log("\n-- Applying ------------------------------------------------");
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE _affected AS
         SELECT DISTINCT fr.to_id AS id
           FROM public.financial_relationships fr
          WHERE fr.to_id = ANY($1::uuid[]) AND fr.to_type = 'official'`,
      [actIds],
    );
    await client.query(
      `CREATE TEMP TABLE _donor AS
         SELECT DISTINCT fr.from_id AS id
           FROM public.financial_relationships fr
          WHERE fr.to_id = ANY($1::uuid[])
            AND fr.cycle_year = $2
            AND fr.metadata->>'source' = $3`,
      [actIds, cycle, source],
    );
    await client.query(`CREATE UNIQUE INDEX ON _donor(id)`);

    const deleted = await q<{ id: string }>(
      client,
      `DELETE FROM public.financial_relationships fr
        WHERE fr.to_id = ANY($1::uuid[])
          AND fr.cycle_year = $2
          AND fr.metadata->>'source' = $3
          AND NOT EXISTS (
                SELECT 1 FROM public.fec_emit_keys k
                 WHERE k.run_id            = $4
                   AND k.cycle_year        = fr.cycle_year
                   AND k.source            = $3
                   AND k.relationship_type = fr.relationship_type
                   AND k.to_type           = fr.to_type
                   AND k.to_id             = fr.to_id
                   AND k.from_id           = fr.from_id
              )
        RETURNING fr.id::text`,
      [actIds, cycle, source, runId],
    );
    console.log(`  deleted ${deleted.length.toLocaleString()} financial_relationships rows`);
    await client.query("COMMIT");

    // -- The tail, via the shared FIX-1074 drain -----------------------------
    try {
      await drainFrRewrite(
        client,
        {
          affectedTable: "_affected",
          affectedIdColumn: "id",
          donorTable: "_donor",
          deletedFrRowIds: deleted.map((d) => d.id),
        },
        { prod, defer, churnedTables: ["financial_relationships", "entity_connections"] },
      );
    } catch (err) {
      if (isCancellation(err)) process.exit(3);
      throw err;
    }
    console.log("\n  Done.");
  } finally {
    await client.end();
  }
}

// FIX-950 — see merge-same-person-official-dupes.ts's tail.
runUnderProdSession(
  { script: "remediate-fec-emit-residue", expectedMinutes: 120 },
  main,
).catch((err) => {
  console.error(err);
  process.exit(1);
});
