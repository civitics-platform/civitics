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

async function fetchActualDates(daysBack: number): Promise<Set<string>> {
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

  if (error) throw new Error(`data_sync_log query failed: ${error.message}`);

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

type AutovacuumStatus = {
  stranded: string[];
  vmDegraded: string[];
  vm: VmRow[];
};

const NO_AUTOVACUUM_FINDINGS: AutovacuumStatus = { stranded: [], vmDegraded: [], vm: [] };

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
  };
  const vm = Array.isArray(result.vm) ? result.vm : [];
  // The RPC already excludes an in-flight rebuild via rebuild_active; this is a
  // second guard in case the shape changes. A rebuild legitimately holds
  // autovacuum off AND churns the visibility map, so neither signal is
  // actionable mid-run — keep vm[] for the meta row, suppress both findings.
  if (result.rebuild_active) return { ...NO_AUTOVACUUM_FINDINGS, vm };
  return {
    stranded:   Array.isArray(result.stranded)    ? result.stranded    : [],
    vmDegraded: Array.isArray(result.vm_degraded) ? result.vm_degraded : [],
    vm,
  };
}

async function writeMetaRow(
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const now = new Date().toISOString();
  const { error } = await db.from("data_sync_log").insert({
    pipeline:     "canary_check",
    status:       "complete",
    started_at:   now,
    completed_at: now,
    metadata: {
      pipeline_checked: PIPELINE_NAME,
      checked_days:     CHECK_DAYS,
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
      peak_rss_mb:      captureRssMb(),
    },
  });
  if (error) {
    console.warn(`[canary-check] meta-row insert failed: ${error.message}`);
  }
}

async function sendAlert(
  missing: string[],
  killed: string[],
  autovacuum: AutovacuumStatus,
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
  // "missing" = no nightly_cron row AND no nightly_killed row for that date.
  // "killed" = no nightly_cron row but a nightly_killed synthetic row exists.
  const missing  = expected.filter((d) => !actual.has(d) && !killedSet.has(d));
  const killed   = expected.filter((d) => !actual.has(d) &&  killedSet.has(d));

  let alertSent = false;
  const adminEmail = process.env["ADMIN_EMAIL"];
  const resendKey  = process.env["RESEND_API_KEY"];
  const inCi       = process.env["GITHUB_ACTIONS"] === "true";
  const sendReal   = process.argv.includes("--send-real");
  const hasAlert   = missing.length > 0 || killed.length > 0
                  || strandedAutovacuum.length > 0 || autovacuum.vmDegraded.length > 0;
  if (hasAlert && adminEmail && resendKey) {
    if (inCi || sendReal) {
      await sendAlert(missing, killed, autovacuum, adminEmail, resendKey);
      alertSent = true;
    } else {
      console.log(
        "[canary-check] local run — skipping Resend send; pass --send-real to actually email"
      );
    }
  }

  await writeMetaRow(missing, killed, autovacuum);

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

  console.log(
    JSON.stringify({
      checked_days:        CHECK_DAYS,
      missing_dates:       missing,
      killed_dates:        killed,
      stranded_autovacuum: strandedAutovacuum,
      vm_degraded:         autovacuum.vmDegraded,
      visibility_map:      autovacuum.vm,
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
