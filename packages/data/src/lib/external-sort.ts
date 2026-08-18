/**
 * External-sort group aggregation — FIX-961 / PR 3a.
 *
 * Bounded-memory replacement for "build a giant Map keyed by a composite key,
 * then iterate it". The FEC indiv stage did exactly that and OOM'd a 12 GB heap
 * at ~77% of indiv20 (FIX-961); the aggregation maps are O(distinct groups) and
 * a presidential cycle has ~2.6M of them plus ~1.9M donor-meta entries, each
 * pinning latin1 substrings sliced out of the source line.
 *
 * Mechanism (Craig's decision, PR 3a):
 *   project → external sort → sequential group aggregation
 *
 *   1. `add(key, value)` accumulates into an in-memory buffer that is ALREADY
 *      combining by key (partial aggregation). The buffer is capped at
 *      `maxBufferEntries` distinct keys.
 *   2. When the cap is hit, the buffer is sorted lexicographically by key and
 *      written to a gzip-compressed "run" file, one `key<TAB>payload` line per
 *      entry. The buffer is then dropped.
 *   3. `finalize()` k-way merges every run with a binary heap, combining
 *      adjacent equal keys as they come off the heap, and writes ONE sorted,
 *      fully-reduced output file. Run files are deleted as soon as the merge
 *      drains them.
 *   4. The returned handle is a re-readable async iterable over
 *      `{ key, value }` in sorted key order. Peak memory is one buffer during
 *      the build, and k line-readers + one group during the merge/read — both
 *      independent of input size.
 *
 * `combine` MUST be associative and commutative: partial aggregation inside the
 * buffer, then again at merge time, then again across runs, is only equivalent
 * to a single-pass fold if it is. Sum / count / max are; "first seen" is not,
 * unless the ordinal is carried in the value and the combine picks min-ordinal
 * (which is what the indiv donor-meta sorter does).
 *
 * Format notes:
 *   - Lines are `key + "\t" + encode(value)`, and the reader splits at the
 *     FIRST tab. A key therefore MUST NOT contain a tab or a newline. A
 *     COMPOSITE key (donor + route + recipient) separates its own fields with
 *     `KEY_FIELD_SEP` (0x1F UNIT SEPARATOR), never a tab — putting tabs inside
 *     the key silently reframes every line, which is exactly the bug the
 *     first-key assertion below exists to catch.
 *   - Ordering: TAB (0x09) < KEY_FIELD_SEP (0x1F) < every character the FEC key
 *     fields can hold (A–Z, 0–9, space 0x20, '|' 0x7c). So a key that is a
 *     strict prefix of another still sorts before it, and every equal-key
 *     record stays contiguous. That contiguity is the only ordering property
 *     the group reduction depends on.
 *   - `encode` output must not contain a newline; it MAY contain tabs (it is
 *     everything after the first one). Use `escapeField` / `unescapeField` for
 *     free-text payload fields — FEC NAME/EMPLOYER are filer-supplied and can
 *     in principle carry a tab.
 *
 * Compression is gzip level 1, not zstd: GHA pins node-version 20 (see
 * .github/workflows/fec-backfill.yml) and `zlib.createZstdCompress` only landed
 * in Node 22.15. Level 1 keeps the CPU cost off the critical path — the point
 * of compressing at all is the runner's ~14 GB free disk, not archival ratio.
 */

import * as fs       from "fs";
import * as path     from "path";
import * as readline from "readline";
import * as zlib     from "zlib";
import { pipeline }  from "stream/promises";
import { Readable }  from "stream";

// ---------------------------------------------------------------------------
// Field escaping for free-text payload fields
// ---------------------------------------------------------------------------

/**
 * Escape a payload field so it survives a `\t`-separated, `\n`-terminated line.
 * Backslash-escapes are the only expansion, so a field with none of
 * {\\, \t, \n, \r} — the overwhelming majority — round-trips as itself and
 * costs one regex test.
 *
 * NOT for key fields: escaping can reorder (a literal backslash becomes two
 * chars), and key ordering is load-bearing. Key fields in this codebase are
 * constrained to A–Z0-9 plus space/'|' and need no escaping at all.
 */
export function escapeField(s: string): string {
  if (!/[\\\t\n\r]/.test(s)) return s;
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Inverse of `escapeField`. */
export function unescapeField(s: string): string {
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    out += n === "t" ? "\t"
         : n === "n" ? "\n"
         : n === "r" ? "\r"
         : n === "\\" ? "\\"
         : n === undefined ? "\\"       // trailing lone backslash — emit literal
         : n;                           // unknown escape — emit the char as-is
  }
  return out;
}

/**
 * Separator for the fields of a COMPOSITE sort key. 0x1F (UNIT SEPARATOR).
 *
 * Not a tab: the line format reserves the first tab for the key/payload
 * boundary, so a tab inside the key reframes the line — the reader would take
 * only the first key field as the key and fold the rest into the payload. That
 * silently groups by a prefix of the intended key. 0x1F sorts above 0x09 and
 * below every printable character, which keeps prefix-ordering intact.
 */
export const KEY_FIELD_SEP = "\x1f";

/** Build a composite sort key from its fields. */
export function compositeKey(...fields: string[]): string {
  return fields.join(KEY_FIELD_SEP);
}

/** Throws if `key` cannot be used as a sort key (contains TAB / CR / LF). */
export function assertSortableKey(key: string): void {
  if (/[\t\n\r]/.test(key)) {
    throw new Error(
      `external-sort: key contains a tab or newline — the first tab is the ` +
      `key/payload boundary, so this would silently regroup by a key prefix. ` +
      `Use KEY_FIELD_SEP for composite keys. key=${JSON.stringify(key)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Options / handles
// ---------------------------------------------------------------------------

export interface ExternalGroupSortOptions<T> {
  /** Directory the run files and the merged output are written to. */
  tempDir: string;
  /** File-name stem — must be unique among concurrent sorters in `tempDir`. */
  name: string;
  /** Value → payload string. Must not emit `\n`. */
  encode: (value: T) => string;
  /** Payload string → value. Inverse of `encode`. */
  decode: (payload: string) => T;
  /**
   * Fold two values for the same key. MUST be associative and commutative —
   * it runs inside the buffer, at merge time, and across runs.
   */
  combine: (a: T, b: T) => T;
  /**
   * Distinct keys held in the buffer before it spills. Default 400_000, which
   * measured ~55 MB of retained heap for the indiv aggregate shape.
   */
  maxBufferEntries?: number;
  /** gzip the run files and the merged output. Default true. */
  compress?: boolean;
  /** gzip level for run files. Default 1 (fast). */
  gzipLevel?: number;
  /**
   * Run `assertSortableKey` on every `add`. Default false — the hot path is
   * 10M+ calls. Tests and the equivalence harness turn it on.
   */
  validateKeys?: boolean;
}

export interface SortedGroups<T> extends AsyncIterable<{ key: string; value: T }> {
  /** Distinct groups in the merged output. */
  readonly groupCount: number;
  /** Bytes on disk of the merged output file. */
  readonly outputBytes: number;
  /** Delete the merged output file. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface ExternalSortStats {
  /** `add()` calls. */
  recordsIn: number;
  /** Run files written (0 ⇒ everything fit in one buffer and merged in RAM). */
  runsWritten: number;
  /** Distinct groups in the merged output. */
  groupsOut: number;
  /** Total bytes ever written, runs + output (not a residency measure). */
  bytesWritten: number;
  /**
   * Largest simultaneous on-disk footprint of this sorter's own files. This is
   * the number that has to fit next to the ~13 GB extracted indiv text.
   */
  peakDiskBytes: number;
}

// ---------------------------------------------------------------------------
// Binary min-heap over merge cursors
// ---------------------------------------------------------------------------

interface Cursor {
  key:     string;
  payload: string;
  next():  Promise<boolean>;
  close(): Promise<void>;
  /** Stable tie-break so the merge order is deterministic across runs. */
  idx: number;
}

function cursorLess(a: Cursor, b: Cursor): boolean {
  if (a.key !== b.key) return a.key < b.key;
  return a.idx < b.idx;
}

class CursorHeap {
  private readonly h: Cursor[] = [];
  get size(): number { return this.h.length; }

  push(c: Cursor): void {
    const h = this.h;
    h.push(c);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!cursorLess(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  peek(): Cursor | undefined { return this.h[0]; }

  pop(): Cursor | undefined {
    const h = this.h;
    if (h.length === 0) return undefined;
    const top  = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && cursorLess(h[l]!, h[m]!)) m = l;
        if (r < h.length && cursorLess(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Line IO
// ---------------------------------------------------------------------------

function readLines(filePath: string, compress: boolean): readline.Interface {
  const raw = fs.createReadStream(filePath);
  const src = compress ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input: src, crlfDelay: Infinity });
}

/** Lines are batched into ~256 KB chunks — 2.6M single-line stream writes is
 *  the difference between a few seconds and a few minutes. */
const WRITE_CHUNK_BYTES = 256 * 1024;

async function writeLines(
  filePath: string,
  lines: Iterable<string> | AsyncIterable<string>,
  compress: boolean,
  gzipLevel: number,
): Promise<number> {
  const out = fs.createWriteStream(filePath);
  const src = Readable.from(
    (async function* () {
      let buf = "";
      for await (const l of lines as AsyncIterable<string>) {
        buf += l;
        buf += "\n";
        if (buf.length >= WRITE_CHUNK_BYTES) { yield buf; buf = ""; }
      }
      if (buf) yield buf;
    })(),
    { objectMode: false, encoding: "utf8" },
  );
  if (compress) {
    await pipeline(src, zlib.createGzip({ level: gzipLevel }), out);
  } else {
    await pipeline(src, out);
  }
  return fs.statSync(filePath).size;
}

// ---------------------------------------------------------------------------
// ExternalGroupSorter
// ---------------------------------------------------------------------------

export class ExternalGroupSorter<T> {
  private readonly opts: Required<ExternalGroupSortOptions<T>>;
  private buffer = new Map<string, T>();
  private runPaths: string[] = [];
  private runBytes: number[] = [];
  private finalized = false;

  readonly stats: ExternalSortStats = {
    recordsIn: 0, runsWritten: 0, groupsOut: 0, bytesWritten: 0, peakDiskBytes: 0,
  };

  constructor(opts: ExternalGroupSortOptions<T>) {
    this.opts = {
      maxBufferEntries: opts.maxBufferEntries ?? 400_000,
      compress:         opts.compress ?? true,
      gzipLevel:        opts.gzipLevel ?? 1,
      validateKeys:     opts.validateKeys ?? false,
      ...opts,
    } as Required<ExternalGroupSortOptions<T>>;
    fs.mkdirSync(this.opts.tempDir, { recursive: true });
  }

  /**
   * Buffer one record. Returns true when the buffer is full and the caller
   * must `await sorter.spill()` before the next `add`.
   *
   * Deliberately synchronous: this runs once per surviving input row (10M+ on a
   * presidential cycle) and an `await` per row costs a microtask each. The
   * caller drives the spill:
   *
   *   if (sorter.add(key, value)) await sorter.spill();
   */
  add(key: string, value: T): boolean {
    if (this.finalized) throw new Error("external-sort: add() after finalize()");
    // Always validate the FIRST key, however `validateKeys` is set. A framing
    // mistake (a tab inside a composite key) is systematic — it is wrong on
    // record #1 or never — and left undetected it does not throw, it silently
    // regroups by a key PREFIX. That cost a full equivalence cycle to find
    // once; it does not get to happen twice.
    if (this.stats.recordsIn === 0) assertSortableKey(key);
    else if (this.opts.validateKeys) assertSortableKey(key);
    this.stats.recordsIn++;
    const existing = this.buffer.get(key);
    this.buffer.set(key, existing === undefined ? value : this.opts.combine(existing, value));
    return this.buffer.size >= this.opts.maxBufferEntries;
  }

  /** Sort the buffer by key and write it out as a run file. No-op when empty. */
  async spill(): Promise<void> {
    if (this.buffer.size === 0) return;
    const keys = [...this.buffer.keys()].sort();
    const buf  = this.buffer;
    // Drop the buffer reference BEFORE the (async) write so the generator below
    // is the only thing holding it and V8 can reclaim as it drains.
    this.buffer = new Map<string, T>();

    const runPath = path.join(this.opts.tempDir, `${this.opts.name}.run-${this.runPaths.length}`);
    const enc = this.opts.encode;
    const bytes = await writeLines(
      runPath,
      (function* () {
        for (const k of keys) yield `${k}\t${enc(buf.get(k) as T)}`;
      })(),
      this.opts.compress,
      this.opts.gzipLevel,
    );
    buf.clear();

    this.runPaths.push(runPath);
    this.runBytes.push(bytes);
    this.stats.runsWritten++;
    this.stats.bytesWritten += bytes;
    this.trackPeakDisk();
  }

  /**
   * High-water of this sorter's simultaneous on-disk footprint: the run files
   * still live plus whatever the merged output has flushed so far. Sampled at
   * every spill and periodically through the merge (statSync on a file being
   * written is cheap and only undercounts by the stream's in-flight buffer).
   */
  private trackPeakDisk(outPath?: string): void {
    let live = 0;
    for (const b of this.runBytes) live += b;
    if (outPath) {
      try { live += fs.statSync(outPath).size; } catch { /* not created yet */ }
    }
    if (live > this.stats.peakDiskBytes) this.stats.peakDiskBytes = live;
  }

  /**
   * Merge every run into one sorted, fully-reduced output file and return a
   * re-readable handle over it. Run files are deleted as the merge drains them,
   * so peak disk is (all runs) + (output written so far), not 2×.
   *
   * Fast path: if nothing ever spilled, the buffer IS the answer — sort it and
   * write the output directly. That keeps small cycles and unit tests off the
   * merge path entirely.
   */
  async finalize(): Promise<SortedGroups<T>> {
    if (this.finalized) throw new Error("external-sort: finalize() called twice");
    this.finalized = true;

    const outPath = path.join(this.opts.tempDir, `${this.opts.name}.sorted`);
    const { compress, gzipLevel, encode, decode, combine } = this.opts;

    let groups = 0;

    if (this.runPaths.length === 0) {
      const keys = [...this.buffer.keys()].sort();
      const buf  = this.buffer;
      this.buffer = new Map<string, T>();
      groups = keys.length;
      const bytes = await writeLines(
        outPath,
        (function* () {
          for (const k of keys) yield `${k}\t${encode(buf.get(k) as T)}`;
        })(),
        compress, gzipLevel,
      );
      buf.clear();
      this.stats.bytesWritten += bytes;
      if (bytes > this.stats.peakDiskBytes) this.stats.peakDiskBytes = bytes;
      this.stats.groupsOut = groups;
      return makeSortedGroups(outPath, compress, decode, groups, bytes);
    }

    // Anything still buffered becomes the last run, so the merge is uniform.
    await this.spill();

    const cursors: Cursor[] = [];
    const heap = new CursorHeap();
    const runPaths = this.runPaths;
    const runBytes = this.runBytes;

    for (let i = 0; i < runPaths.length; i++) {
      const rl   = readLines(runPaths[i]!, compress);
      const iter = rl[Symbol.asyncIterator]();
      const c: Cursor = {
        key: "", payload: "", idx: i,
        next: async () => {
          const r = await iter.next();
          if (r.done) return false;
          const line = r.value as string;
          const t = line.indexOf("\t");
          c.key     = t < 0 ? line : line.slice(0, t);
          c.payload = t < 0 ? ""   : line.slice(t + 1);
          return true;
        },
        close: async () => { rl.close(); },
      };
      cursors.push(c);
      if (await c.next()) heap.push(c);
      else await c.close();
    }

    const self = this;
    async function* merged(): AsyncGenerator<string> {
      let curKey: string | null = null;
      let curVal: T | undefined;
      while (heap.size > 0) {
        const c = heap.pop()!;
        const k = c.key;
        const v = decode(c.payload);
        if (curKey === null) {
          curKey = k; curVal = v;
        } else if (k === curKey) {
          curVal = combine(curVal as T, v);
        } else {
          groups++;
          yield `${curKey}\t${encode(curVal as T)}`;
          curKey = k; curVal = v;
        }
        if (await c.next()) {
          heap.push(c);
        } else {
          await c.close();
          // Reclaim the run's disk as soon as it is exhausted.
          try { fs.unlinkSync(runPaths[c.idx]!); } catch { /* best effort */ }
          runBytes[c.idx] = 0;
        }
        self.stats.groupsOut = groups;
        if (groups > 0 && groups % 250_000 === 0) self.trackPeakDisk(outPath);
      }
      if (curKey !== null) {
        groups++;
        yield `${curKey}\t${encode(curVal as T)}`;
      }
    }

    const bytes = await writeLines(outPath, merged(), compress, gzipLevel);
    this.stats.bytesWritten += bytes;
    this.stats.groupsOut = groups;
    this.trackPeakDisk(outPath);

    // Belt-and-braces: unlink anything the merge did not drain (a throw above
    // leaves them, and the caller's dispose path should not have to know).
    for (const p of runPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    this.runPaths = [];
    this.runBytes = [];

    return makeSortedGroups(outPath, compress, decode, groups, bytes);
  }

  /** Drop run files without merging — for an aborted stage. */
  async abort(): Promise<void> {
    this.finalized = true;
    this.buffer.clear();
    for (const p of this.runPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    this.runPaths = [];
    this.runBytes = [];
  }
}

function makeSortedGroups<T>(
  outPath:  string,
  compress: boolean,
  decode:   (payload: string) => T,
  groups:   number,
  bytes:    number,
): SortedGroups<T> {
  return {
    groupCount:  groups,
    outputBytes: bytes,
    async dispose() { try { fs.unlinkSync(outPath); } catch { /* ignore */ } },
    async *[Symbol.asyncIterator]() {
      const rl = readLines(outPath, compress);
      try {
        for await (const line of rl) {
          if (!line) continue;
          const t = line.indexOf("\t");
          const key     = t < 0 ? line : line.slice(0, t);
          const payload = t < 0 ? ""   : line.slice(t + 1);
          yield { key, value: decode(payload) };
        }
      } finally {
        rl.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Merge-join over two key-sorted streams
// ---------------------------------------------------------------------------

/**
 * Left-outer merge-join of two streams sorted by the SAME key ordering, where
 * `right` may hold several consecutive entries per key.
 *
 * Used by the indiv stage to attach each donor's cycle total (summed across
 * every one of that donor's aggregate rows, both recipient routes) to their
 * meta row without materializing the donor→total map — the last O(donors)
 * structure in the stage.
 *
 * `rightKeyPrefix` extracts the join key from a right-hand key that carries
 * extra sort fields after it (the aggregate key is `fp\troute\trecipient`; the
 * join key is `fp`).
 */
export async function* mergeJoinGrouped<L, R, O>(
  left:  AsyncIterable<{ key: string; value: L }>,
  right: AsyncIterable<{ key: string; value: R }>,
  rightKeyPrefix: (key: string) => string,
  emit: (key: string, leftValue: L, rightValues: R[]) => O,
): AsyncGenerator<O> {
  type RightRow = { key: string; value: R } | null;
  const rit = right[Symbol.asyncIterator]();
  const pullRight = async (): Promise<RightRow> => {
    const r = await rit.next();
    return r.done ? null : r.value;
  };

  let pending: RightRow = await pullRight();

  for await (const l of left) {
    // Discard right rows whose key sorts before the current left key. A
    // well-formed indiv run never has any, but a scoped/partial re-run can.
    while (pending !== null && rightKeyPrefix(pending.key) < l.key) pending = await pullRight();
    const bucket: R[] = [];
    while (pending !== null && rightKeyPrefix(pending.key) === l.key) {
      bucket.push(pending.value);
      pending = await pullRight();
    }
    yield emit(l.key, l.value, bucket);
  }
  if (rit.return) await rit.return(undefined as never);
}
