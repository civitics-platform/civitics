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
export const PROJECT_STATUSES = new Set(["active", "planned", "done"]);

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

  if (!isBlank(fm.when) && fm.when !== "any" && !isDateish(fm.when)) {
    problems.push(`when: \`${fm.when}\` is not \`any\`, a date, or a zoned ISO instant`);
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
