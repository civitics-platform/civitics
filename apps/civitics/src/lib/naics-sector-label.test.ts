/**
 * FIX-1247 — the NAICS label table, pinned to the SQL CASE it mirrors.
 *
 * naics-sector-label.ts is a TS copy of the `CASE SUBSTRING(<naics_code> FROM 1
 * FOR 2) … END` that chord_contract_flows_full(), treemap_recipients_by_
 * contracts_full() and refresh_contract_flow_rollups() carry. The migrations
 * are read as text from disk (the FIX-543 / FIX-1237 drift-test pattern): the
 * LAST migration that carries the CASE is the live definition, every copy in it
 * must agree, and the TS table must equal it. A new arm in SQL without the TS
 * one — or the reverse — fails here instead of splitting one recipient into two
 * sectors across the chord and the Sankey.
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

const CASE_OPEN = /CASE\s+SUBSTRING\(\s*(?:MIN\(\s*)?fr\.metadata->>'naics_code'\s*\)?\s+FROM\s+1\s+FOR\s+2\s*\)/gi;

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

/** The newest migration carrying the CASE, and its parsed copies. */
function latestCase(): { file: string; cases: ParsedCase[] } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const cases = parseNaicsCases(readFileSync(join(MIGRATIONS, files[i]!), "utf8"));
    if (cases.length > 0) return { file: files[i]!, cases };
  }
  throw new Error("no migration carries the NAICS CASE");
}

test("FIX-1247 the TS table equals every copy of the NAICS CASE in the latest migration", () => {
  const { file, cases } = latestCase();
  // chord_contract_flows_full, treemap_recipients_by_contracts_full, and the
  // procedure's two CTEs — at least those four in the file that defines them.
  assert.ok(cases.length >= 4, `${file}: expected >= 4 CASE copies, parsed ${cases.length}`);
  for (const [i, c] of cases.entries()) {
    assert.deepEqual(c.arms, { ...NAICS_SECTOR_LABELS }, `${file} CASE #${i + 1}: arms differ from naics-sector-label.ts`);
    assert.equal(c.otherwise, NAICS_SECTOR_OTHER, `${file} CASE #${i + 1}: ELSE differs`);
  }
});

test("FIX-1247 the parser sees a one-arm edit (the drift test can go red)", () => {
  const { file } = latestCase();
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const mutated = sql.replace("WHEN '53' THEN 'Real Estate'", "WHEN '53' THEN 'Real Estate & Rental'");
  assert.notEqual(mutated, sql, "the mutation must hit an arm");
  const cases = parseNaicsCases(mutated);
  assert.ok(cases.some((c) => c.arms["53"] !== NAICS_SECTOR_LABELS["53"]));
  const dropped = parseNaicsCases(sql.replace("WHEN '55' THEN 'Management'", ""));
  assert.ok(dropped.some((c) => !("55" in c.arms)));
});

test("FIX-1247 naicsSectorLabel mirrors the CASE, including its NULL and ELSE", () => {
  assert.equal(naicsSectorLabel("236220"), "Construction");
  assert.equal(naicsSectorLabel("541330"), "Professional Services");
  assert.equal(naicsSectorLabel("531110"), "Real Estate");      // was missing from the SQL
  assert.equal(naicsSectorLabel("551112"), "Management");       // was missing from the SQL
  assert.equal(naicsSectorLabel("561612"), "Administrative Services"); // the Sankey said "Administrative"
  assert.equal(naicsSectorLabel("621111"), "Healthcare");       // the Sankey said "Health Care"
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
