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
import {
  type AlertTier,
  type Condition,
  type Transition,
  classifyTransitions,
  decideAlert,
  describeTransitions,
  withUnchangedRuns,
} from "./canary-transitions";

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
  /** FIX-1135 — NULL when the pipeline is retired, held, or has never reached
   *  'complete' in the lookback, i.e. staleness is not defined for it. */
  reportAfterHours: number | null;
  cadenceHours: number | null;
  cadenceSource: string | null;
  cadenceSupport: number | null;
  jobname: string | null;
  /** FIX-1011 — 'pg_cron' | 'github_actions' | 'unknown'. */
  driver: string | null;
  /** FIX-1059 — the correlated cron job's active flag; null when uncorrelated. */
  hasActiveJob: boolean | null;
  retired: boolean;
  held: boolean;
  holdReason: string | null;
  orphan: boolean;
  hasClosures: boolean;
  /** The RPC's raw answer against maxAgeHours. */
  stale: boolean;
  /** FIX-1135 — the GATED verdict: stale AND staleness means something here. */
  reports: boolean;
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
  reportAfterHours: number | null;
  cadenceHours: number | null;
  cadenceSource: string | null;
  cadenceSupport: number | null;
  jobname: string | null;
  driver: string | null;
  hasActiveJob: boolean | null;
  retired: boolean;
  held: boolean;
  holdReason: string | null;
  orphan: boolean;
  hasClosures: boolean;
};

/** FIX-1059 — a pg_cron-driven pipeline with rows but no ACTIVE job and no
 *  declaration in rollup_watch_overrides. Reported, never escalated. */
type RollupOrphan = {
  pipeline: string;
  jobid: number | null;
  jobname: string | null;
  schedule: string | null;
  last_row_at: string | null;
};

type RollupRegistry = { watches: RollupWatch[]; orphans: RollupOrphan[] };

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
function fallbackRegistry(): RollupRegistry {
  return {
    watches: FALLBACK_ROLLUP_PIPELINES.map((p) => ({
      ...p,
      escalateAfterHours: p.maxAgeHours * 2,
      reportAfterHours: p.maxAgeHours,
      cadenceHours: null,
      cadenceSource: "fallback_literal",
      cadenceSupport: null,
      jobname: null,
      driver: null,
      hasActiveJob: null,
      retired: false,
      held: false,
      holdReason: null,
      orphan: false,
      hasClosures: true,
    })),
    orphans: [],
  };
}

async function fetchRollupRegistry(): Promise<RollupRegistry> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db.rpc("list_scheduled_rollup_pipelines");
  if (error) {
    console.warn(
      `[canary-check] rollup registry query failed (non-fatal, falling back to the ` +
        `${FALLBACK_ROLLUP_PIPELINES.length}-entry literal): ${error.message}`,
    );
    return fallbackRegistry();
  }
  const r = (data ?? {}) as {
    available?: boolean;
    pipelines?: {
      pipeline: string;
      jobname?: string | null;
      driver?: string | null;
      has_active_job?: boolean | null;
      orphan?: boolean | null;
      retired?: boolean | null;
      held?: boolean | null;
      hold_reason?: string | null;
      has_closures?: boolean | null;
      cadence_hours?: number | null;
      cadence_source?: string | null;
      cadence_support?: number | null;
      report_after_hours?: number | null;
      escalate_after_hours?: number | null;
    }[];
    orphans?: RollupOrphan[];
  };
  const list = Array.isArray(r.pipelines) ? r.pipelines : [];
  if (list.length === 0) {
    console.warn("[canary-check] rollup registry returned 0 pipelines — falling back to the literal");
    return fallbackRegistry();
  }
  return {
    watches: list.map((p) => ({
      pipeline: p.pipeline,
      // FIX-1135 — report_after_hours is NULL for a retired/held pipeline and
      // for one with no closure in the lookback (nothing to be stale relative
      // to). The RPC still needs a number, so pass a nominal one and gate the
      // VERDICT on reportAfterHours below instead of on the RPC's raw answer.
      //
      // ROUNDED, and it has to be: check_rollup_freshness takes
      // `p_max_age_hours int`, and an observed median now yields fractional
      // cadences (163.88h -> a 245.8h report threshold) where every pre-FIX-1135
      // cadence was a whole number of hours off a cron schedule. Passing the raw
      // value made PostgREST reject the call with `invalid input syntax for type
      // integer: "245.8"` — 20 of 49 pipelines silently un-checked, which is the
      // narrowing this whole registry exists to prevent. The unrounded value is
      // kept in reportAfterHours for the verdict and the email.
      maxAgeHours: Math.max(1, Math.round(Number(p.report_after_hours ?? 48))),
      reportAfterHours: p.report_after_hours != null ? Number(p.report_after_hours) : null,
      // FIX-977b — NULL means "we could not derive a cadence for this pipeline",
      // and a cadence we guessed is not one we may page on. Such a pipeline is
      // still listed and still reports; it just cannot escalate. `null` here, NOT
      // a fallback number — coercing it to a default is what made
      // recipient_count_reconcile escalate at 812h against a 730h monthly job.
      escalateAfterHours: p.escalate_after_hours != null ? Number(p.escalate_after_hours) : null,
      cadenceHours: p.cadence_hours != null ? Number(p.cadence_hours) : null,
      cadenceSource: p.cadence_source ?? null,
      cadenceSupport: p.cadence_support != null ? Number(p.cadence_support) : null,
      jobname: p.jobname ?? null,
      driver: p.driver ?? null,
      hasActiveJob: p.has_active_job ?? null,
      retired: p.retired === true,
      held: p.held === true,
      holdReason: p.hold_reason ?? null,
      orphan: p.orphan === true,
      // Pre-migration environments have no such key; treat as "has closures"
      // so behaviour is unchanged rather than silently muted.
      hasClosures: p.has_closures !== false,
    })),
    orphans: Array.isArray(r.orphans) ? r.orphans : [],
  };
}

async function fetchRollupFreshness(registry: RollupWatch[]): Promise<RollupStatus[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const out: RollupStatus[] = [];
  for (const w of registry) {
    const { pipeline, maxAgeHours, escalateAfterHours, cadenceHours, cadenceSource, jobname } = w;
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
    const stale = r.stale === true;
    // FIX-1135/1059 — staleness is only MEANINGFUL where a report threshold
    // exists. It does not for a retired pipeline (recipient_count_reconcile,
    // declared in rollup_watch_overrides), a held one, or one that has never
    // reached 'complete' in the lookback (nightly_killed, edgar_daily,
    // nightly-sync — none of them ever write a closure row). Those stay LISTED
    // in rollup_freshness for the trail; they just do not generate a finding.
    const reports = stale && w.reportAfterHours !== null && !w.retired && !w.held;
    out.push({
      pipeline,
      maxAgeHours,
      escalateAfterHours,
      reportAfterHours:   w.reportAfterHours,
      cadenceHours,
      cadenceSource,
      cadenceSupport:     w.cadenceSupport,
      jobname,
      driver:             w.driver,
      hasActiveJob:       w.hasActiveJob,
      retired:            w.retired,
      held:               w.held,
      holdReason:         w.holdReason,
      orphan:             w.orphan,
      hasClosures:        w.hasClosures,
      stale,
      reports,
      // FIX-977 + FIX-943 cause-vs-consequence split: one cadence cycle late
      // REPORTS (`stale`), two-plus ESCALATES. Without the split, deriving the
      // registry from the schedule would page on every weekly job that slipped
      // a single firing, and an alert that cries wolf gets muted — which is how
      // a detector stops covering what it enumerates.
      // A pipeline with no derivable cadence (escalateAfterHours === null) can
      // never escalate — see FIX-977b. FIX-1135/1059 widen that NULL to cover
      // an observed median with under 4 supporting gaps, a driver that has not
      // closed a cycle yet (fe-crawl), and the orphan class. Otherwise: past
      // two-plus cycles.
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

/** FIX-1073 — a job whose OWN run history shows N-or-more consecutive
 *  startup timeouts. `span_minutes` separates 96 minutes of an every-2-minutes watchdog
 *  from three days of a twice-daily rollup, which the count alone cannot. */
type StartupStreak = {
  jobid: number;
  jobname: string | null;
  schedule: string | null;
  streak: number;
  first_at: string;
  last_at: string;
  span_minutes: number;
};

/** FIX-1073 — a 60-minute bucket with M-or-more startup timeouts across ALL
 *  jobs: the short, broad connection-accept collapse no single job stretches
 *  into a streak. */
type StartupBurst = {
  bucket: string;
  count: number;
  jobs_affected: number;
  jobs: string | null;
};

type StartupTimeoutTiers = {
  streakThreshold: number;
  burstThreshold: number;
  perJob: StartupStreak[];
  burst: StartupBurst[];
};

type CronJobHealth = {
  available: boolean;
  lookbackHours: number;
  startupTimeouts: CronJobFiring[];
  /** FIX-1073 — what actually escalates now; startupTimeouts is report-only. */
  startupTimeoutTiers: StartupTimeoutTiers | null;
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
    startup_timeout_tiers?: {
      streak_threshold?: number;
      burst_threshold?: number;
      per_job?: StartupStreak[];
      burst?: StartupBurst[];
    } | null;
    missing_daily?: CronJobFiring[];
    timeout_blowouts?: CronJobFiring[];
    runs?: CronJobFiring[];
    canary_liveness?: CanaryLiveness | null;
  };
  const arr = (v: unknown): CronJobFiring[] => (Array.isArray(v) ? v : []);
  // FIX-1073 — a pre-migration environment returns no tier key. `null` (not an
  // empty tier set) so main() can tell "no tiers computed" from "tiers computed
  // and clean", and fall back to the old any-startup-timeout rule rather than
  // silently escalating on nothing.
  const t = r.startup_timeout_tiers;
  const tiers: StartupTimeoutTiers | null = t
    ? {
        streakThreshold: Number(t.streak_threshold ?? 0),
        burstThreshold:  Number(t.burst_threshold ?? 0),
        perJob: Array.isArray(t.per_job) ? t.per_job : [],
        burst:  Array.isArray(t.burst)   ? t.burst   : [],
      }
    : null;
  return {
    available:           r.available === true,
    lookbackHours:       r.lookback_hours ?? 0,
    startupTimeouts:     arr(r.startup_timeouts),
    startupTimeoutTiers: tiers,
    missingDaily:        arr(r.missing_daily),
    timeoutBlowouts:     arr(r.timeout_blowouts),
    runs:                arr(r.runs),
    canaryLiveness:      r.canary_liveness ?? null,
  };
}

function describeStreak(s: StartupStreak): string {
  return (
    `${s.jobname ?? `jobid ${s.jobid}`}${s.schedule ? ` (${s.schedule})` : ""}: ` +
    `${s.streak} consecutive startup timeouts over ${s.span_minutes} min, ` +
    `last ${s.last_at}`
  );
}

function describeBurst(b: StartupBurst): string {
  return `${b.bucket}: ${b.count} startup timeouts across ${b.jobs_affected} job(s) — ${b.jobs ?? "?"}`;
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

function buildMetadata(
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
  rollups: RollupStatus[],
  orphans: RollupOrphan[],
  sectorAffinity: SectorAffinityStaleness | null,
  cronHealth: CronJobHealth | null,
  nightlyUnavailable: boolean,
  conditions: Condition[],
  failures: string[],
  reportOnly: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
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
    // FIX-1036 — the verdict itself, not just its inputs. These four keys are
    // what the old meta row could not answer: they existed only in the stdout
    // JSON, so data_sync_log recorded what the canary SAW and never what it
    // CONCLUDED, and no run could compare itself against the one before it.
    escalating_rollups: rollups.filter((r) => r.escalates).map((r) => r.pipeline),
    escalated:          failures.length > 0,
    failures,
    report_only:        reportOnly,
    // FIX-1036 — the keyed conditions this run observed. THIS is what the next
    // run reads to decide new / worsening / unchanged / recovered.
    conditions,
    // FIX-1059 — pg_cron-driven pipelines with rows but no active job and no
    // declaration. Recorded on every run; reported, never escalated.
    orphans,
    // FIX-959 — recorded on EVERY run for the same reason: the signature
    // trail makes a strand's onset findable after the fact.
    sector_affinity_staleness: sectorAffinity,
    // FIX-968 — recorded on EVERY run, findings or not, for the same reason as
    // vm[]/bloat[] above: three days of "the job never fired" were invisible
    // partly because nothing had ever read cron.job_run_details. The full
    // window trail makes a firing regression's onset findable after the fact.
    cron_job_health:  cronHealth,
    // FIX-1073 — hoisted out of cron_job_health so the tier verdict is greppable
    // without parsing the whole window trail. Re-keyed to snake_case on the way
    // out: every other key in this row is snake_case, and the TS-shaped object
    // would have made `metadata->'startup_timeout_tiers'->>'streak_threshold'`
    // return NULL forever — a grep that silently finds nothing is worse than one
    // that errors.
    startup_timeout_tiers: cronHealth?.startupTimeoutTiers
      ? {
          streak_threshold: cronHealth.startupTimeoutTiers.streakThreshold,
          burst_threshold:  cronHealth.startupTimeoutTiers.burstThreshold,
          per_job:          cronHealth.startupTimeoutTiers.perJob,
          burst:            cronHealth.startupTimeoutTiers.burst,
        }
      : null,
    peak_rss_mb:      captureRssMb(),
  };
}

/**
 * FIX-1036 — the previous run's verdict, read BEFORE this run's row can be
 * mistaken for it. Filtering on `started_at < startedAt` is what makes that
 * safe: writeMetaRow has already inserted this run's row by the time this is
 * called (the meta row must land even if everything after it fails), so the
 * newest row is ours.
 *
 * Returns null when there is no readable prior verdict — no previous row, a
 * previous row from before this shipped (no `conditions` key), or a failed
 * read. Every condition then reads as `new` exactly once, and the email says so.
 */
async function fetchPreviousConditions(startedAt: Date): Promise<Condition[] | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db
    .from("data_sync_log")
    .select("metadata")
    .eq("pipeline", "canary_check")
    .lt("started_at", startedAt.toISOString())
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[canary-check] previous-verdict read failed (non-fatal, treating as first run): ${error.message}`);
    return null;
  }
  const rows = (data ?? []) as { metadata?: { conditions?: Condition[] } }[];
  const prev = rows[0]?.metadata?.conditions;
  return Array.isArray(prev) ? prev : null;
}

/** FIX-1036 — stamp the alert outcome onto the row this run already wrote. */
async function updateMetaRow(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>,
  outcome: {
    alert_sent: boolean;
    alert_tier: AlertTier | null;
    alert_error: string | null;
    transitions: Transition[];
    first_run: boolean;
  },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { error } = await db
    .from("data_sync_log")
    .update({ metadata: { ...metadata, ...outcome } })
    .eq("id", id);
  if (error) {
    // Non-fatal by design: the row itself already landed, which is the evidence
    // FIX-980 cares about. Losing the alert stamp costs the NEXT run its
    // transition baseline for one cycle, not this run's visibility.
    console.warn(`[canary-check] meta-row alert stamp failed (non-fatal): ${error.message}`);
  }
}

async function writeMetaRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>,
  startedAt: Date,
): Promise<{ ok: boolean; id: string | null }> {
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
  const { data, error } = await db
    .from("data_sync_log")
    .insert({
      pipeline:     "canary_check",
      status:       "complete",
      started_at:   startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      metadata,
    })
    .select("id")
    .single();
  if (error) {
    // FIX-980 — the OTHER half of "nothing watches the watchman". This used to
    // console.warn() and move on, so an insert that failed under the same 8s
    // service_role cap that killed the 2026-08-06 run left NO row and NO
    // signal: the canary's silence became indistinguishable from its health.
    // The meta row IS the evidence this process ran, so failing to write it is
    // a hard failure — the caller exits non-zero and GHA marks the run red,
    // which is the one surface outside this process that can see the gap.
    console.error(`[canary-check] meta-row insert FAILED: ${error.message}`);
    return { ok: false, id: null };
  }
  return { ok: true, id: (data as { id?: string } | null)?.id ?? null };
}

async function sendAlert(
  tier: AlertTier,
  transitions: Transition[],
  firstRun: boolean,
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
  staleRollups: RollupStatus[],
  orphans: RollupOrphan[],
  rateRegressions: RateFinding[],
  sectorAffinity: SectorAffinityStaleness | null,
  cronHealth: CronJobHealth | null,
  to: string,
  apiKey: string,
): Promise<string | null> {
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
  // FIX-1073 — the SUBJECT now names the tier, not every individual dropped
  // firing: a lone startup timeout is ordinary weather on this box (1,849 in
  // 30 days) and putting each one in the subject is what made the subject
  // unreadable.
  const tiers = cronHealth?.startupTimeoutTiers ?? null;
  const skipped = [...(cronHealth?.startupTimeouts ?? []), ...(cronHealth?.missingDaily ?? [])];
  if ((tiers?.perJob.length ?? 0) > 0) {
    parts.push(
      `pg_cron startup-timeout streak: ${[...new Set(tiers!.perJob.map((s) => s.jobname ?? `jobid ${s.jobid}`))].join(", ")}`,
    );
  }
  if ((tiers?.burst.length ?? 0) > 0) {
    parts.push(`pg_cron startup-timeout burst x${tiers!.burst.length}`);
  }
  if ((cronHealth?.missingDaily.length ?? 0) > 0) {
    parts.push(
      `daily pg_cron job(s) never fired: ${[...new Set((cronHealth?.missingDaily ?? []).map((f) => f.jobname ?? `jobid ${f.jobid}`))].join(", ")}`,
    );
  }
  if (rateRegressions.length > 0) {
    parts.push(`throughput regressed: ${rateRegressions.map((r) => r.pipeline).join(", ")}`);
  }
  if (cronHealth?.canaryLiveness?.silent) parts.push("canary itself went silent");
  const recoveredCount = transitions.filter((t) => t.kind === "recovered").length;
  if (parts.length === 0 && recoveredCount > 0) parts.push(`${recoveredCount} condition(s) cleared`);
  const subject = `[Civitics][${tier}] Nightly canary — ${parts.join("; ") || "state change"}`;

  const sections: string[] = [];
  // FIX-1036 — the derivative goes FIRST. Everything below it is the same
  // point-in-time detail the old email carried; this is the part that says
  // whether anything actually changed since last night, which is the only
  // reason to open the mail at all.
  if (firstRun) {
    sections.push(
      `No prior canary verdict was readable, so EVERY condition below reads as ` +
        `NEW this once. That is a baseline, not an overnight collapse — compare ` +
        `against tomorrow's run.`,
    );
  }
  if (transitions.length > 0) {
    sections.push(`What changed since the last run:\n${describeTransitions(transitions).join("\n")}`);
  }
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
  // FIX-1073 — the ESCALATING half of the firing signal.
  if ((tiers?.perJob.length ?? 0) > 0 || (tiers?.burst.length ?? 0) > 0) {
    sections.push(
      `pg_cron startup timeouts crossed a TIER (FIX-1073) — a single abandoned ` +
        `firing is ordinary weather on this box (1,849 in the 30 days to ` +
        `2026-09-02, dominated by the */2 watchdogs), so what escalates is ` +
        `either ${tiers!.streakThreshold}+ CONSECUTIVE timeouts for one job (that ` +
        `job has stopped running, not merely stumbled) or ${tiers!.burstThreshold}+ ` +
        `in one 60-minute bucket across all jobs (the box stopped accepting ` +
        `pg_cron's connections):\n` +
        (tiers!.perJob.length > 0
          ? tiers!.perJob.map((s) => `  - streak: ${describeStreak(s)}`).join("\n")
          : "") +
        (tiers!.perJob.length > 0 && tiers!.burst.length > 0 ? "\n" : "") +
        (tiers!.burst.length > 0
          ? tiers!.burst.map((b) => `  - burst: ${describeBurst(b)}`).join("\n")
          : "") +
        `\n\nTriage: SELECT * FROM cron.job_run_details ORDER BY start_time DESC; ` +
        `then look for what was saturating the box in that window. span_minutes ` +
        `separates a */2 watchdog losing 90 minutes from a twice-daily rollup ` +
        `losing three days.`,
    );
  }
  // FIX-1059 — pipelines nobody owns. Reported, never escalated.
  if (orphans.length > 0) {
    sections.push(
      `Orphaned watch entries (FIX-1059, REPORT-ONLY) — these pipelines have ` +
        `rows in data_sync_log, no ACTIVE pg_cron job, and no declaration in ` +
        `public.rollup_watch_overrides. Either the job was retired and nobody ` +
        `recorded it, or it was paused and should not have been:\n` +
        orphans
          .map(
            (o) =>
              `  - ${o.pipeline}` +
              (o.jobname ? ` (job ${o.jobname}${o.jobid != null ? `, jobid ${o.jobid}` : ""}, inactive)` : " (no cron job at all)") +
              `, last row ${o.last_row_at ?? "never"}`,
          )
          .join("\n") +
        `\n\nResolve by declaring it: INSERT INTO public.rollup_watch_overrides ` +
        `(pipeline, retired_at, note) VALUES (...) — or by re-activating the job.`,
    );
  }
  if (rateRegressions.length > 0) {
    sections.push(
      `Pipeline throughput regressed (FIX-978) — every run in the recent window ` +
        `is above the P90 baseline by the threshold factor, so this is a trend ` +
        `rather than one slow night:\n` +
        rateRegressions.map((f) => `  - ${describeRate(f)}`).join("\n"),
    );
  }
  if (cronHealth?.canaryLiveness?.silent) {
    const cl = cronHealth.canaryLiveness;
    sections.push(
      `The canary itself went SILENT (FIX-980) — the previous run left no row in ` +
        `data_sync_log. Six of the seven scheduled detectors run only inside that ` +
        `one process, so its silence takes them all dark at once and reads ` +
        `exactly like health:\n` +
        `  - last run ${cl.last_started_at ?? "never"} (${cl.hours_since ?? "?"}h ago, threshold ${cl.threshold_hours}h)`,
    );
  }
  if (skipped.length > 0) {
    sections.push(
      `pg_cron job(s) never STARTED (report-only unless tiered, see above) — ` +
        `this is not "the job failed", ` +
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

  // FIX-1036 — a send failure is REPORTED, never thrown. This used to throw out
  // of sendAlert and, because sendAlert ran BEFORE writeMetaRow, took the whole
  // process down before the meta row landed — so a Resend outage erased the
  // evidence the canary had run at all, which is precisely the silence FIX-980
  // exists to make visible. The row is already written by the time we get here;
  // the caller turns this string into a failures[] entry and a red workflow run.
  try {
    const { error } = await resend.emails.send({
      from:    ALERTS_FROM,
      to:      [to],
      subject,
      text:    body,
    });
    if (error) return `Resend send failed: ${error.message ?? String(error)}`;
  } catch (err) {
    return `Resend send threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/**
 * FIX-1036 — the order of operations IS the fix.
 *
 * It used to be: fetch everything -> sendAlert -> writeMetaRow -> build
 * failures[] -> exit. Three consequences, all of them bugs:
 *
 *   1. The meta row never carried the VERDICT. `escalating_rollups`,
 *      `alert_sent` and `escalated` existed only in the stdout JSON, which
 *      lives in a GHA log that ages out — so data_sync_log recorded what the
 *      canary saw and never what it concluded, and no run could compare itself
 *      against the one before it.
 *   2. A Resend failure THREW before the meta row was written, so an email
 *      outage erased the evidence the canary had run at all. That is exactly
 *      the silence FIX-980 exists to make visible, reintroduced one line above
 *      the detector for it.
 *   3. There was no prior-state read at all, so the same condition paged every
 *      night forever with a byte-identical `; `-joined subject.
 *
 * Now: build the keyed conditions and failures[] FIRST -> write the meta row
 * (it always lands) -> read the PREVIOUS run's conditions -> classify each as
 * new/worsening/unchanged/recovered -> send only on a transition (or the 7-run
 * STILL RED floor) -> stamp the outcome back onto the row this run wrote.
 */
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
  // FIX-1011 — and from every pipeline in data_sync_log, not just pg_cron's.
  const { watches: registry, orphans } = await fetchRollupRegistry();
  console.log(
    `[canary-check] rollup registry: ${registry.length} pipeline(s) ` +
      `(was a hand-maintained literal of ${FALLBACK_ROLLUP_PIPELINES.length}); ` +
      `${orphans.length} orphaned, ` +
      `${registry.filter((r) => r.retired || r.held).length} retired/held`,
  );
  const rollups = await fetchRollupFreshness(registry);
  // FIX-1135 — `reports`, not the RPC's raw `stale`: a retired, held or
  // never-closing pipeline is listed but generates no finding.
  const staleRollups = rollups.filter((r) => r.reports);
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
  // FIX-1073 — `null` means the tier migration has not been applied in this
  // environment. Fall back to the old any-startup-timeout rule there rather
  // than silently escalating on nothing; a detector that quietly stops
  // detecting is the failure this whole file exists to prevent.
  const tiers = cronHealth?.startupTimeoutTiers ?? null;
  const missingDaily = cronHealth?.missingDaily ?? [];
  const legacyStartup = tiers === null ? (cronHealth?.startupTimeouts ?? []) : [];
  // FIX-968 — when the nightly_cron read itself failed we know NOTHING about
  // missing/killed, so report neither rather than inventing a 7-day outage.
  // The remaining detectors are unaffected and still run, which is the whole
  // point of the change.
  const nightlyCheckUnavailable = actual === null;
  // "missing" = no nightly_cron row AND no nightly_killed row for that date.
  // "killed" = no nightly_cron row but a nightly_killed synthetic row exists.
  const missing  = nightlyCheckUnavailable ? [] : expected.filter((d) => !actual!.has(d) && !killedSet.has(d));
  const killed   = nightlyCheckUnavailable ? [] : expected.filter((d) => !actual!.has(d) &&  killedSet.has(d));

  // -------------------------------------------------------------------------
  // FIX-1036 STEP 1 — the keyed conditions. Every finding gets a key that is
  // STABLE across runs (the identity of the problem, not its wording), a tier,
  // and a monotone severity, so the next run can say what moved.
  //
  // Two keying choices matter and are deliberate:
  //   - A rollup uses ONE key whatever its tier, so crossing from report-only
  //     to escalating reads as `worsening` rather than as a recovery plus a
  //     new finding.
  //   - The startup-timeout BURST uses one flat key rather than one per hourly
  //     bucket. Bucket timestamps change every run by construction, so keying
  //     on them would make every burst permanently `new` and page nightly —
  //     the exact defect being fixed.
  // -------------------------------------------------------------------------
  const conditions: Condition[] = [];
  const push = (key: string, tier: "escalate" | "report", severity: number, detail: string) =>
    conditions.push({ key, tier, severity, detail });

  // missing/killed keep their historical email-only contract: they are
  // backward-looking signals about a pipeline that may already have
  // self-corrected, so they report rather than fail the run.
  if (missing.length > 0) {
    push("nightly_missing", "report", missing.length, `nightly_cron missed ${missing.length} day(s): ${missing.join(", ")}`);
  }
  if (killed.length > 0) {
    push("nightly_killed", "report", killed.length, `nightly_cron killed by workflow timeout on ${killed.length} day(s): ${killed.join(", ")}`);
  }
  for (const t of strandedAutovacuum) {
    push(`autovacuum_stranded:${t}`, "escalate", 1, `autovacuum stranded OFF on ${t}`);
  }
  {
    const byName = new Map(autovacuum.vm.map((v) => [v.relname, v]));
    for (const t of autovacuum.vmDegraded) {
      const v = byName.get(t);
      // Severity counts UP as health goes down, so it is monotone-worse.
      push(
        `vm_degraded:${t}`, "escalate", v ? 100 - v.pct_all_visible : 100,
        `visibility map collapsed on ${t}${v ? ` (${v.pct_all_visible}% all-visible)` : ""}`,
      );
    }
  }
  for (const r of rollups) {
    if (!r.escalates && !r.reports) continue;
    push(
      `rollup:${r.pipeline}`,
      r.escalates ? "escalate" : "report",
      // "never reached complete" is worse than any finite age, but must stay a
      // finite number so the WORSEN_FACTOR comparison behaves.
      r.hoursSinceComplete ?? 1_000_000,
      `rollup ${r.pipeline} last complete ${r.lastCompleteAt ?? "NEVER"}` +
        (r.hoursSinceComplete !== null ? ` (${r.hoursSinceComplete}h ago` : " (") +
        `, cadence ${r.cadenceHours ?? "?"}h from ${r.cadenceSource ?? "?"}` +
        (r.escalates ? `, escalate past ${r.escalateAfterHours}h` : `, report past ${r.reportAfterHours}h`) +
        `)` + (r.sweepInProgress ? " [resumable sweep in flight]" : ""),
    );
  }
  for (const o of orphans) {
    push(`orphan:${o.pipeline}`, "report", 1, `orphaned watch entry ${o.pipeline} (no active pg_cron job, no override row)`);
  }
  for (const s of tiers?.perJob ?? []) {
    push(`cron_startup_streak:${s.jobid}`, "escalate", s.streak, `pg_cron startup-timeout streak — ${describeStreak(s)}`);
  }
  if ((tiers?.burst.length ?? 0) > 0) {
    const worst = Math.max(...tiers!.burst.map((b) => b.count));
    push(
      "cron_startup_burst", "escalate", worst,
      `pg_cron startup-timeout burst — ${tiers!.burst.length} bucket(s) at or above ` +
        `${tiers!.burstThreshold}, worst ${worst}: ${tiers!.burst.map(describeBurst).join("; ")}`,
    );
  }
  for (const f of legacyStartup) {
    push(`cron_startup_legacy:${f.jobid}`, "escalate", 1, `pg_cron firing never started: ${describeFiring(f)} (tier RPC not migrated here)`);
  }
  for (const f of missingDaily) {
    push(`cron_missing_daily:${f.jobid}`, "escalate", 1, `daily pg_cron job never fired in the window: ${describeFiring(f)}`);
  }
  if (cronHealth?.canaryLiveness?.silent) {
    const cl = cronHealth.canaryLiveness;
    push(
      "canary_silent", "escalate", cl.hours_since ?? 1_000_000,
      `canary_check itself went silent: last run ${cl.hours_since ?? "?"}h ago ` +
        `(${cl.last_started_at ?? "never"}), threshold ${cl.threshold_hours}h`,
    );
  }
  for (const f of rateRegressions) {
    push(`rate_regression:${f.pipeline}`, "escalate", f.worst_case_ratio ?? 1, `pipeline throughput regressed (sustained): ${describeRate(f)}`);
  }
  if (sectorAffinity?.stale) {
    push(
      "sector_affinity", "escalate", sectorAffinity.hoursOutstanding ?? 1,
      `sector-affinity rollup stranded on a tag change ` +
        `(${sectorAffinity.hoursOutstanding ?? "?"}h outstanding; ` +
        `live=${sectorAffinity.liveSig ?? "-"} stored=${sectorAffinity.storedSig ?? "-"})`,
    );
  }
  // FIX-943 — bloat_degraded is deliberately absent: a table under its own
  // autovacuum trigger is the CAUSE, vm_degraded is the consequence that
  // actually breaks query plans, and only the consequence escalates. The cause
  // is still recorded on every run in the meta row.

  const failures   = conditions.filter((c) => c.tier === "escalate").map((c) => c.detail);
  const reportOnly = conditions.filter((c) => c.tier === "report").map((c) => c.detail);

  // -------------------------------------------------------------------------
  // FIX-1036 STEP 2 — the meta row lands BEFORE anything that can fail.
  // -------------------------------------------------------------------------
  // FIX-979 — `now` is main()'s entry instant, captured before the first
  // detector ran; writeMetaRow stamps completed_at itself.
  const metadata = buildMetadata(
    missing, killed, autovacuum, rollups, orphans, sectorAffinity, cronHealth,
    nightlyCheckUnavailable, conditions, failures, reportOnly,
  );
  const meta = await writeMetaRow(metadata, now);
  if (!meta.ok) {
    // FIX-980 — the row IS the evidence this process ran. A run that leaves
    // none is the silence the dead-man switch exists to surface, so it fails
    // the workflow even if every detector was clean.
    failures.push(
      "canary_check meta-row insert failed — this run left no evidence it ran, " +
        "which is the silence FIX-980 exists to make visible",
    );
  }

  // -------------------------------------------------------------------------
  // FIX-1036 STEP 3 — what changed? `now` excludes the row just written.
  // -------------------------------------------------------------------------
  const previous    = await fetchPreviousConditions(now);
  const firstRun    = previous === null;
  const transitions = classifyTransitions(conditions, previous);
  const decision    = decideAlert(conditions, transitions, firstRun);
  // Persisted conditions carry their unchanged-run counters forward, which is
  // what makes the 7-run STILL RED floor possible without a second table.
  metadata["conditions"] = withUnchangedRuns(conditions, transitions);

  // -------------------------------------------------------------------------
  // FIX-1036 STEP 4 — send only on a transition.
  // -------------------------------------------------------------------------
  let alertSent  = false;
  let alertError: string | null = null;
  const adminEmail = process.env["ADMIN_EMAIL"];
  const resendKey  = process.env["RESEND_API_KEY"];
  const inCi       = process.env["GITHUB_ACTIONS"] === "true";
  const sendReal   = process.argv.includes("--send-real");
  if (decision.send && adminEmail && resendKey) {
    if (inCi || sendReal) {
      alertError = await sendAlert(
        decision.tier!, transitions, firstRun, missing, killed, autovacuum,
        staleRollups, orphans, rateRegressions, sectorAffinity, cronHealth,
        adminEmail, resendKey,
      );
      alertSent = alertError === null;
      if (alertError) {
        console.error(`[canary-check] ${alertError}`);
        failures.push(alertError);
      }
    } else {
      console.log(
        `[canary-check] local run — would have sent [${decision.tier}]; ` +
          `skipping Resend send, pass --send-real to actually email`,
      );
    }
  } else if (!decision.send) {
    console.log("[canary-check] no transition since the last run — no email (the red X still stands if escalating)");
  }

  // -------------------------------------------------------------------------
  // FIX-1036 STEP 5 — stamp the outcome onto the row we already wrote.
  // -------------------------------------------------------------------------
  if (meta.id) {
    await updateMetaRow(meta.id, metadata, {
      alert_sent:  alertSent,
      alert_tier:  decision.tier,
      alert_error: alertError,
      transitions,
      first_run:   firstRun,
    });
  }

  // REPORT-ONLY, kept greppable in the workflow log so a slipping job is
  // visible before it becomes an escalation.
  if (reportOnly.length > 0) {
    console.log(`[canary-check] report-only (${reportOnly.length}): ${reportOnly.join("; ")}`);
  }
  {
    // FIX-1135 — pipelines that have never closed a cycle in the lookback are
    // LISTED (the registry must stay a superset of the census) but are not
    // "stale": hours-since-complete is undefined for them.
    const noClosure = rollups.filter((r) => !r.hasClosures).map((r) => r.pipeline);
    if (noClosure.length > 0) {
      console.log(`[canary-check] no cycle closure in the lookback (not a finding): ${noClosure.join(", ")}`);
    }
    const declared = rollups.filter((r) => r.retired || r.held);
    if (declared.length > 0) {
      console.log(
        `[canary-check] declared in rollup_watch_overrides (listed, never alerted): ` +
          declared.map((r) => `${r.pipeline}=${r.retired ? "retired" : "held"}`).join(", "),
      );
    }
  }
  const rateWatch = (rateHealth?.pipelines ?? []).filter((p) => p.verdict === "intermittent");
  if (rateWatch.length > 0) {
    console.log(
      `[canary-check] intermittent rate outliers (report-only, not a trend): ` +
        `${rateWatch.map(describeRate).join("; ")}`,
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
      // FIX-1059 — the class that paged for six weeks, now named rather than
      // silently carried at a fabricated cadence.
      orphans:                orphans.map((o) => o.pipeline),
      // FIX-978 — the first rate signal on this box.
      rate_regressions:       rateRegressions.map(describeRate),
      rate_intermittent:      rateWatch.map((p) => p.pipeline),
      sector_affinity_staleness: sectorAffinity,
      // FIX-968 — the nightly_cron read failed; missing/killed above are
      // "unknown", not "clean". Surfaced so a quiet run cannot be misread.
      nightly_check_unavailable: nightlyCheckUnavailable,
      // FIX-1073 — startup_timeouts is REPORT-ONLY now; the tiers are what
      // escalate. Both are surfaced so the workflow log shows the raw weather
      // next to the verdict drawn from it.
      cron_startup_timeouts: (cronHealth?.startupTimeouts ?? []).map(describeFiring),
      cron_startup_tiers: {
        streak_threshold: tiers?.streakThreshold ?? null,
        burst_threshold:  tiers?.burstThreshold ?? null,
        per_job:          (tiers?.perJob ?? []).map(describeStreak),
        burst:            (tiers?.burst ?? []).map(describeBurst),
      },
      cron_missing_daily:    missingDaily.map(describeFiring),
      cron_timeout_blowouts: (cronHealth?.timeoutBlowouts ?? []).map(describeFiring),
      // FIX-1036 — the verdict and its derivative, in the log AND the meta row.
      first_run:           firstRun,
      transitions:         transitions.map((t) => `${t.kind}:${t.key}`),
      alert_sent:          alertSent,
      alert_tier:          decision.tier,
      alert_error:         alertError,
      report_only:         reportOnly,
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
