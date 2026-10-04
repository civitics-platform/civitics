#!/usr/bin/env node
// scripts/lib/fixes-md.mjs
//
// The SHAPE of a docs/FIXES.md bullet, in one place.
//
// Before FIX-1016 a bullet was `- [ ] …` / `- [x] …` and five scripts each
// carried their own `/^(\s*- \[)([ xX])(\] )(.*)$/`. The checkbox was the thing
// that distinguished a FIX bullet from any other markdown list item, and when
// it was removed (status now derives from docs/done.log — see
// ./fix-status.mjs) that discriminator went with it. Every script that walks
// the file needs the SAME replacement rule, so it lives here rather than being
// copy-pasted five times.
//
// ── The rule ────────────────────────────────────────────────────────────────
// A FIX bullet is a TOP-LEVEL `- ` line (column 0 — no leading whitespace)
// inside a `## ` section, carrying either an `<!--id:FIX-NNN-->` marker or a
// leading priority emoji. The optional `[ ]`/`[x]` is still accepted so the
// historical bullets in docs/archive/fixes-archive.md keep parsing.
//
// Each clause is load-bearing, measured on the tree at 1a0468b0:
//
//   top-level      docs/archive/fixes-archive.md carries 5 INDENTED `- ` lines
//                  that are continuation prose inside an archived bullet's
//                  body ("  - **Investigation outcome (2026-04-28):** …").
//                  All 407 live and all 1,105 archived FIX bullets are at
//                  column 0, so the anchor separates them exactly.
//   in a section   docs/FIXES.md's PREAMBLE holds 8 `- ` lines — the five
//                  priority-key entries, which begin with a priority emoji
//                  ("- 🔴 Critical — …"), and three section rules. Without the
//                  section gate, fixes:housekeep would have assigned FIX ids to
//                  the priority key on its next run.
//   marker|emoji   a bullet fix:add wrote always has both; one Craig types by
//                  hand has the emoji and gets its marker from
//                  fixes:housekeep, which is why either alone qualifies.
//
// Dependency-free Node, matching its siblings in scripts/.

/** Priority emoji, highest first — also the `--severity` vocabulary of fix:add. */
export const PRIORITY_EMOJI = ["🔴", "🟠", "🟡", "🟢", "⬜"];

/** Complexity tokens — the `--size` vocabulary of fix:add. */
export const COMPLEXITY = new Set(["S", "M", "L", "XL"]);

/** The canonical stable handle at the end of a bullet. */
export const ID_MARKER_RE = /<!--\s*id:\s*(FIX-\d+)\s*-->/;

/**
 * A bullet's lane (FIX-1243): an optional SECOND marker, written by
 * `fix:add --lane <lane>` straight after the id marker, so the bullet stays one
 * line — `… <!--id:FIX-1243--> <!--lane:hygiene-->`. ID_MARKER_RE is untouched:
 * the allocator and every id reader keep matching the first marker only.
 * Craig may hand-add one to an existing bullet; the marker wins over the
 * section→lane map in docs/cc/cc.config.json.
 */
export const LANE_MARKER_RE = /<!--\s*lane:\s*([a-z][a-z0-9-]*)\s*-->/;

/** The `--severity` emoji, as the words `fixes:status --json` prints for them. */
export const PRIORITY_NAMES = { "🔴": "critical", "🟠": "high", "🟡": "medium", "🟢": "quick", "⬜": "future" };

/**
 * Top-level list item with an OPTIONAL legacy checkbox.
 *   1 → the `[ ]`/`[x]` box character, or undefined when absent
 *   2 → everything after the bullet marker (and the box, if present)
 * Deliberately anchored at column 0: see the header.
 */
export const BULLET_RE = /^- (?:\[([ xX])\] ?)?(.*)$/;

/** `^## ` section header. */
export const SECTION_RE = /^##\s+(.+?)\s*$/;
export const STRATEGIC_RE = /^##\s+STRATEGIC PILLARS\b/i;
export const COMPLETED_RE = /^##\s+COMPLETED\b/i;

/**
 * Parse one line as a FIX bullet.
 *
 * @param {string} line
 * @param {{requireSection?: boolean, inSection?: boolean}} [opts]
 *   `inSection` — whether the caller's cursor is past the first `## ` header.
 *   Defaults to true so a caller that has already sliced a section can pass the
 *   line alone; pass the real value when walking the whole file.
 * @returns {{box: string|null, rest: string, id: string|null, hasEmoji: boolean}|null}
 *   null when the line is not a FIX bullet.
 */
export function parseFixBullet(line, { inSection = true } = {}) {
  if (!inSection) return null;
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  const box = m[1] ?? null;
  const rest = m[2];
  const idMatch = ID_MARKER_RE.exec(rest);
  const id = idMatch ? idMatch[1] : null;
  const hasEmoji = PRIORITY_EMOJI.some((e) => rest.startsWith(e));
  // A top-level `- ` line with neither a marker nor a leading priority emoji is
  // ordinary prose (a nested list flattened to column 0, a note) — not a bullet.
  if (!id && !hasEmoji) return null;
  return { box, rest, id, hasEmoji };
}

/**
 * The `**bold**` title of a bullet body, for display. Falls back to a truncated
 * prefix so a malformed bullet still prints something recognisable.
 */
export function titleOf(rest, max = 90) {
  const m = /\*\*(.+?)\*\*/.exec(rest ?? "");
  if (m) return m[1].trim();
  const plain = String(rest ?? "")
    .replace(ID_MARKER_RE, "")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/**
 * The canonical bullet fix:add emits. No checkbox — status lives in
 * docs/done.log (FIX-1016 D2).
 */
export function formatFixBullet({ severity, size, title, body, id, lane }) {
  const n = String(id).replace(/^FIX-/, "");
  return `- ${severity} ${size} — **${title}** — ${body} <!--id:FIX-${n}-->${lane ? ` <!--lane:${lane}-->` : ""}`;
}

/**
 * What a bullet says about itself, read off its leading tokens and markers:
 * `{priority, size, lane_marker}`. `priority` is the PRIORITY_NAMES word for the
 * leading emoji; `size` the S/M/L/XL token after it; either is null when the
 * bullet does not carry it (a hand-typed bullet may not). `lane_marker` is the
 * LANE_MARKER_RE value, or null.
 */
export function bulletFacts(rest) {
  const s = String(rest ?? "");
  const emoji = PRIORITY_EMOJI.find((e) => s.startsWith(e)) ?? null;
  const after = emoji ? s.slice(emoji.length).trimStart() : "";
  const sz = /^(XL|S|M|L)(?=\s|$)/.exec(after);
  const lane = LANE_MARKER_RE.exec(s);
  return {
    priority: emoji ? PRIORITY_NAMES[emoji] : null,
    size: sz ? sz[1] : null,
    lane_marker: lane ? lane[1] : null,
  };
}

/**
 * A bullet's lane (FIX-1243 D1): its own marker, else its section through the
 * section→lane map, else `unmapped`. `lane_source` says which applied —
 * `marker` | `section` | `none`.
 *
 * @param {{section: string|null, lane_marker: string|null}} b
 * @param {Record<string,string>} sectionLanes exact `## ` header text → lane
 */
export function laneOfBullet(b, sectionLanes = {}) {
  if (b.lane_marker) return { lane: b.lane_marker, lane_source: "marker" };
  const mapped = b.section != null ? sectionLanes[b.section] : undefined;
  if (typeof mapped === "string" && mapped) return { lane: mapped, lane_source: "section" };
  return { lane: "unmapped", lane_source: "none" };
}

/**
 * Per-id facts for every bullet in the live file and the archive — the live
 * file wins, as in fixes:status's title index. Map id →
 * `{priority, size, section, lane, lane_source}`.
 */
export function indexBulletFacts({ fixesText = "", archiveText = "", sectionLanes = {} } = {}) {
  const out = new Map();
  for (const text of [archiveText, fixesText]) {
    for (const b of walkFixBullets(text)) {
      if (!b.id) continue;
      const f = bulletFacts(b.rest);
      out.set(b.id, {
        priority: f.priority,
        size: f.size,
        section: b.section,
        ...laneOfBullet({ section: b.section, lane_marker: f.lane_marker }, sectionLanes),
      });
    }
  }
  return out;
}

/**
 * Walk a FIXES.md / fixes-archive.md body and yield every FIX bullet with the
 * section it sits in. Skips the preamble (before the first `## `) by
 * construction — the clause that keeps the priority key from being mistaken
 * for backlog.
 *
 * @param {string} text
 * @returns {{line: string, lineNo: number, section: string, box: string|null, rest: string, id: string|null}[]}
 */
export function walkFixBullets(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let section = null;
  lines.forEach((line, i) => {
    const s = SECTION_RE.exec(line);
    if (s) {
      section = s[1];
      return;
    }
    const b = parseFixBullet(line, { inSection: section !== null });
    if (b) out.push({ line, lineNo: i + 1, section, ...b });
  });
  return out;
}

/**
 * FIX-1271 (a): ids carried by more than one live bullet. Two sessions that
 * `fix:add` from their own trees can allocate the same id; once one rebases
 * onto the other, the file holds the marker twice and every reader silently
 * picks one of the two bullets. Scope is docs/FIXES.md ONLY — the archive
 * carries a historical duplicate (FIX-194, twice) that fixes:status already
 * resolves live-wins, and it is not where a new collision can land.
 *
 * @param {{id: string|null, lineNo: number}[]} bullets — walkFixBullets output
 * @returns {{id: string, lines: number[]}[]} one entry per duplicated id
 */
export function duplicateIdMarkers(bullets) {
  const linesById = new Map();
  for (const b of bullets ?? []) {
    if (!b.id) continue;
    if (!linesById.has(b.id)) linesById.set(b.id, []);
    linesById.get(b.id).push(b.lineNo);
  }
  return [...linesById]
    .filter(([, lines]) => lines.length > 1)
    .map(([id, lines]) => ({ id, lines }));
}

/**
 * FIX-1271 (b): the FIX numbers a commit SUBJECT names. A `FIX-n` tag plus the
 * shorthand siblings that follow it — `FIX-1044/1045/1046`, `FIX-997 / 982`,
 * `FIX-1014, 936, 963`, `FIX-826..829` and `FIX-036 through FIX-041` (a range
 * of at most 50). Numbers, not
 * strings, so `FIX-037` and `FIX-37` agree. Reading a sibling can only ADD a
 * number, so a loose read makes the check more permissive, never stricter.
 */
export function subjectFixNumbers(subject) {
  const s = String(subject ?? "");
  const nums = new Set();
  const tagRe = /FIX-(\d+)/g;
  let m;
  while ((m = tagRe.exec(s))) {
    let prev = Number(m[1]);
    nums.add(prev);
    const sib = /\s*(\/|,|\+|&|\.\.|and\b|through\b)\s*(?:FIX-)?(\d+)\b/y;
    sib.lastIndex = tagRe.lastIndex;
    let k;
    while ((k = sib.exec(s))) {
      const n = Number(k[2]);
      if ((k[1] === ".." || k[1] === "through") && n > prev && n - prev <= 50) for (let i = prev + 1; i < n; i++) nums.add(i);
      nums.add(n);
      prev = n;
      tagRe.lastIndex = sib.lastIndex;
    }
  }
  return nums;
}

/**
 * FIX-1271 (b): a trailer id the commit's own subject does not name. When a
 * session re-allocates a collided id it has to change it in two places — the
 * bullet's marker and every trailer — and doing one is the failure this
 * catches: `feat(x): FIX-1263 — …` carrying `Fixes: FIX-1265`. A subject with
 * NO FIX tag is exempt (most commits with a trailer still name nothing in the
 * subject). Applies to `Fixes:`, `Closes:` and `Reopens:` alike — a reopen of
 * the wrong id is the same mistake.
 *
 * @param {{id: string, sha?: string, commitSha?: string, subject?: string, note?: string}[]} completions
 *   one per (commit, id) — fixes-sync's scanCommits shape. `subject` is the raw
 *   subject; `note` is the fallback (it IS the subject on Fixes:/Closes: rows).
 * @returns {{sha: string, ids: string[], subjectIds: string[], subject: string}[]} one per commit
 */
export function trailerSubjectMismatches(completions) {
  const byCommit = new Map();
  for (const c of completions ?? []) {
    const subject = c.subject ?? c.note ?? "";
    const named = subjectFixNumbers(subject);
    if (named.size === 0) continue;
    if (named.has(Number(String(c.id).replace(/^FIX-/, "")))) continue;
    const sha = c.commitSha ?? c.sha ?? "";
    const key = `${sha}\0${subject}`;
    if (!byCommit.has(key)) {
      const subjectIds = [...new Set(String(subject).match(/FIX-\d+/g))];
      byCommit.set(key, { sha, ids: [], subjectIds, subject });
    }
    const hit = byCommit.get(key);
    if (!hit.ids.includes(c.id)) hit.ids.push(c.id);
  }
  return [...byCommit.values()];
}

/**
 * Detect a file's dominant line ending so a rewrite can put it back. FIXES.md
 * and done.log are pinned to LF by .gitattributes (FIX-361), but a one-off
 * working-tree edit by a misconfigured editor should round-trip rather than
 * silently reflow the whole file.
 */
export function detectEol(text) {
  return /\r\n/.test(String(text ?? "")) ? "\r\n" : "\n";
}
