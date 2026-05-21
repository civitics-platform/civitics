import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditReport, CheckResult, Severity } from "./types";

const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatJSON(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

function sevBadge(sev: Severity): string {
  if (sev === "error") return "🔴";
  if (sev === "warning") return "🟡";
  return "🟢";
}

function formatMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Data integrity audit — ${report.ranAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`- Ran at: \`${report.ranAt}\``);
  lines.push(`- Duration: ${report.durationMs} ms`);
  lines.push(`- DB host: \`${report.dbHost}\``);
  lines.push(
    `- Results: ${report.summary.errors} error · ${report.summary.warnings} warning · ${report.summary.infos} info`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Sev | Category | Expected | Actual | Detail |");
  lines.push("|---|---|---|---|---|");
  const sorted = [...report.results].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      a.category.localeCompare(b.category),
  );
  for (const r of sorted) {
    const detail = r.detail.replace(/\|/g, "\\|");
    lines.push(
      `| ${sevBadge(r.severity)} | ${r.category} | ${r.expected} | ${r.actual} | ${detail} |`,
    );
  }
  lines.push("");
  const withSamples = sorted.filter((r) => r.sample.length > 0);
  if (withSamples.length > 0) {
    lines.push("## Samples");
    lines.push("");
    for (const r of withSamples) {
      lines.push(`### ${sevBadge(r.severity)} ${r.category}`);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.sample, null, 2));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function summarize(results: CheckResult[]): AuditReport["summary"] {
  return {
    total: results.length,
    errors: results.filter((r) => r.severity === "error").length,
    warnings: results.filter((r) => r.severity === "warning").length,
    infos: results.filter((r) => r.severity === "info").length,
  };
}

export function writeReport(
  report: AuditReport,
  outDir: string,
  allowProd: boolean,
): {
  jsonPath: string;
  mdPath: string;
} {
  mkdirSync(outDir, { recursive: true });
  const date = todayISO();
  // FIX-323: suffix goes before the extension so date-based sorting still
  // works. CI runs pass --allow-prod (via data:audit:ci); local runs don't.
  const suffix = allowProd ? "" : "-local";
  const jsonPath = join(outDir, `${date}${suffix}.json`);
  const mdPath = join(outDir, `${date}${suffix}.md`);
  writeFileSync(jsonPath, formatJSON(report), "utf8");
  writeFileSync(mdPath, formatMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export function printStdoutTable(report: AuditReport): void {
  const sorted = [...report.results].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      a.category.localeCompare(b.category),
  );
  const rows = sorted.map((r) => ({
    sev: r.severity,
    category: r.category,
    expected: String(r.expected),
    actual: String(r.actual),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(
    `\nTotals: ${report.summary.errors} error · ${report.summary.warnings} warning · ${report.summary.infos} info (of ${report.summary.total} checks)`,
  );
}
