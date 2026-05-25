/**
 * Ad-hoc cadence audit for the Data Health card overhaul (FIX-381).
 *
 * Reads data_sync_log for the last 90d and prints per-pipeline run count,
 * first/last run timestamps, and the average inter-run gap. Used once to
 * validate the proposed `cadence` table in apps/civitics/app/dashboard/
 * DashboardClient.tsx before locking the freshness thresholds.
 *
 * Read-only. Run with prod env file:
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local.prod \
 *     src/scripts/pipeline-cadence-audit.ts
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    return "";
  }
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(unset)";
  console.log(`Connected env target: ${supabaseUrl}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      pipeline: string;
      runs_90d: string;
      last_run: string | null;
      first_run: string | null;
      avg_gap_hours: string | null;
      days_since_last: string | null;
    }>(`
      SELECT pipeline,
             COUNT(*)::TEXT                                    AS runs_90d,
             MAX(completed_at)                                 AS last_run,
             MIN(completed_at)                                 AS first_run,
             ROUND(
               EXTRACT(EPOCH FROM (MAX(completed_at) - MIN(completed_at)))
               / NULLIF(COUNT(*) - 1, 0) / 3600,
               1
             )::TEXT                                            AS avg_gap_hours,
             ROUND(
               EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 86400,
               1
             )::TEXT                                            AS days_since_last
      FROM public.data_sync_log
      WHERE completed_at IS NOT NULL
        AND completed_at > NOW() - INTERVAL '90 days'
      GROUP BY pipeline
      ORDER BY avg_gap_hours DESC NULLS LAST, pipeline;
    `);

    console.log("\nPer-pipeline cadence (last 90d):");
    console.log("pipeline | runs_90d | days_since_last | avg_gap_hours | first_run | last_run");
    console.log("---------|----------|-----------------|---------------|-----------|---------");
    for (const r of rows) {
      console.log(
        `${r.pipeline} | ${r.runs_90d} | ${r.days_since_last ?? "-"} | ${r.avg_gap_hours ?? "-"} | ${r.first_run ?? "-"} | ${r.last_run ?? "-"}`,
      );
    }

    console.log(
      `\nTotal distinct pipeline names in last 90d: ${rows.length}`,
    );

    // Also surface pipelines whose latest run is older than 90d (which the
    // 90d filter above hides entirely). TIGER is the surfacing case.
    const { rows: stale } = await client.query<{
      pipeline: string;
      last_run: string;
      days_since_last: string;
    }>(`
      SELECT pipeline,
             MAX(completed_at)                                  AS last_run,
             ROUND(
               EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 86400,
               1
             )::TEXT                                             AS days_since_last
      FROM public.data_sync_log
      WHERE completed_at IS NOT NULL
      GROUP BY pipeline
      HAVING MAX(completed_at) <= NOW() - INTERVAL '90 days'
      ORDER BY MAX(completed_at) DESC;
    `);

    console.log("\nPipelines whose latest run is >90 days old (outside main window):");
    if (stale.length === 0) {
      console.log("  (none)");
    } else {
      for (const r of stale) {
        console.log(`  ${r.pipeline} | last_run=${r.last_run} | ${r.days_since_last}d ago`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
