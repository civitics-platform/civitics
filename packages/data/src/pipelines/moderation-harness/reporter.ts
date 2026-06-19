// SF-P3 shadow moderation harness (FIX-601) — dated report writer.
// Mirrors integrity-audit/reporter.ts: a {date}[-local].md + .json under the
// out dir, greppable for `| MISMATCH |`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditRow, HarnessReport } from "./types";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function verdict(row: AuditRow): string {
  return row.match ? "MATCH" : "MISMATCH";
}

// A MISMATCH on a handled/partial fixture is a regression (🔴); on a gap it's
// expected/known-failing (🟡). A MATCH is 🟢.
function badge(row: AuditRow): string {
  if (row.match) return "🟢";
  return row.expectation === "gap" ? "🟡" : "🔴";
}

function formatMarkdown(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push(`# Shadow moderation harness — ${report.ranAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`- Ran at: \`${report.ranAt}\``);
  lines.push(`- Duration: ${report.durationMs} ms`);
  lines.push(`- DB host: \`${report.dbHost}\``);
  lines.push(`- Code sha: \`${report.sha}\``);
  lines.push(
    `- Results: ${report.summary.matches} match · ${report.summary.mismatches} mismatch ` +
      `(${report.summary.regressions} regression · ${report.summary.knownFailing} known-failing gap)`,
  );
  lines.push("");
  lines.push(
    "> Read-only suite. Every fixture's content was created in a transaction and " +
      "rolled back; only the ledger rows persist. No consequence is conferred.",
  );
  lines.push("");
  lines.push("## Verdicts");
  lines.push("");
  lines.push(
    "| | Fixture | Rule | Tier | Expected | Computed | Verdict | Notes |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of report.rows) {
    const note = (r.notes ?? "").replace(/\|/g, "\\|");
    lines.push(
      `| ${badge(r)} | ${r.fixtureId} | ${r.ruleId} | ${r.expectation} | ` +
        `${r.expectedVerdict.replace(/\|/g, "\\|")} | ${r.computedVerdict.replace(/\|/g, "\\|")} | ` +
        `${verdict(r)} | ${note} |`,
    );
  }
  lines.push("");
  lines.push("## Zero-pollution check");
  lines.push("");
  lines.push("| Table | Before | After | Δ |");
  lines.push("|---|---|---|---|");
  for (const p of report.pollution) {
    lines.push(`| ${p.table} | ${p.before} | ${p.after} | ${p.delta} |`);
  }
  const dirty = report.pollution.some((p) => p.delta !== 0);
  lines.push("");
  lines.push(
    dirty
      ? "**⚠️ POLLUTION DETECTED — a fixture leaked rows past its rollback.**"
      : "✅ All fixture content rolled back cleanly (every Δ = 0).",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeReport(
  report: HarnessReport,
  outDir: string,
  allowProd: boolean,
): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const date = todayISO();
  const suffix = allowProd ? "" : "-local";
  const jsonPath = join(outDir, `${date}${suffix}.json`);
  const mdPath = join(outDir, `${date}${suffix}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(mdPath, formatMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export function printStdoutTable(report: HarnessReport): void {
  const rows = report.rows.map((r) => ({
    fixture: r.fixtureId,
    tier: r.expectation,
    verdict: r.match ? "MATCH" : "MISMATCH",
    computed: r.computedVerdict,
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(
    `\nTotals: ${report.summary.matches} match · ${report.summary.mismatches} mismatch ` +
      `(${report.summary.regressions} regression · ${report.summary.knownFailing} known-failing)`,
  );
}
