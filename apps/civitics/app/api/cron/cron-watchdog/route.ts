/**
 * FIX-1194 P2-A — /api/cron/cron-watchdog
 *
 * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
 *
 * Two two-minute pg_cron jobs enforce every runtime budget this platform has:
 * `cron-job-budget-watchdog` (FIX-1063) and `derived-mvs-unit-watchdog`
 * (FIX-1030/1035). Both are pg_cron jobs, so both need pg_cron to fork a
 * background worker to run at all — and the failure they exist to catch is
 * exactly the one that stops pg_cron forking.
 *
 * Measured: cc-130 counted 117 fork failures during the set-1 drain, 41 of them
 * under an ordinary `contract-flow-rollups-refresh`; FIX-1123 recorded
 * 2026-08-31 06:06-12:05 UTC with EVERY watchdog firing failing `job startup
 * timeout`; cc-139 found 2026-09-07's 12/30 and 10/30 under the FIX-1165 apply
 * with no DB trace at all. So for six hours on 08-31 nothing bounded anything,
 * during the window in which something was over budget.
 *
 * A guard that dies with the patient is not a guard. This is the same lesson
 * FIX-1130 learned for the front door, applied to budget enforcement: put a
 * SECOND, INDEPENDENT firing path on a scheduler that is not the thing under
 * strain. Vercel's cron calls this route; this route calls
 * `run_cron_watchdogs()` through PostgREST on an ordinary `authenticator`
 * connection, which needs no pg_cron worker.
 *
 * ── BELT AND BRACES, NOT BRACES INSTEAD OF BELT ──────────────────────────────
 *
 * pg_cron's two jobs are UNCHANGED and still fire every two minutes. This route
 * is additive. Both paths are idempotent by construction — FIX-1063's ledger is
 * keyed on `runid` (PRIMARY KEY) and FIX-1030's guard is
 * `metadata ? 'watchdog_canceled_at'` — so the two racing cancels a target at
 * most once, whoever wins. `cron_job_budget_action.acted_via` records which
 * one did (FIX-1194), and a `vercel` row inside a window where pg_cron's own
 * firings show `job startup timeout` is the receipt this whole item is for.
 *
 * ── WHY IT CALLS A WRAPPER AND NOT THE TWO FUNCTIONS DIRECTLY ────────────────
 *
 * Because it cannot call them directly. Both are SECURITY INVOKER on purpose
 * (FIX-1030: a DEFINER version would be a "cancel any backend" primitive), and
 * `service_role` has neither `USAGE` on schema `cron` nor membership of
 * `pg_signal_backend` — measured on prod 2026-09-21. `run_cron_watchdogs()` is
 * the narrow DEFINER wrapper that closes that gap without widening the
 * primitive: no parameters, no pid input, and it cancels only what the two
 * existing functions already select on their own unchanged predicates. See the
 * migration header (20260920070000) for the full argument.
 *
 * ── WHY NO data_sync_log ROW ────────────────────────────────────────────────
 *
 * Deliberate. At a two-minute cadence this route runs 720 times a day, and a
 * breadcrumb per firing would be 720 rows/day of noise that the FIX-1011
 * freshness registry would then try to infer a cadence for. The durable trace
 * already exists and is better: the `cron_job_budget_action` ledger (now
 * carrying `acted_via`) and the unit watchdog's own stamp on the
 * `refresh_derived_mvs` row. Both are written only when something actually
 * happened.
 *
 * ── WHY IT ANSWERS 200 ON FAILURE ────────────────────────────────────────────
 *
 * Vercel retries nothing on a cron 5xx, so a 5xx buys no recovery — it only
 * turns the deployment dashboard red and trains the reader to ignore it. The
 * failure is reported in the body and in a `console.error` line, which is where
 * it can actually be found. The one exception is the auth check, which answers
 * 401 as every sibling cron route does.
 */

export const dynamic = "force-dynamic";

// Bounded well under Vercel's limit. The RPC has two real bounds already —
// `authenticator`'s 8 s role-level statement_timeout (inherited by
// service_role) and the 10 s client race below — and this is the third fence
// rather than a fourth timer: a watchdog route that can hang is a watchdog that
// stops reporting exactly when it matters.
export const maxDuration = 30;

import { NextResponse, type NextRequest } from "next/server";
import { decideCronWatchdogVerdict } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";

/** The client-side race. See the header: this is bound #2 of two, not a third. */
const RPC_TIMEOUT_MS = 10_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Kill switch without a deploy — the nightly-sync precedent.
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
    // Lazy, inside the try, for the FIX-1130 reason: module-scope client
    // construction makes the route fail before it can report anything.
    const { createAdminClient } = await import("@civitics/db");
    const db = createAdminClient();

    const { data, error } = await withDbTimeout(
      db.rpc("run_cron_watchdogs"),
      RPC_TIMEOUT_MS,
      "cron-watchdog",
    );

    if (error) {
      console.error(`[cron/cron-watchdog] RPC failed: ${error.message}`);
      return NextResponse.json({
        ok: false,
        reason: error.message,
        elapsed_ms: Date.now() - startedAt,
      });
    }

    const verdict = decideCronWatchdogVerdict(data);
    if (verdict.ok) {
      console.log(verdict.line);
    } else {
      console.error(verdict.line);
    }

    return NextResponse.json({
      ok: verdict.ok,
      checked: verdict.checked,
      canceled: verdict.canceled,
      unit_action: verdict.unitAction,
      labelled: verdict.labelled,
      cancelled_jobs: verdict.cancelledJobs,
      errors: verdict.errors,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[cron/cron-watchdog] ${reason}`);
    return NextResponse.json({ ok: false, reason, elapsed_ms: Date.now() - startedAt });
  }
}
