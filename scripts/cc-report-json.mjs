#!/usr/bin/env node
// scripts/cc-report-json.mjs — `pnpm cc:json <n>`
//
// Write `docs/cc/reports/cc-<n>.json`: the report's YAML front matter, parsed,
// as JSON. Nothing else — the free-form prose stays in the .md, which remains
// the human record.
//
// WHY A SECOND COPY. A consumer that only wants to know what a run claimed —
// which commits, which FIXes, whether prod was written, whether CI was green —
// currently has to stage the whole report and re-implement the small YAML
// subset in cc-verify.mjs. The sidecar is about 1 KB and needs neither.
//
// WHY IT IS GENERATED, NEVER HAND-WRITTEN. Two copies of one fact drift, and a
// report whose .md was corrected while its .json still names the old shas is
// exactly the artefact a verifier must not pass. So: this script is the only
// writer, it derives from the .md, and `pnpm cc:verify <n>` FAILs when the two
// disagree instead of quietly preferring one. Regenerate after any front-matter
// edit; the diff is the check.
//
// USAGE
//   pnpm cc:json 125                 # from docs/cc/reports/cc-125.md
//   pnpm cc:json --file path/to.md   # fixtures, or a report elsewhere
//   pnpm cc:json 125 --check         # exit 1 if the file on disk is stale

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontMatter } from "./cc-verify.mjs";
import { loadCcConfig, reportPath, reportJsonPath } from "./lib/cc-config.mjs";

/** The exact bytes the sidecar should hold for a given report body. */
export function renderSidecar(mdText) {
  return `${JSON.stringify(parseFrontMatter(mdText), null, 2)}\n`;
}

function usage() {
  process.stderr.write(
    [
      "Usage: pnpm cc:json <n> [--check]",
      "       pnpm cc:json --file <path-to-report.md> [--check]",
      "",
      "Writes cc-<n>.json beside the report: its front matter, parsed.",
      "--check writes nothing and exits 1 if the sidecar on disk is stale.",
      "",
    ].join("\n"),
  );
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const fileIdx = argv.indexOf("--file");
  const n = argv.find((a) => /^\d+$/.test(a));
  if (fileIdx === -1 && !n) {
    usage();
    return 1;
  }

  const cfg = loadCcConfig();
  const mdPath = fileIdx !== -1 ? resolve(argv[fileIdx + 1] ?? "") : reportPath(n, cfg);
  if (!existsSync(mdPath)) {
    process.stderr.write(`cc:json — no report at ${mdPath}\n`);
    return 1;
  }

  let body;
  try {
    body = renderSidecar(readFileSync(mdPath, "utf8"));
  } catch (e) {
    process.stderr.write(`cc:json — ${e.message}\n`);
    return 1;
  }

  const jsonPath = reportJsonPath(mdPath);
  const current = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;

  if (check) {
    if (current === body) {
      console.log(`cc:json — ${jsonPath} is current.`);
      return 0;
    }
    process.stderr.write(
      `cc:json — ${jsonPath} is ${current === null ? "missing" : "STALE"}. Run \`pnpm cc:json\` to regenerate.\n`,
    );
    return 1;
  }

  if (current === body) {
    console.log(`cc:json — ${jsonPath} unchanged.`);
    return 0;
  }
  writeFileSync(jsonPath, body, "utf8");
  console.log(`cc:json — wrote ${jsonPath} (${body.length} bytes).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
