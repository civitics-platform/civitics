#!/usr/bin/env node
// scripts/board.mjs — `pnpm board` (FIX-1242)
//
// Render the CC loop's lane board — a projects strip, an 8-column UTC week and
// five lanes — from the tree alone, as two files in <boardDir> (outside the
// repo, beside the prompts): board.json (the whole derived model) and
// index.html (one self-contained page, inline CSS, no external fonts/scripts).
//
// It reads, in this order and nothing else:
//   loadCcConfig()                     lanes, promptsDir, reportsDir, boardDir
//   docs/done.log + FIXES.md + archive open count, owed/step receipts (fix-status.mjs)
//   docs/cc/reports/cc-*.json|.md      the sidecar, else the .md (flagged)
//   every cc-prompt-<n>-*.md           front matter via THE reader (parseFrontMatter)
//   <promptsDir>/cc-<n>.running        in-flight markers
//   docs/cc/projects/*.md              plan files
//   docs/cc/lanes-backfill.json        lanes for cc-162…170, which predate `lane:`
//   docs/receipts/<latest day>.json    prod state AS OF its generated_at
//   .claude/board.local.json           supervised windows, if present (untracked)
//
// It never opens a database connection: the receipts file is the instrument,
// and the page says what time it describes. It never fetches and never calls
// gh — each report in the window is checked by cc-verify's own verifyReport()
// against the LOCAL trunk ref, with CI left UNCHECKED (`pnpm cc:verify <n>` is
// where CI is cross-checked). That keeps the output a function of the tree and
// `--now`: same tree + same --now → byte-identical files.
//
// Usage:
//   pnpm board                     write board.json + index.html
//   pnpm board --json              write only board.json
//   pnpm board --dry-run           print board.json to stdout, write nothing
//   pnpm board --now 2026-09-28T04:00:00Z
//
// Exit 0 always, except on a read error.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontMatter, loadReportFrontMatter, verifyReport, buildVerifyContext, FAIL, PASS, UNCHECKED } from "./cc-verify.mjs";
import { parseDoneLog, deriveStatus, buildUniverse, REOPEN_SHA } from "./lib/fix-status.mjs";
import { loadCcConfig, listPromptFiles } from "./lib/cc-config.mjs";
import {
  DEFAULT_LANES,
  PLAN_ONLY_LANES,
  STEP_KINDS,
  PROJECT_STATUSES,
  SLUG_RE,
  FIX_ID_RE,
  isDateish,
  dateishMs,
  hasTime,
  headingTitle,
  splitFrontMatter,
  checkPromptFrontMatter,
  laneProblem,
  owedProblem,
} from "./lib/cc-front-matter.mjs";

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 14;
export const STALE_MARKER_MS = 24 * 3_600_000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The reference render's palette (docs: board-reference-2026-09-27.html).
const LANE_COLORS = { ops: "#3b5bdb", fec: "#b45309", app: "#0f766e", hygiene: "#6b6a63", design: "#7c3aed" };
const laneColor = (l) => LANE_COLORS[l] ?? "#888888";

// ── small pure helpers ──────────────────────────────────────────────────────

const str = (v) => (v === undefined || v === null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);
const ids = (v) => list(v).map((x) => str(x).trim()).filter((x) => FIX_ID_RE.test(x));
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const utcMidnight = (ms) => Date.parse(`${isoDate(ms)}T00:00:00Z`);
const trim = (s, n) => (str(s).length > n ? `${str(s).slice(0, n - 1).trimEnd()}…` : str(s));
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** "2026-09-27T23:31:31.143Z" → "2026-09-27 23:31 UTC". */
const humanUtc = (v) => {
  const ms = Date.parse(str(v));
  return Number.isNaN(ms) ? str(v) : `${isoDate(ms)} ${hhmm(ms)} UTC`;
};

export function escapeHtml(v) {
  return str(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const esc = escapeHtml;

/** The newest `YYYY-MM-DD.json` — the nominal-day rule: latest = max filename. `bands.json` is not a day. */
export function latestReceiptName(names) {
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(byStr).pop() ?? "";
}

/** A `.running` marker's state at `nowMs`. */
export function markerState(marker, nowMs) {
  const started = Date.parse(str(marker?.started_at));
  if (Number.isNaN(started)) return { state: "running · stale?", age_hours: -1 };
  const age = nowMs - started;
  return {
    state: age > STALE_MARKER_MS ? "running · stale?" : "running",
    age_hours: Math.round((age / 3_600_000) * 10) / 10,
  };
}

// ── cron (pg_cron's five fields, UTC) ───────────────────────────────────────

function parseCronField(f, lo, hi) {
  if (f === "*") return { any: true, stepped: false, values: null };
  const values = new Set();
  let stepped = false;
  for (const part of f.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let a;
    let b;
    if (m[1] === "*") [a, b] = [lo, hi];
    else if (m[1].includes("-")) [a, b] = m[1].split("-").map(Number);
    else [a, b] = [Number(m[1]), m[2] ? hi : Number(m[1])];
    const step = m[2] ? Number(m[2]) : 1;
    if (m[2]) stepped = true;
    if (!(step > 0)) return null;
    for (let v = a; v <= b; v += step) values.add(v);
  }
  return { any: false, stepped, values };
}

/**
 * Parse a 5-field schedule. `daily` means fields 3–5 are all `*` (it fires
 * every day, so it would flood a week grid and is not drawn). `mode`:
 *   "each" — a weekday/month-restricted job at fixed times: every firing in the
 *            window is drawn (`0 15 * * 2` → Tue 15:00).
 *   "next" — a day-of-month job, or one whose minute/hour field is `*` or
 *            `*\/N`: drawn once, on its next occurrence (or in `later`).
 */
export function parseCron(schedule) {
  const f = str(schedule).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = [
    parseCronField(f[0], 0, 59),
    parseCronField(f[1], 0, 23),
    parseCronField(f[2], 1, 31),
    parseCronField(f[3], 1, 12),
    parseCronField(f[4], 0, 7),
  ];
  if (!mi || !ho || !dom || !mon || !dow) return null;
  if (dow.values?.has(7)) dow.values.add(0);
  const daily = f[2] === "*" && f[3] === "*" && f[4] === "*";
  const subDaily = mi.any || ho.any || mi.stepped || ho.stepped;
  const mode = subDaily || f[2] !== "*" ? "next" : "each";
  const times = [];
  if (!mi.any && !ho.any) {
    for (const h of [...ho.values].sort((a, b) => a - b)) {
      for (const m of [...mi.values].sort((a, b) => a - b)) times.push(`${pad2(h)}:${pad2(m)}`);
    }
  }
  const matchesDay = (ms) => {
    const d = new Date(ms);
    if (!mon.any && !mon.values.has(d.getUTCMonth() + 1)) return false;
    const domR = f[2] !== "*";
    const dowR = f[4] !== "*";
    const domOk = domR && dom.values.has(d.getUTCDate());
    const dowOk = dowR && dow.values.has(d.getUTCDay());
    if (domR && dowR) return domOk || dowOk; // Vixie cron: either restriction fires
    if (domR) return domOk;
    if (dowR) return dowOk;
    return true;
  };
  return { raw: f.join(" "), daily, subDaily, mode, times, matchesDay, firstTime: times[0] ?? (ho.any ? "00:00" : `${pad2(Math.min(...ho.values))}:00`) };
}

/**
 * The events a job contributes to the week that starts at `todayMs` (UTC
 * midnight): `[{date, time, label}]`, plus `later` for a next-occurrence job
 * that does not fire inside the seven days.
 */
export function cronEvents(cron, todayMs, days = 7) {
  const out = [];
  if (!cron || cron.daily) return out;
  if (cron.mode === "each") {
    for (let i = 0; i < days; i++) {
      const ms = todayMs + i * DAY_MS;
      if (cron.matchesDay(ms)) for (const t of cron.times) out.push({ date: isoDate(ms), time: t });
    }
    if (out.length) return out;
  }
  for (let i = 0; i < 400; i++) {
    const ms = todayMs + i * DAY_MS;
    if (cron.matchesDay(ms)) return [{ date: isoDate(ms), time: cron.firstTime }];
  }
  return out;
}

// ── supervised windows (.claude/board.local.json) ───────────────────────────

function tzParts(tz, ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    wall: Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour") % 24, +get("minute")),
    abbr: get("timeZoneName"),
  };
}

/** A local wall time on a calendar date in `tz` → the UTC instant, and the zone's abbreviation then. */
export function localToUtc(tz, dateStr, time) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - (tzParts(tz, guess).wall - guess);
  return { ms: guess, abbr: tzParts(tz, guess).abbr };
}

/** The footer line for one UTC column date, or "" when the file has no entry for that weekday. */
export function supervisedLine(local, dateStr) {
  if (!local || typeof local !== "object" || !local.supervised || !local.tz) return "";
  const key = DOW_KEYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  const v = local.supervised[key];
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return `supervised · ${v}`;
  if (!Array.isArray(v) || v.length === 0) return "";
  const spans = [];
  for (const w of v) {
    if (!Array.isArray(w) || w.length !== 2 || !/^\d{2}:\d{2}$/.test(w[0]) || !/^\d{2}:\d{2}$/.test(w[1])) continue;
    const a = localToUtc(local.tz, dateStr, w[0]);
    let b = localToUtc(local.tz, dateStr, w[1]);
    if (b.ms <= a.ms) b = { ...b, ms: b.ms + DAY_MS };
    spans.push(`${hhmm(a.ms)}–${hhmm(b.ms)} UTC (${w[0]}–${w[1]} ${a.abbr})`);
  }
  return spans.length ? `supervised ${spans.join(", ")}` : "";
}

// ── reading the tree ────────────────────────────────────────────────────────

/** Where every input lives, for the real repo. */
export function resolvePaths(cfg = loadCcConfig()) {
  const root = cfg.repoRoot;
  return {
    reportsDir: cfg.reportsDir,
    promptsDir: cfg.promptsDir,
    projectsDir: cfg.projectsDir,
    boardDir: cfg.boardDir,
    backfillPath: resolve(root, "docs/cc/lanes-backfill.json"),
    receiptsDir: resolve(root, "docs/receipts"),
    doneLogPath: resolve(root, "docs/done.log"),
    fixesPath: resolve(root, "docs/FIXES.md"),
    archivePath: resolve(root, "docs/archive/fixes-archive.md"),
    // Machine-local and untracked → the primary checkout, like promptsDir.
    localPath: resolve(cfg.mainCheckoutRoot, ".claude/board.local.json"),
    // Links point at the PRIMARY checkout's reports — the human view — so the
    // page is the same whichever worktree rendered it.
    reportLinkDir: resolve(cfg.mainCheckoutRoot, "docs/cc/reports"),
    projectLinkDir: resolve(cfg.mainCheckoutRoot, "docs/cc/projects"),
  };
}

const readText = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");
function readJson(p) {
  if (!p || !existsSync(p)) return { value: undefined, error: "" };
  try {
    return { value: JSON.parse(readFileSync(p, "utf8")), error: "" };
  } catch (e) {
    return { value: undefined, error: `${p}: ${e.message}` };
  }
}

/** Read every input file. Throws only when a directory that must exist cannot be read. */
export function loadBoardInputs(paths) {
  const reports = [];
  if (existsSync(paths.reportsDir)) {
    const names = readdirSync(paths.reportsDir).filter((n) => /^cc-\d+\.md$/.test(n));
    for (const name of names) {
      const mdPath = resolve(paths.reportsDir, name);
      const n = Number(/\d+/.exec(name)[0]);
      const text = readFileSync(mdPath, "utf8");
      let loaded = null;
      let parseError = "";
      try {
        loaded = loadReportFrontMatter(mdPath);
      } catch (e) {
        parseError = e.message;
      }
      reports.push({ n, name, mdPath, text, loaded, parseError });
    }
  }
  const prompts = listPromptFiles({ promptsDir: paths.promptsDir }).map((p) => ({ ...p, text: readText(p.path) }));
  const markers = [];
  if (existsSync(paths.promptsDir)) {
    for (const name of readdirSync(paths.promptsDir).filter((n) => /^cc-\d+\.running$/.test(n))) {
      const { value, error } = readJson(resolve(paths.promptsDir, name));
      markers.push({ n: Number(/\d+/.exec(name)[0]), name, body: value ?? {}, error });
    }
  }
  const plans = [];
  if (existsSync(paths.projectsDir)) {
    for (const name of readdirSync(paths.projectsDir).filter((n) => n.endsWith(".md")).sort(byStr)) {
      const path = resolve(paths.projectsDir, name);
      const text = readFileSync(path, "utf8");
      let fm = null;
      let parseError = "";
      try {
        fm = parseFrontMatter(text);
      } catch (e) {
        parseError = e.message;
      }
      plans.push({ name, path, fm, parseError });
    }
  }
  const backfill = readJson(paths.backfillPath);
  let receipt = null;
  if (existsSync(paths.receiptsDir)) {
    const name = latestReceiptName(readdirSync(paths.receiptsDir));
    if (name) {
      const { value, error } = readJson(resolve(paths.receiptsDir, name));
      receipt = { name, json: value ?? {}, error };
    }
  }
  const local = readJson(paths.localPath);
  return {
    reports,
    prompts,
    markers,
    plans,
    backfill: backfill.value && typeof backfill.value === "object" ? backfill.value : {},
    receipt,
    local: local.value && typeof local.value === "object" ? local.value : null,
    localError: local.error,
    doneLogText: readText(paths.doneLogPath),
    fixesText: readText(paths.fixesPath),
    archiveText: readText(paths.archivePath),
    readErrors: [backfill.error, receipt?.error ?? ""].filter(Boolean),
  };
}

// ── deriving the board ──────────────────────────────────────────────────────

function doneRowsFor(statusMap, id) {
  return (statusMap.get(id)?.rows ?? []).filter((r) => r.sha !== REOPEN_SHA);
}

/**
 * Derive a plan step's status. Returns { status, done, label }.
 * `ctx` = { nowMs, reportState(n), markerFor(n), hasPrompt(n), statusMap }.
 */
export function stepStatus(step, ctx) {
  const after = isDateish(step.after) ? dateishMs(step.after) : Number.NaN;
  const gated = !Number.isNaN(after) && after > ctx.nowMs;
  const gatedLabel = gated ? `gated · ${str(step.after).slice(0, 10)}` : "";
  const kind = str(step.kind);
  const ref = str(step.ref);

  if (kind === "cc") {
    const m = /^cc-(\d+)$/.exec(ref);
    if (m) {
      const n = Number(m[1]);
      const rs = ctx.reportState(n);
      if (rs === "pass") return { status: "done", done: true, label: `${ref} ✓` };
      if (rs === "fail") return { status: "landed · verify FAILs", done: false, label: ref };
      const mk = ctx.markerFor(n);
      if (mk) return { status: markerState(mk, ctx.nowMs).state, done: false, label: ref };
      if (gated) return { status: gatedLabel, done: false, label: ref };
      if (ctx.hasPrompt(n)) return { status: "drafted", done: false, label: ref };
      return { status: "planned", done: false, label: ref };
    }
    return { status: gated ? gatedLabel : "planned", done: false, label: "" };
  }
  if (kind === "receipt" || kind === "op") {
    if (FIX_ID_RE.test(ref)) {
      const floor = Number.isNaN(after) ? "" : isoDate(after);
      const row = doneRowsFor(ctx.statusMap, ref).find((r) => r.date >= floor);
      if (row) return { status: "done", done: true, label: `${ref} ✓ ${row.date}`, done_date: row.date };
    }
    return { status: gated ? gatedLabel : "planned", done: false, label: ref };
  }
  // design / decision: artefacts outside the repo — done only when hand-stated.
  if (isDateish(step.done)) return { status: "done", done: true, label: `${ref || kind} ✓`, done_date: str(step.done) };
  return { status: gated ? gatedLabel : "planned", done: false, label: ref };
}

function planProblems(plan, lanes) {
  const out = [];
  const fm = plan.fm ?? {};
  const slug = str(fm.slug);
  const fileSlug = plan.name.replace(/\.md$/, "");
  if (plan.parseError) out.push(`front matter did not parse: ${plan.parseError}`);
  if (!SLUG_RE.test(slug)) out.push(`slug \`${slug}\` is not a slug`);
  else if (slug !== fileSlug) out.push(`slug \`${slug}\` ≠ filename \`${fileSlug}\``);
  if (!PROJECT_STATUSES.has(str(fm.status))) out.push(`status \`${str(fm.status)}\` is not active | planned | done`);
  for (const l of list(fm.lanes)) {
    const p = laneProblem(l, lanes, { planOnlyAllowed: true });
    if (p) out.push(`lanes: ${p}`);
  }
  list(fm.steps).forEach((s, i) => {
    if (!s || typeof s !== "object") return void out.push(`steps[${i}] is not a map`);
    if (!STEP_KINDS.has(str(s.kind))) out.push(`steps[${i}] kind \`${str(s.kind)}\` is not cc|design|receipt|op|decision`);
    if (s.after !== undefined && s.after !== "" && !isDateish(s.after)) out.push(`steps[${i}] after \`${s.after}\` is not a date`);
    if (s.done !== undefined && s.done !== "" && !isDateish(s.done)) out.push(`steps[${i}] done \`${s.done}\` is not a date`);
  });
  return out;
}

/**
 * The whole derived model. Pure: every input is in `inputs`, `now` is given,
 * and `verify(fm, loaded)` is injected (the real one is cc-verify's
 * verifyReport over one batch context; the tests inject a fixture tree).
 */
export function buildBoard(inputs, { nowMs, verify, lanes = DEFAULT_LANES, head = "", paths = {} }) {
  const statusMap = deriveStatus(parseDoneLog(inputs.doneLogText));
  const universe = buildUniverse({ statusMap, fixesText: inputs.fixesText, archiveText: inputs.archiveText });
  const openCount = universe.filter((id) => (statusMap.get(id)?.status ?? "open") === "open").length;
  const maxId = universe[universe.length - 1] ?? "";
  const todayMs = utcMidnight(nowMs);
  const windowFromMs = nowMs - WINDOW_DAYS * DAY_MS;
  const reportLanes = lanes.filter((l) => !PLAN_ONLY_LANES.has(l));
  const link = (p) => (p ? pathToFileURL(p).href : "");
  const diagnostics = {
    reports_total: inputs.reports.length,
    reports_without_finished_at: [],
    sidecar_missing: [],
    sidecar_drift: [],
    prompts_total: inputs.prompts.length,
    prompts_duplicate_numbers: [],
    legacy_prompts_skipped: 0,
    cron_drawn: [],
    cron_later: [],
    cron_inactive: [],
    cron_daily_not_drawn: 0,
    cron_unparsed: [],
    read_errors: [...inputs.readErrors],
    local_file: inputs.local ? "present" : inputs.localError ? `unreadable — ${inputs.localError}` : "absent",
  };

  // Prompts by number (a tie is kept and flagged; names sort deterministically).
  const promptsByN = new Map();
  for (const p of inputs.prompts) (promptsByN.get(p.n) ?? promptsByN.set(p.n, []).get(p.n)).push(p);
  const promptInfo = new Map(); // name → { fm, title, problems }
  const readPromptInfo = (p, n) => {
    if (!promptInfo.has(p.name)) {
      const { hasFrontMatter } = splitFrontMatter(p.text);
      let fm = null;
      const extra = [];
      if (hasFrontMatter) {
        try {
          fm = parseFrontMatter(p.text);
        } catch (e) {
          extra.push(`front matter did not parse: ${e.message}`);
        }
      }
      const chk = checkPromptFrontMatter(fm, {
        n,
        lanes,
        projectExists: (slug) => inputs.plans.some((pl) => pl.name === `${slug}.md`),
      });
      const problems = [...extra, ...chk.problems.filter((x) => !/^no front matter/.test(x))];
      if (chk.abort) problems.unshift(chk.abort);
      promptInfo.set(p.name, { fm, title: headingTitle(p.text), problems, hasFrontMatter: !!fm });
    }
    return promptInfo.get(p.name);
  };
  const markersByN = new Map(inputs.markers.map((m) => [m.n, m]));

  // Reports: parse, window, verify.
  const reportByN = new Map();
  for (const r of inputs.reports) reportByN.set(r.n, r);
  const maxReportN = inputs.reports.reduce((a, r) => Math.max(a, r.n), 0);
  const inWindow = [];
  for (const r of [...inputs.reports].sort((a, b) => a.n - b.n)) {
    const fm = r.loaded?.fm;
    const fin = Date.parse(str(fm?.finished_at));
    if (!fm || Number.isNaN(fin)) {
      diagnostics.reports_without_finished_at.push(`cc-${r.n}${r.parseError ? ` (${r.parseError})` : ""}`);
      continue;
    }
    if (fin >= windowFromMs) inWindow.push({ ...r, finMs: fin });
  }
  const floor = inWindow.length ? Math.min(...inWindow.map((r) => r.n)) : maxReportN + 1;

  // A verify result per report in the window — and, for plan steps, per report
  // a step names even when it is older than the window.
  const verifyCache = new Map();
  const verified = (r) => {
    if (!verifyCache.has(r.n)) {
      let res;
      if (!r.loaded) res = { pass: 0, fail: 1, unchecked: 0, fails: [`front matter: ${r.parseError}`] };
      else {
        const results = verify(r.loaded.fm, r.loaded);
        res = {
          pass: results.filter((x) => x.verdict === PASS).length,
          fail: results.filter((x) => x.verdict === FAIL).length,
          unchecked: results.filter((x) => x.verdict === UNCHECKED).length,
          fails: results.filter((x) => x.verdict === FAIL).map((x) => `${x.claim}${x.detail ? ` — ${x.detail}` : ""}`),
        };
      }
      verifyCache.set(r.n, res);
    }
    return verifyCache.get(r.n);
  };

  // ── cards ──
  const cards = [];
  const cardFor = (n, report) => {
    const candidates = promptsByN.get(n) ?? [];
    const named = report?.loaded?.fm?.prompt ? candidates.find((p) => p.name === str(report.loaded.fm.prompt)) : null;
    const prompt = named ?? candidates[0] ?? null;
    const pinfo = prompt ? readPromptInfo(prompt, n) : { fm: null, title: "", problems: [], hasFrontMatter: false };
    const pfm = pinfo.fm ?? {};
    const problems = [...pinfo.problems];
    if (candidates.length > 1) problems.push(`${candidates.length} prompt files for cc-${n}`);
    const card = {
      cc: n,
      lane: "",
      lane_source: "none",
      project: "",
      state: "",
      group: "",
      title: pinfo.title,
      prompt_file: prompt?.name ?? "",
      prompt_link: link(prompt?.path),
      report_link: "",
      when: str(pfm.when),
      attended: str(pfm.attended),
      posture: str(pfm.posture),
      fixes_closed: [],
      fixes_filed: [],
      fixes_reopened: [],
      migrations: 0,
      prod_writes: "",
      owed: [],
      stops: 0,
      verify: { pass: 0, fail: 0, unchecked: 0, fails: [] },
      finished_at: "",
      sidecar: "",
      problems,
    };

    const fm = report?.loaded?.fm;
    // Lane: the report's own, else the prompt's, else the backfill map.
    const pick = (v, source) => {
      if (card.lane_source !== "none" || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
      const why = laneProblem(v, lanes);
      if (why) {
        problems.push(`lane (${source}): ${why}`);
        card.lane_source = `${source} (invalid)`;
        return;
      }
      card.lane = str(v);
      card.lane_source = source;
    };
    if (fm) pick(fm.lane, "report");
    pick(pfm.lane, "prompt");
    pick(inputs.backfill[String(n)], "backfill");
    const project = str(fm?.project || pfm.project);
    card.project = SLUG_RE.test(project) ? project : "";

    if (report) {
      card.report_link = link(resolve(paths.reportLinkDir ?? paths.reportsDir ?? ".", `cc-${n}.md`));
      if (!card.title) card.title = headingTitle(report.text);
      if (!fm) {
        card.state = "landed · verify FAILs";
        card.group = "landed";
        card.verify = verified(report);
        return card;
      }
      card.finished_at = str(fm.finished_at);
      card.sidecar = report.loaded.source;
      if (report.loaded.source === "md") diagnostics.sidecar_missing.push(`cc-${n}`);
      if (report.loaded.drift) diagnostics.sidecar_drift.push(`cc-${n}`);
      card.fixes_closed = ids(fm.fixes_closed);
      card.fixes_filed = ids(fm.fixes_filed);
      card.fixes_reopened = ids(fm.fixes_reopened);
      card.migrations = list(fm.migrations_pushed).filter((x) => typeof x === "string" && x.trim()).length;
      card.prod_writes = /^none$/i.test(str(fm.prod_writes).trim()) ? "none" : str(fm.prod_writes).trim() ? "stated" : "";
      card.stops = list(fm.stopped_items).filter((x) => str(x).trim()).length;
      const finDate = str(fm.finished_at).slice(0, 10);
      card.owed = (Array.isArray(fm.owed) ? fm.owed : []).map((o) => {
        const bad = owedProblem(o);
        const fix = str(o?.fix);
        const row = bad ? null : doneRowsFor(statusMap, fix).find((x) => x.date >= finDate);
        return {
          fix,
          what: str(o?.what),
          after: str(o?.after),
          outstanding: !row,
          received: row ? row.date : "",
          problem: bad ?? "",
        };
      });
      card.verify = verified(report);
      if (card.verify.fail > 0) [card.state, card.group] = ["landed · verify FAILs", "landed"];
      else if (card.owed.some((o) => o.outstanding)) [card.state, card.group] = ["owed", "verified"];
      else [card.state, card.group] = ["closed", "verified"];
      return card;
    }

    const mk = markersByN.get(n);
    if (mk) {
      const ms = markerState(mk.body, nowMs);
      card.state = ms.state;
      card.marker_started_at = str(mk.body.started_at);
    } else {
      card.state = pinfo.hasFrontMatter ? "drafted" : "drafted · no front matter";
    }
    card.group = "in_flight";
    return card;
  };

  const seen = new Set();
  for (const r of inWindow) {
    cards.push(cardFor(r.n, r));
    seen.add(r.n);
  }
  for (const [n, list_] of [...promptsByN.entries()].sort((a, b) => a[0] - b[0])) {
    if (seen.has(n) || reportByN.has(n)) continue;
    const hasMarker = markersByN.has(n);
    const anyFm = list_.some((p) => readPromptInfo(p, n).hasFrontMatter);
    // A prompt with no report is in flight when it carries front matter (the
    // cc-171 shape), when a marker says it is running, or — for the legacy
    // shape — when its number sits inside the numbered range the reports
    // already cover. The last bound is what keeps four hundred prompts that
    // were run before reports existed (and the FIX-numbered cc-prompt-677…)
    // off the board.
    if (!hasMarker && !anyFm && !(n >= floor && n <= maxReportN)) {
      diagnostics.legacy_prompts_skipped += 1;
      continue;
    }
    if (list_.length > 1) diagnostics.prompts_duplicate_numbers.push(`cc-${n}`);
    cards.push(cardFor(n, null));
    seen.add(n);
  }
  // Markers with no prompt file at all still show — something is running.
  for (const m of [...inputs.markers].sort((a, b) => a.n - b.n)) {
    if (seen.has(m.n)) continue;
    const c = cardFor(m.n, reportByN.get(m.n) ?? null);
    c.problems.push("marker has no prompt file");
    cards.push(c);
    seen.add(m.n);
  }

  // ── projects ──
  const reportState = (n) => {
    const r = reportByN.get(n);
    if (!r) return "";
    return verified(r).fail > 0 ? "fail" : "pass";
  };
  const stepCtx = {
    nowMs,
    statusMap,
    reportState,
    markerFor: (n) => markersByN.get(n)?.body ?? null,
    hasPrompt: (n) => promptsByN.has(n),
  };
  const projects = inputs.plans.map((plan) => {
    const fm = plan.fm ?? {};
    const steps = list(fm.steps)
      .filter((s) => s && typeof s === "object")
      .map((s) => {
        const st = stepStatus(s, stepCtx);
        return {
          id: str(s.id),
          kind: str(s.kind),
          ref: str(s.ref),
          title: str(s.title),
          after: str(s.after),
          done_stated: str(s.done),
          status: st.status,
          done: st.done,
          done_date: st.done_date ?? "",
          label: st.label,
        };
      });
    const problems = planProblems(plan, lanes);
    for (const s of steps) {
      if ((s.kind === "op" || s.kind === "receipt") && s.done_stated && s.done_date && s.done_stated !== s.done_date) {
        // A stated date and the log's first qualifying row may differ legitimately
        // (a later row exists); flag only a stated date the log has no row on.
        const rows = doneRowsFor(statusMap, s.ref).map((r) => r.date);
        if (!rows.includes(s.done_stated)) problems.push(`${s.id}: done ${s.done_stated} but done.log dates ${rows.join(", ")}`);
      }
      if ((s.kind === "op" || s.kind === "receipt") && s.done_stated && !s.done) {
        problems.push(`${s.id}: done ${s.done_stated} stated, but done.log has no row for ${s.ref || "(no ref)"}`);
      }
    }
    const doneCount = steps.filter((s) => s.done).length;
    const current = steps.find((s) => !s.done) ?? null;
    return {
      slug: str(fm.slug) || plan.name.replace(/\.md$/, ""),
      title: str(fm.title),
      lanes: list(fm.lanes).map(str),
      status: str(fm.status),
      plan: str(fm.plan),
      file: plan.name,
      link: link(paths.projectLinkDir ? resolve(paths.projectLinkDir, plan.name) : plan.path),
      steps,
      done_count: doneCount,
      total: steps.length,
      current: current ? current.id : "",
      current_title: current ? current.title : "",
      current_status: current ? current.status : "",
      problems,
    };
  });

  // Queue: plan steps not done and not already a card.
  const queue = [];
  for (const p of projects) {
    const nonDesign = p.lanes.find((l) => reportLanes.includes(l));
    for (const s of p.steps) {
      if (s.done) continue;
      const m = /^cc-(\d+)$/.exec(s.ref);
      if (s.kind === "cc" && m && seen.has(Number(m[1]))) continue;
      const lane = s.kind === "design" ? "design" : nonDesign ?? (lanes.includes("design") ? "design" : lanes[0]);
      queue.push({ lane, project: p.slug, step: s.id, kind: s.kind, ref: s.ref, title: s.title, status: s.status, after: s.after });
    }
  }

  // ── lanes ──
  const groupOrder = { in_flight: 0, landed: 1, verified: 2 };
  const stateOrder = (c) =>
    ({ running: 0, "running · stale?": 1, drafted: 2, "drafted · no front matter": 3, "landed · verify FAILs": 4, owed: 5, closed: 6 })[c.state] ?? 9;
  const sortCards = (a, b) => groupOrder[a.group] - groupOrder[b.group] || stateOrder(a) - stateOrder(b) || b.cc - a.cc;
  const laneModels = lanes.map((name) => {
    const cs = cards.filter((c) => c.lane === name).sort(sortCards);
    const count = (g) => cs.filter((c) => c.group === g).length;
    return {
      name,
      color: laneColor(name),
      count: cs.length,
      in_flight: count("in_flight"),
      landed: count("landed"),
      verified: count("verified"),
      owed: cs.filter((c) => c.state === "owed").length,
      cards: cs,
      queue: queue.filter((q) => q.lane === name),
    };
  });
  const unlanedCards = cards.filter((c) => !lanes.includes(c.lane)).sort(sortCards);
  const unlaned = {
    count: unlanedCards.length,
    in_flight: unlanedCards.filter((c) => c.group === "in_flight").length,
    landed: unlanedCards.filter((c) => c.group === "landed").length,
    verified: unlanedCards.filter((c) => c.group === "verified").length,
    cards: unlanedCards,
  };

  // Rule 116: every card in exactly one place; each header's parts sum to it.
  const placed = laneModels.reduce((a, l) => a + l.count, 0) + unlaned.count;
  const reconciliation = {
    window_reports: inWindow.length,
    prompt_cards: cards.length - inWindow.length,
    cards: cards.length,
    placed,
    lanes_sum_ok: [...laneModels, unlaned].every((l) => l.in_flight + l.landed + l.verified === l.count),
    ok: placed === cards.length && new Set(cards.map((c) => c.cc)).size === cards.length,
  };
  reconciliation.ok = reconciliation.ok && reconciliation.lanes_sum_ok;

  // ── the week ──
  const days = Array.from({ length: 7 }, (_, i) => {
    const ms = todayMs + i * DAY_MS;
    const date = isoDate(ms);
    return {
      date,
      dow: DOW[new Date(ms).getUTCDay()],
      today: i === 0,
      events: [],
      supervised: supervisedLine(inputs.local, date),
    };
  });
  const later = [];
  const lastMs = todayMs + 6 * DAY_MS;
  const place = (ev, { overdueToToday = false } = {}) => {
    const ms = Date.parse(`${ev.date}T00:00:00Z`);
    if (ms < todayMs) {
      if (!overdueToToday) return;
      days[0].events.push({ ...ev, time: `overdue · ${ev.date.slice(5)}`, date: days[0].date });
      return;
    }
    if (ms > lastMs) later.push(ev);
    else days[Math.round((ms - todayMs) / DAY_MS)].events.push(ev);
  };
  const atOf = (v) => {
    const ms = dateishMs(v);
    return { date: isoDate(ms), time: hasTime(v) ? hhmm(ms) : "" };
  };
  for (const c of cards) {
    if (c.group === "in_flight" && isDateish(c.when)) {
      place({ ...atOf(c.when), kind: "run", lane: c.lane, label: `cc-${c.cc} · ${trim(c.title, 70)}` }, { overdueToToday: true });
    }
    for (const o of c.owed) {
      if (o.outstanding && isDateish(o.after)) {
        place(
          { ...atOf(o.after), kind: "receipt", lane: c.lane, label: `cc-${c.cc} owes ${o.fix}${o.what ? ` · ${trim(o.what, 60)}` : ""}` },
          { overdueToToday: true },
        );
      }
    }
  }
  for (const p of projects) {
    for (const s of p.steps) {
      if (s.done || !isDateish(s.after)) continue;
      place({ ...atOf(s.after), kind: s.kind === "design" ? "cowork" : "gate", lane: "", label: `${p.slug} ${s.id} · ${trim(s.title, 60)}` });
    }
  }
  const rj = inputs.receipt?.json ?? {};
  for (const job of list(rj.cron_jobs).slice().sort((a, b) => str(a.jobname) < str(b.jobname) ? -1 : 1)) {
    const cron = parseCron(job.schedule);
    const name = `jobid ${str(job.jobid)} ${str(job.jobname)}`;
    if (!cron) {
      diagnostics.cron_unparsed.push(`${name} \`${str(job.schedule)}\``);
      continue;
    }
    if (cron.daily) {
      diagnostics.cron_daily_not_drawn += 1;
      continue;
    }
    if (job.active === false || job.active === "false") {
      diagnostics.cron_inactive.push(`${name} \`${cron.raw}\``);
      continue;
    }
    const evs = cronEvents(cron, todayMs);
    const label = cron.mode === "next" && cron.subDaily ? `${name} (\`${cron.raw}\`)` : name;
    for (const e of evs) {
      const ev = { ...e, kind: "cron", lane: "", label };
      if (Date.parse(`${e.date}T00:00:00Z`) > lastMs) diagnostics.cron_later.push(`${name} \`${cron.raw}\` → ${e.date}`);
      else diagnostics.cron_drawn.push(`${name} \`${cron.raw}\` → ${e.date} ${e.time}`);
      place(ev);
    }
  }
  const nightlyAt = Date.parse(str(rj.nightly?.created_at));
  if (!Number.isNaN(nightlyAt)) {
    for (const d of days) d.events.push({ date: d.date, time: hhmm(nightlyAt), kind: "nightly", lane: "", label: "nightly dispatch (gha-dispatch)" });
  }
  const kindOrder = { run: 0, receipt: 1, gate: 2, cowork: 3, cron: 4, nightly: 5 };
  const evSort = (a, b) =>
    byStr(a.date, b.date) || byStr(a.time, b.time) || kindOrder[a.kind] - kindOrder[b.kind] || byStr(a.label, b.label);
  for (const d of days) d.events.sort(evSort);
  later.sort(evSort);

  // ── header badges ──
  const session = new Map(list(rj.interlock?.prod_session).map((kv) => [str(kv?.key), str(kv?.value)]));
  const val = (k) => {
    const v = session.get(k) ?? "";
    return v === "—" ? "" : v;
  };
  const asOf = str(rj.generated_at);
  let interlock;
  if (!inputs.receipt) interlock = { state: "unknown", text: "unknown — no receipts file" };
  else if (val("held") === "true") {
    interlock = {
      state: "held",
      text: `held by ${val("reason") || val("claimant") || "(no reason)"} · claimed ${val("claimed_at") || "(unknown)"} · as of ${asOf}`,
    };
  } else if (val("held") === "false") interlock = { state: "free", text: `free · as of ${asOf}` };
  else interlock = { state: "unknown", text: `unknown — the receipt has no held value · as of ${asOf}` };

  const owedEntries = cards.flatMap((c) => c.owed.filter((o) => o.outstanding));
  const badges = {
    interlock,
    verify_fails: cards.filter((c) => c.state === "landed · verify FAILs").length,
    owed: { receipts: owedEntries.length, reports: cards.filter((c) => c.state === "owed").length },
    in_flight: {
      running: cards.filter((c) => c.state === "running").length,
      stale: cards.filter((c) => c.state === "running · stale?").length,
      drafted: cards.filter((c) => c.group === "in_flight" && c.state.startsWith("drafted")).length,
    },
    open_count: openCount,
    max_id: maxId,
  };
  const inFlightText = `${badges.in_flight.running} running${badges.in_flight.stale ? ` + ${badges.in_flight.stale} stale?` : ""} · ${badges.in_flight.drafted} drafted`;
  const badgeLine =
    `interlock ${interlock.text} | verify FAILs ${badges.verify_fails} | owed ${badges.owed.receipts} ` +
    `(${badges.owed.reports} reports) | in flight ${inFlightText} | ${openCount} open`;

  return {
    generated_at: isoSeconds(nowMs),
    head,
    board_dir: str(paths.boardDir),
    receipt: inputs.receipt ? { file: inputs.receipt.name, as_of: asOf } : { file: "", as_of: "" },
    receipt_as_of: asOf,
    window: { days: WINDOW_DAYS, from: isoSeconds(windowFromMs), prompt_floor: floor, max_report: maxReportN },
    badges,
    badge_line: badgeLine,
    projects,
    week: { days, later },
    lanes: laneModels,
    unlaned,
    reconciliation,
    diagnostics,
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

const CSS = `
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f3f2ec;color:#1f1f1b}
a{color:#1d4ed8}a:hover{color:#1e3a8a}
.mono{font-family:ui-monospace,"Cascadia Mono","Segoe UI Mono",Menlo,Consolas,monospace}
.badge{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;border:1px solid #dad8ce;background:#fff;font-size:12.5px}
.badge b{font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.sub{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7a7972;font-weight:600;padding-top:4px}
.proj{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:10px;background:#fff;border:1px solid #dad8ce;flex:1 1 0;min-width:240px}
.proj.planned{border-style:dashed;background:#f8f7f2}
.proj .pname{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.proj .pname b{font-size:13.5px;font-weight:600;white-space:nowrap}
.proj .prog{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#55544e}
.seq{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.step{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;padding:3px 7px;border-radius:5px;border:1px solid #cfcdc2;background:#f6f5f0;color:#45443f;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.step.done{background:#e2f1e6;border-color:#b6d9c0;color:#14532d}
.step.now{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.step.cw{background:#ede9fe;border-color:#d4c6f7;color:#4c1d95}
.step.bad{background:#fdf0e6;border-color:#c2410c;color:#7c2d12}
.arrow{color:#a3a199;font-size:11px}
.pmeta{font-size:12px;color:#55544e;line-height:1.4}
.pmeta b{color:#2b2b27;font-weight:600}
.plabel{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:#4a4944;border:1px solid #b9b7ac;border-radius:4px;padding:1px 6px;letter-spacing:.02em}
.plabel::before{content:"";width:6px;height:6px;background:#4a4944;transform:rotate(45deg);display:inline-block}
.week{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}
.day{display:flex;flex-direction:column;gap:5px;background:#fff;border:1px solid #dad8ce;border-radius:10px;padding:8px 9px;min-height:200px}
.day.today{border-color:#1d4ed8;box-shadow:inset 0 0 0 1px #1d4ed8}
.day.later{background:#f8f7f2;border-style:dashed}
.dh{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:4px;border-bottom:1px solid #e6e4da}
.dh b{font-size:13px;font-weight:600}
.dh span{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#7a7972}
.ev{display:flex;flex-direction:column;gap:1px;padding:4px 6px;border-radius:5px;border-left:3px solid #9a9890;background:#f6f5f0;font-size:11.5px;line-height:1.3;overflow-wrap:anywhere}
.ev .t{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#55544e}
.ev.run{border-left-color:#1d4ed8;background:#eaf0fd}
.ev.ver{border-left-color:#c2410c;background:#fdf0e6}
.ev.rec{border-left-color:#0f766e;background:#e6f3f1}
.ev.gate{border-left-color:#b45309;background:#fbf2e4}
.ev.cw{border-left-color:#7c3aed;background:#f1ecfc}
.win{margin-top:auto;font-size:10.5px;color:#7a7972;line-height:1.3;padding-top:4px;border-top:1px dashed #e6e4da}
.lanes{display:flex;gap:16px;align-items:flex-start}
.lane{display:flex;flex-direction:column;gap:10px;min-width:0;flex:1 1 0}
.lanehead{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:8px 2px 6px;border-top:3px solid #888}
.lanehead .name{font-weight:600;font-size:14px;letter-spacing:.01em}
.lanehead .count{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#5b5a54;text-align:right}
.card{background:#fff;border:1px solid #d9d7cc;border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:7px}
.card.queued{border-style:dashed;background:#f8f7f2}
.card.stop{border-color:#c2410c}
.card.running{border-color:#1d4ed8}
details.card>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
details.card>summary::-webkit-details-marker{display:none}
details.card[open]>summary{padding-bottom:4px}
.top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.id{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;font-size:13px}
.pill{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;letter-spacing:.04em;text-transform:uppercase}
.pill.drafted{background:#e9e8e0;color:#45443f}
.pill.running{background:#1d4ed8;color:#fff}
.pill.stale{background:#fff;color:#1d4ed8;border:1px dashed #1d4ed8}
.pill.landed{background:#c2410c;color:#fff}
.pill.verified{background:#166534;color:#fff}
.pill.owed{background:#0f766e;color:#fff}
.pill.gated{background:#fff;color:#7c3a0a;border:1px solid #e3b98a}
.pill.cowork{background:#ede9fe;color:#4c1d95}
.ttl{font-size:13px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;padding:2px 6px;border-radius:5px;background:#f0efe8;border:1px solid #dedcd1;color:#2b2b27}
.chip.close{background:#e2f1e6;border-color:#b6d9c0;color:#14532d}
.chip.new{background:#e6edfc;border-color:#c0cff4;color:#1e3a8a}
.chip.cond{background:#fdf0e1;border-color:#f0d0a8;color:#7c3a0a}
.meta{font-size:12px;color:#55544e;line-height:1.45;overflow-wrap:anywhere}
.meta b{color:#2b2b27;font-weight:600}
.owe{font-size:12px;line-height:1.4;color:#0f5f58;background:#e8f4f2;border-radius:6px;padding:5px 8px}
.owe.got{color:#55544e;background:#f0efe8}
.vfy{font-size:12px;line-height:1.4;color:#6b3410;background:#fbf1e6;border-radius:6px;padding:5px 8px;overflow-wrap:anywhere}
.legend{display:flex;align-items:center;gap:14px;font-size:12px;color:#55544e;flex-wrap:wrap}
.diag{font-size:12px;color:#55544e;line-height:1.5}
.diag code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
@media (max-width:1100px){.lanes{flex-wrap:wrap}.lane{flex:1 1 280px}.week{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const pillClass = (state) =>
  state === "running"
    ? "running"
    : state === "running · stale?"
      ? "stale"
      : state.startsWith("landed")
        ? "landed"
        : state === "owed"
          ? "owed"
          : state === "closed" || state === "done"
            ? "verified"
            : state.startsWith("gated")
              ? "gated"
              : "drafted";
const evClass = { run: "ev run", receipt: "ev rec", gate: "ev gate", cowork: "ev cw", cron: "ev", nightly: "ev" };

function renderCardBody(c) {
  const chips = [
    ...c.fixes_closed.map((id) => `<span class="chip close">${esc(id)}</span>`),
    ...c.fixes_filed.map((id) => `<span class="chip new">+${esc(id)}</span>`),
    ...c.fixes_reopened.map((id) => `<span class="chip cond">reopen ${esc(id)}</span>`),
  ];
  const meta = [];
  if (c.when) meta.push(`<b>when:</b> ${esc(c.when)}`);
  if (c.attended) meta.push(`<b>attended:</b> ${esc(c.attended)}`);
  if (c.posture) meta.push(`<b>posture:</b> ${esc(c.posture)}`);
  if (c.group !== "in_flight") {
    meta.push(`<b>migrations:</b> ${c.migrations}`);
    meta.push(`<b>prod writes:</b> ${esc(c.prod_writes || "unstated")}`);
    meta.push(`<b>verify:</b> ${c.verify.pass} pass · ${c.verify.fail} fail · ${c.verify.unchecked} unchecked`);
  }
  if (c.lane_source && c.lane_source !== "report" && c.lane_source !== "prompt") meta.push(`<b>lane from:</b> ${esc(c.lane_source)}`);
  if (c.marker_started_at) meta.push(`<b>started:</b> ${esc(c.marker_started_at)}`);
  const links = [
    c.prompt_link ? `<a href="${esc(c.prompt_link)}">prompt</a>` : "",
    c.report_link ? `<a href="${esc(c.report_link)}">report</a>` : "",
  ].filter(Boolean);
  const owed = c.owed.map((o) =>
    o.outstanding
      ? `<div class="owe">owed: ${esc(o.fix)}${o.what ? ` · ${esc(o.what)}` : ""} · after ${esc(o.after)}${o.problem ? ` · malformed: ${esc(o.problem)}` : ""}</div>`
      : `<div class="owe got">received: ${esc(o.fix)}${o.what ? ` · ${esc(o.what)}` : ""} · done.log ${esc(o.received)}</div>`,
  );
  return [
    c.title ? `<div class="ttl">${esc(c.title)}</div>` : "",
    chips.length ? `<div class="chips">${chips.join("")}</div>` : "",
    meta.length ? `<div class="meta">${meta.join(" · ")}</div>` : "",
    ...owed,
    c.verify.fails.length ? `<div class="vfy">verify FAILs: ${c.verify.fails.map(esc).join(" · ")}</div>` : "",
    c.problems.length ? `<div class="vfy">${c.problems.map(esc).join(" · ")}</div>` : "",
    links.length ? `<div class="meta">${links.join(" · ")}</div>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderCard(c) {
  const top = [
    `<span class="id">cc-${c.cc}</span>`,
    `<span class="pill ${pillClass(c.state)}">${esc(c.state)}</span>`,
    c.stops ? `<span class="chip cond">STOP ×${c.stops}</span>` : "",
    c.project ? `<span class="plabel">${esc(c.project)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  // The STOP border is for cards still asking for attention; a closed card
  // keeps its `STOP ×n` chip and loses the border.
  const cls = ["card", c.stops && c.state !== "closed" ? "stop" : "", c.state === "running" ? "running" : ""]
    .filter(Boolean)
    .join(" ");
  if (c.state === "closed") {
    // Verified and owing nothing: collapsed, every field one click away.
    return `<details class="${cls}"><summary>${top}<span class="meta">${esc(trim(c.title, 80))}</span></summary>\n${renderCardBody(c)}\n</details>`;
  }
  return `<div class="${cls}">\n<div class="top">${top}</div>\n${renderCardBody(c)}\n</div>`;
}

function renderQueue(q) {
  const pill = q.kind === "design" ? "cowork" : pillClass(q.status);
  return (
    `<div class="card queued"><div class="top"><span class="id">${esc(q.ref || q.step)}</span>` +
    `<span class="pill ${pill}">${esc(q.status)}</span><span class="plabel">${esc(q.project)}</span></div>` +
    `<div class="meta">${esc(q.project)} ${esc(q.step)} · ${esc(q.kind)} · ${esc(q.title)}</div></div>`
  );
}

function renderEvent(e) {
  const style = e.kind === "run" && e.lane ? ` style="border-left-color:${laneColor(e.lane)}"` : "";
  return `<div class="${evClass[e.kind] ?? "ev"}"${style}><span class="t">${esc(e.time || "any time")}</span><span>${esc(e.label)}</span></div>`;
}

export function renderHtml(b) {
  const bd = b.badges;
  const interlockDot = bd.interlock.state === "held" ? "#1d4ed8" : bd.interlock.state === "free" ? "#166534" : "#9a9890";
  const header = `
<div class="hdr">
  <div style="display:flex;flex-direction:column;gap:4px">
    <h1 style="margin:0;font-family:ui-serif,Georgia,serif;font-size:26px;font-weight:600;letter-spacing:-0.01em">Civitics · lane board</h1>
    <div class="mono" style="font-size:12px;color:#55544e">HEAD ${esc(b.head || "(unknown)")} · ${bd.open_count} open · ids to ${esc(bd.max_id || "(none)")} · board at ${esc(humanUtc(b.generated_at))} · receipts ${esc(b.receipt.file || "(none)")}${b.receipt.as_of ? ` as of ${esc(humanUtc(b.receipt.as_of))}` : ""} · rendered by scripts/board.mjs</div>
  </div>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <div class="badge"><span class="dot" style="background:${interlockDot}"></span><span>prod interlock (950): <b>${esc(bd.interlock.text)}</b></span></div>
    <div class="badge"><span class="dot" style="background:#c2410c"></span><span>landed · verify FAILs: <b>${bd.verify_fails}</b></span></div>
    <div class="badge"><span class="dot" style="background:#0f766e"></span><span>receipts owed: <b>${bd.owed.receipts}</b> · in ${bd.owed.reports} reports</span></div>
    <div class="badge"><span class="dot" style="background:#45443f"></span><span>in flight: <b>${bd.in_flight.running} running${bd.in_flight.stale ? ` + ${bd.in_flight.stale} stale?` : ""} · ${bd.in_flight.drafted} drafted</b></span></div>
  </div>
</div>`;

  const projects = b.projects
    .map((p) => {
      const seq = p.steps
        .map((s) => {
          const cls = s.done ? "step done" : s.id === p.current ? "step now" : s.status.startsWith("landed") ? "step bad" : s.kind === "design" ? "step cw" : "step";
          const text = `${s.ref ? `${s.ref} · ` : ""}${trim(s.title, 42)}${!s.done && s.status !== "planned" ? ` · ${s.status}` : ""}`;
          return `<span class="${cls}" title="${esc(`${s.id} · ${s.kind} · ${s.status} · ${s.title}`)}">${esc(text)}</span>`;
        })
        .join('<span class="arrow">→</span>');
      const next = p.current ? `${p.current} · ${trim(p.current_title, 70)} (${p.current_status})` : "all done";
      return `
<div class="proj${p.status === "planned" ? " planned" : ""}">
  <div class="pname"><b>${esc(p.slug)}</b><span class="prog">${p.done_count} of ${p.total} done</span></div>
  <div class="seq">${seq}</div>
  <div class="pmeta"><b>next:</b> ${esc(next)}</div>
  <div class="pmeta"><b>lanes:</b> ${esc(p.lanes.join(" · "))} · <b>status:</b> ${esc(p.status)} · <b>plan:</b> ${esc(p.plan)} · <a href="${esc(p.link)}">${esc(p.file)}</a></div>
  ${p.problems.length ? `<div class="vfy">${p.problems.map(esc).join(" · ")}</div>` : ""}
</div>`;
    })
    .join("");

  const week = b.week.days
    .map(
      (d) => `
<div class="day${d.today ? " today" : ""}">
  <div class="dh"><b>${esc(d.dow)}</b><span>${esc(d.date.slice(5))}${d.today ? " · today" : ""}</span></div>
  ${d.events.map(renderEvent).join("\n  ")}
  ${d.supervised ? `<div class="win">${esc(d.supervised)}</div>` : ""}
</div>`,
    )
    .join("");
  const later = `
<div class="day later">
  <div class="dh"><b>Later</b><span>after ${esc(b.week.days[b.week.days.length - 1].date.slice(5))}</span></div>
  ${b.week.later.map((e) => renderEvent({ ...e, time: `${e.date.slice(5)}${e.time ? ` ${e.time}` : ""}` })).join("\n  ")}
</div>`;

  const laneCol = (l) => {
    const active = l.cards.filter((c) => c.state !== "closed");
    const closed = l.cards.filter((c) => c.state === "closed");
    return `
<div class="lane">
  <div class="lanehead" style="border-top-color:${l.color}"><span class="name">${esc(l.name)}</span><span class="count">${l.count} = ${l.in_flight} in flight + ${l.landed} landed + ${l.verified} verified${l.queue.length ? ` · ${l.queue.length} queued` : ""}</span></div>
  ${active.map(renderCard).join("\n")}
  ${l.queue.length ? `<div class="sub">queue — plan steps</div>\n${l.queue.map(renderQueue).join("\n")}` : ""}
  ${closed.length ? `<div class="sub">verified · nothing owed</div>\n${closed.map(renderCard).join("\n")}` : ""}
</div>`;
  };

  const u = b.unlaned;
  const unlaned = u.count
    ? `
<div style="display:flex;flex-direction:column;gap:8px">
  <div class="sub">No lane — ${u.count} = ${u.in_flight} in flight + ${u.landed} landed + ${u.verified} verified · reports before the lanes-backfill window, or with a lane the config does not list</div>
  <div class="lanes" style="flex-wrap:wrap">${u.cards.map((c) => `<div style="flex:1 1 300px;min-width:0">${renderCard(c)}</div>`).join("")}</div>
</div>`
    : "";

  const r = b.reconciliation;
  const dg = b.diagnostics;
  const diag = [
    `window: reports finished since ${esc(b.window.from)} (${r.window_reports}) + in-flight prompts (${r.prompt_cards}) = ${r.cards} cards; placed ${r.placed}; ${r.ok ? "every card in exactly one place, every lane header sums" : "RECONCILIATION FAILED"}`,
    `prompts: ${dg.prompts_total} numbered files; ${dg.legacy_prompts_skipped} pre-front-matter prompts outside cc-${b.window.prompt_floor}…cc-${b.window.max_report} not shown${dg.prompts_duplicate_numbers.length ? `; duplicate numbers ${esc(dg.prompts_duplicate_numbers.join(", "))}` : ""}`,
    dg.sidecar_missing.length ? `read from the .md (no sidecar): ${esc(dg.sidecar_missing.join(", "))}` : "",
    dg.sidecar_drift.length ? `sidecar disagrees with the .md: ${esc(dg.sidecar_drift.join(", "))}` : "",
    dg.reports_without_finished_at.length ? `no finished_at (not placed): ${esc(dg.reports_without_finished_at.join(", "))}` : "",
    `cron: ${dg.cron_drawn.length} firings drawn, ${dg.cron_daily_not_drawn} daily jobs not drawn, ${dg.cron_inactive.length} inactive not drawn${dg.cron_inactive.length ? ` (${esc(dg.cron_inactive.join("; "))})` : ""}${dg.cron_later.length ? `; later: ${esc(dg.cron_later.join("; "))}` : ""}${dg.cron_unparsed.length ? `; unparsed: ${esc(dg.cron_unparsed.join("; "))}` : ""}`,
    `supervised windows: .claude/board.local.json ${esc(dg.local_file)}`,
    dg.read_errors.length ? `read errors: ${esc(dg.read_errors.join("; "))}` : "",
  ]
    .filter(Boolean)
    .map((x) => `<div>${x}</div>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Civitics lane board</title>
<style>${CSS}.hdr{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap}</style>
</head>
<body>
<div style="max-width:1520px;min-height:100vh;margin:0 auto;box-sizing:border-box;padding:28px 32px;display:flex;flex-direction:column;gap:18px">
${header}
<div style="display:flex;flex-direction:column;gap:8px">
  <div class="sub">Projects — one plan file each at docs/cc/projects/&lt;slug&gt;.md; step status derived from the tree</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">${projects}</div>
</div>
<div style="display:flex;flex-direction:column;gap:8px">
  <div class="sub">This week (UTC) — prompt runs, receipts owed, gates, non-daily pg_cron (receipt as of ${esc(humanUtc(b.receipt.as_of))}), the nightly dispatch</div>
  <div class="week">${week}${later}</div>
</div>
<div class="lanes">${b.lanes.map(laneCol).join("")}</div>
${unlaned}
<div class="legend">
  <span><b>card states</b></span>
  <span class="pill drafted">drafted</span><span class="pill running">running</span><span class="pill stale">running · stale?</span>
  <span class="pill landed">landed · verify FAILs</span><span class="pill owed">owed</span><span class="pill verified">closed</span>
  <span class="pill gated">gated · date</span><span class="pill cowork">design</span><span class="plabel">project</span>
  <span style="margin-left:12px">chips:</span><span class="chip close">closes</span><span class="chip new">+files new</span><span class="chip cond">STOP / reopen</span>
  <span style="margin-left:12px">calendar:</span><span class="ev run" style="padding:2px 6px">run</span><span class="ev rec" style="padding:2px 6px">receipt</span><span class="ev gate" style="padding:2px 6px">gate</span><span class="ev cw" style="padding:2px 6px">design</span><span class="ev" style="padding:2px 6px">pg_cron / nightly</span>
</div>
<div class="diag">
${diag}
</div>
</div>
</body>
</html>
`;
}

export const renderBoardJson = (b) => `${JSON.stringify(b, null, 2)}\n`;

// ── the command ─────────────────────────────────────────────────────────────

function usage(stream = process.stderr) {
  stream.write(
    [
      "Usage: pnpm board [--dry-run | --json] [--now <ISO instant>]",
      "",
      "  (default)   write <boardDir>/board.json and <boardDir>/index.html",
      "  --json      write only board.json",
      "  --dry-run   print board.json to stdout; write nothing",
      "  --now       render as of this instant (tests; determinism)",
      "",
    ].join("\n"),
  );
}

/**
 * The command, with every tree-dependent piece injected so the tests drive it
 * against scripts/__fixtures__/board/. Returns the exit code.
 */
export function run(argv, { paths, lanes, head, verify, stdout = process.stdout, stderr = process.stderr }) {
  const dry = argv.includes("--dry-run");
  const jsonOnly = argv.includes("--json");
  const nowIdx = argv.indexOf("--now");
  let nowMs = Math.floor(Date.now() / 1000) * 1000;
  if (nowIdx !== -1) {
    nowMs = Date.parse(argv[nowIdx + 1] ?? "");
    if (Number.isNaN(nowMs)) {
      usage(stderr);
      return 1;
    }
  }
  let inputs;
  try {
    inputs = loadBoardInputs(paths);
  } catch (e) {
    stderr.write(`board — read error: ${e.message}\n`);
    return 1;
  }
  const board = buildBoard(inputs, { nowMs, verify, lanes, head, paths });
  const json = renderBoardJson(board);
  if (dry) {
    stdout.write(json);
    return 0;
  }
  try {
    mkdirSync(paths.boardDir, { recursive: true });
    writeFileSync(resolve(paths.boardDir, "board.json"), json, "utf8");
    if (!jsonOnly) writeFileSync(resolve(paths.boardDir, "index.html"), renderHtml(board), "utf8");
  } catch (e) {
    stderr.write(`board — write error: ${e.message}\n`);
    return 1;
  }
  stdout.write(`board — ${board.badge_line}\n`);
  stdout.write(
    `board — wrote ${resolve(paths.boardDir, "board.json")}${jsonOnly ? "" : " + index.html"} (${Buffer.byteLength(json, "utf8")} bytes json)\n`,
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  let cfg;
  try {
    cfg = loadCcConfig();
  } catch (e) {
    process.stderr.write(`board — ${e.message}\n`);
    return 1;
  }
  let head = "";
  try {
    head = execSync("git rev-parse --short=8 HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    head = "";
  }
  // One context for every report: local trunk ref, no fetch, no gh — see the header.
  const vctx = buildVerifyContext(cfg, { fetch: false, gh: false, batch: true });
  const verify = (fm, loaded) =>
    verifyReport(fm, { ...vctx, frontMatterSource: loaded.source, frontMatterDrift: loaded.drift });
  return run(argv, { paths: resolvePaths(cfg), lanes: cfg.lanes, head, verify });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
