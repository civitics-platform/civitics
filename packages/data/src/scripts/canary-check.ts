/**
 * FIX-234 — Silent-failure alarm for the nightly sync.
 *
 * Queries data_sync_log for `nightly_cron` complete rows over the last 7 UTC
 * days. If any expected day has no matching row, optionally emails ALERT_EMAIL
 * via Resend.
 *
 * Designed for GitHub Actions (.github/workflows/sync-canary-check.yml) at
 * 05:00 UTC, 3h after the nightly's 02:00 UTC start. The pipeline name string
 * `nightly_cron` is what runNightlySync() writes on completion — see
 * packages/data/src/pipelines/index.ts.
 *
 * No-op-safe: missing ALERT_EMAIL or RESEND_API_KEY simply skips the send.
 * Exit 1 only on real errors (DB unreachable, Resend API failure). Missing
 * nightlies are not script errors — they're the thing the script reports.
 */

import { createAdminClient } from "@civitics/db";

const PIPELINE_NAME      = "nightly_cron";
const CHECK_DAYS         = 7;
const ALERTS_FROM        = "alerts@civitics.platform";
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

  const { data, error } = await db
    .from("data_sync_log")
    .select("started_at, completed_at")
    .eq("pipeline", PIPELINE_NAME)
    .eq("status", "complete")
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

async function writeMetaRow(missing: string[]): Promise<void> {
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
    },
  });
  if (error) {
    console.warn(`[canary-check] meta-row insert failed: ${error.message}`);
  }
}

async function sendAlert(missing: string[], to: string, apiKey: string): Promise<void> {
  // Lazy import keeps the script no-op-safe when Resend isn't installed for
  // some reason — prevents a hard module-resolution failure at startup.
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const subject = `[Civitics] Nightly sync missed ${missing.length} day(s)`;
  const body =
    `The nightly sync (pipeline=${PIPELINE_NAME}) is missing complete rows ` +
    `for the following UTC date(s):\n\n` +
    missing.map((d) => `  - ${d}`).join("\n") +
    `\n\nWorkflow runs: ${NIGHTLY_RUN_URL}\n`;

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
  const missing  = expected.filter((d) => !actual.has(d));

  let alertSent = false;
  const alertEmail  = process.env["ALERT_EMAIL"];
  const resendKey   = process.env["RESEND_API_KEY"];
  if (missing.length > 0 && alertEmail && resendKey) {
    await sendAlert(missing, alertEmail, resendKey);
    alertSent = true;
  }

  await writeMetaRow(missing);

  console.log(
    JSON.stringify({
      checked_days:  CHECK_DAYS,
      missing_dates: missing,
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
