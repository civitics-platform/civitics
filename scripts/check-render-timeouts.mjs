#!/usr/bin/env node
// scripts/check-render-timeouts.mjs — P0 request-path cost defense
//
// CI guard against the unwrapped render-path read shape:
//
//   const { data } = await supabase.from("t").select("...")...   // no timeout
//   const { data } = await supabase.rpc("fn", { ... })            // no timeout
//
// Why this is a COST defense, not just correctness: Vercel bills provisioned
// fluid-compute memory for the ENTIRE time a function is blocked on I/O. A slow
// or degraded DB makes a server-rendered page hang on each query, accruing
// GB-hours while it waits. `withDbTimeout(query, ms)` (apps/civitics/src/lib/
// supabase-check.ts) races the query against a timeout and returns
// `{ data: null, error }` instead of hanging — so a degraded DB yields a fast,
// degraded render instead of an expensive stalled one. It is also the only
// defense against a low-and-slow crawl that evades the IP rate limiters.
//
// What it flags: a PostgREST read — a `.from(...).select(` chain or a `.rpc(`
// call — under apps/civitics/app/** (excluding api routes and client
// components) that is NOT lexically enclosed in a `withDbTimeout(` call.
// Writes (`.insert/.upsert/.update/.delete`) and `.storage.` calls are out of
// scope (this guard is about read fail-fast).
//
// Opt-out: put `// db-timeout-exempt: <reason>` on the read line or the line
// above. Reserve it for the rare legitimate case (e.g. a query builder defined
// on one line and wrapped on the next, or a genuinely build-time-only path).
//
// Scope rationale: page renders are the cost driver the 2026-06-21 audit
// flagged. API routes under app/api/** already use withDbTimeout pervasively
// and are excluded here to keep this guard focused on the request-path PAGE
// surface; client components (`"use client"`) never run server-side DB queries.
//
// Known limitation (documented, accepted): detection is lexical. A read whose
// `.from(` and its enclosing `withDbTimeout(` are split across a variable
// assignment slips the enclosure check and must use the opt-out comment.
// Render-time helpers imported from apps/civitics/src/lib are NOT scanned (that
// dir is shared with client code); wrap their reads by hand.
//
// Modes:
//   node scripts/check-render-timeouts.mjs           → check, exit 1 on offenders
//   node scripts/check-render-timeouts.mjs --audit   → dump EVERY PostgREST read
//       under the scanned surface with wrapped/exempt columns

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCAN_DIRS = ["apps/civitics/app"];
const AUDIT = process.argv.includes("--audit");

// Build-time metadata routes — excluded (see collectFiles).
const BUILD_TIME_FILES = new Set(["sitemap.ts", "robots.ts", "manifest.ts"]);

// ---------------------------------------------------------------------------
// File collection — server components under app/, excluding api routes and
// client components.
// ---------------------------------------------------------------------------

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      if (name === "api") continue; // api routes excluded — see scope rationale
      collectFiles(p, out);
    } else if (
      (name.endsWith(".tsx") || name.endsWith(".ts")) &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      // Build-time metadata routes (regenerated on `revalidate`, not per
      // request) carry their own 5s Promise.race timeout + degrade-to-static
      // guardrails — same class as generateStaticParams. Out of scope here.
      !BUILD_TIME_FILES.has(name)
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
// (Copied from check-silent-reads.mjs.)
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
// Read a bracket-balanced expression starting at the offset of an opening
// paren `(`; return [innerStart, closeOffset] of the matching `)`. Skips
// strings / template literals (comments are already stripped).
// ---------------------------------------------------------------------------

function matchParen(src, openParenOffset) {
  let depth = 0;
  let i = openParenOffset;
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
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return [openParenOffset + 1, i];
    }
    i++;
  }
  return [openParenOffset + 1, src.length];
}

// Forward statement/expression read for "does this .from(...) chain include
// .select( before the statement terminates" — bracket-balanced, capped.
function readExpr(src, start) {
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
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth < 0) return src.slice(start, i); // closed our enclosing group
    } else if (c === ";" && depth <= 0) return src.slice(start, i);
    i++;
  }
  return src.slice(start, i);
}

function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

function scanFile(path) {
  const raw = readFileSync(path, "utf8");
  const src = stripComments(raw);
  const lines = raw.split("\n");

  // Client components never run server-side DB queries.
  if (/^\s*["']use client["']/m.test(raw)) return [];

  // Compute all withDbTimeout( ... ) enclosure spans [innerStart, closeOffset].
  // The optional `(?:<…>)?` clause matches the generic-typed call form
  // `withDbTimeout<{ data: … }>(query)` — required when the query builder is
  // `any`-typed (an `any` builder makes `withDbTimeout<T>` infer T=unknown, so
  // call sites add an explicit type arg). Non-greedy + `[^;()]` keep it on one
  // call expression so a far-away `>(` can't be misread as this call.
  const wrapSpans = [];
  for (const m of src.matchAll(/\bwithDbTimeout\s*(?:<[^;()]*?>)?\s*\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const [s, e] = matchParen(src, openParen);
    wrapSpans.push([s, e]);
  }
  const enclosed = (off) => wrapSpans.some(([s, e]) => off >= s && off <= e);

  // generateStaticParams runs at BUILD time, not on the request path. Per
  // CLAUDE.md it already carries its own Promise.race + 5s + degrade-to-[]
  // guardrails — leave it alone. Compute its body span and skip reads inside.
  const gspSpans = [];
  for (const m of src.matchAll(/\bgenerateStaticParams\b/g)) {
    // Find the function-body `{`. A return-type annotation can contain braces
    // (`: Promise<Array<{ id: string }>>`), so "first `{` after the name" is
    // wrong — those braces sit inside `<…>`. Walk forward tracking angle-depth
    // (skipping `=>` so an arrow body isn't miscounted) and take the first `{`
    // seen at angle-depth 0 as the real body brace.
    let angle = 0, brace = -1;
    for (let j = m.index + m[0].length; j < src.length; j++) {
      const c = src[j];
      if (c === "=" && src[j + 1] === ">") { j++; continue; } // arrow, not generic
      if (c === "<") angle++;
      else if (c === ">") { if (angle > 0) angle--; }
      else if (c === "{" && angle === 0) { brace = j; break; }
      else if (c === ";") break; // overload signature / declaration only
    }
    if (brace === -1) continue;
    // brace-match the function body
    let depth = 0, i = brace;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        const q = c; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    gspSpans.push([brace, i]);
  }
  const inBuildTime = (off) => gspSpans.some(([s, e]) => off >= s && off <= e);

  const found = [];

  // ── .from(...).select( read chains ──────────────────────────────────────
  for (const m of src.matchAll(/\.from\s*\(/g)) {
    const off = m.index;
    const expr = readExpr(src, off);
    if (!expr.includes(".select(")) continue; // not a read (filters Array.from etc.)
    if (/\.(insert|upsert|update|delete)\s*\(/.test(expr)) continue; // write
    if (expr.includes(".storage.")) continue;
    record(off, "from+select");
  }

  // ── .rpc( calls ─────────────────────────────────────────────────────────
  for (const m of src.matchAll(/\.rpc\s*\(/g)) {
    record(m.index, "rpc");
  }

  function record(off, kind) {
    if (inBuildTime(off)) return; // generateStaticParams — build-time, skip
    const wrapped = enclosed(off);
    const line = lineOf(src, off);
    const thisLine = lines[line - 1] ?? "";
    const prevLine = lines[line - 2] ?? "";
    const optedOut =
      thisLine.includes("db-timeout-exempt:") ||
      prevLine.includes("db-timeout-exempt:");
    found.push({
      file: relative(ROOT, path).replaceAll("\\", "/"),
      line,
      kind,
      wrapped,
      optedOut,
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const all = [];
for (const dir of SCAN_DIRS) {
  for (const f of collectFiles(join(ROOT, dir))) all.push(...scanFile(f));
}

if (AUDIT) {
  console.log("file:line | kind | wrapped | exempt");
  for (const r of all) {
    console.log(
      `${r.file}:${r.line} | ${r.kind} | ${r.wrapped ? "Y" : "N"} | ${r.optedOut ? "Y" : "N"}`,
    );
  }
  console.log(`\n${all.length} render-path PostgREST reads scanned.`);
  process.exit(0);
}

const offenders = all.filter((r) => !r.wrapped && !r.optedOut);

if (offenders.length === 0) {
  console.log(
    `check:render-timeouts — OK (${all.length} render-path PostgREST reads scanned, 0 unwrapped)`,
  );
  process.exit(0);
}

console.error(
  `check:render-timeouts — ${offenders.length} unwrapped render-path read(s):\n`,
);
for (const r of offenders) {
  console.error(`  ${r.file}:${r.line}  (${r.kind})`);
}
console.error(
  "\nEach of these executes a PostgREST read on the page-render path without",
);
console.error(
  "withDbTimeout, so a slow/degraded DB makes the render hang and accrue Vercel",
);
console.error(
  "provisioned-memory GB-hours while it waits. Wrap the query in withDbTimeout(",
);
console.error(
  "query, ms, \"page:label\") from @/lib/supabase-check — or, only if a hang here",
);
console.error(
  "is genuinely fine, add `// db-timeout-exempt: <reason>` on the line above.",
);
process.exit(1);
