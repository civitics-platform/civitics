#!/usr/bin/env node
// scripts/lib/phase-goals.mjs
//
// The phase headers of docs/PHASE_GOALS.md, for `pnpm board`'s projects strip
// (FIX-1243 D3). A plan file may carry `goal: "P2 · Accountability Tools"`; the
// strip groups tiles under the phase that prefix names, headed with the phase's
// own percentage token.
//
// ── One regex, two copies, pinned ───────────────────────────────────────────
// apps/civitics/app/api/phases/route.ts parses these headers for /dashboard.
// Its parser is a module-private function in a Next route file, which may not
// export anything but route handlers and config, and it imports next/server —
// so it cannot be imported by a dependency-free script. PHASE_HEADER_RE is
// therefore a COPY, and scripts/test-phase-goals.mjs reads the route's source
// and fails if the two literals differ. Change them together.
//
// What the board does NOT do: derive or display a goal's checkbox state. The
// `- [ ]` / `- [x]` bullets are hand-audited, and the percentage in the header
// is the document's own claim; the board quotes it verbatim.
//
// Dependency-free Node, matching its siblings in scripts/.

/**
 * Copied VERBATIM from route.ts `parsePhases` (FIX-1078 — the three header
 * shapes: `100% complete`, `~88% complete`, `Planned`). Groups: 1 `Phase N`,
 * 2 label, 3 the digits (absent for `Planned`).
 */
export const PHASE_HEADER_RE =
  /^## (Phase \d+) — ([^\n`]+?)(?:\s*✓)?\s*`[^`]+`\s*`(?:~?(\d+)% complete|Planned)`/gm;

const GROUP_RE = /^###\s+(.+?)\s*$/;

/**
 * Parse every phase header, with the `### ` goal groups beneath it.
 *
 * @param {string} md PHASE_GOALS.md text
 * @returns {{n: number, name: string, label: string, pct: number, done: boolean,
 *            token: string, groups: string[]}[]}
 *   `name`/`label`/`pct`/`done` are what the route returns; `token` is the
 *   header's last backtick token with ` complete` dropped (`~96%`, `100%`,
 *   `Planned`) — the document's own words, which is what the board shows.
 */
export function parsePhaseHeaders(md) {
  const text = String(md ?? "").replace(/\r\n/g, "\n");
  const re = new RegExp(PHASE_HEADER_RE.source, PHASE_HEADER_RE.flags);
  const phases = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = (/`([^`]+)`$/.exec(m[0])?.[1] ?? "").replace(/\s*complete$/, "");
    const pct = m[3] !== undefined ? parseInt(m[3], 10) : 0;
    phases.push({
      n: Number(m[1].replace(/^Phase /, "")),
      name: m[1].trim(),
      label: m[2].trim(),
      pct,
      done: pct === 100,
      token,
      offset: m.index,
      groups: [],
    });
  }
  // `### ` groups belong to the nearest phase header above them. Only lines
  // after a phase's header and before the next `## ` count.
  const lines = text.split("\n");
  let offset = 0;
  let current = null;
  for (const line of lines) {
    const p = phases.find((ph) => ph.offset === offset);
    if (p) current = p;
    else if (/^##\s/.test(line)) current = null;
    const g = GROUP_RE.exec(line);
    if (g && current) current.groups.push(g[1]);
    offset += line.length + 1;
  }
  return phases.map(({ offset: _o, ...rest }) => rest);
}

/**
 * A plan file's `goal:` → `{phase, group}`. The prefix `P<N>` names the phase;
 * the text after ` · ` (or the first separator) names the goal group.
 * Returns null when there is no `P<N>` prefix.
 */
export function parseGoal(goal) {
  const m = /^P(\d+)\b\s*(?:[·:—–-]\s*)?(.*)$/.exec(String(goal ?? "").trim());
  if (!m) return null;
  return { phase: Number(m[1]), group: m[2].trim() };
}
