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
 *   * The verdict is stateless. There is no Postgres-independent state store
 *     in this codebase — `platform_alert_state` and `pipeline_state` are both
 *     Postgres tables — so dedup is derived from the bucket shape plus the wall
 *     clock rather than from stored state. See front-door-verdict.ts.
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

// Bounded well under Vercel's limit: three 5 s probe attempts plus one Logs API
// call with its own 10 s cap. A watchdog that can hang is a watchdog that stops
// reporting exactly when it matters.
export const maxDuration = 30;

import { NextResponse, type NextRequest } from "next/server";
import {
  alignBuckets,
  floorToBucket,
  decideFrontDoorVerdict,
  shouldSend,
  renderFrontDoorEmail,
  BUCKET_MS,
  BUCKET_COUNT,
  type FrontDoorBucket,
  type FrontDoorProbe,
} from "@civitics/db";
import { sendEmail } from "@/lib/email";

const PROJECT_REF = "xsazcoxinpgttgquwvuf";
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
 * ONE query, aggregated server-side. That matters: the Logs API caps a result
 * at roughly 100 rows (measured 2026-09-04 — a 280-bucket range came back with
 * 93 rows covering only the newest ~24 h), so anything that returns raw log
 * lines silently truncates. Four aggregate rows is far inside the cap.
 *
 * Returns null when the Logs API itself is unavailable, which is NOT evidence
 * of a healthy or unhealthy front door — the caller degrades to the direct
 * probe alone rather than guessing.
 */
async function fetchBuckets(
  endBoundaryMs: number,
  token: string,
): Promise<FrontDoorBucket[] | null> {
  const startMs = endBoundaryMs - BUCKET_COUNT * BUCKET_MS;
  const sql = `
select
  timestamp_seconds(div(unix_seconds(t.timestamp), 900) * 900) as b,
  count(*) as requests,
  countif(r.status_code >= 500) as n_5xx,
  countif(r.status_code between 520 and 526) as n_52x
from edge_logs t
cross join unnest(t.metadata) as m
cross join unnest(m.response) as r
group by b
order by b`;

  const url = new URL(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all`,
  );
  url.searchParams.set("sql", sql);
  url.searchParams.set("iso_timestamp_start", new Date(startMs).toISOString());
  url.searchParams.set("iso_timestamp_end", new Date(endBoundaryMs).toISOString());

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(LOGS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: Array<{ b: number; requests: number; n_5xx: number; n_52x: number }>;
    };
    if (!Array.isArray(json.result)) return null;

    // `b` comes back as MICROseconds since epoch.
    return json.result.map((r) => ({
      startMs: Math.round(Number(r.b) / 1000),
      requests: Number(r.requests) || 0,
      n5xx: Number(r.n_5xx) || 0,
      n52x: Number(r.n_52x) || 0,
    }));
  } catch {
    return null;
  }
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
  // case (~15 s) should not serialise behind the Logs API's (~10 s).
  const [probe, rows] = await Promise.all([
    probeFrontDoor(supabaseUrl),
    mgmtToken ? fetchBuckets(endBoundary, mgmtToken) : Promise.resolve(null),
  ]);

  const buckets = alignBuckets(rows ?? [], endBoundary);
  const verdict = decideFrontDoorVerdict(buckets, probe);
  const send = shouldSend(verdict, nowMs);

  // ── Alert ─────────────────────────────────────────────────────────────────
  // Gated on ADMIN_EMAIL alone, deliberately NOT on EMAIL_ALERTS_ENABLED. That
  // flag governs the "data is stale" tier FIX-1036 split out; this is the "the
  // site is down" tier, and it should not share a kill switch with a staleness
  // digest.
  const adminEmail = process.env["ADMIN_EMAIL"];
  let emailed: string | null = null;
  if (send && adminEmail) {
    const { subject, html } = renderFrontDoorEmail({
      verdict,
      buckets,
      probe,
      probeUrl: `${supabaseUrl}/rest/v1/`,
      nowMs,
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
    logs_api: mgmtToken
      ? rows === null
        ? "unavailable"
        : `${rows.length} bucket(s)`
      : "SUPABASE_MANAGEMENT_API_KEY not configured",
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
  };

  // ── Breadcrumb, strictly after the alert, and structurally unable to break it.
  // If Postgres is reachable this lands a data_sync_log row so the rollup
  // registry can see the job (paired with a rollup_watch_overrides row
  // declaring the 0.25 h cadence, since no pg_cron schedule can express it).
  // If Postgres is NOT reachable — the very case this route exists for — the
  // catch swallows it and the alert has already gone out.
  try {
    const { createAdminClient } = await import("@civitics/db");
    await createAdminClient()
      .from("data_sync_log")
      .insert({
        pipeline: "front_door_watch",
        started_at: new Date(nowMs).toISOString(),
        completed_at: new Date().toISOString(),
        status: verdict.state === "down" ? "partial" : "complete",
        metadata: {
          source: "vercel_cron",
          state: verdict.state,
          reason: verdict.reason,
          probe_answered: probe.answered,
          emailed,
          buckets: body.buckets,
        },
      });
  } catch {
    // Best-effort by design. See the comment above.
  }

  return NextResponse.json(body);
}
