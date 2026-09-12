#!/usr/bin/env node
// scripts/lib/fix-status.mjs
//
// THE derivation of FIX completion status from docs/done.log. One rule, one
// implementation — nothing else in the repo derives status (FIX-1016 D1).
//
// ── The rule ────────────────────────────────────────────────────────────────
//
//   status(id) = OPEN  if the id has no row in done.log,
//                      or if the id's LAST row has `reopen` in the sha column
//                CLOSED otherwise
//
// It keys on COLUMN 3 (sha / `backfill` / `reopen`) and ROW ORDER only. It does
// NOT key on column 4 (`verified`), which is informational and not an enum in
// practice: besides the documented vocabulary the live log carries prose
// ("stranded on PR#1 …", "closed prematurely in Phase 1 closeout …", a
// "TRAILER ERROR:" line) and an undocumented `prod-pending` value. Keying
// status on it would make a note-shaped typo flip a bullet.
//
// Measured against the tree at 1a0468b0 before the checkbox strip: 407 bullets
// in docs/FIXES.md, 0 disagreements with their checkboxes. The derivation is
// not a proposal about what the state should be — it restates what the state
// already was, which is why the checkbox could be removed rather than migrated.
//
// ── Why done.log and not the markdown ───────────────────────────────────────
// done.log is append-only, so two sessions' appends merge; an in-place checkbox
// flip on a hand-edited file silently reverts whatever landed in its
// read→write window. See FIX-1016 and scripts/lib/trunk-guard.mjs (the
// detector this replaces the need for on docs/FIXES.md status).
//
// Dependency-free Node, matching its siblings in scripts/.

// The documented `verified` vocabulary. Used ONLY to disambiguate a 5-column
// row from a legacy 4-column one (date | id | sha | note) — never for status.
export const VERIFIED_VALUES = new Set([
  "local-only",
  "prod-only",
  "local+prod",
  "unverified",
  "closes-as-superseded",
  "closes-as-redirected",
  "closes-as-recognized",
  "closes-as-no-op",
]);

// Column-3 sentinels that are not commit SHAs.
export const REOPEN_SHA = "reopen";

/**
 * Parse docs/done.log into rows, in file (append) order.
 *
 * Tolerates: the leading `#` header block, blank lines, CRLF (FIX-361), legacy
 * 4-column rows, prose in column 4, and `|` inside the note (the note is
 * rejoined). A line with fewer than 3 pipe-separated fields is skipped — it
 * cannot name an id and a sha, so it is not a status row.
 *
 * @param {string} text raw file contents
 * @returns {{date:string,id:string,sha:string,verified:string,note:string,columns:number,lineNo:number}[]}
 */
export function parseDoneLog(text) {
  const rows = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) return;
    let date, id, sha, verified, note;
    if (parts.length >= 5 && VERIFIED_VALUES.has(parts[3])) {
      [date, id, sha, verified, ...note] = parts;
      note = note.join(" | ");
    } else {
      // Legacy 4-column, or a 5+-column row whose column 4 is prose rather than
      // a vocabulary value. Either way column 4 onward is the note.
      [date, id, sha, ...note] = parts;
      verified = "unverified";
      note = note.join(" | ");
    }
    rows.push({ date, id, sha, verified, note, columns: parts.length, lineNo: i + 1 });
  });
  return rows;
}

/**
 * Derive per-id status from parsed rows.
 *
 * @param {ReturnType<typeof parseDoneLog>} rows in append order
 * @returns {Map<string, {status:'open'|'closed', lastRow:object, rows:object[]}>}
 */
export function deriveStatus(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const out = new Map();
  for (const [id, rs] of byId) {
    const lastRow = rs[rs.length - 1];
    out.set(id, { status: lastRow.sha === REOPEN_SHA ? "open" : "closed", lastRow, rows: rs });
  }
  return out;
}

/**
 * Convenience: text → map. The two-step form is exported separately so callers
 * that need the raw rows (fixes:status, fix:reopen) parse once.
 */
export function statusFromDoneLog(text) {
  return deriveStatus(parseDoneLog(text));
}

/**
 * Status for one id against a derived map. An id with no rows has never been
 * closed, which is OPEN — the same answer an unchecked box used to give.
 */
export function statusOf(map, id) {
  return map.get(id)?.status ?? "open";
}
