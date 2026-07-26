/**
 * FIX-903 — weekday "new FEC drop" trigger for the nightly fec_bulk stage.
 *
 * WHY: nightly-sync is scheduled 02:00 UTC, but GHA queues it ~3.5h late, so
 * the fec phase actually starts ~05:30 UTC. FEC publishes indiv{yy}.zip on
 * SUNDAYS around 15:20 UTC — nine hours AFTER Sunday's heavy run already came
 * and went. The Sunday run therefore always probes last week's file, and two
 * failures compound:
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
 * Read the stored watermark for `cycle`, HEAD FEC's indiv file for the same
 * cycle, and report whether FEC is ahead.
 *
 * Costs one small SELECT plus one HEAD (which 302s to S3) — cheap enough to run
 * on every weekday nightly. Logs both timestamps on every outcome so a nightly
 * transcript always shows why fec_bulk did or did not fire.
 */
export async function indivDropPending(db: Db, cycle: string): Promise<boolean> {
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
    console.log(
      `  [fec-drop-check] cycle=${cycle} FEC indiv Last-Modified ${q(probe)} ` +
        `vs watermark ${q(stored)} → ${verdict} (FIX-903)`,
    );
    return ahead;
  } catch (err) {
    console.warn(
      `  [fec-drop-check] probe failed for cycle ${cycle} (treating as no drop): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
