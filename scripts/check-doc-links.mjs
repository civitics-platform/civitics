#!/usr/bin/env node
// scripts/check-doc-links.mjs — `pnpm check:doc-links` (FIX-1243 D7)
//
// Two jobs, one reader of what a doc reference looks like:
//
//   1. CHECK. Walk docs/**/*.md, CLAUDE.md, apps/civitics/CLAUDE.md and
//      README.md for
//        - relative markdown links   [text](X.md) · (./X.md) · (../docs/X.md#§)
//          resolved against the linking file's directory, and
//        - backtick docs paths       `docs/X.md` · `docs/X.md:44` · `docs/X.md §3`
//          resolved against the repo root,
//      and FAIL on a target that does not exist. Breaks that predate the
//      checker are listed in scripts/doc-links-known-breaks.json; a break NOT in
//      that list fails, and a listed one that no longer breaks is reported so
//      the list only shrinks.
//
//   2. ARCHIVE. `--archive A.md B.md …` moves docs/<name> → docs/archive/<name>
//      with `git mv` and rewrites every reference the move would leave dangling:
//        - `docs/<name>` written from the repo root, anywhere in scope
//        - a relative markdown link that resolved to the old path — recomputed
//          from the linking file (and from the moved file's NEW home, for the
//          links a moved file makes outward)
//        - a bare backtick sibling name (`<name>`) in a file that sits in docs/
//          beside it — the same sibling-relative meaning, recomputed.
//      History is not rewritten: docs/audits, docs/ops, docs/receipts,
//      docs/cc/reports, docs/archive/fixes-archive.md, docs/done.log and
//      supabase/migrations are read, and every hit in them is printed as
//      "left as written". A code or migration reference to a doc refuses the
//      move of that doc (a comment that cites a file does not follow a rename).
//
// Usage:
//   pnpm check:doc-links                      check; exit 1 on a new break
//   pnpm check:doc-links --dry-run            list every link + every break; exit 0
//   pnpm check:doc-links --archive X.md …     move + rewrite (then re-check)
//   pnpm check:doc-links --archive X.md … --dry-run
//                                             print every git mv and every rewrite; change nothing
//
// Dependency-free Node, matching its siblings in scripts/.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
export const KNOWN_BREAKS_PATH = "scripts/doc-links-known-breaks.json";

/** Where the checker looks: every .md under docs/, plus these. */
export const CHECK_ROOTS = ["CLAUDE.md", "apps/civitics/CLAUDE.md", "README.md"];

/**
 * Where an archive move looks for references — the census scope of
 * feedback_removal_census_includes_docs: docs, both CLAUDE.mds, every other
 * CLAUDE.md and root .md, code, workflows.
 */
export const CENSUS_GLOBS = ["docs", "apps", "packages", "scripts", ".github", "supabase", ".claude"];

/** Read-only history: an archive move reports hits here and never edits them. */
export const HISTORY_PREFIXES = [
  "docs/audits/",
  "docs/ops/",
  "docs/receipts/",
  "docs/cc/reports/",
  "docs/archive/fixes-archive.md",
  "docs/done.log",
  "supabase/migrations/",
];
/** A reference from here to a doc refuses that doc's move (D7 Tier A/B rule). */
export const CODE_PREFIXES = ["apps/", "packages/", "scripts/", ".github/", "supabase/"];

const toPosix = (p) => p.split("\\").join("/");

// A target that is a pattern, not a path: `cc-<n>.md`, `docs/*.md`, `{a,b}.md`,
// `YYYY-MM-DD.md`, `FIX-NNN.md`.
const TEMPLATED = /[<>*{}$|]|\bNNN\b|YYYY|\bX\.md$|\.\.\.|…/;

// FIX-1244 — a receipts file named for a day that has not happened yet: a
// report that owes a receipt names the file it WILL be in (cc-167.md cites
// `docs/receipts/2026-10-04.md`). Exempt while the date is after today; on the
// day the nightly writes it, and if it never does, the path is checked like
// any other. Judged on the RESOLVED path, so a relative link counts too.
export const FUTURE_RECEIPT = /^docs\/receipts\/(\d{4}-\d{2}-\d{2})\.(md|json)$/;

/** True when `resolved` is a receipts file for a date after `today` (YYYY-MM-DD, UTC). */
export function isFutureReceipt(resolved, today) {
  const m = FUTURE_RECEIPT.exec(String(resolved ?? ""));
  return m !== null && m[1] > today;
}

/**
 * FIX-1244 — an inline code span is an EXAMPLE, not a link: `[title](docs/x.md)`
 * between backticks documents the shape. Every span (single or multi-backtick)
 * is blanked to spaces of the same length before the markdown-link regex runs,
 * so `[`docs/X.md`](X.md)` — a code span as link TEXT — is still a link. The
 * backtick-path kind reads the ORIGINAL line: a `docs/X.md` in backticks is
 * exactly what that kind checks.
 */
export function stripCodeSpans(line) {
  return String(line).replace(/(`+)([\s\S]*?)\1(?!`)/g, (m) => " ".repeat(m.length));
}

/**
 * Every doc reference in one file's text.
 * @returns {{line: number, kind: "link"|"backtick", raw: string, target: string}[]}
 *   `target` is the path part (no `#anchor`, no `:line`), as written.
 */
export function scanText(text) {
  const out = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    // [text](target.md#anchor "title") — relative only, outside code spans.
    for (const m of stripCodeSpans(line).matchAll(/\]\(\s*<?([^)\s>]+?\.md)(#[^)\s]*)?>?(?:\s+"[^"]*")?\s*\)/g)) {
      const t = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || TEMPLATED.test(t)) continue;
      out.push({ line: i + 1, kind: "link", raw: m[0], target: t });
    }
    // `docs/X.md`, `docs/X.md:44`, `docs/X.md §3` — repo-root relative.
    for (const m of line.matchAll(/`(docs\/[A-Za-z0-9_./-]+?\.md)(?:[:#§ ][^`]*)?`/g)) {
      if (TEMPLATED.test(m[1])) continue;
      out.push({ line: i + 1, kind: "backtick", raw: m[0], target: m[1] });
    }
  });
  return out;
}

/** The repo-relative path a reference points at (posix), or null when it leaves the repo. */
export function resolveRef(fileRel, ref) {
  const base = ref.kind === "backtick" || ref.target.startsWith("/") ? "" : posix.dirname(toPosix(fileRel));
  const joined = posix.normalize(posix.join(base, ref.target.replace(/^\//, "")));
  if (joined.startsWith("../") || joined === "..") return null;
  return joined;
}

/** Every file the checker walks, repo-relative posix, sorted. */
export function checkFiles(root = REPO) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, r));
      if (st.isDirectory()) walk(r);
      else if (name.endsWith(".md")) out.push(r);
    }
  };
  walk("docs");
  for (const f of CHECK_ROOTS) if (existsSync(join(root, f))) out.push(f);
  return out.sort();
}

/**
 * Check every reference. `exists(rel)` is injected (tests pass a Set), and so
 * is `today` (UTC YYYY-MM-DD) for the FUTURE_RECEIPT exemption.
 * @returns {{refs: number, breaks: {file, line, kind, target, resolved}[]}}
 */
export function checkTree(files, readRel, exists, { today = new Date().toISOString().slice(0, 10) } = {}) {
  let refs = 0;
  const breaks = [];
  for (const f of files) {
    for (const r of scanText(readRel(f))) {
      refs += 1;
      const resolved = resolveRef(f, r);
      if (resolved !== null && isFutureReceipt(resolved, today)) continue;
      if (resolved === null || !exists(resolved)) breaks.push({ file: f, line: r.line, kind: r.kind, target: r.target, resolved: resolved ?? "(outside the repo)" });
    }
  }
  return { refs, breaks };
}

/** Split breaks against the known list (keyed by file + target, not line — lines move). */
export function compareKnown(breaks, known) {
  const key = (b) => `${b.file} -> ${b.target}`;
  const knownSet = new Set(known.map(key));
  const seen = new Set(breaks.map(key));
  return {
    fresh: breaks.filter((b) => !knownSet.has(key(b))),
    known: breaks.filter((b) => knownSet.has(key(b))),
    stale: known.filter((k) => !seen.has(key(k))),
  };
}

// ── the archive move ────────────────────────────────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isHistory = (rel) => HISTORY_PREFIXES.some((p) => rel === p || rel.startsWith(p));
const isCode = (rel) => CODE_PREFIXES.some((p) => rel.startsWith(p)) && !rel.endsWith(".md");

/**
 * Plan a move of docs/<name> → docs/archive/<name> for each name, against the
 * given text files (repo-relative posix → text). Pure: returns
 *   { moves: [{from, to}], edits: Map<file, {before, after, changes: [{line, from, to}]}>,
 *     history: [{file, line, text}], refused: [{name, file, line, text}],
 *     unrewritten: [{file, line, text, why}] }
 */
export function planArchive(names, texts) {
  const moving = new Map(names.map((n) => [`docs/${n}`, `docs/archive/${n}`]));
  const newHome = (rel) => moving.get(rel) ?? rel;
  const refused = [];
  const history = [];
  const unrewritten = [];
  const edits = new Map();

  // Refusal first: any code/migration file naming a moving doc.
  for (const [file, text] of texts) {
    if (!isCode(file)) continue;
    text.split("\n").forEach((line, i) => {
      for (const n of names) {
        if (new RegExp(`(^|[^A-Za-z0-9_])${esc(n)}`).test(line)) refused.push({ name: n, file, line: i + 1, text: line.trim() });
      }
    });
  }
  const refusedNames = new Set(refused.map((r) => r.name));
  for (const [from] of [...moving]) if (refusedNames.has(from.slice(5))) moving.delete(from);
  const live = [...moving.keys()].map((p) => p.slice(5));

  for (const [file, text] of texts) {
    if (isCode(file)) continue;
    const lines = text.split("\n");
    const changes = [];
    const fileDirAfter = posix.dirname(newHome(file));
    const fileMoves = moving.has(file);
    let fence = false;
    const next = lines.map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const hits = live.filter((n) => line.includes(n));
      const relLinks = fileMoves && !fence && /\]\(/.test(line);
      const bareSibling = fileMoves && /`[A-Z][A-Z0-9_]+\.md`/.test(line);
      if (!hits.length && !relLinks && !bareSibling) return line;
      if (isHistory(file)) {
        if (hits.length) history.push({ file, line: i + 1, text: line.trim() });
        return line;
      }
      let out = line;
      // (1) `docs/<name>` from the repo root — not when it is the tail of a
      // longer relative path (`../docs/<name>`), which (2) handles.
      for (const n of hits) out = out.replace(new RegExp(`(?<![A-Za-z0-9_./-])docs/${esc(n)}`, "g"), `docs/archive/${n}`);
      // (2) relative markdown links: resolve against the OLD tree, re-express
      // from the linking file's NEW home to the target's NEW home. ANY target,
      // not only .md — a moved file's `](../packages/…/index.ts#L12)` breaks
      // exactly like its `.md` links do (PIPELINE_AUDIT.md carries 66 of them).
      if (!fence) {
        out = out.replace(/\]\(\s*([^)\s#]+?)(#[^)\s]*)?\)/g, (all, t, anchor = "") => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(t) || TEMPLATED.test(t) || t.startsWith("/")) return all;
          const target = posix.normalize(posix.join(posix.dirname(file), t));
          if (target.startsWith("../")) return all;
          if (!fileMoves && !moving.has(target)) return all;
          let rel = posix.relative(fileDirAfter, newHome(target));
          if (!rel.startsWith(".") && !rel.includes("/") && t.startsWith("./")) rel = `./${rel}`;
          return rel === t ? all : `](${rel}${anchor})`;
        });
      }
      // (3) a bare backtick sibling name, from a file that sits in docs/.
      const siblingContext = posix.dirname(file) === "docs";
      for (const n of live) {
        const re = new RegExp("`" + esc(n) + "`", "g");
        if (!re.test(out)) continue;
        if (siblingContext) {
          const rel = posix.relative(fileDirAfter, `docs/archive/${n}`);
          if (rel !== n) out = out.replace(re, "`" + rel + "`");
        }
      }
      // A moved file's bare backtick sibling names that are NOT moving now
      // point one level up.
      if (fileMoves) {
        for (const m of [...out.matchAll(/`([A-Z][A-Z0-9_]+\.md)`/g)]) {
          const n = m[1];
          if (live.includes(n) || !texts.has(`docs/${n}`)) continue;
          out = out.replace("`" + n + "`", "`../" + n + "`");
        }
      }
      if (out !== line) changes.push({ line: i + 1, from: line.trim(), to: out.trim() });
      // Anything still naming a moving doc without a path we recognised.
      for (const n of hits) {
        const stillBare = new RegExp(`(^|[^A-Za-z0-9_/])${esc(n)}`).test(out.replace(new RegExp(`archive/${esc(n)}`, "g"), ""));
        if (stillBare && !(fileMoves || posix.dirname(file) === "docs/archive")) {
          unrewritten.push({ file, line: i + 1, text: out.trim(), why: "a bare name with no path — prose, not a link" });
        }
      }
      return out;
    });
    if (changes.length) edits.set(file, { before: text, after: next.join("\n"), changes });
  }
  return {
    moves: [...moving].map(([from, to]) => ({ from, to })),
    edits,
    history,
    refused,
    unrewritten,
  };
}

// ── the command ─────────────────────────────────────────────────────────────

function gitFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...CENSUS_GLOBS, "*.md"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => /\.(md|mdx|mjs|cjs|js|ts|tsx|sql|yml|yaml|json|toml|txt)$/.test(f))
    .filter((f) => !f.includes("node_modules/") && !f.startsWith("scripts/__fixtures__/"));
}

function readKnown(root) {
  const p = join(root, KNOWN_BREAKS_PATH);
  if (!existsSync(p)) return [];
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(j.breaks) ? j.breaks : [];
}

export function main(argv = process.argv.slice(2), { root = REPO, stdout = process.stdout, stderr = process.stderr } = {}) {
  const dry = argv.includes("--dry-run");
  const ai = argv.indexOf("--archive");
  const readRel = (f) => readFileSync(join(root, f), "utf8");
  const exists = (rel) => existsSync(join(root, rel));

  if (ai !== -1) {
    const names = argv.slice(ai + 1).filter((a) => !a.startsWith("--"));
    if (!names.length) {
      stderr.write("check:doc-links — --archive needs at least one docs/<name>.md\n");
      return 1;
    }
    const missing = names.filter((n) => !exists(`docs/${n}`));
    if (missing.length) {
      stderr.write(`check:doc-links — not at docs/: ${missing.join(", ")}\n`);
      return 1;
    }
    const texts = new Map(gitFiles(root).map((f) => [f, readRel(f)]));
    const plan = planArchive(names, texts);
    for (const r of plan.refused) stdout.write(`REFUSED  ${r.name} — code reference ${r.file}:${r.line}: ${r.text.slice(0, 160)}\n`);
    for (const m of plan.moves) stdout.write(`git mv   ${m.from} → ${m.to}\n`);
    let n = 0;
    for (const [file, e] of [...plan.edits].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      for (const c of e.changes) {
        n += 1;
        stdout.write(`rewrite  ${file}:${c.line}\n    - ${c.from.slice(0, 220)}\n    + ${c.to.slice(0, 220)}\n`);
      }
    }
    for (const h of plan.history) stdout.write(`history  ${h.file}:${h.line} left as written: ${h.text.slice(0, 160)}\n`);
    for (const u of plan.unrewritten) stdout.write(`bare     ${u.file}:${u.line} (${u.why}): ${u.text.slice(0, 160)}\n`);
    stdout.write(
      `check:doc-links — ${plan.moves.length} move(s), ${n} line rewrite(s) in ${plan.edits.size} file(s), ` +
        `${plan.history.length} history hit(s) left, ${plan.refused.length} refusal(s)${dry ? " — DRY RUN, nothing changed" : ""}\n`,
    );
    if (dry) return 0;
    for (const m of plan.moves) execFileSync("git", ["mv", m.from, m.to], { cwd: root });
    for (const [file, e] of plan.edits) {
      const moved = plan.moves.find((m) => m.from === file);
      writeFileSync(join(root, moved ? moved.to : file), e.after, "utf8");
    }
    return 0;
  }

  const files = checkFiles(root);
  const { refs, breaks } = checkTree(files, readRel, exists);
  const cmp = compareKnown(breaks, readKnown(root));
  const fmt = (b) => `  ${b.file}:${b.line}  [${b.kind}] ${b.target} → ${b.resolved}`;
  if (dry) {
    stdout.write(`check:doc-links — ${files.length} files, ${refs} references, ${breaks.length} break(s) (${cmp.known.length} known, ${cmp.fresh.length} new)\n`);
    for (const b of breaks) stdout.write(`${fmt(b)}${cmp.fresh.includes(b) ? "   ← NEW" : ""}\n`);
    for (const s of cmp.stale) stdout.write(`  (known break no longer breaks — remove it from ${KNOWN_BREAKS_PATH}: ${s.file} -> ${s.target})\n`);
    return 0;
  }
  for (const s of cmp.stale) stdout.write(`check:doc-links — note: ${s.file} -> ${s.target} is listed in ${KNOWN_BREAKS_PATH} but resolves now; remove it.\n`);
  if (cmp.fresh.length) {
    stderr.write(`check:doc-links — ${cmp.fresh.length} reference(s) to a doc that does not exist:\n${cmp.fresh.map(fmt).join("\n")}\n`);
    stderr.write(
      [
        "",
        "Fix the link, or — if the doc moved — point it at the new path. An archive",
        "move should go through `pnpm check:doc-links --archive <name>.md`, which",
        "rewrites every reference it can see. (FIX-1243)",
        "",
      ].join("\n"),
    );
    return 1;
  }
  stdout.write(`check:doc-links — OK (${files.length} files, ${refs} references, ${cmp.known.length} known pre-existing break(s))\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
