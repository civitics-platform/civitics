/**
 * FIX-1247 — the NAICS label table, pinned to the SQL CASE it mirrors.
 *
 * naics-sector-label.ts is a TS copy of the `CASE SUBSTRING(<naics_code> FROM 1
 * FOR 2) … END` that chord_contract_flows_full(), treemap_recipients_by_
 * contracts_full() and refresh_contract_flow_rollups() carry. The migrations
 * are read as text from disk (the FIX-543 / FIX-1237 drift-test pattern): each
 * routine's live definition is the NEWEST migration that (re)defines it — not
 * the newest file carrying a CASE, since cc-183's FIX-1194 migration redefines
 * the procedure alone — every copy across the three must agree, and the TS
 * table must equal it. A new arm in SQL without the TS
 * one — or the reverse — fails here instead of splitting one recipient into two
 * sectors across the chord and the Sankey.
 *
 * FIX-1254 renamed the seven 1:1 arms to their industry labels, and FIX-1252
 * gave the treemap's copy a CTE column argument (`r.naics_code`, the dominant
 * code); the opener below matches all three argument shapes.
 *
 * Also checked: every label the contract surfaces can emit has a colour in
 * packages/graph (sector-colors.ts + industries.ts, read off disk — the app
 * cannot import the graph package's d3 modules into a node test).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAICS_SECTOR_LABELS, NAICS_SECTOR_OTHER, naicsSectorLabel } from "./naics-sector-label";

const REPO = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO, "supabase", "migrations");

// The CASE's argument is a row's code (`fr.metadata->>'naics_code'`, the chord),
// FIX-1247's `MIN(fr.metadata->>'naics_code')`, or since FIX-1252 the recipient's
// dominant code from a CTE column (`r.naics_code`, the treemap).
const CASE_OPEN =
  /CASE\s+SUBSTRING\(\s*(?:MIN\(\s*)?(?:fr\.metadata->>'naics_code'|[a-z_]+\.naics_code)\s*\)?\s+FROM\s+1\s+FOR\s+2\s*\)/gi;

type ParsedCase = { arms: Record<string, string>; otherwise: string | null };

/** Every NAICS CASE in one SQL text, each as its WHEN arms + ELSE. */
function parseNaicsCases(sqlWithComments: string): ParsedCase[] {
  // Strip `--` comments so a quoted example in a header is never parsed.
  const sql = sqlWithComments.replace(/--[^\n]*/g, "");
  const out: ParsedCase[] = [];
  for (const m of sql.matchAll(CASE_OPEN)) {
    const start = m.index! + m[0].length;
    const end = sql.indexOf("END", start);
    assert.ok(end > start, "a NAICS CASE with no END");
    const body = sql.slice(start, end);
    const arms: Record<string, string> = {};
    for (const w of body.matchAll(/WHEN\s+'(\d{2})'\s+THEN\s+'([^']+)'/g)) arms[w[1]!] = w[2]!;
    const otherwise = body.match(/ELSE\s+'([^']+)'/)?.[1] ?? null;
    out.push({ arms, otherwise });
  }
  return out;
}

/** The three routines that carry the CASE. */
const CASE_ROUTINES = [
  "chord_contract_flows_full",
  "treemap_recipients_by_contracts_full",
  "refresh_contract_flow_rollups",
] as const;

/** One routine's last definition in one SQL text, CREATE through its closing dollar-quote; null if absent. */
function routineDefinition(sqlWithComments: string, name: string): string | null {
  const sql = sqlWithComments.replace(/--[^\n]*/g, "");
  const opener = new RegExp(`CREATE OR REPLACE (?:FUNCTION|PROCEDURE) public\\.${name}\\(`, "g");
  let at = -1;
  for (const m of sql.matchAll(opener)) at = m.index!;
  if (at < 0) return null;
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(at));
  assert.ok(tag, `${name}: no dollar-quoted body`);
  const bodyStart = at + tag.index + tag[0].length;
  const end = sql.indexOf(tag[1]!, bodyStart);
  assert.ok(end > bodyStart, `${name}: unterminated body`);
  return sql.slice(at, end);
}

/** Each routine's LIVE definition — the newest migration that (re)defines it — and the CASE copies in it. */
function liveCases(): { where: string[]; cases: ParsedCase[] } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const text = new Map<string, string>();
  const read = (f: string) => text.get(f) ?? text.set(f, readFileSync(join(MIGRATIONS, f), "utf8")).get(f)!;
  const where: string[] = [];
  const cases: ParsedCase[] = [];
  for (const name of CASE_ROUTINES) {
    let found = false;
    for (let i = files.length - 1; i >= 0 && !found; i--) {
      const def = routineDefinition(read(files[i]!), name);
      if (def === null) continue;
      where.push(`${name}@${files[i]}`);
      cases.push(...parseNaicsCases(def));
      found = true;
    }
    assert.ok(found, `no migration defines ${name}`);
  }
  return { where, cases };
}

test("FIX-1247 the TS table equals every copy of the NAICS CASE in each routine's live definition", () => {
  const { where, cases } = liveCases();
  // chord_contract_flows_full, treemap_recipients_by_contracts_full, and the
  // procedure's two CTEs — at least four copies across the three live bodies.
  assert.ok(cases.length >= 4, `${where.join(", ")}: expected >= 4 CASE copies, parsed ${cases.length}`);
  for (const [i, c] of cases.entries()) {
    assert.deepEqual(c.arms, { ...NAICS_SECTOR_LABELS }, `CASE #${i + 1} (${where.join(", ")}): arms differ from naics-sector-label.ts`);
    assert.equal(c.otherwise, NAICS_SECTOR_OTHER, `CASE #${i + 1} (${where.join(", ")}): ELSE differs`);
  }
});

test("FIX-1247 the parser sees a one-arm edit (the drift test can go red)", () => {
  const { where } = liveCases();
  const file = where.find((w) => w.startsWith("refresh_contract_flow_rollups@"))!.split("@")[1]!;
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  // Every occurrence: the first may sit in the migration's header comment (the
  // FIX-1254 file writes the CASE once there), which the parser strips.
  const mutated = sql.split("WHEN '53' THEN 'Real Estate & Construction'").join("WHEN '53' THEN 'Real Estate'");
  assert.notEqual(mutated, sql, "the mutation must hit an arm");
  const cases = parseNaicsCases(mutated);
  assert.ok(cases.some((c) => c.arms["53"] !== NAICS_SECTOR_LABELS["53"]));
  const dropped = parseNaicsCases(sql.split("WHEN '55' THEN 'Management'").join(""));
  assert.ok(dropped.some((c) => !("55" in c.arms)));
});

test("FIX-1247 naicsSectorLabel mirrors the CASE, including its NULL and ELSE", () => {
  assert.equal(naicsSectorLabel("236220"), "Construction");
  assert.equal(naicsSectorLabel("541330"), "Professional Services");
  assert.equal(naicsSectorLabel("531110"), "Real Estate & Construction"); // FIX-1247 added 53; FIX-1254 its industry label
  assert.equal(naicsSectorLabel("551112"), "Management");       // was missing from the SQL
  assert.equal(naicsSectorLabel("561612"), "Administrative Services"); // the Sankey said "Administrative"
  assert.equal(naicsSectorLabel("621111"), "Health Care");      // FIX-1254: was "Healthcare" beside the industry's "Health Care"
  assert.equal(naicsSectorLabel("517310"), "Technology & Communications"); // FIX-1254: was "Information Technology"
  assert.equal(naicsSectorLabel("921110"), "Government");       // the Sankey said "Public Administration"
  assert.equal(naicsSectorLabel("999999"), "Other");
  assert.equal(naicsSectorLabel(null), "Other");
  assert.equal(naicsSectorLabel(undefined), "Other");
  assert.equal(naicsSectorLabel(""), "Other");
});

/** Object-literal keys from `const <name> … = { "Key": …, }` in a TS source file. */
function objectKeys(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf("{", src.indexOf("=", start));
  const close = src.indexOf("};", open);
  const body = src.slice(open, close).replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]!);
}

test("FIX-1247 every contract-surface label has a colour in packages/graph", () => {
  const graph = join(REPO, "packages", "graph", "src");
  const industries = readFileSync(join(graph, "industries.ts"), "utf8");
  const colors = readFileSync(join(graph, "sector-colors.ts"), "utf8");
  const labelToKey = new Set(objectKeys(industries, "LABEL_TO_KEY"));
  const naicsColored = new Set(objectKeys(colors, "NAICS_LABEL_COLORS"));
  assert.ok(labelToKey.has("defense & aerospace"), "the LABEL_TO_KEY parse found the current labels");

  // Every NAICS label the CASE can emit, plus its ELSE.
  const naicsLabels = new Set([...Object.values(NAICS_SECTOR_LABELS), NAICS_SECTOR_OTHER]);
  for (const label of naicsLabels) {
    assert.ok(
      labelToKey.has(label.toLowerCase()) || naicsColored.has(label),
      `NAICS label '${label}' resolves to no colour (add it to NAICS_LABEL_COLORS)`,
    );
  }
});
