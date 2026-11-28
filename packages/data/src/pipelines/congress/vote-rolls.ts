/**
 * FIX-1448 (cc-331 D5, D6) — the vote-rolls walker: fills `vote_rolls` for
 * every federal roll stored in `votes`, from the roll's own source. The nightly
 * (votes.ts, D3) writes the row for each new roll; this walker is the backfill
 * and the net for a row the nightly did not write.
 *
 * A BOUNDED, RESUMABLE UNIT, in bill-details' image. Each run, in order:
 *   1. SEED — a row for every federal roll_call_id in `votes` that has none,
 *      with what the id gives (chamber, congress, session, number, the URL).
 *      The read is a loose walk of votes_roll_call (SEED_SQL: one index probe
 *      a roll, ~4,800 on prod), never a scan of `votes`. An id of another
 *      shape (Legistar, the synthetic chambers) is counted, not seeded.
 *   2. SENATE LISTS — for each session with a Senate row that has neither a
 *      list nor a detail stamp, one GET of that session's
 *      vote_menu_<congress>_<session>.xml: question, title, result, yeas, nays
 *      and the date for every roll. Six sessions, six GETs, ever.
 *   3. HOUSE DETAIL — rows with no detail, newest first, one GET each from
 *      clerk.house.gov, paced 750 ms plus jitter, up to --house-limit.
 *   4. SENATE DETAIL — the same from senate.gov at SENATE_PACE_MS, up to
 *      --senate-limit. The per-roll file adds present / not voting, the
 *      majority requirement and the tie-breaker; it replaces the list's fields.
 *      Rows whose list result reads against its count go first (cc-340 D1,
 *      READS_AGAINST_COUNT_SQL), then the same newest-first order.
 *
 * STOPS. Between rolls: --max-minutes, and a supervised session holding the box
 * (`prod_session_state()`'s `defer`). Per host: its limit; a 403 / 429 that is
 * still blocked after BLOCKED_RETRY_DELAYS_MS (roll-probe.ts' class) stops THAT
 * host for the run; three consecutive transient answers stop it too. A stop is
 * not a failure: the next run continues. A roll whose file does not parse (the
 * clerk answers a missing roll 200 with an error body) or answers 404 is
 * stamped with the reason and not asked again for PARSE_RETRY_DAYS.
 *
 * D6 — SENATE.GOV'S ALLOWANCE IS THE NIGHTLY'S FIRST. It serves programmatic
 * clients a few dozen GETs and then answers 403 (FIX-1372). So the walker
 * makes no senate.gov request from 15:00Z until the nightly's votes phase (the
 * congress_votes row) has closed, or until 06:00Z if it never does, and takes
 * at most --senate-limit rolls (20) a run. --senate-limit 0 sends nothing to
 * senate.gov, the lists included.
 *
 * WRITES. Only `vote_rolls`. A detail is one upsert of every column the
 * per-roll file owns (= vote-roll-row.ts mergeVoteRoll of a detail); a list is
 * one locked read-merge-write of the session's unlisted, undetailed rows. No
 * `votes` row is read beyond the seed's index walk, and none is written.
 *
 * Run (see docs/OPERATIONS.md §The vote-rolls walker):
 *   pnpm --filter @civitics/data data:vote-rolls -- --dry-run --house-limit 5 --senate-limit 0
 *   pnpm --filter @civitics/data data:vote-rolls -- --apply --house-limit 20 --senate-limit 5
 *   (prod) the dispatcher's vote-rolls unit starts vote-rolls.yml
 */

import type { Client } from "pg";
import { fetchText, sleep as realSleep } from "./members";
import { parseHouseRoll, parseSenateRoll } from "./votes";
import { isMeasureLocalDbError } from "./bill-details";
import { BLOCKED_RETRY_DELAYS_MS, classifyFetchError, looksLikeRoll, type RollOutcome } from "./roll-probe";
import { SENATE_PACE_MS } from "./senate-unstored";
import {
  FIELD_COLUMNS,
  IDENTITY_COLUMNS,
  LIST_COLUMNS,
  detailUpsertRow,
  houseRollFields,
  mergeVoteRoll,
  parseSenateVoteMenu,
  rollIdentity,
  seedRow,
  senateListUrl,
  senateRollFields,
  type Chamber,
  type DetailSource,
  type ListFields,
  type RollFields,
  type RollIdentity,
  type VoteRollRow,
} from "./vote-roll-row";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { buildDbUrl } from "../../lib/heavy-rebuild";
import { readProdSessionState } from "../../lib/prod-session";
import { prodSessionHoldReason } from "../nightly-hold";
import { startSync, completeSync, failSync, skipSync } from "../sync-log";

export const PIPELINE = "congress_vote_rolls";
export const HOUSE_PACE_MS = { base: 750, jitter: 250 } as const;
export const DEFAULT_HOUSE_LIMIT = 500;
/** D6: 20 a run. cc-331 read 2 saw no block in five nightlies (3 Senate GETs each), so nothing lowered it. */
export const DEFAULT_SENATE_LIMIT = 20;
export const PARSE_RETRY_DAYS = 7;
const TRANSIENT_STOP = 3;
const SEED_STATEMENT_TIMEOUT = "30s";
const HEARTBEAT_MS = 5 * 60_000;
/** cc-318 D7: how long a run that found nothing left rests its row. */
const EMPTY_REST_MS = 12 * 60 * 60_000;
const FAILURES_KEPT = 25;

/**
 * cc-340 D1 (FIX-1463) — a Senate session list's result words, as cc-340 read 2
 * found them on prod 2026-11-28: every list-only Senate row's result by
 * sign(yea − nay). A list carries no requirement and no tie-breaker. So a
 * negative word over more yeas (three-fifths, two-thirds, a veto sustained, an
 * acquittal) and any word over a tie (the Vice President's vote) read against
 * the count until the roll's own file replaces them. `Not Sustained` (1 row,
 * yea < nay) was in neither of the prompt's sets; it is placed here by hand.
 * The affirmative set is the rest of read 2's vocabulary, and the pick does
 * not read it.
 */
export const LIST_RESULT_WORDS = {
  negative: ["Rejected", "Veto Sustained", "Not Guilty", "Not Sustained"],
  affirmative: ["Agreed to", "Confirmed", "Passed", "Sustained", "Well Taken"],
} as const;

/**
 * D1: the Senate pick's first key, bound to LIST_RESULT_WORDS.negative as $5.
 * It is true only for a Senate row whose counts are both there and read
 * against its result: a tie, or more yeas under a negative word. A NULL count
 * makes the expression NULL, which DESC would sort first, so COALESCE makes it
 * false. A House row is always false.
 */
export const READS_AGAINST_COUNT_SQL =
  `COALESCE(chamber = 'Senate' AND (yea = nay OR (yea > nay AND result = ANY ($5::text[]))), false)`;

/** D6: the quiet span opens at 15:00Z and runs at most 15 h (to 06:00Z). */
export const SENATE_QUIET_START_HOUR = 15;
export const SENATE_QUIET_MAX_HOURS = 15;

/**
 * The seed read: a loose walk of votes_roll_call, one LIMIT 1 probe above the
 * last id. The step is a LATERAL join, not a scalar subquery, because EXPLAIN
 * (PG 17) does not print a subplan in a WorkTable Scan's target list, so the
 * subquery form's plan cannot be proved (cc-331 read 4). Prod's plan, read
 * 2026-11-27: Index Only Scan using votes_roll_call at both levels, the step's
 * Index Cond `roll_call_id > r.roll_call_id`.
 */
export const SEED_SQL =
  `WITH RECURSIVE r AS (
     (SELECT v.roll_call_id FROM public.votes v WHERE v.roll_call_id IS NOT NULL ORDER BY v.roll_call_id LIMIT 1)
     UNION ALL
     SELECT n.roll_call_id
       FROM r
      CROSS JOIN LATERAL (SELECT v.roll_call_id FROM public.votes v
                           WHERE v.roll_call_id > r.roll_call_id
                           ORDER BY v.roll_call_id LIMIT 1) n
   )
   SELECT r.roll_call_id FROM r`;

/** Every column a per-roll read writes, in one order for the upsert. */
export const DETAIL_WRITE_COLUMNS = [
  ...IDENTITY_COLUMNS, ...FIELD_COLUMNS, "detail_source", "detail_fetched_at", "detail_error", "detail_error_at",
] as const;

const DETAIL_UPSERT_SQL =
  `INSERT INTO public.vote_rolls (${DETAIL_WRITE_COLUMNS.join(", ")})
   SELECT ${DETAIL_WRITE_COLUMNS.join(", ")} FROM jsonb_populate_recordset(NULL::public.vote_rolls, $1::jsonb)
   ON CONFLICT (roll_call_id) DO UPDATE SET ${DETAIL_WRITE_COLUMNS.filter((c) => c !== "roll_call_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;

const SEED_INSERT_SQL =
  `INSERT INTO public.vote_rolls (${IDENTITY_COLUMNS.join(", ")})
   SELECT ${IDENTITY_COLUMNS.join(", ")} FROM jsonb_populate_recordset(NULL::public.vote_rolls, $1::jsonb)
   ON CONFLICT (roll_call_id) DO NOTHING`;

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

/** How a run's statements open and close a transaction — a SAVEPOINT in the clone test. */
export interface TxControl {
  begin(c: Client): Promise<void>;
  commit(c: Client): Promise<void>;
  rollback(c: Client): Promise<void>;
}

export const REAL_TX: TxControl = {
  begin: async (c) => { await c.query("BEGIN"); },
  commit: async (c) => { await c.query("COMMIT"); },
  rollback: async (c) => { await c.query("ROLLBACK"); },
};

export interface HoldReading {
  held: boolean;
  reason: string | null;
}

export interface RunOptions {
  client: Client;
  fetch: (url: string) => Promise<string>;
  apply: boolean;
  houseLimit: number;
  senateLimit: number;
  maxMinutes: number | null;
  isHeld: () => Promise<HoldReading>;
  /** When the nightly's votes phase last closed, among rows started at or after `since`. */
  votesPhaseClosedSince?: (since: Date) => Promise<string | null>;
  tx?: TxControl;
  /** Test seam: the clock D6 reads. */
  now?: () => Date;
  /** Test seam: every pace and retry wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: seed and select only these roll ids. */
  onlyIds?: readonly string[];
  heartbeat?: (s: RunSummary) => Promise<void>;
  log?: (line: string) => void;
}

export type StopReason = "done" | "max_minutes" | "held" | "db_error";
export type HostStop = "none_left" | "limit" | "blocked" | "transient" | "window" | "run_stopped";

export interface HostSummary {
  selected: number;
  gets: number;
  blocked_retries: number;
  detailed: number;
  not_parsed: number;
  transient: number;
  failed: number;
  stop: HostStop | null;
  stop_detail: string | null;
}

export interface RunSummary {
  stop: StopReason;
  stop_detail: string | null;
  seed_ids: number;
  seed_other_shape: number;
  seed_inserted: number;
  seed_ms: number;
  lists_selected: number;
  lists_read: number;
  list_rows_filled: number;
  list_rows_missing: number;
  list_db_ms: number;
  senate_window: string;
  house: HostSummary;
  senate: HostSummary;
  failures: Array<{ roll: string; why: string }>;
  rolls_detailed: number;
  /** Database time of the per-roll writes (details and stamps); the lists' is list_db_ms. */
  db_ms_total: number;
  db_ms_max: number;
  remaining_house: number;
  remaining_senate: number;
  remaining_list_rolls: number;
  elapsed_ms: number;
  /** Set only when nothing is left: now + 12 h. A stale_after row rests on it. */
  next_due_at: string | null;
}

function emptyHost(): HostSummary {
  return { selected: 0, gets: 0, blocked_retries: 0, detailed: 0, not_parsed: 0, transient: 0, failed: 0, stop: null, stop_detail: null };
}

function emptySummary(): RunSummary {
  return {
    stop: "done", stop_detail: null,
    seed_ids: 0, seed_other_shape: 0, seed_inserted: 0, seed_ms: 0,
    lists_selected: 0, lists_read: 0, list_rows_filled: 0, list_rows_missing: 0, list_db_ms: 0,
    senate_window: "open", house: emptyHost(), senate: emptyHost(), failures: [],
    rolls_detailed: 0, db_ms_total: 0, db_ms_max: 0,
    remaining_house: 0, remaining_senate: 0, remaining_list_rolls: 0,
    elapsed_ms: 0, next_due_at: null,
  };
}

// ---------------------------------------------------------------------------
// D6 — the Senate's quiet span
// ---------------------------------------------------------------------------

/** The 15:00Z that opened the quiet span `now` is in, or null outside one (06:00Z–15:00Z). */
export function quietSpanStart(now: Date): Date | null {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = now.getUTCHours() >= SENATE_QUIET_START_HOUR
    ? day + SENATE_QUIET_START_HOUR * 3_600_000
    : day + (SENATE_QUIET_START_HOUR - 24) * 3_600_000;
  return now.getTime() - start < SENATE_QUIET_MAX_HOURS * 3_600_000 ? new Date(start) : null;
}

/**
 * Whether the walker may ask senate.gov now. `readSpan` is the span the run
 * read the nightly in and `closedAt` what it read: the nightly's votes phase
 * closed inside that span. A span the run did not read (the clock crossed
 * 15:00Z mid-run) is quiet.
 */
export function senateWindow(now: Date, readSpan: Date | null, closedAt: string | null): { open: boolean; why: string } {
  const span = quietSpanStart(now);
  if (!span) return { open: true, why: "open" };
  if (readSpan && span.getTime() === readSpan.getTime() && closedAt) return { open: true, why: `open: the nightly's votes phase closed ${closedAt}` };
  return { open: false, why: `quiet since ${span.toISOString().slice(11, 16)}Z until the nightly's votes phase closes (06:00Z at the latest)` };
}

// ---------------------------------------------------------------------------
// Fetch — one host's pace, retries and stops
// ---------------------------------------------------------------------------

/** A GET that brought no body: classifyFetchError() never answers `roll`. */
type FetchFail = Exclude<RollOutcome, { kind: "roll" }>;

class Host {
  readonly name: string;
  readonly pace: { base: number; jitter: number };
  readonly summary: HostSummary;
  private streak = 0;
  constructor(name: string, pace: { base: number; jitter: number }, summary: HostSummary, private readonly o: RunOptions) {
    this.name = name;
    this.pace = pace;
    this.summary = summary;
  }

  get stopped(): boolean {
    return this.summary.stop !== null;
  }

  stopFor(stop: HostStop, detail: string | null = null): void {
    if (this.summary.stop === null) {
      this.summary.stop = stop;
      this.summary.stop_detail = detail;
    }
  }

  private async once(url: string): Promise<{ body: string } | { outcome: FetchFail }> {
    const wait = this.o.sleep ?? realSleep;
    if (this.summary.gets > 0) await wait(this.pace.base + Math.round(Math.random() * this.pace.jitter));
    this.summary.gets += 1;
    try {
      return { body: await this.o.fetch(url) };
    } catch (err) {
      return { outcome: classifyFetchError(err, { blocked: true }) as FetchFail };
    }
  }

  /**
   * One GET, a blocked answer retried after each of BLOCKED_RETRY_DELAYS_MS.
   * Blocked after the last retry, or a third transient in a row, stops this
   * host; the caller reads `stopped`.
   */
  async get(url: string): Promise<{ body: string } | { outcome: FetchFail }> {
    const wait = this.o.sleep ?? realSleep;
    let r = await this.once(url);
    for (const ms of BLOCKED_RETRY_DELAYS_MS) {
      if (!("outcome" in r) || r.outcome.kind !== "blocked") break;
      this.summary.blocked_retries += 1;
      await wait(ms);
      r = await this.once(url);
    }
    if ("outcome" in r) {
      if (r.outcome.kind === "blocked") this.stopFor("blocked", `${r.outcome.why} on ${url}`);
      if (r.outcome.kind === "transient") {
        this.summary.transient += 1;
        if (++this.streak >= TRANSIENT_STOP) this.stopFor("transient", r.outcome.why);
      } else {
        this.streak = 0;
      }
    } else {
      this.streak = 0;
    }
    return r;
  }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function fail(s: RunSummary, roll: string, why: string): void {
  if (s.failures.length < FAILURES_KEPT) s.failures.push({ roll, why: why.slice(0, 200) });
}

function dbTime(s: RunSummary, ms: number): void {
  s.db_ms_total += ms;
  s.db_ms_max = Math.max(s.db_ms_max, ms);
}

/** Step 1. Returns nothing; a database error throws to the loop, which stops the run. */
async function seed(o: RunOptions, tx: TxControl, s: RunSummary, log: (l: string) => void): Promise<void> {
  const t0 = Date.now();
  await tx.begin(o.client);
  try {
    await o.client.query(`SET LOCAL statement_timeout = '${SEED_STATEMENT_TIMEOUT}'`);
    const ids = (await o.client.query<{ roll_call_id: string }>(SEED_SQL)).rows.map((r) => r.roll_call_id);
    const have = new Set((await o.client.query<{ roll_call_id: string }>("SELECT roll_call_id FROM public.vote_rolls")).rows.map((r) => r.roll_call_id));
    const scope = o.onlyIds ? new Set(o.onlyIds) : null;
    const missing: RollIdentity[] = [];
    for (const id of ids) {
      if (scope && !scope.has(id)) continue;
      s.seed_ids += 1;
      const ident = rollIdentity(id);
      if (!ident) { s.seed_other_shape += 1; continue; }
      if (!have.has(id)) missing.push(ident);
    }
    if (o.apply && missing.length > 0) {
      const r = await o.client.query(SEED_INSERT_SQL, [JSON.stringify(missing)]);
      s.seed_inserted = r.rowCount ?? 0;
    } else {
      s.seed_inserted = o.apply ? 0 : missing.length;
    }
    await tx.commit(o.client);
  } catch (err) {
    await tx.rollback(o.client).catch(() => undefined);
    throw err;
  }
  s.seed_ms = Date.now() - t0;
  log(`  seed: ${s.seed_ids} roll ids (${s.seed_other_shape} of another shape, not seeded); ${s.seed_inserted} ${o.apply ? "inserted" : "would insert"} in ${s.seed_ms} ms`);
}

interface ListTarget { congress: number; session: number; rolls: number }

async function selectListSessions(o: RunOptions): Promise<ListTarget[]> {
  return (await o.client.query<ListTarget>(
    `SELECT congress::int AS congress, session::int AS session, count(*)::int AS rolls
       FROM public.vote_rolls
      WHERE chamber = 'Senate' AND detail_fetched_at IS NULL AND list_fetched_at IS NULL
        AND ($1::text[] IS NULL OR roll_call_id = ANY ($1::text[]))
      GROUP BY congress, session ORDER BY congress DESC, session DESC`,
    [o.onlyIds ?? null],
  )).rows;
}

interface ListedRow {
  roll_call_id: string;
  vote_date: string | null;
  question: string | null;
  title: string | null;
  result: string | null;
  yea: number | null;
  nay: number | null;
}

/** Step 2's write for one session: lock its unlisted, undetailed rows, merge, write back. */
async function writeList(
  o: RunOptions,
  tx: TxControl,
  t: ListTarget,
  entries: Map<string, ListFields>,
  at: string,
): Promise<{ filled: number; missing: number; ms: number }> {
  const t0 = Date.now();
  await tx.begin(o.client);
  try {
    const rows = (await o.client.query<ListedRow>(
      `SELECT roll_call_id, vote_date::text AS vote_date, question, title, result, yea, nay
         FROM public.vote_rolls
        WHERE chamber = 'Senate' AND congress = $1 AND session = $2
          AND detail_fetched_at IS NULL AND list_fetched_at IS NULL
          AND ($3::text[] IS NULL OR roll_call_id = ANY ($3::text[]))
        ORDER BY roll_call_id FOR UPDATE`,
      [t.congress, t.session, o.onlyIds ?? null],
    )).rows;
    let missing = 0;
    const out: Array<Pick<VoteRollRow, "roll_call_id" | "list_fetched_at"> & ListFields> = [];
    for (const r of rows) {
      const fields = entries.get(r.roll_call_id) ?? null;
      if (!fields) missing += 1;
      const current: VoteRollRow = { ...seedRow(rollIdentity(r.roll_call_id)!), ...r };
      const merged = mergeVoteRoll(current, { kind: "list", at, fields });
      out.push({
        roll_call_id: r.roll_call_id, list_fetched_at: merged.list_fetched_at,
        ...Object.fromEntries(LIST_COLUMNS.map((c) => [c, merged[c]])) as ListFields,
      });
    }
    if (o.apply && out.length > 0) {
      await o.client.query(
        `UPDATE public.vote_rolls t
            SET ${LIST_COLUMNS.map((c) => `${c} = s.${c}`).join(", ")}, list_fetched_at = s.list_fetched_at
           FROM jsonb_populate_recordset(NULL::public.vote_rolls, $1::jsonb) s
          WHERE t.roll_call_id = s.roll_call_id AND t.detail_fetched_at IS NULL`,
        [JSON.stringify(out)],
      );
      await tx.commit(o.client);
    } else {
      await tx.rollback(o.client);
    }
    return { filled: out.length - missing, missing, ms: Date.now() - t0 };
  } catch (err) {
    await tx.rollback(o.client).catch(() => undefined);
    throw err;
  }
}

interface DetailTarget { roll_call_id: string; source_url: string }

async function selectDetail(o: RunOptions, chamber: Chamber, limit: number): Promise<DetailTarget[]> {
  if (limit <= 0) return [];
  return (await o.client.query<DetailTarget>(
    `SELECT roll_call_id, source_url
       FROM public.vote_rolls
      WHERE chamber = $1 AND detail_fetched_at IS NULL
        AND (detail_error_at IS NULL OR detail_error_at < now() - make_interval(days => $2))
        AND ($3::text[] IS NULL OR roll_call_id = ANY ($3::text[]))
      ORDER BY ${READS_AGAINST_COUNT_SQL} DESC, congress DESC, session DESC, roll_number DESC
      LIMIT $4`,
    [chamber, PARSE_RETRY_DAYS, o.onlyIds ?? null, limit, [...LIST_RESULT_WORDS.negative]],
  )).rows;
}

async function writeDetail(o: RunOptions, id: RollIdentity, source: DetailSource, fields: RollFields): Promise<number> {
  const t0 = Date.now();
  if (o.apply) {
    const row = detailUpsertRow(id, source, new Date().toISOString(), fields);
    await o.client.query(DETAIL_UPSERT_SQL, [JSON.stringify([row])]);
  }
  return Date.now() - t0;
}

async function stampError(o: RunOptions, rollCallId: string, reason: string): Promise<number> {
  const t0 = Date.now();
  if (o.apply) {
    await o.client.query(
      `UPDATE public.vote_rolls SET detail_error = $2, detail_error_at = now()
        WHERE roll_call_id = $1 AND detail_fetched_at IS NULL`,
      [rollCallId, reason.slice(0, 200)],
    );
  }
  return Date.now() - t0;
}

async function remaining(o: RunOptions, s: RunSummary): Promise<void> {
  const r = (await o.client.query<{ house: number; senate: number; lists: number }>(
    `SELECT count(*) FILTER (WHERE chamber = 'House'  AND detail_fetched_at IS NULL AND (detail_error_at IS NULL OR detail_error_at < now() - make_interval(days => $1)))::int AS house,
            count(*) FILTER (WHERE chamber = 'Senate' AND detail_fetched_at IS NULL AND (detail_error_at IS NULL OR detail_error_at < now() - make_interval(days => $1)))::int AS senate,
            count(*) FILTER (WHERE chamber = 'Senate' AND detail_fetched_at IS NULL AND list_fetched_at IS NULL)::int AS lists
       FROM public.vote_rolls
      WHERE ($2::text[] IS NULL OR roll_call_id = ANY ($2::text[]))`,
    [PARSE_RETRY_DAYS, o.onlyIds ?? null],
  )).rows[0]!;
  s.remaining_house = r.house;
  s.remaining_senate = r.senate;
  s.remaining_list_rolls = r.lists;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** A database error that is one roll's data fails the roll; anything else stops the run. */
class RunStop extends Error {
  constructor(readonly reason: StopReason, readonly detail: string | null) {
    super(detail ?? reason);
  }
}

export async function runVoteRolls(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? ((l: string) => console.info(l));
  const tx = o.tx ?? REAL_TX;
  const now = o.now ?? (() => new Date());
  const t0 = Date.now();
  const s = emptySummary();
  const house = new Host("clerk.house.gov", HOUSE_PACE_MS, s.house, o);
  const senate = new Host("www.senate.gov", SENATE_PACE_MS, s.senate, o);
  let lastBeat = Date.now();

  /** Between rolls: the clock, the heartbeat, the hold. Throws RunStop. */
  const between = async (): Promise<void> => {
    if (o.maxMinutes !== null && Date.now() - t0 >= o.maxMinutes * 60_000) throw new RunStop("max_minutes", null);
    if (o.heartbeat && Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      await o.heartbeat(s).catch((err: unknown) => log(`  [heartbeat] ${err instanceof Error ? err.message : String(err)}`));
    }
    const hold = await o.isHeld();
    if (hold.held) throw new RunStop("held", prodSessionHoldReason(hold.reason));
  };
  /** A database error: one roll's data (22 / 23) fails the roll; anything else stops the run. */
  const dbFailed = (host: Host, roll: string, err: unknown): void => {
    const code = (err as { code?: string }).code ?? "?";
    const msg = err instanceof Error ? err.message : String(err);
    host.summary.failed += 1;
    fail(s, roll, `db ${code}: ${msg}`);
    if (!isMeasureLocalDbError(err)) throw new RunStop("db_error", `${code}: ${msg}`);
    log(`  ${roll}: write failed (db ${code}) — ${msg}`);
  };

  // D6: read the nightly once, for the span this run starts in.
  const readSpan = quietSpanStart(now());
  const closedAt = readSpan && o.votesPhaseClosedSince ? await o.votesPhaseClosedSince(readSpan) : null;
  const senateOpen = (): boolean => {
    const w = senateWindow(now(), readSpan, closedAt);
    s.senate_window = w.why;
    if (!w.open) senate.stopFor("window", w.why);
    return w.open;
  };
  if (o.senateLimit <= 0) senate.stopFor("limit", "--senate-limit 0");
  else senateOpen();

  try {
    await between();
    try {
      await seed(o, tx, s, log);
    } catch (err) {
      throw new RunStop("db_error", `seed: ${(err as { code?: string }).code ?? "?"}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 2 — the Senate session lists.
    const lists = senate.stopped ? [] : await selectListSessions(o);
    s.lists_selected = lists.length;
    for (const t of lists) {
      await between();
      if (senate.stopped || !senateOpen()) break;
      const url = senateListUrl(t.congress, t.session);
      const r = await senate.get(url);
      if ("outcome" in r) {
        if (r.outcome.kind !== "blocked" && r.outcome.kind !== "transient") fail(s, `list ${t.congress}-${t.session}`, `${r.outcome.kind}: ${r.outcome.why}`);
        log(`  list ${t.congress}-${t.session}: ${r.outcome.kind} — ${r.outcome.why}`);
        continue;
      }
      const parsed = parseSenateVoteMenu(r.body);
      if (!parsed || parsed.congress !== t.congress || parsed.session !== t.session) {
        fail(s, `list ${t.congress}-${t.session}`, "not a session list");
        log(`  list ${t.congress}-${t.session}: not a session list (${r.body.length} bytes)`);
        continue;
      }
      let w: { filled: number; missing: number; ms: number };
      try {
        w = await writeList(o, tx, t, new Map(parsed.entries.map((e) => [e.roll_call_id, e.fields])), new Date().toISOString());
      } catch (err) {
        dbFailed(senate, `list ${t.congress}-${t.session}`, err);
        continue;
      }
      s.list_db_ms += w.ms;
      s.lists_read += 1;
      s.list_rows_filled += w.filled;
      s.list_rows_missing += w.missing;
      log(`  list ${t.congress}-${t.session}: ${parsed.entries.length} votes listed; ${w.filled} of ${t.rolls} unlisted rolls filled, ${w.missing} not in the list · db ${w.ms} ms`);
    }

    // Steps 3 and 4 — the per-roll files.
    const steps: Array<{ host: Host; chamber: Chamber; limit: number; source: DetailSource }> = [
      { host: house, chamber: "House", limit: o.houseLimit, source: "clerk_xml" },
      { host: senate, chamber: "Senate", limit: o.senateLimit, source: "lis_roll_xml" },
    ];
    for (const step of steps) {
      if (step.limit <= 0) { step.host.stopFor("limit", "limit 0"); continue; }
      if (step.host.stopped) continue;
      const targets = await selectDetail(o, step.chamber, step.limit);
      step.host.summary.selected = targets.length;
      let n = 0;
      for (const t of targets) {
        await between();
        if (step.chamber === "Senate" && !senateOpen()) break;
        if (step.host.stopped) break;
        n += 1;
        const id = rollIdentity(t.roll_call_id);
        if (!id) { fail(s, t.roll_call_id, "not a federal roll id"); continue; }
        const r = await step.host.get(t.source_url);
        if ("outcome" in r) {
          const k = r.outcome.kind;
          if (k === "blocked" || k === "transient") {
            log(`  ${t.roll_call_id}: ${k} — ${r.outcome.why}${step.host.stopped ? ` · ${step.host.name} stopped for the run` : ""}`);
            continue;
          }
          // 404, another 4xx: the file is not there to read. Named, rested PARSE_RETRY_DAYS.
          try { dbTime(s, await stampError(o, t.roll_call_id, r.outcome.why)); } catch (err) { dbFailed(step.host, t.roll_call_id, err); continue; }
          step.host.summary.not_parsed += 1;
          log(`  ${t.roll_call_id}: ${r.outcome.why} — stamped, not asked again for ${PARSE_RETRY_DAYS} days`);
          continue;
        }
        const fields = readFields(step.chamber, r.body);
        if (typeof fields === "string") {
          try { dbTime(s, await stampError(o, t.roll_call_id, fields)); } catch (err) { dbFailed(step.host, t.roll_call_id, err); continue; }
          step.host.summary.not_parsed += 1;
          log(`  ${t.roll_call_id}: ${fields} — stamped, not asked again for ${PARSE_RETRY_DAYS} days`);
          continue;
        }
        let ms: number;
        try {
          ms = await writeDetail(o, { ...id, source_url: t.source_url }, step.source, fields);
        } catch (err) {
          dbFailed(step.host, t.roll_call_id, err);
          continue;
        }
        dbTime(s, ms);
        step.host.summary.detailed += 1;
        s.rolls_detailed += 1;
        log(`  ${t.roll_call_id}: ${fields.result ?? "(no result)"} ${fields.yea ?? "?"}-${fields.nay ?? "?"}-${fields.present ?? "?"}-${fields.not_voting ?? "?"} · db ${ms} ms`);
      }
      if (!step.host.stopped) step.host.stopFor(n >= step.limit && targets.length >= step.limit ? "limit" : "none_left");
    }
  } catch (err) {
    if (!(err instanceof RunStop)) throw err;
    s.stop = err.reason;
    s.stop_detail = err.detail;
    for (const h of [house, senate]) h.stopFor("run_stopped", err.reason);
  }

  if (s.stop !== "db_error") {
    await remaining(o, s);
    if (s.remaining_house === 0 && s.remaining_senate === 0 && s.remaining_list_rolls === 0) {
      s.next_due_at = new Date(Date.now() + EMPTY_REST_MS).toISOString();
    }
  }
  s.elapsed_ms = Date.now() - t0;
  return s;
}

/** A body's fields, or why it gave none. */
function readFields(chamber: Chamber, body: string): RollFields | string {
  if (chamber === "House") {
    if (!looksLikeRoll(body, "rollcall-vote")) return "non-roll body";
    const p = parseHouseRoll(body);
    return p ? houseRollFields(p.meta) : "unparseable roll body";
  }
  if (!looksLikeRoll(body, "roll_call_vote")) return "non-roll body";
  const p = parseSenateRoll(body);
  return p ? senateRollFields(p) : "unparseable roll body";
}

// ---------------------------------------------------------------------------
// The run row and the summary line
// ---------------------------------------------------------------------------

function hostLine(name: string, h: HostSummary): string {
  return (
    `${name} detail=${h.detailed}/${h.selected} not_parsed=${h.not_parsed} transient=${h.transient} failed=${h.failed}` +
    ` gets=${h.gets} (retries ${h.blocked_retries}) stop=${h.stop ?? "-"}${h.stop_detail ? ` (${h.stop_detail})` : ""}`
  );
}

export function summaryLine(s: RunSummary, apply: boolean): string {
  const writes = s.rolls_detailed + s.house.not_parsed + s.senate.not_parsed;
  const perRoll = writes > 0 ? Math.round(s.db_ms_total / writes) : 0;
  return (
    `vote-rolls ${apply ? "APPLY" : "DRY-RUN"}: seed ids=${s.seed_ids} other_shape=${s.seed_other_shape} ${apply ? "inserted" : "would_insert"}=${s.seed_inserted} (${s.seed_ms} ms)` +
    ` lists ${s.lists_read}/${s.lists_selected} read, rows filled=${s.list_rows_filled} missing=${s.list_rows_missing} (${s.list_db_ms} ms)` +
    ` · ${hostLine("house", s.house)} · ${hostLine("senate", s.senate)} · senate window: ${s.senate_window}` +
    ` · stop=${s.stop}${s.stop_detail ? ` (${s.stop_detail})` : ""}` +
    ` remaining house=${s.remaining_house} senate=${s.remaining_senate} list_rolls=${s.remaining_list_rolls}` +
    ` elapsed=${(s.elapsed_ms / 1000).toFixed(1)}s db_ms/roll=${perRoll} (max ${s.db_ms_max})`
  );
}

function runMetadata(s: RunSummary, args: CliArgs): Record<string, unknown> {
  const { failures, next_due_at, ...counts } = s;
  return {
    ...counts,
    ...(next_due_at ? { next_due_at } : {}),
    failures,
    house_limit: args.houseLimit,
    senate_limit: args.senateLimit,
    max_minutes: args.maxMinutes,
    rows_by_table: { vote_rolls: s.seed_inserted + s.list_rows_filled + s.rolls_detailed },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  apply: boolean;
  allowProd: boolean;
  houseLimit: number;
  senateLimit: number;
  maxMinutes: number | null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs | { error: string } {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply === dryRun) return { error: "Pass exactly one of --dry-run or --apply." };
  const num = (flag: string, min: number): number | null | "bad" => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const n = Number(argv[at + 1]);
    return Number.isFinite(n) && n >= min ? n : "bad";
  };
  const house = num("--house-limit", 0);
  const senateN = num("--senate-limit", 0);
  const maxMinutes = num("--max-minutes", Number.MIN_VALUE);
  if (house === "bad") return { error: "--house-limit takes a whole number of rolls, 0 or more." };
  if (senateN === "bad") return { error: "--senate-limit takes a whole number of rolls, 0 or more." };
  if (maxMinutes === "bad") return { error: "--max-minutes takes a positive number." };
  return {
    apply,
    allowProd: argv.includes("--allow-prod"),
    houseLimit: house === null ? DEFAULT_HOUSE_LIMIT : Math.floor(house),
    senateLimit: senateN === null ? DEFAULT_SENATE_LIMIT : Math.floor(senateN),
    maxMinutes,
  };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }
  const args = parsed;
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const local = /127\.0\.0\.1|localhost/.test(url) && /127\.0\.0\.1|localhost/.test(buildDbUrl());
  if (!local && !args.allowProd) {
    console.error(`[vote-rolls] REFUSING a non-local DB (${url}) without --allow-prod.`);
    process.exit(2);
  }
  console.info("=================================================");
  console.info("  FIX-1448 — vote_rolls: each roll's own totals, result and title");
  console.info(`  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  DB: ${local ? "local" : "PROD"}  house-limit=${args.houseLimit}  senate-limit=${args.senateLimit}  max-minutes=${args.maxMinutes ?? "none"}`);
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
      const votesPhaseClosedSince = async (since: Date): Promise<string | null> => {
        const r = await client.query<{ at: string | null }>(
          `SELECT max(completed_at)::text AS at FROM public.data_sync_log
            WHERE pipeline = 'congress_votes' AND started_at >= $1 AND completed_at IS NOT NULL`,
          [since.toISOString()],
        );
        return r.rows[0]?.at ?? null;
      };
      const heartbeat = async (s: RunSummary): Promise<void> => {
        if (!logId) return;
        await client.query(
          `UPDATE public.data_sync_log
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                             || jsonb_build_object('heartbeat_at', now()::text, 'rolls_detailed', $2::int)
            WHERE id = $1 AND status = 'running'`,
          [logId, s.rolls_detailed],
        );
      };
      return runVoteRolls({
        client,
        fetch: fetchText,
        apply: args.apply,
        houseLimit: args.houseLimit,
        senateLimit: args.senateLimit,
        maxMinutes: args.maxMinutes,
        isHeld,
        votesPhaseClosedSince,
        heartbeat,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vote-rolls] fatal: ${msg}`);
    await failSync(logId, msg);
    process.exitCode = 1;
    return;
  }

  console.info(summaryLine(summary, args.apply));
  const metadata = runMetadata(summary, args);
  const result = {
    inserted: summary.seed_inserted,
    updated: summary.list_rows_filled + summary.rolls_detailed,
    failed: summary.house.failed + summary.senate.failed,
    estimatedMb: 0,
    metadata,
  };
  const nothingDone = summary.seed_inserted + summary.lists_read + summary.rolls_detailed + summary.house.not_parsed + summary.senate.not_parsed === 0;
  if (summary.stop === "held" && nothingDone) {
    await skipSync(logId, summary.stop_detail ?? prodSessionHoldReason(null), metadata);
  } else if (summary.stop === "db_error") {
    await failSync(logId, `db_error: ${summary.stop_detail ?? ""}`, metadata);
    process.exitCode = 1;
  } else {
    const whole = summary.stop === "done" && summary.remaining_house + summary.remaining_senate + summary.remaining_list_rolls === 0;
    await completeSync(logId, result, whole ? "complete" : "partial");
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
