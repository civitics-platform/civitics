#!/usr/bin/env node
// scripts/fix-reopen.mjs
//
// pnpm fix:reopen FIX-NNN --note "why" — reopen a closed FIX by APPENDING a
// `reopen` row to docs/done.log. Never touches docs/FIXES.md.
//
// Before FIX-1016 a reopen was two hand edits: uncheck the bullet in the
// markdown AND hand-append a note to the log. The markdown half was an in-place
// edit of a hand-edited file — the concurrent-write class this FIX exists to
// remove — and it was easy to do one half and forget the other, at which point
// the two sources of truth disagreed silently. Now status derives from the log
// alone, so the append IS the reopen.
//
// Row shape (the one the log already uses — see the three existing rows):
//
//   YYYY-MM-DD | FIX-NNN | reopen | reopen | <note>
//
// `reopen` in column 4 is not in the documented `verified` vocabulary, so
// parseDoneLog folds it into the note. That is deliberate and harmless: status
// keys on column 3 and row order only, and matching the shape already in the
// file matters more than a tidier parse of a column nothing reads.
//
// No trunk guard here, unlike its siblings. The guard exists for a
// read-modify-write that replaces a whole file; this is an append. If another
// session lands a close in the read-to-write window, this row still lands after
// it and the derivation — which is last-row-wins — gives the right answer. That
// is the structural property the whole FIX is built on.
//
// The same reopen can ride a commit instead: a `Reopens: FIX-NNN` trailer,
// picked up by `pnpm fixes:sync`. Use that when the commit is what discovered
// the regression; use this when there is no commit to hang it on.
//
// Dependency-free Node, matching its siblings in scripts/.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import { ID_MARKER_RE } from "./lib/fixes-md.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");
const ARCHIVE_PATH = resolve(REPO_ROOT, "docs/archive/fixes-archive.md");

export function parseArgs(argv) {
  let id = null;
  let note = null;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--note") note = argv[++i] ?? null;
    else if (a.startsWith("--note=")) note = a.slice("--note=".length);
    else if (a === "--dry-run") dry = true;
    else if (/^FIX-\d+$/i.test(a)) id = `FIX-${a.replace(/^FIX-/i, "")}`;
    else if (/^\d+$/.test(a)) id = `FIX-${a.padStart(3, "0")}`;
    else throw new Error(`unrecognised argument "${a}"`);
  }
  return { id, note, dry };
}

/** The row this appends. Exported so the test can assert the shape. */
export function formatReopenRow({ id, note, date = new Date().toISOString().slice(0, 10) }) {
  return `${date} | ${id} | reopen | reopen | ${note}`;
}

/** Does any tracked markdown carry this id's marker? */
export function hasMarker(id, { fixesText = "", archiveText = "" } = {}) {
  const re = new RegExp(ID_MARKER_RE.source.replace("FIX-\\d+", id.replace("-", "\\-")));
  return re.test(fixesText) || re.test(archiveText);
}

function die(msg) {
  process.stderr.write(`fix:reopen — ${msg}\n`);
  process.exit(1);
}

function usage() {
  process.stderr.write(
    [
      'Usage: pnpm fix:reopen FIX-NNN --note "why it is open again" [--dry-run]',
      "",
      "Appends  YYYY-MM-DD | FIX-NNN | reopen | reopen | <note>  to docs/done.log.",
      "Refuses when the id has no bullet marker anywhere, and when it already",
      "derives OPEN. docs/FIXES.md is never modified.",
      "",
    ].join("\n"),
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    usage();
    die(e.message);
  }
  if (!args.id) {
    usage();
    die("no FIX-NNN given.");
  }
  if (!args.note || !args.note.trim()) {
    usage();
    die("--note is required — a reopen with no reason is not a record.");
  }
  if (args.note.includes("|")) {
    die("--note must not contain a `|` — it is the done.log column separator.");
  }
  if (args.note.includes("\n")) {
    die("--note must be a single line.");
  }

  const fixesText = existsSync(FIXES_PATH) ? readFileSync(FIXES_PATH, "utf8") : "";
  const archiveText = existsSync(ARCHIVE_PATH) ? readFileSync(ARCHIVE_PATH, "utf8") : "";
  if (!hasMarker(args.id, { fixesText, archiveText })) {
    die(
      `${args.id} has no <!--id:${args.id}--> marker in docs/FIXES.md or docs/archive/fixes-archive.md.\n` +
        "  Reopening an id that was never filed would create a status record with nothing behind it.",
    );
  }

  const doneText = existsSync(DONE_PATH) ? readFileSync(DONE_PATH, "utf8") : "";
  const entry = deriveStatus(parseDoneLog(doneText)).get(args.id);
  const status = entry?.status ?? "open";
  if (status === "open") {
    const why = entry
      ? `its last row is ${entry.lastRow.date} | ${entry.lastRow.sha}`
      : "it has no done.log row at all";
    die(`${args.id} already derives OPEN (${why}). Nothing to reopen.`);
  }

  const row = formatReopenRow({ id: args.id, note: args.note.trim() });
  if (args.dry) {
    console.log("fix:reopen — DRY RUN. Would append to docs/done.log:");
    console.log(`  ${row}`);
    return;
  }

  // Guarantee the append starts on its own line even if the file's last line
  // was left without a trailing newline by a hand edit.
  const needsNewline = doneText.length > 0 && !doneText.endsWith("\n");
  appendFileSync(DONE_PATH, `${needsNewline ? "\n" : ""}${row}\n`);

  console.log(`fix:reopen — ${args.id} is now OPEN.`);
  console.log(`  appended to docs/done.log:  ${row}`);
  console.log("  commit docs/done.log as its own status commit; docs/FIXES.md is unchanged.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
