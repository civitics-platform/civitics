/**
 * FIX-1130 — the front-door watchdog.
 *
 * Fires every 15 minutes from the `front-door-watch` cron entry in
 * apps/civitics/vercel.json, which invokes this endpoint with
 * `Authorization: Bearer <CRON_SECRET>` — the same protocol
 * /api/cron/platform-snapshot already uses.
 *
 * WHAT IT WATCHES, AND WHY NOTHING ELSE DOES. The Supabase front door
 * (Cloudflare -> Kong -> PostgREST/pooler) can wedge independently of the
 * database and stay wedged after Postgres itself has recovered. On 2026-08-31
 * it did that for about seventeen hours: `edge_logs` shows sixteen consecutive
 * hours at 100.0% Cloudflare-class 52x, and `pg_postmaster_start_time()` still
 * reads 2026-08-31T23:01:12Z — the project restart that cleared it. Nothing
 * paged. The two instruments that could have are both blind by construction:
 * the sync canary rides Postgres, and Cloudflare's own analytics for
 * civitics.com showed ZERO 5xx across the same 24 hours, because the wedge was
 * on the DATA front door, not the website's edge.
 *
 * (The request-path probe was not entirely blind — it went red three times that
 * day, at 11:49, 18:11 and 22:52 UTC, catching a 500 on
 * /api/officials/<id>/responsiveness. But its effective cadence is roughly
 * hourly-to-multi-hourly, its first red was five hours after onset, and a red
 * GitHub Actions run is not a page. This route replays the same day and
 * declares DOWN at 06:47.)
 *
 * ── WHY VERCEL CRON AND NOT GHA, AND WHY ITS OWN ROUTE ────────────────────────
 *
 * GHA cron does not honour sub-hourly schedules here — measured at eight
 * firings in 51 hours against an advertised ten-minute cron (FIX-1127). Vercel is
 * the external driver that already works. It is a SEPARATE route from
 * platform-snapshot on purpose: that route's first act is `createAdminClient()`
 * and a snapshot write, so a wedge that hangs Postgres hangs it — and a
 * watchdog that hangs in the outage it exists to report is not a watchdog
 * (the FIX-1125 lesson).
 *
 * ── THE POSTGRES-FREE CONSTRAINT, HONOURED LITERALLY ─────────────────────────
 *
 * FIX-1130 puts it in scope explicitly: the detector must not depend on a
 * Postgres connection succeeding. So:
 *
 *   * Both instruments are HTTP. The direct probe hits `/rest/v1/` and the
 *     corroborator hits the Supabase Logs API. Neither opens a DB connection.
 *   * The verdict is stateless — `platform_alert_state` and `pipeline_state`
 *     are both Postgres tables — so dedup is derived from the bucket shape plus
 *     the wall clock rather than from stored state. See front-door-verdict.ts.
 *   * The restart decision (FIX-1285) is NOT stateless: it holds DOWN for 30
 *     minutes and spaces and caps restarts, so it keeps four keys in Upstash —
 *     the Postgres-free store the FIX-1125 memory ring already uses. Upstash
 *     not answering means no restart. See front-door-restart.ts.
 *   * The `data_sync_log` breadcrumb at the very end is best-effort, wrapped so
 *     it cannot throw, and runs strictly AFTER the alert has been sent. It
 *     exists so the rollup registry can see this job; it is never load-bearing.
 *
 * ── WHY A 401 FROM THE PROBE MEANS HEALTHY ───────────────────────────────────
 *
 * `GET /rest/v1/` answers 401 "Secret API key required" even with a valid
 * publishable key — PostgREST rejects on key class before touching the
 * database. That is exactly what makes it the right liveness target: it proves
 * the front door is answering without proving anything about Postgres, and it
 * cannot break when a key is rotated. So the predicate is "any HTTP response
 * with status < 500", NOT "200". Do not "fix" this to expect a 200 by pointing
 * it at a table read — that would couple the watchdog to the database again and
 * would have fired through the 2026-09-01 statement-timeout window.
 */

export const dynamic = "force-dynamic";

// Every call is bounded. Phase one runs in parallel: three 5 s probe attempts
// (15 s worst), the Logs read (10 s cap) and the restart state read (3 s) with
// its health GET (5 s, only once DOWN has held 30 min). On a restart tick the
// POST adds 10 s and its state write 3 s: 28 s before the first email, and
// sendEmail has no timeout of its own — during a wedge its usage counter writes
// through the dead front door. 30 s would leave 2, so FIX-1285 raised it to 60.
// A watchdog that can hang is a watchdog that stops reporting exactly when it
// matters.
export const maxDuration = 60;

import { NextResponse, type NextRequest } from "next/server";
import {
  alignBuckets,
  floorToBucket,
  decideFrontDoorVerdict,
  shouldSend,
  renderFrontDoorEmail,
  corroboratorLabel,
  queryEdgeBuckets,
  countDownTick,
  decideRestart,
  issueProjectRestart,
  parseRestartMode,
  planRestartStateCommands,
  readProjectHealth,
  readRestartState,
  renderRestartEmail,
  restartLine,
  restartsWithin24h,
  shouldEmailWouldRestart,
  upstashCredsFromEnv,
  writeRestartState,
  BUCKET_MS,
  BUCKET_COUNT,
  RESTART_HOLD_TICKS,
  type FrontDoorBucket,
  type FrontDoorCorroborator,
  type FrontDoorProbe,
  type ProjectHealth,
  type RestartStateRead,
} from "@civitics/db";
import { sendEmail } from "@/lib/email";

const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 5_000;
const LOGS_TIMEOUT_MS = 10_000;

/**
 * Direct liveness probe against the REST front door.
 *
 * Three attempts because a single transport blip is not an outage; they run in
 * sequence with no backoff, so worst case is ~15 s. "Answered" is any HTTP
 * status below 500 — see the module header for why that, and not 200.
 */
async function probeFrontDoor(baseUrl: string): Promise<FrontDoorProbe> {
  const attempts: FrontDoorProbe["attempts"] = [];
  let answered = false;

  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/rest/v1/`, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      attempts.push({ status: res.status, ms: Date.now() - t0 });
      if (res.status < 500) {
        answered = true;
        break;
      }
    } catch (err) {
      attempts.push({
        status: null,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { answered, attempts };
}

/**
 * Pull the four closed 15-minute buckets ending at `endBoundaryMs`.
 *
 * Through the one Logs helper (`queryEdgeBuckets`, packages/db/src/
 * supabase-logs.ts — FIX-1219), which owns the SQL, the time range, the unit
 * and the endpoint. It is the SAME builder the census's edge half reads, so
 * the two can no longer drift apart: before FIX-1219 each carried its own copy
 * of the BigQuery query, and one removal took both dark on the same morning.
 *
 * ONE query, aggregated server-side. The endpoint caps an answer at 1000 rows
 * silently (measured cc-155) and the helper reads an answer at the cap as
 * dark; four aggregate rows is far inside it.
 *
 * rows is null when the Logs API itself returned nothing, which is NOT evidence
 * of a healthy or unhealthy front door. `corroborator` says which failure it
 * was: `unavailable` is the endpoint gone (410/404 — how `logs.all` answered
 * after its removal), `dark` is anything else, including the endpoint's 429
 * (10 requests / 60 s per token, shared with the census). The verdict then
 * reads corroborator_unavailable, never ok.
 */
async function fetchBuckets(
  endBoundaryMs: number,
  token: string,
): Promise<{ rows: FrontDoorBucket[] | null; corroborator: FrontDoorCorroborator }> {
  const a = await queryEdgeBuckets({
    startMs: endBoundaryMs - BUCKET_COUNT * BUCKET_MS,
    endMs: endBoundaryMs,
    bucketSeconds: BUCKET_MS / 1000,
    token,
    timeoutMs: LOGS_TIMEOUT_MS,
  });
  if (a.kind === "unavailable") {
    return { rows: null, corroborator: { kind: "unavailable", status: a.status, detail: a.detail } };
  }
  if (a.kind === "dark") return { rows: null, corroborator: { kind: "dark", detail: a.detail } };
  return { rows: a.rows, corroborator: { kind: "ok", buckets: a.rows.length } };
}

/**
 * FIX-1285 — what the restart decision needs besides the verdict: its Upstash
 * state, and the project health once it could matter. Runs beside the probe and
 * the Logs read. The health GET (read token, `project_admin_read`) is made only
 * when this tick could be the 4th counted DOWN tick or later (FIX-1286), so a
 * healthy tick costs one MGET.
 */
async function readRestartInputs(
  mgmtToken: string | undefined,
): Promise<{ state: RestartStateRead; health: { health: ProjectHealth; detail: string } }> {
  const creds = upstashCredsFromEnv(process.env);
  const state: RestartStateRead = creds
    ? await readRestartState(creds)
    : { ok: false, error: "UPSTASH_REDIS_REST_URL / _TOKEN not configured" };
  const held = state.ok && (state.state.downTicks ?? 0) + 1 >= RESTART_HOLD_TICKS;
  if (!held) return { state, health: { health: "unknown", detail: `not read (fewer than ${RESTART_HOLD_TICKS - 1} DOWN ticks counted)` } };
  if (!mgmtToken) return { state, health: { health: "unknown", detail: "SUPABASE_MANAGEMENT_API_KEY not configured" } };
  return { state, health: await readProjectHealth(mgmtToken) };
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;
  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_SUPABASE_URL not configured" },
      { status: 503 },
    );
  }

  const nowMs = Date.now();
  const endBoundary = floorToBucket(nowMs);
  const mgmtToken = process.env["SUPABASE_MANAGEMENT_API_KEY"];

  // Both instruments in parallel — they are independent, and the probe's worst
  // case (~15 s) should not serialise behind the Logs API's (~10 s). The
  // restart state read (FIX-1285) rides beside them for the same reason.
  const [probe, logs, restartInputs] = await Promise.all([
    probeFrontDoor(supabaseUrl),
    mgmtToken
      ? fetchBuckets(endBoundary, mgmtToken)
      : Promise.resolve({
          rows: null,
          corroborator: { kind: "dark", detail: "SUPABASE_MANAGEMENT_API_KEY not configured" } as FrontDoorCorroborator,
        }),
    readRestartInputs(mgmtToken),
  ]);

  const buckets = alignBuckets(logs.rows ?? [], endBoundary);
  const verdict = decideFrontDoorVerdict(buckets, probe, logs.corroborator);
  const logsApi = corroboratorLabel(logs.corroborator);
  const send = shouldSend(verdict, nowMs);

  // ── FIX-1285: the restart decision, built on the verdict ─────────────────────
  const { mode, warning: modeWarning } = parseRestartMode(process.env["FRONT_DOOR_AUTO_RESTART"]);
  const restartKey = process.env["SUPABASE_MANAGEMENT_RESTART_KEY"];
  const stored = restartInputs.state.ok ? restartInputs.state.state : null;
  // FIX-1286: only a Logs-arm DOWN advances the hold; the probe is reason-only.
  const { logsDown, downTicks } = countDownTick(verdict, stored);
  const decision = decideRestart({
    verdictState: verdict.state,
    logsDown,
    downTicks,
    probeAnswered: probe.answered,
    nowMs,
    downSinceMs: stored?.downSinceMs ?? null,
    lastRestartMs: stored?.lastRestartMs ?? null,
    restartsLast24h: stored ? restartsWithin24h(stored, nowMs) : 0,
    mode,
    tokenPresent: Boolean(restartKey),
    health: restartInputs.health.health,
    stateError: restartInputs.state.ok ? null : restartInputs.state.error,
  });

  // The POST and its state write go BEFORE any email: sendEmail's usage counter
  // writes through the same front door, so during a wedge an email can hang
  // until Cloudflare gives up, and the restart must not queue behind that.
  const adminEmail = process.env["ADMIN_EMAIL"];
  const call =
    decision.action === "restart" && restartKey ? await issueProjectRestart(restartKey) : null;
  const wouldEmail = Boolean(adminEmail) && shouldEmailWouldRestart(decision, stored);
  const upstash = upstashCredsFromEnv(process.env);
  let stateWrite: string | null = null;
  if (stored && upstash) {
    const commands = planRestartStateCommands({
      logsDown,
      state: stored,
      nowMs,
      restartIssued: call !== null,
      wouldRestartEmailed: wouldEmail,
    });
    if (commands.length > 0) {
      const w = await writeRestartState(upstash, commands);
      stateWrite = w.ok ? `${w.commands} command(s) written` : `FAILED: ${w.error}`;
    }
  }

  let restartEmailed: string | null = null;
  if (adminEmail && (call || wouldEmail)) {
    const { subject, html } = renderRestartEmail({
      kind: call ? "issued" : "would_fire",
      decision,
      mode,
      nowMs,
      health: restartInputs.health,
      call,
      stateWrite,
    });
    const result = await sendEmail({ to: adminEmail, subject, html });
    restartEmailed = result.sent ? "sent" : `failed: ${result.reason}`;
  }

  // ── Alert ─────────────────────────────────────────────────────────────────
  // Gated on ADMIN_EMAIL alone, deliberately NOT on EMAIL_ALERTS_ENABLED. That
  // flag governs the "data is stale" tier FIX-1036 split out; this is the "the
  // site is down" tier, and it should not share a kill switch with a staleness
  // digest.
  let emailed: string | null = null;
  if (send && adminEmail) {
    const { subject, html } = renderFrontDoorEmail({
      verdict,
      buckets,
      probe,
      probeUrl: `${supabaseUrl}/rest/v1/`,
      nowMs,
      restartLine:
        verdict.state === "down"
          ? restartLine(decision, mode) + (modeWarning ? ` (${modeWarning})` : "")
          : null,
    });
    const result = await sendEmail({ to: adminEmail, subject, html });
    emailed = result.sent ? "sent" : `failed: ${result.reason}`;
  } else if (send) {
    emailed = "skipped: ADMIN_EMAIL not configured";
  }

  const body = {
    ok: true,
    state: verdict.state,
    reason: verdict.reason,
    checked_at: new Date(nowMs).toISOString(),
    // Named so a glance at the Vercel log answers "is this thing wired up?"
    // without anyone printing a secret to find out.
    // FIX-1219: "N bucket(s)", "unavailable (410, FIX-1219)" or "dark (…)".
    logs_api: logsApi,
    email_configured: Boolean(adminEmail),
    emailed,
    probe: { answered: probe.answered, attempts: probe.attempts },
    buckets: buckets.map((b, i) => ({
      at: new Date(b.startMs).toISOString(),
      requests: b.requests,
      n_5xx: b.n5xx,
      n_52x: b.n52x,
      red: verdict.red[i] ?? false,
    })),
    // FIX-1285. `none` on a healthy tick; see front-door-restart.ts for the rest.
    restart: {
      action: decision.action,
      reason: decision.reason,
      mode,
      downForMs: decision.downForMs,
      down_ticks: decision.downTicks,
      ...(modeWarning ? { mode_warning: modeWarning } : {}),
      state_store: restartInputs.state.ok ? "ok" : `unreachable: ${restartInputs.state.error}`,
      health: restartInputs.health.health,
      issued: call ? { status: call.status, ms: call.ms } : null,
      state_write: stateWrite,
      emailed: restartEmailed,
    },
  };

  // ── Breadcrumb, strictly after the alert, and structurally unable to break it.
  // If Postgres is reachable this lands a data_sync_log row so the rollup
  // registry can see the job (paired with a rollup_watch_overrides row
  // declaring the 0.25 h cadence, since no pg_cron schedule can express it).
  // If Postgres is NOT reachable — the very case this route exists for — the
  // catch swallows it and the alert has already gone out.
  try {
    const { createAdminClient, noStoreFetch } = await import("@civitics/db");
    await createAdminClient({ fetch: noStoreFetch })
      .from("data_sync_log")
      .insert({
        pipeline: "front_door_watch",
        started_at: new Date(nowMs).toISOString(),
        completed_at: new Date().toISOString(),
        status: verdict.state === "down" ? "partial" : "complete",
        // A blind tick still ran, so it stays "complete": the rollup registry
        // counts only complete rows, and a watch that ran must not read as a
        // watch that stopped. The canary reads the state, report-only (FIX-1219).
        metadata: {
          source: "vercel_cron",
          state: verdict.state,
          reason: verdict.reason,
          logs_api: logsApi,
          probe_answered: probe.answered,
          emailed,
          buckets: body.buckets,
          restart: body.restart,
        },
      });
  } catch {
    // Best-effort by design. See the comment above.
  }

  return NextResponse.json(body);
}
