/**
 * FIX-1450 (cc-325 D6) — an individual donor's FEC-reported line.
 *
 * Runs via:  tsx --test src/lib/donor-reported-line.test.ts
 *
 * The gate the STOP table names: `zip5` is never in the output, and the donors
 * page keeps the line out of generateMetadata and the JSON-LD (a source scan).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { donorReportedLine, reportedValue, REPORTED_CAPTION } from "./donor-reported-line";

const person = (metadata: Record<string, unknown> | null) => ({ entity_type: "individual", metadata });

test("the full line: occupation · employer · city, state", () => {
  assert.equal(
    donorReportedLine(person({ occupation: "CHAIRMAN", employer: "VAN WAGNER", city: "NEW YORK", state: "NY", zip5: "10022" })),
    "CHAIRMAN · VAN WAGNER · NEW YORK, NY",
  );
  assert.equal(REPORTED_CAPTION, "As reported on an FEC filing");
});

test("each non-answer is dropped, trimmed and case-insensitive", () => {
  for (const v of ["", "   ", "N/A", "n/a", "NA", "None", "NULL", ".", "REQUESTED", " requested ",
                   "INFORMATION REQUESTED", "Information Requested Per Best Efforts", null, undefined, 42]) {
    assert.equal(reportedValue(v), null, JSON.stringify(v));
    assert.equal(
      donorReportedLine(person({ occupation: v, employer: "ACME", city: "AUSTIN", state: "TX" })),
      "ACME · AUSTIN, TX",
      JSON.stringify(v),
    );
  }
});

test("answers stay: RETIRED, NOT EMPLOYED, SELF-EMPLOYED, SELF EMPLOYED, SELF, HOMEMAKER", () => {
  for (const v of ["RETIRED", "NOT EMPLOYED", "SELF-EMPLOYED", "SELF EMPLOYED", "SELF", "HOMEMAKER"]) {
    assert.equal(reportedValue(v), v);
  }
  assert.equal(
    donorReportedLine(person({ occupation: "ATTORNEY", employer: "SELF", city: "BOSTON", state: "MA" })),
    "ATTORNEY · SELF · BOSTON, MA",
  );
});

test("occupation and employer that are the same answer print once", () => {
  assert.equal(
    donorReportedLine(person({ occupation: "RETIRED", employer: "RETIRED", city: "TAMPA", state: "FL" })),
    "RETIRED · TAMPA, FL",
  );
  assert.equal(
    donorReportedLine(person({ occupation: "SELF-EMPLOYED", employer: "self employed", city: null, state: null })),
    "SELF-EMPLOYED",
  );
});

test("a row with only a city prints the city; only a state prints the state; nothing prints nothing", () => {
  assert.equal(donorReportedLine(person({ city: "PASADENA" })), "PASADENA");
  assert.equal(donorReportedLine(person({ state: "CA", employer: "N/A" })), "CA");
  assert.equal(donorReportedLine(person({ employer: "N/A", occupation: "INFORMATION REQUESTED" })), null);
  assert.equal(donorReportedLine(person({})), null);
  assert.equal(donorReportedLine(person(null)), null);
});

test("zip5 is never in the output", () => {
  const meta = { occupation: "CEO", employer: "AHMC", city: "PASADENA", state: "CA", zip5: "91101", zip: "91101-2345" };
  const line = donorReportedLine(person(meta)) ?? "";
  assert.doesNotMatch(line, /91101/);
  assert.equal(donorReportedLine(person({ zip5: "91101" })), null, "a ZIP alone is not a line");
});

test("an entity of any other type returns nothing", () => {
  const meta = { occupation: "CEO", employer: "AHMC", city: "PASADENA", state: "CA" };
  for (const t of ["pac", "super_pac", "corporation", "union", "party_committee", "organization", "other", "Individual"]) {
    assert.equal(donorReportedLine({ entity_type: t, metadata: meta }), null, t);
  }
});

test("the donors page keeps the line out of <title>, the description, OpenGraph and JSON-LD", () => {
  const src = readFileSync(join(__dirname, "..", "..", "app", "donors", "[id]", "page.tsx"), "utf8");
  assert.ok(src.includes("donorReportedLine("), "the page renders it");
  const meta = src.slice(src.indexOf("export async function generateMetadata"), src.indexOf("export default async function"));
  assert.ok(meta.length > 100, "generateMetadata found");
  assert.doesNotMatch(meta, /donorReportedLine|reportedLine|occupation|employer|zip5/);
  const ld = src.slice(src.indexOf("const donorJsonLd"), src.indexOf("return (", src.indexOf("const donorJsonLd")));
  assert.ok(ld.length > 50, "JSON-LD found");
  assert.doesNotMatch(ld, /reportedLine|occupation|employer|zip5/);
  assert.doesNotMatch(src, /zip5/, "the page never names zip5");
});
