/**
 * The 57014 / front-door census — cc-132's stop-rule gate (f), as a command.
 *
 * WHY THIS EXISTS. `receipts-daily.ts` listed statement-cancellation counts
 * under NOT_CAPTURABLE with the sentence "There is no repo script for it
 * today", and every prompt that has needed the number has hand-assembled a
 * Logs API URL from that note. A gate quoted in four prompts and implemented in
 * none of them is a gate nobody can check the same way twice.
 *
 *   pnpm --filter @civitics/data data:census:cancellations:prod
 *   pnpm --filter @civitics/data data:census:cancellations:prod -- --minutes 90 --json
 *
 * NO POSTGRES. Everything here is HTTP against the Supabase Analytics
 * (Logflare) API. That is not incidental: the census exists to be readable
 * exactly when the box is unwell, and an instrument that opens a DB connection
 * to report a DB problem is the FIX-1125 lesson (`front-door-watch/route.ts`
 * carries the same constraint for the same reason). There is no `:local`
 * variant because there is no local Logs API.
 *
 * FLAGS
 *   --minutes N        window length, default 60
 *   --end <iso>        window end, default now
 *   --baseline <n>     cancellations/min, default 0.033 (cc-129's measurement,
 *                      quoted in docs/audits/2026-09-17-fix1187-prod-apply.md).
 *                      The flag exists so a prompt RE-STATES the baseline it is
 *                      gating against rather than inheriting a default nobody
 *                      re-derived; the script prints which value it used either
 *                      way, so a stale default is at least visible.
 *   --json             machine-readable; the verdicts are the same either way.
 *
 * EXIT CODES — so a prompt can gate on the process rather than on prose.
 *   0  both gates PASS
 *   1  either gate FAILs
 *   2  the Logs API answered anything but 200, or the key is missing
 */

import {
  buildAttributionSql,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  sanitizeLike,
  verdictFor,
  ATTRIBUTABLE_FIELDS,
  LOGS_RETENTION_DAYS,
  MAX_ATTRIBUTION_MINUTES,
  type AttributableField,
  type AttributionRow,
  type CancellationBucket,
  type EdgeBucket,
} from "../lib/cancellation-census";

const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const LOGS_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all`;
const TIMEOUT_MS = 20_000;
const EDGE_BUCKET_MS = 15 * 60 * 1000;

/** cc-129's measured baseline. Stated here once; every other mention quotes it. */
const DEFAULT_BASELINE = 0.033;

/**
 * Per-minute cancellation buckets out of `postgres_logs`.
 *
 * Both classes in ONE query rather than two: `statement timeout` is the 57014
 * the gate is about, and `user request` is a cancel somebody issued by hand —
 * which is a different event with a different cause (it is what a `Ctrl-C` or a
 * `pg_cancel_backend` looks like from here) and must not inflate the gated
 * number. Reported alongside, never added in.
 *
 * `countif` is Logflare's BigQuery dialect. The aggregate is server-side, so a
 * 60-minute window returns 60 rows at most — far inside the ~100-row cap that
 * makes the front-door route's own query safe.
 */
const SQL_CANCELLATIONS = `
select
  timestamp_seconds(div(unix_seconds(t.timestamp), 60) * 60) as b,
  countif(t.event_message like '%canceling statement due to statement timeout%') as n_timeout,
  countif(t.event_message like '%canceling statement due to user request%') as n_user
from postgres_logs t
group by b
order by b`;

/**
 * The front-door 5xx aggregate.
 *
 * COPIED VERBATIM from `fetchBuckets()` in
 * `apps/civitics/app/api/cron/front-door-watch/route.ts`, and deliberately not
 * imported: that file lives in `apps/` and this one in `packages/data`, so
 * sharing it means a new `packages/db` Logs-API helper. That is the right
 * refactor and the wrong week for it — it would put a new shared module on the
 * request path of the front-door watchdog on the Friday before a prod op. If a
 * third consumer appears, file it.
 *
 * Keep the two in step: the shape that matters is the double `unnest` down to
 * `m.response` and `r.status_code`, and `b` coming back in MICROseconds.
 */
const SQL_EDGE = `
select
  timestamp_seconds(div(unix_seconds(t.timestamp), 900) * 900) as b,
  count(*) as requests,
  countif(r.status_code >= 500) as n_5xx
from edge_logs t
cross join unnest(t.metadata) as m
cross join unnest(m.response) as r
group by b
order by b`;

interface Args {
  minutes: number;
  endMs: number;
  baseline: number;
  json: boolean;
  /** Non-null puts the script in attribution mode: no verdict, always exit 0. */
  by: AttributableField | null;
  like: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    minutes: 60,
    endMs: Date.now(),
    baseline: DEFAULT_BASELINE,
    json: false,
    by: null,
    like: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--minutes":
        a.minutes = Number(v);
        i++;
        break;
      case "--end": {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new Error(`--end is not an ISO timestamp: ${v}`);
        a.endMs = t;
        i++;
        break;
      }
      case "--baseline":
        a.baseline = Number(v);
        i++;
        break;
      case "--by": {
        const f = String(v);
        if (!isAttributableField(f)) {
          throw new Error(
            `--by ${f} is not a parsed field on a cancellation row. ` +
              `Known: ${ATTRIBUTABLE_FIELDS.join(", ")}`,
          );
        }
        a.by = f;
        i++;
        break;
      }
      case "--like": {
        const l = sanitizeLike(String(v));
        if (l === null) {
          throw new Error(
            `--like ${v} is not usable: 1-120 chars of [A-Za-z0-9_. :/-] only ` +
              "(it is interpolated into a SQL string literal)",
          );
        }
        a.like = l;
        i++;
        break;
      }
      case "--json":
        a.json = true;
        break;
      case "--help":
        console.log(
          "Usage: cancellation-census [--minutes N] [--end <iso>] [--baseline <per-min>] [--json]\n" +
            "       cancellation-census --by <field> [--like <substring>] [--minutes N] [--end <iso>] [--json]\n" +
            `       fields: ${ATTRIBUTABLE_FIELDS.join(", ")}`,
        );
        process.exit(0);
        break;
      default:
        if (argv[i]!.startsWith("--")) throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (!Number.isFinite(a.minutes) || a.minutes <= 0) throw new Error("--minutes must be > 0");
  if (!Number.isFinite(a.baseline) || a.baseline < 0) throw new Error("--baseline must be >= 0");
  if (a.like !== null && a.by === null) throw new Error("--like needs --by (it narrows an attribution)");
  // The clamp, refused rather than silently under-reported. See
  // MAX_ATTRIBUTION_MINUTES for the measurement this rests on.
  if (a.by !== null && a.minutes > MAX_ATTRIBUTION_MINUTES) {
    throw new Error(
      `--minutes ${a.minutes} exceeds the Logs API's measured ${MAX_ATTRIBUTION_MINUTES}-minute ` +
        "answer window. Above it the API returns the OLDEST 24 h of the range asked for, with " +
        "no error and no short result — a wrong answer that looks like a right one. Walk a " +
        `longer span with repeated --end runs instead (retention is ${LOGS_RETENTION_DAYS} days).`,
    );
  }
  return a;
}

/** null on any non-200 / malformed answer — the caller turns that into exit 2. */
async function query<T>(sql: string, startMs: number, endMs: number, token: string): Promise<T[] | null> {
  const url = new URL(LOGS_URL);
  url.searchParams.set("sql", sql);
  url.searchParams.set("iso_timestamp_start", new Date(startMs).toISOString());
  url.searchParams.set("iso_timestamp_end", new Date(endMs).toISOString());
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[census] Logs API ${res.status} ${res.statusText}`);
      return null;
    }
    const json = (await res.json()) as { result?: T[] };
    return Array.isArray(json.result) ? json.result : null;
  } catch (err) {
    console.error(`[census] Logs API request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env["SUPABASE_MANAGEMENT_API_KEY"];
  if (!token) {
    console.error(
      "[census] SUPABASE_MANAGEMENT_API_KEY is not set. It lives in .env.local.prod;\n" +
        "         run this through the :prod package script, which passes --env-file.",
    );
    process.exit(2);
  }

  const startMs = args.endMs - args.minutes * 60_000;

  // ── attribution mode ──────────────────────────────────────────────────────
  // Deliberately BEFORE the gate queries and deliberately terminal: this asks
  // which statement is being cancelled, which is not a health question, so it
  // runs neither gate and exits 0 on every outcome including "nothing matched".
  // Conflating the two is how an instrument becomes a gate nobody trusts.
  if (args.by !== null) {
    const sql = buildAttributionSql(args.by, args.like);
    const rows = await query<{ g: string | null; n: number }>(sql, startMs, args.endMs, token);
    if (rows === null) {
      console.error("[census] the Logs API did not answer — no attribution. (exit 2)");
      process.exit(2);
    }
    const parsed: AttributionRow[] = rows.map((r) => ({
      group: r.g === null || r.g === "" ? "(null)" : String(r.g),
      count: Number(r.n) || 0,
    }));
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            window: { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes },
            by: args.by,
            like: args.like,
            sql,
            rows: parsed,
            gate: null,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `\n${formatAttribution({
          rows: parsed,
          field: args.by,
          like: args.like,
          startIso: iso(startMs),
          endIso: iso(args.endMs),
        })}`,
      );
    }
    // RETURN, not process.exit(0). Calling process.exit() here aborts the
    // process on Windows — `Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING), src\win\async.c` — and the shell sees 127, not 0.
    // The gate path below survives it only because awaiting TWO fetches leaves
    // undici's handle far enough through teardown by the time it exits. One
    // fetch does not, so this path lets the loop drain on its own instead.
    // Measured both ways on this box; the exit code is the whole contract here.
    process.exitCode = 0;
    return;
  }

  // The edge half is bucketed at 15 min and gated on the last CLOSED bucket, so
  // it reads a whole-bucket-aligned window ending at the last boundary already
  // past. Sharing the cancellation window would gate on a bucket still filling.
  const edgeEnd = Math.floor(args.endMs / EDGE_BUCKET_MS) * EDGE_BUCKET_MS;
  const edgeStart = edgeEnd - 4 * EDGE_BUCKET_MS;

  const [cRows, eRows] = await Promise.all([
    query<{ b: number; n_timeout: number; n_user: number }>(SQL_CANCELLATIONS, startMs, args.endMs, token),
    query<{ b: number; requests: number; n_5xx: number }>(SQL_EDGE, edgeStart, edgeEnd, token),
  ]);

  if (cRows === null || eRows === null) {
    console.error("[census] the Logs API did not answer — no verdict. (exit 2)");
    process.exit(2);
  }

  // `b` comes back in MICROseconds, same as the front-door route.
  const cancellations: CancellationBucket[] = cRows.map((r) => ({
    startMs: Math.round(Number(r.b) / 1000),
    timeouts: Number(r.n_timeout) || 0,
    userRequests: Number(r.n_user) || 0,
  }));
  const edge: EdgeBucket[] = eRows.map((r) => ({
    startMs: Math.round(Number(r.b) / 1000),
    requests: Number(r.requests) || 0,
    n5xx: Number(r.n_5xx) || 0,
  }));

  const v = verdictFor({ cancellations, minutes: args.minutes, baseline: args.baseline });
  const ev = edgeVerdictFor(edge);
  const userTotal = cancellations.reduce((n, b) => n + b.userRequests, 0);
  const zeroMinutes = args.minutes - cancellations.filter((b) => b.timeouts > 0).length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes },
          cancellations: { ...v, user_requests: userTotal, gate: "ratio <= 2" },
          edge: {
            window: { start: iso(edgeStart), end: iso(edgeEnd) },
            buckets: edge,
            ...ev,
            gate: "last closed bucket 5xx <= 1 %",
          },
          pass: v.pass && ev.pass,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n── 57014 census ── ${iso(startMs)} → ${iso(args.endMs)} (${args.minutes} min)`);
    const nonZero = cancellations.filter((b) => b.timeouts > 0 || b.userRequests > 0);
    if (nonZero.length === 0) {
      console.log("  no cancellation of either class in any minute of the window");
    } else {
      console.log(`  ${"minute".padEnd(22)}  timeout  user`);
      for (const b of nonZero) {
        console.log(`  ${iso(b.startMs).padEnd(22)}  ${String(b.timeouts).padStart(7)}  ${String(b.userRequests).padStart(4)}`);
      }
    }
    console.log(`  ${zeroMinutes} minute(s) with zero statement-timeout cancellations`);
    console.log(
      `\n  total ${v.total}  rate ${v.rate.toFixed(4)}/min  baseline ${v.baseline}/min  ` +
        `ratio ${v.ratio.toFixed(2)}x  (gate <= ${2}x)  → ${v.pass ? "PASS" : "FAIL"}`,
    );
    console.log(`  cancelled by hand (user request, NOT gated): ${userTotal}`);

    console.log(`\n── front door ── ${iso(edgeStart)} → ${iso(edgeEnd)} (15-min buckets)`);
    console.log(`  ${"bucket".padEnd(22)}  requests   5xx      %`);
    for (const b of edge) {
      const pct = b.requests > 0 ? ((b.n5xx / b.requests) * 100).toFixed(2) : "—";
      console.log(
        `  ${iso(b.startMs).padEnd(22)}  ${String(b.requests).padStart(8)}  ${String(b.n5xx).padStart(4)}  ${String(pct).padStart(6)}`,
      );
    }
    console.log(`\n  last closed bucket: ${ev.note}  (gate <= 1 %)  → ${ev.pass ? "PASS" : "FAIL"}`);
    console.log(
      `\n  VERDICT: ${v.pass && ev.pass ? "PASS" : "FAIL"} — cc-131 read 7 (f), the drain-and-wait\n` +
        `  gate in docs/cc/PROMPT_TEMPLATE.md. Quote both numbers WITH this window.`,
    );
  }

  process.exit(v.pass && ev.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[census] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
