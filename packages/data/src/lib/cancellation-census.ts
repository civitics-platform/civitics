/**
 * The verdict half of the 57014 / front-door census — pure, so it is testable.
 *
 * The gates are cc-131's read 7 (f), which the drain-and-wait block in
 * `docs/cc/PROMPT_TEMPLATE.md` now states as a rule: statement cancellations
 * per minute over the last hour at or below TWICE the measured baseline, and
 * front-door 5xx at or below 1 % over the last CLOSED 15-minute bucket.
 *
 * Both are expressed as a RATIO against a stated baseline rather than as an
 * absolute, for the reason cc-130 earned: a gate must describe a state prod
 * actually visits. "Zero cancellations in an hour" is not that state — the
 * measured baseline is 0.033/min, i.e. about two an hour, on a healthy box.
 *
 * ── THE POISSON FLOOR (cc-151 D1) ───────────────────────────────────────────
 * A ratio test on a count under ~10 is noise. At 0.033/min the expected count
 * is λ = 2.0 in 60 min and λ = 0.5 in 15 min, so with no burst at all a 60-min
 * reading failed `ratio > 2` at >= 4 events (P = 14.3 % per reading) and a
 * 15-min reading failed at >= 1 (P = 39.4 %) — seven pre-CALL readings over a
 * one-hour run tripped with P ≈ 97 % on an ordinary night (cc-148 §5.3). So a
 * reading now FAILS only when BOTH hold:
 *   ratio > RATIO_GATE   AND   total > poissonP99(baseline × minutes)
 * i.e. the count is also above what the baseline itself produces 99 % of the
 * time. At λ = 2.0 the floor is 6 (a 60-min reading fails at >= 7, tail
 * 0.45 %); at λ = 0.5 it is 3 (a 15-min reading fails at >= 4, tail 0.18 %).
 * Above ~10 events the ratio dominates again and the floor stops binding.
 */

/** One minute of `postgres_logs`, as the census aggregates it. */
export interface CancellationBucket {
  /** Bucket start, ms since epoch. */
  startMs: number;
  /** `canceling statement due to statement timeout` — the 57014 class. */
  timeouts: number;
  /** `canceling statement due to user request` — cancelled by hand. Reported, not gated. */
  userRequests: number;
}

/** One 15-minute `edge_logs` bucket. Same shape the front-door route reads. */
export interface EdgeBucket {
  startMs: number;
  requests: number;
  n5xx: number;
}

export interface CancellationVerdict {
  total: number;
  minutes: number;
  /** Cancellations per minute over the window. */
  rate: number;
  baseline: number;
  /** rate / baseline. Infinity when the baseline is 0 and the rate is not. */
  ratio: number;
  /** baseline × minutes — the count the baseline itself expects in the window. */
  lambda: number;
  /** poissonP99(lambda): a count at or below this never fails, whatever the ratio. */
  floor: number;
  pass: boolean;
  note: string;
}

export interface EdgeVerdict {
  /** The last bucket with any traffic in it, or null when every bucket is empty. */
  lastClosed: EdgeBucket | null;
  pct5xx: number | null;
  pass: boolean;
  note: string;
}

/** The gate: at most twice the stated baseline. */
export const RATIO_GATE = 2;

/** The gate: at most 1 % 5xx in the last closed bucket. */
export const PCT_5XX_GATE = 1;

/** The floor's quantile: a count the baseline alone exceeds 1 % of the time. */
export const FLOOR_QUANTILE = 0.99;

/**
 * The smallest k with P(X <= k) >= 0.99 for X ~ Poisson(λ). Summed in log
 * space so a large λ does not underflow e^-λ to zero. λ <= 0 (or not finite)
 * is 0: no expected events, so no tolerance above none.
 */
export function poissonP99(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  const logL = Math.log(lambda);
  const kMax = Math.ceil(lambda + 12 * Math.sqrt(lambda) + 25);
  let logP = -lambda; // log P(X = 0)
  let cum = 0;
  for (let k = 0; k <= kMax; k++) {
    cum += Math.exp(logP);
    if (cum >= FLOOR_QUANTILE) return k;
    logP += logL - Math.log(k + 1);
  }
  return kMax;
}

export function verdictFor(input: {
  cancellations: readonly CancellationBucket[];
  minutes: number;
  baseline: number;
}): CancellationVerdict {
  const { minutes, baseline } = input;
  const total = input.cancellations.reduce((n, b) => n + b.timeouts, 0);
  const rate = minutes > 0 ? total / minutes : 0;
  // A zero baseline makes the ratio meaningless rather than infinite-and-failing,
  // so it is called out as such instead of silently gating on division.
  const ratio = baseline > 0 ? rate / baseline : total === 0 ? 0 : Number.POSITIVE_INFINITY;
  const lambda = baseline > 0 ? baseline * minutes : 0;
  const floor = poissonP99(lambda);
  const overRatio = ratio > RATIO_GATE;
  const overFloor = total > floor;
  const pass = baseline > 0 ? !(overRatio && overFloor) : total === 0;
  const head = `${total} over ${minutes} min — ratio ${ratio.toFixed(2)}`;
  const at = `P99 floor ${floor} at λ=${lambda.toFixed(1)}`;
  return {
    total,
    minutes,
    rate,
    baseline,
    ratio,
    lambda,
    floor,
    pass,
    note:
      baseline <= 0
        ? "baseline is 0 — the ratio is not meaningful; gating on 'no cancellations at all'"
        : total === 0
          ? `no cancellations in the window (${at})`
          : !overRatio
            ? `${head} <= ${RATIO_GATE}`
            : overFloor
              ? `${head} > ${RATIO_GATE} and > ${at}`
              : `${head} > ${RATIO_GATE} but <= ${at}`,
  };
}

/**
 * The 5xx gate, read off the LAST CLOSED bucket.
 *
 * "Closed" matters: the newest bucket is usually still filling, so a single 5xx
 * arriving into a bucket holding three requests reads as 33 %. The caller aligns
 * its window to a bucket boundary, and this takes the last bucket that actually
 * carried traffic — a bucket with zero requests is not evidence of health and is
 * reported as `no traffic` rather than as a pass on 0 %.
 */
export function edgeVerdictFor(buckets: readonly EdgeBucket[]): EdgeVerdict {
  const withTraffic = buckets.filter((b) => b.requests > 0);
  const last = withTraffic.length > 0 ? withTraffic[withTraffic.length - 1]! : null;
  if (!last) {
    return {
      lastClosed: null,
      pct5xx: null,
      pass: true,
      note: "no traffic in any bucket — nothing to fail, and nothing proved either",
    };
  }
  const pct = (last.n5xx / last.requests) * 100;
  return {
    lastClosed: last,
    pct5xx: pct,
    pass: pct <= PCT_5XX_GATE,
    note: `${last.n5xx} of ${last.requests} request(s) = ${pct.toFixed(2)} %`,
  };
}

// ───────────────────────────── attribution mode ─────────────────────────────
//
// The gate above answers "is the box healthy enough to start". Attribution
// answers a different question — WHICH statement is being cancelled — and the
// two must not be confused, so this half returns no verdict and the caller
// exits 0 regardless. It is an instrument, not a gate.
//
// It exists because pgss CANNOT answer it. `pg_stat_statements` does not record
// a statement that was cancelled (measured on local PG17, cc-137 read 2: a
// `SET statement_timeout='1s'` + `pg_sleep(3.5)` leaves ZERO pgss rows), so
// every 57014 is invisible there by construction and the Logs API is the only
// instrument that can see one.

/** One attribution group: a field value and how many cancellations carried it. */
export interface AttributionRow {
  group: string;
  count: number;
}

/**
 * The `metadata.parsed` fields a cancellation row actually carries, PROBED on
 * prod (cc-137 read 2) rather than assumed. Allow-listed because `--by` is
 * interpolated into the SQL string.
 *
 * `user_name` is deliberately included and is deliberately near-useless for
 * splitting a PostgREST request by its effective role: PostgREST logs in as
 * `authenticator` and then `SET ROLE`s to anon / authenticated / service_role,
 * and the Postgres log records the LOGIN role. Measured over 24 h of prod: all
 * 38 cancellations carried `user_name = authenticator`, none carried anon,
 * authenticated or service_role. So the role split is not readable here; the
 * QUERY is, which is what `--by query` is for.
 */
export const ATTRIBUTABLE_FIELDS = [
  "query",
  "user_name",
  "application_name",
  "backend_type",
  "command_tag",
  "database_name",
  "connection_from",
  "error_severity",
  "sql_state_code",
  "session_id",
] as const;

export type AttributableField = (typeof ATTRIBUTABLE_FIELDS)[number];

export function isAttributableField(v: string): v is AttributableField {
  return (ATTRIBUTABLE_FIELDS as readonly string[]).includes(v);
}

/**
 * THE 24-HOUR CLAMP — the single most important thing to know about this API.
 *
 * The Logs API answers a query from the partition holding `iso_timestamp_start`
 * and silently ignores an `iso_timestamp_end` more than 24 h later. It does not
 * error, it does not warn, and it does not return a short window — it returns a
 * FULL, PLAUSIBLE 24 h of rows that are the OLDEST day of the range asked for.
 *
 * Measured on prod (cc-137 read 2), each request made at 2026-09-19T03:07Z:
 *
 *   lookback   rows   rows actually covering
 *   1 day      3790   2026-09-18T03:08 → 2026-09-19T03:06   (the whole window)
 *   2 days     4824   2026-09-17T03:08 → 2026-09-18T03:06   (the OLDEST day)
 *   3 days     3857   2026-09-16T03:08 → 2026-09-17T03:06   (the OLDEST day)
 *   7 days     3874   2026-09-12T03:08 → 2026-09-13T03:06   (the OLDEST day)
 *
 * A caller asking for "the last 7 days" therefore gets day 1 of 7 and no
 * indication of it. That is a wrong answer wearing a right answer's clothes, so
 * this refuses above the clamp rather than quietly under-reporting; walk a
 * longer span with repeated `--end` runs, which is what the audit did.
 */
export const MAX_ATTRIBUTION_MINUTES = 1440;

/**
 * Retention, measured the same way: a window STARTING 7 days back returns rows;
 * one starting 8, 9 or 10 days back returns zero. Supabase Pro keeps 7 days.
 */
export const LOGS_RETENTION_DAYS = 7;

/**
 * `--like` is interpolated into a BigQuery string literal, so it is restricted
 * to characters that cannot close one or start a comment. Returns null when the
 * value is unusable, and the caller turns that into a refusal.
 */
export function sanitizeLike(raw: string): string | null {
  if (raw.length === 0 || raw.length > 120) return null;
  return /^[A-Za-z0-9_. :/-]+$/.test(raw) ? raw : null;
}

/**
 * Render the attribution table. Pure, so the shape is a test rather than a
 * thing you confirm by eye against prod.
 */
export function formatAttribution(input: {
  rows: readonly AttributionRow[];
  field: string;
  like: string | null;
  startIso: string;
  endIso: string;
}): string {
  const { rows, field, like, startIso, endIso } = input;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const head =
    `── 57014 attribution ── by ${field}` +
    (like ? ` · query like %${like}%` : "") +
    `\n   ${startIso} → ${endIso}`;
  if (rows.length === 0) {
    return `${head}\n   no statement-timeout cancellation matched in this window`;
  }
  const width = Math.max(...rows.map((r) => r.group.length), 5);
  const lines = rows.map((r) => {
    const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
    return `   ${r.group.padEnd(width)}  ${String(r.count).padStart(6)}  ${pct.padStart(5)} %`;
  });
  return [
    head,
    `   ${"group".padEnd(width)}  ${"count".padStart(6)}  ${"share".padStart(5)}  `,
    ...lines,
    `   ${"".padEnd(width)}  ${String(total).padStart(6)}  total`,
    "",
    "   NOT A GATE — attribution only; this exits 0 whatever it finds.",
  ].join("\n");
}

/**
 * The attribution query, server-side aggregated so the ~100-row cap that makes
 * the gate queries safe holds here too: `limit 20` over a `group by` returns at
 * most 20 rows however busy the window was.
 *
 * `--by query` does NOT group by the query text. PostgREST wraps every RPC in a
 * ~600-character `WITH pgrst_source AS (…)` envelope, so grouping on the raw
 * text would return one row per distinct bind-parameter shape and blow the cap
 * while telling you nothing. It groups by the FUNCTION NAME extracted from the
 * envelope (`"public"."get_official_page"` → `get_official_page`), falling back
 * to the first 60 characters for a table-level query with no function in it.
 */
export function buildAttributionSql(field: AttributableField, like: string | null): string {
  const groupExpr =
    field === "query"
      ? `coalesce(regexp_extract(p.query, r'"public"[.]"([a-z0-9_]+)"'), ` +
        `substr(regexp_replace(coalesce(p.query, t.event_message), r'\s+', ' '), 1, 60))`
      : `coalesce(cast(p.${field} as string), '(null)')`;
  const likeClause = like ? `\n  and p.query like '%${like}%'` : "";
  return `
select
  ${groupExpr} as g,
  count(*) as n
from postgres_logs t
cross join unnest(t.metadata) as m
cross join unnest(m.parsed) as p
where p.sql_state_code = '57014'${likeClause}
group by g
order by n desc
limit 20`;
}
