// FIX-1415 — docs/PHASE_GOALS.md → the /dashboard Development Progress card.
//
// The roadmap's percentage is a checkbox ratio (its own header note says so),
// so it is computed here, not read off the header. Before this, three copies
// were hand-kept and all three disagreed with the file: the route's `catch`
// and DashboardClient's PHASES_FALLBACK both said Phase 1 was 88 %, and
// PHASE1_TASKS called five checked bullets not done.
//
// Pure — no `next` import — so /api/phases imports it and the unit tests run it
// under tsx. scripts/lib/phase-goals.mjs (the board, dependency-free Node)
// keeps a COPY of PHASE_HEADER_RE and a twin of the counter;
// scripts/test-phase-goals.mjs pins the copy to this file's literal, and
// phase-goals.test.ts asserts the two counters agree on the real file.

/**
 * The three header shapes (FIX-1078): `100% complete`, `~96% complete`,
 * `Planned`. Groups: 1 `Phase N`, 2 label, 3 the header's digits (absent for
 * `Planned`). The digits are the document's claim, which the tests pin to the
 * computed ratio; they are not the percentage this module returns.
 */
export const PHASE_HEADER_RE = /^## (Phase \d+) — ([^\n`]+?)(?:\s*✓)?\s*`[^`]+`\s*`(?:~?(\d+)% complete|Planned)`/gm;

const BULLET_RE = /^- \[([ xX])\] (.*)$/;
const PARKED_RE = /— was FIX-\d+;/;
const GROUP_RE = /^### (.+?)\s*$/;
const LABEL_MAX = 100;

export type OpenItem = { label: string; group: string | null };

export type PhaseGoal = {
  name: string;
  label: string;
  /** The header's own token with ` complete` dropped: `100%`, `~96%`, `Planned`. */
  token: string;
  /** The header's digits; null for `Planned`. */
  headerPct: number | null;
  /** The header carries `✓`. */
  headerDone: boolean;
  checked: number;
  /** Top-level bullets still `- [ ]`, parked ones excluded. */
  open: OpenItem[];
  /** Bullets carrying `— was FIX-NNN;`: in neither `checked` nor `open`. */
  parked: number;
  /** checked + open.length */
  total: number;
  /** round(100 × checked / total); 0 when there are no bullets. */
  pct: number;
  done: boolean;
};

export type PhaseBar = Pick<PhaseGoal, "name" | "label" | "pct" | "done" | "checked" | "total">;

export type CurrentPhase = Pick<PhaseGoal, "name" | "label" | "checked" | "total" | "parked" | "open">;

export type PhasesPayload = { phases: PhaseBar[]; current: CurrentPhase };

/**
 * A bullet's text → its card label: the text before the first ` — `, with
 * backticks, bold markers and link syntax removed, capped at 100 characters.
 */
export function itemLabel(text: string): string {
  const dash = text.indexOf(" — ");
  const head = dash === -1 ? text : text.slice(0, dash);
  const plain = head
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  return plain.length > LABEL_MAX ? `${plain.slice(0, LABEL_MAX - 1).trimEnd()}…` : plain;
}

/**
 * Every phase header PHASE_HEADER_RE matches, with the top-level checkbox
 * bullets between it and the next `## ` line. Indented bullets do not count.
 */
export function parsePhaseGoals(md: string): PhaseGoal[] {
  const text = md.replace(/\r\n/g, "\n");
  const re = new RegExp(PHASE_HEADER_RE.source, PHASE_HEADER_RE.flags);
  const headers = new Map<number, RegExpExecArray>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) headers.set(m.index, m);

  const phases: PhaseGoal[] = [];
  let current: PhaseGoal | null = null;
  let group: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const h = headers.get(offset);
    offset += line.length + 1;
    if (h) {
      const digits = h[3];
      current = {
        name: h[1]!.trim(),
        label: h[2]!.trim(),
        token: (/`([^`]+)`$/.exec(h[0])?.[1] ?? "").replace(/\s*complete$/, ""),
        headerPct: digits === undefined ? null : parseInt(digits, 10),
        headerDone: h[0].includes("✓"),
        checked: 0,
        open: [],
        parked: 0,
        total: 0,
        pct: 0,
        done: false,
      };
      phases.push(current);
      group = null;
      continue;
    }
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const g = GROUP_RE.exec(line);
    if (g) {
      group = g[1]!;
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (!b) continue;
    if (PARKED_RE.test(line)) current.parked++;
    else if (b[1] === " ") current.open.push({ label: itemLabel(b[2]!), group });
    else current.checked++;
  }

  for (const p of phases) {
    p.total = p.checked + p.open.length;
    p.pct = p.total === 0 ? 0 : Math.round((100 * p.checked) / p.total);
    p.done = p.pct === 100;
  }
  return phases;
}

/**
 * /api/phases' body. `current` is the first phase under 100, else the last.
 * Throws when the file yields no phase: the route answers `{ phases: [] }`
 * rather than a payload with nothing behind it.
 */
export function phasesPayload(md: string): PhasesPayload {
  const phases = parsePhaseGoals(md);
  const cur = phases.find((p) => p.pct < 100) ?? phases[phases.length - 1];
  if (!cur) throw new Error("No phases found");
  return {
    phases: phases.map(({ name, label, pct, done, checked, total }) => ({ name, label, pct, done, checked, total })),
    current: {
      name: cur.name,
      label: cur.label,
      checked: cur.checked,
      total: cur.total,
      parked: cur.parked,
      open: cur.open,
    },
  };
}
