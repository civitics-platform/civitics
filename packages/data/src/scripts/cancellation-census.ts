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
 * NO POSTGRES. Everything here is HTTP against the Supabase Management API's
 * `logs` endpoint, through the one Logs helper (`packages/db/src/
 * supabase-logs.ts` — the SQL, the time range and the unit all live there,
 * FIX-1219). That is not incidental: the census exists to be readable exactly
 * when the box is unwell, and an instrument that opens a DB connection to
 * report a DB problem is the FIX-1125 lesson (`front-door-watch/route.ts`
 * carries the same constraint for the same reason, and reads through the same
 * helper). There is no `:local` variant because there is no local Logs API.
 *
 * FLAGS
 *   --minutes N        window length, default 60, at most 1440 in either mode
 *                      (the endpoint answers the OLDEST 24 h of a longer range)
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
 *   2  dark: the Logs API did not answer (a 5xx, a 429, a timeout, a network
 *      error, a 200 carrying an error or no result array), or the key is missing
 *   8  unavailable: the endpoint is GONE (410, or 404 on the same path) — how
 *      `logs.all` answered from 2026-09-24 until FIX-1219 moved the census to
 *      `logs`, and how the next removal will answer. Not a reading and not a
 *      symptom. `--by` exits 8 the same way.
 *   (3 is not used: it is the bootstrap runner's retired census_fail.)
 *
 * WHAT IT READS. Both halves and `--by` are the helper's builders:
 * `queryCancellationBuckets` (per-minute `statement timeout` and `user
 * request` counts — a hand cancel is a different event and is reported
 * alongside, never added in), `queryEdgeBuckets` at 900 s (the front-door
 * route's own read, the same builder), and `queryAttribution`. Buckets arrive
 * in ms. Re-validated on the 09-23/24 fixtures in cc-155 (the report carries
 * the old/new table): every count identical.
 */

import {
  queryAttribution,
  queryCancellationBuckets,
  queryEdgeBuckets,
  sqlAttribution,
} from "@civitics/db";

import {
  answersExit,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  sanitizeLike,
  unavailableJson,
  unavailableSummary,
  verdictFor,
  ATTRIBUTABLE_FIELDS,
  CENSUS_EXIT,
  LOGS_RETENTION_DAYS,
  MAX_ATTRIBUTION_MINUTES,
  RATIO_GATE,
  type AttributableField,
  type AttributionRow,
  type CancellationBucket,
  type EdgeBucket,
  type LogsAnswer,
} from "../lib/cancellation-census";

const TIMEOUT_MS = 20_000;
const EDGE_BUCKET_MS = 15 * 60 * 1000;

/** cc-129's measured baseline. Stated here once; every other mention quotes it. */
const DEFAULT_BASELINE = 0.033;

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
      case "--":
        // pnpm passes the separator through literally (`… :prod -- --minutes
        // 90`, the form in the header). Refusing it made a usage error exit 2,
        // which every consumer reads as DARK. Measured cc-155.
        break;
      case "--help":
        console.log(
          "Usage: cancellation-census [--minutes N] [--end <iso>] [--baseline <per-min>] [--json]\n" +
            "       cancellation-census --by <field> [--like <substring>] [--minutes N] [--end <iso>] [--json]\n" +
            `       fields: ${ATTRIBUTABLE_FIELDS.join(", ")}\n` +
            "       exit: 0 pass · 1 fail · 2 dark (the Logs API did not answer) · " +
            "8 unavailable (the endpoint is gone — 410; FIX-1219)",
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
  // The clamp, refused rather than silently under-reported — in BOTH modes
  // now: a gate read over a longer window got the oldest day just the same.
  // See MAX_ATTRIBUTION_MINUTES for the measurement this rests on (re-measured
  // on the `logs` endpoint, cc-155).
  if (a.minutes > MAX_ATTRIBUTION_MINUTES) {
    throw new Error(
      `--minutes ${a.minutes} exceeds the Logs API's measured ${MAX_ATTRIBUTION_MINUTES}-minute ` +
        "answer window. Above it the API returns the OLDEST 24 h of the range asked for, with " +
        "no error and no short result — a wrong answer that looks like a right one. Walk a " +
        `longer span with repeated --end runs instead (retention is ${LOGS_RETENTION_DAYS} days).`,
    );
  }
  return a;
}

/** Log a non-rows answer's detail to stderr; the caller turns it into exit 2 / exit 8. */
function logAnswer<T>(a: LogsAnswer<T>): LogsAnswer<T> {
  if (a.kind !== "rows") console.error(`[census] ${a.detail}`);
  return a;
}

/**
 * Exit 8, as text or JSON. process.exitCode and a return, never process.exit():
 * after fast-failing fetches process.exit() aborts on Windows (the
 * UV_HANDLE_CLOSING assertion below) and the shell sees 127, which a consumer
 * would read as dark — measured in cc-152 read 5 on exactly this 410.
 */
function exitUnavailable(status: number, window: { start: string; end: string; minutes: number }, json: boolean): void {
  if (json) console.log(JSON.stringify(unavailableJson(status, window), null, 2));
  else console.log(`\n[census] ${unavailableSummary(status)} — no verdict, no attribution. (exit 8)`);
  process.exitCode = CENSUS_EXIT.unavailable;
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
    const sql = sqlAttribution(args.by, args.like);
    const a = logAnswer(
      await queryAttribution({ field: args.by, like: args.like, startMs, endMs: args.endMs, token, timeoutMs: TIMEOUT_MS }),
    );
    if (a.kind === "unavailable") {
      exitUnavailable(a.status, { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes }, args.json);
      return;
    }
    if (a.kind === "dark") {
      // exitCode, not process.exit(): see exitUnavailable. Exit 2 was reaching
      // the shell as 127 on Windows after a fast failure.
      console.error("[census] the Logs API did not answer — no attribution. (exit 2)");
      process.exitCode = CENSUS_EXIT.dark;
      return;
    }
    const parsed: AttributionRow[] = a.rows;
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

  const [cAns, eAns] = await Promise.all([
    queryCancellationBuckets({ startMs, endMs: args.endMs, token, timeoutMs: TIMEOUT_MS }).then(logAnswer),
    queryEdgeBuckets({ startMs: edgeStart, endMs: edgeEnd, bucketSeconds: EDGE_BUCKET_MS / 1000, token, timeoutMs: TIMEOUT_MS }).then(logAnswer),
  ]);

  const early = answersExit([cAns, eAns]);
  if (early?.code === CENSUS_EXIT.unavailable) {
    exitUnavailable(early.status, { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes }, args.json);
    return;
  }
  if (early || cAns.kind !== "rows" || eAns.kind !== "rows") {
    // exitCode, not process.exit(): see exitUnavailable.
    console.error("[census] the Logs API did not answer — no verdict. (exit 2)");
    process.exitCode = CENSUS_EXIT.dark;
    return;
  }
  // Buckets arrive in ms from the helper. Only minutes WITH a cancellation come
  // back (the helper's WHERE), which is all the verdict and the table read.
  const cancellations: CancellationBucket[] = cAns.rows;
  const edge: EdgeBucket[] = eAns.rows.map(({ startMs, requests, n5xx }) => ({ startMs, requests, n5xx }));

  const v = verdictFor({ cancellations, minutes: args.minutes, baseline: args.baseline });
  const ev = edgeVerdictFor(edge);
  const userTotal = cancellations.reduce((n, b) => n + b.userRequests, 0);
  const zeroMinutes = args.minutes - cancellations.filter((b) => b.timeouts > 0).length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes },
          cancellations: {
            ...v,
            user_requests: userTotal,
            gate: `fails iff ratio > ${RATIO_GATE} AND total > P99 floor (poissonP99(baseline x minutes))`,
          },
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
        `ratio ${v.ratio.toFixed(2)}x  λ ${v.lambda.toFixed(2)}  P99 floor ${v.floor}  ` +
        `(fails iff ratio > ${RATIO_GATE}x AND total > floor)  → ${v.pass ? "PASS" : "FAIL"}`,
    );
    console.log(`  ${v.note}`);
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
