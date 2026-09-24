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
 *       LPUSH + LTRIM 0 719 = 24 h at 2 min, plus `civitics:box_health:latest`.
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
 * No data_sync_log row, for the cron-watchdog reason: 720 firings a day would be
 * noise the freshness registry would try to infer a cadence from. Answers 200
 * on every failure except auth, for the same reason as its sibling.
 */

export const dynamic = "force-dynamic";

// Bounded well under Vercel's limit: a 10 s scrape, a 5 s Upstash write, and
// the RPC's 10 s race.
export const maxDuration = 30;

import { NextResponse, type NextRequest } from "next/server";
import { withDbTimeout } from "@/lib/supabase-check";

const RPC_TIMEOUT_MS = 10_000;

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
        const db = createAdminClient({ fetch: noStoreFetch });
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

    if (result.ok) console.log(result.line);
    else console.error(result.line);

    return NextResponse.json({
      ok: result.ok,
      sample: result.sample,
      off_box: result.off_box,
      on_box: result.on_box,
      ambiguous: result.ambiguous,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[cron/box-health] ${reason}`);
    return NextResponse.json({ ok: false, reason, elapsed_ms: Date.now() - startedAt });
  }
}
