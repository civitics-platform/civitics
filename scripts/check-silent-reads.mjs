#!/usr/bin/env node
// scripts/check-silent-reads.mjs — FIX-546
//
// CI guard against the silent-zero PostgREST read shape:
//
//   const { data } = await db.from("t").select("...")...   // no `error` check
//
// A transient gateway/PostgREST failure makes that read return `data: null`,
// which `data ?? []` turns into "table is empty". When the result feeds a
// preload Map/Set, downstream matching silently re-does everything from
// scratch while the run looks clean (FIX-422, FIX-545 / the FIX-294 rerun).
//
// What it flags: a `const { data } = await …` / `const { data: x } = await …`
// destructure whose destructure body does NOT mention `error`, where the
// awaited statement is a PostgREST read chain — contains `.from(` and
// `.select(` — and is not a single-row read (`.single()` / `.maybeSingle()`),
// an RPC (`.rpc(`), a write (`.insert(` / `.upsert(` / `.update(` / `.delete(`),
// or a storage call (`.storage.`).
//
// Opt-out: put `// reads-ok: <reason>` on the `const` line or the line above.
// Reserve it for reads where a null/empty result is genuinely equivalent to
// "no rows" for the caller — not for preloads.
//
// Known limitation (documented, accepted): only the destructure-of-await
// shape is detected. `const res = await …; const { data } = res;` slips
// through — but that split shape is rare here and the audit
// (docs/audits/2026-06-09-read-degradation-audit.md) covered the stock.
//
// Modes:
//   node scripts/check-silent-reads.mjs            → check, exit 1 on offenders
//   node scripts/check-silent-reads.mjs --audit    → dump EVERY destructured
//       PostgREST read with mechanical shape columns (used to build the
//       FIX-545 audit doc; not run in CI)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCAN_DIRS = ["packages/data/src", "packages/db/src"];
const AUDIT = process.argv.includes("--audit");

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectTsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__fixtures__") continue;
      collectTsFiles(p, out);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment stripper — replace // and /* */ comment bodies with spaces
// (length-preserving, newlines kept) so code shapes quoted in docstrings
// don't match. String-aware: `//` inside a string literal is not a comment.
// ---------------------------------------------------------------------------

function stripComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Statement scanner — from a start offset, consume a bracket-balanced
// statement, skipping strings / template literals / comments, until a `;`
// at depth 0 (or EOF / a hard cap as fallback).
// ---------------------------------------------------------------------------

function readStatement(src, start) {
  let depth = 0;
  let i = start;
  const cap = Math.min(src.length, start + 8000);
  while (i < cap) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < cap && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < cap && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < cap && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth <= 0) return src.slice(start, i);
    i++;
  }
  return src.slice(start, i);
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

const DESTRUCTURE_RE = /const\s*\{([^}]*)\}\s*=\s*await\b/g;

function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

function scanFile(path) {
  const raw = readFileSync(path, "utf8");
  // Match against comment-stripped source so docstring examples don't fire;
  // keep raw lines around for the `reads-ok:` opt-out check (it lives in a
  // comment by design).
  const src = stripComments(raw);
  const lines = raw.split("\n");
  const found = [];

  for (const m of src.matchAll(DESTRUCTURE_RE)) {
    const bindings = m[1];
    if (!/\bdata\b/.test(bindings)) continue; // count-only / status-only destructures

    const stmt = readStatement(src, m.index + m[0].length);
    // PostgREST read chain only — `.from(` excludes raw pg / fetch; `.select(`
    // excludes storage and bare RPCs; write/select-returning excluded below.
    if (!stmt.includes(".from(") || !stmt.includes(".select(")) continue;
    if (/\.(insert|upsert|update|delete)\s*\(/.test(stmt)) continue;
    if (stmt.includes(".storage.")) continue;

    const hasError = /\berror\b/.test(bindings);
    const single = /\.(single|maybeSingle)\s*\(/.test(stmt);
    const rpc = /\.rpc\s*\(/.test(stmt);
    const line = lineOf(src, m.index);
    const thisLine = lines[line - 1] ?? "";
    const prevLine = lines[line - 2] ?? "";
    const optedOut = thisLine.includes("reads-ok:") || prevLine.includes("reads-ok:");

    found.push({
      file: relative(ROOT, path).replaceAll("\\", "/"),
      line,
      bindings: bindings.replace(/\s+/g, " ").trim(),
      hasError,
      single,
      rpc,
      optedOut,
      hasRange: stmt.includes(".range("),
      hasIn: stmt.includes(".in("),
      hasLimit: stmt.includes(".limit("),
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const all = [];
for (const dir of SCAN_DIRS) {
  for (const f of collectTsFiles(join(ROOT, dir))) all.push(...scanFile(f));
}

if (AUDIT) {
  // Mechanical dump for the audit doc — every destructured PostgREST read.
  console.log("file:line | bindings | error-checked | single | rpc | range | in | limit | reads-ok");
  for (const r of all) {
    console.log(
      `${r.file}:${r.line} | {${r.bindings}} | ${r.hasError ? "Y" : "N"} | ` +
      `${r.single ? "Y" : "N"} | ${r.rpc ? "Y" : "N"} | ${r.hasRange ? "Y" : "N"} | ` +
      `${r.hasIn ? "Y" : "N"} | ${r.hasLimit ? "Y" : "N"} | ${r.optedOut ? "Y" : "N"}`,
    );
  }
  console.log(`\n${all.length} destructured PostgREST reads scanned.`);
  process.exit(0);
}

const offenders = all.filter((r) => !r.hasError && !r.single && !r.rpc && !r.optedOut);

if (offenders.length === 0) {
  console.log(`check:reads — OK (${all.length} destructured PostgREST reads scanned, 0 silent-zero)`);
  process.exit(0);
}

console.error(`check:reads — ${offenders.length} silent-zero PostgREST read(s):\n`);
for (const r of offenders) {
  console.error(`  ${r.file}:${r.line}  const {${r.bindings}} = await …`);
}
console.error(
  "\nEach of these destructures `data` without checking `error`, so a gateway",
);
console.error(
  "blip reads as an empty table (FIX-545/FIX-422 class). Either check `error`,",
);
console.error(
  "use rowsOrThrow/selectAllOrThrow from @civitics/db, or — only if empty-on-error",
);
console.error("is genuinely acceptable — add `// reads-ok: <reason>` on the line above.");
process.exit(1);
