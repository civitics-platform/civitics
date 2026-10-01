/**
 * FIX-903 — weekday "new FEC drop" trigger for the nightly fec_bulk stage.
 *
 * WHY: the nightly's fec phase runs many hours before FEC publishes, so it
 * always probes last week's file. FEC publishes indiv{yy}.zip on SUNDAYS around
 * 15:20–15:50 UTC; Sunday's heavy run has long since come and gone by then.
 *
 * The exact gap has moved twice and the numbers in this header are dated, so
 * treat nightly.yml's cron comment as the current one. When FIX-903 was written
 * the cron was 02:00 UTC and GHA queued it ~3.5h late (fec phase ~05:30 UTC). By
 * 2026-09-09 the queueing offset had grown to a near-constant 4h43–6h41, putting
 * the fec phase at 06:43–08:41 UTC. FIX-1163 then moved the cron to 21:00 UTC on
 * the previous day, which at that offset starts the fec phase 01:43–03:41 UTC.
 * Every one of those is hours BEFORE the same day's publish, so the premise
 * below is unchanged by any of it — only the size of the gap moved.
 *
 * Two failures compound:
 *
 *   1. If last week's file was already ingested, the FIX-193 watermark gate in
 *      ./index.ts short-circuits the whole indiv stage for the cycle.
 *   2. On those weeks nothing is left in fec_bulk_run_state, so the FIX-754
 *      weekday resume trigger in ../index.ts never fires either — Mon-Sat
 *      never invoked fec_bulk at all, and Sunday's fresh file sat uningested
 *      for a full week.
 *
 * Net effect before this module: one full indiv ingest per TWO weeks, one
 * ~2.5h writer run discarded per two weeks, and prod donor data permanently
 * 1-2 weeks behind FEC.
 *
 * The fix is a third trigger condition for the nightly gate: on a non-weekly
 * night with NO pending resume state, HEAD the active cycle's indiv file and
 * run fec_bulk when it is ahead of the stored watermark. The FIX-193 watermark
 * inside the pipeline stays the authoritative guard — this probe only decides
 * whether it is worth invoking the pipeline at all.
 *
 * FAIL CLOSED. A failed/unparseable HEAD returns false: launching a ~2.5h
 * writer run on a probe we could not read is strictly worse than waiting, and
 * the Sunday path still catches the drop the following week.
 *
 * Pure decision helpers up top (unit-testable without network or DB, mirrors
 * run-state.ts / weekly-gate.ts); a thin best-effort DB + HTTP wrapper at the
 * bottom.
 */

import { headFecFile, parseLastModified } from "./util";
import { pushRing, type DropProbeRingEntry, type StoredDropProbe } from "../../scripts/canary-fec-drop";

/** pipeline_state row holding the FIX-193 per-cycle indiv watermark. */
export const FEC_INDIV_WATERMARK_KEY = "fec_indiv_watermark";

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

/**
 * The FEC cycle currently being filed into, as a 4-digit string.
 *
 * FEC cycles are even-numbered (2024, 2026, ...); an odd year files into the
 * following even year. Extracted from the inline `yr % 2 === 0 ? yr : yr + 1`
 * expression in ../index.ts and shared with it deliberately: the drop probe and
 * the run it triggers MUST NOT be able to disagree about which cycle is active.
 */
export function currentFecCycle(now: Date): string {
  const yr = now.getFullYear();
  return String(yr % 2 === 0 ? yr : yr + 1);
}

/**
 * Which cycle should the drop probe HEAD?
 *
 * An explicit FEC_INDIV_CYCLES override wins (a cron-time or dispatch-time
 * knob must not be second-guessed) — the highest listed cycle is probed, since
 * that is the one FEC still republishes weekly. Anything unset/malformed falls
 * back to the calendar-derived active cycle.
 *
 * NOTE: this only chooses what to PROBE. It deliberately does not narrow what
 * the triggered run processes — the drop-pending path takes the pipeline's
 * normal 2-cycle / 1-indiv-cycle nightly defaults, unlike FIX-754 resume mode
 * which narrows to the single pending cycle.
 */
export function resolveProbeCycle(now: Date, envIndivCycles: string | undefined): string {
  const listed = (envIndivCycles ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}$/.test(s));
  if (listed.length === 0) return currentFecCycle(now);
  return listed.reduce((a, b) => (parseInt(b, 10) > parseInt(a, 10) ? b : a));
}

/**
 * Has FEC published an indiv drop newer than what we have ingested?
 *
 * Both sides are HTTP Last-Modified strings; comparison is by parsed timestamp
 * so a format change on either side degrades to "unparseable" rather than to a
 * wrong lexical comparison.
 *
 *   - probe unparseable/null (HEAD failed)  → false  (fail closed)
 *   - stored unparseable/null (never ingested) → true (there IS work to do)
 *   - otherwise → probe strictly newer than stored
 *
 * Strictly newer, not >=: an equal watermark means the file we hold is the file
 * FEC is serving, which is exactly the case the FIX-193 gate would skip anyway.
 */
export function indivDropIsAhead(
  stored: string | null | undefined,
  probe:  string | null | undefined,
): boolean {
  const p = parseLastModified(probe);
  if (!p) return false;
  const s = parseLastModified(stored);
  if (!s) return true;
  return p.getTime() > s.getTime();
}

/** FEC bulk URL for the itemized individual contributions file (indiv{yy}.zip). */
export function indivFileUrl(cycle: string): string {
  return `https://www.fec.gov/files/bulk-downloads/${cycle}/indiv${cycle.slice(2)}.zip`;
}

// ---------------------------------------------------------------------------
// Thin DB + HTTP wrapper — best-effort by design. A probe failure must never
// abort the nightly; it degrades to "no drop pending", which is the pre-FIX-903
// weekday behavior.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

type IndivWatermark = Record<string, { last_modified?: string | null } | undefined>;

function q(s: string | null | undefined): string {
  return s ? `"${s}"` : "(none)";
}

/**
 * The full result of one drop probe — both timestamps, not just the verdict.
 *
 * FIX-1163: the boolean was all `indivDropPending` ever returned, so the two
 * Last-Modified values it compared existed only in a GHA log line. That is the
 * whole reason "did anything notice Sunday's drop?" has been a log-crawl every
 * time it is asked. The record-only caller in ../index.ts persists this shape.
 */
export interface IndivDropProbe {
  cycle: string;
  pending: boolean;
  /** FEC's Last-Modified for indiv{yy}.zip, or null when the HEAD failed. */
  remote_last_modified: string | null;
  /** Our FIX-193 stored watermark for the cycle, or null when unset. */
  watermark_last_modified: string | null;
  probed_at: string;
}

/**
 * Read the stored watermark for `cycle`, HEAD FEC's indiv file for the same
 * cycle, and report whether FEC is ahead — with both timestamps.
 *
 * Costs one small SELECT plus one HEAD (which 302s to S3) — cheap enough to run
 * on every weekday nightly. Logs both timestamps on every outcome so a nightly
 * transcript always shows why fec_bulk did or did not fire.
 *
 * FAIL CLOSED, as `indivDropPending` always has: any throw yields
 * `pending: false` with null timestamps. A caller cannot distinguish "FEC is
 * level with us" from "we could not read FEC" by the boolean alone — that is
 * what the null `remote_last_modified` is for.
 */
export async function probeIndivDrop(db: Db, cycle: string): Promise<IndivDropProbe> {
  const probed_at = new Date().toISOString();
  try {
    const { data, error } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", FEC_INDIV_WATERMARK_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const raw = (data?.value ?? null) as IndivWatermark | null;
    const stored =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw[cycle]?.last_modified ?? null
        : null;

    const head  = await headFecFile(indivFileUrl(cycle));
    const probe = head?.lastModified ?? null;
    const ahead = indivDropIsAhead(stored, probe);

    const verdict = ahead
      ? "NEW DROP PENDING"
      : probe
        ? "no new drop"
        : "HEAD failed — failing closed";
    console.info(
      `  [fec-drop-check] cycle=${cycle} FEC indiv Last-Modified ${q(probe)} ` +
        `vs watermark ${q(stored)} → ${verdict} (FIX-903)`,
    );
    return {
      cycle,
      pending: ahead,
      remote_last_modified: probe,
      watermark_last_modified: stored,
      probed_at,
    };
  } catch (err) {
    console.warn(
      `  [fec-drop-check] probe failed for cycle ${cycle} (treating as no drop): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      cycle,
      pending: false,
      remote_last_modified: null,
      watermark_last_modified: null,
      probed_at,
    };
  }
}

/**
 * The FIX-903 verdict alone. Unchanged contract, unchanged call site: the
 * nightly's fec-phase trigger still takes a boolean and still fails closed.
 */
export async function indivDropPending(db: Db, cycle: string): Promise<boolean> {
  return (await probeIndivDrop(db, cycle)).pending;
}

/** pipeline_state row holding the most recent drop probe (FIX-1163). */
export const FEC_DROP_PROBE_KEY = "fec_drop_probe";

/**
 * Persist a probe result to `pipeline_state.fec_drop_probe` (FIX-1163).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TRIGGER: the FIX-903 probe is evaluated
 * *inside* the fec phase, downstream of the exact failure it is there to
 * detect. A fec-phase that is killed, held, or never starts loses the day's
 * ingest AND the only evidence that a drop was waiting. Recording the probe
 * from a phase that always runs makes "a drop is pending and nobody collected
 * it" answerable from a row instead of a GHA log crawl.
 *
 * FIX-1166 — the row also carries a three-deep `recent` ring of
 * {probed_at, remote_last_modified}, newest first. The watcher needs it because
 * probeIndivDrop FAILS CLOSED: an unreadable HEAD returns pending=false with a
 * null remote_last_modified, so a permanently broken probe is indistinguishable
 * from a permanently level watermark on the current row alone. Three
 * consecutive nulls is what makes that reportable; one is just FEC being FEC.
 * Writing it here rather than reconstructing it from the canary's own history
 * costs one small read and keeps working across a stretch where the canary did
 * not run — which is exactly when a blind probe goes unnoticed.
 *
 * Never throws, never widens the trigger: this writes one row and returns.
 */
export async function recordDropProbe(
  db: Db,
  probe: IndivDropProbe,
  phase: string,
): Promise<boolean> {
  try {
    // Best-effort read of the existing ring. A failure here must not cost us
    // the probe row itself, so it degrades to a fresh one-entry ring.
    let priorRing: DropProbeRingEntry[] | undefined;
    try {
      const { data } = await db
        .from("pipeline_state")
        .select("value")
        .eq("key", FEC_DROP_PROBE_KEY)
        .maybeSingle();
      const prior = (data?.value ?? null) as StoredDropProbe | null;
      if (prior && Array.isArray(prior.recent)) priorRing = prior.recent;
    } catch {
      priorRing = undefined;
    }
    const recent = pushRing(priorRing, {
      probed_at: probe.probed_at,
      remote_last_modified: probe.remote_last_modified,
    });

    const { error } = await db.from("pipeline_state").upsert(
      {
        key: FEC_DROP_PROBE_KEY,
        value: { ...probe, phase, recent },
        updated_at: probe.probed_at,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.warn(
      `  [fec-drop-check] failed to persist ${FEC_DROP_PROBE_KEY} (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
