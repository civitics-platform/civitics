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
    // FIX-584 — re-project promoted investigation evidence_cards. MUST stay last:
    // like _external it's an ON CONFLICT DO NOTHING pass, so every authoritative
    // pass must populate its (from,to,type) tuples first (a community assertion
    // never overrides a derived edge).
    "rebuild_entity_connections_investigation",
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

// FIX-588 — full donation rebuild, windowed by from_id across SEPARATE
// top-level statements. The monolithic rebuild_entity_connections_donations_full()
// ran as one statement and hit the 90min session statement_timeout on prod (run
// 27496446207, 2026-06-14) — the ~4M-edge INSERT into a 9-index table plus the
// recipient_count UPDATE can't finish under a single per-statement cap. Each
// prepare/window/finalize call below is its own SELECT → its own fresh timeout,
// so total wall-clock can exceed any single cap (bounded by the 4h GHA budget).
// from_id is a uuid; these 16 nibble windows partition the whole space and the
// aggregate GROUP BYs on from_id, so the windowed result is identical to the
// monolith (verified local vs ground-truth aggregation, FIX-588).
const DONATION_WINDOW_BOUNDS: (string | null)[] = [
  "00000000-0000-0000-0000-000000000000",
  "10000000-0000-0000-0000-000000000000",
  "20000000-0000-0000-0000-000000000000",
  "30000000-0000-0000-0000-000000000000",
  "40000000-0000-0000-0000-000000000000",
  "50000000-0000-0000-0000-000000000000",
  "60000000-0000-0000-0000-000000000000",
  "70000000-0000-0000-0000-000000000000",
  "80000000-0000-0000-0000-000000000000",
  "90000000-0000-0000-0000-000000000000",
  "a0000000-0000-0000-0000-000000000000",
  "b0000000-0000-0000-0000-000000000000",
  "c0000000-0000-0000-0000-000000000000",
  "d0000000-0000-0000-0000-000000000000",
  "e0000000-0000-0000-0000-000000000000",
  "f0000000-0000-0000-0000-000000000000",
  null, // final window runs to the end of the uuid space
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runDonationsFullWindowed(client: any): Promise<number> {
  await client.query("SELECT public.rebuild_ec_donations_full_prepare()");
  let total = 0;
  for (let i = 0; i < DONATION_WINDOW_BOUNDS.length - 1; i++) {
    const lo = DONATION_WINDOW_BOUNDS[i]!;     // only the final bound is null
    const hi = DONATION_WINDOW_BOUNDS[i + 1];  // null on the last window
    const wStart = Date.now();
    try {
      const r = await client.query(
        "SELECT public.rebuild_ec_donations_full_window($1, $2) AS n",
        [lo, hi],
      );
      const n = Number(r.rows[0]?.n ?? 0);
      total += n;
      console.log(
        `    [donations] window ${i + 1}/16 [${lo.slice(0, 8)}..${hi ? hi.slice(0, 8) : "end"}) — ${n} edges in ${((Date.now() - wStart) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      // Re-throw with window context. Donations is the graph's backbone — a
      // window failure must surface as a hard chunk failure (non-zero exit via
      // chunkFailures), never a silent partial. (Prepare already cleared the
      // old edges, so a mid-rebuild failure leaves donations short until the
      // next run — the failure signal is what makes that visible.)
      throw new Error(`donations window ${i + 1}/16 [${lo}..${hi ?? "end"}): ${errMsg(err)}`);
    }
  }
  const fin = await client.query("SELECT public.rebuild_ec_donations_full_finalize() AS n");
  console.log(
    `    [donations] finalize — recipient_count updated for ${Number(fin.rows[0]?.n ?? 0)} individual donors`,
  );
  return total;
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
      const dsn = dbUrl; // narrowed non-null for the signal-handler closure
      const { Client } = await import("pg");
      // FIX-591 — tag the connection so the startup reconcile and signal handler
      // can find THIS run's backend (and a prior run's orphan) by application_name.
      const APP_NAME = "entity_connections_rebuild";
      const client = new Client({ connectionString: dsn, application_name: APP_NAME });
      await client.connect();

      // Our backend pid — the signal handler cancels this exact backend.
      const pidRes = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const myPid = pidRes.rows[0]?.pid;

      // FIX-591 — SIGTERM/SIGINT handler. GHA cancellation AND the timeout-minutes
      // cap both deliver SIGTERM (then SIGKILL after a grace window). Without this,
      // the node client dies but Postgres keeps running our in-flight DELETE/INSERT
      // as an ORPHANED backend that hammers prod for up to the session
      // statement_timeout (observed 1h10m on the 2026-06-14 run), and a SIGKILL
      // skips the finally so autovacuum is left disabled. On signal we open a
      // FRESH connection (the main one is busy), pg_cancel_backend our own pid, and
      // re-enable autovacuum — best-effort within the grace window. The next run's
      // startup reconcile (below) is the backstop if this can't finish in time.
      let cleaningUp = false;
      const onSignal = (sig: string): void => {
        if (cleaningUp) return;
        cleaningUp = true;
        console.error(`  [rebuild] received ${sig} — cancelling in-flight query + re-enabling autovacuum`);
        void (async () => {
          try {
            const { Client: CleanupClient } = await import("pg");
            const cleanup = new CleanupClient({ connectionString: dsn, application_name: `${APP_NAME}_cleanup` });
            await cleanup.connect();
            if (myPid) await cleanup.query("SELECT pg_cancel_backend($1)", [myPid]);
            await cleanup.query("ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)");
            await cleanup.end();
            console.error("  [rebuild] signal cleanup complete");
          } catch (e) {
            console.error(`  [rebuild] signal cleanup failed (next run's startup reconcile will recover): ${errMsg(e)}`);
          } finally {
            process.exit(1);
          }
        })();
      };
      process.on("SIGTERM", () => onSignal("SIGTERM"));
      process.on("SIGINT", () => onSignal("SIGINT"));

      // FIX-591 — startup reconcile: self-heal whatever a prior run left behind
      // when it was cancelled/timed out/SIGKILLed. The workflow concurrency group
      // is cancel-in-progress:false, so any OTHER backend carrying our
      // application_name is a leftover orphan, never a peer run — cancel then
      // terminate it. Also unconditionally re-enable autovacuum on
      // entity_connections in case a prior run's finally was skipped. Cheap and
      // idempotent; makes a clean run recover even after a dirty exit.
      try {
        const orphans = await client.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> $2 AND state <> 'idle'",
          [APP_NAME, myPid ?? 0],
        );
        if (orphans.rows.length > 0) {
          console.warn(`  [rebuild] startup reconcile: found ${orphans.rows.length} orphaned backend(s) from a prior run — cancelling`);
          for (const o of orphans.rows) await client.query("SELECT pg_cancel_backend($1)", [o.pid]);
          await new Promise((r) => setTimeout(r, 3000));
          await client.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> $2 AND state <> 'idle'",
            [APP_NAME, myPid ?? 0],
          );
        }
        await client.query("ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)");
      } catch (reconcileErr) {
        console.warn(`  [rebuild] startup reconcile warning: ${errMsg(reconcileErr)}`);
      }

      try {
        // FIX-588 — raise work_mem for the rebuild session so the donation
        // aggregate's HashAggregate and the recipient_count GROUP BY don't
        // thrash at prod's tiny default (work_mem=3.4MB → 9 hash batches /
        // 23MB temp on a 1/16 sample). One off-peak single-connection session,
        // safe on the 2GB Pro Small.
        await client.query("SET work_mem = '256MB'");
        // FIX-590 — pause autovacuum on entity_connections for the full rebuild.
        // The donations prepare() DELETE leaves ~2.7M dead tuples; with FIX-331's
        // aggressive autovacuum_vacuum_scale_factor=0.05 that trips autovacuum
        // MID-rebuild, and its VACUUM I/O competes with the window INSERTs on the
        // cache-starved Pro Small. On the 2026-06-14 full run that turned donation
        // windows 14-16 from ~4min into 40-57min each (3h08m donations total →
        // 4h budget blown). Disable for the run; re-enable + one manual VACUUM
        // ANALYZE after (success path below) and a belt-and-braces re-enable in
        // the finally so a mid-run failure never leaves it off.
        if (mode === "full") {
          await client.query(
            "ALTER TABLE public.entity_connections SET (autovacuum_enabled = false)",
          );
          console.log("  [rebuild] autovacuum paused on entity_connections (full rebuild)");
        }
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
            let rows: { connection_type: string; edges_upserted: string | number }[];
            if (fn === "rebuild_entity_connections_donations_full") {
              // FIX-588 — windowed sequence (prepare + 16 from_id windows +
              // finalize) instead of the single monolithic call that hit the
              // 90min cap. The 90min statement_timeout set above governs each
              // individual prepare/window/finalize SELECT.
              const n = await runDonationsFullWindowed(client);
              rows = [{ connection_type: "donation", edges_upserted: n }];
            } else {
              const res = await client.query<{ connection_type: string; edges_upserted: string | number }>(
                `SELECT * FROM public.${fn}()`,
              );
              rows = res.rows;
            }
            const chunkDur = Date.now() - chunkStart;
            for (const r of rows) {
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
        // FIX-590 — re-enable autovacuum and do ONE manual VACUUM ANALYZE now
        // that the churn is done, instead of letting autovacuum compete during
        // the rebuild. Wrapped so a VACUUM failure doesn't mask a good rebuild;
        // the finally below re-enables autovacuum regardless.
        if (mode === "full") {
          try {
            await client.query(
              "ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)",
            );
            await client.query("SET statement_timeout = '30min'");
            await client.query("VACUUM (ANALYZE) public.entity_connections");
            console.log("  [post] autovacuum re-enabled + VACUUM ANALYZE entity_connections — complete");
          } catch (vacErr) {
            console.warn(`  [post] post-rebuild VACUUM — FAILED: ${errMsg(vacErr)}`);
          }
        }
      } finally {
        // FIX-590 — ensure autovacuum is back on even if the rebuild threw
        // mid-way (a cancelled/failed full run must never strand it disabled).
        if (mode === "full") {
          try {
            await client.query(
              "ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)",
            );
          } catch {
            /* connection may already be dead — manual re-enable then needed */
          }
        }
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
