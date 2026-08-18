/**
 * FIX-961 / PR 3a — external-sort group aggregation.
 *
 * Runs via:  node run-tests.mjs   (or: tsx --test src/lib/external-sort.test.ts)
 *
 * The five properties the indiv rewiring depends on:
 *   1. multi-run merge correctness (more input than one buffer holds)
 *   2. duplicate-key grouping — every record for a key folds into exactly one
 *      output group, no matter which runs the duplicates landed in
 *   3. compression round-trip — gzip on/off produce identical logical output,
 *      including latin1 high bytes and escaped free-text fields
 *   4. determinism — same input ⇒ byte-identical output, twice
 *   5. a group that SPANS a run boundary (the adversarial case: a key whose
 *      records are split across every run and sit at the seam of each)
 */

import { test }  from "node:test";
import assert    from "node:assert/strict";
import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  ExternalGroupSorter,
  mergeJoinGrouped,
  compositeKey,
  escapeField,
  unescapeField,
  assertSortableKey,
  KEY_FIELD_SEP,
} from "./external-sort";

// ── fixtures ───────────────────────────────────────────────────────────────

interface Agg { cents: number; count: number; maxDt: string | null }

const AGG_SPEC = {
  encode: (v: Agg) => `${v.cents}\t${v.count}\t${v.maxDt ?? ""}`,
  decode: (s: string): Agg => {
    const [c, n, d] = s.split("\t");
    return { cents: Number(c), count: Number(n), maxDt: d ? d : null };
  },
  combine: (a: Agg, b: Agg): Agg => ({
    cents: a.cents + b.cents,
    count: a.count + b.count,
    maxDt: (b.maxDt ?? "") > (a.maxDt ?? "") ? b.maxDt : a.maxDt,
  }),
};

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitics-xsort-${name}-`));
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function collect<T>(g: AsyncIterable<{ key: string; value: T }>): Promise<Array<[string, T]>> {
  const out: Array<[string, T]> = [];
  for await (const { key, value } of g) out.push([key, value]);
  return out;
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000; };
}

/** Reference fold — the "old path" this module has to be equivalent to. */
function referenceFold(rows: Array<[string, Agg]>): Map<string, Agg> {
  const m = new Map<string, Agg>();
  for (const [k, v] of rows) {
    const e = m.get(k);
    m.set(k, e === undefined ? { ...v } : AGG_SPEC.combine(e, v));
  }
  return m;
}

// ── 1 + 2: multi-run merge and duplicate-key grouping ──────────────────────

test("FIX-961 multi-run merge folds duplicate keys across runs (vs in-memory reference)", async () => {
  const dir = tmp("merge");
  try {
    const rand = lcg(20260817);
    const rows: Array<[string, Agg]> = [];
    // 40k records over 900 distinct keys, buffer 500 ⇒ ~80 runs. Every key is
    // near-certain to appear in most runs.
    for (let i = 0; i < 40_000; i++) {
      const key = `K${String(Math.floor(rand() * 900)).padStart(4, "0")}`;
      rows.push([key, {
        cents: Math.floor(rand() * 10_000) + 1,
        count: 1,
        maxDt: `${String(Math.floor(rand() * 12) + 1).padStart(2, "0")}010202${Math.floor(rand() * 10)}`,
      }]);
    }

    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "agg", maxBufferEntries: 500, validateKeys: true, ...AGG_SPEC,
    });
    for (const [k, v] of rows) if (sorter.add(k, v)) await sorter.spill();
    const sorted = await sorter.finalize();

    assert.ok(sorter.stats.runsWritten > 20, `expected many runs, got ${sorter.stats.runsWritten}`);
    assert.equal(sorter.stats.recordsIn, 40_000);

    const got = await collect(sorted);
    const ref = referenceFold(rows);

    assert.equal(got.length, ref.size, "group count");
    assert.equal(sorted.groupCount, ref.size, "reported groupCount");
    assert.equal(sorter.stats.groupsOut, ref.size, "stats.groupsOut");

    // Sorted by key, strictly ascending, no duplicate groups.
    for (let i = 1; i < got.length; i++) {
      assert.ok(got[i - 1]![0] < got[i]![0], `not strictly ascending at ${i}`);
    }

    let totalCents = 0, totalCount = 0;
    for (const [k, v] of got) {
      const e = ref.get(k);
      assert.ok(e, `unexpected key ${k}`);
      assert.deepEqual(v, e, `mismatch for ${k}`);
      totalCents += v.cents;
      totalCount += v.count;
    }
    assert.equal(totalCount, 40_000, "every input record accounted for exactly once");
    assert.equal(totalCents, rows.reduce((a, [, v]) => a + v.cents, 0), "no dollars lost");

    // Every run file is gone after finalize; only the merged output remains.
    const left = fs.readdirSync(dir).filter((f) => f.includes(".run-"));
    assert.deepEqual(left, [], `run files leaked: ${left.join(", ")}`);

    await sorted.dispose();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rmrf(dir); }
});

// ── 5: adversarial — one group spans every run boundary ────────────────────

test("FIX-961 a group whose records straddle every run boundary folds once", async () => {
  const dir = tmp("boundary");
  try {
    const BUF = 4;               // 4 distinct keys per run
    const rows: Array<[string, Agg]> = [];
    // "SEAM" is emitted as both the LAST record before a spill and the FIRST
    // record after it, in every run — so it is the max key of one run and the
    // min key of the next, repeatedly.
    for (let r = 0; r < 25; r++) {
      rows.push(["SEAM", { cents: 1, count: 1, maxDt: `0101200${r % 10}` }]);
      for (let j = 0; j < BUF - 1; j++) {
        rows.push([`AAA${r}_${j}`, { cents: 100, count: 1, maxDt: "01012000" }]);
      }
      rows.push(["SEAM", { cents: 1, count: 1, maxDt: `0202200${r % 10}` }]);
    }
    // …and a key that sorts AFTER SEAM, present in only one run, to prove the
    // heap does not swallow the tail group.
    rows.push(["ZZZ", { cents: 7, count: 1, maxDt: "12312024" }]);

    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "seam", maxBufferEntries: BUF, validateKeys: true, ...AGG_SPEC,
    });
    for (const [k, v] of rows) if (sorter.add(k, v)) await sorter.spill();
    const sorted = await sorter.finalize();
    const got = new Map(await collect(sorted));

    assert.ok(sorter.stats.runsWritten >= 10, `expected many runs, got ${sorter.stats.runsWritten}`);
    const seam = got.get("SEAM");
    assert.ok(seam, "SEAM group missing");
    assert.equal(seam.count, 50, "SEAM must fold to exactly ONE group of 50");
    assert.equal(seam.cents, 50);
    assert.equal(seam.maxDt, "02022009", "max over the whole group, not per-run");
    assert.deepEqual(got.get("ZZZ"), { cents: 7, count: 1, maxDt: "12312024" });
    assert.deepEqual(await collect(sorted), await collect(sorted), "handle is re-readable");

    await sorted.dispose();
  } finally { rmrf(dir); }
});

// ── prefix keys must not interleave ────────────────────────────────────────

test("FIX-961 a key that is a strict prefix of another still groups contiguously", async () => {
  const dir = tmp("prefix");
  try {
    // "A" is a prefix of "A B" and of "A|99999" — the TAB separator (0x09) has
    // to sort below space (0x20) and '|' (0x7c) or these groups interleave.
    const rows: Array<[string, Agg]> = [];
    for (let i = 0; i < 300; i++) {
      rows.push(["A",        { cents: 1, count: 1, maxDt: null }]);
      rows.push(["A B",      { cents: 2, count: 1, maxDt: null }]);
      rows.push(["A|99999",  { cents: 4, count: 1, maxDt: null }]);
      rows.push(["Aé",  { cents: 8, count: 1, maxDt: null }]);   // latin1 high byte
    }
    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "pfx", maxBufferEntries: 3, validateKeys: true, ...AGG_SPEC,
    });
    for (const [k, v] of rows) if (sorter.add(k, v)) await sorter.spill();
    const got = new Map(await collect(await sorter.finalize()));

    assert.equal(got.size, 4);
    assert.deepEqual(got.get("A"),       { cents: 300,  count: 300, maxDt: null });
    assert.deepEqual(got.get("A B"),     { cents: 600,  count: 300, maxDt: null });
    assert.deepEqual(got.get("A|99999"), { cents: 1200, count: 300, maxDt: null });
    assert.deepEqual(got.get("Aé"), { cents: 2400, count: 300, maxDt: null });
  } finally { rmrf(dir); }
});

// ── 3: compression round-trip ──────────────────────────────────────────────

test("FIX-961 compressed and uncompressed sorts agree, including escaped free text", async () => {
  const dir = tmp("gzip");
  try {
    const payloads = [
      "PLAIN",
      "WITH\tTAB",
      "WITH\nNEWLINE",
      "WITH\r\nCRLF",
      "BACK\\SLASH",
      "TRAILING\\",
      "LATIN1 ÉÑü",
      "",
    ];
    for (const p of payloads) {
      assert.equal(unescapeField(escapeField(p)), p, `round-trip failed for ${JSON.stringify(p)}`);
      assert.ok(!/[\t\n\r]/.test(escapeField(p)), `escape leaked a control char for ${JSON.stringify(p)}`);
    }

    const spec = {
      encode: (v: string) => escapeField(v),
      decode: (s: string) => unescapeField(s),
      combine: (a: string, _b: string) => a,
    };
    const run = async (compress: boolean) => {
      const sorter = new ExternalGroupSorter<string>({
        tempDir: dir, name: `gz-${compress}`, maxBufferEntries: 2, compress, validateKeys: true, ...spec,
      });
      for (let i = 0; i < payloads.length; i++) {
        if (sorter.add(`K${String(i).padStart(2, "0")}`, payloads[i]!)) await sorter.spill();
      }
      const s = await sorter.finalize();
      const got = await collect(s);
      await s.dispose();
      return { got, bytes: s.outputBytes };
    };

    const gz    = await run(true);
    const plain = await run(false);
    assert.deepEqual(gz.got, plain.got, "gzip changed the logical output");
    assert.deepEqual(gz.got.map(([, v]) => v), payloads, "payload round-trip through the sort");
  } finally { rmrf(dir); }
});

// ── 4: determinism ─────────────────────────────────────────────────────────

test("FIX-961 same input ⇒ byte-identical sorted output (twice)", async () => {
  const digest = async (seed: number, bufSize: number): Promise<string> => {
    const dir = tmp("det");
    try {
      const rand = lcg(seed);
      const sorter = new ExternalGroupSorter<Agg>({
        tempDir: dir, name: "d", maxBufferEntries: bufSize, compress: false, ...AGG_SPEC,
      });
      for (let i = 0; i < 5_000; i++) {
        const k = `K${String(Math.floor(rand() * 400)).padStart(3, "0")}`;
        if (sorter.add(k, { cents: i, count: 1, maxDt: null })) await sorter.spill();
      }
      const s = await sorter.finalize();
      const h = crypto.createHash("sha256");
      for await (const { key, value } of s) h.update(`${key}|${value.cents}|${value.count}\n`);
      await s.dispose();
      return h.digest("hex");
    } finally { rmrf(dir); }
  };

  const a = await digest(7, 111);
  const b = await digest(7, 111);
  assert.equal(a, b, "two identical runs disagreed");
  // Same logical input, different spill geometry ⇒ same result. This is the
  // property that makes maxBufferEntries a pure tuning knob.
  const c = await digest(7, 5_000);       // never spills — single-buffer path
  assert.equal(a, c, "buffer size changed the result");
});

// ── the single-buffer fast path ────────────────────────────────────────────

test("FIX-961 a sort that never spills still produces a sorted, reduced file", async () => {
  const dir = tmp("nospill");
  try {
    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "s", maxBufferEntries: 1_000, ...AGG_SPEC,
    });
    for (const k of ["c", "a", "b", "a", "c", "a"]) {
      if (sorter.add(k, { cents: 5, count: 1, maxDt: null })) await sorter.spill();
    }
    assert.equal(sorter.stats.runsWritten, 0, "should not have spilled");
    const got = await collect(await sorter.finalize());
    assert.deepEqual(got.map(([k, v]) => [k, v.count]), [["a", 3], ["b", 1], ["c", 2]]);
  } finally { rmrf(dir); }
});

// ── key validation ─────────────────────────────────────────────────────────

test("FIX-961 keys carrying a tab or newline are rejected", () => {
  assert.doesNotThrow(() => assertSortableKey(compositeKey("SMITH JOHN|94110", "C", "C00123456")));
  for (const bad of ["a\tb", "a\nb", "a\rb"]) {
    assert.throws(() => assertSortableKey(bad), /tab or newline/);
  }
});

// ── composite keys: the bug this PR actually shipped once ──────────────────
//
// A tab inside a sort key does not throw and does not corrupt the file — it
// silently reframes every line, so the reader takes field 1 as the whole key
// and the merge groups by a PREFIX of the intended key. On the indiv stage that
// meant grouping by donor instead of by (donor, route, recipient): 240,703
// aggregate groups vanished and the surviving ones summed across recipients.
// Two defences, both tested here: KEY_FIELD_SEP for composite keys, and an
// always-on assertion on the first key added, regardless of `validateKeys`.

test("FIX-961 a composite key groups by ALL its fields, not just the first", async () => {
  const dir = tmp("composite");
  try {
    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "c", maxBufferEntries: 2, ...AGG_SPEC,
    });
    // One donor, three distinct (route, recipient) cells. If the key reframes,
    // these collapse into a single group of 6.
    const rows: Array<[string, string, string]> = [
      ["DONOR ONE|94110", "C", "H0CA00001"],
      ["DONOR ONE|94110", "C", "H0CA00002"],
      ["DONOR ONE|94110", "M", "C00000001"],
    ];
    for (const [fp, route, recip] of rows) {
      for (let i = 0; i < 2; i++) {
        if (sorter.add(compositeKey(fp, route, recip), { cents: 100, count: 1, maxDt: null })) {
          await sorter.spill();
        }
      }
    }
    const got = await collect(await sorter.finalize());
    assert.equal(got.length, 3, "must be three groups, one per (donor, route, recipient)");
    for (const [key, v] of got) {
      const parts = key.split(KEY_FIELD_SEP);
      assert.equal(parts.length, 3, `key lost its fields: ${JSON.stringify(key)}`);
      assert.equal(v.count, 2);
      assert.equal(v.cents, 200);
    }
    // Route ordering: 'C' before 'M' for the same donor, so a route filter over
    // the merged stream sees contiguous blocks.
    assert.deepEqual(got.map(([k]) => k.split(KEY_FIELD_SEP)[1]), ["C", "C", "M"]);
  } finally { rmrf(dir); }
});

test("FIX-961 a tab inside a key is rejected on the FIRST add, with validateKeys off", async () => {
  const dir = tmp("firstkey");
  try {
    const sorter = new ExternalGroupSorter<Agg>({
      tempDir: dir, name: "f", maxBufferEntries: 1_000, validateKeys: false, ...AGG_SPEC,
    });
    assert.throws(
      () => sorter.add("DONOR\tC\tH0CA00001", { cents: 1, count: 1, maxDt: null }),
      /key prefix/,
      "the first key must be validated even when validateKeys is off",
    );
  } finally { rmrf(dir); }
});

test("FIX-961 KEY_FIELD_SEP orders between the payload boundary and printable text", () => {
  // TAB < KEY_FIELD_SEP < every char an FEC key field can hold. This is what
  // keeps a prefix key sorted before the keys that extend it.
  assert.ok("\t" < KEY_FIELD_SEP);
  for (const c of [" ", "0", "9", "A", "Z", "|", "é"]) {
    assert.ok(KEY_FIELD_SEP < c, `KEY_FIELD_SEP must sort below ${JSON.stringify(c)}`);
  }
});

// ── mergeJoinGrouped ───────────────────────────────────────────────────────

test("FIX-961 mergeJoinGrouped attaches every right-hand row to its left key", async () => {
  const left = (async function* () {
    for (const k of ["d1", "d2", "d3", "d4"]) yield { key: k, value: `meta-${k}` };
  })();
  const right = (async function* () {
    // d1: two rows; d2: none; d3: one; d4: three. Plus an orphan that sorts
    // before every left key, which must be discarded without stalling.
    for (const [k, v] of [
      ["d0\tC\tX", 999],
      ["d1\tC\tA", 10], ["d1\tM\tB", 20],
      ["d3\tC\tC", 30],
      ["d4\tC\tD", 1], ["d4\tC\tE", 2], ["d4\tM\tF", 3],
    ] as Array<[string, number]>) yield { key: k, value: v };
  })();

  const out: Array<[string, string, number]> = [];
  for await (const row of mergeJoinGrouped<string, number, [string, string, number]>(
    left, right,
    (k) => k.slice(0, k.indexOf("\t") < 0 ? k.length : k.indexOf("\t")),
    (key, meta, vals) => [key, meta, vals.reduce((a, b) => a + b, 0)],
  )) out.push(row);

  assert.deepEqual(out, [
    ["d1", "meta-d1", 30],
    ["d2", "meta-d2", 0],
    ["d3", "meta-d3", 30],
    ["d4", "meta-d4", 6],
  ]);
});
