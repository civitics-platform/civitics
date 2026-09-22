/**
 * FIX-1182 experiment (1) — join the COMMITTED set-A manifest to the set-B
 * manifest a second complete emit run produced, and cut the derived RETRACTED
 * manifest that is the only thing FIX-1106 may ever apply.
 *
 * Read-only: two TSVs in, a markdown report and (per source, if the retraction
 * class is non-empty) one TSV out. It opens no database connection — the
 * evidence is the two manifests, and that is deliberate. Set A's emit rows are
 * GONE from the database: `fec_emit_runs` / `fec_emit_keys` are UNLOGGED on
 * purpose (`20260909000000_fix1106_fec_emit_set.sql:32-40`) so that crash
 * recovery truncates them and the audit REFUSES rather than anti-joining a
 * prefix. The committed manifest is therefore the only surviving copy of set
 * A, and a two-run comparison keys on the committed manifests, never on the
 * database's emit ledger.
 *
 *   pnpm --filter @civitics/data tsx src/scripts/fix1182-experiment-1.ts \
 *     --set-a docs/audits/2026-09-14-…-fec_bulk_indiv.tsv \
 *     --set-b docs/audits/2026-09-22-…-fec_bulk_indiv.tsv
 *
 * Paths resolve against the REPO ROOT, not the cwd (FIX-1198).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveUnderRepoRoot } from "../lib/repo-root";
import {
  type ClassifiedRow,
  type ManifestRow,
  classify,
  totals,
} from "../lib/fix1182-classify";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const usd = (cents: number): string =>
  "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

interface ParsedManifest {
  comments: string[];
  rows: ManifestRow[];
  cycle: number;
  source: string;
  runId: string;
  generated: Date;
  /** The `# cycle=… run_id=…` line, verbatim — the derived manifest reuses it. */
  headerLine: string;
  droppedLine: string;
  emitLine: string;
}

function parseManifest(file: string): ParsedManifest {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const comments = lines.filter((l) => l.startsWith("#"));
  const headerLine = comments.find((c) => c.includes("cycle=") && c.includes("run_id=")) ?? "";
  const get = (k: string): string => new RegExp(`${k}=(\\S+)`).exec(headerLine)?.[1] ?? "";
  const genLine = comments.find((c) => c.includes("generated ")) ?? "";
  const genMatch = /generated (\S+)/.exec(genLine);
  const generated = new Date(genMatch?.[1] ?? "");
  if (Number.isNaN(generated.getTime())) {
    console.error(`FAIL ${file} has no parseable '# … generated <iso>' line — cannot date set A.`);
    process.exit(1);
  }

  const head = lines.findIndex((l) => l.startsWith("class\t"));
  if (head < 0) {
    console.error(`FAIL ${file} has no 'class\\t…' header row — not a FIX-1106 manifest.`);
    process.exit(1);
  }
  const rows: ManifestRow[] = [];
  for (const line of lines.slice(head + 1)) {
    if (line.trim() === "") continue;
    const f = line.split("\t");
    rows.push({
      cls: f[0] ?? "",
      to_type: f[1] ?? "",
      to_id: f[2] ?? "",
      name: f[3] ?? "",
      rows: Number(f[4] ?? 0),
      cents: Number(f[5] ?? 0),
      last_write: f[6] ?? "",
      emitted_rows: Number(f[7] ?? 0),
    });
  }
  return {
    comments,
    rows,
    cycle: Number(get("cycle")),
    source: get("source"),
    runId: get("run_id"),
    generated,
    headerLine,
    droppedLine: comments.find((c) => c.includes("DROPPED-OUT")) ?? "",
    emitLine: comments.find((c) => c.includes("emit set")) ?? "",
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const aPath = arg(argv, "--set-a");
  const bPath = arg(argv, "--set-b");
  if (aPath === undefined || bPath === undefined) {
    console.error("FAIL usage: --set-a <manifest.tsv> --set-b <manifest.tsv> [--out-dir docs/audits]");
    process.exit(1);
  }
  const outDir = resolveUnderRepoRoot(arg(argv, "--out-dir") ?? path.join("docs", "audits"), "fix1182-exp1");

  const A = parseManifest(resolveUnderRepoRoot(aPath, "fix1182-exp1"));
  const B = parseManifest(resolveUnderRepoRoot(bPath, "fix1182-exp1"));

  if (A.source !== B.source || A.cycle !== B.cycle) {
    console.error(`FAIL the two manifests are not the same slice: ${A.cycle}/${A.source} vs ${B.cycle}/${B.source}.`);
    process.exit(1);
  }
  if (A.runId === B.runId) {
    console.error(
      `FAIL both manifests name run ${A.runId}. Experiment (1) needs TWO complete runs;\n` +
        `  comparing a run with itself can only ever produce class (i).`,
    );
    process.exit(1);
  }

  const classified = classify({ setA: A.rows, setB: B.rows, generatedA: A.generated });
  const i = totals(classified, "unproven-both");
  const ii = totals(classified, "retraction");
  const iii = totals(classified, "re-emitted");

  const aDropped = A.rows.filter((r) => r.cls === "DROPPED-OUT").length;
  const bDropped = B.rows.filter((r) => r.cls === "DROPPED-OUT").length;

  console.log(`\n-- FIX-1182 experiment (1) -- cycle ${A.cycle} / ${A.source} --`);
  console.log(`   set A ${A.runId}  generated ${A.generated.toISOString()}  DROPPED-OUT ${aDropped}`);
  console.log(`   set B ${B.runId}  generated ${B.generated.toISOString()}  DROPPED-OUT ${bDropped}`);
  console.log(`\n   (i)   UNPROVEN  (dropped in both)   ${i.recipients} recipients  ${i.rows.toLocaleString()} rows  ${usd(i.cents)}`);
  console.log(`   (ii)  RETRACTION (A had, B dropped) ${ii.recipients} recipients  ${ii.rows.toLocaleString()} rows  ${usd(ii.cents)}`);
  console.log(`   (iii) RE-EMITTED (A dropped, B has) ${iii.recipients} recipients  ${iii.rows.toLocaleString()} rows  ${usd(iii.cents)}`);

  const demoted = classified.filter((r) => r.demotedReason !== undefined);
  if (demoted.length > 0) {
    console.log(`\n   ! ${demoted.length} candidate retraction(s) DEMOTED to unproven by the provenance check:`);
    for (const d of demoted) console.log(`     ${d.to_id} ${d.name} — ${d.demotedReason}`);
  }

  // Reconciliation — stated as an assertion, because a mismatch means the join
  // key is wrong and every number above is meaningless.
  const undemotedI = classified.filter((r) => r.klass === "unproven-both" && r.demotedReason === undefined).length;
  const okA = undemotedI + iii.recipients === aDropped;
  const okB = i.recipients + ii.recipients === bDropped;
  console.log(
    `\n   reconcile: A ${aDropped} = (i undemoted) ${undemotedI} + (iii) ${iii.recipients} ${okA ? "OK" : "MISMATCH"}` +
      `   |   B ${bDropped} = (i) ${i.recipients} + (ii) ${ii.recipients} ${okB ? "OK" : "MISMATCH"}`,
  );
  if (!okA || !okB) process.exitCode = 1;

  // -- the derived RETRACTED manifest ---------------------------------------
  const retractions = classified.filter((r) => r.klass === "retraction");
  if (retractions.length === 0) {
    console.log(`\n   Class (ii) is EMPTY — no manifest cut. The residue for this source is UNPROVEN`);
    console.log(`   and the apply is EMPTY.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(outDir, `${stamp}-fix1106-residue-${A.cycle}-${A.source}-RETRACTED.tsv`);
  const body = retractions.map((r: ClassifiedRow) =>
    [r.cls, r.to_type, r.to_id, r.name, r.rows, r.cents, r.last_write, r.emitted_rows].join("\t"),
  );
  fs.writeFileSync(
    out,
    [
      `# NOT AN AUTHORISATION until Craig's go-ahead for THIS set is typed into the`,
      `# session that applies it. Derived by fix1182-experiment-1.ts, not by the audit.`,
      `#`,
      `# This file is the RETRACTION class (ii) ONLY: recipients that set A's complete`,
      `# emit run held and set B's complete emit run dropped. It deliberately EXCLUDES`,
      `# class (i) (dropped by both runs = never emitted by either = UNPROVEN, the class`,
      `# FIX-1182 was filed to protect) and class (iii) (re-emitted by B = not residue).`,
      `#   set A ${A.runId} generated ${A.generated.toISOString()} — the committed manifest is the ONLY`,
      `#         surviving copy; fec_emit_keys is UNLOGGED by design and its rows are gone.`,
      `#   set B ${B.runId} generated ${B.generated.toISOString()}`,
      `#   class (i) UNPROVEN ${i.recipients} / ${i.rows} rows / ${usd(i.cents)} — NOT in this file`,
      `#   class (iii) RE-EMITTED ${iii.recipients} / ${iii.rows} rows / ${usd(iii.cents)} — NOT in this file`,
      `#`,
      `# The header below is set B's, verbatim, because the apply re-checks every`,
      `# row-level fact against set B's run and refuses if that run is not complete.`,
      B.headerLine,
      B.emitLine,
      `# DROPPED-OUT ${ii.recipients} recipients / ${ii.rows} rows / ${usd(ii.cents)}   [class (ii) only]`,
      `# This file is an AUTHORISATION, not a description. The apply re-checks every`,
      `# row-level fact keyed on these ids and SKIPS anything that grew since.`,
      ["class", "to_type", "to_id", "name", "rows", "cents", "last_write", "emitted_rows"].join("\t"),
      ...body,
    ].join("\n") + "\n",
    "utf8",
  );
  console.log(`\n   -> ${out}`);
}

main();
