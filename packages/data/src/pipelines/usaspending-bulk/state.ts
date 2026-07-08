/**
 * FIX-739 — DB-backed run state for the USASpending bulk pipeline.
 *
 * Replaces the runner-local `packages/data/.usaspending-bulk-state.json`, which
 * was gitignored and died with each ephemeral GHA runner — so every CI dispatch
 * logged "No prior state — first run" and re-ran Full, and delta mode was dead
 * in CI (the exact trap FIX-754 called out for fec_bulk). State now lives in
 * `pipeline_state.usaspending_bulk_state` (JSONB, keyed by category); each DB
 * (local Docker vs Pro) holds its own, so the file's env-keying is unnecessary.
 *
 * Two things per category:
 *   - `baseline`:       the last FULLY-completed archive date. Delta decisions
 *                       read this; it advances only when an entire run finishes
 *                       (a partial Full must never seed a delta baseline).
 *   - `fullInProgress`: part-level resume for an in-flight Full run. Records the
 *                       archive identity (date) + the set of CSV parts already
 *                       upserted. A re-dispatch after a kill resumes the SAME
 *                       archive, skipping completed parts (upserts are idempotent
 *                       on *_award_unique_key, so replaying a boundary is
 *                       harmless); a different archive date discards the partial
 *                       and restarts. Resume granularity is a CSV part (~30 min
 *                       against a 350-min budget) — no row-offset cursors.
 *
 * Pure decision helpers up top (unit-tested in state.test.ts); thin best-effort
 * DB load/save wrappers + the one-time file→DB lift at the bottom.
 */

import * as fs   from "fs";
import * as path from "path";
import type { BulkCategory } from "./index";

export const USASPENDING_STATE_KEY     = "usaspending_bulk_state";
export const USASPENDING_STATE_VERSION = 1;

/** Last fully-completed archive per category — drives the delta decision. */
export interface CategoryBaseline {
  /** YYYYMMDD of the latest archive processed to completion. */
  lastArchiveDate: string;
  lastRunType:     "full" | "delta";
  lastRunAt:       string;
}

/** Part-level resume record for a Full run still in flight. */
export interface FullRunProgress {
  /** YYYYMMDD identity of the Full archive being processed. */
  archiveDate:    string;
  /** Composite keys (see partKey) of CSV parts already upserted. */
  completedParts: string[];
  startedAt:      string;
  updatedAt:      string;
}

export interface CategoryState {
  baseline?:       CategoryBaseline;
  fullInProgress?: FullRunProgress;
}

export interface UsaSpendingBulkState {
  version:     number;
  contracts?:  CategoryState;
  assistance?: CategoryState;
}

export function createEmptyState(): UsaSpendingBulkState {
  return { version: USASPENDING_STATE_VERSION };
}

/**
 * Shape-validate a raw pipeline_state.value. Returns null on anything that
 * isn't a v1 state — including a future version bump, which must not be
 * half-understood by v1 code (falls back to a fresh Full, heavy but safe).
 */
export function parseState(value: unknown): UsaSpendingBulkState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== USASPENDING_STATE_VERSION) return null;
  return v as unknown as UsaSpendingBulkState;
}

/** The completed-baseline used for delta decisions. null → run Full. */
export function getBaseline(
  state:    UsaSpendingBulkState,
  category: BulkCategory,
): CategoryBaseline | null {
  return state[category]?.baseline ?? null;
}

/**
 * Stable per-CSV-part identity within a Full run. Zip name + entry path so it is
 * unique whether an archive splits at the zip level (`_N.zip` suffix) or into
 * multiple CSV entries inside one zip (the FIX-766 case).
 */
export function partKey(zipName: string, entryPath: string): string {
  return `${zipName}::${entryPath}`;
}

function ensureCategory(
  state:    UsaSpendingBulkState,
  category: BulkCategory,
): CategoryState {
  let cat = state[category];
  if (!cat) { cat = {}; state[category] = cat; }
  return cat;
}

/**
 * Begin (or resume) a Full run for `archiveDate`. An in-progress Full for the
 * SAME date has its completed parts preserved (resume); an in-progress Full for
 * a DIFFERENT date is discarded (a newer archive dropped — correctness over
 * saved progress). Returns what happened so the caller can log loudly and knows
 * which parts to skip.
 */
export function startFullRun(
  state:       UsaSpendingBulkState,
  category:    BulkCategory,
  archiveDate: string,
  nowIso:      string = new Date().toISOString(),
): { resumed: boolean; discardedDate: string | null; completedParts: string[] } {
  const cat   = ensureCategory(state, category);
  const prior = cat.fullInProgress;

  if (prior && prior.archiveDate === archiveDate) {
    prior.updatedAt = nowIso;
    return {
      resumed:        prior.completedParts.length > 0,
      discardedDate:  null,
      completedParts: [...prior.completedParts],
    };
  }

  const discardedDate = prior ? prior.archiveDate : null;
  cat.fullInProgress = {
    archiveDate,
    completedParts: [],
    startedAt:      nowIso,
    updatedAt:      nowIso,
  };
  return { resumed: false, discardedDate, completedParts: [] };
}

export function isPartComplete(
  state:    UsaSpendingBulkState,
  category: BulkCategory,
  key:      string,
): boolean {
  return state[category]?.fullInProgress?.completedParts.includes(key) ?? false;
}

export function markPartComplete(
  state:    UsaSpendingBulkState,
  category: BulkCategory,
  key:      string,
  nowIso:   string = new Date().toISOString(),
): void {
  const cat = ensureCategory(state, category);
  if (!cat.fullInProgress) return;   // defensive — startFullRun must precede
  if (!cat.fullInProgress.completedParts.includes(key)) {
    cat.fullInProgress.completedParts.push(key);
  }
  cat.fullInProgress.updatedAt = nowIso;
}

/** A Full run finished every part: set the delta baseline, clear the partial. */
export function completeFullRun(
  state:       UsaSpendingBulkState,
  category:    BulkCategory,
  archiveDate: string,
  nowIso:      string = new Date().toISOString(),
): void {
  const cat = ensureCategory(state, category);
  cat.baseline = { lastArchiveDate: archiveDate, lastRunType: "full", lastRunAt: nowIso };
  delete cat.fullInProgress;
}

/** A Delta run finished: advance the baseline (no fullInProgress is involved). */
export function completeDeltaRun(
  state:           UsaSpendingBulkState,
  category:        BulkCategory,
  lastArchiveDate: string,
  nowIso:          string = new Date().toISOString(),
): void {
  const cat = ensureCategory(state, category);
  cat.baseline = { lastArchiveDate, lastRunType: "delta", lastRunAt: nowIso };
}

/** One-line summary for the loud state log line. */
export function describeState(
  state:    UsaSpendingBulkState,
  category: BulkCategory,
): string {
  const cat = state[category];
  if (!cat || (!cat.baseline && !cat.fullInProgress)) return `${category}=fresh`;
  const parts: string[] = [];
  if (cat.baseline) {
    parts.push(`baseline=${cat.baseline.lastArchiveDate}(${cat.baseline.lastRunType})`);
  }
  if (cat.fullInProgress) {
    parts.push(
      `full-in-progress=${cat.fullInProgress.archiveDate} ` +
      `parts=${cat.fullInProgress.completedParts.length}`,
    );
  }
  return `${category}: ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Legacy file → DB one-time lift
//
// The old runner-local JSON keyed state under `envs.{supabase-url-host}.{category}`
// (FIX-166) so local and prod progressed independently in one file. Each DB now
// holds its own state, so on migration we lift ONLY the active env's slice into
// `baseline`. The file is read once and never written or deleted again.
// ---------------------------------------------------------------------------

const LEGACY_STATE_FILE = path.join(__dirname, "../../../.usaspending-bulk-state.json");

/** Stable env identifier derived from the active Supabase URL (host + port). */
function envKey(): string {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!url) return "unknown";
  try { return new URL(url).host; } catch { return "unknown"; }
}

/**
 * Read the legacy file's baselines for the active env (or the given host).
 * Falls back to the v1 root shape (`{contracts,assistance}` at the top) and the
 * v0 root shape (a single contracts CategoryState at the root). Returns null
 * when the file is absent or carries nothing for that env. Never writes.
 */
export function readLegacyBaselines(
  filePath: string = LEGACY_STATE_FILE,
  host:     string = envKey(),
): { contracts?: CategoryBaseline; assistance?: CategoryBaseline } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  try {
    if (!fs.existsSync(filePath)) return null;
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }

  const out: { contracts?: CategoryBaseline; assistance?: CategoryBaseline } = {};
  const toBaseline = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    src: any,
  ): CategoryBaseline | undefined =>
    src?.lastArchiveDate
      ? {
          lastArchiveDate: src.lastArchiveDate,
          lastRunType:     src.lastRunType ?? "full",
          lastRunAt:       src.lastRunAt   ?? new Date().toISOString(),
        }
      : undefined;

  for (const category of ["contracts", "assistance"] as const) {
    const b = toBaseline(raw?.envs?.[host]?.[category]) ?? toBaseline(raw?.[category]);
    if (b) out[category] = b;
  }
  // v0: single contracts state at the root.
  if (!out.contracts) {
    const v0 = toBaseline(raw);
    if (v0) out.contracts = v0;
  }

  return out.contracts || out.assistance ? out : null;
}

// ---------------------------------------------------------------------------
// Thin DB wrappers — best-effort by design. A save failure must never abort the
// pipeline (a stale part-set just re-upserts a few idempotent parts on resume);
// a load failure just means no resume this run.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function loadState(db: Db): Promise<UsaSpendingBulkState> {
  try {
    const { data, error } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", USASPENDING_STATE_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = parseState(data?.value ?? null);
    if (parsed) return parsed;               // prefer the DB unconditionally
  } catch (err) {
    console.warn(
      `  [usaspending-state] load failed (treating as fresh): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return createEmptyState();
  }

  // DB key absent — one-time lift from the legacy file (active env only).
  const legacy = readLegacyBaselines();
  const state  = createEmptyState();
  if (legacy) {
    if (legacy.contracts)  state.contracts  = { baseline: legacy.contracts };
    if (legacy.assistance) state.assistance = { baseline: legacy.assistance };
    console.log(
      `  [usaspending-state] migrated legacy file state into pipeline_state for env "${envKey()}"`,
    );
    await saveState(db, state);
  }
  return state;
}

export async function saveState(db: Db, state: UsaSpendingBulkState): Promise<void> {
  try {
    const { error } = await db.from("pipeline_state").upsert(
      { key: USASPENDING_STATE_KEY, value: state, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(
      `  [usaspending-state] save failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
