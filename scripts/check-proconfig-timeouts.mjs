#!/usr/bin/env node
// check-proconfig-timeouts.mjs — FIX-1128
//
// WHY THIS EXISTS. A function-level `SET statement_timeout` — the proconfig
// form, written in a routine's header or via `ALTER FUNCTION … SET` — does not
// bound the call it decorates. `statement_timeout` is armed once, by the
// server, at the start of a top-level client statement, from the GUC value at
// that moment; changing the GUC from inside the statement changes what
// `current_setting()` reports and nothing else.
//
// Measured both directions on the clone (PG 17), recorded in
// docs/audits/2026-09-13-fix1128-experiments.md:
//   - it cannot TIGHTEN: session 60s, proconfig 1s, a 3s sleep completed.
//   - it cannot LOOSEN : session 2s, proconfig 30s, a 5s sleep was cancelled
//                        at 2.001s — identically to the same body with no
//                        proconfig at all.
//
// So the value is inert in both directions. It is nonetheless read as a guard:
// FIX-1123's 21,638-second run carried "1200s", and two of the 91 functions
// FIX-1128 stripped (`derive_nh_floterials`, `revoke_grant`) were written with
// one AFTER FIX-1128 was filed. Stripping without a guard buys a few weeks.
//
// WHAT IT FLAGS
//   CREATE [OR REPLACE] FUNCTION|PROCEDURE … SET statement_timeout = …
//   ALTER FUNCTION|PROCEDURE … SET statement_timeout = …
//
// WHAT IT DOES NOT FLAG — these are the real mechanisms, not the inert one:
//   SET statement_timeout = '…';          as its own statement (arms the NEXT one)
//   set_config('statement_timeout', …)    a function call, same rules as above
//   ALTER … RESET statement_timeout       removing the decoration
//   ALTER ROLE … SET statement_timeout    role-level, which genuinely applies
//   anything inside a routine BODY        the body is code, not the header
//
// THE ESCAPE HATCH. `-- fix1128: <reason>` on the offending line or the line
// above waives it, and the reason is printed so it stays attached to the value.
//
// A NOTE ON WHAT THE HATCH IS *NOT* FOR. The design of record imagined one
// legitimate case — a PROCEDURE whose post-COMMIT units arm from its own
// proconfig. Experiment 2 showed that object cannot exist: a routine carrying
// any SET clause runs in an atomic context and cannot execute COMMIT at all
// ("invalid transaction termination"). That is also why the FIX-1128 census
// found 91 functions and zero procedures. The hatch remains for a deliberate,
// argued exception; it has no known legitimate use today.
//
// BASELINE. The 91 historical migrations that created the pattern would all
// fail this scan, and they are append-only history. So the scan starts AFTER
// the migration that stripped them — BASELINE_MIGRATION below — and only looks
// at files that sort after it. `--since <filename>` overrides for a one-off
// audit; `--all` scans everything and is expected to fail loudly.
//
// USAGE
//   node scripts/check-proconfig-timeouts.mjs          # exit 1 on an undeclared hit
//   pnpm check:proconfig
//   pnpm check:proconfig --all                         # audit history too
//   pnpm check:proconfig --since 20260101000000_x.sql
//   pnpm check:proconfig --dir <path>                  # fixtures; scans every file
//
// Dependency-free by design: a text scan, no database, so it runs in the unit
// job with no secrets.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const TAG = "[proconfig]";

/** The strip. Only migrations sorting AFTER this are scanned. */
export const BASELINE_MIGRATION = "20260913000000_fix1128_reset_inert_statement_timeout.sql";

const WAIVER_RE = /--\s*fix1128:\s*(.+)$/i;

/**
 * Blank out everything that is not plain SQL code — dollar-quoted bodies,
 * single-quoted strings, and `--` / block comments — while preserving byte
 * offsets, so a regex match maps back to a real line number.
 *
 * Returns { code, bodySpans } where bodySpans are [start, end) offsets of
 * dollar-quoted regions (a routine's body starts at the first one after its
 * CREATE).
 */
export function maskNonCode(text) {
  const out = Array.from(text);
  const bodySpans = [];
  let i = 0;
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    // line comment
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    // block comment (not nested-aware beyond one level, which is enough here)
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // single-quoted string
    if (text[i] === "'") {
      let k = i + 1;
      while (k < n) {
        if (text[k] === "'" && text[k + 1] === "'") { k += 2; continue; }
        if (text[k] === "'") { k++; break; }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    // dollar-quoted body
    const dq = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
    if (dq) {
      const tag = dq[0];
      const close = text.indexOf(tag, i + tag.length);
      const stop = close === -1 ? n : close + tag.length;
      bodySpans.push([i, stop]);
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return { code: out.join(""), bodySpans };
}

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Find every inert `SET statement_timeout` in one SQL file.
 * Returns [{ line, kind, snippet, waiver }].
 */
export function scanSql(text) {
  const { code, bodySpans } = maskNonCode(text);
  const lines = text.split("\n");
  const hits = [];

  const record = (offset, kind) => {
    const line = lineOf(text, offset);
    const here = lines[line - 1] ?? "";
    const above = lines[line - 2] ?? "";
    const waiver = (WAIVER_RE.exec(here) ?? WAIVER_RE.exec(above) ?? [])[1] ?? null;
    hits.push({ line, kind, snippet: here.trim(), waiver: waiver ? waiver.trim() : null });
  };

  // ── CREATE [OR REPLACE] FUNCTION|PROCEDURE … <header> … <body opener> ─────
  const createRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/gi;
  for (let m = createRe.exec(code); m; m = createRe.exec(code)) {
    const start = m.index;
    // The header ends at the routine's body (the first dollar-quoted span after
    // the CREATE), or at the statement terminator if there is none.
    const body = bodySpans.find(([s]) => s > start);
    const semi = code.indexOf(";", start);
    const endCandidates = [body ? body[0] : Infinity, semi === -1 ? Infinity : semi];
    const end = Math.min(...endCandidates);
    if (!Number.isFinite(end)) continue;

    const header = code.slice(start, end);
    const setRe = /\bSET\s+statement_timeout\b/gi;
    for (let s = setRe.exec(header); s; s = setRe.exec(header)) {
      record(start + s.index, `CREATE ${m[1].toUpperCase()}`);
    }
  }

  // ── ALTER FUNCTION|PROCEDURE … SET statement_timeout ──────────────────────
  // RESET is fine: `\bSET\b` cannot match inside "RESET" (the S is preceded by
  // a word character), which is exactly the distinction we want.
  const alterRe = /\bALTER\s+(FUNCTION|PROCEDURE)\b[^;]*?\bSET\s+statement_timeout\b/gi;
  for (let m = alterRe.exec(code); m; m = alterRe.exec(code)) {
    const rel = m[0].search(/\bSET\s+statement_timeout\b/i);
    record(m.index + rel, `ALTER ${m[1].toUpperCase()}`);
  }

  return hits.sort((a, b) => a.line - b.line);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main(argv) {
  let since = BASELINE_MIGRATION;
  let dir = MIGRATIONS_DIR;
  let scanAll = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") since = argv[++i];
    else if (argv[i] === "--all") scanAll = true;
    else if (argv[i] === "--dir") { dir = argv[++i]; scanAll = true; }
  }

  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.error(`${TAG} cannot read ${dir}`);
    return 1;
  }
  const scanned = scanAll ? files : files.filter((f) => f > since);

  let problems = 0;
  let waived = 0;
  for (const f of scanned) {
    const full = join(dir, f);
    const hits = scanSql(readFileSync(full, "utf8"));
    for (const h of hits) {
      const where = `${relative(ROOT, full).replace(/\\/g, "/")}:${h.line}`;
      if (h.waiver) {
        waived++;
        console.log(`${TAG} WAIVED  ${where} — ${h.kind}\n      ${h.snippet}\n      reason: ${h.waiver}`);
        continue;
      }
      problems++;
      console.error(
        `${TAG} INERT TIMEOUT — ${where} (${h.kind})\n` +
          `      ${h.snippet}\n` +
          `      A routine-level SET statement_timeout bounds nothing (FIX-1128): the timer is\n` +
          `      armed at the start of the top-level statement, and changing the GUC from inside\n` +
          `      it only changes what current_setting() reports.\n` +
          `      Bound the CALLER instead — a SET as its own statement before the call, or the\n` +
          `      pg_cron job's command string ("SET statement_timeout='…'; CALL …").\n` +
          `      If this one really is deliberate, say why on the line or the line above:\n` +
          `        -- fix1128: <why this is not inert>`,
      );
    }
  }

  const summary =
    `${TAG} ${scanned.length} migration(s) scanned` +
    (scanAll ? " (all)" : ` (after ${since})`) +
    `; ${waived} waived, ${problems} undeclared.`;
  if (problems > 0) {
    console.error(summary);
    return 1;
  }
  console.log(summary);
  return 0;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("check-proconfig-timeouts.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
