#!/usr/bin/env node
// scripts/cc-verify.mjs
//
// pnpm cc:verify <n> — check a CC run report's structured claims against git
// and docs/done.log (FIX-1175).
//
// A CC report is evidence. Today the checking is done by hand: read the claimed
// shas against the reflog, the claimed closes against done.log, the claimed
// status against the markdown. Every one of those is mechanical, so it should
// fail loudly rather than depend on somebody re-reading carefully.
//
// It checks CLAIMS, not quality. A PASS means the report does not contradict the
// tree; it says nothing about whether the work was right. Anything it cannot
// settle locally is reported UNCHECKED, never quietly passed — a verifier that
// degrades to green when it cannot see is worse than no verifier.
//
// Usage:
//   pnpm cc:verify 122
//   pnpm cc:verify 122 --json
//   pnpm cc:verify --file path/to/report.md      (fixtures, or a report elsewhere)
//
// Exit: 0 when nothing FAILs, 1 on any FAIL (UNCHECKED does not fail).

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import { ID_MARKER_RE } from "./lib/fixes-md.mjs";
import { loadCcConfig, reportPath, findPromptFiles } from "./lib/cc-config.mjs";

const PASS = "PASS";
const FAIL = "FAIL";
const UNCHECKED = "UNCHECKED";

function git(args, { cwd } = {}) {
  try {
    return {
      ok: true,
      out: execSync(`git ${args}`, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim(),
    };
  } catch {
    return { ok: false, out: "" };
  }
}

// ── front matter ────────────────────────────────────────────────────────────
// A deliberately small YAML subset — scalars, `[a, b]` inline lists, `- item`
// block lists, and `- {sha: x, subject: y}` inline maps. Enough for the report
// contract and nothing more; a real YAML dependency would be the only one in
// scripts/, and the contract is ours to keep simple.

export function parseFrontMatter(text) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (!m) throw new Error("report has no `---` YAML front matter at the top");
  const out = {};
  const lines = m[1].split("\n");
  let key = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const block = /^\s*-\s+(.*)$/.exec(raw);
    if (block && key) {
      (out[key] ||= []).push(parseScalarOrMap(block[1]));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      out[key] = []; // a block list follows (or the key is empty)
    } else if (rest.startsWith("[")) {
      out[key] = splitInline(rest.slice(1, rest.lastIndexOf("]")))
        .map((s) => parseScalarOrMap(s))
        .filter((s) => s !== "" && s !== undefined);
      key = null;
    } else {
      out[key] = unquote(rest);
      key = null;
    }
  }
  return out;
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Split on commas that are not inside {} or quotes.
function splitInline(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of String(s)) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseScalarOrMap(s) {
  const t = String(s).trim();
  if (!t.startsWith("{")) return unquote(t);
  const inner = t.slice(1, t.lastIndexOf("}"));
  const obj = {};
  for (const pair of splitMapPairs(inner)) {
    const i = pair.indexOf(":");
    if (i === -1) continue;
    obj[pair.slice(0, i).trim()] = unquote(pair.slice(i + 1));
  }
  return obj;
}

// Inside a `{key: value, key: value}` map, a bare comma is NOT a separator
// unless what follows it looks like the next key. Commit subjects contain
// commas constantly ("feat(x): a, b and c"), and splitting on the first one
// silently truncated every subject to its first clause — which the test caught.
// Residual ambiguity: a subject containing ", word:" would still split, so the
// report contract says to QUOTE a subject when in doubt; `splitInline` already
// honours quotes and `unquote` strips them.
function splitMapPairs(inner) {
  const parts = [];
  let cur = "";
  let quote = null;
  const rest = String(inner);
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "," && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(rest.slice(i + 1))) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// A key written with no value (`prod_writes:`) parses as an empty block list,
// which is TRUTHY — so a plain `if (!fm.x)` treated "omitted" as "present" and
// passed. Scalar fields use this instead. (`migrations_pushed: []` is a
// legitimate empty LIST and is checked as a list, not with this.)
const missing = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]);
const asIds = (v) =>
  asList(v)
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => /^FIX-\d+$/.test(x));

// ── the checks ──────────────────────────────────────────────────────────────

export function verifyReport(fm, ctx) {
  const { statusMap, fixesText, archiveText, trunkRef, resolveSha, isAncestor, fileOnTrunk, ghCi } = ctx;
  const results = [];
  const add = (verdict, claim, detail = "") => results.push({ verdict, claim, detail });

  // 1. Required fields.
  for (const field of ["cc", "head_before", "head_after"]) {
    if (missing(fm[field])) add(FAIL, `front matter has \`${field}\``, "missing");
    else add(PASS, `front matter has \`${field}\``, String(fm[field]));
  }

  // 2. Commits: each exists and is on trunk.
  const commits = asList(fm.commits)
    .map((c) => (typeof c === "string" ? { sha: c } : c))
    .filter((c) => c && c.sha);
  if (commits.length === 0) {
    add(UNCHECKED, "commits[] listed", "none claimed");
  }
  const claimedShas = new Set();
  for (const c of commits) {
    const full = resolveSha(c.sha);
    if (!full) {
      add(FAIL, `commit ${c.sha} exists`, "no such object in this clone");
      continue;
    }
    claimedShas.add(full);
    claimedShas.add(full.slice(0, 8));
    claimedShas.add(c.sha);
    if (!isAncestor(full)) {
      add(FAIL, `commit ${c.sha} is on ${trunkRef}`, "exists but is NOT an ancestor — unmerged/off-trunk");
    } else {
      add(PASS, `commit ${c.sha} is on ${trunkRef}`, c.subject ? String(c.subject).slice(0, 60) : "");
    }
  }

  // 3. head_after is on trunk. (head_before is informational — it may have been
  //    rewritten by a later rebase, and failing on that would be noise.)
  if (!missing(fm.head_after)) {
    const full = resolveSha(fm.head_after);
    if (!full) add(FAIL, `head_after ${fm.head_after} exists`, "no such object");
    else if (!isAncestor(full)) add(FAIL, `head_after is on ${trunkRef}`, "not an ancestor — the run did not land");
    else add(PASS, `head_after is on ${trunkRef}`);
  }

  // 4. fixes_closed: derives CLOSED, via a row naming one of this run's commits.
  for (const id of asIds(fm.fixes_closed)) {
    const entry = statusMap.get(id);
    if (!entry) {
      add(FAIL, `${id} closed`, "no row in docs/done.log at all");
      continue;
    }
    if (entry.status !== "closed") {
      add(FAIL, `${id} closed`, `derives OPEN (last row ${entry.lastRow.date} | ${entry.lastRow.sha})`);
      continue;
    }
    // The close must be attributable to this run, not to some earlier commit —
    // otherwise a report could claim credit for work it did not do.
    const mine = entry.rows.some((r) => r.sha !== "reopen" && claimedShas.has(r.sha));
    if (mine) add(PASS, `${id} closed by this run`, `${entry.lastRow.date} ${entry.lastRow.sha} ${entry.lastRow.verified}`);
    else {
      add(
        FAIL,
        `${id} closed by this run`,
        `derives CLOSED, but no done.log row names a commit from commits[] ` +
          `(rows: ${entry.rows.map((r) => r.sha).join(", ")})`,
      );
    }
  }

  // 5. fixes_filed: the id has a marker somewhere.
  for (const id of asIds(fm.fixes_filed)) {
    const re = new RegExp(`<!--\\s*id:\\s*${id}\\s*-->`);
    if (re.test(fixesText) || re.test(archiveText)) add(PASS, `${id} filed (marker present)`);
    else add(FAIL, `${id} filed (marker present)`, "no <!--id:FIX-NNN--> marker in FIXES.md or the archive");
  }

  // 6. fixes_reopened: derives OPEN on a reopen row.
  for (const id of asIds(fm.fixes_reopened)) {
    const entry = statusMap.get(id);
    if (!entry) add(FAIL, `${id} reopened`, "no row in docs/done.log");
    else if (entry.status !== "open") add(FAIL, `${id} reopened`, `derives CLOSED (last row ${entry.lastRow.sha})`);
    else if (entry.lastRow.sha !== "reopen") add(FAIL, `${id} reopened`, "open, but its last row is not a reopen row");
    else add(PASS, `${id} reopened`, `${entry.lastRow.date} — ${entry.lastRow.note.slice(0, 60)}`);
  }

  // 7. migrations_pushed: the file exists and is on trunk. Whether it actually
  //    reached the Pro database is not knowable from here, and saying so is the
  //    point — a silent PASS would imply a check that never ran.
  const migrations = asList(fm.migrations_pushed).filter((x) => typeof x === "string" && x.trim());
  for (const file of migrations) {
    const rel = file.includes("/") ? file : `supabase/migrations/${file}`;
    if (!fileOnTrunk(rel)) add(FAIL, `migration ${file} is on ${trunkRef}`, `not found at ${rel}`);
    else add(PASS, `migration ${file} is on ${trunkRef}`);
    add(UNCHECKED, `migration ${file} applied to Pro`, "unverifiable locally — check supabase migration list --db-url");
  }
  if (migrations.length === 0) add(PASS, "migrations_pushed[] empty", "no schema change claimed");

  // 8. prod_writes must be stated, either way.
  if (missing(fm.prod_writes)) add(FAIL, "prod_writes stated", "missing — say `none` or describe them");
  else if (/^none$/i.test(String(fm.prod_writes))) add(PASS, "prod_writes: none");
  else add(UNCHECKED, "prod_writes described", String(fm.prod_writes).slice(0, 80));

  // 9. ci.
  const ci = missing(fm.ci) ? "" : String(fm.ci).trim();
  if (!ci) add(FAIL, "ci stated", "missing — say `green` or `red <run-id>`");
  else if (/^green$/i.test(ci)) {
    if (!ghCi) add(UNCHECKED, "ci: green", "gh unavailable — not cross-checked");
    else if (ghCi.conclusion === "success") add(PASS, "ci: green", `${ghCi.headSha?.slice(0, 8) ?? ""} ${ghCi.displayTitle ?? ""}`.trim());
    else if (ghCi.status && ghCi.status !== "completed") add(UNCHECKED, "ci: green", `latest run is ${ghCi.status}`);
    else add(FAIL, "ci: green", `latest tests.yml run on main is ${ghCi.conclusion}`);
  } else add(UNCHECKED, `ci: ${ci}`, "not a green claim — read it");

  return results;
}

// ── main ────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    [
      "Usage: pnpm cc:verify <n> [--json]",
      "       pnpm cc:verify --file <path> [--json]",
      "",
      "Checks the YAML front matter of a CC run report against git and",
      "docs/done.log. Exit 1 on any FAIL; UNCHECKED never fails.",
      "",
    ].join("\n"),
  );
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const fileIdx = argv.indexOf("--file");
  const n = argv.find((a) => /^\d+$/.test(a));
  if (fileIdx === -1 && !n) {
    usage();
    process.exit(1);
  }

  const cfg = loadCcConfig();
  const path = fileIdx !== -1 ? resolve(argv[fileIdx + 1] ?? "") : reportPath(n, cfg);
  if (!existsSync(path)) {
    process.stderr.write(`cc:verify — no report at ${path}\n`);
    process.exit(1);
  }

  let fm;
  try {
    fm = parseFrontMatter(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(`cc:verify — ${e.message}\n`);
    process.exit(1);
  }

  // Fetch so trunk is current; offline degrades to the cached ref rather than
  // failing, and every ancestry answer then carries that caveat implicitly.
  git("fetch origin --quiet");
  const trunkRef =
    ["origin/main", "refs/remotes/origin/main", "main"].find((r) => git(`rev-parse --verify --quiet ${r}`).ok) ??
    "HEAD";

  const root = cfg.repoRoot;
  const readIf = (p) => (existsSync(resolve(root, p)) ? readFileSync(resolve(root, p), "utf8") : "");
  const statusMap = deriveStatus(parseDoneLog(readIf("docs/done.log")));

  let ghCi = null;
  try {
    const out = execSync(
      `gh run list --workflow tests.yml --branch main --limit 1 --json status,conclusion,displayTitle,headSha`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 },
    );
    ghCi = JSON.parse(out)[0] ?? null;
  } catch {
    ghCi = null; // gh absent / unauthenticated / offline → UNCHECKED, never FAIL
  }

  const results = verifyReport(fm, {
    statusMap,
    fixesText: readIf("docs/FIXES.md"),
    archiveText: readIf("docs/archive/fixes-archive.md"),
    trunkRef,
    resolveSha: (sha) => {
      const r = git(`rev-parse --verify --quiet ${sha}`);
      return r.ok && r.out ? r.out : null;
    },
    isAncestor: (sha) => git(`merge-base --is-ancestor ${sha} ${trunkRef}`).ok,
    fileOnTrunk: (rel) => git(`cat-file -e ${trunkRef}:${rel}`).ok,
    ghCi,
  });

  const counts = {
    pass: results.filter((r) => r.verdict === PASS).length,
    fail: results.filter((r) => r.verdict === FAIL).length,
    unchecked: results.filter((r) => r.verdict === UNCHECKED).length,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify({ report: path, trunk: trunkRef, counts, results }, null, 2)}\n`);
  } else {
    console.log(`cc:verify — ${path}`);
    console.log(`  trunk: ${trunkRef}\n`);
    for (const r of results) {
      const mark = r.verdict === PASS ? "PASS     " : r.verdict === FAIL ? "FAIL     " : "UNCHECKED";
      console.log(`  ${mark}  ${r.claim}${r.detail ? `  —  ${r.detail}` : ""}`);
    }
    console.log(`\n${counts.pass} pass · ${counts.fail} fail · ${counts.unchecked} unchecked`);
    if (counts.fail === 0 && counts.unchecked === 0) console.log("✓ every claim checked and consistent with the tree.");
    else if (counts.fail === 0) console.log("✓ no claim contradicts the tree (some could not be checked here).");
  }

  process.exit(counts.fail > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { PASS, FAIL, UNCHECKED, findPromptFiles, ID_MARKER_RE };
