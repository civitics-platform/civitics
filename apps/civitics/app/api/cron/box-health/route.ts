/**
 * FIX-1125 / FIX-1194 P1-B — /api/cron/box-health
 *
 * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
 *
 * Nothing on this platform recorded the database box's memory. cc-145 read the
 * 09-22 outage: a MemAvailable series at 2-minute resolution would have shown
 * the ramp in the ten minutes before the fork failure, and the snapshot route,
 * the one thing that scrapes the metrics endpoint, wrote no rows 15:30–22:00
 * that day because it writes to the database it was measuring. So this route
 * scrapes the endpoint every 2 minutes and keeps the sample OFF the box first.
 *
 * ── ORDER, AND WHAT EACH HALF IS FOR ─────────────────────────────────────────
 *
 *   (a) OFF the box, first: an Upstash ring, `civitics:box_health:mem`,
 *       LPUSH + LTRIM 0 899 = 30 h at 2 min (FIX-1289), 2 commands a sample. The ring's
 *       head is the latest sample (cc-153 dropped the duplicate `SET … latest`).
 *       It needs no Postgres, so it keeps the ramp through an outage (rule 20).
 *       This write is the deliverable, and it decides `ok`.
 *   (b) ON the box, second, best-effort: `record_box_health_mem()` upserts
 *       `pipeline_state.box_health_mem`, the stamp box_is_saturated() reads
 *       into its readings. A failure is logged and changes nothing else. It is
 *       also expected to fail between this deploy and the migration's Pro
 *       apply, when the RPC does not exist yet.
 *
 * All of it lives in `runBoxHealth()` (packages/db/src/box-health-store.ts),
 * where every branch is tested with a fake fetch. This file only wires env,
 * the no-store fetch and the RPC.
 *
 * ── BLIND SPOT, stated ───────────────────────────────────────────────────────
 *
 * The metrics endpoint is served from the same host as the ingress that
 * returned 522 on 09-22 from 16:00. The series shows the ramp BEFORE a failure
 * and goes dark WITH it. The off-box ring keeps the ramp. That is the design's
 * point, and it is not a bound on anything (FIX-1125's title stands).
 *
 * ── A SEPARATE ROUTE (rule 38) ───────────────────────────────────────────────
 *
 * Not folded into /api/cron/cron-watchdog. That route has one rule, one
 * predicate and one file, and a memory scrape that failed or ran long there
 * would share a firing with the budget guard.
 *
 * ── THE DISPATCHER RE-FIRE (FIX-1308) ────────────────────────────────────────
 *
 * After the memory work, one more read: the newest dispatch_log.ticked_at.
 * The dispatcher ticks on odd minutes from pg_cron; when its newest row is
 * more than 360 s old (three missed ticks), this route calls
 * dispatch_one_unit('vercel') once — the second path, for the same reason
 * the budget watchdog has one (FIX-1194 P2-A). The function reads the box and
 * the pause dial itself; the route only decides whether to call. The decision
 * is the pure shouldRefireDispatcher() in src/lib/dispatcher-refire.ts.
 *
 * No data_sync_log row, for the cron-watchdog reason: 720 firings a day would be
 * noise the freshness registry would try to infer a cadence from. Answers 200
 * on every failure except auth, for the same reason as its sibling.
 */

export const dynamic = "force-dynamic";

// Bounded under Vercel's limit: a 10 s scrape, a 5 s Upstash write, the RPC's
// 10 s race, and the dispatcher's two 2 s races (FIX-1308) — 29 s worst case.
export const maxDuration = 30;

import { NextResponse, type NextRequest } from "next/server";
import { withDbTimeout } from "@/lib/supabase-check";
import { shouldRefireDispatcher } from "@/lib/dispatcher-refire";

const RPC_TIMEOUT_MS = 10_000;
// FIX-1308 — the dispatch_log read is one indexed row and the re-fire is a
// tens-of-ms function; 2 s each keeps the route inside maxDuration. A re-fire
// the race abandons still runs to completion server-side and logs its row.
const DISPATCH_TIMEOUT_MS = 2_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (process.env["CRON_DISABLED"] === "true") {
    return NextResponse.json({ ok: true, skipped: true, reason: "CRON_DISABLED flag" });
  }

  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;
  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    // Lazy, inside the try (FIX-1130): module-scope construction would fail
    // the route before it could report anything.
    const { createAdminClient, noStoreFetch, runBoxHealth } = await import("@civitics/db");
    const db = createAdminClient({ fetch: noStoreFetch });

    const result = await runBoxHealth({
      env: {
        SUPABASE_SECRET_KEY: process.env["SUPABASE_SECRET_KEY"],
        UPSTASH_REDIS_REST_URL: process.env["UPSTASH_REDIS_REST_URL"],
        UPSTASH_REDIS_REST_TOKEN: process.env["UPSTASH_REDIS_REST_TOKEN"],
      },
      // rule 171 / FIX-1208: every fetch in this route is no-store. The store
      // passes `cache: "no-store"` itself too; this is the second fence.
      fetchImpl: noStoreFetch,
      stampOnBox: async (sample) => {
        const { data, error } = await withDbTimeout(
          db.rpc("record_box_health_mem", { p: sample }),
          RPC_TIMEOUT_MS,
          "box-health",
        );
        if (error) return { at: null, error: error.message };
        const at = (data as { at?: unknown } | null)?.at;
        return { at: typeof at === "string" ? at : null, error: null };
      },
    });

    if (result.ok) console.info(result.line);
    else console.error(result.line);

    // FIX-1308 — the dispatcher's second path. Read the newest dispatch_log
    // row; when it is more than 360 s old (three missed odd-minute ticks),
    // call the tick's function once. dispatch_one_unit() reads the box and the
    // pause dial itself, so this route decides only whether to call. Until the
    // tables reach Pro the read fails "absent", which is expected and quiet.
    const dispatchRead = await withDbTimeout(
      db.from("dispatch_log").select("ticked_at").order("ticked_at", { ascending: false }).limit(1),
      DISPATCH_TIMEOUT_MS,
      "box-health:dispatch",
    );
    const lastTickAt =
      (dispatchRead.data as Array<{ ticked_at: string }> | null)?.[0]?.ticked_at ?? null;
    const verdict = shouldRefireDispatcher({
      read: { lastTickAt, error: dispatchRead.error },
      now: new Date(),
    });
    let refireResult: unknown = null;
    if (verdict.refire) {
      const { data, error } = await withDbTimeout(
        db.rpc("dispatch_one_unit", { p_source: "vercel" }),
        DISPATCH_TIMEOUT_MS,
        "box-health:dispatch",
      );
      refireResult = error ? { error: error.message } : data;
      const d = (data ?? {}) as { decision?: unknown; job?: unknown; reason?: unknown };
      // PGRST202: the function is not on this database (before the push, or
      // after a ROLLBACK that dropped it). Expected, so not an error line.
      if (error && (error as { code?: string }).code === "PGRST202") console.info(`[cron/box-health] dispatcher re-fire skipped: dispatch_one_unit absent`);
      else if (error) console.error(`[cron/box-health] dispatcher re-fire failed: ${error.message}`);
      else console.info(`[cron/box-health] dispatcher re-fired (${verdict.reason}): ${String(d.decision)} ${String(d.job ?? "-")} — ${String(d.reason ?? "")}`);
    } else if (dispatchRead.error && !verdict.notLanded) {
      console.error(`[cron/box-health] ${verdict.reason}`);
    }

    return NextResponse.json({
      ok: result.ok,
      sample: result.sample,
      off_box: result.off_box,
      on_box: result.on_box,
      ambiguous: result.ambiguous,
      dispatcher: {
        checked: true,
        last_tick_at: lastTickAt,
        refired: verdict.refire,
        reason: verdict.reason,
        result: refireResult,
      },
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[cron/box-health] ${reason}`);
    return NextResponse.json({ ok: false, reason, elapsed_ms: Date.now() - startedAt });
  }
}
