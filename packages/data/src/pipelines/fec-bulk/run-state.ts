/**
 * FIX-754 — checkpoint/resume state for the fec_bulk indiv ingest.
 *
 * WHY: the nightly fec-phase job SIGTERMs at its GHA budget on heavy Sundays.
 * Attribution from GHA run 28755577316 (2026-07-05 forced-heavy): the three
 * direct-pg indiv writers alone consumed ~132 of the 150 minutes (donor
 * entities 52m, indiv→candidate 47m, indiv→committee killed 32m in), while
 * download+extract+stream was ~2.3 minutes. A killed run used to restart from
 * zero the next Sunday, so a heavy week's ingest could never complete. This
 * module lets the NEXT nightly resume instead:
 *
 *   - Per-sub-stage completion markers, using the FIX-700 scope.ts stage
 *     vocabulary, so completed upsert stages are skipped (their id maps are
 *     rebuilt via batched direct-pg reads — see writer.ts).
 *   - Intra-stage chunk cursors for the three big direct-pg writers, persisted
 *     after every committed chunk (GHA SIGTERM gives no reliable grace window,
 *     so persistence must be incremental, never a shutdown handler).
 *
 * All resume state lives in pipeline_state under FEC_RUN_STATE_KEY — never a
 * runner-local file. GHA runners are ephemeral; a local state file dies with
 * the runner (the exact FIX-739 USASpending trap).
 *
 * Run identity = (cycle, FEC indiv Last-Modified). Resume is valid only while
 * FEC's current HEAD Last-Modified for the cycle matches the stored state; a
 * new FEC drop discards the state — correctness over saved progress (the
 * weekly drop cadence makes mid-week staleness rare, and the weeknights
 * between drops are ample to finish).
 *
 * Scoped runs (FEC_INDIV_TX_TYPES / FEC_INDIV_STAGES / FEC_INDIV_RECIPIENT_CMTES)
 * never create or consume this state — cursors from a partial slice must not
 * resume into a different scope (mirrors the FIX-701 watermark bypass).
 *
 * Re-streaming on resume is deterministic (same file + same filters ⇒ same map
 * contents and insertion order), but the derived writer rows also depend on DB
 * lookups (officials match index, entity ids) that can churn between nights.
 * Defense: each cursored stage records its merged rows-array length; a rebuilt
 * array of a different length resets that stage's cursor to 0 — the upserts
 * are idempotent, so a reset is merely slower, never wrong.
 *
 * Pure decision helpers up top (unit-testable without a pipeline run, mirrors
 * scope.ts); thin best-effort DB load/save/clear wrappers at the bottom.
 */

import type { Client } from "pg";
import { parseLastModified } from "./util";
import type { IndivStageName } from "./scope";

export const FEC_RUN_STATE_KEY = "fec_bulk_run_state";
export const FEC_RUN_STATE_VERSION = 1;

/** Per-cycle indiv sub-stages tracked in run state (scope.ts vocabulary).
 *  `totals` is deliberately absent — it is end-of-run, not per-cycle, and
 *  always runs on the completing run. */
export const TRACKED_STAGES = [
  "donor-entities",
  "indiv-to-candidate",
  "recipient-entities",
  "indiv-to-committee",
  "independent-expenditures",
] as const satisfies readonly IndivStageName[];
export type TrackedStage = (typeof TRACKED_STAGES)[number];

/** The four indiv writer sub-stages. When ALL are complete, a resumed run can
 *  skip download/extract/stream entirely — only the IE stage, totals, and the
 *  watermark persist remain. */
export const INDIV_WRITER_STAGES = [
  "donor-entities",
  "indiv-to-candidate",
  "recipient-entities",
  "indiv-to-committee",
] as const satisfies readonly TrackedStage[];

/** The three direct-pg writers big enough to need intra-stage cursors. */
export type CursoredStage = "donor-entities" | "indiv-to-candidate" | "indiv-to-committee";

export interface StageProgress {
  status: "in-progress" | "complete";
  /** Rows already processed — absolute offset into the writer's merged rows
   *  array. Cursored stages only. */
  cursor?: number;
  /** Merged rows-array length recorded when the stage first ran. The
   *  defensive check: a rebuilt array of a different length resets the cursor. */
  total_rows?: number;
}

/** Stored at pipeline_state.fec_bulk_run_state. snake_case keys to match the
 *  fec_indiv_watermark JSONB convention. */
export interface FecBulkRunState {
  version: number;
  cycle: string;
  /** RFC1123 Last-Modified of the FEC indiv file this run is ingesting. */
  fec_last_modified: string;
  fec_etag: string | null;
  started_at: string;
  updated_at: string;
  stages: Partial<Record<TrackedStage, StageProgress>>;
}

export function createRunState(
  cycle: string,
  fecLastModified: string,
  fecEtag: string | null,
  nowIso: string = new Date().toISOString(),
): FecBulkRunState {
  return {
    version: FEC_RUN_STATE_VERSION,
    cycle,
    fec_last_modified: fecLastModified,
    fec_etag: fecEtag,
    started_at: nowIso,
    updated_at: nowIso,
    stages: {},
  };
}

/** Shape-validate a raw pipeline_state.value. Returns null on anything that
 *  doesn't look like a v1 run state — including a future version bump, which
 *  must not be half-understood by v1 code. */
export function parseRunState(value: unknown): FecBulkRunState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== FEC_RUN_STATE_VERSION) return null;
  if (typeof v["cycle"] !== "string" || !v["cycle"]) return null;
  if (typeof v["fec_last_modified"] !== "string" || !v["fec_last_modified"]) return null;
  if (!v["stages"] || typeof v["stages"] !== "object" || Array.isArray(v["stages"])) return null;
  return v as unknown as FecBulkRunState;
}

/** Compare two HTTP Last-Modified strings by parsed timestamp (format-tolerant).
 *  Either side unparseable/null ⇒ false. */
export function sameLastModified(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const pa = parseLastModified(a);
  const pb = parseLastModified(b);
  return !!pa && !!pb && pa.getTime() === pb.getTime();
}

export type CycleResumePlan =
  | "none"          // no state pending
  | "other-cycle"   // state pends for a different cycle — leave it alone
  | "resume"        // identity verified, writer work remaining
  | "skip-indiv"    // identity verified, every indiv writer stage complete
  | "stale"         // FEC published a new drop — discard the state
  | "unverifiable"; // FEC HEAD failed — can neither resume nor safely discard

/**
 * Decide what this cycle should do with the pending run state, given the FEC
 * HEAD probe's Last-Modified (null/undefined = HEAD failed). "unverifiable"
 * means: run the cycle fresh WITHOUT checkpointing, keeping the stored state
 * for a later run that can verify it — the markers could hide new data if the
 * file actually changed, but discarding on a transient HEAD failure would
 * throw away real progress.
 */
export function planCycleResume(
  state: FecBulkRunState | null,
  cycle: string,
  probeLastModified: string | null | undefined,
): CycleResumePlan {
  if (!state) return "none";
  if (state.cycle !== cycle) return "other-cycle";
  if (!parseLastModified(probeLastModified)) return "unverifiable";
  if (!sameLastModified(state.fec_last_modified, probeLastModified)) return "stale";
  return allIndivWriterStagesComplete(state) ? "skip-indiv" : "resume";
}

export function stageIsComplete(state: FecBulkRunState, stage: TrackedStage): boolean {
  return state.stages[stage]?.status === "complete";
}

export function allIndivWriterStagesComplete(state: FecBulkRunState): boolean {
  return INDIV_WRITER_STAGES.every((s) => stageIsComplete(state, s));
}

export function markStageComplete(state: FecBulkRunState, stage: TrackedStage): void {
  const prev = state.stages[stage];
  state.stages[stage] = { ...(prev ?? {}), status: "complete" };
}

export function updateStageCursor(
  state: FecBulkRunState,
  stage: TrackedStage,
  cursor: number,
  totalRows: number,
): void {
  state.stages[stage] = { status: "in-progress", cursor, total_rows: totalRows };
}

/**
 * Where should a cursored writer start, given the stored stage progress and
 * the rows array it just rebuilt? The stored cursor is only trusted when the
 * rebuilt array length matches the recorded total (see the header comment on
 * determinism vs DB churn). A mismatch resets to 0 with `reset: true` so the
 * caller can log — idempotent upserts make a reset merely slower, never wrong.
 */
export function resolveResumeCursor(
  progress: StageProgress | undefined,
  actualTotalRows: number,
): { start: number; reset: boolean } {
  const cursor = progress?.cursor ?? 0;
  if (cursor <= 0) return { start: 0, reset: false };
  if (progress?.total_rows !== actualTotalRows) return { start: 0, reset: true };
  return { start: Math.min(cursor, actualTotalRows), reset: false };
}

// ---------------------------------------------------------------------------
// FIX-996 — checkpoint cadence + accounting
// ---------------------------------------------------------------------------

/**
 * Minimum gap between two SUCCESSFUL checkpoint persists inside a cursored
 * stage. Below this, a chunk's `onProgress` still fires (bulkUpsert's
 * every-chunk contract is load-bearing for FIX-754's cursor accounting) but the
 * write is skipped.
 *
 * WHY THROTTLE AT ALL: pre-FIX-996 the donor stage issued one synchronous
 * PostgREST upsert per 4,000-row chunk — 210 round-trips for that stage alone,
 * each on the congested path, at the exact moment the DB is saturated by the
 * writes being checkpointed. Measured on prod 2026-08-08, one of those saves
 * consumed the full ~100s gateway cap and then failed
 * (`[fec-resume] failed to persist run state (continuing): upstream request
 * timeout`).
 *
 * WHY 20s IS SAFE: re-done work on resume is bounded by whatever committed
 * inside the window, and every indiv upsert is idempotent on a stable arbiter —
 * the module header's "a reset is merely slower, never wrong" already covers
 * this. At the measured 52-68s per chunk the throttle is currently a no-op
 * (every chunk exceeds the window); it becomes load-bearing exactly when chunks
 * get fast, which is the direction this work is pushing them.
 */
export const CHECKPOINT_MIN_INTERVAL_MS = 20_000;

/** Per-stage checkpoint accounting, logged as one line at stage end (FIX-996).
 *  The 2026-08-03..08-08 investigation had to derive save cadence by hand from
 *  cursor arithmetic because nothing counted; this is that gap closed. */
export interface CheckpointStats {
  /** Persists attempted (i.e. not throttled away). */
  attempted: number;
  /** Persists that landed. */
  saved: number;
  /** Persists that threw and were swallowed by the best-effort contract. */
  failed: number;
  /** Chunks whose persist was skipped by the interval throttle. */
  throttled: number;
}

/** Mutable per-stage checkpoint state: the counters plus the last successful
 *  save time the throttle compares against. */
export interface CheckpointThrottle {
  stats: CheckpointStats;
  /** Epoch ms of the last SUCCESSFUL save. 0 = none yet, so the first call
   *  always persists (a failed save does not start the clock — otherwise a
   *  failure would suppress the retry that follows it). */
  lastSavedAtMs: number;
}

export function newCheckpointThrottle(): CheckpointThrottle {
  return { stats: { attempted: 0, saved: 0, failed: 0, throttled: 0 }, lastSavedAtMs: 0 };
}

/**
 * Should this chunk's cursor actually be written? `force` is stage completion —
 * the last cursor of a stage must always land, or a kill immediately after the
 * final chunk would resume mid-stage and re-do the tail.
 */
export function shouldPersistCheckpoint(
  t: CheckpointThrottle,
  nowMs: number,
  force: boolean,
): boolean {
  if (force) return true;
  return nowMs - t.lastSavedAtMs >= CHECKPOINT_MIN_INTERVAL_MS;
}

/** One-line stage-end summary, e.g. "checkpoint saves: 41 ok / 3 failed / 166 throttled". */
export function describeCheckpointStats(s: CheckpointStats): string {
  return `checkpoint saves: ${s.saved} ok / ${s.failed} failed / ${s.throttled} throttled`;
}

/** One-line summary for the loud RESUMING log lines (orchestrator + pipeline). */
export function describeRunState(state: FecBulkRunState): string {
  const parts = TRACKED_STAGES.map((s) => {
    const p = state.stages[s];
    if (!p) return `${s}=pending`;
    if (p.status === "complete") return `${s}=done`;
    return `${s}=${p.cursor ?? 0}/${p.total_rows ?? "?"}`;
  });
  return `cycle=${state.cycle} lm="${state.fec_last_modified}" ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Thin DB wrappers — best-effort by design. A state-save failure must never
// abort the pipeline (a stale cursor just re-upserts a few chunks on resume);
// a state-load failure just means no resume this run.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function loadRunState(db: Db): Promise<FecBulkRunState | null> {
  try {
    const { data, error } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", FEC_RUN_STATE_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return parseRunState(data?.value ?? null);
  } catch (err) {
    console.warn(
      `    [fec-resume] failed to load run state (treating as none): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * FIX-996 — persist the run state. Best-effort by contract: warns, continues,
 * NEVER throws. Returns whether the write landed, purely so the caller can
 * count (see CheckpointStats); ignoring the return value is the same behavior
 * as before.
 *
 * TRANSPORT: when `client` is supplied, the write goes over that live direct-pg
 * connection — the SAME one bulkUpsert is writing chunks on, inside
 * withDirectClient's scope, so no extra connection is opened (210 per-save
 * connections would be worse than the problem). That path carries the raised
 * 90-min SESSION statement_timeout and bypasses PostgREST entirely.
 *
 * FALLBACK: the save sites OUTSIDE the chunk loop — createRunState at stage
 * establishment, completeStage's marker write, and the orchestrator's load —
 * have no writer client in scope, so they pass none and go over PostgREST as
 * before. That path is subject to the service_role 8s statement_timeout and the
 * ~100s gateway cap; it is a handful of calls per run rather than hundreds, so
 * it is left alone deliberately. The fallback is explicit in the signature, not
 * an accident of a missing argument.
 */
export async function saveRunState(
  db: Db,
  state: FecBulkRunState,
  client?: Client | null,
): Promise<boolean> {
  state.updated_at = new Date().toISOString();
  try {
    if (client) {
      // `key` is the PRIMARY KEY of public.pipeline_state (migration 0012), so
      // the bare ON CONFLICT (key) arbiter matches PostgREST's onConflict:"key"
      // resolution exactly.
      await client.query(
        `INSERT INTO public.pipeline_state (key, value, updated_at)
         VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [FEC_RUN_STATE_KEY, JSON.stringify(state), state.updated_at],
      );
    } else {
      const { error } = await db.from("pipeline_state").upsert(
        { key: FEC_RUN_STATE_KEY, value: state, updated_at: state.updated_at },
        { onConflict: "key" },
      );
      if (error) throw new Error(error.message);
    }
    return true;
  } catch (err) {
    console.warn(
      `    [fec-resume] failed to persist run state (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export async function clearRunState(db: Db): Promise<void> {
  try {
    const { error } = await db.from("pipeline_state").delete().eq("key", FEC_RUN_STATE_KEY);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(
      `    [fec-resume] failed to clear run state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
