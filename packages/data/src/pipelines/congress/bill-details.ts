/**
 * FIX-1452 (cc-327) — the congress.gov bill-details walker: sponsor,
 * cosponsors, actions, real titles and introduced dates, into tables that
 * already existed and were empty (prod 2026-11-26: primary_sponsor_id on 0 of
 * the 8,983 federal measures, proposal_cosponsors and proposal_actions 0 rows).
 *
 * A BOUNDED, RESUMABLE UNIT (D1, D2). It takes a measure only while its
 * `congress_gov` ref carries no `metadata.detail.fetched_at`, in the order:
 * measures with votes first, then Congress descending, then last action
 * descending. Between measures it stops on --limit, on --max-minutes, on three
 * consecutive 429 / 5xx / no-response answers, and when `prod_session_state()`
 * says a supervised session holds the box (`defer`, the one read the nightly
 * and the USASpending CI use to yield). A stop mid-list is not a failure; the
 * next run continues from the measures still unstamped. Its class is the CRS
 * walker's (D8): a paced trickle with no claim of its own that yields to one.
 *
 * ONE MEASURE, ONE TRANSACTION (D2). Its sponsor, cosponsor rows, action rows,
 * title / introduced-date fills and its `fetched_at` stamp commit together or
 * not at all, over one direct connection (the admin client cannot hold a
 * transaction across tables). A detail 404 is stamped `not_found` so it is
 * named, not retried.
 *
 * WHAT IT WRITES, AND ONLY WHEN (D3–D7)
 *   bill_details.primary_sponsor_id  when the sponsor's bioguide resolves to
 *                                    EXACTLY one officials row and the column is
 *                                    NULL; never a name match.
 *   proposal_cosponsors              one row per cosponsor resolving to exactly
 *                                    one official, source 'congress_gov'; an
 *                                    existing row is updated only if this
 *                                    walker wrote it.
 *   proposal_actions                 every action, source 'congress_gov', keyed
 *                                    by source_key (20261126003000); both
 *                                    source systems' rows are kept.
 *   proposals.title                  only when empty or just the bill number.
 *   proposals.introduced_at          when NULL, or when it is the vote path's
 *                                    placeholder (the first roll's date on a
 *                                    measure still titled by its number) —
 *                                    cc-327's one deviation from D6.
 *   external_source_refs.metadata    `detail`: the source's sponsor, title,
 *                                    short title, introduced date, policy area,
 *                                    cosponsor counts (the SOURCE's — stored
 *                                    rows are not the count, FIX-1448) and the
 *                                    unresolved, and the stamp.
 * Not its own: status (proposals_advance_status), latest_action, summary_plain,
 * votes, AI text, entity_connections.
 *
 * PACING. fetchCongressApi sleeps 200 ms and the walker adds 600 ms after
 * every request: ~800 ms a request, the CRS walker's ~4,500 an hour (the key's
 * ceiling read 20,000 / h on 2026-11-26; it is shared with the nightly). Three
 * requests a measure when the source lists no cosponsors, four when it does.
 *
 * Run (see docs/OPERATIONS.md §The bill-details walker):
 *   pnpm --filter @civitics/data data:bill-details -- --dry-run --limit 5
 *   pnpm --filter @civitics/data data:bill-details -- --apply --only voted --limit 10
 *   gh workflow run bill-details.yml -f only=voted -f max_minutes=120   (prod)
 */

import type { Client } from "pg";
import { fetchCongressApi, sleep } from "./members";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { buildDbUrl } from "../../lib/heavy-rebuild";
import { readProdSessionState } from "../../lib/prod-session";
import { prodSessionHoldReason } from "../nightly-hold";
import { startSync, completeSync, failSync, skipSync } from "../sync-log";
import {
  BILL_TYPES,
  billPath,
  buildBioguideResolver,
  decideIntroduced,
  decideTitle,
  httpStatusOf,
  isNumberTitle,
  isTransient,
  needsCosponsors,
  needsTitles,
  nextPage,
  parseActionPages,
  parseBillDetail,
  parseBillKey,
  parseCosponsorPages,
  pickShortTitle,
  resolveCosponsors,
  titleForColumn,
  type ActionsPage,
  type BillDetailResponse,
  type BioguideResolution,
  type CosponsorsPage,
  type FillOutcome,
  type OfficialBioguideRow,
  type ParsedActions,
  type ParsedCosponsors,
  type ParsedDetail,
  type TitlesPage,
  type UnresolvedMember,
} from "./bill-details-parse";

export const PIPELINE = "congress_bill_details";
const THROTTLE_MS = 800;
const MAX_PAGES = 40;
const TRANSIENT_STOP = 3;
/** Each measure's statements; the run's own reads get the session's 60 s. */
const MEASURE_STATEMENT_TIMEOUT = "30s";
/** A failure list longer than this is counted, not listed. */
const FAILURES_KEPT = 25;

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export type Only = "voted" | "all";

export interface Target {
  ref_id: string;
  proposal_id: string;
  external_id: string;
  voted: boolean;
}

/** A congress.gov GET: a path or a pagination URL in, parsed JSON out. */
export type CongressGet = <T>(pathOrUrl: string) => Promise<T>;

/** How a measure's transaction opens and closes — a SAVEPOINT in the clone test. */
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
  get: CongressGet;
  apply: boolean;
  only: Only;
  limit: number | null;
  maxMinutes: number | null;
  isHeld: () => Promise<HoldReading>;
  tx?: TxControl;
  /** Test seam: take only these external ids. */
  keys?: readonly string[];
  /** Test seam: resolve bioguides from these rows instead of `officials`. */
  officials?: readonly OfficialBioguideRow[];
  /** Test seam: the backoff after a transient answer. */
  backoffMs?: (streak: number) => number;
  /**
   * Called between measures at most every HEARTBEAT_MS: the run row's
   * metadata.heartbeat_at, which reap_stale_sync_log() reads before started_at
   * (FIX-1291), so a run longer than the nightly's 60-min reap is not reaped.
   */
  heartbeat?: (s: RunSummary) => Promise<void>;
  log?: (line: string) => void;
}

const HEARTBEAT_MS = 5 * 60_000;

export type StopReason = "done" | "limit" | "max_minutes" | "held" | "api_errors" | "db_error";

export interface RunSummary {
  stop: StopReason;
  stop_detail: string | null;
  selected: number;
  remaining: number;
  measures_done: number;
  measures_stamped: number;
  measures_not_found: number;
  measures_failed: number;
  failures: Array<{ key: string; why: string }>;
  requests: number;
  sponsors_set: number;
  sponsors_same: number;
  sponsors_kept_differs: number;
  sponsors_unresolved_none: number;
  sponsors_unresolved_many: number;
  sponsors_absent: number;
  no_bill_details: number;
  cosponsors_source: number;
  cosponsors_inserted: number;
  cosponsors_updated: number;
  cosponsors_unresolved: number;
  actions_source: number;
  actions_inserted: number;
  actions_undated: number;
  actions_duplicate_key: number;
  titles_filled: number;
  titles_kept_differs: number;
  introduced_filled: number;
  introduced_replaced_placeholder: number;
  introduced_kept_differs: number;
  db_ms_total: number;
  db_ms_max: number;
  elapsed_ms: number;
}

function emptySummary(): RunSummary {
  return {
    stop: "done", stop_detail: null, selected: 0, remaining: 0,
    measures_done: 0, measures_stamped: 0, measures_not_found: 0, measures_failed: 0, failures: [],
    requests: 0,
    sponsors_set: 0, sponsors_same: 0, sponsors_kept_differs: 0, sponsors_unresolved_none: 0,
    sponsors_unresolved_many: 0, sponsors_absent: 0, no_bill_details: 0,
    cosponsors_source: 0, cosponsors_inserted: 0, cosponsors_updated: 0, cosponsors_unresolved: 0,
    actions_source: 0, actions_inserted: 0, actions_undated: 0, actions_duplicate_key: 0,
    titles_filled: 0, titles_kept_differs: 0, introduced_filled: 0, introduced_replaced_placeholder: 0, introduced_kept_differs: 0,
    db_ms_total: 0, db_ms_max: 0, elapsed_ms: 0,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Every unstamped bill / resolution ref, in D1's order. Nominations carry a
 * congress_gov proposal ref too and are excluded by type. Read once a run; the
 * loop re-checks the stamp under the row lock, so two runs never write one
 * measure twice.
 */
export async function selectTargets(c: Client, only: Only, keys?: readonly string[]): Promise<Target[]> {
  const res = await c.query<Target>(
    `SELECT t.ref_id, t.proposal_id, t.external_id, t.voted
       FROM (
         SELECT x.id AS ref_id, x.entity_id AS proposal_id, x.external_id,
                EXISTS (SELECT 1 FROM public.votes v WHERE v.bill_proposal_id = x.entity_id) AS voted,
                split_part(x.external_id, '-', 1)::int AS congress,
                p.last_action_at
           FROM public.external_source_refs x
           JOIN public.proposals p ON p.id = x.entity_id
          WHERE x.source = 'congress_gov'
            AND x.entity_type = 'proposal'
            AND x.external_id ~ '^[0-9]+-[A-Z]+-[0-9]+$'
            AND split_part(x.external_id, '-', 2) = ANY ($1::text[])
            AND (x.metadata -> 'detail' ->> 'fetched_at') IS NULL
            AND ($2::text[] IS NULL OR x.external_id = ANY ($2::text[]))
       ) t
      WHERE ($3::boolean IS FALSE OR t.voted)
      ORDER BY t.voted DESC, t.congress DESC, t.last_action_at DESC NULLS LAST, t.external_id`,
    [BILL_TYPES, keys && keys.length > 0 ? keys : null, only === "voted"],
  );
  return res.rows;
}

async function loadOfficials(c: Client): Promise<OfficialBioguideRow[]> {
  const res = await c.query<OfficialBioguideRow>(
    `SELECT id, source_ids FROM public.officials WHERE source_ids ? 'congress_gov'`,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export class MeasureFetchError extends Error {
  readonly status: number | null;
  readonly path: string;
  /** Requests this measure made, the failing one included. */
  readonly requests: number;
  constructor(status: number | null, path: string, message: string, requests = 1) {
    super(message);
    this.name = "MeasureFetchError";
    this.status = status;
    this.path = path;
    this.requests = requests;
  }
}

export interface FetchedMeasure {
  detail: ParsedDetail;
  cosponsors: ParsedCosponsors | null;
  actions: ParsedActions;
  shortTitle: string | null;
  requests: number;
}

/** The live GET: fetchCongressApi's 200 ms, then the rest of the ~800 ms pace. */
export function congressGet(apiKey: string): CongressGet {
  return async <T>(pathOrUrl: string): Promise<T> => {
    try {
      return await fetchCongressApi<T>(pathOrUrl, apiKey);
    } finally {
      await sleep(THROTTLE_MS - 200);
    }
  };
}

export async function fetchMeasure(get: CongressGet, externalId: string): Promise<FetchedMeasure> {
  const key = parseBillKey(externalId);
  if (!key) throw new MeasureFetchError(400, externalId, `unparseable bill key ${externalId}`, 0);
  let requests = 0;
  const one = async <T>(path: string): Promise<T> => {
    requests += 1;
    try {
      return await get<T>(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      throw new MeasureFetchError(httpStatusOf(err), path, msg.replace(/api_key=[^&\s]+/g, "api_key=…"), requests);
    }
  };
  const pages = async <T extends { pagination?: { next?: string } }>(path: string): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null = path;
    while (next && out.length < MAX_PAGES) {
      const page: T = await one<T>(next);
      out.push(page);
      next = nextPage(page);
    }
    return out;
  };

  const detail = parseBillDetail(await one<BillDetailResponse>(billPath(key)));
  const cosponsors = needsCosponsors(detail)
    ? parseCosponsorPages(await pages<CosponsorsPage>(billPath(key, "cosponsors")))
    : null;
  const actions = parseActionPages(await pages<ActionsPage>(billPath(key, "actions")));
  const shortTitle = needsTitles(detail) ? pickShortTitle(await pages<TitlesPage>(billPath(key, "titles"))) : null;
  return { detail, cosponsors, actions, shortTitle, requests };
}

// ---------------------------------------------------------------------------
// Write — one measure, one transaction
// ---------------------------------------------------------------------------

export interface MeasureWrite {
  sponsor: "set" | "same" | "kept_differs" | "unresolved_none" | "unresolved_many" | "absent" | "no_bill_details";
  cosponsorsInserted: number;
  cosponsorsUpdated: number;
  cosponsorsUnresolved: UnresolvedMember[];
  cosponsorsResolved: number;
  actionsInserted: number;
  title: FillOutcome;
  introduced: FillOutcome;
  dbMs: number;
}

interface CurrentRow {
  stamped: string | null;
  title: string | null;
  introduced_at: string | null;
  bill_number: string | null;
  has_bill_details: boolean;
  primary_sponsor_id: string | null;
  /** The measure's first roll's date — the vote path's introduced_at placeholder. */
  first_vote: string | null;
}

async function readCurrent(c: Client, t: Target, lock: boolean): Promise<CurrentRow | null> {
  const ref = await c.query<{ stamped: string | null }>(
    `SELECT metadata -> 'detail' ->> 'fetched_at' AS stamped
       FROM public.external_source_refs WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [t.ref_id],
  );
  if (ref.rows.length === 0) return null;
  const p = await c.query<Omit<CurrentRow, "stamped">>(
    `SELECT p.title, p.introduced_at::text AS introduced_at, bd.bill_number,
            (bd.proposal_id IS NOT NULL) AS has_bill_details, bd.primary_sponsor_id,
            (SELECT min(v.voted_at)::date::text FROM public.votes v WHERE v.bill_proposal_id = p.id) AS first_vote
       FROM public.proposals p
       LEFT JOIN public.bill_details bd ON bd.proposal_id = p.id
      WHERE p.id = $1${lock ? " FOR UPDATE OF p" : ""}`,
    [t.proposal_id],
  );
  if (p.rows.length === 0) return null;
  return { stamped: ref.rows[0]!.stamped, ...p.rows[0]! };
}

/** D6, with cc-327's one deviation: the placeholder date is passed only while the title is still the number. */
function introducedOutcome(cur: CurrentRow, f: FetchedMeasure): FillOutcome {
  const placeholder = isNumberTitle(cur.title, cur.bill_number) ? cur.first_vote : null;
  return decideIntroduced(cur.introduced_at, f.detail.introducedDate, placeholder);
}

function sponsorOutcome(cur: CurrentRow, r: BioguideResolution | null): MeasureWrite["sponsor"] {
  if (!cur.has_bill_details) return "no_bill_details";
  if (!r) return "absent";
  if (r.kind === "none") return "unresolved_none";
  if (r.kind === "many") return "unresolved_many";
  if (cur.primary_sponsor_id === null) return "set";
  return cur.primary_sponsor_id === r.id ? "same" : "kept_differs";
}

function detailStamp(f: FetchedMeasure, w: MeasureWrite, sponsorId: string | null, at: string): Record<string, unknown> {
  return {
    fetched_at: at,
    source_update_date: f.detail.updateDate,
    sponsor: f.detail.sponsor,
    sponsors_listed: f.detail.sponsorsListed,
    sponsor_official_id: sponsorId,
    sponsor_outcome: w.sponsor,
    title: f.detail.title,
    short_title: f.shortTitle,
    introduced_date: f.detail.introducedDate,
    policy_area: f.detail.policyArea,
    title_outcome: w.title,
    introduced_outcome: w.introduced,
    cosponsor_count: f.cosponsors?.count ?? f.detail.cosponsorCount,
    cosponsor_count_including_withdrawn: f.cosponsors?.countIncludingWithdrawn ?? f.detail.cosponsorCountIncludingWithdrawn,
    cosponsors_listed: f.cosponsors?.items.length ?? 0,
    cosponsors_resolved: w.cosponsorsResolved,
    cosponsors_unresolved: w.cosponsorsUnresolved,
    action_count: f.actions.count,
    actions_stored: f.actions.rows.length,
    actions_undated: f.actions.undated,
    actions_duplicate_key: f.actions.duplicateKey,
    requests: f.requests,
  };
}

/** Returns null when the measure was stamped by someone else between selection and the lock. */
export async function writeMeasure(
  c: Client,
  tx: TxControl,
  t: Target,
  f: FetchedMeasure,
  resolve: (bioguide: string) => BioguideResolution,
  apply: boolean,
): Promise<MeasureWrite | null> {
  const started = Date.now();
  const sponsorRes = f.detail.sponsor ? resolve(f.detail.sponsor.bioguide) : null;
  const cos = resolveCosponsors(f.cosponsors?.items ?? [], resolve);

  if (!apply) {
    const cur = await readCurrent(c, t, false);
    if (!cur || cur.stamped) return null;
    return {
      sponsor: sponsorOutcome(cur, sponsorRes),
      cosponsorsInserted: cos.rows.length,
      cosponsorsUpdated: 0,
      cosponsorsUnresolved: cos.unresolved,
      cosponsorsResolved: cos.rows.length,
      actionsInserted: f.actions.rows.length,
      title: decideTitle(cur.title, cur.bill_number, f.detail.title),
      introduced: introducedOutcome(cur, f),
      dbMs: Date.now() - started,
    };
  }

  await tx.begin(c);
  try {
    await c.query(`SET LOCAL statement_timeout = '${MEASURE_STATEMENT_TIMEOUT}'`);
    const cur = await readCurrent(c, t, true);
    if (!cur || cur.stamped) {
      await tx.rollback(c);
      return null;
    }

    const sponsor = sponsorOutcome(cur, sponsorRes);
    const sponsorId = sponsorRes?.kind === "one" ? sponsorRes.id : null;
    if (sponsor === "set") {
      await c.query(
        `UPDATE public.bill_details SET primary_sponsor_id = $2
          WHERE proposal_id = $1 AND primary_sponsor_id IS NULL`,
        [t.proposal_id, sponsorId],
      );
    }

    let cosponsorsInserted = 0;
    let cosponsorsUpdated = 0;
    if (cos.rows.length > 0) {
      const r = await c.query<{ inserted: boolean }>(
        `INSERT INTO public.proposal_cosponsors
                (proposal_id, official_id, is_original_cosponsor, date_added, date_withdrawn, source)
         SELECT $1, u.official_id, u.is_original, u.date_added, u.date_withdrawn, 'congress_gov'
           FROM unnest($2::uuid[], $3::boolean[], $4::date[], $5::date[])
                AS u(official_id, is_original, date_added, date_withdrawn)
         ON CONFLICT (proposal_id, official_id) DO UPDATE
            SET is_original_cosponsor = EXCLUDED.is_original_cosponsor,
                date_added            = EXCLUDED.date_added,
                date_withdrawn        = EXCLUDED.date_withdrawn
          WHERE public.proposal_cosponsors.source = 'congress_gov'
            AND (public.proposal_cosponsors.is_original_cosponsor,
                 public.proposal_cosponsors.date_added,
                 public.proposal_cosponsors.date_withdrawn)
                IS DISTINCT FROM
                (EXCLUDED.is_original_cosponsor, EXCLUDED.date_added, EXCLUDED.date_withdrawn)
         RETURNING (xmax = 0) AS inserted`,
        [
          t.proposal_id,
          cos.rows.map((x) => x.official_id),
          cos.rows.map((x) => x.is_original_cosponsor),
          cos.rows.map((x) => x.date_added),
          cos.rows.map((x) => x.date_withdrawn),
        ],
      );
      for (const row of r.rows) {
        if (row.inserted) cosponsorsInserted += 1;
        else cosponsorsUpdated += 1;
      }
    }

    let actionsInserted = 0;
    if (f.actions.rows.length > 0) {
      const a = f.actions.rows;
      const r = await c.query(
        `INSERT INTO public.proposal_actions
                (proposal_id, action_type, action_at, description, source, source_key, metadata)
         SELECT $1, u.action_type, (u.at_eastern::timestamp AT TIME ZONE 'America/New_York'),
                u.description, 'congress_gov', u.source_key, u.metadata::jsonb
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                AS u(action_type, at_eastern, description, source_key, metadata)
         ON CONFLICT (proposal_id, source, source_key) DO NOTHING`,
        [
          t.proposal_id,
          a.map((x) => x.action_type),
          a.map((x) => x.action_at_eastern),
          a.map((x) => x.description),
          a.map((x) => x.source_key),
          a.map((x) => JSON.stringify(x.metadata)),
        ],
      );
      actionsInserted = r.rowCount ?? 0;
    }

    // Decided on the values read under the row lock, so no re-assert is needed.
    const title = decideTitle(cur.title, cur.bill_number, f.detail.title);
    const introduced = introducedOutcome(cur, f);
    const setTitle = title === "filled";
    const setIntroduced = introduced === "filled" || introduced === "replaced_placeholder";
    if (setTitle || setIntroduced) {
      await c.query(
        `UPDATE public.proposals
            SET title         = CASE WHEN $2 THEN $3 ELSE title END,
                introduced_at = CASE WHEN $4 THEN $5::date ELSE introduced_at END
          WHERE id = $1`,
        [
          t.proposal_id,
          setTitle,
          setTitle ? titleForColumn(f.detail.title!) : null,
          setIntroduced,
          setIntroduced ? f.detail.introducedDate : null,
        ],
      );
    }

    const w: MeasureWrite = {
      sponsor, cosponsorsInserted, cosponsorsUpdated,
      cosponsorsUnresolved: cos.unresolved, cosponsorsResolved: cos.rows.length,
      actionsInserted, title, introduced, dbMs: 0,
    };
    await c.query(
      `UPDATE public.external_source_refs
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('detail', $2::jsonb)
        WHERE id = $1`,
      [t.ref_id, JSON.stringify(detailStamp(f, w, sponsorId, new Date().toISOString()))],
    );
    await tx.commit(c);
    w.dbMs = Date.now() - started;
    return w;
  } catch (err) {
    await tx.rollback(c).catch(() => undefined);
    throw err;
  }
}

/** A detail 404: the measure is named, not retried. */
async function stampNotFound(c: Client, tx: TxControl, t: Target, status: number): Promise<boolean> {
  await tx.begin(c);
  try {
    await c.query(`SET LOCAL statement_timeout = '${MEASURE_STATEMENT_TIMEOUT}'`);
    const r = await c.query(
      `UPDATE public.external_source_refs
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('detail', jsonb_build_object('fetched_at', $2::text, 'http_status', $3::int, 'not_found', true))
        WHERE id = $1 AND (metadata -> 'detail' ->> 'fetched_at') IS NULL`,
      [t.ref_id, new Date().toISOString(), status],
    );
    await tx.commit(c);
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    await tx.rollback(c).catch(() => undefined);
    throw err;
  }
}

/**
 * SQLSTATE classes that are one measure's data, not the database's health: an
 * integrity violation (23) or a data exception (22) fails the measure and the
 * run goes on. Anything else — a cancel (57014), a lock timeout (55P03), a
 * lost connection (08), resources (53) — stops the run.
 */
export function isMeasureLocalDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("23") || code.startsWith("22"));
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function tally(s: RunSummary, f: FetchedMeasure, w: MeasureWrite): void {
  s.measures_done += 1;
  s.measures_stamped += 1;
  switch (w.sponsor) {
    case "set": s.sponsors_set += 1; break;
    case "same": s.sponsors_same += 1; break;
    case "kept_differs": s.sponsors_kept_differs += 1; break;
    case "unresolved_none": s.sponsors_unresolved_none += 1; break;
    case "unresolved_many": s.sponsors_unresolved_many += 1; break;
    case "absent": s.sponsors_absent += 1; break;
    case "no_bill_details": s.no_bill_details += 1; break;
  }
  s.cosponsors_source += f.cosponsors?.count ?? f.detail.cosponsorCount;
  s.cosponsors_inserted += w.cosponsorsInserted;
  s.cosponsors_updated += w.cosponsorsUpdated;
  s.cosponsors_unresolved += w.cosponsorsUnresolved.length;
  s.actions_source += f.actions.count;
  s.actions_inserted += w.actionsInserted;
  s.actions_undated += f.actions.undated;
  s.actions_duplicate_key += f.actions.duplicateKey;
  if (w.title === "filled") s.titles_filled += 1;
  if (w.title === "kept_differs") s.titles_kept_differs += 1;
  if (w.introduced === "filled") s.introduced_filled += 1;
  if (w.introduced === "replaced_placeholder") s.introduced_replaced_placeholder += 1;
  if (w.introduced === "kept_differs") s.introduced_kept_differs += 1;
  s.db_ms_total += w.dbMs;
  s.db_ms_max = Math.max(s.db_ms_max, w.dbMs);
}

function fail(s: RunSummary, key: string, why: string): void {
  s.measures_failed += 1;
  if (s.failures.length < FAILURES_KEPT) s.failures.push({ key, why: why.slice(0, 200) });
}

export async function runBillDetails(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? ((l: string) => console.info(l));
  const tx = o.tx ?? REAL_TX;
  const backoff = o.backoffMs ?? ((n: number) => 5000 * n);
  const t0 = Date.now();
  const s = emptySummary();

  const targets = await selectTargets(o.client, o.only, o.keys);
  s.selected = targets.length;
  const resolve = buildBioguideResolver(o.officials ?? (await loadOfficials(o.client)));
  log(`  selected ${targets.length} unstamped measure(s) (only=${o.only}); ${targets.filter((t) => t.voted).length} with votes`);

  let streak = 0;
  let lastBeat = Date.now();
  let i = 0;
  for (; i < targets.length; i++) {
    const t = targets[i]!;
    if (o.limit !== null && s.measures_done + s.measures_failed + s.measures_not_found >= o.limit) { s.stop = "limit"; break; }
    if (o.maxMinutes !== null && Date.now() - t0 >= o.maxMinutes * 60_000) { s.stop = "max_minutes"; break; }
    if (o.heartbeat && Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      await o.heartbeat(s).catch((err: unknown) => log(`  [heartbeat] ${err instanceof Error ? err.message : String(err)}`));
    }
    const hold = await o.isHeld();
    if (hold.held) { s.stop = "held"; s.stop_detail = prodSessionHoldReason(hold.reason); break; }

    const tag = `  [${i + 1}/${targets.length}] ${t.external_id}${t.voted ? " (voted)" : ""}`;
    let fetched: FetchedMeasure;
    try {
      fetched = await fetchMeasure(o.get, t.external_id);
      streak = 0;
    } catch (err) {
      const fe = err instanceof MeasureFetchError ? err : new MeasureFetchError(null, t.external_id, String(err));
      s.requests += fe.requests;
      if (isTransient(fe.status)) {
        streak += 1;
        fail(s, t.external_id, `${fe.status ?? "no response"}: ${fe.message}`);
        log(`${tag}: transient ${fe.status ?? "no response"} (${streak}/${TRANSIENT_STOP}) — ${fe.message}`);
        if (streak >= TRANSIENT_STOP) { s.stop = "api_errors"; s.stop_detail = fe.message; i += 1; break; }
        await sleep(backoff(streak));
        continue;
      }
      streak = 0;
      // A 404 on the detail itself: congress.gov has no such measure.
      if (fe.status === 404 && /^bill\/\d+\/[a-z]+\/\d+$/.test(fe.path)) {
        if (o.apply) await stampNotFound(o.client, tx, t, 404);
        s.measures_not_found += 1;
        log(`${tag}: 404 — stamped not_found`);
        continue;
      }
      fail(s, t.external_id, `${fe.status}: ${fe.message}`);
      log(`${tag}: failed ${fe.status} — ${fe.message}`);
      continue;
    }
    s.requests += fetched.requests;

    let w: MeasureWrite | null;
    try {
      w = await writeMeasure(o.client, tx, t, fetched, resolve, o.apply);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "?";
      const msg = err instanceof Error ? err.message : String(err);
      if (isMeasureLocalDbError(err)) {
        fail(s, t.external_id, `db ${code}: ${msg}`);
        log(`${tag}: write failed (db ${code}) — nothing written — ${msg}`);
        continue;
      }
      fail(s, t.external_id, `db ${code}: ${msg}`);
      s.stop = "db_error";
      s.stop_detail = `${code}: ${msg}`;
      i += 1;
      break;
    }
    if (!w) { log(`${tag}: stamped by another run — skipped`); continue; }
    tally(s, fetched, w);
    log(
      `${tag}: sponsor ${w.sponsor} · cosponsors +${w.cosponsorsInserted}` +
        `${w.cosponsorsUpdated ? ` ~${w.cosponsorsUpdated}` : ""}/${fetched.cosponsors?.count ?? fetched.detail.cosponsorCount}` +
        ` (unresolved ${w.cosponsorsUnresolved.length}) · actions +${w.actionsInserted}/${fetched.actions.count}` +
        ` · title ${w.title} · introduced ${w.introduced} · ${fetched.requests} req · db ${w.dbMs} ms`,
    );
  }
  s.remaining = targets.length - i;
  s.elapsed_ms = Date.now() - t0;
  return s;
}

// ---------------------------------------------------------------------------
// The run row and the summary line
// ---------------------------------------------------------------------------

export function summaryLine(s: RunSummary, apply: boolean): string {
  const perMeasure = s.measures_stamped > 0 ? Math.round(s.db_ms_total / s.measures_stamped) : 0;
  const secs = (s.elapsed_ms / 1000).toFixed(1);
  const done = s.measures_done + s.measures_not_found;
  return (
    `bill-details ${apply ? "APPLY" : "DRY-RUN"}: measures=${done} (stamped ${s.measures_stamped}, not_found ${s.measures_not_found}, failed ${s.measures_failed})` +
    ` requests=${s.requests}` +
    ` sponsors set=${s.sponsors_set} same=${s.sponsors_same} unresolved=${s.sponsors_unresolved_none}+${s.sponsors_unresolved_many}many absent=${s.sponsors_absent} no_bill_details=${s.no_bill_details}` +
    ` cosponsors +${s.cosponsors_inserted}${s.cosponsors_updated ? ` ~${s.cosponsors_updated}` : ""} of source ${s.cosponsors_source} (unresolved ${s.cosponsors_unresolved})` +
    ` actions +${s.actions_inserted} of source ${s.actions_source} (dup_key ${s.actions_duplicate_key}, undated ${s.actions_undated})` +
    ` titles_filled=${s.titles_filled} introduced_filled=${s.introduced_filled} introduced_replaced_placeholder=${s.introduced_replaced_placeholder}` +
    ` kept_differs title=${s.titles_kept_differs} introduced=${s.introduced_kept_differs} sponsor=${s.sponsors_kept_differs}` +
    ` stop=${s.stop}${s.stop_detail ? ` (${s.stop_detail})` : ""} remaining=${s.remaining}` +
    ` elapsed=${secs}s db_ms/measure=${perMeasure} (max ${s.db_ms_max})` +
    (done > 0 ? ` s/measure=${(s.elapsed_ms / 1000 / done).toFixed(2)}` : "")
  );
}

function runMetadata(s: RunSummary, args: CliArgs): Record<string, unknown> {
  const { failures, ...counts } = s;
  return {
    ...counts,
    failures,
    only: args.only,
    limit: args.limit,
    max_minutes: args.maxMinutes,
    rows_by_table: {
      bill_details: s.sponsors_set,
      proposal_cosponsors: s.cosponsors_inserted + s.cosponsors_updated,
      proposal_actions: s.actions_inserted,
      proposals: s.titles_filled + s.introduced_filled + s.introduced_replaced_placeholder,
      external_source_refs: s.measures_stamped + s.measures_not_found,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  apply: boolean;
  allowProd: boolean;
  only: Only;
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
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : "voted";
  if (only !== "voted" && only !== "all") return { error: "--only takes voted or all." };
  return { apply, allowProd: argv.includes("--allow-prod"), only, limit: limit === null ? null : Math.floor(limit), maxMinutes };
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
    console.error(`[bill-details] REFUSING a non-local DB (${url}) without --allow-prod.`);
    process.exit(2);
  }
  console.info("=================================================");
  console.info("  FIX-1452 — congress.gov bill details (sponsor, cosponsors, actions, titles, dates)");
  console.info(`  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  DB: ${local ? "local" : "PROD"}  only=${args.only}  limit=${args.limit ?? "none"}  max-minutes=${args.maxMinutes ?? "none"}`);
  console.info("=================================================");

  // The admin client's own guard runs here too (startSync creates it).
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
                             || jsonb_build_object('heartbeat_at', now()::text, 'measures_done', $2::int)
            WHERE id = $1 AND status = 'running'`,
          [logId, s.measures_done],
        );
      };
      return runBillDetails({
        client,
        get: congressGet(apiKey),
        apply: args.apply,
        only: args.only,
        limit: args.limit,
        maxMinutes: args.maxMinutes,
        isHeld,
        heartbeat,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bill-details] fatal: ${msg}`);
    await failSync(logId, msg);
    process.exitCode = 1;
    return;
  }

  console.info(summaryLine(summary, args.apply));
  const metadata = runMetadata(summary, args);
  const result = {
    inserted: summary.cosponsors_inserted + summary.actions_inserted,
    updated: summary.sponsors_set + summary.cosponsors_updated + summary.titles_filled + summary.introduced_filled + summary.introduced_replaced_placeholder,
    failed: summary.measures_failed,
    estimatedMb: 0,
    metadata,
  };
  if (summary.stop === "held" && summary.measures_done + summary.measures_not_found === 0) {
    await skipSync(logId, summary.stop_detail ?? prodSessionHoldReason(null), metadata);
  } else if (summary.stop === "db_error") {
    await failSync(logId, `db_error: ${summary.stop_detail ?? ""}`, metadata);
    process.exitCode = 1;
  } else {
    await completeSync(logId, result, summary.stop === "done" ? "complete" : "partial");
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
