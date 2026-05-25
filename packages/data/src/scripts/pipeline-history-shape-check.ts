/**
 * Standalone replica of `getPipelines()`'s per-pipeline bucketing query —
 * runs the same 14-month / 3000-row data_sync_log scan and walks the
 * grouped result the same way the dashboard handler does, then prints one
 * line per pipeline (run count, latest completion, age, status).
 *
 * Run this when the Data Health card looks off — a pipeline is missing,
 * showing wrong cadence, or surfacing as an orphan — to confirm whether
 * the underlying data_sync_log shape matches what the server expects, and
 * to enumerate every writer string actually present in the window (the
 * authoritative input to PIPELINES.aliases + HIDDEN_PIPELINES audits).
 *
 * Run against either environment by toggling `.env.local`:
 *   pnpm --filter @civitics/data diag:pipeline-history
 *
 * Reads SUPABASE_DB_URL when set, otherwise constructs the pooler URL
 * from NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD (prod) or falls
 * back to the local Docker connection (dev).
 *
 * Originally landed as the verification helper for FIX-381 (Data Health
 * cadence-awareness); promoted to a permanent diagnostic in the Data
 * Health cleanup follow-up.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return "";
  // Local Docker uses the hard-coded postgres:postgres super-user and needs
  // no project password — check this first so a missing SUPABASE_DB_PASSWORD
  // doesn't short-circuit the local run.
  if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const password = process.env.SUPABASE_DB_PASSWORD;
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!password || !m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL ?? constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  console.log(`Connected env target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const fourteenMonthsAgo = new Date(
      Date.now() - 14 * 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Mirror of getPipelines() (post-FIX-381): same 14-month bound + ORDER
    // BY (pipeline ASC, completed_at DESC NULLS LAST) + 3000 LIMIT.
    const { rows } = await client.query<{
      pipeline: string;
      status: string;
      completed_at: string | null;
    }>(
      `
      SELECT pipeline, status, started_at, completed_at,
             rows_inserted, rows_updated, rows_failed, estimated_mb, error_message
      FROM public.data_sync_log
      WHERE completed_at > $1
      ORDER BY pipeline ASC, completed_at DESC NULLS LAST
      LIMIT 3000;
      `,
      [fourteenMonthsAgo],
    );

    // JS-side bucketing (matches getPipelines).
    const history: Record<string, typeof rows> = {};
    for (const r of rows) {
      const b = (history[r.pipeline] ??= []);
      if (b.length < 7) b.push(r);
    }

    const keys = Object.keys(history).sort();
    console.log(`\nFetched ${rows.length} rows; bucketed into ${keys.length} pipelines.`);
    console.log("\nPer-pipeline trimmed history (newest first per pipeline):");
    for (const k of keys) {
      const latest = history[k][0];
      const ageH = latest?.completed_at
        ? Math.round((Date.now() - new Date(latest.completed_at).getTime()) / 3_600_000)
        : null;
      console.log(
        `  ${k.padEnd(38)} runs=${history[k].length}  latest=${latest?.completed_at ?? "(none)"}  age=${ageH ?? "?"}h  status=${latest?.status ?? "?"}`,
      );
    }

    // Specifically check the pipelines the FIX-381 prompt cited.
    const tiger = history["tiger_districts"];
    const bulkPeople = history["openstates_bulk_people"];
    console.log("\nFocused checks:");
    console.log(
      `  tiger_districts present in history: ${tiger ? "YES" : "NO"} (${tiger?.length ?? 0} runs in window)`,
    );
    console.log(
      `  openstates_bulk_people present:     ${bulkPeople ? "YES" : "NO"} (${bulkPeople?.length ?? 0} runs in window)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
