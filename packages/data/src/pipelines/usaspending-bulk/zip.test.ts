/**
 * FIX-766 — multi-part CSV enumeration from a USASpending zip.
 *
 * Proves openCsvParts enumerates EVERY .csv entry (the bug: the old
 * extractCsvFromZip took only the first and autodrain()'d the rest), sorts them
 * deterministically, ignores non-csv members, and extracts each part's content
 * one at a time.
 *
 * The fixture is a dependency-free STORED (compression method 0) zip built at
 * test time — no zip-writer dep, and it produces byte-identical output on
 * Windows (local) and Linux (CI).
 *
 * Runs via:  tsx --test src/pipelines/usaspending-bulk/zip.test.ts
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";
import { openCsvParts } from "./zip";

// --- CRC32 (IEEE) -----------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- minimal STORED zip writer ---------------------------------------------
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks:  Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc     = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);              // method = stored
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));

    offset += lfh.length + nameBuf.length + data.length;
  }

  const cd   = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cd, eocd]);
}

// ---------------------------------------------------------------------------

test("FIX-766 openCsvParts enumerates EVERY csv part, sorted, ignoring non-csv", async () => {
  const tmp     = fs.mkdtempSync(path.join(os.tmpdir(), "usasp-zip-"));
  const zipPath = path.join(tmp, "FY2026_All_Contracts_Full_20260704.zip");
  try {
    // Entries deliberately out of order, plus a non-csv member.
    fs.writeFileSync(zipPath, buildStoredZip([
      { name: "FY2026_All_Contracts_Full_20260704_2.csv", data: Buffer.from("h\nrowB\n") },
      { name: "FY2026_All_Contracts_Full_20260704_1.csv", data: Buffer.from("h\nrowA1\nrowA2\n") },
      { name: "FY2026_All_Contracts_Full_20260704_3.csv", data: Buffer.from("h\nrowC\n") },
      { name: "readme.txt",                                data: Buffer.from("not a csv") },
    ]));

    const parts = await openCsvParts(zipPath);
    assert.equal(parts.length, 3, "all three csv parts enumerated — the old code took only the first");
    assert.deepEqual(
      parts.map((p) => p.path),
      [
        "FY2026_All_Contracts_Full_20260704_1.csv",
        "FY2026_All_Contracts_Full_20260704_2.csv",
        "FY2026_All_Contracts_Full_20260704_3.csv",
      ],
      "sorted deterministically; readme.txt excluded",
    );

    // Extract → read → delete one at a time (the bounded-disk flow).
    const contents: string[] = [];
    for (const part of parts) {
      const dest = path.join(tmp, path.basename(part.path));
      await part.extractTo(dest);
      contents.push(fs.readFileSync(dest, "utf8"));
      fs.unlinkSync(dest);
    }
    assert.deepEqual(contents, ["h\nrowA1\nrowA2\n", "h\nrowB\n", "h\nrowC\n"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FIX-766 openCsvParts returns [] when a zip has no csv entries", async () => {
  const tmp     = fs.mkdtempSync(path.join(os.tmpdir(), "usasp-zip-"));
  const zipPath = path.join(tmp, "nocsv.zip");
  try {
    fs.writeFileSync(zipPath, buildStoredZip([{ name: "readme.txt", data: Buffer.from("x") }]));
    assert.deepEqual(await openCsvParts(zipPath), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
