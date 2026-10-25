/**
 * FIX-1218 — /api/cron/gha-dispatch/<stem>   (nightly-request | sync-canary-check | platform-snapshot)
 *
 * N2 (FIX-1336, cc-243): `nightly-request` fires only on the dispatcher's
 * unconsumed request stamp (pipeline_state.gha_dispatch_request_nightly) and
 * consumes it. The legacy `nightly` slot, and the job_registry read that gated
 * it, were removed by FIX-1350 (cc-249): `/nightly` now gets the allowlist's
 * 400. The logic is runGhaDispatch() in lib/gha-dispatch.ts; this file wires
 * the deps.
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
import {
  dispatchWorkflow,
  resolveDispatchTarget,
  runGhaDispatch,
  type GhaDispatchDeps,
  type GhaDispatchRequest,
} from "@/lib/gha-dispatch";

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

  // The admin client, built lazily inside a try for the FIX-1130 reason:
  // module-scope client construction makes the route fail before it can report
  // anything. FIX-1208 — `no-store`, or a read/RPC can be answered from the
  // Data Cache and never sent: force-dynamic does not stop Next 14.2 caching a
  // fetch inside a GET Route Handler. See `noStoreFetch`.
  type Db = ReturnType<typeof import("@civitics/db").createAdminClient>;
  let dbPromise: Promise<Db> | null = null;
  const getDb = (): Promise<Db> => {
    dbPromise ??= import("@civitics/db").then(({ createAdminClient, noStoreFetch }) =>
      createAdminClient({ fetch: noStoreFetch }),
    );
    return dbPromise;
  };
  const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const deps: GhaDispatchDeps = {
    // N2: the dispatcher's request stamp (service_role reads pipeline_state).
    readRequest: async (stem) => {
      try {
        const db = await getDb();
        const { data, error } = await withDbTimeout(
          db.from("pipeline_state").select("value").eq("key", `gha_dispatch_request_${stem}`).maybeSingle(),
          STAMP_TIMEOUT_MS,
          "gha-dispatch-request",
        );
        if (error) return { value: null, error: error.message };
        const value = (data as { value?: unknown } | null)?.value;
        return { value: value && typeof value === "object" ? (value as GhaDispatchRequest) : null, error: null };
      } catch (err) {
        return { value: null, error: msg(err) };
      }
    },
    recordDispatch: async (p) => {
      try {
        const db = await getDb();
        const { data, error } = await withDbTimeout(db.rpc("record_gha_dispatch", { p }), STAMP_TIMEOUT_MS, "gha-dispatch-stamp");
        if (error) return { at: null, error: error.message };
        const at = (data as { at?: unknown } | null)?.at;
        return { at: typeof at === "string" ? at : null, error: null };
      } catch (err) {
        return { at: null, error: msg(err) };
      }
    },
    consumeRequest: async (stem, outcome, http) => {
      try {
        const db = await getDb();
        const { error } = await withDbTimeout(
          db.rpc("consume_gha_dispatch_request", { p_stem: stem, p_outcome: outcome, p_http: http ?? undefined }),
          STAMP_TIMEOUT_MS,
          "gha-dispatch-consume",
        );
        return { error: error ? error.message : null };
      } catch (err) {
        return { error: msg(err) };
      }
    },
    dispatch: (t) => dispatchWorkflow(t, process.env["GITHUB_DISPATCH_TOKEN"]),
  };

  const result = await runGhaDispatch(target, deps);
  if (result.error) console.error(result.line);
  else console.info(result.line);
  return NextResponse.json(result.body);
}
