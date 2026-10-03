/**
 * FIX-1268 — the fiscal-year rollover: resolveFullFiles() tries FY, then FY−1
 * ONCE, and reports which one it used.
 *
 * The stub is the S3 bucket listing itself: it honours `?prefix=` over a fixed
 * key set and answers in the bucket's XML shape, so the prefix encoding and the
 * Full-file regex are exercised, not mocked away. The key sets are the shapes
 * read off files.usaspending.gov on 2026-10-03 (no FY2027 Full yet; FY2026's
 * newest is 20260906; one FY(All) delta).
 *
 * The wrong-but-green line (rule 105): before FIX-1268 the run asked for FY2027
 * only, got an empty listing, and failSync'd — the "rollover" case below is
 * that listing, and it must resolve to FY2026 rather than to nothing.
 *
 * Runs via:  tsx --test src/pipelines/usaspending-bulk/fy-fallback.test.ts
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import { resolveFullFiles } from "./index";

/** An S3 ListBucketResult for the keys under `?prefix=`, like the real bucket. */
function bucket(keys: string[]) {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<string> => {
    const prefix = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
    asked.push(prefix);
    const hits = keys.filter((k) => k.startsWith(prefix));
    return (
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Prefix>${prefix}</Prefix>` +
      `<IsTruncated>false</IsTruncated>` +
      hits.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join("") +
      `</ListBucketResult>`
    );
  };
  return { fetch, asked };
}

const OCT_2026 = [
  "FY2025_All_Contracts_Full_20260906.zip",
  "FY2026_All_Contracts_Full_20260806.zip",
  "FY2026_All_Contracts_Full_20260906.zip",
  "FY2026_All_Assistance_Full_20260906.zip",
  "FY(All)_All_Contracts_Delta_20260924.zip",
  "FY2026_012_Contracts_Full_20260906.zip", // a per-agency file: not an _All_ Full
];

test("the requested FY has a Full archive → used as is, no fallback, one listing", async () => {
  const b = bucket([...OCT_2026, "FY2027_All_Contracts_Full_20261006.zip"]);
  const r = await resolveFullFiles("contracts", 2027, b.fetch);
  assert.deepEqual(
    { requested: r.fiscal_year_requested, used: r.fiscal_year_used, fallback: r.fiscal_year_fallback },
    { requested: 2027, used: 2027, fallback: false },
  );
  assert.deepEqual(r.files.map((f) => f.name), ["FY2027_All_Contracts_Full_20261006.zip"]);
  assert.deepEqual(b.asked, ["FY2027_All_Contracts_Full"], "no FY−1 listing when FY answers");
});

test("the rollover (10-01 shape): no FY2027 Full yet → FY2026's set, fallback stamped", async () => {
  const b = bucket(OCT_2026);
  const r = await resolveFullFiles("contracts", 2027, b.fetch);
  assert.deepEqual(
    { requested: r.fiscal_year_requested, used: r.fiscal_year_used, fallback: r.fiscal_year_fallback },
    { requested: 2027, used: 2026, fallback: true },
  );
  assert.deepEqual(
    r.files.map((f) => [f.name, f.date]).sort(),
    [["FY2026_All_Contracts_Full_20260806.zip", "20260806"], ["FY2026_All_Contracts_Full_20260906.zip", "20260906"]],
    "the whole FY2026 _All_ Full listing (latestFullSet picks the newest later); the per-agency file is not a match",
  );
  assert.deepEqual(b.asked, ["FY2027_All_Contracts_Full", "FY2026_All_Contracts_Full"]);
});

test("the fallback is per category and goes back ONE year only", async () => {
  // Assistance has FY2026; a bucket with only FY2025 for contracts must NOT
  // reach back two years.
  const b = bucket(["FY2025_All_Contracts_Full_20260906.zip", "FY2026_All_Assistance_Full_20260906.zip"]);
  const assistance = await resolveFullFiles("assistance", 2027, b.fetch);
  assert.equal(assistance.fiscal_year_used, 2026);
  assert.equal(assistance.fiscal_year_fallback, true);
  const contracts = await resolveFullFiles("contracts", 2027, b.fetch);
  assert.equal(contracts.fiscal_year_used, null, "FY2025 is two years back — not a fallback");
  assert.deepEqual(contracts.files, []);
});

test("the double miss: neither FY nor FY−1 → empty, used null, so the run failSyncs", async () => {
  const b = bucket(["FY(All)_All_Contracts_Delta_20260924.zip"]);
  const r = await resolveFullFiles("contracts", 2027, b.fetch);
  assert.deepEqual(
    { files: r.files.length, requested: r.fiscal_year_requested, used: r.fiscal_year_used, fallback: r.fiscal_year_fallback },
    { files: 0, requested: 2027, used: null, fallback: false },
  );
  assert.deepEqual(b.asked, ["FY2027_All_Contracts_Full", "FY2026_All_Contracts_Full"], "exactly two listings, then stop");
});
