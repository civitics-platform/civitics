/**
 * FIX-291 — Rebuild entity_connections via the chunked SQL derivation,
 * extracted from runNightlySync.
 *
 * Background: the rebuild grew past 90 minutes wall-clock on prod and was
 * blowing the daily nightly's `timeout-minutes: 120` GHA budget (5/10, 5/14,
 * 5/17 cancellations — see docs/audits/missing-nightlies-2026-05-10-to-16.md).
 * The chunked split (FIX-263) helped but each chunk's `statement_timeout` is
 * the new cap. Moving it to a dedicated workflow lets the donations chunk
 * have a 90-min timeout (FIX-291 migration) without fighting wall-clock
 * pressure from unrelated daily pipelines, and lets the workflow have a 4-hour
 * budget without bloating the daily one.
 *
 * Cadence: GHA `rebuild-entity-connections.yml` runs Sun + Wed 08:00 UTC.
 * Graph edges go stale up to ~3 days between rebuilds. Accepted trade-off
 * relative to the 4-of-7-nights-fail baseline.
 *
 * Writes its own `entity_connections_rebuild` rows to data_sync_log (NOT
 * `nightly_cron` — different cadence, different semantics, canary watches
 * only nightly_cron).
 *
 *   pnpm data:rebuild-connections        # local
 *   pnpm data:rebuild-connections:ci     # in GHA, adds --allow-prod
 */

import { startSync, completeSync, failSync } from "../pipelines/sync-log";

// Mirrors the buildDbUrl in packages/data/src/pipelines/index.ts. Kept local
// here so the standalone script can run without importing the orchestrator's
// internals (which would drag in every pipeline module).
function buildDbUrl(): string | null {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!password || !supabaseUrl) return null;
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return null;
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const parts: string[] = [obj.message];
      if (obj.code)    parts.push(`(${String(obj.code)})`);
      if (obj.details) parts.push(`details=${String(obj.details)}`);
      if (obj.hint)    parts.push(`hint=${String(obj.hint)}`);
      return parts.join(" ");
    }
    try { return JSON.stringify(err); } catch { return "<unserializable error>"; }
  }
  return String(err);
}

type Mode = "full" | "incremental";

// FIX-372/FIX-373 — donations + votes have _full() companions for the weekly
// reconcile path. The other 8 chunks always run as a single full-rebuild
// function. External MUST stay last (FIX-251 ON CONFLICT DO NOTHING).
function chunkFns(mode: Mode): string[] {
  const suffix = mode === "full" ? "_full" : "";
  return [
    `rebuild_entity_connections_donations${suffix}`,
    `rebuild_entity_connections_votes${suffix}`,
    "rebuild_entity_connections_cosponsors",
    "rebuild_entity_connections_appointments",
    "rebuild_entity_connections_oversight",
    "rebuild_entity_connections_holds",
    "rebuild_entity_connections_gifts",
    "rebuild_entity_connections_contracts",
    "rebuild_entity_connections_lobbying",
    "rebuild_entity_connections_external",
  ];
}

function parseMode(argv: string[]): Mode {
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      const v = arg.slice("--mode=".length);
      if (v === "full" || v === "incremental") return v;
      throw new Error(`[rebuild] invalid --mode value: ${v} (expected 'full' or 'incremental')`);
    }
  }
  return "incremental";
}

interface ChunkResult {
  connection_type: string;
  edges_upserted: string | number;
  duration_ms: number;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const mode = parseMode(process.argv.slice(2));
  const fns = chunkFns(mode);
  const logId = await startSync("entity_connections_rebuild");
  const breakdown: ChunkResult[] = [];
  const chunkFailures: string[] = [];
  let total = 0;

  const dbUrl = buildDbUrl();
  console.log(
    `[rebuild] mode=${mode} (${dbUrl ? "direct pg, per-chunk" : "PostgREST RPC umbrella"})`,
  );

  try {
    if (dbUrl) {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      try {
        for (const fn of fns) {
          const chunkStart = Date.now();
          try {
            // Each chunk's ALTER FUNCTION ... SET statement_timeout sets a
            // function-level GUC that wins inside the function body. The
            // session-level timeout below is a belt-and-braces backstop for
            // any chunk that doesn't have a function-level setting yet.
            // FIX-291 raises the donations chunk's function-level timeout
            // from 60min → 90min.
            await client.query("SET statement_timeout = '90min'");
            const res = await client.query<{ connection_type: string; edges_upserted: string | number }>(
              `SELECT * FROM public.${fn}()`,
            );
            const chunkDur = Date.now() - chunkStart;
            for (const r of res.rows) {
              breakdown.push({ ...r, duration_ms: chunkDur });
              total += Number(r.edges_upserted ?? 0);
            }
            console.log(`  [chunk] ${fn} — complete in ${(chunkDur / 1000).toFixed(1)}s`);
          } catch (chunkErr) {
            const chunkDur = Date.now() - chunkStart;
            const msg = errMsg(chunkErr);
            console.error(`  [chunk] ${fn} — FAILED in ${(chunkDur / 1000).toFixed(1)}s: ${msg}`);
            chunkFailures.push(`${fn}: ${msg}`);
            breakdown.push({ connection_type: `${fn}:failed`, edges_upserted: -1, duration_ms: chunkDur });
          }
        }
        // FIX-338 — refresh the connection_type_counts materialization
        // after all chunks land. The umbrella RPC body does this itself
        // (see 20260523040002_umbrella_rebuild_calls_refresh.sql), but the
        // per-chunk path GHA uses on prod bypasses the umbrella, so the
        // refresh has to be invoked explicitly here. Wrapped so a refresh
        // failure doesn't mask a successful rebuild — the next run picks up.
        try {
          await client.query("SELECT public.refresh_connection_type_counts()");
          console.log("  [post] refresh_connection_type_counts — complete");
        } catch (refreshErr) {
          console.warn(
            `  [post] refresh_connection_type_counts — FAILED: ${errMsg(refreshErr)}`,
          );
        }
        // FIX-500 — refresh the per-cohort donor rollup the graph group route
        // reads. Donation edges only change when the chunks above run, so this is
        // the right (and only) cadence — no separate cron. Wrapped so a refresh
        // failure leaves the prior rollup snapshot in place (the route still reads
        // it; the next rebuild re-aggregates) rather than masking the rebuild.
        try {
          // The function's proconfig statement_timeout is not honored through the
          // session pooler (the session value governs), so set an explicit budget
          // here rather than relying on the chunk loop's leftover 90min. The full
          // re-aggregate measured ~6min on prod under load (519k donor rows), so
          // 1800s is generous off-path headroom.
          await client.query("SET statement_timeout = '1800s'");
          const r = await client.query<{ refresh_group_donor_rollup: unknown }>(
            "SELECT public.refresh_group_donor_rollup()",
          );
          console.log(
            `  [post] refresh_group_donor_rollup — complete: ${JSON.stringify(r.rows[0]?.refresh_group_donor_rollup ?? {})}`,
          );
        } catch (rollupErr) {
          console.warn(
            `  [post] refresh_group_donor_rollup — FAILED: ${errMsg(rollupErr)}`,
          );
        }
        // FIX-509 — refresh the per-entity connection-stats MV the treemap
        // aggregate + graph entities routes read. Like the rollup above, its
        // source (entity_connections) only changes when the chunks run, so this
        // is the right (and only) cadence. Wrapped so a refresh failure leaves
        // the prior snapshot in place rather than masking a successful rebuild.
        try {
          await client.query("SET statement_timeout = '600s'");
          await client.query("SELECT public.refresh_entity_connection_stats_mv()");
          console.log("  [post] refresh_entity_connection_stats_mv — complete");
        } catch (statsErr) {
          console.warn(
            `  [post] refresh_entity_connection_stats_mv — FAILED: ${errMsg(statsErr)}`,
          );
        }
      } finally {
        await client.end();
      }
    } else {
      // PostgREST RPC umbrella fallback (local dev without SUPABASE_DB_URL).
      // The umbrella calls the incremental functions; --mode=full is honored
      // only on the direct-pg path. Warn so the operator knows.
      if (mode === "full") {
        console.warn(
          "[rebuild] --mode=full ignored on PostgREST fallback path; umbrella calls incremental functions",
        );
      }
      const { createAdminClient } = await import("@civitics/db");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const admin = createAdminClient() as any;
      const { data, error } = await admin.rpc("rebuild_entity_connections");
      if (error) throw error;
      const rows = (data ?? []) as { connection_type: string; edges_upserted: string | number }[];
      for (const r of rows) {
        breakdown.push({ ...r, duration_ms: 0 });
        total += Number(r.edges_upserted ?? 0);
      }
      // FIX-500 — same rollup refresh on the local-dev umbrella path so
      // `pnpm data:rebuild-connections` against local Docker also rebuilds the
      // donor rollup the group route reads. Wrapped (advisory) like the prod path.
      try {
        const { error: rollupErr } = await admin.rpc("refresh_group_donor_rollup");
        if (rollupErr) throw rollupErr;
        console.log("  [post] refresh_group_donor_rollup — complete");
      } catch (rollupErr) {
        console.warn(
          `  [post] refresh_group_donor_rollup — FAILED: ${errMsg(rollupErr)}`,
        );
      }
      // FIX-509 — same per-entity connection-stats MV refresh on the local-dev
      // umbrella path so `pnpm data:rebuild-connections` against local Docker
      // also rebuilds the MV the treemap/entities routes read. Advisory.
      try {
        const { error: statsErr } = await admin.rpc("refresh_entity_connection_stats_mv");
        if (statsErr) throw statsErr;
        console.log("  [post] refresh_entity_connection_stats_mv — complete");
      } catch (statsErr) {
        console.warn(
          `  [post] refresh_entity_connection_stats_mv — FAILED: ${errMsg(statsErr)}`,
        );
      }
    }

    const dur = Date.now() - t0;
    const statusLabel = chunkFailures.length > 0 ? "PARTIAL" : "complete";
    console.log(
      `[rebuild] ${statusLabel} in ${(dur / 1000).toFixed(1)}s, ${total} edges` +
        (chunkFailures.length > 0 ? ` (${chunkFailures.length} chunk failures)` : ""),
    );
    for (const r of breakdown) {
      const durStr = r.duration_ms > 0 ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : "";
      console.log(`  ${r.connection_type}: ${r.edges_upserted}${durStr}`);
    }

    if (chunkFailures.length > 0) {
      await failSync(logId, chunkFailures.join("; "));
      // Non-zero exit so GHA marks the workflow run as failed, but only after
      // the data_sync_log row is finalised. Partial-success is still a
      // failure signal for an operations workflow.
      process.exit(1);
    } else {
      await completeSync(logId, { inserted: total, updated: 0, failed: 0, estimatedMb: 0 });
    }
  } catch (err) {
    const msg = errMsg(err);
    console.error("[rebuild] failed:", msg);
    await failSync(logId, msg);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[rebuild] unexpected error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
