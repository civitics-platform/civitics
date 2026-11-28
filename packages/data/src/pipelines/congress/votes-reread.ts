/**
 * FIX-1466 / FIX-1465 (cc-341 D1–D3, D5) — the votes re-read walker: reads a
 * stored roll's own file again and INSERTS the member votes the roll is
 * missing. Nothing else.
 *
 * WHY. From about 2026-04-24 to 06-09 the votes writer built its member map
 * from the first 1,000 `officials` rows (PostgREST's cap; FIX-545 paginated
 * the read on 06-09). Every roll written in that window — the nightly's, and
 * the 117th–118th House backfill of 04-29 — stored only the members the cut
 * map held, with no error, and the nightly never re-reads a stored roll. Prod
 * 2026-11-28: 154 House rolls of the 119th short 19,735 votes, four Senate
 * rolls short 170, and 43 / 35 sitting members with an officials row and no
 * 118th / 117th House vote at all.
 *
 * WHAT A ROLL GETS (D2). The roll's file is fetched from its STORED
 * `source_url`, parsed with the nightly's parser, and resolved with the
 * nightly's `buildOfficialMaps`. A member with no stored row gets one, by
 * `INSERT … ON CONFLICT (roll_call_id, official_id) DO NOTHING`:
 *   - the cast from the file, through `mapVote`;
 *   - every roll-level field copied from the roll's stored rows:
 *     bill_proposal_id, voted_at, vote_question, session, chamber, source_url
 *     and the metadata's roll keys (a Senate live pair's `live_pair_with` is
 *     the member's own, from the file), so a roll re-pointed since (cc-316's
 *     nominations) stays where it is;
 *   - primary_source / _url / _last_seen_at from the parent proposal — the
 *     values the nightly's propagation would write, so it never revisits them.
 * A STORED ROW IS NEVER CHANGED: no UPDATE and no DELETE of `votes` anywhere
 * here. A stored cast that differs from the file's is counted and named only.
 * An insert fires no trigger on `votes`.
 *
 * A ROLL IS SKIPPED AND NAMED, never half-written, when: its stored rows sit
 * on more than one proposal, or disagree on another roll-level field; a cast
 * mapVote does not know (FIX-1417); it would insert more rows than the file's
 * members minus its stored rows (a stored row outside the file); or its
 * stored casts disagree with the file on more than 1 % of its members.
 *
 * BOUNDED AND RESUMABLE (D3), the vote-rolls walker's shape. The scope is a
 * manifest (`--manifest <tsv>`), `--only-ids`, or a chamber: `--chamber house`
 * is every stored House roll; `--chamber senate` is the sitting Congress's
 * rolls whose stored yes + no are under 90 % of vote_rolls' yea + nay (D1).
 * The cursor is each run's `data_sync_log` row: `metadata.done`, the rolls it
 * finished (inserted, or nothing to insert), range-encoded; every later run
 * leaves those out (`--refetch` ignores it). A heartbeat writes it every
 * minute, so a killed run keeps what it finished. One transaction a roll.
 * Between rolls it stops on --limit, --max-minutes, and a supervised session
 * holding the box (`prod_session_state()`'s `defer`). Per host: 750 ms between
 * House GETs, SENATE_PACE_MS for senate.gov and never in the Senate's quiet
 * span (vote-rolls.ts D6); a 403 / 429 still blocked after the retries stops
 * THAT host for the run, and so do three fetch failures in a row.
 *
 * Run (see docs/OPERATIONS.md §The votes re-read walker):
 *   pnpm --filter @civitics/data data:votes-reread -- --dry-run --manifest ../../docs/audits/2026-11-28-short-rolls-manifest.tsv
 *   pnpm --filter @civitics/data data:votes-reread -- --apply --chamber house --limit 100
 *   gh workflow run votes-reread.yml -f chamber=house -f max_minutes=45   (prod)
 */

import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { createAdminClient } from "@civitics/db";
import { fetchText, mapVote, sleep as realSleep, SITTING_CONGRESS, UnknownCastError } from "./members";
import {
  buildOfficialMaps,
  parseHouseRoll,
  parseSenateRoll,
  senateMemberFields,
  senateMemberList,
  xmlText,
  type OfficialMaps,
} from "./votes";
import { assertMemberMapFloor, senateNameKey } from "./votes-maps";
import { isMeasureLocalDbError } from "./bill-details";
import { BLOCKED_RETRY_DELAYS_MS, classifyFetchError, type RollOutcome } from "./roll-probe";
import { SENATE_PACE_MS } from "./senate-unstored";
import { HOUSE_PACE_MS, REAL_TX, SEED_SQL, quietSpanStart, senateWindow, type HoldReading, type TxControl } from "./vote-rolls";
import { rollIdentity, type Chamber } from "./vote-roll-row";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { buildDbUrl } from "../../lib/heavy-rebuild";
import { readProdSessionState } from "../../lib/prod-session";
import { prodSessionHoldReason } from "../nightly-hold";
import { startSync, completeSync, failSync, skipSync } from "../sync-log";

export const PIPELINE = "congress_votes_reread";
/** D2: a roll whose stored casts disagree with its file on more than this share of its members is not written. */
export const CAST_DISAGREE_LIMIT = 0.01;
/** D1: a Senate roll of the sitting Congress is short when its stored yes + no are under this share of yea + nay. */
export const SENATE_SHORT_SHARE = 0.9;
const FAIL_STOP = 3;
const INSERT_STATEMENT_TIMEOUT = "30s";
const SELECT_STATEMENT_TIMEOUT = "30s";
const HEARTBEAT_MS = 60_000;
const UNMATCHED_KEPT = 50;
const NAMED_KEPT = 100;

// ---------------------------------------------------------------------------
// The plan for one roll — pure
// ---------------------------------------------------------------------------

/** A stored `votes` row of the roll, as the plan reads it. */
export interface StoredVote {
  official_id: string;
  vote: string;
  bill_proposal_id: string;
  /** ISO instant. */
  voted_at: string;
  vote_question: string | null;
  session: string | null;
  chamber: string;
  source_url: string | null;
  metadata: Record<string, unknown> | null;
}

/** One member of the roll's file, resolved. */
export interface FileMember {
  /** The bioguide (House) or the `lastname:STATE` key (Senate): what an unmatched member is named by. */
  key: string;
  officialId: string | null;
  cast: string;
  /** A Senate live pair's partner (`<vote_cast pair=…>`), or null. */
  livePairWith: string | null;
}

export interface VoteInsertRow {
  official_id: string;
  bill_proposal_id: string;
  vote: string;
  chamber: string;
  roll_call_id: string;
  session: string | null;
  voted_at: string;
  vote_question: string | null;
  source_url: string | null;
  metadata: Record<string, unknown>;
}

export type SkipReason =
  | "not_stored"
  | "proposals_differ"
  | "roll_fields_differ"
  | "unknown_cast"
  | "insert_exceeds_gap"
  | "casts_disagree";

export interface CastDisagreement {
  official_id: string;
  stored: string;
  file: string;
}

export interface RollPlan {
  roll: string;
  stored: number;
  inFile: number;
  resolvable: number;
  insert: VoteInsertRow[];
  unmatched: string[];
  disagreements: CastDisagreement[];
  /** File members resolving to an official another member of the file already took: the first keeps it. */
  duplicates: number;
  skip: SkipReason | null;
  skipDetail: string | null;
}

/** A row's metadata without the per-member key: what every row of a roll shares. */
export function rollMetadata(m: Record<string, unknown> | null): Record<string, unknown> {
  const { live_pair_with: _member, ...roll } = m ?? {};
  return roll;
}

function sortedJson(v: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
}

/** The first roll-level field the stored rows disagree on, or null. */
function rollFieldDisagreement(stored: readonly StoredVote[]): string | null {
  const fields: Array<[string, (r: StoredVote) => string]> = [
    ["voted_at", (r) => String(new Date(r.voted_at).getTime())],
    ["vote_question", (r) => r.vote_question ?? "\u0000"],
    ["session", (r) => r.session ?? "\u0000"],
    ["chamber", (r) => r.chamber],
    ["source_url", (r) => r.source_url ?? "\u0000"],
    ["metadata", (r) => sortedJson(rollMetadata(r.metadata))],
  ];
  for (const [name, read] of fields) {
    if (new Set(stored.map(read)).size > 1) return name;
  }
  return null;
}

/**
 * D2 — what one roll gets. Pure: the stored rows and the file's resolved
 * members in, the rows to insert and what to name out. A member already stored
 * yields nothing; a stored cast that differs from the file's is reported, not
 * written; a roll whose stored rows disagree on a roll-level field yields
 * nothing at all.
 */
export function planRoll(roll: string, stored: readonly StoredVote[], members: readonly FileMember[]): RollPlan {
  const plan: RollPlan = {
    roll, stored: stored.length, inFile: members.length, resolvable: 0,
    insert: [], unmatched: [], disagreements: [], duplicates: 0, skip: null, skipDetail: null,
  };
  const skip = (reason: SkipReason, detail: string): RollPlan => ({ ...plan, insert: [], skip: reason, skipDetail: detail });

  const first = stored[0];
  if (!first) return skip("not_stored", "no stored rows");
  const proposals = new Set(stored.map((r) => r.bill_proposal_id));
  if (proposals.size > 1) return skip("proposals_differ", [...proposals].sort().join(", "));
  const differs = rollFieldDisagreement(stored);
  if (differs) return skip("roll_fields_differ", differs);

  const storedBy = new Map(stored.map((r) => [r.official_id, r.vote]));
  const taken = new Set<string>();
  const roll_meta = rollMetadata(first.metadata);
  for (const m of members) {
    if (!m.officialId) {
      plan.unmatched.push(m.key);
      continue;
    }
    plan.resolvable += 1;
    let vote: string;
    try {
      vote = mapVote(m.cast);
    } catch (err) {
      if (err instanceof UnknownCastError) return skip("unknown_cast", `'${err.cast}' for ${m.key}`);
      throw err;
    }
    const was = storedBy.get(m.officialId);
    if (was !== undefined) {
      if (was !== vote) plan.disagreements.push({ official_id: m.officialId, stored: was, file: vote });
      continue;
    }
    if (taken.has(m.officialId)) {
      plan.duplicates += 1;
      continue;
    }
    taken.add(m.officialId);
    plan.insert.push({
      official_id:      m.officialId,
      bill_proposal_id: first.bill_proposal_id,
      vote,
      chamber:          first.chamber,
      roll_call_id:     roll,
      session:          first.session,
      voted_at:         new Date(first.voted_at).toISOString(),
      vote_question:    first.vote_question,
      source_url:       first.source_url,
      metadata:         { ...roll_meta, ...(m.livePairWith ? { live_pair_with: m.livePairWith } : {}) },
    });
  }

  if (plan.insert.length > plan.inFile - plan.stored) {
    return skip("insert_exceeds_gap", `${plan.insert.length} to insert > ${plan.inFile} in the file − ${plan.stored} stored`);
  }
  if (plan.disagreements.length > CAST_DISAGREE_LIMIT * plan.inFile) {
    return skip("casts_disagree", `${plan.disagreements.length} of ${plan.inFile} stored casts differ from the file`);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The file — the nightly's parser and maps
// ---------------------------------------------------------------------------

/** A House Clerk roll's members, resolved by bioguide, or null when the body is not a roll. */
export function houseFileMembers(body: string, officialMap: ReadonlyMap<string, string>): FileMember[] | null {
  const p = parseHouseRoll(body);
  if (!p) return null;
  const raw = p.voteData["recorded-vote"];
  const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((rv) => {
    const o = (rv && typeof rv === "object" ? rv : {}) as Record<string, unknown>;
    const legislator = (o["legislator"] && typeof o["legislator"] === "object" ? o["legislator"] : {}) as Record<string, unknown>;
    const bioguide = String(legislator["@_name-id"] ?? "").trim();
    return {
      key: bioguide || "(no name-id)",
      officialId: bioguide ? (officialMap.get(bioguide) ?? null) : null,
      cast: xmlText(o["vote"]),
      livePairWith: null,
    };
  });
}

/** A Senate LIS roll's members, resolved by `lastname:STATE`, or null when the body is not a roll. */
export function senateFileMembers(body: string, senatorByNameState: ReadonlyMap<string, string>): FileMember[] | null {
  const root = parseSenateRoll(body);
  if (!root) return null;
  return senateMemberList(root).map((m) => {
    const { lastName, state, cast, livePairWith } = senateMemberFields(m);
    const key = senateNameKey(lastName, state);
    return {
      key: key || `${lastName}:${state}`,
      officialId: key ? (senatorByNameState.get(key) ?? null) : null,
      cast,
      livePairWith,
    };
  });
}

// ---------------------------------------------------------------------------
// The cursor — range-encoded roll ids in each run's sync row
// ---------------------------------------------------------------------------

const ROLL_TAIL = /^(.*-)(\d+)$/;

/**
 * Roll ids → `{ "2025-house-###": "3-295,297", "senate-119-2-#####": "114-117" }`:
 * the prefix with one `#` a digit of the padded number, then its ranges.
 */
export function encodeDone(ids: Iterable<string>): Record<string, string> {
  const by = new Map<string, number[]>();
  for (const id of ids) {
    const m = ROLL_TAIL.exec(id);
    if (!m) continue;
    const key = `${m[1]}${"#".repeat(m[2]!.length)}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push(Number(m[2]));
  }
  const out: Record<string, string> = {};
  for (const [key, nums] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const ranges: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
      ranges.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
      i = j;
    }
    out[key] = ranges.join(",");
  }
  return out;
}

/** The inverse of encodeDone. Anything malformed is dropped, never thrown. */
export function decodeDone(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const m = /^(.*-)(#+)$/.exec(key);
    if (!m || typeof value !== "string") continue;
    const width = m[2]!.length;
    for (const part of value.split(",")) {
      const r = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!r) continue;
      const lo = Number(r[1]);
      const hi = r[2] === undefined ? lo : Number(r[2]);
      for (let n = lo; n <= hi && n - lo < 10_000; n++) out.add(`${m[1]}${String(n).padStart(width, "0")}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scope
// ---------------------------------------------------------------------------

export interface Target {
  roll_call_id: string;
  chamber: Chamber;
}

function chamberOf(id: string): Chamber | null {
  return rollIdentity(id)?.chamber ?? null;
}

/** A manifest TSV's roll ids: `#` lines and the `roll_call_id` header skipped; the first column read. */
export function parseManifest(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.split("\t")[0]!.trim();
    if (!first || first.startsWith("#") || first === "roll_call_id") continue;
    ids.push(first);
  }
  return ids;
}

/**
 * D1's Senate scope: the sitting Congress's rolls whose stored yes + no are
 * under SENATE_SHORT_SHARE of the list's or file's yea + nay. One index probe
 * of votes_roll_call a roll.
 */
export const SENATE_SHORT_SQL =
  `SELECT vr.roll_call_id
     FROM public.vote_rolls vr
    WHERE vr.chamber = 'Senate' AND vr.congress = $1 AND vr.yea IS NOT NULL AND vr.nay IS NOT NULL
      AND (SELECT count(*) FROM public.votes v
            WHERE v.roll_call_id = vr.roll_call_id AND v.vote IN ('yes', 'no')) < $2 * (vr.yea + vr.nay)
    ORDER BY vr.roll_call_id`;

export interface Scope {
  manifest: string | null;
  onlyIds: string[] | null;
  chamber: Chamber | null;
}

/** The rolls a run may take, in roll_call_id order, before the cursor. */
export async function selectTargets(client: Client, scope: Scope, manifestText?: string): Promise<Target[]> {
  let ids: string[];
  if (scope.manifest !== null || manifestText !== undefined) {
    ids = parseManifest(manifestText ?? readFileSync(scope.manifest!, "utf8"));
  } else if (scope.onlyIds) {
    ids = scope.onlyIds;
  } else if (scope.chamber === "House") {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL statement_timeout = '${SELECT_STATEMENT_TIMEOUT}'`);
      ids = (await client.query<{ roll_call_id: string }>(SEED_SQL)).rows.map((r) => r.roll_call_id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } else if (scope.chamber === "Senate") {
    ids = (await client.query<{ roll_call_id: string }>(SENATE_SHORT_SQL, [SITTING_CONGRESS, SENATE_SHORT_SHARE])).rows.map((r) => r.roll_call_id);
  } else {
    throw new Error("no scope: pass --manifest, --only-ids or --chamber");
  }
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const id of [...ids].sort()) {
    const chamber = chamberOf(id);
    if (!chamber || seen.has(id)) continue;
    if (scope.chamber && chamber !== scope.chamber) continue;
    seen.add(id);
    out.push({ roll_call_id: id, chamber });
  }
  return out;
}

/** Every roll an earlier run of this pipeline finished: the union of the sync rows' `done`. */
export async function readDone(client: Client): Promise<Set<string>> {
  const rows = (await client.query<{ done: unknown }>(
    `SELECT metadata -> 'done' AS done FROM public.data_sync_log WHERE pipeline = $1 AND metadata ? 'done'`,
    [PIPELINE],
  )).rows;
  const out = new Set<string>();
  for (const r of rows) for (const id of decodeDone(r.done)) out.add(id);
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type StopReason = "done" | "limit" | "max_minutes" | "held" | "db_error";
export type HostStop = "blocked" | "failures" | "window" | "run_stopped";

export interface HostSummary {
  gets: number;
  blocked_retries: number;
  failed: number;
  stop: HostStop | null;
  stop_detail: string | null;
}

export interface RollLine {
  roll: string;
  stored: number;
  in_file: number;
  resolvable: number;
  to_insert: number;
  inserted: number | null;
  unmatched: number;
  disagree: number;
  skip: SkipReason | null;
  db_ms: number;
}

export interface RunSummary {
  stop: StopReason;
  stop_detail: string | null;
  selected: number;
  rolls_read: number;
  rolls_changed: number;
  rows_to_insert: number;
  rows_inserted: number;
  duplicates: number;
  unmatched: Map<string, number>;
  cast_disagreements: number;
  disagreement_rolls: Array<{ roll: string; n: number; sample: CastDisagreement[] }>;
  skipped: Array<{ roll: string; reason: SkipReason; detail: string | null }>;
  failures: Array<{ roll: string; why: string }>;
  house: HostSummary;
  senate: HostSummary;
  db_ms_total: number;
  db_ms_max: number;
  done: string[];
  lines: RollLine[];
  remaining: number;
  elapsed_ms: number;
}

function emptyHost(): HostSummary {
  return { gets: 0, blocked_retries: 0, failed: 0, stop: null, stop_detail: null };
}

export interface RunOptions {
  client: Client;
  maps: OfficialMaps;
  fetch: (url: string) => Promise<string>;
  apply: boolean;
  targets: readonly Target[];
  limit: number | null;
  maxMinutes: number | null;
  isHeld: () => Promise<HoldReading>;
  /** When the nightly's votes phase last closed, among rows started at or after `since` (vote-rolls.ts D6). */
  votesPhaseClosedSince?: (since: Date) => Promise<string | null>;
  tx?: TxControl;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  heartbeat?: (s: RunSummary) => Promise<void>;
  log?: (line: string) => void;
}

/** One host's pace, blocked retries and stops. */
class Host {
  private streak = 0;
  constructor(
    readonly name: string,
    private readonly pace: { base: number; jitter: number },
    readonly summary: HostSummary,
    private readonly o: RunOptions,
  ) {}

  get stopped(): boolean {
    return this.summary.stop !== null;
  }

  stopFor(stop: HostStop, detail: string | null = null): void {
    if (this.summary.stop === null) {
      this.summary.stop = stop;
      this.summary.stop_detail = detail;
    }
  }

  private async once(url: string): Promise<{ body: string } | { outcome: Exclude<RollOutcome, { kind: "roll" }> }> {
    const wait = this.o.sleep ?? realSleep;
    if (this.summary.gets > 0) await wait(this.pace.base + Math.round(Math.random() * this.pace.jitter));
    this.summary.gets += 1;
    try {
      return { body: await this.o.fetch(url) };
    } catch (err) {
      return { outcome: classifyFetchError(err, { blocked: true }) as Exclude<RollOutcome, { kind: "roll" }> };
    }
  }

  async get(url: string): Promise<{ body: string } | { outcome: Exclude<RollOutcome, { kind: "roll" }> }> {
    const wait = this.o.sleep ?? realSleep;
    let r = await this.once(url);
    for (const ms of BLOCKED_RETRY_DELAYS_MS) {
      if (!("outcome" in r) || r.outcome.kind !== "blocked") break;
      this.summary.blocked_retries += 1;
      await wait(ms);
      r = await this.once(url);
    }
    if ("outcome" in r && r.outcome.kind === "blocked") this.stopFor("blocked", `${r.outcome.why} on ${url}`);
    return r;
  }

  /** A GET or a parse that gave no roll. The third in a row stops this host. */
  failed(why: string): void {
    this.summary.failed += 1;
    if (++this.streak >= FAIL_STOP) this.stopFor("failures", why);
  }

  ok(): void {
    this.streak = 0;
  }
}

class RunStop extends Error {
  constructor(readonly reason: StopReason, readonly detail: string | null) {
    super(detail ?? reason);
  }
}

const INSERT_SQL =
  `INSERT INTO public.votes (official_id, bill_proposal_id, vote, chamber, roll_call_id, session, voted_at,
                             vote_question, source_url, metadata,
                             primary_source, primary_source_url, primary_source_last_seen_at)
   SELECT s.official_id, s.bill_proposal_id, s.vote, s.chamber, s.roll_call_id, s.session, s.voted_at,
          s.vote_question, s.source_url, s.metadata,
          p.primary_source, p.primary_source_url, p.primary_source_last_seen_at
     FROM jsonb_populate_recordset(NULL::public.votes, $1::jsonb) s
     LEFT JOIN public.proposals p ON p.id = s.bill_proposal_id
   ON CONFLICT (roll_call_id, official_id) DO NOTHING`;

const STORED_SQL =
  `SELECT official_id, vote, bill_proposal_id, voted_at, vote_question, session, chamber, source_url, metadata
     FROM public.votes WHERE roll_call_id = $1`;

export async function runReread(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? ((l: string) => console.info(l));
  const tx = o.tx ?? REAL_TX;
  const now = o.now ?? (() => new Date());
  const t0 = Date.now();
  const s: RunSummary = {
    stop: "done", stop_detail: null, selected: o.targets.length,
    rolls_read: 0, rolls_changed: 0, rows_to_insert: 0, rows_inserted: 0, duplicates: 0,
    unmatched: new Map(), cast_disagreements: 0, disagreement_rolls: [], skipped: [], failures: [],
    house: emptyHost(), senate: emptyHost(), db_ms_total: 0, db_ms_max: 0,
    done: [], lines: [], remaining: o.targets.length, elapsed_ms: 0,
  };
  const hosts = {
    House: new Host("clerk.house.gov", HOUSE_PACE_MS, s.house, o),
    Senate: new Host("www.senate.gov", SENATE_PACE_MS, s.senate, o),
  };
  const readSpan = quietSpanStart(now());
  const closedAt = readSpan && o.votesPhaseClosedSince && o.targets.some((t) => t.chamber === "Senate")
    ? await o.votesPhaseClosedSince(readSpan)
    : null;
  let lastBeat = Date.now();
  let taken = 0;
  const dbTime = (ms: number) => {
    s.db_ms_total += ms;
    s.db_ms_max = Math.max(s.db_ms_max, ms);
  };

  const between = async (): Promise<void> => {
    if (o.limit !== null && taken >= o.limit) throw new RunStop("limit", `--limit ${o.limit}`);
    if (o.maxMinutes !== null && Date.now() - t0 >= o.maxMinutes * 60_000) throw new RunStop("max_minutes", null);
    if (o.heartbeat && Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      await o.heartbeat(s).catch((err: unknown) => log(`  [heartbeat] ${err instanceof Error ? err.message : String(err)}`));
    }
    const hold = await o.isHeld();
    if (hold.held) throw new RunStop("held", prodSessionHoldReason(hold.reason));
  };

  try {
    for (const t of o.targets) {
      const host = hosts[t.chamber];
      if (host.stopped) continue;
      if (t.chamber === "Senate") {
        const w = senateWindow(now(), readSpan, closedAt);
        if (!w.open) { host.stopFor("window", w.why); continue; }
      }
      await between();
      taken += 1;

      // The stored rows: roll-level fields, who is stored, and the URL.
      const r0 = Date.now();
      let stored: StoredVote[];
      try {
        stored = (await o.client.query<StoredVote & { voted_at: Date | string }>(STORED_SQL, [t.roll_call_id])).rows
          .map((r) => ({ ...r, voted_at: new Date(r.voted_at).toISOString() }));
      } catch (err) {
        throw new RunStop("db_error", `stored read ${t.roll_call_id}: ${(err as { code?: string }).code ?? "?"}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const readMs = Date.now() - r0;
      dbTime(readMs);
      const url = stored[0]?.source_url ?? rollIdentity(t.roll_call_id)?.source_url ?? null;
      if (stored.length === 0 || !url) {
        s.skipped.push({ roll: t.roll_call_id, reason: "not_stored", detail: stored.length === 0 ? "no stored rows" : "no source_url" });
        log(`  ${t.roll_call_id}: not stored — skipped`);
        continue;
      }

      const got = await host.get(url);
      if ("outcome" in got) {
        const why = `${got.outcome.kind}: ${got.outcome.why}`;
        if (got.outcome.kind !== "blocked") host.failed(why);
        if (s.failures.length < NAMED_KEPT) s.failures.push({ roll: t.roll_call_id, why });
        log(`  ${t.roll_call_id}: ${why}${host.stopped ? ` · ${host.name} stopped for the run` : ""}`);
        continue;
      }
      const members = t.chamber === "House"
        ? houseFileMembers(got.body, o.maps.officialMap)
        : senateFileMembers(got.body, o.maps.senatorByNameState);
      if (!members) {
        host.failed("not a roll");
        if (s.failures.length < NAMED_KEPT) s.failures.push({ roll: t.roll_call_id, why: `not a roll (${got.body.length} bytes)` });
        log(`  ${t.roll_call_id}: not a roll (${got.body.length} bytes)${host.stopped ? ` · ${host.name} stopped for the run` : ""}`);
        continue;
      }
      host.ok();
      s.rolls_read += 1;

      const plan = planRoll(t.roll_call_id, stored, members);
      for (const k of plan.unmatched) s.unmatched.set(k, (s.unmatched.get(k) ?? 0) + 1);
      s.duplicates += plan.duplicates;
      if (plan.disagreements.length > 0) {
        s.cast_disagreements += plan.disagreements.length;
        if (s.disagreement_rolls.length < NAMED_KEPT) {
          s.disagreement_rolls.push({ roll: t.roll_call_id, n: plan.disagreements.length, sample: plan.disagreements.slice(0, 5) });
        }
      }
      const line: RollLine = {
        roll: t.roll_call_id, stored: plan.stored, in_file: plan.inFile, resolvable: plan.resolvable,
        to_insert: plan.insert.length, inserted: null, unmatched: plan.unmatched.length,
        disagree: plan.disagreements.length, skip: plan.skip, db_ms: readMs,
      };
      s.lines.push(line);
      const sitting = rollIdentity(t.roll_call_id)?.congress === SITTING_CONGRESS;
      const named = sitting && plan.unmatched.length > 0 ? ` [${plan.unmatched.join(" ")}]` : "";

      if (plan.skip) {
        s.skipped.push({ roll: t.roll_call_id, reason: plan.skip, detail: plan.skipDetail });
        log(`  ${t.roll_call_id}: SKIPPED ${plan.skip} (${plan.skipDetail ?? ""}) · stored ${plan.stored} · file ${plan.inFile}`);
        continue;
      }
      s.rows_to_insert += plan.insert.length;

      let inserted = 0;
      if (plan.insert.length > 0) {
        if (o.apply) {
          const w0 = Date.now();
          await tx.begin(o.client);
          try {
            await o.client.query(`SET LOCAL statement_timeout = '${INSERT_STATEMENT_TIMEOUT}'`);
            inserted = (await o.client.query(INSERT_SQL, [JSON.stringify(plan.insert)])).rowCount ?? 0;
            await tx.commit(o.client);
          } catch (err) {
            await tx.rollback(o.client).catch(() => undefined);
            const code = (err as { code?: string }).code ?? "?";
            const msg = err instanceof Error ? err.message : String(err);
            if (!isMeasureLocalDbError(err)) throw new RunStop("db_error", `${t.roll_call_id} ${code}: ${msg}`);
            if (s.failures.length < NAMED_KEPT) s.failures.push({ roll: t.roll_call_id, why: `db ${code}: ${msg.slice(0, 160)}` });
            log(`  ${t.roll_call_id}: insert failed (db ${code}) — ${msg}`);
            continue;
          }
          const ms = Date.now() - w0;
          dbTime(ms);
          line.db_ms += ms;
        } else {
          inserted = plan.insert.length;
        }
      }
      line.inserted = o.apply ? inserted : null;
      if (o.apply) s.rows_inserted += inserted;
      if (inserted > 0) s.rolls_changed += 1;
      s.done.push(t.roll_call_id);
      log(
        `  ${t.roll_call_id}: stored ${plan.stored} · file ${plan.inFile} · resolvable ${plan.resolvable}` +
          ` · ${o.apply ? `inserted ${inserted} of ${plan.insert.length}` : `to insert ${plan.insert.length}`}` +
          ` · unmatched ${plan.unmatched.length}${named} · disagree ${plan.disagreements.length} · db ${line.db_ms} ms`,
      );
    }
  } catch (err) {
    if (!(err instanceof RunStop)) throw err;
    s.stop = err.reason;
    s.stop_detail = err.detail;
    for (const h of Object.values(hosts)) h.stopFor("run_stopped", err.reason);
  }
  if (s.stop === "done" && Object.values(hosts).some((h) => h.summary.stop === "blocked" || h.summary.stop === "failures" || h.summary.stop === "window")) {
    s.stop_detail = Object.values(hosts).filter((h) => h.stopped).map((h) => `${h.name} ${h.summary.stop}`).join(", ");
  }
  s.remaining = o.targets.length - s.done.length;
  s.elapsed_ms = Date.now() - t0;
  return s;
}

// ---------------------------------------------------------------------------
// The run row and the summary
// ---------------------------------------------------------------------------

export function unmatchedTop(s: RunSummary, n = UNMATCHED_KEPT): Array<{ key: string; rolls: number }> {
  return [...s.unmatched].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([key, rolls]) => ({ key, rolls }));
}

export function summaryLine(s: RunSummary, apply: boolean): string {
  const writes = s.lines.length;
  const perRoll = writes > 0 ? Math.round(s.db_ms_total / writes) : 0;
  const host = (name: string, h: HostSummary) =>
    `${name} gets=${h.gets} (retries ${h.blocked_retries}) failed=${h.failed} stop=${h.stop ?? "-"}${h.stop_detail ? ` (${h.stop_detail})` : ""}`;
  return (
    `votes-reread ${apply ? "APPLY" : "DRY-RUN"}: selected=${s.selected} read=${s.rolls_read} changed=${s.rolls_changed}` +
    ` rows ${apply ? `inserted=${s.rows_inserted} of ${s.rows_to_insert}` : `to_insert=${s.rows_to_insert}`}` +
    ` unmatched_distinct=${s.unmatched.size} disagreements=${s.cast_disagreements} duplicates=${s.duplicates}` +
    ` skipped=${s.skipped.length} failures=${s.failures.length}` +
    ` · ${host("house", s.house)} · ${host("senate", s.senate)}` +
    ` · stop=${s.stop}${s.stop_detail ? ` (${s.stop_detail})` : ""} remaining=${s.remaining}` +
    ` elapsed=${(s.elapsed_ms / 1000).toFixed(1)}s db_ms total=${s.db_ms_total} max=${s.db_ms_max} per_roll=${perRoll}`
  );
}

export function runMetadata(s: RunSummary, scope: Scope, args: Pick<CliArgs, "limit" | "maxMinutes" | "refetch">): Record<string, unknown> {
  return {
    scope: { manifest: scope.manifest, only_ids: scope.onlyIds?.length ?? null, chamber: scope.chamber },
    limit: args.limit, max_minutes: args.maxMinutes, refetch: args.refetch,
    stop: s.stop, stop_detail: s.stop_detail,
    rolls_selected: s.selected, rolls_read: s.rolls_read, rolls_changed: s.rolls_changed,
    rows_to_insert: s.rows_to_insert, rows_inserted: s.rows_inserted, duplicates: s.duplicates,
    unmatched_distinct: s.unmatched.size, unmatched_top: unmatchedTop(s),
    cast_disagreements: s.cast_disagreements, disagreement_rolls: s.disagreement_rolls,
    skipped: s.skipped.slice(0, NAMED_KEPT), skipped_count: s.skipped.length,
    failures: s.failures,
    house: s.house, senate: s.senate,
    db_ms_total: s.db_ms_total, db_ms_max: s.db_ms_max,
    db_ms_per_roll: s.lines.length > 0 ? Math.round(s.db_ms_total / s.lines.length) : 0,
    remaining: s.remaining, elapsed_ms: s.elapsed_ms,
    done: encodeDone(s.done), done_count: s.done.length,
    rows_by_table: { votes: s.rows_inserted },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  apply: boolean;
  allowProd: boolean;
  chamber: Chamber | null;
  onlyIds: string[] | null;
  manifest: string | null;
  limit: number | null;
  maxMinutes: number | null;
  refetch: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs | { error: string } {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply === dryRun) return { error: "Pass exactly one of --dry-run or --apply." };
  const value = (flag: string): string | null | "missing" => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const v = argv[at + 1];
    return v === undefined || v.startsWith("--") ? "missing" : v;
  };
  const num = (flag: string, min: number): number | null | "bad" => {
    const v = value(flag);
    if (v === null) return null;
    const n = Number(v);
    return v !== "missing" && Number.isFinite(n) && n >= min ? n : "bad";
  };
  const chamberRaw = value("--chamber");
  if (chamberRaw === "missing" || (chamberRaw !== null && !["house", "senate"].includes(chamberRaw))) {
    return { error: "--chamber takes house or senate." };
  }
  const onlyRaw = value("--only-ids");
  const manifest = value("--manifest");
  if (onlyRaw === "missing") return { error: "--only-ids takes a comma-separated list of roll ids." };
  if (manifest === "missing") return { error: "--manifest takes a TSV path." };
  if (onlyRaw !== null && manifest !== null) return { error: "Pass --only-ids or --manifest, not both." };
  if (chamberRaw === null && onlyRaw === null && manifest === null) {
    return { error: "Pass a scope: --manifest <tsv>, --only-ids <ids> or --chamber house|senate." };
  }
  const limit = num("--limit", 1);
  const maxMinutes = num("--max-minutes", Number.MIN_VALUE);
  if (limit === "bad") return { error: "--limit takes a whole number of rolls, 1 or more." };
  if (maxMinutes === "bad") return { error: "--max-minutes takes a positive number." };
  return {
    apply,
    allowProd: argv.includes("--allow-prod"),
    chamber: chamberRaw === "house" ? "House" : chamberRaw === "senate" ? "Senate" : null,
    onlyIds: onlyRaw === null ? null : onlyRaw.split(",").map((x) => x.trim()).filter(Boolean),
    manifest,
    limit: limit === null ? null : Math.floor(limit),
    maxMinutes,
    refetch: argv.includes("--refetch"),
  };
}

/** The Senate governing body's id, read (never seeded): the nightly's own `seedGoverningBodies` key. */
async function senateGovBodyId(client: Client): Promise<string> {
  const rows = (await client.query<{ id: string }>(
    `SELECT id FROM public.governing_bodies WHERE name = 'United States Senate' AND type = 'legislature_upper'`,
  )).rows;
  if (rows.length !== 1) throw new Error(`expected one United States Senate governing body, found ${rows.length}`);
  return rows[0]!.id;
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
    console.error(`[votes-reread] REFUSING a non-local DB (${url}) without --allow-prod.`);
    process.exit(2);
  }
  const scope: Scope = { manifest: args.manifest, onlyIds: args.onlyIds, chamber: args.chamber };
  console.info("=================================================");
  console.info("  FIX-1466 — the votes re-read walker: INSERT the member votes a stored roll is missing");
  console.info(
    `  Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  DB: ${local ? "local" : "PROD"}  scope: ` +
      `${args.manifest ? `manifest ${args.manifest}` : args.onlyIds ? `${args.onlyIds.length} id(s)` : `chamber ${args.chamber}`}` +
      `${args.chamber && (args.manifest || args.onlyIds) ? ` (${args.chamber} only)` : ""}` +
      `  limit=${args.limit ?? "none"}  max-minutes=${args.maxMinutes ?? "none"}${args.refetch ? "  --refetch" : ""}`,
  );
  console.info("=================================================");

  const logId = args.apply ? await startSync(PIPELINE) : "";
  let summary: RunSummary;
  try {
    summary = await withDirectClient(async (client) => {
      await client.query("SET statement_timeout = '60s'");
      await client.query(`SET application_name = '${PIPELINE}'`);

      // The nightly's maps, under the nightly's floor (FIX-1467).
      const maps = await buildOfficialMaps(createAdminClient(), await senateGovBodyId(client));
      assertMemberMapFloor({ house: maps.officialMap.size, senate: maps.senatorByNameState.size });

      const all = await selectTargets(client, scope);
      const done = args.refetch ? new Set<string>() : await readDone(client);
      const targets = all.filter((t) => !done.has(t.roll_call_id));
      console.info(`  scope: ${all.length} roll(s); ${all.length - targets.length} finished by an earlier run; ${targets.length} to read`);

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
                             || jsonb_build_object('heartbeat_at', now()::text, 'done', $2::jsonb,
                                                   'done_count', $3::int, 'rows_inserted', $4::int)
            WHERE id = $1 AND status = 'running'`,
          [logId, JSON.stringify(encodeDone(s.done)), s.done.length, s.rows_inserted],
        );
      };
      return runReread({
        client, maps, fetch: fetchText, apply: args.apply, targets,
        limit: args.limit, maxMinutes: args.maxMinutes, isHeld, votesPhaseClosedSince, heartbeat,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[votes-reread] fatal: ${msg}`);
    await failSync(logId, msg);
    process.exitCode = 1;
    return;
  }

  console.info(summaryLine(summary, args.apply));
  const top = unmatchedTop(summary, 15);
  if (top.length > 0) console.info(`  unmatched (most rolls first): ${top.map((u) => `${u.key}×${u.rolls}`).join(" ")}`);
  for (const sk of summary.skipped) console.info(`  skipped ${sk.roll}: ${sk.reason}${sk.detail ? ` (${sk.detail})` : ""}`);
  for (const d of summary.disagreement_rolls) console.info(`  cast disagreements ${d.roll}: ${d.n} — ${d.sample.map((x) => `${x.official_id} stored ${x.stored} file ${x.file}`).join("; ")}`);

  const metadata = runMetadata(summary, scope, args);
  const result = {
    inserted: summary.rows_inserted,
    updated: 0,
    failed: summary.skipped.length + summary.failures.length,
    estimatedMb: 0,
    metadata,
  };
  if (summary.stop === "held" && summary.done.length === 0) {
    await skipSync(logId, summary.stop_detail ?? prodSessionHoldReason(null), metadata);
  } else if (summary.stop === "db_error") {
    await failSync(logId, `db_error: ${summary.stop_detail ?? ""}`, metadata);
    process.exitCode = 1;
  } else {
    const whole = summary.stop === "done" && summary.remaining === 0;
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
