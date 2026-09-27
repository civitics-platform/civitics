// rederive-budget.mjs — chunking and the two-term budget guard for the
// manifest-driven FE totals re-derives (FIX-1235, cc-163). Pure; tested by
// scripts/test-rederive-budget.mjs.
//
// WHY TWO TERMS (rule 204): cc-160's FIX-1226 guard projected the remaining
// work at ONE cumulative rows/s rate. A chunk's wall is two costs — the FE
// UPDATE per id written (~15 ms on prod) and the FR read per row — and the
// first chunks, sorted by rows ascending, are 200 ids with few rows each: write
// cost, not read cost. Their rows/s rate, applied to the row-heavy tail, over-
// projected 3.3× and stopped a run that would have finished inside its budget.
// Here each chunk's (ids, rows, wall) is a sample of
//
//   wall ≈ msPerId × ids + msPerRow × rows
//
// fitted by least squares on both unknowns, non-negative, and the projection is
// idsLeft × msPerId + rowsLeft × msPerRow.

/** Sort ascending by rows; close an ordinary chunk at idsPerChunk ids OR rowsPerChunk rows; whales (> whaleRows) are chunks of one, last. */
export function chunkIds(rows, { idsPerChunk, rowsPerChunk, whaleRows }) {
  const sorted = [...rows].sort((a, b) => a.fr_rows - b.fr_rows || (a.id < b.id ? -1 : 1));
  const chunks = [];
  let cur = [];
  let curRows = 0;
  for (const r of sorted.filter((x) => x.fr_rows <= whaleRows)) {
    if (cur.length > 0 && (cur.length === idsPerChunk || curRows + r.fr_rows > rowsPerChunk)) {
      chunks.push(cur);
      cur = [];
      curRows = 0;
    }
    cur.push(r.id);
    curRows += r.fr_rows;
  }
  if (cur.length > 0) chunks.push(cur);
  for (const w of sorted.filter((x) => x.fr_rows > whaleRows)) chunks.push([w.id]);
  return chunks;
}

// Two-sided 95 % Student-t critical values by degrees of freedom. With a
// handful of chunks "twice the standard error" is far too lax: at 2 dof the
// clone rehearsal's one 300 ms spike on its row-heaviest chunk read as a
// per-row cost (t = 2.1) and projected 57 s for a 1 s run.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
export function tCritical(dof) {
  return dof < T95.length ? T95[dof] : 2.0;
}

/**
 * Least squares for wall_ms ≈ a·ids + b·rows over samples [{ids, rows, ms}],
 * keeping a coefficient only when the samples IDENTIFY it. Returns
 * {msPerId, msPerRow}, both ≥ 0.
 *
 * Why the identification test: the first chunks are all 200 ids with a few
 * hundred rows between them. Over that narrow a row range, ±7 % wall noise is a
 * per-row slope of several ms — and multiplied by the tail's ~300 k rows it
 * projects a quarter of an hour for a minute of work. That is cc-160's false
 * stop again, reached by a two-term fit instead of a one-term one (the rule 105
 * test pins it). So a coefficient is used only if its estimate exceeds its
 * standard error × tCritical(n − 2); otherwise it is dropped and the other term refitted
 * alone. Dropping the per-row term early under-projects the tail — the guard's
 * elapsed check before every chunk still bounds the run, to one chunk.
 *
 * When NEITHER term is identified, the walls do not scale detectably with ids
 * or rows — a fixed per-statement cost dominates (the clone rehearsal: ~20 ms a
 * chunk, one 130 ms spike). Picking the single term with the smaller residual
 * there projected 28.8 s for a 1.6 s run, so instead the projection is the mean
 * chunk wall per chunk left ({msPerChunk}). Chunks are capped at 200 ids and
 * 50,000 rows, which is what makes a per-chunk mean a bounded estimate.
 */
export function fitTwoTerm(samples) {
  let xx = 0, xy = 0, yy = 0, xw = 0, yw = 0;
  for (const s of samples) {
    xx += s.ids * s.ids;
    xy += s.ids * s.rows;
    yy += s.rows * s.rows;
    xw += s.ids * s.ms;
    yw += s.rows * s.ms;
  }
  const sse = (a, b) => samples.reduce((acc, s) => acc + (s.ms - a * s.ids - b * s.rows) ** 2, 0);
  const onlyIds = { msPerId: xx > 0 ? Math.max(0, xw / xx) : 0, msPerRow: 0, msPerChunk: 0 };
  const onlyRows = { msPerId: 0, msPerRow: yy > 0 ? Math.max(0, yw / yy) : 0, msPerChunk: 0 };
  const bestSingle = () => (sse(onlyIds.msPerId, 0) <= sse(0, onlyRows.msPerRow) ? onlyIds : onlyRows);
  const perChunk = { msPerId: 0, msPerRow: 0, msPerChunk: samples.reduce((acc, s) => acc + s.ms, 0) / samples.length };

  const det = xx * yy - xy * xy;
  // Collinear samples (every chunk the same ids:rows ratio) leave the split
  // undetermined; so does a fit with no residual degree of freedom.
  if (samples.length < 3 || !(Math.abs(det) > 1e-9 * Math.max(1, xx * yy))) return bestSingle();
  const a = (xw * yy - yw * xy) / det;
  const b = (yw * xx - xw * xy) / det;
  const dof = samples.length - 2;
  const sigma2 = sse(a, b) / dof;
  const seA = Math.sqrt((sigma2 * yy) / det);
  const seB = Math.sqrt((sigma2 * xx) / det);
  const t = tCritical(dof);
  const keepA = a > t * seA;
  const keepB = b > t * seB;
  if (keepA && keepB) return { msPerId: a, msPerRow: b, msPerChunk: 0 };
  if (keepA) return onlyIds;
  if (keepB) return onlyRows;
  return perChunk;
}

/**
 * The guard, before each chunk. `done` = the chunks run so far as samples.
 * Below minChunks samples it checks elapsed only (a fit on one or two points
 * is not a fit). Returns {stop, reason, projectedSeconds} — projectedSeconds is
 * elapsed plus the fitted remainder (null below minChunks).
 */
export function budgetCheck({ elapsedSeconds, budgetSeconds, done, idsLeft, rowsLeft, chunksLeft, minChunks }) {
  if (elapsedSeconds >= budgetSeconds) {
    return { stop: true, reason: `elapsed ${elapsedSeconds.toFixed(1)} s reached the ${budgetSeconds} s budget`, projectedSeconds: null };
  }
  if (done.length < minChunks) return { stop: false, reason: null, projectedSeconds: null };
  const { msPerId, msPerRow, msPerChunk } = fitTwoTerm(done);
  const remainingSeconds = (idsLeft * msPerId + rowsLeft * msPerRow + chunksLeft * msPerChunk) / 1000;
  const projectedSeconds = elapsedSeconds + remainingSeconds;
  if (projectedSeconds > budgetSeconds) {
    const terms =
      msPerChunk > 0
        ? `${chunksLeft} chunks × ${msPerChunk.toFixed(1)} ms — neither term identified`
        : `${idsLeft} ids × ${msPerId.toFixed(2)} ms + ${rowsLeft} rows × ${msPerRow.toFixed(4)} ms`;
    return {
      stop: true,
      reason: `projected ${projectedSeconds.toFixed(1)} s (${terms} left) passes the ${budgetSeconds} s budget`,
      projectedSeconds,
    };
  }
  return { stop: false, reason: null, projectedSeconds };
}
