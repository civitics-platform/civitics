// scripts/lib/cc-front-matter.mjs
//
// The SHAPE of the lane/project/owed front matter on CC prompts and reports
// (FIX-1242) — constants and validators over an ALREADY-PARSED object.
//
// Parsing is not here. `parseFrontMatter()` in scripts/cc-verify.mjs is the
// only YAML reader (one reader decides); this file takes its output. Keeping
// the two apart is also what lets cc-verify import these validators without an
// import cycle.
//
// Consumers: cc-verify.mjs (report checks), cc-prompt.mjs (`/cc` Step 1),
// board.mjs (card and tile problems).

/** Used when a config file predates `lanes`. docs/cc/cc.config.json is the source of record. */
export const DEFAULT_LANES = ["ops", "fec", "app", "hygiene", "design"];

/**
 * `design` is a plan-step lane only: Cowork's design notes live outside the
 * repo, so no CC run — and therefore no report — can be in it.
 */
export const PLAN_ONLY_LANES = new Set(["design"]);

/** Reports from this cc number on must carry `lane:`; earlier ones are UNCHECKED. */
export const LANE_REQUIRED_FROM = 172;
/** The FIX that introduced the fields — named in the UNCHECKED line. */
export const LANE_FIX = "FIX-1242";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const FIX_ID_RE = /^FIX-\d+$/;
export const ATTENDED = new Set(["supervised", "unattended-ok"]);
export const POSTURES = new Set(["code-only", "prod-reads", "prod-writes"]);
export const STEP_KINDS = new Set(["cc", "design", "receipt", "op", "decision"]);
/**
 * A plan file's stated status. `archived` (FIX-1243 D4) hides the plan from the
 * board entirely; `done` is also DERIVED — a plan whose steps are all done
 * renders as done whatever it says, with a lint line when the two disagree.
 */
export const PROJECT_STATUSES = new Set(["active", "planned", "done", "archived"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A calendar date (`2026-09-29`) or an ISO instant WITH a zone
 * (`2026-09-29T16:30Z`). A zoneless instant is refused: the board renders in
 * UTC, and a local-time instant would silently shift by the writer's offset.
 */
export function isDateish(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (DATE_RE.test(s)) return !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (INSTANT_RE.test(s)) return !Number.isNaN(Date.parse(s));
  return false;
}

/** The epoch-ms of a dateish value (a bare date is 00:00 UTC), or NaN. */
export function dateishMs(v) {
  if (!isDateish(v)) return Number.NaN;
  const s = v.trim();
  return DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
}

/** Whether a dateish value carries a time of day (vs a bare date). */
export const hasTime = (v) => typeof v === "string" && v.includes("T");

const DEP_RE = /^cc-([1-9]\d*)$/;

/**
 * A prompt's `when:` (FIX-1243 D5, FIX-1451). Six forms:
 *   any                              → {kind: "any"}
 *   2026-09-29 | 2026-09-29T16:30Z   → {kind: "at", start}
 *   after 2026-09-29T16:30Z          → {kind: "after", deps: [], start}   (a date works too)
 *   after cc-317[, cc-303][, <ISO>]  → {kind: "after", deps: [303, 317], start?}
 *   2026-10-01T23:15Z..2026-10-02T03:30Z → {kind: "window", start, end}
 *   (absent)                         → {kind: "none"}
 * anything else → {kind: "invalid", reason}. Every instant must carry a zone
 * (isDateish): a local time would shift by the writer's offset. `start`/`end`
 * are the raw strings; `startMs`/`endMs` their epoch ms (a bare date is 00:00
 * UTC, and a bare-date window END is the end of that day).
 *
 * A `when:` is a condition, never an estimate (Craig, 2026-11-25): an `after`
 * names the prompts it waits on (`deps`, ascending, de-duplicated) and carries
 * an instant only for a timed receipt or a span to avoid — at most one, and
 * `start`/`startMs`/`timed` are present only when it does. whenStatus() below
 * says whether the condition holds.
 */
export function parseWhen(v) {
  if (v === undefined || v === null || v === "") return { kind: "none" };
  if (typeof v !== "string") return { kind: "invalid", reason: "not a string" };
  const s = v.trim();
  if (s === "any") return { kind: "any" };
  if (isDateish(s)) return { kind: "at", start: s, startMs: dateishMs(s), timed: hasTime(s) };
  const after = /^after\s+(.+)$/.exec(s);
  if (after) {
    const deps = new Set();
    let start = null;
    for (const raw of after[1].split(",")) {
      const item = raw.trim();
      if (!item) return { kind: "invalid", reason: "after has an empty item" };
      const dep = DEP_RE.exec(item);
      if (dep) deps.add(Number(dep[1]));
      else if (isDateish(item)) {
        if (start !== null) return { kind: "invalid", reason: `after names two instants (\`${start}\`, \`${item}\`); at most one` };
        start = item;
      } else return { kind: "invalid", reason: `after \`${item}\` is not cc-<n>, a date or a zoned ISO instant` };
    }
    const w = { kind: "after", deps: [...deps].sort((a, b) => a - b) };
    return start === null ? w : { ...w, start, startMs: dateishMs(start), timed: hasTime(start) };
  }
  const win = /^(\S+)\s*\.\.\s*(\S+)$/.exec(s);
  if (win) {
    const [, a, b] = win;
    if (!isDateish(a) || !isDateish(b)) return { kind: "invalid", reason: "a window's ends must be dates or zoned ISO instants" };
    const startMs = dateishMs(a);
    const endMs = hasTime(b) ? dateishMs(b) : dateishMs(b) + 86_400_000;
    if (!(endMs > startMs)) return { kind: "invalid", reason: "a window must end after it starts" };
    return { kind: "window", start: a, end: b, startMs, endMs, timed: hasTime(a) };
  }
  return { kind: "invalid", reason: "not `any`, a date, a zoned instant, `after <cc-n | ISO>, …` or `<ISO>..<ISO>`" };
}

/** An epoch-ms as `2026-11-26T01:12:13Z` — what a status reason prints. */
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Whether a parsed `when:` holds now (FIX-1451 D2) — the one status cc:prompt,
 * /cc and the board share. Pure.
 *
 *   reportFinishedMs(n) → the report's `finished_at` in ms; `null` when the
 *     report exists without a readable one; `undefined` when there is no report.
 *     A report existing is the whole signal (D3): whether the dependency did
 *     what the dependent needs stays a Phase 0 read in that prompt.
 *
 * Returns { ready, waiting_on, opens_ms, reason }, or null for `invalid` (that
 * stays a `problems` line):
 *   none · any · at   ready — an `at` is a plan, not a bound
 *   after             waiting_on = the deps with no report (`cc-<n>`); ready
 *                     when that is empty and now is at or past the instant, if
 *                     there is one; opens_ms = the latest of the instant and
 *                     the deps' finished_at once every dep has reported, else
 *                     null
 *   window            ready only inside it
 */
export function whenStatus(w, { nowMs = Date.now(), reportFinishedMs = () => undefined } = {}) {
  if (!w || w.kind === "invalid") return null;
  const ok = (reason, opens_ms = null) => ({ ready: true, waiting_on: [], opens_ms, reason });
  if (w.kind === "none") return ok("no when");
  if (w.kind === "any") return ok("any time");
  if (w.kind === "at") return ok(`planned for ${w.start} (an at is a plan, not a bound)`);
  if (w.kind === "window") {
    const st = { waiting_on: [], opens_ms: w.startMs };
    if (nowMs < w.startMs) return { ready: false, ...st, reason: `not open until ${w.start}` };
    if (nowMs >= w.endMs) return { ready: false, ...st, reason: `closed at ${w.end}` };
    return { ready: true, ...st, reason: `open until ${w.end}` };
  }
  // after
  const deps = w.deps ?? [];
  const finished = deps.map((n) => ({ n, ms: reportFinishedMs(n) }));
  const waiting_on = finished.filter((d) => d.ms === undefined).map((d) => `cc-${d.n}`);
  const hasStart = typeof w.startMs === "number";
  const future = hasStart && nowMs < w.startMs;
  const notBefore = future ? `not before ${w.start}` : "";
  if (waiting_on.length) {
    return { ready: false, waiting_on, opens_ms: null, reason: [`waits on ${waiting_on.join(", ")}`, notBefore].filter(Boolean).join(" · ") };
  }
  const known = [...(hasStart ? [w.startMs] : []), ...finished.map((d) => d.ms).filter((ms) => typeof ms === "number")];
  const opens_ms = known.length ? Math.max(...known) : null;
  if (future) return { ready: false, waiting_on, opens_ms, reason: notBefore };
  if (!deps.length) return { ready: true, waiting_on, opens_ms, reason: `open since ${w.start}` };
  const reported = `${deps.map((n) => `cc-${n}`).join(", ")} reported`;
  return { ready: true, waiting_on, opens_ms, reason: opens_ms === null ? reported : `${reported} · ready since ${isoSec(opens_ms)}` };
}

const isBlank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Check a `lane` value. Returns null when fine, else a reason.
 * `planOnlyAllowed` is true for plan files, false for prompts and reports.
 */
export function laneProblem(lane, lanes = DEFAULT_LANES, { planOnlyAllowed = false } = {}) {
  if (typeof lane !== "string" || !lane.trim()) return "not a single lane name";
  if (!lanes.includes(lane)) return `\`${lane}\` is not one of cc.config.json's lanes (${lanes.join(", ")})`;
  if (!planOnlyAllowed && PLAN_ONLY_LANES.has(lane)) return `\`${lane}\` is a plan-step lane only`;
  return null;
}

/**
 * Check one `owed:` entry — `{fix: FIX-969, what: "…", after: <date|instant>}`.
 * Returns null when fine, else a reason. `after` is required: an owed receipt
 * with no date cannot be placed on the week, and "owed eventually" is not a
 * claim anyone can check.
 */
export function owedProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "not a {fix, what, after} map";
  }
  if (typeof entry.fix !== "string" || !FIX_ID_RE.test(entry.fix.trim())) {
    return `fix \`${entry.fix ?? ""}\` does not match FIX-NNN`;
  }
  if (isBlank(entry.after)) return "after missing";
  if (!isDateish(entry.after)) return `after \`${entry.after}\` is not a date or a zoned ISO instant`;
  return null;
}

/**
 * Split a prompt's text into its front matter block (raw, or null) and body.
 * A prompt without front matter (every one before cc-171) is legal.
 */
export function splitFrontMatter(text) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (!m) return { hasFrontMatter: false, body: t };
  return { hasFrontMatter: true, body: t.slice(m[0].length) };
}

/**
 * The first `# ` heading after the front matter, with a leading `cc-<n> — `
 * dropped (the card shows the number already), trimmed to `max` chars.
 */
export function headingTitle(text, max = 160) {
  const { body } = splitFrontMatter(text);
  const line = body.split("\n").find((l) => /^#\s+\S/.test(l));
  if (!line) return "";
  const t = line
    .replace(/^#\s+/, "")
    .replace(/^cc-\d+\s*[:—–-]\s*/i, "")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Check a prompt's parsed front matter (null when it has none).
 * Returns { abort, problems }:
 *   abort    — non-null means `/cc` must not run it (a cc number that
 *              disagrees with the filename: two files think they are different
 *              runs, and running the wrong one is worse than asking).
 *   problems — shape issues, reported but not fatal.
 */
export function checkPromptFrontMatter(fm, { n, lanes = DEFAULT_LANES, projectExists } = {}) {
  const problems = [];
  if (!fm) return { abort: null, problems: ["no front matter (pre-cc-171 prompt)"] };

  let abort = null;
  if (isBlank(fm.cc)) problems.push("no `cc:` — proceed, but say so");
  else if (n !== undefined && Number(fm.cc) !== Number(n)) {
    abort = `front matter says cc: ${fm.cc}, the filename says ${n}`;
  }

  if (isBlank(fm.lane)) problems.push("no `lane:`");
  else {
    const p = laneProblem(fm.lane, lanes);
    if (p) problems.push(`lane: ${p}`);
  }

  if (!isBlank(fm.project)) {
    const slug = String(fm.project);
    if (!SLUG_RE.test(slug)) problems.push(`project: \`${slug}\` is not a slug`);
    else if (projectExists && !projectExists(slug)) problems.push(`project: no docs/cc/projects/${slug}.md`);
  }

  if (!isBlank(fm.when)) {
    const w = parseWhen(fm.when);
    if (w.kind === "invalid") problems.push(`when: \`${fm.when}\` — ${w.reason}`);
    const self = Number(n ?? fm.cc);
    if (w.kind === "after" && w.deps.includes(self)) problems.push(`when: \`${fm.when}\` names this prompt (cc-${self})`);
  }
  if (!isBlank(fm.attended) && !ATTENDED.has(fm.attended)) {
    problems.push(`attended: \`${fm.attended}\` is not one of ${[...ATTENDED].join(" | ")}`);
  }
  if (!isBlank(fm.posture) && !POSTURES.has(fm.posture)) {
    problems.push(`posture: \`${fm.posture}\` is not one of ${[...POSTURES].join(" | ")}`);
  }
  if (fm.concurrent_with !== undefined) {
    const list = Array.isArray(fm.concurrent_with) ? fm.concurrent_with : [fm.concurrent_with];
    const bad = list.filter((x) => !/^\d+$/.test(String(x).trim()));
    if (bad.length) problems.push(`concurrent_with: not cc numbers — ${bad.join(", ")}`);
  }
  return { abort, problems };
}
