/**
 * FIX-234 — Silent-failure alarm for the nightly sync.
 *
 * Queries data_sync_log for `nightly_cron` complete rows over the last 7 UTC
 * days. If any expected day has no matching row, optionally emails ADMIN_EMAIL
 * via Resend.
 *
 * Designed for GitHub Actions (.github/workflows/sync-canary-check.yml) at
 * 05:00 UTC, 3h after the nightly's 02:00 UTC start. The pipeline name string
 * `nightly_cron` is what runNightlySync() writes on completion — see
 * packages/data/src/pipelines/index.ts.
 *
 * No-op-safe: missing ADMIN_EMAIL or RESEND_API_KEY simply skips the send.
 * Local-run guard: even when both env vars are set, the Resend send is gated
 * on GITHUB_ACTIONS=true OR --send-real, so local iteration doesn't page the
 * admin by accident.
 *
 * Exit 1 only on real errors (DB unreachable, Resend API failure). Missing
 * nightlies are not script errors — they're the thing the script reports.
 */

import { createAdminClient } from "@civitics/db";
import { captureRssMb } from "../pipelines/sync-log";

const PIPELINE_NAME      = "nightly_cron";
const KILLED_PIPELINE    = "nightly_killed";
const CHECK_DAYS         = 7;
// FIX-944 — rollup pipelines the canary watches for "never reached complete".
// The canary previously watched ONLY nightly_cron, which is why
// donor_rollup_refresh could fail four days running (2026-07-27..30) and read
// as ordinary noise in data_sync_log. Each entry is checked against its own
// max-age; exceeding it escalates (non-zero exit), same as the DB-health
// findings, because a stale money rollup is a point-in-time fact about prod
// that stays broken until someone acts.
//
// FIX-977 — THIS LIST IS NO LONGER THE TRUTH. It is the fallback for an
// environment where list_scheduled_rollup_pipelines() has not been migrated yet.
//
// It used to be the whole registry, at length 1, and that was the defect: the
// RPC it feeds (check_rollup_freshness) is fully generic, so the narrowing was
// purely this array. Measured on prod 2026-08-07, four UNWATCHED pipelines were
// 1.1-2.4 cadence cycles behind — financial_entity_totals_refresh at 403.8h
// (it renders total_donated_cents on every donor and financial-entity page) and
// entity_connections_rebuild at 212.8h (the graph) — while the ONE watched
// pipeline was the freshest of the five.
//
// Playbook D4 signature B / E5: a detector covers only what it enumerates.
// "Add four more entries" would be the same defect with a later expiry date, so
// the registry is now DERIVED from the schedule itself — see
// fetchRollupRegistry() below and the FIX-977 migration.
const FALLBACK_ROLLUP_PIPELINES: { pipeline: string; maxAgeHours: number }[] = [
  // Daily job (pg_cron `0 9 * * *`). 48h allows one missed night before
  // escalating. A FIX-944 sweep converging over several nights reports
  // status='partial' with sweep_in_progress=true and is NOT alerted on.
  { pipeline: "donor_rollup_refresh", maxAgeHours: 48 },
];
// FIX-289: unify From: address with the rest of the platform (kill-switch
// alerts in apps/civitics/src/lib/email.ts also read RESEND_FROM). Falls back
// to the prior hardcoded address only if the env var isn't set, so behavior
// is unchanged for any deployment still missing the variable.
const ALERTS_FROM        = process.env["RESEND_FROM"] ?? "alerts@civitics.com";
const NIGHTLY_RUN_URL    =
  "https://github.com/civitics-platform/civitics/actions/workflows/nightly.yml";

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function expectedDates(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let offset = days; offset >= 1; offset--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - offset);
    out.push(utcDateString(d));
  }
  return out;
}

interface SyncRow {
  started_at: string | null;
  completed_at: string | null;
}

// FIX-968 — returns null when the query itself fails, NOT an empty set.
//
// This used to `throw`, and the throw propagated out of main() to the top-level
// catch, so a failure here skipped EVERY other detector. On 2026-08-06 07:30
// (GHA run 31081114924) it did exactly that: `data_sync_log query failed:
// canceling statement due to statement timeout` — service_role's 8s cap, blown
// because the box was saturated — and the canary died before reaching the
// autovacuum, rollup, sector-affinity or cron-firing checks. jobid 9 and 11 had
// both been starved that morning and nothing reported it.
//
// That is the FIX-968 failure class turned on the watchman: the canary was
// blindest exactly when the box was most saturated, which is when things are
// actually being starved. Every other detector here is already non-fatal on
// error; these two were the exception.
//
// null (unknown) rather than an empty set is deliberate — an empty set would be
// indistinguishable from "the nightly missed all 7 days" and would fire a
// 7-day-outage alert on what is really a read timeout.
async function fetchActualDates(daysBack: number): Promise<Set<string> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (daysBack + 1));

  // FIX-290: accept status='partial' too. Partial runs (errors > 0) still
  // indicate the nightly ran. The canary's job is "didn't run at all"
  // detection; error-tracking is the dashboard's job (see FIX-287 banner).
  const { data, error } = await db
    .from("data_sync_log")
    .select("started_at, completed_at")
    .eq("pipeline", PIPELINE_NAME)
    .in("status", ["complete", "partial"])
    .gte("started_at", since.toISOString());

  if (error) {
    console.warn(
      `[canary-check] nightly_cron query failed (non-fatal, other detectors still run): ${error.message}`,
    );
    return null;
  }

  const rows = (data ?? []) as SyncRow[];
  const set = new Set<string>();
  for (const row of rows) {
    const ts = row.started_at ?? row.completed_at;
    if (ts) set.add(utcDateString(new Date(ts)));
  }
  return set;
}

// FIX-290: nightly_killed rows are written by .github/workflows/nightly.yml's
// post-step when the workflow runs out of time before runNightlySync reaches
// its own completion-row insert. Surfacing them separately lets the canary
// distinguish "never ran" from "ran but SIGTERM'd."
async function fetchKilledDates(daysBack: number): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (daysBack + 1));

  const { data, error } = await db
    .from("data_sync_log")
    .select("started_at, completed_at")
    .eq("pipeline", KILLED_PIPELINE)
    .gte("started_at", since.toISOString());

  if (error) {
    console.warn(`[canary-check] killed-row query failed (non-fatal): ${error.message}`);
    return new Set();
  }

  const rows = (data ?? []) as SyncRow[];
  const set = new Set<string>();
  for (const row of rows) {
    const ts = row.started_at ?? row.completed_at;
    if (ts) set.add(utcDateString(new Date(ts)));
  }
  return set;
}

// FIX-650 — read-only detector: is any rebuild-toggled table (entity_connections)
// sitting at autovacuum_enabled=false outside an active rebuild? The full rebuild
// pauses autovacuum (FIX-590) and re-enables it on exit (FIX-591), but a SIGKILL
// at the GHA 4h cap skips the finally and the manual 2b recovery path historically
// didn't manage the flag — so on 2026-06-21 entity_connections was stranded at
// autovacuum-off and bloated to ~70% dead tuples (FIX-650). The canary runs at
// 05:00 UTC, never inside the Mon/Wed 08:00 rebuild window, so it's the morning-
// after detector that would have caught this.
//
// FIX-885 — it recurred anyway: the 2026-06-28 GHA run was cancelled at the cap,
// FIX-688 had already moved the schedule to pg_cron (leaving the TS script's
// startup reconcile unreachable), and the in-DB procedure gated every re-enable
// on v_full while both cron jobs pass 'incremental'. The flag sat off for ~4
// weeks. This detector reported it correctly the whole time — the canary just
// exited 0. So this now returns the visibility-map numbers too (the state that
// actually breaks query plans), and main() exits non-zero on either finding.
// FIX-885 — vm[] entry: visibility-map health for a rebuild-toggled table. An
// empty visibility map downgrades every index-only scan to a per-row heap fetch,
// which is what actually breaks queries; the autovacuum flag is only a proxy for
// it. On prod this silently cost FIX-497's covering index its intended plan.
type VmRow = {
  relname: string;
  relallvisible: number;
  relpages: number;
  pct_all_visible: number;
};

// FIX-943 — bloat[] entry: dead-tuple load against the table's OWN computed
// autovacuum trigger. This is the CAUSE side of the vm[] consequence: a table
// under its trigger will not be vacuumed no matter how many dead tuples it
// carries, so the visibility map decays until it crosses. Recorded on every run;
// bloatDegraded is deliberately NOT an escalating signal (see below).
type BloatRow = {
  relname: string;
  n_dead_tup: number;
  vacuum_trigger: number;
  pct_of_trigger: number | null;
};

type AutovacuumStatus = {
  stranded: string[];
  vmDegraded: string[];
  vm: VmRow[];
  bloat: BloatRow[];
  bloatDegraded: string[];
};

const NO_AUTOVACUUM_FINDINGS: AutovacuumStatus = {
  stranded: [], vmDegraded: [], vm: [], bloat: [], bloatDegraded: [],
};

async function fetchStrandedAutovacuum(): Promise<AutovacuumStatus> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("check_rebuild_autovacuum_status");
  if (error) {
    // Non-fatal: belt-and-braces detector. A missing RPC (env not yet migrated)
    // or a transient error must never fail the nightly canary's primary job.
    console.warn(`[canary-check] autovacuum detector query failed (non-fatal): ${error.message}`);
    return NO_AUTOVACUUM_FINDINGS;
  }
  const result = (data ?? {}) as {
    rebuild_active?: boolean;
    stranded?: string[];
    vm_degraded?: string[];
    vm?: VmRow[];
    bloat?: BloatRow[];
    bloat_degraded?: string[];
  };
  const vm = Array.isArray(result.vm) ? result.vm : [];
  // FIX-943 — pre-migration environments return no bloat keys; default to empty
  // so an un-migrated DB reads as "nothing to report" rather than throwing.
  const bloat = Array.isArray(result.bloat) ? result.bloat : [];
  // The RPC already excludes an in-flight rebuild via rebuild_active; this is a
  // second guard in case the shape changes. A rebuild legitimately holds
  // autovacuum off AND churns the visibility map, so neither signal is
  // actionable mid-run — keep vm[]/bloat[] for the meta row, suppress findings.
  if (result.rebuild_active) return { ...NO_AUTOVACUUM_FINDINGS, vm, bloat };
  return {
    stranded:   Array.isArray(result.stranded)    ? result.stranded    : [],
    vmDegraded: Array.isArray(result.vm_degraded) ? result.vm_degraded : [],
    vm,
    bloat,
    bloatDegraded: Array.isArray(result.bloat_degraded) ? result.bloat_degraded : [],
  };
}

// FIX-944 — rollup freshness. `stale` is the escalating condition: the pipeline
// has not reached status='complete' within its window. `sweepInProgress`
// deliberately does NOT alert — it is the FIX-944 resumable path working as
// designed (a large dirty set converging over several nightly windows), and
// treating it as a failure would page on every successful catch-up.
type RollupStatus = {
  pipeline: string;
  maxAgeHours: number;
  /** FIX-977 — two-plus cadence cycles late. Escalates; `stale` alone reports.
   *  NULL when no cadence could be derived: reports, never escalates. */
  escalateAfterHours: number | null;
  cadenceHours: number | null;
  cadenceSource: string | null;
  jobname: string | null;
  stale: boolean;
  escalates: boolean;
  hoursSinceComplete: number | null;
  lastCompleteAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  sweepInProgress: boolean;
};

type RollupWatch = {
  pipeline: string;
  maxAgeHours: number;
  escalateAfterHours: number | null;
  cadenceHours: number | null;
  cadenceSource: string | null;
  jobname: string | null;
};

/**
 * FIX-977 — the DERIVED watch registry.
 *
 * Census, correlation and cadence are all computed in
 * list_scheduled_rollup_pipelines() from cron.job + data_sync_log, so a new
 * scheduled rollup joins the watch list on its first run with no code change
 * here. Falls back to the old literal only when the RPC is absent (an
 * environment not yet migrated), because a canary that hard-fails on a missing
 * detector is worse than one that watches less.
 */
async function fetchRollupRegistry(): Promise<RollupWatch[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("list_scheduled_rollup_pipelines");
  if (error) {
    console.warn(
      `[canary-check] rollup registry query failed (non-fatal, falling back to the ` +
        `${FALLBACK_ROLLUP_PIPELINES.length}-entry literal): ${error.message}`,
    );
    return FALLBACK_ROLLUP_PIPELINES.map((p) => ({
      ...p,
      escalateAfterHours: p.maxAgeHours * 2,
      cadenceHours: null,
      cadenceSource: "fallback_literal",
      jobname: null,
    }));
  }
  const r = (data ?? {}) as {
    available?: boolean;
    pipelines?: {
      pipeline: string;
      jobname?: string | null;
      cadence_hours?: number | null;
      cadence_source?: string | null;
      report_after_hours?: number | null;
      escalate_after_hours?: number | null;
    }[];
  };
  const list = Array.isArray(r.pipelines) ? r.pipelines : [];
  if (list.length === 0) {
    console.warn("[canary-check] rollup registry returned 0 pipelines — falling back to the literal");
    return FALLBACK_ROLLUP_PIPELINES.map((p) => ({
      ...p,
      escalateAfterHours: p.maxAgeHours * 2,
      cadenceHours: null,
      cadenceSource: "fallback_literal",
      jobname: null,
    }));
  }
  return list.map((p) => ({
    pipeline:    p.pipeline,
    maxAgeHours: Number(p.report_after_hours ?? 48),
    // FIX-977b — NULL means "we could not derive a cadence for this pipeline",
    // and a cadence we guessed is not one we may page on. Such a pipeline is
    // still listed and still reports; it just cannot escalate. `null` here, NOT
    // a fallback number — coercing it to a default is what made
    // recipient_count_reconcile escalate at 812h against a 730h monthly job.
    escalateAfterHours: p.escalate_after_hours != null ? Number(p.escalate_after_hours) : null,
    cadenceHours:       p.cadence_hours != null ? Number(p.cadence_hours) : null,
    cadenceSource:      p.cadence_source ?? null,
    jobname:            p.jobname ?? null,
  }));
}

async function fetchRollupFreshness(registry: RollupWatch[]): Promise<RollupStatus[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const out: RollupStatus[] = [];
  for (const { pipeline, maxAgeHours, escalateAfterHours, cadenceHours, cadenceSource, jobname } of registry) {
    const { data, error } = await db.rpc("check_rollup_freshness", {
      p_pipeline: pipeline,
      p_max_age_hours: maxAgeHours,
    });
    if (error) {
      // Non-fatal, same contract as the other detectors: a missing RPC (env not
      // yet migrated) must never fail the canary's primary nightly_cron job.
      console.warn(`[canary-check] rollup freshness query failed for ${pipeline} (non-fatal): ${error.message}`);
      continue;
    }
    const r = (data ?? {}) as {
      stale?: boolean;
      hours_since_complete?: number | null;
      last_complete_at?: string | null;
      last_status?: string | null;
      last_error?: string | null;
      sweep_in_progress?: boolean | null;
    };
    const hours = r.hours_since_complete ?? null;
    out.push({
      pipeline,
      maxAgeHours,
      escalateAfterHours,
      cadenceHours,
      cadenceSource,
      jobname,
      stale:              r.stale === true,
      // FIX-977 + FIX-943 cause-vs-consequence split: one cadence cycle late
      // REPORTS (`stale`), two-plus ESCALATES. Without the split, deriving the
      // registry from the schedule would page on every weekly job that slipped
      // a single firing, and an alert that cries wolf gets muted — which is how
      // a detector stops covering what it enumerates.
      // A pipeline with no derivable cadence (escalateAfterHours === null) can
      // never escalate — see FIX-977b. Otherwise: past two-plus cycles.
      escalates:          escalateAfterHours === null ? false
                          : hours === null ? true
                          : hours > escalateAfterHours,
      hoursSinceComplete: hours,
      lastCompleteAt:     r.last_complete_at ?? null,
      lastStatus:         r.last_status ?? null,
      lastError:          r.last_error ?? null,
      sweepInProgress:    r.sweep_in_progress === true,
    });
  }
  return out;
}

// FIX-959 — sector-affinity tag staleness. The RPC compares the LIVE content
// signature of the financial_entity/industry tag set against the one stored by
// refresh_sector_affinity_from_tag_changes() (FIX-958). A mismatch alone is NOT
// a finding — this canary runs at 05:00 UTC, inside the nightly window, so it
// can legitimately observe tags-written-refresh-pending. The RPC only reports
// stale=true once the STORED signature has sat unchanged across >26h of
// observed mismatch (probe state in pipeline_state), i.e. a whole nightly cycle
// failed to incorporate a tag change — the eleven-day FIX-916 drift shape.
type SectorAffinityStaleness = {
  stale: boolean;
  state: string;
  liveSig: string | null;
  storedSig: string | null;
  hoursOutstanding: number | null;
};

async function fetchSectorAffinityStaleness(): Promise<SectorAffinityStaleness | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("check_sector_affinity_tag_staleness");
  if (error) {
    // Non-fatal, same contract as the other detectors: a missing RPC (env not
    // yet migrated) must never fail the canary's primary nightly_cron job.
    console.warn(`[canary-check] sector-affinity staleness query failed (non-fatal): ${error.message}`);
    return null;
  }
  const r = (data ?? {}) as {
    stale?: boolean;
    state?: string;
    live_sig?: string | null;
    stored_sig?: string | null;
    hours_outstanding?: number | null;
  };
  return {
    stale:            r.stale === true,
    state:            r.state ?? "unknown",
    liveSig:          r.live_sig ?? null,
    storedSig:        r.stored_sig ?? null,
    hoursOutstanding: r.hours_outstanding ?? null,
  };
}

// FIX-968 — pg_cron FIRING health. Every other detector here watches a
// CONSEQUENCE (a rollup is stale, a visibility map collapsed). This is the only
// one that watches whether the scheduled work started at all.
//
// The surfacing case: jobid 24 (donor-rollup-refresh) died at STARTUP on
// 2026-08-03/04/05 — `cron.job_run_details.return_message = 'job startup
// timeout'`, ~10s after firing, body never entered. Because a startup timeout
// writes nothing to data_sync_log, the FIX-944 rollup watcher above could only
// infer it two days later from staleness, and the other 20 jobs had no watcher
// at all (five of them were starved in the same window; jobid 12 has failed 4 of
// 5 runs at the 6h ceiling unnoticed).
//
// Escalation split mirrors FIX-943's cause-vs-consequence rule and is enforced
// in the RPC, not here: startupTimeouts + missingDaily escalate; timeoutBlowouts
// and runs are report-only (seven jobs blow the 6h ceiling, one near-weekly, so
// escalating on it would fail this workflow most Tuesdays and train the alert to
// be ignored).
type CronJobFiring = {
  jobid: number;
  jobname: string | null;
  schedule: string | null;
  start_time?: string;
  seconds?: number;
  message?: string | null;
  status?: string;
};

type CronJobHealth = {
  available: boolean;
  lookbackHours: number;
  startupTimeouts: CronJobFiring[];
  missingDaily: CronJobFiring[];
  timeoutBlowouts: CronJobFiring[];
  runs: CronJobFiring[];
  /** FIX-980 — the canary's own dead-man switch. */
  canaryLiveness: CanaryLiveness | null;
};

type CanaryLiveness = {
  silent: boolean;
  hours_since: number | null;
  last_started_at: string | null;
  threshold_hours: number;
};

async function fetchCronJobHealth(): Promise<CronJobHealth | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("check_cron_job_health");
  if (error) {
    // Non-fatal, same contract as every other detector: a missing RPC (env not
    // yet migrated) must never fail the canary's primary nightly_cron job.
    console.warn(`[canary-check] cron job health query failed (non-fatal): ${error.message}`);
    return null;
  }
  const r = (data ?? {}) as {
    available?: boolean;
    lookback_hours?: number;
    startup_timeouts?: CronJobFiring[];
    missing_daily?: CronJobFiring[];
    timeout_blowouts?: CronJobFiring[];
    runs?: CronJobFiring[];
    canary_liveness?: CanaryLiveness | null;
  };
  const arr = (v: unknown): CronJobFiring[] => (Array.isArray(v) ? v : []);
  return {
    available:       r.available === true,
    lookbackHours:   r.lookback_hours ?? 0,
    startupTimeouts: arr(r.startup_timeouts),
    missingDaily:    arr(r.missing_daily),
    timeoutBlowouts: arr(r.timeout_blowouts),
    runs:            arr(r.runs),
    canaryLiveness:  r.canary_liveness ?? null,
  };
}

function describeFiring(f: CronJobFiring): string {
  return `${f.jobname ?? `jobid ${f.jobid}`}${f.schedule ? ` (${f.schedule})` : ""}`;
}

// FIX-978 — the first RATE detector. Every other detector here answers "is it
// stale?" or "is it in a bad state?"; none answered "is it getting slower?", so
// a throughput regression that still converged inside its freshness window was
// invisible by construction (playbook D4 signature A). The RPC computes cost
// per unit of work from data_sync_log's span + rows_inserted/rows_updated and
// escalates ONLY on a sustained regression — see the migration for the two
// false-positive shapes it is built to survive.
type RateFinding = {
  pipeline: string;
  verdict: string;
  baseline_runs?: number;
  recent_runs?: number;
  baseline_p90_s_per_1k?: number;
  threshold_s_per_1k?: number;
  recent_min_s_per_1k?: number;
  recent_max_s_per_1k?: number;
  worst_case_ratio?: number;
  escalates?: boolean;
};

type RateHealth = {
  available: boolean;
  pipelines: RateFinding[];
  regressions: RateFinding[];
};

async function fetchRateRegression(): Promise<RateHealth | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("check_pipeline_rate_regression");
  if (error) {
    // Non-fatal, same contract as every other detector.
    console.warn(`[canary-check] rate regression query failed (non-fatal): ${error.message}`);
    return null;
  }
  const r = (data ?? {}) as {
    available?: boolean;
    pipelines?: RateFinding[];
    regressions?: RateFinding[];
  };
  const arr = (v: unknown): RateFinding[] => (Array.isArray(v) ? v : []);
  return {
    available:   r.available === true,
    pipelines:   arr(r.pipelines),
    regressions: arr(r.regressions),
  };
}

function describeRate(f: RateFinding): string {
  return (
    `${f.pipeline}: ${f.recent_min_s_per_1k ?? "?"}s/1k rows across its last ` +
    `${f.recent_runs ?? "?"} runs vs a ${f.baseline_p90_s_per_1k ?? "?"}s/1k P90 baseline ` +
    `over ${f.baseline_runs ?? "?"} runs (${f.worst_case_ratio ?? "?"}x, threshold ` +
    `${f.threshold_s_per_1k ?? "?"})`
  );
}

async function writeMetaRow(
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
  rollups: RollupStatus[],
  sectorAffinity: SectorAffinityStaleness | null,
  cronHealth: CronJobHealth | null,
  nightlyUnavailable: boolean,
  startedAt: Date,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  // FIX-979 — TWO timestamps taken around the work, not one value written twice.
  // This row used to carry a single `new Date()` in BOTH columns, so every
  // canary_check row ever written reads completed_at - started_at = 0 and
  // pipeline_runtime_stats_mv renders the run as 0 ms. The canary's detectors
  // are a dozen sequential DB round-trips — that duration is the thing worth
  // watching, since a slow canary is the first symptom of a saturated box
  // (FIX-968, where the canary itself timed out before reaching its findings).
  // startedAt is main()'s entry instant; the completion stamp is taken here.
  const { error } = await db.from("data_sync_log").insert({
    pipeline:     "canary_check",
    status:       "complete",
    started_at:   startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    metadata: {
      pipeline_checked: PIPELINE_NAME,
      checked_days:     CHECK_DAYS,
      // FIX-968 — true means the nightly_cron read failed, so missing_* below
      // are "unknown" rather than "none". Without this a read timeout and a
      // clean night are the same two zeros in data_sync_log.
      nightly_check_unavailable: nightlyUnavailable,
      missing_count:    missing.length,
      missing_dates:    missing,
      killed_count:     killed.length,
      killed_dates:     killed,
      // FIX-650 — rebuild-toggled tables stranded at autovacuum_enabled=false.
      stranded_autovacuum: autovacuum.stranded,
      // FIX-885 — visibility-map health. vm[] is recorded on EVERY run (not just
      // findings) so the trend is greppable in data_sync_log after the fact —
      // FIX-884 went unnoticed for ~4 weeks partly because nothing logged it.
      vm_degraded:      autovacuum.vmDegraded,
      visibility_map:   autovacuum.vm,
      // FIX-943 — the CAUSE side, recorded on EVERY run for the same reason.
      // REPORT-ONLY: bloat_degraded does NOT escalate. A table can sit under its
      // trigger with tens of thousands of dead tuples and no harm done; what is
      // actionable is the visibility map that eventually collapses as a result,
      // and vm_degraded already escalates on that. This exists so the cause is
      // greppable in data_sync_log BEFORE the consequence arrives.
      bloat_degraded:   autovacuum.bloatDegraded,
      dead_tuple_load:  autovacuum.bloat,
      // FIX-944 — recorded on EVERY run, findings or not, so the convergence of
      // a multi-night resumable sweep is greppable after the fact.
      rollup_freshness: rollups,
      // FIX-959 — recorded on EVERY run for the same reason: the signature
      // trail makes a strand's onset findable after the fact.
      sector_affinity_staleness: sectorAffinity,
      // FIX-968 — recorded on EVERY run, findings or not, for the same reason as
      // vm[]/bloat[] above: three days of "the job never fired" were invisible
      // partly because nothing had ever read cron.job_run_details. The full
      // window trail makes a firing regression's onset findable after the fact.
      cron_job_health:  cronHealth,
      peak_rss_mb:      captureRssMb(),
    },
  });
  if (error) {
    // FIX-980 — the OTHER half of "nothing watches the watchman". This used to
    // console.warn() and move on, so an insert that failed under the same 8s
    // service_role cap that killed the 2026-08-06 run left NO row and NO
    // signal: the canary's silence became indistinguishable from its health.
    // The meta row IS the evidence this process ran, so failing to write it is
    // a hard failure — the caller exits non-zero and GHA marks the run red,
    // which is the one surface outside this process that can see the gap.
    console.error(`[canary-check] meta-row insert FAILED: ${error.message}`);
    return false;
  }
  return true;
}

async function sendAlert(
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
  staleRollups: RollupStatus[],
  sectorAffinity: SectorAffinityStaleness | null,
  cronHealth: CronJobHealth | null,
  to: string,
  apiKey: string,
): Promise<void> {
  const strandedAutovacuum = autovacuum.stranded;
  // Lazy import keeps the script no-op-safe when Resend isn't installed for
  // some reason — prevents a hard module-resolution failure at startup.
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  // FIX-290: distinguish "didn't run at all" from "ran but got SIGTERM'd."
  // Killed-only is a softer signal — the workflow started and the post-step
  // wrote a synthetic row, so the runner + GHA scheduling are healthy.
  // FIX-650: a third, independent signal — a rebuild-toggled table stranded at
  // autovacuum-off. Build the subject additively across whichever signals fired.
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missed ${missing.length} day(s)`);
  if (killed.length > 0) parts.push(`killed ${killed.length} day(s)`);
  if (strandedAutovacuum.length > 0) parts.push(`autovacuum stranded off on ${strandedAutovacuum.join(", ")}`);
  // FIX-885 — the visibility map can collapse even with the flag correctly ON
  // (e.g. a long gap between vacuums), and that is the state that actually
  // degrades query plans, so it gets its own subject fragment.
  if (autovacuum.vmDegraded.length > 0) parts.push(`visibility map collapsed on ${autovacuum.vmDegraded.join(", ")}`);
  // FIX-944 — a rollup that never reaches 'complete' is its own signal.
  if (staleRollups.length > 0) parts.push(`stale rollup: ${staleRollups.map((r) => r.pipeline).join(", ")}`);
  // FIX-959 — a donor tag change stranded un-incorporated in the affinity rollup.
  if (sectorAffinity?.stale) parts.push(`sector-affinity rollup stranded on a tag change`);
  // FIX-968 — a pg_cron firing that never started. Distinct from every other
  // fragment here: those say "the data is wrong", this says "the work never ran".
  const skipped = [...(cronHealth?.startupTimeouts ?? []), ...(cronHealth?.missingDaily ?? [])];
  if (skipped.length > 0) {
    parts.push(`pg_cron job(s) never started: ${[...new Set(skipped.map((f) => f.jobname ?? `jobid ${f.jobid}`))].join(", ")}`);
  }
  const subject = `[Civitics] Nightly canary — ${parts.join("; ")}`;

  const sections: string[] = [];
  if (missing.length > 0) {
    sections.push(
      `Missing entirely (no row in data_sync_log) — likely never ran or died ` +
        `before its post-step:\n` +
        missing.map((d) => `  - ${d}`).join("\n"),
    );
  }
  if (killed.length > 0) {
    sections.push(
      `Killed by workflow timeout (synthetic nightly_killed row present) — ` +
        `the workflow ran but exceeded timeout-minutes before reaching the ` +
        `completion-row write in runNightlySync:\n` +
        killed.map((d) => `  - ${d}`).join("\n"),
    );
  }
  if (strandedAutovacuum.length > 0) {
    sections.push(
      `Autovacuum stranded OFF (FIX-650) — the full entity_connections rebuild ` +
        `pauses autovacuum and re-enables it on exit, but a SIGKILL at the GHA ` +
        `cap (or a recovery path that didn't manage the flag) left it disabled. ` +
        `Dead tuples accumulate unbounded until re-enabled:\n` +
        strandedAutovacuum.map((t) => `  - ${t}`).join("\n") +
        `\n\nRemediate at low traffic: ALTER TABLE public.<table> SET ` +
        `(autovacuum_enabled = true); VACUUM (ANALYZE) public.<table>;`,
    );
  }
  if (autovacuum.vmDegraded.length > 0) {
    const byName = new Map(autovacuum.vm.map((v) => [v.relname, v]));
    sections.push(
      `Visibility map collapsed (FIX-885) — under 50% of pages are all-visible, ` +
        `so every "Index Only Scan" on these tables degrades to a per-row heap ` +
        `fetch and any covering index silently stops being one. On prod this ` +
        `cost FIX-497's index its intended plan (34,534 heap fetches for 34,552 ` +
        `rows, 20.5s of a 22.1s query) with no other symptom:\n` +
        autovacuum.vmDegraded
          .map((t) => {
            const v = byName.get(t);
            return v
              ? `  - ${t}: ${v.pct_all_visible}% all-visible (${v.relallvisible}/${v.relpages} pages)`
              : `  - ${t}`;
          })
          .join("\n") +
        `\n\nRemediate at low traffic: VACUUM (ANALYZE) public.<table>;`,
    );
  }
  if (staleRollups.length > 0) {
    sections.push(
      `Rollup never reached 'complete' (FIX-944) — the pipeline below has not ` +
        `logged a successful run inside its window. On 2026-07-27..30 ` +
        `donor_rollup_refresh failed four nights running and nobody noticed, ` +
        `because the canary only watched nightly_cron and every failure row ` +
        `read as ordinary noise. Its six per-official money rollups ` +
        `(official_donor_rollup_mv, official_donor_totals, ` +
        `official_small_dollar_rollup, official_sector_affinity_rollup, ` +
        `treemap_individuals_rollup, official_donor_bracket_totals) go stale ` +
        `together, and that is what officials' pages, the treemap, the chord ` +
        `and sector-affinity all render:\n` +
        staleRollups
          .map(
            (r) =>
              `  - ${r.pipeline}: last complete ${r.lastCompleteAt ?? "NEVER"}` +
              (r.hoursSinceComplete !== null ? ` (${r.hoursSinceComplete}h ago` : " (") +
              `, window ${r.maxAgeHours}h), last status=${r.lastStatus ?? "-"}` +
              (r.sweepInProgress ? " [resumable sweep in flight]" : "") +
              (r.lastError ? `\n      last error: ${r.lastError}` : ""),
          )
          .join("\n") +
        `\n\nTriage: check cron.job_run_details for the true end_time — a ` +
        `'reaped' data_sync_log row's started_at..reaped_at gap is an upper ` +
        `bound, NOT a runtime. Single-pass catch-up: ` +
        `pnpm --filter @civitics/data data:donor-rollup:sweep:prod`,
    );
  }
  if (sectorAffinity?.stale) {
    sections.push(
      `Sector-affinity rollup stranded on a tag change (FIX-959) — the donor ` +
        `industry-tag content signature changed and ` +
        `refresh_sector_affinity_from_tag_changes() has not incorporated it for ` +
        `${sectorAffinity.hoursOutstanding ?? "?"}h (>1 nightly cycle). The ` +
        `FIX-897 official industry pills are rendering pre-change sectors — the ` +
        `eleven-day FIX-916 drift shape, caught early this time:\n` +
        `  - live sig:   ${sectorAffinity.liveSig ?? "-"}\n` +
        `  - stored sig: ${sectorAffinity.storedSig ?? "-"}\n` +
        `\nTriage: check data_sync_log pipeline='sector_affinity_tag_refresh' ` +
        `for the failing/missing run, then re-run the nightly tagger or CALL ` +
        `public.refresh_sector_affinity_from_tag_changes() directly (off-peak).`,
    );
  }
  if (skipped.length > 0) {
    sections.push(
      `pg_cron job(s) never STARTED (FIX-968) — this is not "the job failed", ` +
        `it is "the firing was abandoned before the body ran", so nothing was ` +
        `written to data_sync_log and no self-heal fired:\n` +
        (cronHealth?.startupTimeouts ?? [])
          .map((f) => `  - startup timeout: ${describeFiring(f)} at ${f.start_time ?? "?"} after ${f.seconds ?? "?"}s`)
          .join("\n") +
        ((cronHealth?.missingDaily ?? []).length > 0
          ? "\n" +
            (cronHealth?.missingDaily ?? [])
              .map((f) => `  - no run row at all in the last ${cronHealth?.lookbackHours ?? "?"}h: ${describeFiring(f)}`)
              .join("\n")
          : "") +
        `\n\nCause on this instance: cron.use_background_workers=off, so pg_cron ` +
        `opens a fresh libpq connection per firing with a ~10s window. Under ` +
        `sustained load on Pro Small that window is blown and the firing is ` +
        `dropped silently — no queue, no retry.\n` +
        `Triage: SELECT * FROM cron.job_run_details ORDER BY start_time DESC; ` +
        `then look for what was saturating the box at that minute (a job burning ` +
        `the 6h statement_timeout, or an overnight GHA fec_bulk retry).` +
        ((cronHealth?.timeoutBlowouts ?? []).length > 0
          ? `\n\nAlso in this window (report-only, not escalating): ` +
            (cronHealth?.timeoutBlowouts ?? [])
              .map((f) => `${describeFiring(f)} ran ${f.seconds ?? "?"}s into the 6h statement_timeout`)
              .join("; ")
          : ""),
    );
  }
  const body = sections.join("\n\n") + `\n\nWorkflow runs: ${NIGHTLY_RUN_URL}\n`;

  const { error } = await resend.emails.send({
    from:    ALERTS_FROM,
    to:      [to],
    subject,
    text:    body,
  });
  if (error) throw new Error(`Resend send failed: ${error.message ?? String(error)}`);
}

async function main(): Promise<number> {
  const now      = new Date();
  const expected = expectedDates(now, CHECK_DAYS);
  const actual   = await fetchActualDates(CHECK_DAYS);
  const killedSet = await fetchKilledDates(CHECK_DAYS);
  // FIX-650 — point-in-time check (not a 7-day window): is a rebuild-toggled
  // table stranded at autovacuum-off right now, outside an active rebuild?
  // FIX-885 — also carries visibility-map health.
  const autovacuum = await fetchStrandedAutovacuum();
  const strandedAutovacuum = autovacuum.stranded;
  // FIX-944 — point-in-time too: has each watched rollup reached 'complete'
  // inside its window?
  // FIX-977 — the watch list is derived from the schedule, not hand-listed.
  const registry = await fetchRollupRegistry();
  console.log(
    `[canary-check] rollup registry: ${registry.length} scheduled pipeline(s) ` +
      `(was a hand-maintained literal of ${FALLBACK_ROLLUP_PIPELINES.length})`,
  );
  const rollups = await fetchRollupFreshness(registry);
  const staleRollups = rollups.filter((r) => r.stale);
  // One cadence cycle late reports; two-plus escalates.
  const escalatingRollups = rollups.filter((r) => r.escalates);
  // FIX-978 — is anything getting SLOWER while still landing inside its window?
  const rateHealth = await fetchRateRegression();
  const rateRegressions = rateHealth?.regressions ?? [];
  // FIX-959 — point-in-time: is a donor industry-tag change stranded
  // un-incorporated in official_sector_affinity_rollup past one nightly cycle?
  const sectorAffinity = await fetchSectorAffinityStaleness();
  // FIX-968 — did every scheduled pg_cron job actually START? The only detector
  // here that watches the cause rather than a consequence.
  const cronHealth = await fetchCronJobHealth();
  const skippedFirings = [
    ...(cronHealth?.startupTimeouts ?? []),
    ...(cronHealth?.missingDaily ?? []),
  ];
  // FIX-968 — when the nightly_cron read itself failed we know NOTHING about
  // missing/killed, so report neither rather than inventing a 7-day outage.
  // The remaining detectors are unaffected and still run, which is the whole
  // point of the change.
  const nightlyCheckUnavailable = actual === null;
  // "missing" = no nightly_cron row AND no nightly_killed row for that date.
  // "killed" = no nightly_cron row but a nightly_killed synthetic row exists.
  const missing  = nightlyCheckUnavailable ? [] : expected.filter((d) => !actual!.has(d) && !killedSet.has(d));
  const killed   = nightlyCheckUnavailable ? [] : expected.filter((d) => !actual!.has(d) &&  killedSet.has(d));

  let alertSent = false;
  const adminEmail = process.env["ADMIN_EMAIL"];
  const resendKey  = process.env["RESEND_API_KEY"];
  const inCi       = process.env["GITHUB_ACTIONS"] === "true";
  const sendReal   = process.argv.includes("--send-real");
  const hasAlert   = missing.length > 0 || killed.length > 0
                  || strandedAutovacuum.length > 0 || autovacuum.vmDegraded.length > 0
                  || staleRollups.length > 0 || sectorAffinity?.stale === true
                  || skippedFirings.length > 0;
  if (hasAlert && adminEmail && resendKey) {
    if (inCi || sendReal) {
      await sendAlert(missing, killed, autovacuum, staleRollups, sectorAffinity, cronHealth, adminEmail, resendKey);
      alertSent = true;
    } else {
      console.log(
        "[canary-check] local run — skipping Resend send; pass --send-real to actually email"
      );
    }
  }

  // FIX-979 — `now` is main()'s entry instant, captured before the first
  // detector ran; writeMetaRow stamps completed_at itself.
  const metaRowWritten = await writeMetaRow(missing, killed, autovacuum, rollups, sectorAffinity, cronHealth, nightlyCheckUnavailable, now);

  // FIX-885 — ESCALATE. The DB-health findings exit non-zero so the workflow run
  // goes red; an email alone is not escalation. FIX-650 built the detector and it
  // WAS correctly reporting stranded:[entity_connections] for ~4 weeks — the
  // canary just exited 0 every morning, so nothing surfaced until FIX-883 tripped
  // over the consequences (FIX-884). Detection worked; escalation did not.
  //
  // Deliberately scoped to the autovacuum/visibility-map findings. missing/killed
  // keep their existing email-only behaviour: they are backward-looking signals
  // about a pipeline that may already have self-corrected, and turning them red
  // here would change an unrelated contract. These two are point-in-time facts
  // about the CURRENT state of prod that stay broken until someone acts.
  const failures: string[] = [];
  if (strandedAutovacuum.length > 0) {
    failures.push(`autovacuum stranded OFF on: ${strandedAutovacuum.join(", ")}`);
  }
  if (autovacuum.vmDegraded.length > 0) {
    const byName = new Map(autovacuum.vm.map((v) => [v.relname, v]));
    failures.push(
      `visibility map collapsed on: ${autovacuum.vmDegraded
        .map((t) => {
          const v = byName.get(t);
          return v ? `${t} (${v.pct_all_visible}% all-visible)` : t;
        })
        .join(", ")}`,
    );
  }
  // FIX-944 — escalate for the same reason as the two above: this is a
  // point-in-time fact about prod that stays broken until someone acts. Four
  // days of total donor-rollup failure produced no signal at all under the
  // email-only contract.
  //
  // FIX-977 narrowed this from `staleRollups` to `escalatingRollups`. Deriving
  // the registry took the watch list from 1 pipeline to 13, and escalating on
  // one-cycle staleness across all 13 would fail the canary most Tuesdays — an
  // alert that cries wolf gets muted, which is how a detector quietly stops
  // covering what it enumerates. One cycle late is reported below; two-plus
  // still escalates here, which is what the four-day donor-rollup outage was.
  if (escalatingRollups.length > 0) {
    failures.push(
      `rollup never reached 'complete': ${escalatingRollups
        .map(
          (r) =>
            `${r.pipeline} (${r.hoursSinceComplete ?? "?"}h ago, cadence ` +
            `${r.cadenceHours ?? "?"}h, escalate past ${r.escalateAfterHours}h)`,
        )
        .join(", ")}`,
    );
  }
  // REPORT-ONLY: one cadence cycle late. Kept greppable so a slipping job is
  // visible before it becomes an escalation.
  const reportOnlyStale = staleRollups.filter((r) => !r.escalates);
  if (reportOnlyStale.length > 0) {
    console.log(
      `[canary-check] rollups one cycle late (report-only): ${reportOnlyStale
        .map((r) => `${r.pipeline} (${r.hoursSinceComplete ?? "?"}h, cadence ${r.cadenceHours ?? "?"}h)`)
        .join(", ")}`,
    );
  }
  // FIX-980 — the watchman's dead-man switch. `canary_check` is a GHA workflow,
  // so check_cron_job_health() cannot see it in cron.job_run_details and no
  // other workflow asserts on it. It emitted ZERO rows on 2026-08-06 — the day
  // with the most incidents in the retained window — after 19 consecutive daily
  // rows, and nothing noticed. Six of the seven scheduled detectors run only
  // inside this process, so its silence takes them all dark at once.
  if (cronHealth?.canaryLiveness?.silent) {
    const cl = cronHealth.canaryLiveness;
    failures.push(
      `canary_check itself went silent: last run ${cl.hours_since ?? "?"}h ago ` +
        `(${cl.last_started_at ?? "never"}), threshold ${cl.threshold_hours}h`,
    );
  }
  if (!metaRowWritten) {
    failures.push(
      "canary_check meta-row insert failed — this run left no evidence it ran, " +
        "which is the silence FIX-980 exists to make visible",
    );
  }
  // FIX-978 — a SUSTAINED rate regression escalates: every one of the last N
  // runs above the P90 baseline x factor, with enough history to mean it. An
  // intermittent or single-run dip is report-only (the bimodal guard), per the
  // FIX-943 cause-vs-consequence split.
  if (rateRegressions.length > 0) {
    failures.push(
      `pipeline throughput regressed (sustained): ${rateRegressions.map(describeRate).join("; ")}`,
    );
  }
  const rateWatch = (rateHealth?.pipelines ?? []).filter((p) => p.verdict === "intermittent");
  if (rateWatch.length > 0) {
    console.log(
      `[canary-check] intermittent rate outliers (report-only, not a trend): ` +
        `${rateWatch.map(describeRate).join("; ")}`,
    );
  }
  // FIX-959 — escalate for the same reason: a stranded tag change is a
  // point-in-time fact about prod that stays broken (stale pills, no error)
  // until someone acts. The 2026-07 instance sat unnoticed for eleven days.
  if (sectorAffinity?.stale) {
    failures.push(
      `sector-affinity rollup stranded on a tag change ` +
        `(${sectorAffinity.hoursOutstanding ?? "?"}h outstanding; ` +
        `live=${sectorAffinity.liveSig ?? "-"} stored=${sectorAffinity.storedSig ?? "-"})`,
    );
  }

  // FIX-968 — escalate for the same reason as the four above, and arguably
  // harder: a skipped firing means the work provably did not happen, and pg_cron
  // has no queue or retry, so it stays not-happened until the next firing. This
  // is the detector that would have caught jobid 24 on the MORNING of 08-03
  // instead of two days later via downstream staleness.
  if (skippedFirings.length > 0) {
    failures.push(
      `pg_cron firing(s) never started: ${skippedFirings.map(describeFiring).join(", ")}`,
    );
  }

  console.log(
    JSON.stringify({
      checked_days:        CHECK_DAYS,
      missing_dates:       missing,
      killed_dates:        killed,
      stranded_autovacuum: strandedAutovacuum,
      vm_degraded:         autovacuum.vmDegraded,
      visibility_map:      autovacuum.vm,
      // FIX-943 — report-only; absent from `failures` by design (see the meta
      // row above). Surfaced here so a workflow log shows the cause alongside
      // the consequence when someone is already looking.
      bloat_degraded:      autovacuum.bloatDegraded,
      dead_tuple_load:     autovacuum.bloat,
      rollup_freshness:    rollups,
      stale_rollups:       staleRollups.map((r) => r.pipeline),
      // FIX-977 — how many pipelines the derived registry actually covers, so a
      // silent narrowing (the exact defect this replaced) is visible in the log.
      rollup_registry_size:   registry.length,
      escalating_rollups:     escalatingRollups.map((r) => r.pipeline),
      // FIX-978 — the first rate signal on this box.
      rate_regressions:       rateRegressions.map(describeRate),
      rate_intermittent:      rateWatch.map((p) => p.pipeline),
      sector_affinity_staleness: sectorAffinity,
      // FIX-968 — startup_timeouts/missing_daily escalate; timeout_blowouts is
      // report-only (see the RPC comment), surfaced here so the cause shows up
      // in the workflow log alongside the consequence.
      // FIX-968 — the nightly_cron read failed; missing/killed above are
      // "unknown", not "clean". Surfaced so a quiet run cannot be misread.
      nightly_check_unavailable: nightlyCheckUnavailable,
      cron_startup_timeouts: (cronHealth?.startupTimeouts ?? []).map(describeFiring),
      cron_missing_daily:    (cronHealth?.missingDaily ?? []).map(describeFiring),
      cron_timeout_blowouts: (cronHealth?.timeoutBlowouts ?? []).map(describeFiring),
      alert_sent:          alertSent,
      escalated:           failures.length > 0,
    })
  );

  if (failures.length > 0) {
    console.error(`[canary-check] ESCALATING — ${failures.join("; ")}`);
    return 1;
  }
  return 0;
}

main()
  // FIX-885 — propagate main's exit code instead of hardcoding 0, so a stranded
  // autovacuum flag or a collapsed visibility map turns the workflow run red.
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      "[canary-check] failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  });
