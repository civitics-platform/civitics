/**
 * FIX-1400 — irs990's two 2025 archives are Deflate64, and the run said
 * `complete` anyway.
 *
 * Eight Mondays logged `complete / 0 inserted / 5 failed`. Run 42722763973
 * (11-09): `2025_TEOS_XML_05A.zip: extract failed — invalid distance too far
 * back` and `2025_TEOS_XML_11B.zip: extract failed — too many length or
 * distance symbols`. cc-278 read 5 read both local headers: method 9
 * (Deflate64), version-needed 21; the control 01A is method 8. Node's zlib
 * inflates method 8 only.
 *
 * D6: those two zlib messages — and only those — route to Info-ZIP `unzip`,
 * when the binary exists. D7: a download or extract failure that leaves ids
 * unresolved ends the run `partial`, naming both; a clean run is unchanged.
 *
 * No test here reaches the network or a database. The fake `unzip` writes
 * files into the run's scratch directory the way the real one would.
 *
 * Runs via:  tsx --test src/pipelines/irs990/fallback.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  DEFLATE64_ZLIB_MESSAGES,
  extractObjectIdXmls,
  extractObjectIdXmlsWithUnzip,
  isDeflate64ZlibError,
  unzipAvailable,
  unzipExtractArgs,
  unzipListArgs,
  type ExecFileLike,
  type IndexRow,
} from "./util";
import { irs990RunOutcome, runIrs990Pipeline, type Irs990Deps } from "./index";
import { SEED_NONPROFITS } from "./seed";

const ZIP = "/tmp/irs990/2025_TEOS_XML_05A.zip";

test("the two zlib messages are Deflate64's; other inflate errors are not", () => {
  assert.equal(isDeflate64ZlibError(new Error("invalid distance too far back")), true);
  assert.equal(isDeflate64ZlibError(new Error("too many length or distance symbols")), true);
  assert.equal(DEFLATE64_ZLIB_MESSAGES.length, 2);
  for (const other of ["unexpected end of file", "invalid block type", "incorrect header check", "HTTP 503 for https://apps.irs.gov/…"]) {
    assert.equal(isDeflate64ZlibError(new Error(other)), false, other);
  }
});

for (const message of DEFLATE64_ZLIB_MESSAGES) {
  test(`"${message}" routes to the unzip fallback`, async () => {
    let unzipCalls = 0;
    const out = await extractObjectIdXmls(ZIP, new Set(["1"]), {
      stream:         async () => { throw new Error(message); },
      unzip:          async () => { unzipCalls++; return new Map([["1", "<Return/>"]]); },
      unzipAvailable: async () => true,
    });
    assert.equal(unzipCalls, 1);
    assert.equal(out.via, "unzip");
    assert.equal(out.xmls.get("1"), "<Return/>");
  });
}

test("any other error does not route to the fallback — it rethrows unchanged", async () => {
  const original = new Error("unexpected end of file");
  let unzipCalls = 0;
  await assert.rejects(
    extractObjectIdXmls(ZIP, new Set(["1"]), {
      stream:         async () => { throw original; },
      unzip:          async () => { unzipCalls++; return new Map(); },
      unzipAvailable: async () => true,
    }),
    (err) => err === original,
  );
  assert.equal(unzipCalls, 0);
});

test("a missing unzip binary: the original error stands", async () => {
  const original = new Error("invalid distance too far back");
  let unzipCalls = 0;
  await assert.rejects(
    extractObjectIdXmls(ZIP, new Set(["1"]), {
      stream:         async () => { throw original; },
      unzip:          async () => { unzipCalls++; return new Map(); },
      unzipAvailable: async () => false,
    }),
    (err) => err === original,
  );
  assert.equal(unzipCalls, 0);

  // unzipAvailable itself: a spawn error (ENOENT) is "no".
  const enoent: ExecFileLike = async () => { throw Object.assign(new Error("spawn unzip ENOENT"), { code: "ENOENT" }); };
  assert.equal(await unzipAvailable(enoent), false);
  assert.equal(await unzipAvailable(async () => ({ stdout: "UnZip 6.00 … USE_DEFLATE64" })), true);
});

test("a streaming success never asks for unzip", async () => {
  const out = await extractObjectIdXmls(ZIP, new Set(["1"]), {
    stream:         async () => new Map(),
    unzip:          async () => { throw new Error("must not be called"); },
    unzipAvailable: async () => { throw new Error("must not be called"); },
  });
  assert.equal(out.via, "stream");
});

test("the fallback's argument lists are arrays, never a shell string", () => {
  assert.deepEqual(unzipListArgs(ZIP), ["-Z1", ZIP]);
  assert.deepEqual(
    unzipExtractArgs(ZIP, ["202533149349300748_public.xml", "202511359349304506_public.xml"], "/tmp/irs990/unzip-x"),
    ["-o", "-j", "-qq", ZIP, "202533149349300748_public.xml", "202511359349304506_public.xml", "-d", "/tmp/irs990/unzip-x"],
  );
});

test("extractObjectIdXmlsWithUnzip lists, extracts only the needed entries, reads them back, and cleans up", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  let outDir = "";
  const run: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "-Z1") {
      return { stdout: ["202501159339300115_public.xml", "202533149349300748_public.xml", "202511359349304506_public.xml", "notes.txt", ""].join("\n") };
    }
    // The extract: write each named entry into -d's directory.
    outDir = args[args.indexOf("-d") + 1]!;
    for (const name of args.slice(4, args.indexOf("-d"))) {
      fs.writeFileSync(path.join(outDir, name), `<Return id="${name.split("_")[0]}"/>`);
    }
    return { stdout: "" };
  };
  const needed = new Set(["202533149349300748", "202511359349304506", "999999999999999999"]);
  const found = await extractObjectIdXmlsWithUnzip(ZIP, needed, run);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { file: "unzip", args: ["-Z1", ZIP] });
  assert.equal(calls[1]!.file, "unzip");
  assert.deepEqual(calls[1]!.args, unzipExtractArgs(ZIP, ["202533149349300748_public.xml", "202511359349304506_public.xml"], outDir));
  assert.deepEqual([...found.keys()].sort(), ["202511359349304506", "202533149349300748"]);
  assert.equal(found.get("202533149349300748"), `<Return id="202533149349300748"/>`);
  assert.equal(fs.existsSync(outDir), false, "the scratch directory is removed");

  // Nothing needed in this archive → no extract call at all.
  const calls2: string[][] = [];
  const none = await extractObjectIdXmlsWithUnzip(ZIP, new Set(["42"]), async (_f, args) => { calls2.push(args); return { stdout: "1_public.xml\n" }; });
  assert.equal(none.size, 0);
  assert.equal(calls2.length, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// D7 — the run's status
// ──────────────────────────────────────────────────────────────────────────

test("irs990RunOutcome: partial only when a ZIP failed AND ids remain; keys only when non-empty", () => {
  assert.deepEqual(irs990RunOutcome([], [], []), { status: "complete" });
  assert.deepEqual(irs990RunOutcome([{ zip: "a.zip", error: "x" }], ["1"], []), {
    status:   "partial",
    metadata: { zips_failed: [{ zip: "a.zip", error: "x" }], object_ids_unresolved: ["1"] },
  });
  // A failed archive that held nothing we needed: the run still resolved everything.
  assert.deepEqual(irs990RunOutcome([{ zip: "a.zip", error: "x" }], [], []), {
    status: "complete", metadata: { zips_failed: [{ zip: "a.zip", error: "x" }] },
  });
  assert.deepEqual(irs990RunOutcome([], [], ["05A.zip"]), { status: "complete", metadata: { zips_via_unzip: ["05A.zip"] } });
});

const SEED_EIN = SEED_NONPROFITS[0]!.ein;
const UNRESOLVED_ID = "202533149349300748";

function indexRow(objectId: string): IndexRow {
  return {
    RETURN_ID: "1", FILING_TYPE: "EFILE", EIN: SEED_EIN, TAX_PERIOD: "202412", SUB_DATE: "2025",
    TAXPAYER_NAME: "SEED ORG", RETURN_TYPE: "990", DLN: "1", OBJECT_ID: objectId, XML_BATCH_ID: "2025_TEOS_XML_05A",
  };
}

interface RunCalls {
  complete: Array<{ status?: string; metadata?: Record<string, unknown>; failed: number }>;
  watermarkSaves: number;
}

function runDeps(calls: RunCalls, extra: Partial<Irs990Deps>): Partial<Irs990Deps> {
  return {
    startSync:                    async () => "log-1",
    completeSync:                 async (_id, result, status) => { calls.complete.push({ status, metadata: result.metadata, failed: result.failed }); },
    failSync:                     async () => { throw new Error("test: failSync not expected"); },
    db:                           () => ({}),
    years:                        () => [2025],
    loadOfficialsByCanonicalName: async () => new Map(),
    loadIndexWatermark:           async () => ({}),
    saveIndexWatermark:           async () => { calls.watermarkSaves++; },
    headIrsFile:                  async () => ({ lastModified: "Mon, 09 Nov 2026 00:00:00 GMT", etag: null, contentLength: null }),
    streamIndexCsv:               async (_url, onRow) => { await onRow(indexRow(UNRESOLVED_ID)); return { headers: null, rowCount: 1 }; },
    filterUningestedObjectIds:    async () => new Set<string>(),
    getYearZipUrls:               async () => [
      "https://apps.irs.gov/pub/epostcard/990/xml/2025/2025_TEOS_XML_01A.zip",
      "https://apps.irs.gov/pub/epostcard/990/xml/2025/2025_TEOS_XML_05A.zip",
    ],
    downloadFileToTemp:           async () => {},
    ...extra,
  };
}

test("an extract failure (no unzip) that leaves an id unresolved ends the run partial, naming both", async () => {
  const calls: RunCalls = { complete: [], watermarkSaves: 0 };
  await runIrs990Pipeline(runDeps(calls, {
    extractObjectIdXmls: async (zipPath) => {
      if (zipPath.endsWith("05A.zip")) throw new Error("invalid distance too far back");
      return { xmls: new Map(), via: "stream" };
    },
  }));
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.status, "partial");
  assert.deepEqual(calls.complete[0]!.metadata, {
    zips_failed:           [{ zip: "2025_TEOS_XML_05A.zip", error: "extract failed — invalid distance too far back" }],
    object_ids_unresolved: [UNRESOLVED_ID],
  });
  assert.equal(calls.complete[0]!.failed, 1);
  assert.equal(calls.watermarkSaves, 0, "the year's watermark is withheld while ids remain");
});

test("a download failure that leaves an id unresolved is partial too", async () => {
  const calls: RunCalls = { complete: [], watermarkSaves: 0 };
  await runIrs990Pipeline(runDeps(calls, {
    downloadFileToTemp:  async (url) => { if (url.endsWith("05A.zip")) throw new Error("HTTP 503 for https://apps.irs.gov/…/2025_TEOS_XML_05A.zip"); },
    extractObjectIdXmls: async () => ({ xmls: new Map(), via: "stream" }),
  }));
  assert.equal(calls.complete[0]!.status, "partial");
  assert.deepEqual(calls.complete[0]!.metadata?.["zips_failed"], [
    { zip: "2025_TEOS_XML_05A.zip", error: "download failed — HTTP 503 for https://apps.irs.gov/…/2025_TEOS_XML_05A.zip" },
  ]);
});

test("a clean run is still complete, with no new metadata key", async () => {
  // Every matched filing already ingested: the year resolves and is watermarked.
  const calls: RunCalls = { complete: [], watermarkSaves: 0 };
  await runIrs990Pipeline(runDeps(calls, {
    filterUningestedObjectIds: async () => new Set([UNRESOLVED_ID]),
    extractObjectIdXmls:       async () => { throw new Error("test: no ZIP should be opened"); },
  }));
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.status, "complete");
  assert.equal(calls.complete[0]!.metadata, undefined);
  assert.equal(calls.watermarkSaves, 1);

  // And a run whose archives all stream but hold nothing needed keeps today's
  // shape: complete, the misses counted failed, the unresolved id named.
  const calls2: RunCalls = { complete: [], watermarkSaves: 0 };
  await runIrs990Pipeline(runDeps(calls2, { extractObjectIdXmls: async () => ({ xmls: new Map(), via: "stream" }) }));
  assert.equal(calls2.complete[0]!.status, "complete");
  assert.deepEqual(calls2.complete[0]!.metadata, { object_ids_unresolved: [UNRESOLVED_ID] });
});
