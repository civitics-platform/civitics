/**
 * FIX-435 (Phase 2) — Backfill proposals.summary_plain from Congress.gov CRS
 * summaries. NON-AI ingestion: the CRS-authored plain-language summary is real
 * prose, so writing it to summary_plain shows real summaries on congress bill
 * pages with zero AI calls (flips title_only -> full_summary). Phase 1 did the
 * same for OpenStates abstracts (FIX-445); this is the higher-yield congress
 * side.
 *
 * Source: GET /bill/{congress}/{type}/{number}/summaries returns summaries[] of
 * { actionDate, actionDesc, text, updateDate, versionCode }. `text` is HTML
 * (entity-encoded prose). Bills carry multiple versions (Introduced, Reported,
 * Public Law, ...) — we take the LATEST by updateDate, strip tags + decode
 * entities, and write the plain prose.
 *
 * Don't-clobber: the UPDATE re-asserts `summary_plain IS NULL`, so a
 * concurrent/prior fill is never overwritten (source text owns this column; AI
 * writes go to ai_summary_cache, not here).
 *
 * FIX-1455 (cc-318) — A BOX, AND THE CURSOR A BOX NEEDS. The dispatcher starts
 * this walker (job_registry crs-summaries, `stale_after 2 hours`, 15-minute
 * runs), so a run asks only part of the list. Each measure asked gets
 * `metadata.crs = {asked_at, result}` on its congress_gov ref (result: summary |
 * none | not_found | unparseable), a server-side merge of that one key — the
 * bill-details walker writes `metadata.detail` on the same ref. A run takes
 * bills and resolutions with summary_plain NULL, never-asked first, then the
 * oldest asked_at, and skips a measure asked inside REASK_AFTER_DAYS. Before the
 * cursor every run re-selected one external_id order, so a boxed run re-asked
 * the head of the list and never reached its tail.
 *
 * Between measures it stops on --limit, on --max-minutes, on three consecutive
 * 429 / 5xx / no-response answers, and when prod_session_state() says a
 * supervised session holds the box (the bill-details walker's own read). One
 * data_sync_log row per run under `congress_crs_summaries`: a clean stop is
 * complete or partial; a held stop before the first measure is skipped (the
 * bill-details walker's rule); only a database error that is not one measure's
 * own is failed. A run with nothing to take closes complete with
 * metadata.next_due_at, which the registry row then rests on (FIX-1330).
 * Nominations carry a congress_gov proposal ref too and have no CRS summary:
 * they are not selected.
 *
 * Rate limit: fetchCongressApi already sleeps 200ms; we add THROTTLE_MS-200 so
 * each request is ~800ms (~4,500/hr). The key is shared with the nightly and the
 * bill-details walker.
 *
 * Run:
 *   pnpm --filter @civitics/data data:backfill-crs-summaries -- --dry-run --limit 5
 *   pnpm --filter @civitics/data data:backfill-crs-summaries -- --apply --limit 10
 *   gh workflow run crs-summaries.yml -f max_minutes=15   (prod; empty = no box)
 */

import type { Client } from "pg";
import { fetchCongressApi, sleep } from "../pipelines/congress/members";
import { withDirectClient } from "../lib/direct-pg-upsert";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { readProdSessionState } from "../lib/prod-session";
import { prodSessionHoldReason } from "../pipelines/nightly-hold";
import { startSync, completeSync, failSync, skipSync } from "../pipelines/sync-log";
import { BILL_TYPES, httpStatusOf, isTransient, parseBillKey } from "../pipelines/congress/bill-details-parse";
import { isMeasureLocalDbError, REAL_TX, type HoldReading, type TxControl } from "../pipelines/congress/bill-details";

interface SummariesResponse {
  summaries?: Array<{
    actionDate?: string;
    actionDesc?: string;
    text?: string;
    updateDate?: string;
    versionCode?: string;
  }>;
}

export const PIPELINE = "congress_crs_summaries";
// ~800ms/iter total (fetchCongressApi sleeps 200ms, we add the rest) keeps the
// run near ~4,500 req/hr, safely under the Congress.gov per-key ceiling.
const THROTTLE_MS = 800;
const TRANSIENT_STOP = 3;
/**
 * A measure asked this recently is not taken again. CRS writes a summary weeks
 * after a bill moves, so a week between asks is the old Saturday cadence, now
 * per measure.
 */
export const REASK_AFTER_DAYS = 7;
/** next_due_at is never sooner than the registry row's own `stale_after 2 hours`. */
const REST_MIN_HOURS = 2;
/** With no measure left to ask at all, the next ask is the nightly's new measures. */
const REST_EMPTY_HOURS = 12;
const HEARTBEAT_MS = 5 * 60_000;
const MEASURE_STATEMENT_TIMEOUT = "30s";
/** A failure list longer than this is counted, not listed. */
const FAILURES_KEPT = 25;

export type CrsResult = "summary" | "none" | "not_found" | "unparseable";

export interface Target {
  ref_id: string;
  proposal_id: string;
  external_id: string;
  asked_at: string | null;
}

/** A congress.gov GET: a path in, parsed JSON out. */
export type CongressGet = <T>(path: string) => Promise<T>;

export interface RunOptions {
  client: Client;
  get: CongressGet;
  apply: boolean;
  limit: number | null;
  maxMinutes: number | null;
  isHeld: () => Promise<HoldReading>;
  tx?: TxControl;
  /** Test seam: take only these external ids. */
  keys?: readonly string[];
  /** Test seam: the backoff after a transient answer. */
  backoffMs?: (streak: number) => number;
  /** Test seam: the clock --max-minutes reads. */
  now?: () => number;
  /** Called between measures at most every HEARTBEAT_MS (FIX-1291's heartbeat_at). */
  heartbeat?: (s: RunSummary) => Promise<void>;
  log?: (line: string) => void;
}

export type StopReason = "done" | "limit" | "max_minutes" | "held" | "api_errors" | "db_error";

export interface RunSummary {
  stop: StopReason;
  stop_detail: string | null;
  selected: number;
  remaining: number;
  /** Measures whose request was answered: written + already_filled + none + not_found. */
  asked: number;
  written: number;
  /** A summary found, but summary_plain was filled between the selection and the write. */
  already_filled: number;
  none: number;
  not_found: number;
  unparseable: number;
  failed: number;
  failures: Array<{ key: string; why: string }>;
  requests: number;
  /** Set only when the selection was empty: when the next measure becomes due (FIX-1330). */
  next_due_at: string | null;
  elapsed_ms: number;
}

function emptySummary(): RunSummary {
  return {
    stop: "done", stop_detail: null, selected: 0, remaining: 0,
    asked: 0, written: 0, already_filled: 0, none: 0, not_found: 0, unparseable: 0, failed: 0, failures: [],
    requests: 0, next_due_at: null, elapsed_ms: 0,
  };
}

/** Measures this run has dealt with, for --limit. */
const handled = (s: RunSummary): number => s.asked + s.unparseable + s.failed;

// ---------------------------------------------------------------------------
// Selection — the cursor
// ---------------------------------------------------------------------------

/** metadata.crs.asked_at as a timestamptz; anything unreadable counts as never asked. */
const ASKED_AT_SQL = `CASE WHEN x.metadata -> 'crs' ->> 'asked_at' ~ '^\\d{4}-\\d\\d-\\d\\d[ T]'
                           THEN (x.metadata -> 'crs' ->> 'asked_at')::timestamptz END`;

/** Bills and resolutions with no summary_plain, the FROM / WHERE both reads share. */
const CANDIDATES_SQL = `
  FROM public.external_source_refs x
  JOIN public.proposals p ON p.id = x.entity_id
 WHERE x.source = 'congress_gov'
   AND x.entity_type = 'proposal'
   AND x.external_id ~ '^[0-9]+-[A-Z]+-[0-9]+$'
   AND split_part(x.external_id, '-', 2) = ANY ($1::text[])
   AND p.summary_plain IS NULL
   AND ($2::text[] IS NULL OR x.external_id = ANY ($2::text[]))`;

/** Never-asked first, then the oldest asked_at; a measure asked inside REASK_AFTER_DAYS is not taken. */
export async function selectTargets(c: Client, keys?: readonly string[]): Promise<Target[]> {
  const res = await c.query<Target>(
    `SELECT x.id AS ref_id, x.entity_id AS proposal_id, x.external_id, (${ASKED_AT_SQL})::text AS asked_at
       ${CANDIDATES_SQL}
        AND COALESCE(${ASKED_AT_SQL}, '-infinity'::timestamptz) < now() - make_interval(days => $3::int)
      ORDER BY ${ASKED_AT_SQL} NULLS FIRST, x.external_id`,
    [BILL_TYPES, keys && keys.length > 0 ? keys : null, REASK_AFTER_DAYS],
  );
  return res.rows;
}

/**
 * For a run that found nothing to take: the oldest asked_at among the measures
 * still without a summary, + REASK_AFTER_DAYS, at least REST_MIN_HOURS out; with
 * no such measure, REST_EMPTY_HOURS out.
 */
export async function restUntil(c: Client, keys?: readonly string[]): Promise<string> {
  const res = await c.query<{ at: string }>(
    `SELECT to_char(GREATEST(COALESCE(min(${ASKED_AT_SQL}) + make_interval(days => $3::int),
                                      now() + make_interval(hours => $5::int)),
                             now() + make_interval(hours => $4::int)) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       ${CANDIDATES_SQL}`,
    [BILL_TYPES, keys && keys.length > 0 ? keys : null, REASK_AFTER_DAYS, REST_MIN_HOURS, REST_EMPTY_HOURS],
  );
  return res.rows[0]!.at;
}

// ---------------------------------------------------------------------------
// The summary text
// ---------------------------------------------------------------------------

// Minimal HTML → plain prose: strip tags, decode the entities CRS text actually
// uses, collapse whitespace. (CRS summaries are entity-encoded HTML fragments.)
export function htmlToPlain(html: string): string {
  let s = html.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // numeric entities (decimal + hex)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    // ampersand last so we don't double-decode the entities above
    .replace(/&amp;/gi, "&");
  return s.replace(/\s+/g, " ").trim();
}

/** Pick the most recent summary version's plain text (latest updateDate). */
export function latestSummaryText(resp: SummariesResponse): string | null {
  const summaries = resp.summaries ?? [];
  if (summaries.length === 0) return null;
  const sorted = [...summaries].sort((a, b) => {
    const ad = a.updateDate ?? a.actionDate ?? "";
    const bd = b.updateDate ?? b.actionDate ?? "";
    return ad < bd ? 1 : ad > bd ? -1 : 0; // descending
  });
  for (const s of sorted) {
    const plain = htmlToPlain(s.text ?? "");
    if (plain.length > 0) return plain;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write — one measure, one transaction
// ---------------------------------------------------------------------------

/**
 * The don't-clobber UPDATE (when there is text) and the stamp, together. The
 * stamp replaces the ref's top-level `crs` key only, server-side, so the
 * bill-details walker's `detail` key on the same row survives. Returns whether
 * summary_plain was written.
 */
export async function writeMeasure(c: Client, tx: TxControl, t: Target, result: CrsResult, text: string | null): Promise<boolean> {
  await tx.begin(c);
  try {
    await c.query(`SET LOCAL statement_timeout = '${MEASURE_STATEMENT_TIMEOUT}'`);
    let written = false;
    if (text !== null) {
      const u = await c.query(
        `UPDATE public.proposals SET summary_plain = $2 WHERE id = $1 AND summary_plain IS NULL`,
        [t.proposal_id, text],
      );
      written = (u.rowCount ?? 0) > 0;
    }
    await c.query(
      `UPDATE public.external_source_refs
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('crs', jsonb_build_object('asked_at', now(), 'result', $2::text))
        WHERE id = $1`,
      [t.ref_id, result],
    );
    await tx.commit(c);
    return written;
  } catch (err) {
    await tx.rollback(c).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function fail(s: RunSummary, key: string, why: string): void {
  s.failed += 1;
  if (s.failures.length < FAILURES_KEPT) s.failures.push({ key, why: why.slice(0, 200) });
}

const redact = (msg: string): string => msg.split("\n")[0]!.replace(/api_key=[^&\s]+/g, "api_key=…");

export async function runCrsSummaries(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? ((l: string) => console.info(l));
  const tx = o.tx ?? REAL_TX;
  const backoff = o.backoffMs ?? ((n: number) => 5000 * n);
  const now = o.now ?? Date.now;
  const t0 = now();
  const s = emptySummary();

  const targets = await selectTargets(o.client, o.keys);
  s.selected = targets.length;
  log(`  selected ${targets.length} measure(s) with no summary, never asked or asked over ${REASK_AFTER_DAYS} days ago; ` +
      `${targets.filter((t) => t.asked_at === null).length} never asked`);
  if (targets.length === 0) {
    s.next_due_at = await restUntil(o.client, o.keys);
    log(`  nothing to take — the row rests until ${s.next_due_at}`);
  }

  // The write: a stamp (and the summary) when applying; a count either way.
  const record = async (t: Target, result: CrsResult, text: string | null): Promise<boolean> => {
    if (!o.apply) return text !== null;
    return writeMeasure(o.client, tx, t, result, text);
  };

  let streak = 0;
  let lastBeat = now();
  let i = 0;
  for (; i < targets.length; i++) {
    const t = targets[i]!;
    if (o.limit !== null && handled(s) >= o.limit) { s.stop = "limit"; break; }
    if (o.maxMinutes !== null && now() - t0 >= o.maxMinutes * 60_000) { s.stop = "max_minutes"; break; }
    if (o.heartbeat && now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now();
      await o.heartbeat(s).catch((err: unknown) => log(`  [heartbeat] ${err instanceof Error ? err.message : String(err)}`));
    }
    const hold = await o.isHeld();
    if (hold.held) { s.stop = "held"; s.stop_detail = prodSessionHoldReason(hold.reason); break; }

    const tag = `  [${i + 1}/${targets.length}] ${t.external_id}${t.asked_at ? ` (asked ${t.asked_at})` : ""}`;
    try {
      const key = parseBillKey(t.external_id);
      if (!key) {
        await record(t, "unparseable", null);
        s.unparseable += 1;
        log(`${tag}: unparseable — stamped`);
        continue;
      }

      let resp: SummariesResponse;
      s.requests += 1;
      try {
        resp = await o.get<SummariesResponse>(`bill/${key.congress}/${key.type}/${key.number}/summaries`);
        streak = 0;
      } catch (err) {
        const status = httpStatusOf(err);
        const msg = redact(err instanceof Error ? err.message : String(err));
        if (isTransient(status)) {
          streak += 1;
          fail(s, t.external_id, `${status ?? "no response"}: ${msg}`);
          log(`${tag}: transient ${status ?? "no response"} (${streak}/${TRANSIENT_STOP}) — ${msg}`);
          if (streak >= TRANSIENT_STOP) { s.stop = "api_errors"; s.stop_detail = msg; i += 1; break; }
          await sleep(backoff(streak));
          continue;
        }
        streak = 0;
        if (status === 404) {
          await record(t, "not_found", null);
          s.asked += 1;
          s.not_found += 1;
          log(`${tag}: 404 — stamped not_found`);
          continue;
        }
        fail(s, t.external_id, `${status}: ${msg}`);
        log(`${tag}: failed ${status} — ${msg}`);
        continue;
      }

      const text = latestSummaryText(resp);
      const written = await record(t, text === null ? "none" : "summary", text);
      s.asked += 1;
      if (text === null) s.none += 1;
      else if (written) s.written += 1;
      else s.already_filled += 1;
      if (text !== null) log(`${tag}: ${written ? `${o.apply ? "set" : "would set"} summary_plain (${text.length} chars)` : "summary, but already filled"}`);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "?";
      const msg = err instanceof Error ? err.message : String(err);
      fail(s, t.external_id, `db ${code}: ${msg}`);
      if (isMeasureLocalDbError(err)) {
        log(`${tag}: write failed (db ${code}) — nothing written — ${msg}`);
        continue;
      }
      s.stop = "db_error";
      s.stop_detail = `${code}: ${msg}`;
      i += 1;
      break;
    }
  }
  s.remaining = targets.length - i;
  s.elapsed_ms = now() - t0;
  return s;
}

// ---------------------------------------------------------------------------
// The run row and the summary line
// ---------------------------------------------------------------------------

/** How a run's data_sync_log row closes: a clean stop advances; a held stop before any measure does not. */
export function closeAs(s: RunSummary): "complete" | "partial" | "skipped" | "failed" {
  if (s.stop === "db_error") return "failed";
  if (s.stop === "held" && handled(s) === 0) return "skipped";
  return s.stop === "done" ? "complete" : "partial";
}

export function summaryLine(s: RunSummary, apply: boolean): string {
  const secs = (s.elapsed_ms / 1000).toFixed(1);
  return (
    `crs-summaries ${apply ? "APPLY" : "DRY-RUN"}: asked=${s.asked} (written ${s.written}, already_filled ${s.already_filled}, none ${s.none}, not_found ${s.not_found})` +
    ` unparseable=${s.unparseable} failed=${s.failed} requests=${s.requests}` +
    ` stop=${s.stop}${s.stop_detail ? ` (${s.stop_detail})` : ""} selected=${s.selected} remaining=${s.remaining}` +
    (s.next_due_at ? ` next_due_at=${s.next_due_at}` : "") +
    ` elapsed=${secs}s`
  );
}

export function runMetadata(s: RunSummary, args: CliArgs): Record<string, unknown> {
  const { next_due_at, ...counts } = s;
  return {
    ...counts,
    limit: args.limit,
    max_minutes: args.maxMinutes,
    reask_after_days: REASK_AFTER_DAYS,
    // FIX-1330: the dispatcher reads metadata.next_due_at off the newest advancing row
    ...(next_due_at ? { next_due_at } : {}),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  apply: boolean;
  allowProd: boolean;
  limit: number | null;
  maxMinutes: number | null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs | { error: string } {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply === dryRun) return { error: "Pass exactly one of --dry-run or --apply." };
  const num = (flag: string): number | null | "bad" => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const n = Number(argv[at + 1]);
    return Number.isFinite(n) && n > 0 ? n : "bad";
  };
  const limit = num("--limit");
  const maxMinutes = num("--max-minutes");
  if (limit === "bad") return { error: "--limit takes a positive number of measures." };
  if (maxMinutes === "bad") return { error: "--max-minutes takes a positive number." };
  return { apply, allowProd: argv.includes("--allow-prod"), limit: limit === null ? null : Math.floor(limit), maxMinutes };
}

/** The live GET: fetchCongressApi's 200 ms, then the rest of the ~800 ms pace. */
function congressGet(apiKey: string): CongressGet {
  return async <T>(path: string): Promise<T> => {
    try {
      return await fetchCongressApi<T>(path, apiKey);
    } finally {
      await sleep(THROTTLE_MS - 200);
    }
  };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }
  const args = parsed;
  const apiKey = process.env["CONGRESS_API_KEY"] ?? process.env["CONGRESS_GOV_API_KEY"];
  if (!apiKey) {
    console.error("CONGRESS_API_KEY (or CONGRESS_GOV_API_KEY) not set in env.");
    process.exit(2);
  }
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const local = /127\.0\.0\.1|localhost/.test(url) && /127\.0\.0\.1|localhost/.test(buildDbUrl());
  if (!local && !args.allowProd) {
    console.error(`[crs-summaries] REFUSING a non-local DB (${url}) without --allow-prod.`);
    process.exit(2);
  }
  console.info("=================================================");
  console.info("  FIX-435 Phase 2 / FIX-1455 — CRS summaries → summary_plain, boxed");
  console.info(`  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  DB: ${local ? "local" : "PROD"}  limit=${args.limit ?? "none"}  max-minutes=${args.maxMinutes ?? "none"}`);
  console.info("=================================================");

  const logId = args.apply ? await startSync(PIPELINE) : "";
  let summary: RunSummary;
  try {
    summary = await withDirectClient(async (client) => {
      await client.query("SET statement_timeout = '60s'");
      await client.query(`SET application_name = '${PIPELINE}'`);
      const isHeld = async (): Promise<HoldReading> => {
        const state = await readProdSessionState(client);
        return { held: state?.defer === true, reason: state?.reason ?? null };
      };
      const heartbeat = async (s: RunSummary): Promise<void> => {
        if (!logId) return;
        await client.query(
          `UPDATE public.data_sync_log
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                             || jsonb_build_object('heartbeat_at', now()::text, 'asked', $2::int)
            WHERE id = $1 AND status = 'running'`,
          [logId, s.asked],
        );
      };
      return runCrsSummaries({
        client,
        get: congressGet(apiKey),
        apply: args.apply,
        limit: args.limit,
        maxMinutes: args.maxMinutes,
        isHeld,
        heartbeat,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[crs-summaries] fatal: ${msg}`);
    await failSync(logId, msg);
    process.exitCode = 1;
    return;
  }

  console.info(summaryLine(summary, args.apply));
  const metadata = runMetadata(summary, args);
  const close = closeAs(summary);
  if (close === "skipped") {
    await skipSync(logId, summary.stop_detail ?? prodSessionHoldReason(null), metadata);
  } else if (close === "failed") {
    await failSync(logId, `db_error: ${summary.stop_detail ?? ""}`, metadata);
    process.exitCode = 1;
  } else {
    await completeSync(logId, { inserted: 0, updated: summary.written, failed: summary.failed, estimatedMb: 0, metadata }, close);
  }
}

if (require.main === module) {
  main()
    .then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200))
    .catch((err) => {
      console.error("Fatal error:", err);
      setTimeout(() => process.exit(1), 200);
    });
}
