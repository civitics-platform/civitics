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

async function writeMetaRow(missing: string[], killed: string[]): Promise<void> {
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
  to: string,
  apiKey: string,
): Promise<void> {
  // Lazy import keeps the script no-op-safe when Resend isn't installed for
  // some reason — prevents a hard module-resolution failure at startup.
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  // FIX-290: distinguish "didn't run at all" from "ran but got SIGTERM'd."
  // Killed-only is a softer signal — the workflow started and the post-step
  // wrote a synthetic row, so the runner + GHA scheduling are healthy.
  let subject: string;
  if (missing.length > 0 && killed.length > 0) {
    subject = `[Civitics] Nightly sync missed ${missing.length} day(s), killed ${killed.length} day(s)`;
  } else if (missing.length > 0) {
    subject = `[Civitics] Nightly sync missed ${missing.length} day(s)`;
  } else {
    subject = `⚠️ Nightly killed by workflow timeout (${killed.length} day(s))`;
  }

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
  const body = sections.join("\n\n") + `\n\nWorkflow runs: ${NIGHTLY_RUN_URL}\n`;

  const { error } = await resend.emails.send({
    from:    ALERTS_FROM,
    to:      [to],
    subject,
    text:    body,
  });
  if (error) throw new Error(`Resend send failed: ${error.message ?? String(error)}`);
}

async function main(): Promise<void> {
  const now      = new Date();
  const expected = expectedDates(now, CHECK_DAYS);
  const actual   = await fetchActualDates(CHECK_DAYS);
  const killedSet = await fetchKilledDates(CHECK_DAYS);
  // "missing" = no nightly_cron row AND no nightly_killed row for that date.
  // "killed" = no nightly_cron row but a nightly_killed synthetic row exists.
  const missing  = expected.filter((d) => !actual.has(d) && !killedSet.has(d));
  const killed   = expected.filter((d) => !actual.has(d) &&  killedSet.has(d));

  let alertSent = false;
  const adminEmail = process.env["ADMIN_EMAIL"];
  const resendKey  = process.env["RESEND_API_KEY"];
  const inCi       = process.env["GITHUB_ACTIONS"] === "true";
  const sendReal   = process.argv.includes("--send-real");
  const hasAlert   = missing.length > 0 || killed.length > 0;
  if (hasAlert && adminEmail && resendKey) {
    if (inCi || sendReal) {
      await sendAlert(missing, killed, adminEmail, resendKey);
      alertSent = true;
    } else {
      console.log(
        "[canary-check] local run — skipping Resend send; pass --send-real to actually email"
      );
    }
  }

  await writeMetaRow(missing, killed);

  console.log(
    JSON.stringify({
      checked_days:  CHECK_DAYS,
      missing_dates: missing,
      killed_dates:  killed,
      alert_sent:    alertSent,
    })
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "[canary-check] failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  });
