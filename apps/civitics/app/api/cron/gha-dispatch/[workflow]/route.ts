/**
 * FIX-1218 — /api/cron/gha-dispatch/<stem>   (nightly | sync-canary-check | platform-snapshot)
 *
 * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
 *
 * GitHub runs a scheduled workflow when it gets round to it. nightly.yml's
 * `0 21 * * *` has started 1.59–2.74 h after its slot on all 14 nights since
 * 09-10 (median 2.11 h); platform-snapshot.yml, the FIX-1026 outage pager, is
 * configured for every ten minutes and ran 13 times in 48 h; sync-canary-check's
 * `0 5` lands 3.7–5.3 h late (cc-150 read 2). The offset is specific to the cron
 * hour and stable over days (rule 79), and GitHub does not pre-queue (rule 83),
 * so no cron edit removes it.
 *
 * A Vercel cron is on time to the minute. It calls this route; the route POSTs
 * GitHub's workflow_dispatch endpoint; the run starts at the slot. Each
 * workflow's `schedule:` trigger is KEPT as the fallback. For the nightly that
 * costs one runner-minute a day — its fec-phase preflight finds the dispatched
 * run's rows for the nominal day and every phase is skipped (FIX-1218 D3). The
 * other two are idempotent by nature.
 *
 * ── THE STAMP, ON EVERY CALL (rule 167) ──────────────────────────────────────
 *
 * GitHub gives a refused dispatch no failure signal of its own: no run is
 * created, and a run that does not exist notifies nobody. So every call —
 * dispatched, refused (an EXPIRED fine-grained PAT is a 401 one year after it
 * was minted), or error — is stamped via record_gha_dispatch() into
 * pipeline_state.gha_dispatch_<stem>. The receipts read the nightly's stamp in
 * section 1 and the canary reports gha_dispatch_refused / gha_dispatch_stale. A
 * stamp that fails is logged and reported in the body; it never blocks the
 * dispatch, which has already happened by then.
 *
 * ── WHY IT ANSWERS 200 ON A REFUSAL ──────────────────────────────────────────
 *
 * The cron-watchdog route's reasoning, unchanged: Vercel retries nothing on a
 * cron 5xx, so a 5xx buys no recovery and only trains the reader to ignore the
 * dashboard. The truth is in the stamp and in one log line. Exceptions: 401 for
 * the auth check (as every sibling cron route), and 400 for a workflow outside
 * the allowlist — that request never reaches GitHub and has no stamp to write,
 * because a stamp keyed on caller input is exactly what the allowlist refuses.
 */

export const dynamic = "force-dynamic";

// GitHub's own timeout below is 10 s and the stamp RPC is raced at 10 s; 30 s
// is the fence around both, the cron-watchdog route's value.
export const maxDuration = 30;

import { NextResponse, type NextRequest } from "next/server";
import { withDbTimeout } from "@/lib/supabase-check";
import { dispatchLogLine, dispatchWorkflow, resolveDispatchTarget } from "@/lib/gha-dispatch";

const STAMP_TIMEOUT_MS = 10_000;

export async function GET(
  request: NextRequest,
  { params }: { params: { workflow: string } },
): Promise<NextResponse> {
  // Kill switch without a deploy — the nightly-sync precedent.
  if (process.env["CRON_DISABLED"] === "true") {
    return NextResponse.json({ ok: true, skipped: true, reason: "CRON_DISABLED flag" });
  }

  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;
  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const param = params.workflow;
  const target = resolveDispatchTarget(param);
  if (target === null) {
    console.error(`[cron/gha-dispatch] workflow=${JSON.stringify(param)} is not in the allowlist — refused, not dispatched`);
    return NextResponse.json({ ok: false, error: "workflow not in allowlist" }, { status: 400 });
  }

  const startedAt = Date.now();
  const outcome = await dispatchWorkflow(target, process.env["GITHUB_DISPATCH_TOKEN"]);

  // The stamp. Lazy import inside the try for the FIX-1130 reason: module-scope
  // client construction makes the route fail before it can report anything.
  let dbAt: string | null = null;
  let stampError: string | null = null;
  try {
    const { createAdminClient, noStoreFetch } = await import("@civitics/db");
    // FIX-1208 — `no-store`, or the RPC can be answered from the Data Cache and
    // never sent: force-dynamic does not stop Next 14.2 caching a fetch inside
    // a GET Route Handler. See `noStoreFetch`.
    const db = createAdminClient({ fetch: noStoreFetch });
    const { data, error } = await withDbTimeout(
      db.rpc("record_gha_dispatch", {
        p: {
          workflow_stem: target.stem,
          workflow: target.workflow,
          status: outcome.status,
          http_status: outcome.http_status,
          run_id: outcome.run_id,
          detail: outcome.detail,
          elapsed_ms: outcome.elapsed_ms,
        },
      }),
      STAMP_TIMEOUT_MS,
      "gha-dispatch-stamp",
    );
    if (error) {
      stampError = error.message;
    } else {
      const at = (data as { at?: unknown } | null)?.at;
      dbAt = typeof at === "string" ? at : null;
    }
  } catch (err) {
    stampError = err instanceof Error ? err.message : String(err);
  }

  const line = dispatchLogLine(target, outcome, dbAt);
  if (outcome.status === "dispatched" && stampError === null) {
    console.log(line);
  } else {
    console.error(stampError === null ? line : `${line} stamp_error=${JSON.stringify(stampError)}`);
  }

  return NextResponse.json({
    ok: outcome.status === "dispatched",
    workflow: target.workflow,
    status: outcome.status,
    http_status: outcome.http_status,
    run_id: outcome.run_id,
    detail: outcome.detail,
    at: dbAt,
    ...(stampError === null ? {} : { stamp_error: stampError }),
    elapsed_ms: Date.now() - startedAt,
  });
}
