#!/usr/bin/env node
// scripts/fixes-status.mjs
//
// pnpm fixes:status — answer "is FIX-NNN open?" from docs/done.log.
//
// This is the question every CC prompt's Phase 0 used to answer with a grep for
// the bullet's checkbox. The checkbox is gone (FIX-1016 D2); the derivation in
// scripts/lib/fix-status.mjs is the only place that answers it, and this is its
// CLI.
//
// Usage:
//   pnpm fixes:status                       the open backlog (the default question)
//   pnpm fixes:status FIX-914 FIX-1163      these ids, whatever their status
//   pnpm fixes:status --closed              every closed id (large — pair with --since)
//   pnpm fixes:status --open --closed       everything
//   pnpm fixes:status --since 2026-09-01    ids whose LAST done.log row is on/after that date
//   pnpm fixes:status --json                machine-readable; what cc:verify consumes
//
// The universe of ids is (markers in docs/FIXES.md) union (ids in docs/done.log)
// union (markers in docs/archive/fixes-archive.md) — so an archived id that was
// later reopened still answers, even though its bullet has left the live file.
//
// Exit code is 0 for every answer, including "open". Only a parse failure
// exits 1 — a status question is not a gate. (`pnpm fixes:check` is the gate.)
//
// Dependency-free Node, matching its siblings in scripts/.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import { walkFixBullets, titleOf, ID_MARKER_RE } from "./lib/fixes-md.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");
const ARCHIVE_PATH = resolve(REPO_ROOT, "docs/archive/fixes-archive.md");

const NO_TITLE = "(archived, no title)";

export function parseArgs(argv) {
  const ids = [];
  const opts = { open: false, closed: false, json: false, since: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--open") opts.open = true;
    else if (a === "--closed") opts.closed = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--since") opts.since = argv[++i] ?? null;
    else if (a.startsWith("--since=")) opts.since = a.slice("--since=".length);
    else if (/^FIX-\d+$/i.test(a)) ids.push(`FIX-${a.replace(/^FIX-/i, "")}`);
    else if (/^\d+$/.test(a)) ids.push(`FIX-${a.padStart(3, "0")}`);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else throw new Error(`unrecognised argument "${a}" — expected FIX-NNN or a flag`);
  }
  // Explicit ids answer for exactly those ids. With no ids and no filter, the
  // useful default is the backlog: what is still open.
  if (ids.length === 0 && !opts.open && !opts.closed) opts.open = true;
  if (ids.length > 0 && !opts.open && !opts.closed) {
    opts.open = true;
    opts.closed = true;
  }
  return { ids, opts };
}

/** Title index: live FIXES.md wins, then the archive. */
export function buildTitleIndex({ fixesText = "", archiveText = "" } = {}) {
  const titles = new Map();
  const sources = new Map();
  for (const [text, where] of [
    [archiveText, "archive"],
    [fixesText, "live"],
  ]) {
    for (const b of walkFixBullets(text)) {
      if (!b.id) continue;
      titles.set(b.id, titleOf(b.rest));
      sources.set(b.id, where);
    }
  }
  return { titles, sources };
}

/** Every id the repo knows about, from all three files. */
export function buildUniverse({ statusMap, fixesText = "", archiveText = "" }) {
  const ids = new Set(statusMap.keys());
  for (const text of [fixesText, archiveText]) {
    for (const m of String(text).matchAll(new RegExp(ID_MARKER_RE.source, "g"))) ids.add(m[1]);
  }
  return [...ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

export function buildItems({ universe, statusMap, titles, sources, ids, opts }) {
  const wanted = ids.length ? new Set(ids) : null;
  const out = [];
  for (const id of universe) {
    if (wanted && !wanted.has(id)) continue;
    const entry = statusMap.get(id);
    const status = entry?.status ?? "open";
    if (status === "open" && !opts.open) continue;
    if (status === "closed" && !opts.closed) continue;
    const last = entry?.lastRow ?? null;
    // --since filters on the LAST row's date. An id with no rows has no date at
    // all, so it cannot satisfy a since-window and is dropped.
    if (opts.since && (!last || last.date < opts.since)) continue;
    out.push({
      id,
      status,
      last_date: last?.date ?? null,
      last_sha: last?.sha ?? null,
      last_verified: last?.verified ?? null,
      last_note: last?.note ?? null,
      rows: entry?.rows.length ?? 0,
      title: titles.get(id) ?? NO_TITLE,
      bullet: sources.get(id) ?? "none",
    });
  }
  // Explicit ids that exist nowhere still get an answer — open, zero rows.
  if (wanted) {
    const seen = new Set(out.map((i) => i.id));
    for (const id of ids) {
      if (seen.has(id)) continue;
      if (!opts.open) continue;
      if (opts.since) continue;
      out.push({
        id, status: "open", last_date: null, last_sha: null, last_verified: null,
        last_note: null, rows: 0, title: titles.get(id) ?? NO_TITLE,
        bullet: sources.get(id) ?? "none",
      });
    }
    out.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  }
  return out;
}

function usage() {
  process.stderr.write(
    [
      "Usage: pnpm fixes:status [FIX-NNN ...] [--open] [--closed] [--since YYYY-MM-DD] [--json]",
      "",
      "  (no args)   the open backlog",
      "  FIX-NNN     those ids, open or closed",
      "  --open      restrict to open      --closed  restrict to closed",
      "  --since D   last done.log row on or after D",
      "  --json      { generated_at, open_count, items: [...] }",
      "",
      "Status is derived from docs/done.log alone (FIX-1016):",
      "  OPEN if the id has no row, or its LAST row has `reopen` in the sha column;",
      "  CLOSED otherwise.",
      "",
    ].join("\n"),
  );
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    usage();
    process.stderr.write(`fixes:status — ${e.message}\n`);
    process.exit(1);
  }
  if (parsed.opts.help) {
    usage();
    process.exit(0);
  }
  const { ids, opts } = parsed;

  let statusMap, universe, titles, sources, openCount;
  try {
    const doneText = existsSync(DONE_PATH) ? readFileSync(DONE_PATH, "utf8") : "";
    const fixesText = existsSync(FIXES_PATH) ? readFileSync(FIXES_PATH, "utf8") : "";
    const archiveText = existsSync(ARCHIVE_PATH) ? readFileSync(ARCHIVE_PATH, "utf8") : "";
    statusMap = deriveStatus(parseDoneLog(doneText));
    ({ titles, sources } = buildTitleIndex({ fixesText, archiveText }));
    universe = buildUniverse({ statusMap, fixesText, archiveText });
    openCount = universe.filter((id) => (statusMap.get(id)?.status ?? "open") === "open").length;
  } catch (e) {
    process.stderr.write(`fixes:status — could not read/parse the status files: ${e.message}\n`);
    process.exit(1);
  }

  const items = buildItems({ universe, statusMap, titles, sources, ids, opts });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ generated_at: new Date().toISOString(), open_count: openCount, items }, null, 2)}\n`,
    );
    return;
  }

  if (items.length === 0) {
    console.log("fixes:status — no items match.");
    return;
  }
  for (const it of items) {
    const mark = it.status === "open" ? "OPEN  " : "closed";
    const last = it.last_date
      ? `${it.last_date} ${it.last_sha}${it.last_verified && it.last_verified !== "unverified" ? ` ${it.last_verified}` : ""}`
      : "(no done.log row)";
    console.log(`${it.id.padEnd(9)} ${mark}  ${last.padEnd(34)} ${it.title}`);
    if (it.status === "open" && it.last_sha === "reopen" && it.last_note) {
      // Rows written as `… | reopen | reopen | note` carry the column-4
      // sentinel into the note (it is not in the `verified` vocabulary, so
      // parseDoneLog folds it in). Drop it for display only — the file is
      // append-only and the row itself is never rewritten.
      console.log(`${" ".repeat(9)}         reopened: ${it.last_note.replace(/^reopen \| /, "")}`);
    }
  }
  console.log(
    `\n${items.length} shown · ${openCount} open of ${universe.length} known ids` +
      `${opts.since ? ` · since ${opts.since}` : ""}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
