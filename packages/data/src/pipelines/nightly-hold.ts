/**
 * FIX-950 — pure predicates for the nightly orchestrator under a supervised
 * prod session. The sibling of `fec-hold.ts`, and here for the same reason:
 * `index.ts` pulls createAdminClient, the ai-tagger's module-level
 * createAiClient() and the whole ingest import graph, so the truth table can
 * only be asserted from a module that imports none of it.
 *
 * ── D3a: SKIP WRITERS, KEEP PROBES ──────────────────────────────────────────
 * The alternative — skip whole phases — is simpler and wrong. The FIX-1163
 * drop probe is a HEAD plus one `pipeline_state` write, and FIX-1166 escalates
 * when it goes stale. Skipping it would make every supervised session a
 * `probe-missing` TRUE POSITIVE, i.e. the interlock would manufacture the exact
 * alert it is supposed to let an operator avoid. So the probe runs under a hold
 * and the writers do not.
 *
 * ── WHERE THE LINE IS DRAWN, AND WHY IT IS NOT "EVERYTHING" ─────────────────
 * Under a hold:
 *
 *   fec_bulk chain          HELD. It is the 2.5-hour writer, and it already
 *                           takes a `held` input (FIX-998), so this is one OR.
 *   enrichment heavy/light  Writer blocks SKIPPED (LittleSis, EDGAR-weekly,
 *   /tail                   USASpending, OpenStates API, the agency family,
 *                           tag-industry, the AI taggers, the comment scorer).
 *   FEC drop probe          STILL RECORDS (see D3a above).
 *   Phase 1 daily ingest    STILL RUNS. Deliberate. Regulations.gov,
 *   (regulations,           Congress.gov, the OpenStates bulk people refresh
 *   congress, edgar         and the EDGAR 13D/G poll are the platform's primary
 *   daily, openstates)      DATA INTAKE, they are watermarked or upserted so a
 *                           missed night is re-collected by the next one, and
 *                           on prod 2026-09-11 the whole fec phase took 3m50s.
 *                           Costing a day of congressional votes to save four
 *                           minutes of contention is the wrong trade; the
 *                           rollups this DOES hold are derived and re-derive
 *                           themselves on their next firing.
 *
 * ── THE PHASE ROW'S STATUS ─────────────────────────────────────────────────
 * A held phase closes `skipped`, not `complete`: it did not do its work, and
 * `complete` would be a lie that `check_rollup_freshness` would then believe.
 * `nightlyPhaseStatus` only says `skipped` when EVERY writer block the phase
 * selected was held — which is why `all` (whose fec half still runs) does not
 * qualify and `enrichment` (whose three sub-phases all hold) does.
 *
 * Note the consequence, which is intended: `list_scheduled_rollup_pipelines`
 * and `check_rollup_freshness` both count ONLY `status='complete'`, so a held
 * phase does not advance the freshness clock. That is the honest reading of a
 * firing that did nothing. It also means a session long enough to cross a
 * pipeline's report threshold will be reported stale — measured on prod
 * 2026-09-11, `financial_entity_totals_refresh` reports at 0.8 h and escalates
 * at 1.3 h, which is the shortest such window on the platform. See
 * docs/ops/prod-holds.md.
 */

import type { NightlyPhase } from "./index";
import type { FecBulkTriggerInputs } from "./fec-hold";
import { ProdSessionRefused } from "../lib/prod-session";

export interface NightlyHoldInputs {
  /** `prod_session_state()->>'defer'`. False when the reader was unavailable. */
  sessionHeld: boolean;
}

/**
 * Should a selected writer block actually run?
 *
 * `phaseSelected` is the existing `runEnrichmentHeavy` / `runEnrichmentLight` /
 * `runEnrichmentTail` gate, so `sessionHeld === false` is byte-identical to
 * pre-FIX-950 behaviour at every call site.
 */
export function writersRun(phaseSelected: boolean, i: NightlyHoldInputs): boolean {
  return phaseSelected && !i.sessionHeld;
}

/**
 * The fec_bulk chain's `held` input: the FIX-998 deploy-time flag OR a live
 * supervised session. One OR, threaded through all three trigger predicates by
 * `fec-hold.ts` — which is the module that exists because a guard on one branch
 * is not a guard.
 */
export function fecChainHeld(flagHeld: boolean, i: NightlyHoldInputs): boolean {
  return flagHeld || i.sessionHeld;
}

/**
 * The FIX-1163 drop probe is hold-INDEPENDENT by design (D3a). Stated as a
 * function anyway so the intent is greppable and the test can assert it rather
 * than the absence of a gate being something a future edit quietly adds.
 */
export function probeRecords(phaseSelected: boolean, _i: NightlyHoldInputs): boolean {
  return phaseSelected;
}

/**
 * True when every writer block this phase would have run was held — i.e. the
 * phase genuinely did nothing but its probe.
 */
export function phaseFullyHeld(phase: NightlyPhase, i: NightlyHoldInputs): boolean {
  if (!i.sessionHeld) return false;
  switch (phase) {
    case "enrichment":
    case "enrichment-heavy":
    case "enrichment-light":
    case "enrichment-tail":
      return true;
    // 'fec' still runs the Phase 1 daily ingest; 'all' contains it.
    case "fec":
    case "all":
      return false;
  }
}

/** The `data_sync_log` status the phase's terminal row closes with. */
export function nightlyPhaseStatus(args: {
  phase: NightlyPhase;
  hold: NightlyHoldInputs;
  hasErrors: boolean;
}): "complete" | "partial" | "skipped" {
  if (phaseFullyHeld(args.phase, args.hold)) return "skipped";
  return args.hasErrors ? "partial" : "complete";
}

/**
 * The operator-facing reason, in the exact form the guarded pg_cron procedures
 * write into their own `skip_reason`. One spelling across both mechanisms is
 * what lets FIX-1137's re-fire key on `skip_reason LIKE 'prod session held%'`
 * without caring whether the firing was pg_cron's or GitHub's.
 */
export function prodSessionHoldReason(reason: string | null | undefined): string {
  return `prod session held: ${reason && reason.trim() !== "" ? reason : "(no label)"}`;
}

/** The loud one-liner the orchestrator logs once per held phase. */
export function prodSessionHoldBanner(reason: string | null | undefined): string {
  return (
    `${prodSessionHoldReason(reason)} (FIX-950) — the nightly's writer blocks are ` +
    "SKIPPED for this phase. The FEC drop probe still records, and the Phase 1 " +
    "daily ingest still runs. Release the session (Ctrl-C on session:claim-prod, " +
    "or let the landing script finish) to restore the normal path."
  );
}

// ---------------------------------------------------------------------------
// FIX-1310 — the nightly's fec_bulk writer takes the claim (D6)
// ---------------------------------------------------------------------------
//
// Everything above decides whether the nightly TRIES a writer block (it reads
// prod_session_state() once, at the top). These three decide what happens when
// the fec_bulk block then asks for the FIX-950 claim itself, so the box can see
// a drop night the way it sees a supervised landing: the guarded pg_cron jobs
// skip with this reason, the freshness holds go up, and `session:held` reads
// true for the wall. Playbook C9: a prod-writing pipeline is visible to the
// interlock, or it does not run on prod.

/** Which of `shouldRunFecBulk`'s three conditions admitted this run. */
export type FecBulkTrigger = "weekly" | "resume" | "drop";

/**
 * The trigger word, in `shouldRunFecBulk`'s own priority order. Only meaningful
 * once that returned true. On a weekly run the resume state is never loaded
 * (`shouldLoadResumeState`), so `weekly` wins by construction there too.
 */
export function fecBulkTrigger(i: FecBulkTriggerInputs, resumeStatePresent: boolean): FecBulkTrigger {
  if (i.isWeekly) return "weekly";
  return resumeStatePresent ? "resume" : "drop";
}

/**
 * The claim's `reason`. It is what an operator reads in every guarded job's
 * `skip_reason` ('prod session held: nightly fec_bulk weekly run …'), so it
 * names the GHA run that holds the box — the one id that leads straight to a
 * log. Capped at 300 like `runUnderProdSession`'s; `withProdSession` does not
 * cap it.
 */
export function nightlyFecClaimReason(args: {
  trigger: FecBulkTrigger;
  runId: string | undefined;
  cycles: string | undefined;
  indivCycles: string | undefined;
}): string {
  const run = args.runId && args.runId.trim() !== "" ? args.runId : "local";
  const list = (v: string | undefined) => (v && v.trim() !== "" ? v : "(default)");
  return (
    `nightly fec_bulk ${args.trigger} run ${run} ` +
    `cycles=${list(args.cycles)} indiv=${list(args.indivCycles)}`
  ).slice(0, 300);
}

/**
 * What a claim error becomes. A REFUSAL — a human holds the box, or another
 * writer is live — is a `skipped` fec_bulk, the FIX-998 vocabulary every
 * consumer of the payload already reads; the FIX-754 resume state is left as it
 * was, so the next nightly picks the work up. Anything else is rethrown:
 * `withProdSession` already fails OPEN on every infrastructure error, so what
 * reaches here un-refused is a real fault and must not be dressed as a skip.
 */
export function classifyFecClaimError(
  err: unknown,
): { kind: "skipped"; error: string } | { kind: "rethrow" } {
  if (err instanceof ProdSessionRefused) {
    return { kind: "skipped", error: `prod session claim refused: ${err.verdict.detail}` };
  }
  return { kind: "rethrow" };
}
