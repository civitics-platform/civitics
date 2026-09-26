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
 *   --start <iso>      window start, in place of --minutes (the runner reads a
 *                      CALL's own span this way — FIX-1232)
 *   --baseline <n>     cancellations/min, default 0.033 (cc-129's measurement,
 *                      quoted in docs/audits/2026-09-17-fix1187-prod-apply.md).
 *                      The flag exists so a prompt RE-STATES the baseline it is
 *                      gating against rather than inheriting a default nobody
 *                      re-derived; the script prints which value it used either
 *                      way, so a stale default is at least visible.
 *   --baseline-renders <n>
 *                      renders/min the floor is computed at; default = the
 *                      --baseline value (decision 6 of the FIX-1232 design: the
 *                      same number, in the right unit, until the ~10-03
 *                      re-measure supplies its own)
 *   --renders-only     one Logs read, not two: the renders over the window and
 *                      nothing else. An instrument, like --by — no verdict, exit
 *                      0 on any reading, 2 dark, 8 unavailable. The paced
 *                      runner's CALL and breather windows (FIX-1232 D3).
 *   --json             machine-readable; the verdicts are the same either way.
 *
 * EXIT CODES — so a prompt can gate on the process rather than on prose.
 *   0  both gates PASS
 *   1  either gate FAILs
 *   2  dark: the Logs API did not answer (a 5xx, a 429, a timeout, a network
 *      error, a 200 carrying any other error or no result array), or the key
 *      is missing
 *   8  unavailable: the endpoint is GONE (410, or 404 on the same path) — how
 *      `logs.all` answered from 2026-09-24 until FIX-1219 moved the census to
 *      `logs` — or a table or field the query names is (a 200 whose error says
 *      it "does not exist", cc-156; the summary names it). Not a reading and
 *      not a symptom. `--by` exits 8 the same way.
 *   (3 is not used: it is the bootstrap runner's retired census_fail.)
 *
 * WHAT IT READS. Both halves and `--by` are the helper's builders:
 * `queryCancellationRenders` (statement timeouts by SECOND — one row is one
 * render lost; FIX-1232), `queryEdgeBuckets` at 900 s (the front-door route's
 * own read, the same builder), and `queryAttribution`. Still two Logs calls per
 * reading: the renders read REPLACED the per-minute bucket read rather than
 * joining it (rule 190 — four readers share one token), and its events equal
 * the bucket read's `timeouts` on every fixture window, minute by minute (rule
 * 116). What that costs: hand cancels ("due to user request") are no longer
 * counted here — they were reported, never gated; `--by sql_state_code` still
 * sees them. Buckets arrive in ms.
 */

import {
  queryAttribution,
  queryCancellationRenders,
  queryEdgeBuckets,
  sqlAttribution,
} from "@civitics/db";

import {
  answersExit,
  edgeVerdictFor,
  formatAttribution,
  isAttributableField,
  sanitizeLike,
  topPages,
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
  type EdgeBucket,
  type LogsAnswer,
  type RenderSecond,
} from "../lib/cancellation-census";

const TIMEOUT_MS = 20_000;
const EDGE_BUCKET_MS = 15 * 60 * 1000;

/** cc-129's measured baseline. Stated here once; every other mention quotes it. */
const DEFAULT_BASELINE = 0.033;

interface Args {
  minutes: number;
  endMs: number;
  baseline: number;
  /** null = the --baseline value (FIX-1232 decision 6). */
  baselineRenders: number | null;
  json: boolean;
  /** Non-null puts the script in attribution mode: no verdict, always exit 0. */
  by: AttributableField | null;
  like: string | null;
  /** The renders over the window and nothing else: one Logs read, no verdict (FIX-1232 D3). */
  rendersOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    minutes: 60,
    endMs: Date.now(),
    baseline: DEFAULT_BASELINE,
    baselineRenders: null,
    json: false,
    by: null,
    like: null,
    rendersOnly: false,
  };
  let startMs: number | null = null;
  let minutesGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--minutes":
        a.minutes = Number(v);
        minutesGiven = true;
        i++;
        break;
      case "--end": {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new Error(`--end is not an ISO timestamp: ${v}`);
        a.endMs = t;
        i++;
        break;
      }
      case "--start": {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new Error(`--start is not an ISO timestamp: ${v}`);
        startMs = t;
        i++;
        break;
      }
      case "--baseline":
        a.baseline = Number(v);
        i++;
        break;
      case "--baseline-renders":
        a.baselineRenders = Number(v);
        i++;
        break;
      case "--renders-only":
        a.rendersOnly = true;
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
          "Usage: cancellation-census [--minutes N | --start <iso>] [--end <iso>] [--baseline <per-min>]\n" +
            "                           [--baseline-renders <per-min>] [--json]\n" +
            "       cancellation-census --renders-only [--minutes N | --start <iso>] [--end <iso>] [--json]\n" +
            "       cancellation-census --by <field> [--like <substring>] [--minutes N] [--end <iso>] [--json]\n" +
            `       fields: ${ATTRIBUTABLE_FIELDS.join(", ")}\n` +
            "       exit: 0 pass · 1 fail · 2 dark (the Logs API did not answer) · " +
            "8 unavailable (the endpoint is gone — 410 — or a table/field it names is; FIX-1219)",
        );
        process.exit(0);
        break;
      default:
        if (argv[i]!.startsWith("--")) throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (startMs !== null) {
    if (minutesGiven) throw new Error("--start and --minutes both name the window's length; give one");
    a.minutes = (a.endMs - startMs) / 60_000;
  }
  if (!Number.isFinite(a.minutes) || a.minutes <= 0) throw new Error("--minutes must be > 0 (and --start before --end)");
  if (!Number.isFinite(a.baseline) || a.baseline < 0) throw new Error("--baseline must be >= 0");
  if (a.baselineRenders !== null && (!Number.isFinite(a.baselineRenders) || a.baselineRenders < 0)) {
    throw new Error("--baseline-renders must be >= 0");
  }
  if (a.like !== null && a.by === null) throw new Error("--like needs --by (it narrows an attribution)");
  if (a.rendersOnly && a.by !== null) throw new Error("--renders-only and --by are two different instruments; give one");
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
function exitUnavailable(
  status: number,
  window: { start: string; end: string; minutes: number },
  json: boolean,
  detail?: string,
): void {
  if (json) console.log(JSON.stringify(unavailableJson(status, window, detail), null, 2));
  else console.log(`\n[census] ${unavailableSummary(status, detail)} — no verdict, no attribution. (exit 8)`);
  process.exitCode = CENSUS_EXIT.unavailable;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** The `by_second` array of the --json body: what the runner windows into CALLs and breathers. */
function bySecond(rows: readonly RenderSecond[]) {
  return rows.map((r) => ({ at: iso(r.startMs), startMs: r.startMs, events: r.events, page: r.sampleQuery }));
}

function printSeconds(rows: readonly RenderSecond[]): void {
  if (rows.length === 0) {
    console.log("  no statement-timeout cancellation in any second of the window");
    return;
  }
  console.log(`  ${"second".padEnd(22)}  events  page`);
  for (const r of rows) console.log(`  ${iso(r.startMs).padEnd(22)}  ${String(r.events).padStart(6)}  ${r.sampleQuery}`);
  console.log(`  ${rows.length} render(s) lost, ${rows.reduce((n, r) => n + r.events, 0)} event(s)`);
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
      exitUnavailable(a.status, { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes }, args.json, a.detail);
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

  // ── renders-only mode (FIX-1232 D3) ─────────────────────────────────────────
  // The paced runner's CALL and breather windows: which seconds lost a render,
  // and nothing else — one Logs read, where a gate reading is two. Like --by it
  // is an instrument, not a gate: exit 0 on any reading, whatever it holds; the
  // runner judges the count against its own budget.
  if (args.rendersOnly) {
    const window = { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes };
    const r = logAnswer(await queryCancellationRenders({ startMs, endMs: args.endMs, token, timeoutMs: TIMEOUT_MS }));
    if (r.kind === "unavailable") {
      exitUnavailable(r.status, window, args.json, r.detail);
      return;
    }
    if (r.kind === "dark") {
      // exitCode, not process.exit(): see exitUnavailable.
      console.error("[census] the Logs API did not answer — no renders reading. (exit 2)");
      process.exitCode = CENSUS_EXIT.dark;
      return;
    }
    const events = r.rows.reduce((n, x) => n + x.events, 0);
    if (args.json) {
      console.log(JSON.stringify({ window, renders: { renders: r.rows.length, events, by_second: bySecond(r.rows), pages: topPages(r.rows) }, gate: null }, null, 2));
    } else {
      console.log(`\n── renders lost ── ${window.start} → ${window.end} (${args.minutes.toFixed(2)} min)`);
      printSeconds(r.rows);
      console.log("\n   NOT A GATE — a renders reading only; this exits 0 whatever it finds.");
    }
    process.exitCode = 0;
    return;
  }

  // The edge half is bucketed at 15 min and gated on the last CLOSED bucket, so
  // it reads a whole-bucket-aligned window ending at the last boundary already
  // past. Sharing the cancellation window would gate on a bucket still filling.
  const edgeEnd = Math.floor(args.endMs / EDGE_BUCKET_MS) * EDGE_BUCKET_MS;
  const edgeStart = edgeEnd - 4 * EDGE_BUCKET_MS;

  const [cAns, eAns] = await Promise.all([
    queryCancellationRenders({ startMs, endMs: args.endMs, token, timeoutMs: TIMEOUT_MS }).then(logAnswer),
    queryEdgeBuckets({ startMs: edgeStart, endMs: edgeEnd, bucketSeconds: EDGE_BUCKET_MS / 1000, token, timeoutMs: TIMEOUT_MS }).then(logAnswer),
  ]);

  const early = answersExit([cAns, eAns]);
  if (early?.code === CENSUS_EXIT.unavailable) {
    exitUnavailable(early.status, { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes }, args.json, early.detail);
    return;
  }
  if (early || cAns.kind !== "rows" || eAns.kind !== "rows") {
    // exitCode, not process.exit(): see exitUnavailable.
    console.error("[census] the Logs API did not answer — no verdict. (exit 2)");
    process.exitCode = CENSUS_EXIT.dark;
    return;
  }
  // Seconds arrive in ms from the helper. Only seconds WITH a statement timeout
  // come back (the helper's WHERE), which is all the verdict and the table read.
  const renders: RenderSecond[] = cAns.rows;
  const edge: EdgeBucket[] = eAns.rows.map(({ startMs, requests, n5xx }) => ({ startMs, requests, n5xx }));

  const v = verdictFor({ renders, minutes: args.minutes, baseline: args.baseline, baselineRenders: args.baselineRenders ?? undefined });
  const ev = edgeVerdictFor(edge);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: { start: iso(startMs), end: iso(args.endMs), minutes: args.minutes },
          cancellations: {
            ...v,
            by_second: bySecond(renders),
            pages: topPages(renders),
            // Not read since FIX-1232: the renders read counts statement
            // timeouts only (reported, never gated, before it).
            user_requests: null,
            gate: `fails iff ratio_renders > ${RATIO_GATE} AND renders > P99 floor (poissonP99(baseline_renders x minutes)); a render is a second with >= 1 statement timeout`,
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
    console.log(`\n── 57014 census ── ${iso(startMs)} → ${iso(args.endMs)} (${args.minutes} min) — in RENDERS (FIX-1232)`);
    printSeconds(renders);
    console.log(
      `\n  renders ${v.renders}  baseline ${v.baseline_renders}/min  ratio ${v.ratio_renders.toFixed(2)}x  ` +
        `λ ${v.lambda_renders.toFixed(2)}  P99 floor ${v.floor_renders}  ` +
        `(fails iff ratio > ${RATIO_GATE}x AND renders > floor)  → ${v.pass ? "PASS" : "FAIL"}`,
    );
    console.log(`  ${v.note}`);
    console.log(`  events ${v.events} (ratio ${v.ratio_events.toFixed(2)}x at ${v.baseline}/min) — the old unit, reported, not gated`);
    console.log("  cancelled by hand: not read since FIX-1232 (the renders read counts statement timeouts only; --by sql_state_code sees them)");

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

  // exitCode, not process.exit(): see exitUnavailable. The verdict path was the
  // last one left, and cc-156 measured it: a PASS reading printed its verdict
  // and then aborted on the UV_HANDLE_CLOSING assertion, exit 127 — which every
  // consumer reads as dark.
  process.exitCode = v.pass && ev.pass ? 0 : 1;
}

main().catch((err) => {
  console.error("[census] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
